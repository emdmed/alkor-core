/**
 * The medprotocol CLI, as this profile's authority on what a set of vital signs MEANS.
 *
 * WHY A SUBPROCESS RATHER THAN TWENTY LINES OF ARITHMETIC. The shock contract kept asking a 4B
 * model to decide whether a systolic was below a threshold, and three prompt formulations
 * failed at the boundary: measured on this pack's corpus, the model applied the cohort gate at
 * a systolic of 104 and skipped it at exactly 90 and at a ten-minute duration. Right on the
 * glaring case, wrong on the edge — the worst profile a safety check can have, because it looks
 * like it works. Numeric decisions do not belong to the model, and they do not belong to a
 * second hand-rolled implementation in this repository either: they belong to the tool the
 * consuming application already uses, so that the eval and the product classify a blood
 * pressure the same way or the number describes something adjacent to the product.
 *
 * WHAT IT DECIDES AND WHAT IT DOES NOT. medprotocol parses the blood pressure and categorises
 * it; the PACK still owns the study's entry criterion. Those are different questions and
 * conflating them is measurably wrong here: `category: "Low"` fires on systolic < 90 OR
 * diastolic < 60, while Vazquez et al. enrolled on systolic < 90 alone. A patient at 120/55 is
 * "Low" and is nobody's idea of shock; `sh-17-systolic-at-cut` is exactly 90 and would be
 * admitted to a cohort it is not in. So this module returns FACTS — the parsed numbers and the
 * CLI's own categories — and `[clinical.shockExam]` decides what they mean for this contract.
 *
 * THE ERROR CONTRACT IS THE NON-OBVIOUS PART, and it is inconsistent. Measured against v0.7.10:
 * `vitals --bp 78` (a missing diastolic) exits 0 with `{"error": ...}` on stdout, while
 * `vitals --bp NaN/NaN` exits 1 with the same shape. So NEITHER the exit code nor its absence
 * can be trusted on its own — a caller keying on the status would read the first as a result,
 * find no `bloodPressure`, and carry an undefined systolic into `undefined < 90`, which is
 * `false`: every patient outside the cohort, a plausible number, and a rule that never ran.
 * `run` below therefore looks for the `error` key on BOTH paths and reports either as a refusal.
 */
import { execFileSync } from 'node:child_process'
import { type Pack } from '../../core/pack.ts'
import { ProfileError } from '../../core/profile.ts'

/**
 * How to invoke the CLI, and which version the pack's numbers were measured against.
 *
 * `command` is an ARGV ARRAY rather than a shell string, because a shell string is a quoting
 * bug waiting for a path with a space in it and there is nothing here that needs a shell.
 *
 * `version` is checked at load and is not decoration: this contract's answer key depends on
 * where medprotocol draws the line between Low and Normal, so a run against a different build
 * is a run against a different rule. The check is what stops that being invisible.
 */
export interface MedprotocolRule {
  command: string[]
  version: string
}

/**
 * The pack's declaration, with `MEDPROTOCOL_BIN` allowed to override the executable.
 *
 * The override exists because the COMMAND is a property of a machine while the VERSION is a
 * property of the contract. A pack committed with one developer's absolute path would be
 * unusable everywhere else, and a pack that let the environment choose the version would be a
 * pack whose numbers nobody can reproduce. So the first is overridable and the second is not.
 */
export const loadMedprotocolRule = (pack: Pack): MedprotocolRule => {
  const manifest = pack.manifest as { clinical?: { medprotocol?: Partial<MedprotocolRule> } }
  const m = manifest.clinical?.medprotocol
  if (!m || !Array.isArray(m.command) || !m.command.length || typeof m.version !== 'string') {
    throw new ProfileError(
      `pack '${pack.name}': [clinical.medprotocol] must state command = [...] and version = "..." — ` +
        'the shock contract delegates every numeric decision to this CLI, and a pack that does not ' +
        'name it is a pack whose cohort gate is undefined',
    )
  }
  const override = process.env.MEDPROTOCOL_BIN
  return {
    command: override ? [override] : (m.command as string[]),
    version: m.version,
  }
}

