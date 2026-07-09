// The DAL aggregate — one object the rest of the app codes against. Every module is a factory bound
// to the SAME DalContext (one db handle, one clock, one id source, one event sink), so there is
// exactly one writer path and PatchBus emission is uniform. Secrets additionally needs a Sealer
// (Electron safeStorage in main; a fake in tests) — the only external dependency any module takes.

import type { DalContext } from './util.js';
import { makeJobsDal } from './jobs.js';
import { makeApplicationsDal } from './applications.js';
import { makeRunsDal } from './runs.js';
import { makeAnswersDal } from './answers.js';
import { makeDocumentsDal } from './documents.js';
import { makeSettingsDal } from './settings.js';
import { makeSecretsDal, type Sealer } from './secrets.js';
import { makeEventsDal } from './events.js';
import { makeEmailsDal } from './emails.js';

export interface Dal {
  jobs: ReturnType<typeof makeJobsDal>;
  applications: ReturnType<typeof makeApplicationsDal>;
  runs: ReturnType<typeof makeRunsDal>;
  answers: ReturnType<typeof makeAnswersDal>;
  documents: ReturnType<typeof makeDocumentsDal>;
  settings: ReturnType<typeof makeSettingsDal>;
  secrets: ReturnType<typeof makeSecretsDal>;
  events: ReturnType<typeof makeEventsDal>;
  emails: ReturnType<typeof makeEmailsDal>;
  /** the shared context, so callers can run their own ctx.db.transaction / emit / newId. */
  ctx: DalContext;
}

export function makeDal(ctx: DalContext, deps: { sealer: Sealer }): Dal {
  return {
    jobs: makeJobsDal(ctx),
    applications: makeApplicationsDal(ctx),
    runs: makeRunsDal(ctx),
    answers: makeAnswersDal(ctx),
    documents: makeDocumentsDal(ctx),
    settings: makeSettingsDal(ctx),
    secrets: makeSecretsDal(ctx, deps.sealer),
    events: makeEventsDal(ctx),
    emails: makeEmailsDal(ctx),
    ctx,
  };
}

// Re-exports so consumers import the whole DAL surface from one place.
export type { DalContext, DomainEvent, LeanPage } from './util.js';
export { defaultContext, ulid, makeStmtCache, clampLimit } from './util.js';
export type { Sealer } from './secrets.js';
export { isSensitiveKey } from './answers.js';
export * as runFsm from './run-fsm.js';
