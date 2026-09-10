#!/usr/bin/env node
/**
 * Harness CLI.
 *
 *   node src/cli.ts extract --profile NAME (--note FILE | --case NAME | -) [--task NAME] [--constrain] [--json]
 *   node src/cli.ts eval    --profile NAME [--runs N] [--constrain] [--repair] [--difficulty N|N-M] [--no-cache-prompt] [--url URL] [--pack DIR]
 *   node src/cli.ts eval    --profile NAME --from-trace FILE [--strip-fences]
 *   node src/cli.ts agent   --profile NAME --task "..." --workspace DIR [--url URL] [--steps N]
 *   node src/cli.ts route   --profile NAME --input "..." [--json]
 *   node src/cli.ts pipeline --profile NAME --input "..." [--json]
 *   node src/cli.ts profiles
 *
 * `extract` is the job and `eval` is how you know it works. They are two entries into one
 * pass: the profile assembles prompt, schema and cap once and both verbs run it, so a note
 * handed to `extract` is read by the contract `eval` scored, not by something near it.
 *
 * No profile is special here. The name is looked up in profiles.toml, its module is
 * imported from src/profiles/<name>/ — or from wherever its `module` entry points, which
 * may be another repository — and its pack, if it declares one, is loaded from the manifest
 * in that directory. Adding a domain touches config and a profile directory,
 * never this file.
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { loadConfig, requireProfile, ConfigError } from './core/config.ts'
import { loadPack, resolvePackRoot, PackError, type Pack } from './core/pack.ts'
import { TraceError } from './core/trace-read.ts'
import { loadProfileModule, redactor, requireDocumentName, resolveProfileModule, ProfileError } from './core/profile.ts'
import { runAgent } from './modes/agentic.ts'
import { runPipeline, buildPipeline } from './modes/pipeline.ts'
import { nullTrace, openTrace } from './core/trace.ts'

const { values } = parseArgs({
  allowPositionals: true,
  options: {
    profile: { type: 'string' },
    runs: { type: 'string' },
    constrain: { type: 'boolean', default: false },
    url: { type: 'string' },
    pack: { type: 'string' },
    task: { type: 'string' },
    workspace: { type: 'string' },
    steps: { type: 'string' },
    note: { type: 'string' },
    case: { type: 'string' },
    difficulty: { type: 'string' },
    input: { type: 'string' },
    // Spelled as the negative because ON is the default and the reason to type it is to give
    // the reuse up. `parseArgs` has no negation convention, so this is a plain flag.
    'no-cache-prompt': { type: 'boolean', default: false },
    // The medication pass over a dictation, ON by default — unlike the repair, because it is
    // part of what this pack says reading a dictation means, and an eval that ran it only when
    // asked would measure a reading the application does not ship.
    //
    // It was opt-in for exactly one measured run, and the history is the point: at a 512-token
    // cap and without a worked example of a discontinued drug it failed `not invented` and put
    // a STOPPED drug on a medication list. Both are fixed and re-measured. This flag reproduces
    // a figure pinned before the pass existed. See src/profiles/clinical/medication.ts.
    'no-medication-pass': { type: 'boolean', default: false },
    // Re-score a recorded run instead of producing a new one. No server is contacted.
    'from-trace': { type: 'string' },
    'strip-fences': { type: 'boolean', default: false },
    'context-dir': { type: 'string' },
    step: { type: 'string' },
    // The second pass over the items whose citation failed. Opt-in on both verbs, because
    // every number this harness has pinned describes one pass: a repair that ran by default
    // would make the old results incomparable with the new ones without anyone typing
    // anything. See src/profiles/clinical/repair.ts.
    repair: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    calculate: { type: 'boolean', default: false },
    // Pipeline fidelity eval: run three arms (monolith, specialist, verified) against
    // the clinical corpus and compare. See src/profiles/clinical-verified/eval.ts.
    fidelity: { type: 'boolean', default: false },
    // Limit the fidelity eval to N cases (for quick iteration).
    'case-limit': { type: 'string' },
  },
})

const usage = (msg?: string) => {
  if (msg) console.error(`${msg}\n`)
  console.error('usage:')
  console.error('  node src/cli.ts extract --profile NAME (--note FILE | --case NAME | --note -) [--task NAME] [--constrain] [--repair] [--no-medication-pass] [--calculate] [--json] [--url URL] [--pack DIR]')
  console.error('  node src/cli.ts eval    --profile NAME [--input "..."] [--runs N] [--constrain] [--task NAME] [--repair] [--difficulty N|N-M] [--no-cache-prompt] [--no-medication-pass] [--url URL] [--pack DIR]')
  console.error('  node src/cli.ts eval    --profile NAME --from-trace FILE [--strip-fences] [--pack DIR]   (re-score a recorded run, no server)')
  console.error('  node src/cli.ts agent   --profile NAME --task "..." --workspace DIR [--url URL] [--steps N]')
  console.error('  node src/cli.ts route   --profile NAME --input "..." [--json] [--url URL]')
  console.error('  node src/cli.ts pipeline --profile NAME --input "..." [--json] [--url URL] [--pack DIR] [--context-dir DIR] [--step N]')
  console.error('  node src/cli.ts profiles')
  process.exit(2)
}

/** Config, pack and profile problems are setup mistakes, not crashes — report them plainly. */
const die = (e: unknown): never => {
  if (e instanceof ConfigError || e instanceof PackError || e instanceof ProfileError || e instanceof TraceError) {
    console.error(`${e.constructor.name.replace('Error', '').toLowerCase()}: ${e.message}`)
    process.exit(2)
  }
  throw e
}

