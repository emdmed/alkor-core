/**
 * What a profile must expose for the CLI to run it.
 *
 * Profiles are resolved by dynamic import, keyed by the profile name in profiles.toml.
 * There is no registry file to edit: adding a domain means adding a directory and a config
 * entry, which is what keeps the harness itself free of any particular project's
 * vocabulary.
 *
 * A profile may live OUTSIDE this repository, named by `module` in profiles.toml exactly
 * as `pack` names a contract pack. The two belong together: a domain's prompts and its
 * scoring rules are the same secret, and a project that must keep its pack private has no
 * use for a harness that makes it publish the scorer that reads it. Out-of-tree profiles
 * are also how a proprietary domain extends this harness without forking it.
 *
 * `runEval` returns a uniform verdict so the CLI's exit code is decided in one place
 * rather than reimplemented per profile — a profile that gates on recall and one that
 * gates on tool selection should not disagree about what exit 1 means.
 */
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Pack } from './pack.ts'
import type { ToolDef } from './tools.ts'
import { CONFIG_NAME, envSuffix, type Mode, type ProfileConfig } from './config.ts'
import type { Provider } from './client.ts'
import type { Redactor, Trace } from './trace.ts'
import type { Activity } from './activity.ts'
import type { ProfileTopology } from './topology.ts'

const envKey = (name: string) => `PROFILE_MODULE_${envSuffix(name)}`

export interface EvalContext {
  config: ProfileConfig
  /** Present iff the profile's config names a pack. */
  pack?: Pack
  baseUrl?: string
  trace: Trace
  /** Everything else the CLI collected: --runs, --constrain, and so on. */
  options: Record<string, unknown>
  /** A custom LLM provider; defaults to the built-in HTTP client. */
  provider?: Provider
  /** Activity bus for operational events. */
  activity?: Activity
}

export interface EvalVerdict {
  /** Decides the process exit code. */
  pass: boolean
  /** One line, printed last. Says which number gated and where it landed. */
  summary: string
}

export interface ProfileModule {
  name: string
  mode: Mode
  /** Whether `runEval` requires `ctx.pack`. Checked before any server call. */
  needsPack: boolean
  systemPrompt?: string
  /**
   * The system prompt for INTERACTIVE use, defaulting to `systemPrompt`. Present makes a
   * profile CONVERSATIONAL, whatever its mode — a chat is not the property of the agentic
   * loop, it is the property of having something to say.
   *
   * It diverges from `systemPrompt` for a real reason rather than for tidiness. For an
   * agentic profile, an eval prompt is written for one task run to completion, so it tends
   * to demand a terminal call and speak of "the task", which in a conversation ends a turn
   * the user meant to continue. For an extract profile the gap is wider still: the eval
   * prompt orders the model to emit nothing but JSON against a schema, which is precisely
   * what a person asking a question does not want.
   *
   * A function when the prompt is built from the pack — the vocabulary a profile wants to
   * talk about is usually the vocabulary it extracts, and that lives in the pack rather
   * than in the code.
   */
  chatSystemPrompt?: string | ((pack?: Pack) => string)
  /** Agentic profiles only: the toolset the loop is handed. */
  tools?: ToolDef[]
  /** Agentic profiles only: default iteration cap, overridable with --iterations. */
  maxIterations?: number
  /**
   * Static execution shape for dashboards and other topology clients. Optional so existing
   * out-of-tree profiles remain compatible; the server supplies a conservative mode-level
   * blueprint when a profile does not declare its finer-grained shape.
   */
  topology?: ProfileTopology
  /**
   * Redaction for this profile's trace lines. `trace.ts` promises this hook and it has to
   * be reachable from somewhere: a trace holds the raw prompt and the raw completion, so
   * for a profile over real records it holds patient data. Absent means identity, which is
   * a statement about a synthetic corpus rather than a safe default.
   *
   * Use `redactFor` instead when the answer depends on the pack, which for a corpus-handling
   * profile it usually does. Resolved through `redactor()` below, never read directly.
   */
  redact?: Redactor
  /**
   * Redaction chosen once the pack is known, and preferred over `redact` when both are set.
   *
   * Separate from `redact` rather than a union with it, deliberately. A `Redactor` and a
   * `(pack) => Redactor` are both functions of one argument and cannot be told apart at
   * runtime, so a union would be resolved by guessing — and the guess that fails hands the
   * factory itself to `openTrace`, which then writes every line unredacted while the profile
   * appears to have redaction configured. Two fields cannot be guessed wrong.
   */
  redactFor?(pack?: Pack): Redactor
  /**
   * Extract profiles only: documents in the pack that `review` will accept by name.
   *
   * `options` is what the CLI collected, and it is here because a profile may read more than
   * one corpus. The clinical pack holds written notes for three tasks and dictated
   * transcripts for a fourth, filed apart on purpose; `--case tr-en-02-self-correction`
   * names a document that exists only under `--task transcript`, and a name list that
   * ignored the task would refuse it while claiming the pack does not hold it.
   */
  documentNames?(pack: Pack, options?: Record<string, unknown>): string[]
  /** Extract profiles only: one interactive document review. */
  review?(ctx: ReviewContext): Promise<ReviewResult>
  /**
   * How this profile measures itself, when it has a measurement to offer.
   *
   * Optional, because "no eval" is a true thing for a profile to say and the required form
   * gave it no way to say it. A workflow whose steps are declared in profiles.toml has
   * nothing of its own to measure until someone writes a corpus for it, and under the
   * required form it still had to return a verdict — so the stub asserted what `loadConfig`
   * had already enforced and reported `pass: true`. A green PASS for a workflow nobody has
   * measured is worse than no eval at all, because it is indistinguishable from one that was.
   *
   * A profile with neither this nor `review` is refused at load: it is a module that can
   * be named but never run.
   */
  runEval?(ctx: EvalContext): Promise<EvalVerdict>
}

