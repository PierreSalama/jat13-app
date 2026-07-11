// The Adapter DSL — site recipes as DATA (01-ARCHITECTURE §2 "adapters-as-data"). The generic
// app-side interpreter (driveRun) operates on PageSnapshots using these declarative rules; the
// extension has ZERO adapter knowledge. A LinkedIn/Indeed DOM change becomes a JSON edit (a new
// adapter version), never code surgery. zod validates every adapter at load so a malformed recipe is
// rejected before it can drive a run (registry law 1: skip-and-warn, never crash boot).
//
// Ported from cb25d19:shared/src/adapter-schema/index.ts. Stage-2 deltas from the port:
//   • APP-LOCAL: the Adapter DSL lives here (app/src/main/adapters/schema.ts), not in @jat13/shared.
//     The shared snapshot/protocol package is not shipped yet, so SnapRole is inlined below (kept
//     byte-identical to the old SNAP_ROLES). When the protocol lands in shared, re-import SnapRole
//     from there and delete the local copy — the enum values must stay identical.
//   • MIGRATION IS AUTHORITY: PageDef.parkIf now carries `parkKind` (was a free-form `reason`
//     string) typed to apply_runs.park_kind's CHECK vocab (001_init.sql), so a wired park writes the
//     column directly. Oracle keeps `level` (verified|grounded|inferred): the runner's oracle
//     evaluator DERIVES the apply_runs.evidence_kind value (text_became_success / url_confirmation)
//     from the oracle KIND, and the level drives the submitted-vs-ready_for_review gate (§10.2).
import { z } from 'zod';

// ── Snapshot roles (inlined from the old shared protocol; SelectorLike matches SNAPSHOT nodes) ──────
/** Roles the sensor emits (a curated interaction-oriented subset of ARIA). */
export const SNAP_ROLES = [
  'button', 'link', 'textbox', 'textarea', 'radio', 'checkbox', 'combobox', 'select',
  'option', 'file', 'heading', 'text', 'group', 'radiogroup', 'progressbar',
  'alert', 'dialog', 'img', 'iframe',
] as const;
export const SnapRole = z.enum(SNAP_ROLES);
export type SnapRole = z.infer<typeof SnapRole>;

/**
 * apply_runs.park_kind vocabulary (001_init.sql CHECK) — the ONLY values a park may resolve to. The
 * adapter declares which one a page-level park trigger maps to; the runner writes it verbatim to the
 * column (the CHECK guarantees it is always valid).
 */
export const PARK_KINDS = [
  'captcha', 'cloudflare', 'login', 'account_wall', 'resume_required',
  'needs_answer', 'awaiting_review', 'external_redirect', 'rate_limited', 'other',
] as const;
export const ParkKind = z.enum(PARK_KINDS);
export type ParkKind = z.infer<typeof ParkKind>;

/** SelectorLike matches SNAPSHOT nodes (role + name + attrs) — NOT raw CSS against the page. */
export const SelectorLike = z.object({
  role: SnapRole.optional(),
  nameRx: z.string().optional(),
  attr: z.object({
    key: z.enum(['id', 'nameAttr', 'type', 'placeholder', 'autocomplete', 'testid', 'href', 'accept']),
    rx: z.string(),
  }).optional(),
});
export type SelectorLike = z.infer<typeof SelectorLike>;

/** A classification signal (regex strings are matched app-side against the snapshot). */
export const Signal = z.union([
  z.object({ url: z.string() }), //                                    regex on location.href
  z.object({ selectorLike: SelectorLike }), //                         structural (snapshot node match)
  z.object({ buttonLabel: z.string() }), //                            regex vs loading-stripped button names
  z.object({ textPresent: z.string() }), //                            regex vs heading/alert/text nodes
  z.object({ fieldCount: z.object({ min: z.number().int().optional(), radioAware: z.literal(true) }) }),
  z.object({ frameHost: z.string() }),
]);
export type Signal = z.infer<typeof Signal>;

/** How to ground the form root on a page (ordered strategies; first that grounds wins). */
export const RootStrategy = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dialogRole') }), //                      role=dialog subtree
  z.object({ kind: z.literal('walkUpFromAdvance') }), //               v11.27 full-page: field-bearing nav-free ancestor of advance
  z.object({ kind: z.literal('attrRoot'), attr: z.object({ key: z.enum(['testid', 'id']), rx: z.string() }) }),
  z.object({ kind: z.literal('radioAwareWhole') }), //                 whole-page, radio-aware count grounds it
]);
export type RootStrategy = z.infer<typeof RootStrategy>;

/** onEnter action (e.g. click the Easy Apply opener on job_view). */
export const ActionRule = z.object({
  action: z.enum(['click', 'scrollIntoView']),
  target: SelectorLike,
  ifMissing: z.string().optional(), //   e.g. 'classifyExternal'
});
export type ActionRule = z.infer<typeof ActionRule>;

