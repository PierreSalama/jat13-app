// The LEARN DISTILLER — turns a batch of passively-observed interactions (the user filling their OWN
// application, watched by the extension recorder in OBSERVE mode) into learned answers on the default
// profile. It is the app-side half of watch-and-learn. Ported VERBATIM from the proven cb25d19 tree;
// the ONE new-convention delta is the default-profile lookup goes through dal.profiles.getDefault()
// instead of a raw `dal.ctx.db.prepare(...)` (no raw SQL outside db/dal/ — the grep-gated law).
//
// SECURITY: redaction is enforced in THREE independent places and this is the second. The recorder
// never sends a sensitive VALUE (it marks the event `redacted`); this distiller DROPS every redacted
// event before it can be recorded; and even a non-redacted event with a sensitive LABEL is dropped a
// THIRD time by dal.answers.record() (isSensitiveKey → returns null). Defense in depth: a demographic /
// SSN / DOB / salary-history answer can never reach learned_answers.
//
// Dedup / ask-once is the DAL's job: record() upserts on (profile, kind, key_norm), so re-observing the
// same question bumps seen_count instead of inserting a duplicate.

import type { Dal } from '../db/dal/index.js';
import type { FieldType, RecordInput } from '../db/dal/answers.js';

/** One passively-observed interaction as sent up by the extension recorder. */
export interface ObservedEvent {
  kind: 'fill' | 'choose' | 'advance';
  label?: string;
  fieldType?: string;
  value?: string | null;
  choice?: string | null;
  /** true ⇒ a sensitive/secret field: LABEL only was captured, value is null. NEVER stored. */
  redacted?: boolean;
  at?: number;
}

/** A batch flushed by one OBSERVE session on one page. */
export interface ObservedBatch {
  sessionId?: string;
  url?: string;
  host?: string;
  events: ObservedEvent[];
}

export interface IngestResult {
  /** how many learned answers were recorded (inserted or upserted). */
  learned: number;
  /** how many events were dropped (redacted, sensitive-label, empty, or non-answer). */
  dropped: number;
}

export type LearnDistiller = ReturnType<typeof makeLearnDistiller>;

const FIELD_TYPES: ReadonlySet<string> = new Set([
  'text', 'textarea', 'select', 'radio', 'checkbox', 'number', 'date', 'file',
]);

/** Map the recorder's coarse field-type tag onto the learned_answers.field_type vocabulary. */
function mapFieldType(ft: string | undefined): FieldType | undefined {
  if (!ft) return undefined;
  if (FIELD_TYPES.has(ft)) return ft as FieldType;
  if (ft === 'email' || ft === 'tel' || ft === 'url' || ft === 'search' || ft === 'password') return 'text';
  return undefined;
}

/** The value we learn from an event: the chosen option for a choose, the typed value for a fill. */
function pickValue(ev: ObservedEvent): string | null {
  if (ev.kind === 'choose') return ev.choice ?? ev.value ?? null;
  return ev.value ?? null;
}

function safeHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

export function makeLearnDistiller(deps: { dal: Dal }) {
  const { dal } = deps;

  /**
   * Ingest one observed batch. For every NON-redacted fill/choose with a resolvable label + value,
   * record a `qa` learned answer (provenance 'harvest', confidence 0.6). Redacted events and events
   * whose label the DAL deems sensitive are dropped. Optionally records a timeline note. Never throws.
   */
  function ingest(batch: ObservedBatch): IngestResult {
    let learned = 0;
    let dropped = 0;
    const events = Array.isArray(batch?.events) ? batch.events : [];

    // Learning always attaches to the default profile (learned memory is per-profile, FK-cascaded).
    const profileId = dal.profiles.getDefault()?.id;
    if (!profileId) return { learned: 0, dropped: events.length };

    const host = batch.host || safeHost(batch.url);

    for (const ev of events) {
      if (!ev || ev.kind === 'advance') continue; // 'advance' is a transition marker, nothing to learn
      if (ev.redacted) { dropped++; continue; } // ABSOLUTE: a redacted event is never stored
      const label = (ev.label ?? '').trim();
      const value = pickValue(ev);
      if (!label || value == null || value === '') { dropped++; continue; }

      const input: RecordInput = {
        kind: 'qa',
        label,
        value,
        provenance: 'harvest',
        confidence: 0.6,
      };
      if (host) input.sourceHost = host;
      const ft = mapFieldType(ev.fieldType);
      if (ft) input.fieldType = ft;

      // record() returns null when the DAL drops a sensitive KEY — count that as dropped (belt #3).
      const rec = dal.answers.record(profileId, input);
      if (rec) learned++;
      else dropped++;
    }

    // A single, quiet timeline note so the user can SEE that learning happened (never per-answer spam).
    if (learned > 0 && host) {
      try {
        dal.events.record({
          kind: 'note',
          source: host.slice(0, 64),
          summary: `Learned ${learned} answer(s) from you on ${host}`,
        });
      } catch {
        /* best-effort — a note failure must never fail the ingest */
      }
    }

    return { learned, dropped };
  }

  return { ingest };
}
