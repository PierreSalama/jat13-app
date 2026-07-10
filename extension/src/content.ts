// The content-script ENTRY — Stage 0: a DORMANT stub. Built to dist/content.js so the bundle
// pipeline is proven from day one, but NOT registered in manifest.json (no content_scripts block —
// see build.mjs header), so Chrome never injects it. Inert twice over.
//
// THE DORMANT-BY-DEFAULT CONTRACT (the law this file exists to carry into Stage 2):
// on load the script does the BARE minimum — connect its port and say hello — then WAITS. The
// service worker is the sole authority and puts a tab into exactly ONE of three states:
//
//   • DRIVE   (activate {runId, epoch})  — the tab is leased to a run. Only then: first snapshot,
//     MutationObserver, Cmd envelopes → actuator. The actuator structurally refuses any mutating op
//     whose epoch doesn't match the lease (stale-epoch guard).
//   • OBSERVE (observe {sessionId})      — watch-and-learn: passive recorder only, triple-redacted
//     at capture. No driving, no commands, no navigation.
//   • DORMANT (deactivate)               — tear everything down and go quiet. THE DEFAULT.
//
// WHY this is a law and not a style: the v11 content script snapshotted on EVERY page load and
// rebuilt a full 128KB snapshot every 500ms on ANY mutation, run or no run — a drain on heavy
// sites, and a stray page_ready could be mistaken for a resumable run and re-navigate ("refresh")
// the user's tab. A tab must do NOTHING until the SW assigns it a state.
//
// Stage 2 ports the full machine (sensor + actuator + recorder + port lifecycle) from the proven
// tree (git cb25d19:extension/src/content.ts). Until then: no port, no listeners, no logging —
// even a console.log would violate "dormant does nothing" on someone's LinkedIn tab.

/** The 3-state lifecycle. The SW assigns it; this script only ever mirrors the assignment. */
type Mode = 'dormant' | 'observe' | 'drive';

interface Lifecycle {
  mode: Mode;
  /** set by `activate`; commands whose epoch ≠ this are refused (stale-epoch guard) */
  epoch: string;
  runId?: string;
  sessionId?: string;
}

const lifecycle: Lifecycle = { mode: 'dormant', epoch: '' };

/** Stage-0 boot: intentionally does nothing — not even a hello (there is no port to say it on
 *  until Stage 2 registers the script and the SW grows its tab registry). */
function boot(): Lifecycle {
  return lifecycle;
}

boot();