/**
 * One interactive extraction: a document in, a structured result out.
 *
 * This stays one-shot no matter what else the profile offers. The answer is constrained by
 * a grammar, and there is no follow-up turn that could refine it without abandoning the
 * schema that makes it trustworthy — a second pass that "took the correction into account"
 * would no longer be the thing the eval measures, which is the only reason to run it here.
 *
 * A profile may ALSO be conversational (`chatSystemPrompt`), and an extract profile usually
 * should be. The two do not merge: the conversation is where a result is questioned, this is
 * where one is produced, and a host puts the second into the first rather than blurring
 * them.
 */
export interface ReviewContext {
  pack?: Pack
  baseUrl?: string
  trace: Trace
  /**
   * A named document from the pack, or text the user supplied directly.
   *
   * Supplied text carries an optional `label` — the file it was read from, or `stdin`.
   * Only the host knows that, and a report headed "supplied document" is one nobody can
   * match back to the note it was about once two of them are on screen.
   */
  input: { kind: 'case'; name: string } | { kind: 'text'; text: string; label?: string }
  options: Record<string, unknown>
  /** A custom LLM provider; defaults to the built-in HTTP client. */
  provider?: Provider
  /** Activity bus for operational events. */
  activity?: Activity
}

export interface ReviewResult {
  /**
   * Rendered and ready to print. The profile owns how its own domain reads — a host that
   * formatted this itself would become a second, drifting source of truth for numbers the
   * profile already knows how to report.
   */
  text: string
  /** False when the extraction never produced a usable structure. */
  ok: boolean
  /**
   * The model's completion, unaltered — what a consuming application's parser receives.
   *
   * Passed through rather than re-serialized from the profile's parsed shape, and the
   * difference matters: a parser normally keeps the fields it grades and drops the rest, so
   * re-serializing would hand a caller a tidied document that no model ever emitted. Present
   * even when `ok` is false, because a reply that would not parse is exactly the one worth
   * looking at.
   */
  raw?: string
  /**
   * The document that was actually reviewed, and what to call it.
   *
   * Returned so a host that also runs a CONVERSATION can put the document into it. Only
   * the profile knows what `/case sle-flare-01` resolved to on disk, and a conversation
   * about a note that only one side has read is worse than no conversation at all.
   */
  document?: string
  label?: string
  /**
   * The same reading as data, when the profile has one to give.
   *
   * Optional because it is a stronger promise than `raw`: a completion is whatever the model
   * said, and this is what the profile CONCLUDED — the parsed structure together with every
   * verdict it computed about it. That is the object a second implementation of the same
   * contract is compared against, and the comparison needs the verdicts: two runtimes that
   * emit identical bytes and disagree about which quotes verify are not the same runtime, and
   * nothing in the completion shows the difference.
   *
   * A profile without one is not deficient. Vital signs has none because its `--json` is a
   * pipe into an application that parses the completion itself, and changing that shape would
   * break the caller to serve a fixture it never asked for.
   */
  report?: unknown
}

/**
 * The profile's interactive system prompt, or undefined when it has no conversation to
 * have. Resolved in one place so a host never has to know which of the two forms a given
 * profile chose.
 */
