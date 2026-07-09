// The transport the runner drives through — abstracted so the engine is testable WITHOUT a browser
// (a fake gateway replays scripted snapshots and can "die" mid-run) and swappable for the real ws
// gateway later. The runner never touches Chrome APIs; it speaks Cmd/CmdResult/PageSnapshot only.
import type { Cmd, CmdResult, PageSnapshot } from '@jat13/shared/protocol';

/** Thrown when the tab/port died before a command result arrived. The runner treats this as NORMAL
 *  (structural law 1): it parks the run to waiting_page and resumes by re-classifying the live page. */
export class PortGoneError extends Error {
  constructor(public readonly reason: 'nav' | 'close' | 'crash' | 'bfcache' = 'crash') {
    super('port_gone');
    this.name = 'PortGoneError';
  }
}

export interface ResumeInfo {
  epoch: string;
  snapshot: PageSnapshot;
}

export interface RunGateway {
  /**
   * Issue a command to the live tab for this run and await its result. Mutating ops attach a fresh
   * snapshot (`snapshotDelta`) so the app always decides against post-action reality.
   * @throws PortGoneError if the tab/port died before the result arrived.
   */
  command(runId: string, epoch: string, cmd: Cmd): Promise<CmdResult>;

  /**
   * After a PortGoneError, wait for the extension to reconnect and report the LIVE page. Resolves with
   * a fresh epoch + snapshot; the app then RE-CLASSIFIES (never replays the last command).
   * @throws on TTL expiry (the runner then re-queues / fails per the watchdog rules).
   */
  awaitResume(runId: string, timeoutMs: number): Promise<ResumeInfo>;
}
