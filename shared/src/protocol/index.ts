// @jat13/shared/protocol — the ext<->app wire contract (Pillar 3 §3). Both the thin extension and the
// app gateway bind to THIS; a change here is a PROTOCOL_VERSION bump (see constants.ts), which surfaces
// a visible skew banner rather than silent corruption.
export * from './envelope.js';
export * from './snapshot.js';
export * from './commands.js';
export * from './events.js';