const [command] = process.argv.slice(2).filter((a) => !a.startsWith('-'))
if (!command) usage()

let cfg
try {
  cfg = loadConfig()
} catch (e) {
  die(e)
}

if (command === 'profiles') {
  for (const p of Object.values(cfg!.profiles)) {
    // `module` is printed only when set: for an in-tree profile it would be the same
    // derived string on every row, which is a column that has stopped informing.
    const where = p.module ? `  module ${p.module}` : ''
    console.log(
      `${p.name.padEnd(12)} mode ${String(p.mode).padEnd(8)} pack ${p.pack ?? '(none)'}  url ${p.url ?? '(default)'}${where}`,
    )
  }
  process.exit(0)
}

if (command !== 'eval' && command !== 'agent' && command !== 'extract' && command !== 'route' && command !== 'pipeline') usage(`unknown command '${command}'`)
if (!values.profile) usage('--profile is required')

let profileConfig
let profile
try {
  profileConfig = requireProfile(cfg!, values.profile!)
  profile = await loadProfileModule(
    values.profile!,
    resolveProfileModule(values.profile!, { configured: profileConfig.module, base: cfg!.base }),
  )
} catch (e) {
  die(e)
}

const baseUrl = values.url ?? (profileConfig!.url as string | undefined)

// Load the pack before anything reaches the network: a missing manifest should fail in
// milliseconds, not after the first case has already spent a minute on the GPU.
let pack
if (profile!.needsPack || values.pack || profileConfig!.pack) {
  try {
    pack = loadPack(
      resolvePackRoot(profile!.name, {
        explicit: values.pack,
        configured: profileConfig!.pack as string | undefined,
        base: cfg!.base,
      }),
    )
  } catch (e) {
    die(e)
  }
}

if (command === 'extract') {
  if (profile!.mode !== 'extract' && profile!.mode !== 'router' && profile!.mode !== 'pipeline') usage(`profile '${profile!.name}' is mode '${profile!.mode}', which extracts nothing`)
  if (!profile!.review) usage(`profile '${profile!.name}' does not implement review, so it cannot read a single document`)
  if (Boolean(values.note) === Boolean(values.case)) usage('extract needs exactly one of --note FILE and --case NAME')

  // `--note -` reads stdin, which is what makes this composable with whatever produced the
  // note. fd 0 rather than a stream: the document is one note, and the whole of it has to
  // be in hand before the request is built anyway.
  let input
  try {
    input =
      values.case !== undefined
        ? ({ kind: 'case', name: requireDocumentName(profile!, pack!, values.case, { task: values.task }) } as const)
        : ({
            kind: 'text',
            text: values.note === '-' ? readFileSync(0, 'utf8') : readFileSync(values.note!, 'utf8'),
            label: values.note === '-' ? 'stdin' : values.note!,
          } as const)
  } catch (e) {
    if (e instanceof ProfileError) die(e)
    console.error(`cannot read ${values.note}: ${(e as Error).message}`)
    process.exit(2)
  }

  const trace = openTrace(profile!.name, redactor(profile!, pack))
  // Wrapped in the same try/`die` the `eval` verb below has always had, and this was a real
  // gap rather than a tidy-up. A profile refuses an unusable `--task` with a ProfileError
  // whose message names the task and says what to run instead — a sentence written to be the
  // whole of what the user sees. Unwrapped, it arrived as a nine-line stack trace with that
  // sentence buried in the middle, so the one verb where a refusal is the NORMAL outcome was
  // the one verb that reported it as a crash.
  let result: Awaited<ReturnType<NonNullable<NonNullable<typeof profile>['review']>>> | undefined
  try {
    result = await profile!.review!({
      pack,
      baseUrl,
      trace,
      input: input!,
      // `--task` selects the contract, for a profile whose pack holds more than one. A profile
      // that reads a single contract ignores it, which is why it is passed unconditionally
      // rather than being made conditional on something this file would have to know.
      options: {
        constrain: values.constrain,
        task: values.task,
        repair: values.repair,
        medicationPass: !values['no-medication-pass'],
        calculate: values.calculate,
      },
    })
  } catch (e) {
    // Closed before dying, exactly as the eval path does: a refusal that left the trace open
    // would drop whatever the run had already written about why it refused.
    trace.close()
    die(e)
  }
  trace.close()

  // --json puts machine-readable output on stdout and NOTHING else, so the verb can be piped
  // into the application that would consume it. The rendered reading goes to stderr in that
  // mode rather than being suppressed: a caller redirecting stdout still wants to see the
  // provenance warnings, and dropping them would make the quiet path the one that hides an
  // unverified quote.
  //
  // WHAT lands on stdout is the profile's decision. A profile that returns a `report` gets
  // that — the reading together with every verdict it computed — and one that does not gets
  // the raw completion, which is what this verb has always emitted. The distinction is not
  // cosmetic: a completion is what the model said, and a report is what the contract
  // concluded about it, and only the second can be compared against a second implementation
  // of the same contract. Two runtimes emitting identical bytes while disagreeing about which
  // quotes verify are not the same runtime, and the completion does not show it.
  if (values.json) {
    console.error(result!.text)
    if (result!.report !== undefined) console.log(JSON.stringify(result!.report, null, 2))
    else if (result!.raw !== undefined) console.log(result!.raw)
  } else {
    console.log(result!.text)
  }
  // An unreadable reply is a failure. A reading with an unverified quote is not — it is a
  // finding, and it is printed rather than hidden behind an exit code.
  process.exit(result!.ok ? 0 : 1)
}

