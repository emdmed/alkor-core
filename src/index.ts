/**
 * medextract — the public surface.
 *
 * A profile may live outside this repository (`module` in profiles.toml), which is what
 * lets a project keep its prompts, schemas AND the code that scores them private while
 * running this harness unmodified. That only works if there is something to import: a
 * profile is written against `ProfileModule`, calls `extract` or `runAgent`, reads a
 * `Pack` and writes to a `Trace`. This file is that contract, stated once.
 *
 * **The rule is: everything a profile is written against, and nothing that is itself a
 * profile.** So `core/` and `modes/` are here in full — including the transport, because a
 * profile that measures tool-calling behaviour reaches it directly, as `profiles/coding`
 * does. What is deliberately absent is the layer above: the profiles, the CLI's argument
 * wiring, and the window. Those are consumers of this contract, not part of it, and a
 * stranger who imports one has coupled to a decision rather than to an interface.
 *
 * Deep imports are not supported. `exports` in package.json names this file and nothing
 * else, so an internal module can be moved without breaking anyone. If something inside is
 * needed and is not re-exported here, that is a gap in this file, not a reason to reach
 * past it.
 */

// --- Where a deployment says what exists -------------------------------------------
export {
  CONFIG_NAME,
  ConfigError,
  envSuffix,
  findConfig,
  loadConfig,
  requireProfile,
  type Config,
  type Mode,
  type ProfileConfig,
} from './core/config.ts'

// --- The domain, as data ------------------------------------------------------------
export {
  MANIFEST_NAME,
  PackError,
  SPEC_VERSION,
  loadPack,
  resolvePackRoot,
  type Pack,
  type PackManifest,
} from './core/pack.ts'

// --- What a profile must expose, and how one is found -------------------------------
export {
  ProfileError,
  chatPrompt,
  loadProfileModule,
  resolveProfileModule,
  type EvalContext,
  type EvalVerdict,
  type ProfileModule,
  type ReviewContext,
  type ReviewResult,
} from './core/profile.ts'

// --- The tool CONTRACT. Core defines no tools; a profile brings its own. -------------
export { dispatchCall, toolSpecs, type Dispatch, type ToolDef } from './core/tools.ts'

// --- Tracing, with a per-profile redaction hook -------------------------------------
export { openTrace, stateRoot, type Redactor, type Trace } from './core/trace.ts'

// --- The transport to llama-server --------------------------------------------------
export {
  LLAMA_DEFAULT_URL,
  LlamaError,
  llamaChat,
  serverModel,
  streamChat,
  toolChat,
  type ChatOptions,
  type StreamChatOptions,
  type StreamResult,
  type ToolCall,
  type ToolChatOptions,
  type Usage,
} from './core/client.ts'

// --- The execution modes ------------------------------------------------------------
export { briefing, extract, type ExtractOptions, type ExtractOutcome } from './modes/extract.ts'
export { runAgent, type AgenticOptions, type AgenticResult } from './modes/agentic.ts'
export {
  createSession,
  type Consent,
  type Session,
  type SessionOptions,
  type TurnResult,
} from './modes/session.ts'
