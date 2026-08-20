#!/usr/bin/env node
/**
 * Harness CLI.
 *
 *   node src/cli.ts eval    --profile NAME [--runs N] [--constrain] [--url URL] [--pack DIR]
 *   node src/cli.ts agent   --profile NAME --task "..." --workspace DIR [--url URL] [--steps N]
 *   node src/cli.ts profiles
 *
 * No profile is special here. The name is looked up in profiles.toml, its module is
 * imported from src/profiles/<name>/ — or from wherever its `module` entry points, which
 * may be another repository — and its pack, if it declares one, is loaded from the manifest
 * in that directory. Adding a domain touches config and a profile directory,
 * never this file.
 */
import { parseArgs } from 'node:util'
import { loadConfig, requireProfile, ConfigError } from './core/config.ts'
import { loadPack, resolvePackRoot, PackError } from './core/pack.ts'
import { loadProfileModule, resolveProfileModule, ProfileError } from './core/profile.ts'
import { runAgent } from './modes/agentic.ts'
import { openTrace } from './core/trace.ts'

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
  },
})

const usage = (msg?: string) => {
  if (msg) console.error(`${msg}\n`)
  console.error('usage:')
  console.error('  node src/cli.ts eval    --profile NAME [--runs N] [--constrain] [--task NAME] [--url URL] [--pack DIR]')
  console.error('  node src/cli.ts agent   --profile NAME --task "..." --workspace DIR [--url URL] [--steps N]')
  console.error('  node src/cli.ts profiles')
  process.exit(2)
}

/** Config, pack and profile problems are setup mistakes, not crashes — report them plainly. */
const die = (e: unknown): never => {
  if (e instanceof ConfigError || e instanceof PackError || e instanceof ProfileError) {
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

if (command !== 'eval' && command !== 'agent') usage(`unknown command '${command}'`)
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

if (command === 'agent') {
  if (!values.task || !values.workspace) usage('agent needs --task and --workspace')
  if (profile!.mode !== 'agentic') usage(`profile '${profile!.name}' is mode '${profile!.mode}', which has no agent loop`)
  if (!profile!.tools?.length) usage(`profile '${profile!.name}' declares no tools`)

  const trace = openTrace(profile!.name)
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

const trace = openTrace(profile!.name)
const verdict = await profile!.runEval({
  config: profileConfig!,
  pack,
  baseUrl,
  trace,
  // `task` is shared with the agentic path, where it is the instruction. For an extract
  // profile it names WHICH eval to run, and a profile that has only one ignores it.
  options: { runs: values.runs, constrain: values.constrain, task: values.task },
})
trace.close()

// One place decides what exit 1 means, for every profile.
console.log(`${verdict.pass ? 'PASS' : 'FAIL'} — ${verdict.summary}`)
process.exit(verdict.pass ? 0 : 1)