if (command === 'agent') {
  if (!values.task || !values.workspace) usage('agent needs --task and --workspace')
  if (profile!.mode !== 'agentic') usage(`profile '${profile!.name}' is mode '${profile!.mode}', which has no agent loop`)
  if (!profile!.tools?.length) usage(`profile '${profile!.name}' declares no tools`)

  const trace = openTrace(profile!.name, redactor(profile!, pack))
  const res = await runAgent({
    systemPrompt: profile!.systemPrompt ?? '',
    task: values.task!,
    workspace: values.workspace!,
    tools: profile!.tools!,
    maxSteps: Number(values.steps ?? profile!.maxSteps ?? 12),
    baseUrl,
    trace,
  })
  trace.close()
  console.log(`\nstop: ${res.stop}  steps: ${res.steps}  tools: ${res.toolsUsed.join(' → ') || '(none)'}`)
  if (res.answer) console.log(`\n${res.answer}`)
  if (res.error) console.error(`\nerror: ${res.error}`)
  // A step cap or a loop that never called a tool is a failure, not a quiet success.
  process.exit(res.stop === 'done' ? 0 : 1)
}

if (command === 'route') {
  if (!values.input) usage('route needs --input')
  if (profile!.mode !== 'router') usage(`profile '${profile!.name}' is mode '${profile!.mode}', which is not a router`)
  if (!profile!.review) usage(`profile '${profile!.name}' does not implement review, so it cannot route a single input`)

  const trace = openTrace(profile!.name, redactor(profile!, pack))
  let result: Awaited<ReturnType<NonNullable<NonNullable<typeof profile>['review']>>> | undefined
  try {
    result = await profile!.review!({
      pack,
      baseUrl,
      trace,
      input: { kind: 'text', text: values.input!, label: 'cli-input' },
      options: {
        constrain: values.constrain,
        task: values.task,
      },
    })
  } catch (e) {
    trace.close()
    die(e)
  }
  trace.close()

  if (values.json) {
    console.error(result!.text)
    if (result!.report !== undefined) console.log(JSON.stringify(result!.report, null, 2))
    else if (result!.raw !== undefined) console.log(result!.raw)
  } else {
    console.log(result!.text)
  }
  process.exit(result!.ok ? 0 : 1)
}

