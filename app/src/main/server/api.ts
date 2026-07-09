// The REST API the Aurora UI + the extension popup call. Loopback-only; every /api route except the
// pairing hand-off requires the X-JAT13-Token header. Read routes are lean DAL projections (payload
// discipline); control routes drive the run-service + importer. PatchBus (live push over /drive) is
// layered on top later — these are the request/response surface.
import { Hono } from 'hono';
import { IDENTITY, PROTOCOL_VERSION } from '@jat13/shared';
import type { Dal } from '../db/dal/index.js';
import type { RunService } from '../engine/run-service.js';
import type { Registry } from '../adapters/registry.js';
import { planImport, executeImport } from '../importer/v11.js';
import { migrateGmailCredentials } from '../importer/gmail-creds.js';
import type { AiService } from '../ai/index.js';
import type { DiscoveryService } from '../discovery/service.js';

export interface ApiDeps {
  dal: Dal;
  runService: RunService;
  registry: Registry;
  aiService: AiService;
  discovery: DiscoveryService;
  token: string;
  version: string;
  /** mount extra routes on the AUTHED /api sub-app (e.g. the Gmail routes). */
  extend?: (api: Hono) => void;
  /** override the "is v11 running?" gate (tests inject a deterministic stub). */
  v11Probe?: () => Promise<boolean>;
  /** show + focus the app window (popup "Open dashboard"); absent in headless tests. */
  frontWindow?: () => void;
  /** decrypt a v11-sealed value (Electron safeStorage) so the import can migrate Gmail creds. */
  unsealV11?: (stored: string) => string;
}

function intParam(v: string | undefined, def: number): number {
  const n = v === undefined ? def : Number(v);
  return Number.isFinite(n) ? n : def;
}

/** Live-process gate (plan §5.1): a running v11 answers on :7744; importing then could read a
 *  half-written snapshot. Belt to the importer's lock-dir suspenders. */
