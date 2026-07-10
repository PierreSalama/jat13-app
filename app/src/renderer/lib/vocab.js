// JAT 13 — the ONE human vocabulary. Every enum→label in the renderer lives here
// and nowhere else (CI gate fails on duplicated enum labels — the v13.0.x tree
// grew three drifting copies of STATUS_LABEL before the rebuild). Raw enum ids
// never reach the UI; unknown values humanize (snake_case → words) so a new
// backend enum degrades readably instead of leaking `interview_1` to Pierre.

export const humanize = (v) => String(v ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

// ---------------------------------------------------------------------------
// application status FSM (Track pages, funnel, pipeline columns)
// ---------------------------------------------------------------------------
export const STATUS_ORDER = ['tracked', 'submitted', 'acknowledged', 'assessment', 'interview_1', 'interview_2', 'interview_final', 'offer', 'hired', 'rejected', 'withdrawn', 'ghosted'];
export const STATUS_LABEL = {
  tracked: 'Saved', submitted: 'Applied', acknowledged: 'Acknowledged', assessment: 'Assessment',
  interview_1: 'Interview 1', interview_2: 'Interview 2', interview_final: 'Final interview',
  offer: 'Offer', hired: 'Hired', rejected: 'Rejected', withdrawn: 'Withdrawn', ghosted: 'Ghosted',
};
export const STATUS_DOT = {
  tracked: 'dim', submitted: 'bronze', acknowledged: 'sage', assessment: 'ember',
  interview_1: 'gold', interview_2: 'gold', interview_final: 'gold',
  offer: 'bronze', hired: 'sage', rejected: 'danger', withdrawn: 'dim', ghosted: 'dim',
};
export const TERMINAL_STATUS = new Set(['rejected', 'withdrawn', 'ghosted', 'hired']);
export const statusLabel = (s) => STATUS_LABEL[s] || humanize(s);
export const statusDot = (s) => STATUS_DOT[s] || 'dim';

// ---------------------------------------------------------------------------
// apply-run FSM (13 states) — label + theatre progress percentage
// ---------------------------------------------------------------------------
export const RUN_STATE = {
  queued: { label: 'Queued', pct: 8 }, leased: { label: 'Starting', pct: 16 },
  navigating: { label: 'Reading page', pct: 32 }, classifying: { label: 'Reading page', pct: 46 },
  driving: { label: 'Filling form', pct: 66 }, verifying: { label: 'Verifying submit', pct: 88 },
  waiting_page: { label: 'Waiting on page', pct: 52 }, needs_human: { label: 'Needs you', pct: 100 },
  submitted: { label: 'Submitted', pct: 100 }, ready_for_review: { label: 'Ready for review', pct: 96 },
  parked: { label: 'Parked', pct: 100 }, skipped: { label: 'Skipped', pct: 100 }, failed: { label: 'Failed', pct: 100 },
};
export const ACTIVE_RUN_STATES = ['leased', 'navigating', 'classifying', 'driving', 'verifying', 'waiting_page'];
export const TERMINAL_RUN_STATES = new Set(['submitted', 'ready_for_review', 'parked', 'skipped', 'failed']);
export const runStateLabel = (s) => RUN_STATE[s]?.label || humanize(s);

// park vocabulary (why a run stopped and what kind of human it needs)
export const PARK_LABEL = {
  captcha: 'CAPTCHA', cloudflare: 'Cloudflare check', login: 'Sign-in required', account_wall: 'Account wall',
  resume_required: 'Résumé required', needs_answer: 'Screening question', awaiting_review: 'Awaiting your review',
  external_redirect: 'External site', rate_limited: 'Rate limited', other: 'Needs attention',
};
export const ANSWERABLE_PARK = new Set(['needs_answer', 'other', 'awaiting_review']);
export const parkLabel = (k) => PARK_LABEL[k] || humanize(k);

// ---------------------------------------------------------------------------
// lanes + sources
// ---------------------------------------------------------------------------
export const LANE_LABEL = { linkedin: 'LinkedIn', indeed: 'Indeed', ats: 'Direct ATS' };
export const laneLabel = (l) => LANE_LABEL[l] || humanize(l);
export const SRC_TAG = { linkedin: 'in', indeed: 'id', lever: 'lv', greenhouse: 'gh', ashby: 'as', workday: 'wd', bamboohr: 'bh', icims: 'ic', taleo: 'tl', web: 'w' };
export const srcTagText = (source) => { const s = String(source || '').toLowerCase(); return SRC_TAG[s] || s.slice(0, 2) || '·'; };

// ---------------------------------------------------------------------------
// inbox email categories (ordered classifier output → short human chips)
// ---------------------------------------------------------------------------
export const MAIL_CAT_LABEL = {
  application_confirmation: 'Confirmation', application_ack: 'Acknowledged', interview: 'Interview',
  assessment: 'Assessment', rejection: 'Rejection', offer: 'Offer', recruiter: 'Recruiter', other: 'Other',
};
export const mailCatLabel = (c) => (c ? (MAIL_CAT_LABEL[c] || humanize(c)) : '');

// ---------------------------------------------------------------------------
// event kinds (activity ledger) — mirrors the events.kind CHECK in 001_init.sql
// ---------------------------------------------------------------------------
export const EVENT_KIND_LABEL = {
  created: 'Found', imported: 'Imported', submitted: 'Applied', status_change: 'Status',
  park: 'Parked', needs_human: 'Needs you', email: 'Email', email_matched: 'Email',
  note: 'Note', document_attached: 'Document', resume_tailored: 'Tailored',
  cover_letter_generated: 'Cover letter', autopsy_created: 'Autopsy',
  interview_detected: 'Interview', answer_learned: 'Learned',
};
export const EVENT_KIND_DOT = {
  created: 'dim', imported: 'dim', submitted: 'bronze', status_change: 'gold',
  park: 'ember', needs_human: 'ember', email: 'sage', email_matched: 'sage',
  note: 'dim', document_attached: 'bronze', resume_tailored: 'bronze',
  cover_letter_generated: 'bronze', autopsy_created: 'ember',
  interview_detected: 'gold', answer_learned: 'sage',
};
export const eventKindLabel = (k) => EVENT_KIND_LABEL[k] || humanize(k);
export const eventKindDot = (k) => EVENT_KIND_DOT[k] || 'dim';

// ---------------------------------------------------------------------------
// application via (how the application happened)
// ---------------------------------------------------------------------------
export const VIA_LABEL = { auto: 'Auto', manual: 'Manual', import: 'Imported' };
export const viaLabel = (v) => (v ? (VIA_LABEL[v] || humanize(v)) : '—');

// ---------------------------------------------------------------------------
// documents — roles + provenance of the file itself
// ---------------------------------------------------------------------------
export const DOC_ROLE_LABEL = {
  resume: 'Résumé', cover_letter: 'Cover letter', portfolio: 'Portfolio',
  transcript: 'Transcript', brief: 'Interview brief', other: 'Other',
};
export const docRoleLabel = (r) => DOC_ROLE_LABEL[r] || humanize(r);
/** roles a user may pick when uploading (generated/brief docs are engine-made). */
export const UPLOAD_DOC_ROLES = ['resume', 'cover_letter', 'portfolio', 'transcript', 'other'];
export const DOC_SOURCE_LABEL = {
  upload: 'Uploaded', application: 'From an application', folder: 'Watched folder',
  generated: 'AI-generated', import_v11: 'From v11',
};
export const docSourceLabel = (s) => DOC_SOURCE_LABEL[s] || humanize(s);

// ---------------------------------------------------------------------------
// learned memory — answer kinds + provenance (who taught the engine this)
// ---------------------------------------------------------------------------
export const ANSWER_KIND_LABEL = { field: 'Form field', qa: 'Q&A' };
export const answerKindLabel = (k) => ANSWER_KIND_LABEL[k] || humanize(k);
export const PROVENANCE_LABEL = {
  user: 'You', harvest: 'Harvested', ai: 'AI', teach: 'Taught',
  profile_push: 'Profile', deterministic: 'Derived', import_v11: 'v11 import',
};
export const provenanceLabel = (p) => PROVENANCE_LABEL[p] || humanize(p);
export const PROVENANCE_DOT = {
  user: 'gold', harvest: 'bronze', ai: 'ember', teach: 'gold',
  profile_push: 'sage', deterministic: 'sage', import_v11: 'dim',
};
export const provenanceDot = (p) => PROVENANCE_DOT[p] || 'dim';

// ---------------------------------------------------------------------------
// email→application match provenance (suggest→confirm pipeline)
// ---------------------------------------------------------------------------
export const MATCH_SOURCE_LABEL = { auto: 'Matched', suggested: 'Suggested', manual: 'Manual', dismissed: 'Dismissed' };
export const matchSourceLabel = (s) => MATCH_SOURCE_LABEL[s] || humanize(s);

// ---------------------------------------------------------------------------
// AI layer vocabulary (Stage 4 — named now so Settings/Autopsies stubs and the
// eventual ai_calls ledger all speak the same words)
// ---------------------------------------------------------------------------
export const AI_BACKEND_LABEL = { claude_code: 'Claude Code', codex: 'Codex' };
export const AI_TASK_LABEL = {
  screening: 'Screening answer', tailor_resume: 'Résumé tailoring', cover_letter: 'Cover letter',
  fit_score: 'Fit scoring', interview_brief: 'Interview brief', autopsy_summary: 'Autopsy summary',
};
export const AI_HEALTH_LABEL = {
  not_installed: 'Not installed', installed: 'Installed', creds_present: 'Credentials present', verified: 'Verified',
};

// ---------------------------------------------------------------------------
// rebuild stages — the delivery ladder (02-STAGES.md, one line each). Drives the
// Command Center progress card and every stub-card "Arrives · Stage N" badge.
// ---------------------------------------------------------------------------
export const CURRENT_STAGE = 1;
export const STAGES = [
  { n: 0, title: 'Clean slate, skeleton, harness', goal: 'Fresh monorepo, schema v1, API envelope + CI gates, tray-resident boot, dev-drive, this Atelier shell.' },
  { n: 1, title: 'Data foundation', goal: 'Your v11 life imported with full fidelity — every Track and You page browsable on real data.' },
  { n: 2, title: 'Single-apply end-to-end', goal: '“Apply now” on one chosen job, driven E2E per lane, with submit-truth evidence and a first autopsy.' },
  { n: 3, title: 'Full supervised auto-apply', goal: 'Discovery, scheduler, caps, pacing, needs-you and the fit floor — mission control goes live.' },
  { n: 4, title: 'The AI layer', goal: 'Claude Code + Codex backends: screening answers, tailored docs under the rephrase-only guardrail, fit scoring.' },
  { n: 5, title: 'Gmail, Interviews, self-healing', goal: 'Inbox classifier moves statuses; interview detection + AI briefs; autopsy patterns propose fixes.' },
  { n: 6, title: 'Unattended, hardening, release', goal: 'Idle auto-start with hard caps and notifications; soak tests; packaged release; the v11 cutover call.' },
];