/** One invocation, as JSON, or a refusal that names what was run. */
const run = (rule: MedprotocolRule, args: string[]): Record<string, unknown> => {
  const [bin, ...fixed] = rule.command
  let out: string
  try {
    // stderr is CAPTURED rather than inherited, so a refusal on the error path can be quoted
    // instead of being printed past the caller into the middle of an eval's output.
    out = execFileSync(bin!, [...fixed, ...args, '--json'], {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    // A non-zero exit still carries the CLI's own diagnosis — on STDERR on this path, having
    // been on stdout on the exit-0 one. Both are searched rather than the likelier of the two,
    // because the whole point of the header's note is that this contract is inconsistent and a
    // reader should not have to know which half they are on. Quoting it is worth more than the
    // spawn error: "--bp values must be numbers" says what to fix, "Command failed" does not.
    const refusal = errorIn(String((e as { stdout?: unknown }).stdout ?? '')) ??
      errorIn(String((e as { stderr?: unknown }).stderr ?? ''))
    if (refusal) throw new ProfileError(`medprotocol refused '${args.join(' ')}': ${refusal}`)
    throw new ProfileError(
      `medprotocol could not be run (${rule.command.join(' ')} ${args.join(' ')}): ${(e as Error).message} — ` +
        'set MEDPROTOCOL_BIN to the executable, or correct [clinical.medprotocol].command in pack.toml',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(out)
  } catch {
    throw new ProfileError(`medprotocol returned output that is not JSON: ${out.slice(0, 200)}`)
  }
  const o = parsed as Record<string, unknown>
  // Exit code 0 with an `error` key — the other half of the contract. See the file header.
  if (typeof o.error === 'string') {
    throw new ProfileError(`medprotocol refused '${args.join(' ')}': ${o.error}`)
  }
  return o
}

/** The CLI's own diagnosis inside a possibly-JSON stdout, or undefined if there is not one. */
const errorIn = (stdout: string): string | undefined => {
  try {
    const o = JSON.parse(stdout) as { error?: unknown }
    return typeof o.error === 'string' ? o.error : undefined
  } catch {
    return undefined
  }
}

/**
 * The installed version, checked against the pack's declaration.
 *
 * Called ONCE per run rather than per case: it is a property of the machine, and twenty
 * subprocesses to ask the same question would be twenty chances to answer it differently.
 */
export const checkMedprotocolVersion = (rule: MedprotocolRule, packName: string): string => {
  const [bin, ...fixed] = rule.command
  let out: string
  try {
    out = execFileSync(bin!, [...fixed, '--version'], { encoding: 'utf8', timeout: 30_000 }).trim()
  } catch (e) {
    throw new ProfileError(
      `medprotocol could not be run (${rule.command.join(' ')} --version): ${(e as Error).message} — ` +
        'set MEDPROTOCOL_BIN to the executable, or correct [clinical.medprotocol].command in pack.toml',
    )
  }
  // `medprotocol v0.7.10` -> `0.7.10`
  const found = /v?(\d+\.\d+\.\d+)/.exec(out)?.[1]
  if (!found) throw new ProfileError(`medprotocol --version said '${out}', which names no version`)
  if (found !== rule.version) {
    throw new ProfileError(
      `pack '${packName}' declares medprotocol ${rule.version} and this machine has ${found} — ` +
        'this contract\'s answer key depends on where that CLI draws its category boundaries, so a ' +
        'different build is a different rule; install the declared version or update the pack and re-measure',
    )
  }
  return found
}

/** What medprotocol says about one patient's vitals, plus what the pack derives from it. */
export interface Vitals {
  /** Parsed by medprotocol, not by a regex here. */
  systolic: number
  diastolic: number
  /** medprotocol's own label: Low / Normal / Elevated / ... Reported, never a cohort gate. */
  bloodPressureCategory: string
  heartRate: number
  heartRateCategory: string
  /**
   * Mean arterial pressure, diastolic + (systolic - diastolic) / 3.
   *
   * Computed HERE and not by medprotocol, because medprotocol has no MAP calculation — its
   * `sepsis sofa` command CONSUMES a `--map` rather than producing one. Stated so nobody
   * reading this file assumes the CLI was asked and answered.
   */
  meanArterialPressure: number
  /**
   * Shock index, heart rate / systolic. Above 0.9 is the usual flag for circulatory
   * compromise. Also derived here, and from MEDPROTOCOL'S parsed numbers rather than from the
   * payload's raw strings, so there is one parse of a blood pressure in this pipeline.
   */
  shockIndex: number
}

/**
 * Evaluate one patient's vitals through the CLI.
 *
 * The two derived composites are computed from the numbers medprotocol returns rather than from
 * the payload, so that a blood pressure is parsed exactly once in this pipeline and every
 * downstream number is a function of that one parse.
 */
export const evaluateVitals = (
  rule: MedprotocolRule,
  bp: { systolic: number; diastolic: number },
  heartRate: number,
): Vitals => {
  const o = run(rule, ['vitals', '--bp', `${bp.systolic}/${bp.diastolic}`, '--hr', String(heartRate)])
  const b = o.bloodPressure as { systolic?: number; diastolic?: number; category?: string } | undefined
  const h = o.heartRate as { value?: number; category?: string } | undefined
  if (typeof b?.systolic !== 'number' || typeof b?.diastolic !== 'number' || typeof h?.value !== 'number') {
    throw new ProfileError(
      `medprotocol vitals returned no usable bloodPressure/heartRate for ${bp.systolic}/${bp.diastolic} hr ${heartRate}: ` +
        JSON.stringify(o).slice(0, 200),
    )
  }
  return {
    systolic: b.systolic,
    diastolic: b.diastolic,
    bloodPressureCategory: b.category ?? 'unknown',
    heartRate: h.value,
    heartRateCategory: h.category ?? 'unknown',
    meanArterialPressure: Math.round((b.diastolic + (b.systolic - b.diastolic) / 3) * 10) / 10,
    shockIndex: h.value / b.systolic,
  }
}