export const FillPolicy = z.object({
  requiredFirst: z.boolean().optional(),
  fillOptional: z.boolean().optional(),
  roles: z.array(SnapRole).optional(), //          restrict to these control roles
  answerConfidenceMin: z.number().min(0).max(1).optional(),
});
export type FillPolicy = z.infer<typeof FillPolicy>;

export const PAGE_KINDS = ['jobView', 'form', 'review', 'confirmation', 'wall', 'interstitial', 'external'] as const;

export const PageDef = z.object({
  key: z.string(), //                    'job_view' | 'form' | 'review' | 'confirmation' | …
  kind: z.enum(PAGE_KINDS),
  classify: z.object({
    all: z.array(Signal).optional(), //  AND
    any: z.array(Signal).optional(), //  OR
    none: z.array(Signal).optional(), // NOT
  }),
  formRoot: z.array(RootStrategy).optional(),
  onEnter: z.array(ActionRule).optional(),
  fill: FillPolicy.optional(),
  next: z.array(z.string()), //          legal successor page keys (the step-graph edges)
  // page-level park triggers → a value from apply_runs.park_kind (the migration is authority).
  parkIf: z.array(z.object({ signal: Signal, parkKind: ParkKind })).optional(),
});
export type PageDef = z.infer<typeof PageDef>;

export const AdvancePolicy = z.object({
  labels: z.array(z.string()), //        regex strings vs stripLoadingPrefix()'d names
  finalLabels: z.array(z.string()), //   the ones that mean SUBMIT (arm success oracles)
  neverLabels: z.array(z.string()), //   openers etc. — in-form scan must never click these
  disabledIsWaiting: z.literal(true), // ALWAYS true (v11.86 law: disabled advance = present-and-waiting)
  waitEnabledMs: z.number().int(),
  maxLabelLen: z.number().int().default(40),
});
export type AdvancePolicy = z.infer<typeof AdvancePolicy>;

export const Oracle = z.discriminatedUnion('kind', [
  z.object({ id: z.string(), kind: z.literal('urlMatches'), rx: z.string(), level: z.enum(['verified', 'grounded']) }),
  z.object({ id: z.string(), kind: z.literal('textPresent'), rx: z.string(), level: z.literal('verified') }),
  z.object({ id: z.string(), kind: z.literal('nodeGone'), page: z.string(), level: z.literal('inferred') }),
  z.object({ id: z.string(), kind: z.literal('realCaptchaWidget') }), //   visible ≥60×30, excludes invisible badges (v11.59)
  z.object({ id: z.string(), kind: z.literal('challengeCopy'), rx: z.string() }),
]);
export type Oracle = z.infer<typeof Oracle>;

export const RunLimits = z.object({
  maxSteps: z.number().int().default(12), //          page transitions
  maxSameActionRepeat: z.number().int().default(2), // duplicate-opener/advance breaker
  perActionMs: z.number().int().optional(),
});
export type RunLimits = z.infer<typeof RunLimits>;

/** Adapter-specific label→profile-key hints. The answer ladder owns the actual resolution. */
export const FieldRule = z.object({
  labelRx: z.string(),
  mapTo: z.string().optional(), //       profile key ('email','phone','workAuthorization',…); '@resume'/'@coverLetter' = attachments
  grounded: z.enum(['work_auth', 'sponsorship', 'ability_to_perform', 'referral_na', 'notice_period']).optional(),
  neverAutofill: z.literal(true).optional(), // EEO/sensitive — park instead
});
export type FieldRule = z.infer<typeof FieldRule>;

export const ADAPTER_SOURCES = ['linkedin', 'indeed', 'greenhouse', 'lever', 'ashby', 'generic', 'wall'] as const;

export const AdapterDoc = z.object({
  id: z.string(), //                     'linkedin-easy-apply'
  version: z.number().int(), //          bump on every edit; runs pin adapter_version
  engineMin: z.string(), //              semver of interpreter this doc requires
  source: z.enum(ADAPTER_SOURCES), //    routes to a lane (linkedin→linkedin, indeed→indeed, gh/lever/ashby→ats)
  hosts: z.array(z.string()), //         ['*.linkedin.com'] — first-pass routing
  priority: z.number().int(), //         higher wins when multiple docs match a host
  pages: z.array(PageDef).min(1),
  fieldMap: z.array(FieldRule).default([]),
  advance: AdvancePolicy,
  oracles: z.object({
    success: z.array(Oracle).default([]),
    failure: z.array(Oracle).default([]),
    humanGate: z.array(Oracle).default([]),
  }),
  limits: RunLimits,
  quirks: z.record(z.string(), z.unknown()).optional(), // documented escape hatch, interpreter-versioned
});
export type AdapterDoc = z.infer<typeof AdapterDoc>;

/** Parse + validate a raw adapter JSON. Throws (zod) with a precise path on a malformed recipe. */
export function parseAdapter(raw: unknown): AdapterDoc {
  return AdapterDoc.parse(raw);
}
