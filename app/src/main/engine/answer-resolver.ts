// The profile-first answer resolver (Pillar 3, resolver #7) — produces the `ResolveControl` the runner
// calls for every UNSATISFIED form control. It answers ONLY from two trusted sources, in a fixed order:
//   1. the SENSITIVE GUARD (EEO/demographic/SSN/DOB/salary-history/criminal + adapter neverAutofill) — PARK
//   2. the human's PROFILE (email/phone/name/city/links/work-auth/years-of-experience)
//   3. the per-profile LEARNED ANSWERS (ask-once-ever memory), gated by a confidence floor
//   4. otherwise → PARK (reason 'unknown'); the runner batches all parks into one needs_answer stop.
//
// There is NO AI here. Unknowns park; the Codex fallback is a separate, later wiring. Parking is the
// safe default — a wrong autofill on a screening question is worse than asking the human once.
import type { SnapNode } from '@jat13/shared/protocol';
import type { AdapterDoc, PageDef, FieldRule } from '../adapters/schema.js';
import { normQuestion } from '../db/dal/index.js';
import { isSensitiveKey, type makeAnswersDal } from '../db/dal/answers.js';
import type { ControlAnswer, ResolveControl } from './runner.js';

type AnswersDal = ReturnType<typeof makeAnswersDal>;

export interface ResolverDeps {
  answers: AnswersDal;
  /** The active profile's free-form field bag (the `data_json` payload). */
  profile: { data: Record<string, unknown> };
  /** Adapter label→profile-key hints; `neverAutofill` rules force a park. Optional. */
  fieldMap?: FieldRule[];
  profileId: string;
  /** Learned answers below this confidence are ignored (park instead). Default 0.5. */
  confidenceMin?: number;
}

/** The stable key for a control: the resolved group prompt when present, else the accessible name. */
export function controlKey(control: SnapNode): string {
  return normQuestion(control.groupPrompt || control.name || '');
}

// ---- profile-key aliases ----------------------------------------------------
// A profile.data bag can spell the same fact many ways (v11 stored `firstName`, the importer wrote
// `first_name`, a hand-edit used `given name`). Each canonical concept lists every alias we accept;
// the first key that resolves to a non-empty string wins. Kept explicit (not fuzzy) so a resolution
// is always auditable — no surprise autofills from a coincidental substring match.
const PROFILE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  email: ['email', 'emailAddress', 'email_address', 'contactEmail'],
  phone: ['phone', 'phoneNumber', 'phone_number', 'mobile', 'telephone', 'cell'],
  firstName: ['firstName', 'first_name', 'givenName', 'given_name', 'fname'],
  lastName: ['lastName', 'last_name', 'familyName', 'family_name', 'surname', 'lname'],
  fullName: ['fullName', 'full_name', 'name'],
  city: ['city', 'town', 'locality'],
  linkedin: ['linkedin', 'linkedinUrl', 'linkedin_url', 'linkedInUrl'],
  website: ['website', 'websiteUrl', 'website_url', 'portfolio', 'portfolioUrl', 'personalSite'],
  workAuthorization: ['workAuthorization', 'work_authorization', 'authorizedToWork', 'workAuthorized'],
  yearsOfExperience: ['yearsOfExperience', 'years_of_experience', 'yearsExperience', 'experienceYears'],
};

/** Read the first non-empty string among a concept's aliases from the profile bag. */
function readProfile(data: Record<string, unknown>, concept: keyof typeof PROFILE_ALIASES): string | null {
  for (const alias of PROFILE_ALIASES[concept] ?? []) {
    const raw = data[alias];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    if (typeof raw === 'boolean') return raw ? 'Yes' : 'No';
  }
  return null;
}

// ---- concept detection from a control's normalized key ----------------------
// The control key is a SORTED bag of tokens (normQuestion), so we test token membership, never a
// left-to-right phrase. Order-independence is the whole point: "email address" and "your e-mail" and
// French "adresse courriel" all fold to the token `email`.
function hasAll(tokens: ReadonlySet<string>, ...need: string[]): boolean {
  return need.every((t) => tokens.has(t));
}

interface Concept {
  concept: keyof typeof PROFILE_ALIASES;
  /** True when this control is asking for `concept`. */
  match: (tokens: ReadonlySet<string>) => boolean;
}

// Ordered most-specific first so e.g. "first name" resolves before the generic "name" concept.
const CONCEPTS: readonly Concept[] = [
  { concept: 'email', match: (t) => t.has('email') },
  { concept: 'phone', match: (t) => t.has('phone') },
  { concept: 'linkedin', match: (t) => t.has('linkedin') },
  { concept: 'website', match: (t) => t.has('website') || t.has('portfolio') },
  { concept: 'firstName', match: (t) => hasAll(t, 'firstname', 'name') || t.has('firstname') || hasAll(t, 'first', 'name') },
  { concept: 'lastName', match: (t) => t.has('lastname') || hasAll(t, 'last', 'name') || t.has('surname') },
  { concept: 'city', match: (t) => t.has('city') },
  {
    concept: 'workAuthorization',
    // "authorized to work", "work authorization", "legally authorized" → all carry work+authoriz*
    match: (t) => (t.has('work') || t.has('legally')) && (t.has('authorization') || t.has('authorized')),
  },
  {
    concept: 'yearsOfExperience',
    match: (t) => t.has('years') && t.has('experience'),
  },
  // fullName last: a bare "name" with no first/last qualifier.
  { concept: 'fullName', match: (t) => t.has('name') },
];

