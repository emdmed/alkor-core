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
  type PipelineConfig,
  type ProfileConfig,
} from './core/config.ts'

// --- The domain, as data ------------------------------------------------------------
export {
  MANIFEST_NAME,
  PackError,
  SPEC_CHANGES,
  SPEC_VERSION,
  loadPack,
  resolvePackRoot,
  specGap,
  type Pack,
  type PackManifest,
} from './core/pack.ts'

// --- What a profile must expose, and how one is found -------------------------------
export {
  ProfileError,
  chatPrompt,
  loadProfileModule,
  redactor,
  requireDocumentName,
  resolveProfileModule,
  type EvalContext,
  type EvalVerdict,
  type ProfileModule,
  type ReviewContext,
  type ReviewResult,
} from './core/profile.ts'
export { type ProfileTopology, type ProfileTopologyRoute, type ProfileTopologyStage } from './core/topology.ts'

// --- The tool CONTRACT. Core defines no tools; a profile brings its own. -------------
export { dispatchCall, toolSpecs, type Dispatch, type ToolDef } from './core/tools.ts'

// --- What produced a result ---------------------------------------------------------
export { HARNESS_VERSION } from './core/version.ts'

// --- What a result COST. Server-counted, on the graded pass itself. -------------------
export {
  formatBench,
  median,
  percentile,
  summarizeBench,
  type BenchConditions,
  type BenchSample,
  type BenchSummary,
  type Timings,
} from './core/bench.ts'

// --- Provenance: the check a schema cannot do ----------------------------------------
export {
  collapse,
  verifyDerivation,
  verifyQuote,
  type DerivationRule,
  type DerivationVerdict,
  type QuoteDrift,
  type QuoteRule,
  type QuoteVerdict,
} from './core/verify.ts'

// --- What a repeated run bought, as opposed to what it averaged to --------------------
export {
  formatStability,
  summarizeStability,
  type CaseStability,
  type Observation,
  type StabilitySummary,
} from './core/stability.ts'

// --- Many documents into the one message a task sends ---------------------------------
export { assembleDocument, truncateOnCharBoundary, type AssemblyRule } from './core/assemble.ts'

// --- Tracing, with a per-profile redaction hook -------------------------------------
export { nullTrace, openTrace, stateRoot, TRACE_SPEC, type Redactor, type Trace } from './core/trace.ts'
export {
  eventOf,
  eventsOf,
  isRedacted,
  readTrace,
  TraceError,
  type TraceEvent,
  type TraceFile,
} from './core/trace-read.ts'

// --- Activity: metadata-only operational events ---------------------------------------
export {
  ACTIVITY_SPEC,
  createActivity,
  nullActivity,
  withActivity,
  withActivityScope,
  type Activity,
  type ActivityEvent,
  type ActivityInput,
  type ActivityScope,
  type StageDetail,
} from './core/activity.ts'

// --- The transport to the LLM server -----------------------------------------------
export {
  DEFAULT_URL,
  LLAMA_DEFAULT_URL,
  ChatError,
  LlamaError,
  UNIDENTIFIED,
  chat,
  defaultProvider,
  identifyServer,
  llamaChat,
  serverModel,
  serverProps,
  streamChat,
  toolChat,
  type ChatOptions,
  type Provider,
  type StreamChatOptions,
  type StreamResult,
  type ToolCall,
  type ServerIdentity,
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
export {
  route,
  type RouteRule,
  type RouteResult,
  type RouterOptions,
} from './modes/router.ts'
export {
  runPipeline,
  buildPipeline,
  type PipelineOptions,
  type PipelineResult,
  type PipelineStep,
  type PipelineStepResult,
} from './modes/pipeline.ts'
