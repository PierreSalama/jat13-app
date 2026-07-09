// classify.ts — the deterministic rules-ladder classifier (Pillar 8 / plan §5.1). ORDER IS THE
// ALGORITHM: the ladder is walked top-to-bottom and the FIRST category whose pattern hits wins, so the
// array order encodes the v11.64 precedence that stopped receipt-footer boilerplate mis-staging as an
// interview. Category PRECEDENCE (highest→lowest):
//   offer > rejection > assessment > interview > application_confirmation > recruiter > other
// This is a pure function over {from, subject, body} — no DB, no I/O, no clock — so the fixture corpus
// can gate it in isolation (plan §6.3). It NEVER matches on the subject alone (rejections routinely hide
// behind neutral subjects — the v11 lesson), so every rule runs over subject + "\n" + body(≤2000).

/** The email-category vocab — MUST equal the emails.category CHECK in migration 002 + status.json. */
export type EmailCategory =
  | 'application_confirmation'
  | 'recruiter'
  | 'assessment'
  | 'interview'
  | 'offer'
  | 'rejection'
  | 'other';

export interface ClassifyInput {
  from?: string;
  subject?: string;
  body?: string;
}

export interface ClassifyResult {
  category: EmailCategory;
  /** 0..1 — how confidently the rules ladder placed this (a strong-signal hit scores higher). */
  confidence: number;
  via: 'rules';
}

/** One rung of the ladder. `rx` is tested (case-insensitive) over the haystack; first hit on the
 *  highest rung wins. `strong` marks a high-signal pattern → a higher confidence when it fires. */
interface Rule {
  category: EmailCategory;
  rx: RegExp;
  note: string;
}