async function v11IsRunning(): Promise<boolean> {
  try {
    const res = await fetch('http://127.0.0.1:7744/health', { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

export function mountApi(app: Hono, deps: ApiDeps): void {
  const { dal, runService, registry } = deps;

  // --- public: the loopback pairing hand-off (extension popup fetches the token on a user click) ---
  const pub = new Hono();
  pub.get('/pair/token', (c) =>
    c.json({ token: deps.token, productName: IDENTITY.productName, version: deps.version, protocol: PROTOCOL_VERSION }),
  );
  app.route('/api', pub);

  // --- protected: everything else ---
  const api = new Hono();
  api.use('*', async (c, next) => {
    if (c.req.header(IDENTITY.authHeader) !== deps.token) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  api.get('/version', (c) => c.json({ version: deps.version, protocol: PROTOCOL_VERSION }));

  api.get('/summary', (c) =>
    c.json({
      funnel: dal.applications.funnel({ days: 90 }),
      runs: dal.runs.stats({ hours: 24 }),
      needsYou: dal.runs.listLean({ state: 'needs_human', limit: 200 }).total,
      applying: runService.isRunning(),
    }),
  );

  api.get('/jobs', (c) => {
    const q = c.req.query();
    const p: NonNullable<Parameters<typeof dal.jobs.listLean>[0]> = { limit: intParam(q.limit, 100), offset: intParam(q.offset, 0) };
    if (q.source) p.source = q.source;
    if (q.q) p.q = q.q;
    return c.json(dal.jobs.listLean(p));
  });
  api.get('/jobs/:id', (c) => {
    const d = dal.jobs.getDetail(c.req.param('id'));
    return d ? c.json(d) : c.json({ error: 'not_found' }, 404);
  });

  api.get('/applications', (c) => {
    const q = c.req.query();
    const p: NonNullable<Parameters<typeof dal.applications.listLean>[0]> = { limit: intParam(q.limit, 100), offset: intParam(q.offset, 0) };
    if (q.status) p.status = q.status as NonNullable<typeof p.status>;
    return c.json(dal.applications.listLean(p));
  });
  api.get('/applications/:id/timeline', (c) => {
    const id = c.req.param('id');
    return c.json({ events: dal.events.timeline(id), emails: dal.emails.listForApplication(id) });
  });

  api.get('/runs', (c) => {
    const q = c.req.query();
    const p: NonNullable<Parameters<typeof dal.runs.listLean>[0]> = { limit: intParam(q.limit, 100), offset: intParam(q.offset, 0) };
    if (q.state) p.state = q.state as NonNullable<typeof p.state>;
    if (q.lane) p.lane = q.lane as NonNullable<typeof p.lane>;
    return c.json(dal.runs.listLean(p));
  });
  api.get('/runs/:id/steps', (c) => c.json({ steps: dal.runs.getSteps(c.req.param('id')) }));

  // the Needs-You queue: runs waiting on a human (walls) or a review, ENRICHED with the actual parked
  // questions + park kind + job title so the UI can render a real answer form (not a generic one).
  api.get('/needs-you', (c) => {
    const enrich = (r: { id: string; job_id?: string }) => {
      const full = dal.runs.get(r.id);
      const detail = full ? dal.jobs.getDetail(full.job_id) : undefined;
      return {
        ...r,
        park_kind: full?.park_kind ?? null,
        park_detail: full?.park_detail ?? null,
        questions: full?.pending_questions ?? [],
        job_title: detail?.title ?? null,
        company: detail?.company ?? null,
      };
    };
    const human = dal.runs.listLean({ state: 'needs_human', limit: 200 }).rows.map(enrich);
    const review = dal.runs.listLean({ state: 'ready_for_review', limit: 200 }).rows.map(enrich);
    return c.json({ needsHuman: human, readyForReview: review });
  });
  // answer a parked question, then re-queue the run (needs_human → queued) so it resumes
  api.post('/runs/:id/answer', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as { answers?: { profileId: string; label: string; value: string; kind?: 'qa' | 'field' }[] };
    for (const a of body.answers ?? []) dal.answers.record(a.profileId, { kind: a.kind ?? 'qa', label: a.label, value: a.value, provenance: 'user', locked: true });
    const run = dal.runs.get(id);
    if (run && run.state === 'needs_human') dal.runs.transition(id, 'queued');
    return c.json({ ok: true });
  });

  // ---- documents: real management (upload / download / set-default / delete) ----
  api.get('/documents', (c) => c.json({ rows: dal.documents.listLean() }));
  api.post('/documents', async (c) => {
    // multipart upload: file + optional role/label. The browser FormData carries the bytes.
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return c.json({ error: 'no_file' }, 400);
    const roleRaw = String(form.get('role') ?? 'resume');
    const roles = ['resume', 'cover_letter', 'portfolio', 'transcript', 'other'];
    const role = (roles.includes(roleRaw) ? roleRaw : 'resume') as 'resume' | 'cover_letter' | 'portfolio' | 'transcript' | 'other';
    const bytes = Buffer.from(await file.arrayBuffer());
    const prof = dal.ctx.db.prepare('SELECT id FROM profiles WHERE is_default = 1 LIMIT 1').get() as { id: string } | undefined;
    try {
      const add: Parameters<typeof dal.documents.add>[0] = { name: file.name.slice(0, 256), role, bytes, source: 'upload' };
      if (file.type) add.mime = file.type;
      if (prof) add.profileId = prof.id;
      const label = form.get('label');
      if (typeof label === 'string' && label) add.label = label.slice(0, 128);
      return c.json({ ok: true, doc: dal.documents.add(add) });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'upload_failed' }, 400);
    }
  });
  api.get('/documents/:id/download', (c) => {
    const id = c.req.param('id');
    const bytes = dal.documents.getBytes(id);
    if (!bytes) return c.json({ error: 'not_found' }, 404);
    const row = dal.documents.listLean().rows.find((r) => r.id === id);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': row?.mime ?? 'application/octet-stream',
        'content-disposition': `attachment; filename="${(row?.name ?? 'document').replace(/["\\]/g, '')}"`,
      },
    });
  });
  api.post('/documents/:id/default', (c) => {
    try {
      dal.documents.setDefault(c.req.param('id'));
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'not_found' }, 404);
    }
  });
  api.delete('/documents/:id', (c) => c.json({ ok: dal.documents.remove(c.req.param('id')) }));

  api.get('/emails', (c) => {
    const q = c.req.query();
    const p: NonNullable<Parameters<typeof dal.emails.listLean>[0]> = { limit: intParam(q.limit, 100), offset: intParam(q.offset, 0) };
    if (q.category) p.category = q.category;
    return c.json(dal.emails.listLean(p));
  });
  api.get('/emails/suggestions', (c) => c.json({ rows: dal.emails.unmatchedSuggestions() }));

  api.get('/settings', (c) => c.json(dal.settings.all()));
  api.put('/settings/:section/:key', async (c) => {
    const body = (await c.req.json()) as { value: unknown };
    try {
      dal.settings.set(c.req.param('section'), c.req.param('key'), body.value);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'bad_setting' }, 400);
    }
  });

  api.get('/adapters', (c) =>
    c.json({ rows: registry.all().map((a) => ({ id: a.id, version: a.version, source: a.source, hosts: a.hosts, priority: a.priority, pages: a.pages.length })) }),
  );
  api.get('/secrets/health', (c) => c.json({ rows: dal.secrets.health() }));

  // ---- AI (Codex CLI, ChatGPT subscription — no API keys) ----
  api.get('/ai/status', async (c) => {
    const ai = dal.settings.get('ai') as { codexPath?: string; enabled?: boolean };
    const st = await deps.aiService.status(ai.codexPath || undefined);
    return c.json({ ...st, enabled: ai.enabled !== false });
  });
  api.post('/ai/detect', async (c) => {
    const ai = dal.settings.get('ai') as { codexPath?: string };
    return c.json(await deps.aiService.status(ai.codexPath || undefined));
  });

  // ---- discovery (ATS job sourcing) ----
  api.get('/discovery/status', (c) => c.json({ lanes: dal.discovery.stats() }));
  api.post('/discovery/run', async (c) => c.json(await deps.discovery.runOnce()));

  // popup quick actions
  api.post('/app/front', (c) => {
    deps.frontWindow?.();
    return c.json({ ok: true });
  });
  // "Track this page": upsert the posting + ensure an application on the default profile.
  api.post('/track', async (c) => {
    const body = (await c.req.json()) as { url?: string; title?: string; company?: string };
    if (!body.url || !/^https?:/i.test(body.url)) return c.json({ error: 'bad_url' }, 400);
    const host = new URL(body.url).hostname.replace(/^www\./, '');
    const source = host.includes('linkedin') ? 'linkedin' : host.includes('indeed') ? 'indeed' : host.split('.')[0] ?? 'web';
    const up = dal.jobs.upsert({
      source,
      job_url: body.url,
      title: (body.title ?? '').slice(0, 512),
      company: (body.company ?? '').slice(0, 256),
    });
    const prof = dal.ctx.db.prepare('SELECT id FROM profiles WHERE is_default = 1 LIMIT 1').get() as { id: string } | undefined;
    if (prof) dal.applications.ensure(up.job.id, prof.id);
    return c.json({ ok: true, jobId: up.job.id, action: up.action === 'inserted' ? 'tracked' : 'existing' });
  });

  // run-service control (the minimal single-lane driver; #4 is the full scheduler)
  api.get('/apply/status', (c) => c.json({ running: runService.isRunning() }));
  api.post('/apply/start', (c) => { runService.start(); return c.json({ running: true }); });
  api.post('/apply/stop', (c) => { runService.stop(); return c.json({ running: false }); });

  // v11 import wizard
  api.post('/import/plan', async (c) => {
    const { sourcePath } = (await c.req.json()) as { sourcePath: string };
    if (await (deps.v11Probe ?? v11IsRunning)()) return c.json({ error: 'V11_RUNNING', message: 'Quit JAT v11 first — the import reads a consistent snapshot.' }, 409);
    try {
      return c.json(planImport(sourcePath));
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return c.json({ error: err.code ?? 'import_plan_failed', message: err.message }, 400);
    }
  });
  api.post('/import/execute', async (c) => {
    const { sourcePath, migrateGmail } = (await c.req.json()) as { sourcePath: string; migrateGmail?: boolean };
    if (await (deps.v11Probe ?? v11IsRunning)()) return c.json({ error: 'V11_RUNNING', message: 'Quit JAT v11 first — the import reads a consistent snapshot.' }, 409);
    try {
      const result = executeImport(dal.ctx.db, sourcePath);
      let gmail: ReturnType<typeof migrateGmailCredentials> | undefined;
      if (migrateGmail) {
        const mdeps = deps.unsealV11 ? { dal, unsealV11: deps.unsealV11 } : { dal };
        gmail = migrateGmailCredentials(dal.ctx.db, sourcePath, mdeps, { consent: true });
      }
      return c.json({ ...result, gmail });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return c.json({ error: err.code ?? 'import_failed', message: err.message }, 400);
    }
  });

  // -------------------------------------------------------------------------
  // Dashboard-facing additive routes (DAL-backed, lean shapes, parameterized SQL).
  // -------------------------------------------------------------------------

  // Dashboard stat cards: the 90-day funnel + 24h run stats + a few cheap totals.
  api.get('/stats', (c) => {
    const jobs = (dal.ctx.db.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number }).c;
    const applications = (dal.ctx.db.prepare('SELECT COUNT(*) AS c FROM applications').get() as { c: number }).c;
    const since7d = Date.now() - 7 * 86_400_000;
    const submitted7d = (dal.ctx.db.prepare('SELECT COUNT(*) AS c FROM applications WHERE submitted_at IS NOT NULL AND submitted_at >= ?').get(since7d) as { c: number }).c;
    return c.json({
      funnel: dal.applications.funnel({ days: 90 }),
      runs: dal.runs.stats({ hours: 24 }),
      totals: { jobs, applications, submitted7d },
    });
  });

  // Activity feed.
  api.get('/events/recent', (c) => c.json({ rows: dal.events.recent({ limit: intParam(c.req.query('limit'), 50) }).rows }));

  // Profiles (list / detail / update) — the Profile editor.
  api.get('/profiles', (c) =>
    c.json({ rows: dal.ctx.db.prepare('SELECT id, name, is_default FROM profiles ORDER BY is_default DESC, name ASC').all() }),
  );
  api.get('/profiles/:id', (c) => {
    const row = dal.ctx.db.prepare('SELECT id, name, is_default, data_json FROM profiles WHERE id = ?').get(c.req.param('id')) as
      | { id: string; name: string; is_default: number; data_json: string }
      | undefined;
    if (!row) return c.json({ error: 'not_found' }, 404);
    let data: unknown = {};
    try { data = JSON.parse(row.data_json); } catch { data = {}; }
    return c.json({ id: row.id, name: row.name, is_default: row.is_default, data });
  });
  api.put('/profiles/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as { name?: string; data?: unknown };
    const sets: string[] = [];
    const params: Record<string, unknown> = { id, now: dal.ctx.now() };
    if (typeof body.name === 'string') { sets.push('name = @name'); params.name = body.name.slice(0, 512); }
    if (body.data !== undefined) {
      const json = JSON.stringify(body.data);
      if (json.length > 262144) return c.json({ error: 'too_large', message: 'profile data exceeds 256KB' }, 400);
      params.data = json; // json_valid holds — JSON.stringify emits valid JSON; the column CHECK is the belt.
      sets.push('data_json = @data');
    }
    if (!sets.length) return c.json({ error: 'nothing_to_update' }, 400);
    const info = dal.ctx.db.prepare(`UPDATE profiles SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params);
    if (info.changes === 0) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  });

  // Learned answers (list scoped by profile / update / delete) — the Profile memory table.
  api.get('/answers', (c) => {
    const q = c.req.query();
    const profileId = q.profileId;
    if (!profileId) return c.json({ error: 'profileId_required' }, 400);
    const input: NonNullable<Parameters<typeof dal.answers.list>[1]> = { limit: intParam(q.limit, 200) };
    if (q.q) input.q = q.q;
    if (q.kind === 'qa' || q.kind === 'field') input.kind = q.kind;
    return c.json(dal.answers.list(profileId, input));
  });
  // full answer WITH value — the Profile page loads this on demand to view/edit an answer.
  api.get('/answers/:id', (c) => {
    const a = dal.answers.get(c.req.param('id'));
    return a ? c.json(a) : c.json({ error: 'not_found' }, 404);
  });
  api.put('/answers/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as { value?: string; locked?: boolean };
    const sets: string[] = [];
    const params: Record<string, unknown> = { id, now: dal.ctx.now() };
    if (typeof body.value === 'string') { sets.push('value = @value'); params.value = body.value.slice(0, 8192); }
    if (typeof body.locked === 'boolean') { sets.push('locked = @locked'); params.locked = body.locked ? 1 : 0; }
    if (!sets.length) return c.json({ error: 'nothing_to_update' }, 400);
    const info = dal.ctx.db.prepare(`UPDATE learned_answers SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params);
    if (info.changes === 0) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  });
  api.delete('/answers/:id', (c) => {
    const info = dal.ctx.db.prepare('DELETE FROM learned_answers WHERE id = ?').run(c.req.param('id'));
    return info.changes === 0 ? c.json({ error: 'not_found' }, 404) : c.json({ ok: true });
  });

  // Email accounts (Settings › Gmail summary).
  api.get('/email/accounts', (c) => c.json({ rows: dal.emails.listAccounts() }));

  // Data export — jobs + applications as a JSON attachment.
  api.get('/export', (c) => {
    c.header('Content-Disposition', 'attachment; filename="jat13-export.json"');
    return c.json({
      exportedAt: null,
      jobs: dal.jobs.listLean({ limit: 5000 }).rows,
      applications: dal.applications.listLean({ limit: 5000 }).rows,
    });
  });

  deps.extend?.(api); // extra authed routes (Gmail) mount here, under the same token guard

  app.route('/api', api);
}