if (command === 'pipeline') {
  if (!values.input) usage('pipeline needs --input')
  if (profile!.mode !== 'pipeline') usage(`profile '${profile!.name}' is mode '${profile!.mode}', which is not a pipeline`)

  const stepNumber = values.step !== undefined ? Number(values.step) : undefined
  if (stepNumber !== undefined && (Number.isNaN(stepNumber) || stepNumber < 0 || !Number.isInteger(stepNumber))) {
    usage(`--step must be a non-negative integer, got '${values.step}'`)
  }
  if (stepNumber !== undefined && stepNumber > 0 && !values['context-dir']) {
    usage('--step > 0 requires --context-dir to load state from previous steps')
  }

  // Pipeline steps are read from the profile config (profiles.toml extra keys).
  const steps = profileConfig!.steps as Array<Record<string, unknown>> | undefined
  if (!steps || !Array.isArray(steps)) usage(`profile '${profile!.name}' has no 'steps' array in its config`)

  const pipelineSteps = buildPipeline(
    steps!.map((s) => ({
      name: String(s.name ?? 'unnamed'),
      profile: String(s.profile ?? ''),
      input: s.input as string | Record<string, string> | undefined,
      field: s.field as string | undefined,
      options: s.options as Record<string, unknown> | undefined,
    })),
  )

  if (stepNumber !== undefined && stepNumber >= pipelineSteps.length) {
    usage(`--step ${stepNumber} is out of range (pipeline has ${pipelineSteps.length} steps)`)
  }

  // Load all referenced profiles and packs.
  const profiles = new Map<string, Awaited<ReturnType<typeof loadProfileModule>>>()
  const packs = new Map<string, Pack | undefined>()
  const baseUrls = new Map<string, string | undefined>()

  for (const step of pipelineSteps) {
    if (!profiles.has(step.profile)) {
      const stepProfileConfig = requireProfile(cfg!, step.profile)
      const stepProfile = await loadProfileModule(
        step.profile,
        resolveProfileModule(step.profile, { configured: stepProfileConfig.module, base: cfg!.base }),
      )
      profiles.set(step.profile, stepProfile)
      baseUrls.set(step.profile, stepProfileConfig.url)

      if (stepProfile.needsPack || stepProfileConfig.pack) {
        try {
          const stepPack = loadPack(
            resolvePackRoot(stepProfile.name, {
              explicit: undefined,
              configured: stepProfileConfig.pack as string | undefined,
              base: cfg!.base,
            }),
          )
          packs.set(step.profile, stepPack)
        } catch (e) {
          if (stepProfile.needsPack) throw e
          packs.set(step.profile, undefined)
        }
      }
    }
  }

  const trace = openTrace(profile!.name, redactor(profile!, pack))
  const result = await runPipeline({
    initialInput: values.input!,
    steps: pipelineSteps,
    profiles,
    packs,
    baseUrls,
    trace,
    contextDir: values['context-dir'],
    runStep: stepNumber,
  })
  trace.close()

  const lines = [
    `=== pipeline · ${profile!.name} ===`,
    stepNumber !== undefined ? `running step: ${stepNumber + 1} / ${pipelineSteps.length}` : `steps: ${result.steps.length}`,
    `total time: ${(result.totalMs / 1000).toFixed(1)}s`,
    `stopped early: ${result.stoppedEarly ? 'yes' : 'no'}`,
    ...(values['context-dir'] ? [`context dir: ${values['context-dir']}`] : []),
  ]
  for (const step of result.steps) {
    lines.push(`  ${step.step + 1}. ${step.name} (${step.profile}) — ${step.ok ? 'ok' : 'failed'}${step.error ? ` — ${step.error}` : ''}${step.wallMs ? ` — ${(step.wallMs / 1000).toFixed(1)}s` : ''}`)
  }
  if (result.final) {
    lines.push(`\nfinal output:`)
    lines.push(JSON.stringify(result.final, null, 2))
  }

  const text = lines.join('\n')
  if (values.json) {
    console.log(JSON.stringify({ pipeline: result }, null, 2))
  } else {
    console.log(text)
  }
  process.exit(result.stoppedEarly ? 1 : 0)
}

// `--from-trace` re-scores a recording and contacts no server, so it opens no trace of its
// own: a dated empty file per re-score is litter in the one directory where the real
// recordings live.
const trace = values['from-trace'] ? nullTrace() : openTrace(profile!.name, redactor(profile!, pack))
// A profile rejecting an option it was handed — an unknown task, a malformed --difficulty —
// is the same class of mistake as a missing pack and reads better as one line than as a
// stack trace. Anything else still throws.
let verdict
try {
  verdict = await profile!.runEval({
    config: profileConfig!,
    pack,
    baseUrl,
    trace,
    // `task` is shared with the agentic path, where it is the instruction. For an extract
    // profile it names WHICH eval to run, and a profile that has only one ignores it.
    options: {
      runs: values.runs,
      constrain: values.constrain,
      task: values.task,
      difficulty: values.difficulty,
      // A condition of the RESULT rather than a performance knob: a run with prefix reuse off
      // is the one that can be compared with somebody else's byte for byte. See
      // core/stability.ts for the flip that was measured with it on.
      cachePrompt: !values['no-cache-prompt'],
      fromTrace: values['from-trace'],
      stripFences: values['strip-fences'],
      repair: values.repair,
      medicationPass: !values['no-medication-pass'],
      fidelity: values.fidelity,
      caseLimit: values['case-limit'] ? Number(values['case-limit']) : undefined,
      input: values.input,
    },
  })
} catch (e) {
  trace.close()
  die(e)
}
trace.close()

// One place decides what exit 1 means, for every profile.
console.log(`${verdict!.pass ? 'PASS' : 'FAIL'} — ${verdict!.summary}`)
process.exit(verdict!.pass ? 0 : 1)