// The v11.64 rule ladder, ordered HIGHEST-precedence first. Each `rx` compiles with `i`.
// DO NOT reorder without re-running the fixture corpus — order is the classifier's semantics.
const LADDER: readonly Rule[] = [
  // 1) OFFER — terminal-positive first so an offer never gets shadowed by an interview/assessment phrase.
  {
    category: 'offer',
    rx: /\b(job offer|offer letter|letter of offer|pleased to offer|we(?:'re| are) (?:delighted|pleased|excited) to offer|offer of employment|formal offer|extend(?:ing)? (?:you )?an offer)\b/i,
    note: 'terminal-positive first',
  },
  // 2) REJECTION — v11.65 broadened set. Before assessment/interview because a rejection email can
  //    quote the role/stage it is rejecting ("your interview for X did not…").
  {
    category: 'rejection',
    rx: /\b(unfortunately|we regret to inform|regret to inform|not (?:be )?(?:moving|move) forward|won'?t be moving forward|move forward with (?:other|another)|moved forward with another|pursue other candidates|other candidates|not (?:been )?(?:selected|chosen)|not (?:a |been a )?(?:fit|match)(?: at this time)?|no longer (?:under consideration|available)|position (?:has been|is) (?:filled|no longer available)|decided not to proceed|will not be proceeding|not to move ahead)\b/i,
    note: 'v11.65 broadened set — before interview/assessment (rejections quote the stage)',
  },
  // 3) STRONG application-confirmation RECEIPT — "application was submitted/received successfully",
  //    "copy of your application". Pre-empts interview/assessment false-positives from boilerplate
  //    footers ("we will contact you to schedule an interview if…") — the CMiC bug, v11.64.
  {
    category: 'application_confirmation',
    rx: /\b(application (?:was|has been|is) (?:successfully )?(?:submitted|received|completed)|(?:successfully )?(?:submitted|received) your application|copy of your application|your application (?:was|has been) (?:sent|submitted|received)|thank you for submitting your application|we(?:'ve| have) received your application)\b/i,
    note: 'STRONG receipt — pre-empts interview footer boilerplate (CMiC bug, v11.64)',
  },
  // 4) ASSESSMENT — before interview; a coding challenge / take-home is its own stage.
  {
    category: 'assessment',
    rx: /\b(online assessment|technical assessment|coding (?:challenge|assessment|test|exercise)|take[- ]home|hackerrank|codility|codesignal|hirevue|karat|skills? (?:test|assessment)|assessment (?:invitation|link)|complete (?:the |your )?(?:assessment|challenge|test))\b/i,
    note: 'before interview — assessments are a distinct stage',
  },
  // 5) INTERVIEW — STRICT invite/scheduling language ONLY (never the bare word "interview"); checked
  //    before generic confirmation because real invites often carry neutral "Your application to X"
  //    subjects and would otherwise collapse to submitted.
  {
    category: 'interview',
    rx: /\b(interview (?:invitation|invite)|invit(?:e|ation) (?:you )?to (?:an )?interview|schedule (?:an |your |a )?interview|set up (?:an |a )?interview|book (?:an |a )?interview|(?:phone|video|onsite|on-site|technical) interview|availability for (?:an |a )?(?:interview|call)|like to (?:schedule|set up|arrange) (?:a |an )?(?:call|interview|chat)|move(?:d)? (?:you )?(?:forward|ahead) to (?:the |an )?interview)\b/i,
    note: 'strict invite language only; before generic confirmation (neutral-subject invites)',
  },
  // 6) GENERIC application-confirmation — "thanks for applying", ceipal/workable "thank you for your
  //    application FOR X" shapes (v11.49).
  {
    category: 'application_confirmation',
    rx: /\b(thank(?:s| you)?(?: so much)? for (?:applying|your (?:application|interest))|thank you for your application (?:for|to)|we appreciate your (?:application|interest)|your application (?:to|for) .+ (?:has been|was) received|application confirmation)\b/i,
    note: 'generic "thanks for applying" incl. ceipal/workable shapes (v11.49)',
  },
  // 7) RECRUITER — a cold reach / talent-team outreach (lowest positive rung).
  {
    category: 'recruiter',
    rx: /\b(recruiter|talent (?:team|acquisition|partner|advisor|specialist)|sourcing (?:team|specialist)|came across your (?:profile|resume)|reaching out (?:about|regarding) (?:a|an|our)|opportunity (?:that|which) (?:might|may) (?:be of interest|interest you)|hiring (?:manager|team) (?:would like|wanted) to (?:connect|chat))\b/i,
    note: 'recruiter cold-reach — lowest positive rung',
  },
];

/** Strong-signal patterns that, when they also match, bump confidence for the winning category. */
const STRONG_BY_CATEGORY: Partial<Record<EmailCategory, RegExp>> = {
  offer: /\b(offer letter|offer of employment|pleased to offer)\b/i,
  rejection: /\b(we regret to inform|pursue other candidates|not (?:be )?moving forward)\b/i,
  assessment: /\b(hackerrank|codility|codesignal|hirevue|online assessment)\b/i,
  interview: /\b(interview invitation|schedule (?:an|your|a) interview|invit(?:e|ation) to interview)\b/i,
  application_confirmation: /\b(application (?:was|has been) (?:submitted|received))\b/i,
};

/** Trim + lowercase the body to a bounded window and join with the subject — the one haystack every
 *  rule runs over. Body is capped at 2000 chars (a rejection/offer never buries its verdict past that,
 *  and it caps the regex work per email). */
function buildHaystack(input: ClassifyInput): string {
  const subject = input.subject ?? '';
  const body = (input.body ?? '').slice(0, 2000);
  return `${subject}\n${body}`;
}

/**
 * Classify one email by walking the ordered rules ladder. Returns the first (highest-precedence)
 * category whose pattern hits, with a confidence that is higher when a strong-signal sub-pattern also
 * matches. No hit anywhere → { category: 'other', confidence: 0 }. Pure — safe to fuzz/corpus-gate.
 */
export function classifyEmail(input: ClassifyInput): ClassifyResult {
  const haystack = buildHaystack(input);
  for (const rule of LADDER) {
    if (rule.rx.test(haystack)) {
      const strong = STRONG_BY_CATEGORY[rule.category];
      const confidence = strong && strong.test(haystack) ? 0.92 : 0.7;
      return { category: rule.category, confidence, via: 'rules' };
    }
  }
  return { category: 'other', confidence: 0, via: 'rules' };
}