function detectConcept(tokens: ReadonlySet<string>): keyof typeof PROFILE_ALIASES | null {
  for (const c of CONCEPTS) if (c.match(tokens)) return c.concept;
  return null;
}

// ---- role → answer shape ----------------------------------------------------
const FILL_ROLES = new Set<SnapNode['role']>(['textbox', 'textarea', 'combobox']);

/** Wrap a resolved string value as the ControlAnswer that fits the control's role, or park if the
 *  role can't be satisfied by a plain value (e.g. a checkbox needs an explicit yes/no, not a string). */
function valueToAnswer(control: SnapNode, value: string): ControlAnswer {
  const role = control.role;
  if (FILL_ROLES.has(role)) return { kind: 'fill', value };
  if (role === 'select') return { kind: 'select', byText: value };
  if (role === 'radiogroup' || role === 'radio') return { kind: 'radio', byText: value };
  if (role === 'checkbox') {
    // A checkbox is only autofilled for an unambiguous affirmative; anything else is ambiguous → park.
    if (/^(yes|true|y|1|on|checked)$/i.test(value.trim())) return { kind: 'fill', value: 'true' };
    return { kind: 'park', reason: 'unknown' };
  }
  // file uploads and anything else are not this resolver's job.
  return { kind: 'park', reason: 'unknown' };
}

// ---- fieldMap lookup --------------------------------------------------------
/** The first fieldMap rule whose labelRx matches the control's prompt/name (case-insensitive). */
function matchFieldRule(control: SnapNode, fieldMap: readonly FieldRule[]): FieldRule | null {
  const label = control.groupPrompt || control.name || '';
  for (const rule of fieldMap) {
    let rx: RegExp;
    try {
      rx = new RegExp(rule.labelRx, 'i');
    } catch {
      continue; // a malformed adapter pattern degrades to "no match", never a throw.
    }
    if (rx.test(label)) return rule;
  }
  return null;
}

/**
 * Build the profile-first resolver the runner drives. The returned function is pure w.r.t. its
 * closure (the DAL/profile), so the runner can call it once per unsatisfied control per step.
 *
 * RESOLUTION ORDER (first hit wins; every miss falls through to the next):
 *   1. SENSITIVE GUARD — isSensitiveKey(controlKey) OR a matching fieldMap rule with neverAutofill
 *      → park('sensitive'). Checked FIRST so a demographic question can never be autofilled by a
 *      coincidental profile/learned hit.
 *   2. PROFILE — a detected common concept (email/phone/name/city/links/work-auth/years) read from
 *      profile.data → the role-appropriate fill/select/radio.
 *   3. LEARNED ANSWERS — answers.lookup(profileId, controlKey); used only if value present AND
 *      confidence >= confidenceMin.
 *   4. otherwise → park('unknown').
 */
export function makeResolver(deps: ResolverDeps): ResolveControl {
  const fieldMap = deps.fieldMap ?? [];
  const confidenceMin = typeof deps.confidenceMin === 'number' ? deps.confidenceMin : 0.5;

  return function resolve(control: SnapNode, _page: PageDef, _adapter: AdapterDoc): ControlAnswer {
    const key = controlKey(control);
    const tokens = new Set(key.split(' ').filter(Boolean));

    // 1) SENSITIVE GUARD FIRST — never autofill protected/regulated attributes.
    const rule = matchFieldRule(control, fieldMap);
    if (rule?.neverAutofill) return { kind: 'park', reason: 'sensitive' };
    if (isSensitiveKey(key)) return { kind: 'park', reason: 'sensitive' };

    // 2) PROFILE — the human's own known facts.
    const concept = detectConcept(tokens);
    if (concept) {
      const value = readProfile(deps.profile.data, concept);
      if (value !== null) {
        // A work-authorization radio/select answers Yes/No; a truthy profile value → "Yes".
        if (concept === 'workAuthorization' && (control.role === 'radiogroup' || control.role === 'radio' || control.role === 'select')) {
          const yes = /^(yes|true|y|1|authorized|authorised)$/i.test(value.trim());
          return { kind: control.role === 'select' ? 'select' : 'radio', byText: yes ? 'Yes' : 'No' };
        }
        const ans = valueToAnswer(control, value);
        if (ans.kind !== 'park') return ans;
        // A profile hit that the control role can't consume falls through to learned answers.
      }
    }

    // 3) LEARNED ANSWERS — ask-once-ever memory, gated by confidence.
    const learned = deps.answers.lookup(deps.profileId, key);
    if (learned && learned.value != null && learned.value !== '' && learned.confidence >= confidenceMin) {
      const ans = valueToAnswer(control, learned.value);
      if (ans.kind !== 'park') return ans;
    }

    // 4) unknown → park (the runner batches all parks into one needs_answer stop).
    return { kind: 'park', reason: 'unknown' };
  };
}

// ---- AI-aware resolver rung — ARRIVES STAGE 4 -----------------------------------------------------
// makeAiAwareResolver() will wrap makeResolver here: a genuine `unknown` park (never sensitive, never
// a known miss) escalates to the AiRouter (Claude Code / Codex), confidence-gated, saved back with
// provenance 'ai' (ask-once-ever). Until then the ladder ENDS at park(needs_answer) — the seam is this
// comment; run-service builds only makeResolver() at Stage 2.

