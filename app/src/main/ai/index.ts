// JAT 13 — AI service barrel. One import site for the Codex-backed screening-answer service.
// The only provider is the Codex CLI (Pierre's ChatGPT/Codex subscription, no API keys); see codex.ts.
export {
  makeAiService,
  discoverCli,
  status,
  generate,
  defaultRunCodex,
  extractAssistantText,
  CodexError,
  SCREENING_SCHEMA,
} from './codex.js';
export type {
  AiService,
  AiServiceDeps,
  AiSettings,
  CodexStatus,
  CodexSource,
  DiscoveredCli,
  CodexCall,
  CodexRaw,
  RunCodex,
  CodexErrorCode,
  GenerateOpts,
  GenerateResult,
  ScreeningControl,
  ScreeningContext,
  ScreeningAnswer,
} from './codex.js';
