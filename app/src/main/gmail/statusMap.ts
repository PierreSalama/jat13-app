// statusMap.ts — the ONE mapping from an email category to the application status it advances a job to
// (Pillar 8 / plan §8.1). Deliberately tiny and pure so the elevation caller has a single, auditable
// place that decides "does this email move the funnel, and to where". A `null` return means the category
// is NOT status-bearing (recruiter outreach, generic 'other') — the caller must NOT elevate.
//
// The forward-only guard lives in applications.elevate (the DAL), NOT here: this map is allowed to name
// a status "below" a job's current one (e.g. a late application_confirmation → 'submitted' for a job
// already at 'interview_1'); elevate refuses the backward move and the pipeline stays honest. So this
// map only answers "what stage does this category assert?", never "is it allowed right now?".

import type { ApplicationStatus } from '../db/dal/applications.js';
import type { EmailCategory } from './classify.js';

/**
 * Map an email category to the application status it asserts, or `null` when the category carries no
 * status signal. Mapping (v11 FSM, unchanged):
 *   offer                    → offer
 *   rejection                → rejected
 *   assessment               → assessment
 *   interview                → interview_1   (a first invite; further rounds are set by the user/UI)
 *   application_confirmation → submitted     (the job entered the funnel; elevate stamps submitted_at)
 *   recruiter | other        → null          (not status-bearing — caller elevates nothing)
 */
export function categoryToStatus(category: EmailCategory): ApplicationStatus | null {
  switch (category) {
    case 'offer':
      return 'offer';
    case 'rejection':
      return 'rejected';
    case 'assessment':
      return 'assessment';
    case 'interview':
      return 'interview_1';
    case 'application_confirmation':
      return 'submitted';
    case 'recruiter':
    case 'other':
      return null;
    default: {
      // Exhaustiveness guard: a new category must be handled explicitly (TS errors here if not).
      const _never: never = category;
      return _never;
    }
  }
}