export const chatPrompt = (profile: ProfileModule, pack?: Pack): string | undefined => {
  const p = profile.chatSystemPrompt ?? profile.systemPrompt
  return typeof p === 'function' ? p(pack) : p
}

/**
 * The profile's trace redactor, resolved against the pack it will be tracing.
 *
 * Resolved in one place for the same reason `chatPrompt` above is: a host should not have to
 * know which of the two forms a profile chose, and this is the one hook where getting it
 * wrong writes patient data to disk rather than printing the wrong string.
 */
export const redactor = (profile: ProfileModule, pack?: Pack): Redactor | undefined =>
  profile.redactFor ? profile.redactFor(pack) : profile.redact

export class ProfileError extends Error {}

/**
 * Check a `--case` name against the documents the profile says its pack holds.
 *
 * The failure is worth its own message. A pack's documents are named by a TEMPLATE rather
 * than by a manifest key, so a mistyped name reaches the filesystem and comes back as
 * ENOENT on a path the user never typed — technically accurate and useless. Listing what
 * the pack actually offers turns that into a one-glance fix, and a profile with no named
 * documents at all is a different mistake that deserves saying so.
 */
export const requireDocumentName = (
  profile: ProfileModule,
  pack: Pack,
  name: string,
  options: Record<string, unknown> = {},
): string => {
  const names = profile.documentNames?.(pack, options) ?? []
  if (!names.length) {
    throw new ProfileError(
      `profile '${profile.name}' exposes no named documents, so --case has nothing to select — pass --note FILE instead`,
    )
  }
  if (!names.includes(name)) {
    throw new ProfileError(`pack '${pack.name}' has no document '${name}' — it holds: ${names.join(', ')}`)
  }
  return name
}

/**
 * Where a profile's module lives, or undefined for the built-in `src/profiles/<name>/`.
 *
 * Precedence and base-directory rules are deliberately identical to `resolvePackRoot`, so
 * the two halves of a domain are wired the same way: `PROFILE_MODULE_<NAME>` first, then
 * `module` in profiles.toml, then the built-in. An env var and a config entry disagree
 * about what a relative path means — one comes from a shell and one from a file — so each
 * resolves against its own origin.
 */
export const resolveProfileModule = (
  name: string,
  opts: { configured?: string; base: string },
): string | undefined => {
  const env = process.env[envKey(name)]
  const chosen = env ?? opts.configured
  if (!chosen) return undefined
  return isAbsolute(chosen) ? chosen : resolve(env !== undefined ? process.cwd() : opts.base, chosen)
}

/**
 * Load a profile module. `module` is an absolute path from `resolveProfileModule`; without
 * one the built-in directory is used.
 *
 * The name is validated only on the built-in path, and that asymmetry is the point. There,
 * a command-line string is interpolated into an import specifier and must not be able to
 * escape the directory. An explicit `module` is a path its author wrote into profiles.toml
 * — the same trust already extended to `pack`, which routinely contains `..` — so it is
 * taken at face value rather than being pattern-matched into uselessness.
 */
export const loadProfileModule = async (name: string, module?: string): Promise<ProfileModule> => {
  if (!module && !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new ProfileError(`invalid profile name '${name}' (expected lowercase letters, digits and hyphens)`)
  }
  // Name the resolved path rather than the specifier: an out-of-tree profile that fails to
  // load is almost always a path one level off, and that is invisible before resolution.
  const where = module ?? `src/profiles/${name}/profile.ts`
  if (module && !existsSync(module)) {
    throw new ProfileError(
      `profile '${name}' names module '${module}', which does not exist — ` +
        `fix 'module' for [${name}] in ${CONFIG_NAME}, or export ${envKey(name)}`,
    )
  }
  let mod: Record<string, unknown>
  try {
    mod = (await import(module ? pathToFileURL(module).href : `../profiles/${name}/profile.ts`)) as Record<
      string,
      unknown
    >
  } catch (e) {
    throw new ProfileError(
      `profile '${name}' is declared in ${CONFIG_NAME} but ${where} did not load: ${(e as Error).message}`,
    )
  }
  const profile = mod.PROFILE as ProfileModule | undefined
  if (!profile) {
    throw new ProfileError(`${where} must export a PROFILE`)
  }
  // Either way of being runnable will do, but one of them is required. `runEval` alone is an
  // eval-only profile, `review` alone is a workflow step or an interactive specialist that has
  // no corpus yet; neither is an object that can be named in profiles.toml and never executed.
  if (!profile.runEval && !profile.review) {
    throw new ProfileError(
      `${where} exports a PROFILE with neither runEval nor review — it declares a profile that cannot be run`,
    )
  }
  return profile
}
