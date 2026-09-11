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
 * THE ERROR CONTRACT IS THE NON-OBVIOUS PART. Re-measured against the vendored v0.7.10 now that
 * it is in the repository to measure: `vitals --bp 78` (a missing diastolic) and
 * `vitals --bp NaN/NaN` BOTH exit 1 with `{"error": ...}` on stderr and an empty stdout. An
 * earlier note here recorded the first as exiting 0 with the error on stdout; that is not what
 * this build does, and the differential run in VENDOR.md is the check.
 *
 * `run` below nonetheless searches for the `error` key on BOTH streams and on BOTH exit paths,
 * and that is deliberate rather than leftover. What must never happen is a refusal read as a
 * result: a caller that took an exit-0 empty object as an answer would find no `bloodPressure`,
 * and carry an undefined systolic into `undefined < 90`, which is `false` — every patient
 * outside the cohort, a plausible number, and a rule that never ran. Handling the path this
 * build does not currently take costs four lines; being wrong about which path it takes costs a
 * silent cohort gate.
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { type Pack } from '../../core/pack.ts'
import { ProfileError } from '../../core/profile.ts'

/**
 * The copy of the CLI that travels with this repository. See src/vendor/medprotocol/VENDOR.md.
 *
 * Resolved from THIS MODULE'S URL rather than from the working directory, because the eval is
 * run from wherever the user happens to be standing and a cwd-relative path would make the
 * cohort gate a property of the shell's location.
 */
const VENDORED = fileURLToPath(new URL('../../vendor/medprotocol/index.ts', import.meta.url))

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
 * The pack's declaration, resolved against the copy of the CLI this repository carries.
 *
 * THREE WAYS THIS RESOLVES, in order. `MEDPROTOCOL_BIN` wins, and is how the tests point the
 * profile at a fixture and how an operator points it at their own build. A BARE NAME — a
 * `command` whose first element has no path separator, which is what every pack in this
 * repository declares — resolves to the vendored CLI under src/vendor/medprotocol, run with
 * this same node. Anything else is passed through as written, so a pack that names a path or a
 * different executable still gets what it asked for.
 *
 * WHY THE BARE NAME NO LONGER MEANS `$PATH`. It used to, and that made the reference pack's
 * numbers a property of what the operator happened to have installed: no medprotocol on PATH
 * and the clinical profile did not run at all; a medprotocol of a different version and it
 * refused, correctly but uselessly, on a machine that had no way to fix it. The CLI is three
 * thousand lines of arithmetic with no dependencies of its own, so it is checked in — and once
 * it is checked in, the version pin below stops being a hurdle for the reader and goes back to
 * being what it was for: a statement that the answer key and the tool agree.
 *
 * The COMMAND is still a property of a machine while the VERSION is a property of the contract,
 * which is why only the first is overridable. A pack that let the environment choose the
 * version would be a pack whose numbers nobody can reproduce.
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
  const declared = m.command as string[]
  return {
    command: resolveCommand(declared),
    version: m.version,
  }
}

/** `MEDPROTOCOL_BIN`, else the vendored CLI for a bare name, else the declaration verbatim. */
const resolveCommand = (declared: string[]): string[] => {
  const override = process.env.MEDPROTOCOL_BIN
  if (override) return [override]
  const bin = declared[0]!
  // `process.execPath` rather than `node`, so the CLI runs on the interpreter that is already
  // running this profile — the vendored source is TypeScript and needs a node that strips it.
  if (!bin.includes('/') && !bin.includes('\\')) return [process.execPath, VENDORED, ...declared.slice(1)]
  return declared
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
   * Shock index, heart rate / systolic, ROUNDED TO TWO DECIMAL PLACES. Above 0.9 is the usual
   * flag for circulatory compromise. Also derived here, and from MEDPROTOCOL'S parsed numbers
   * rather than from the payload's raw strings, so there is one parse of a blood pressure in
   * this pipeline.
   *
   * Rounded at the point of division rather than at each place it is printed, and that is the
   * whole point: `124 / 78` is `1.5897435897435896`, and a value that is rounded only for
   * display travels into the exam payload at full precision while the report beside it says
   * `1.59`. A model handed the long form echoes the long form, and a reader comparing the echo
   * to the report sees two numbers. Worse, the threshold comparison then runs on a number
   * nothing ever showed anyone — the run's own report would not describe the decision it made.
   *
   * WHAT THIS MOVES. `shockIndex > shockIndexAbove` now compares the rounded value, so a ratio
   * within half a hundredth above the cut — `64/91 = 0.7033` against a cut of 0.7 — rounds to
   * `0.70` and no longer clears it. That is a real shift of the boundary by up to 0.005, and it
   * is the deliberate trade: the number that decided is the number that is published.
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
    shockIndex: Math.round((h.value / b.systolic) * 100) / 100,
  }
}

/**
 * What medprotocol says about one patient's Quick SOFA screen.
 *
 * Delegated to the CLI for the reason every other number in this profile is: the sepsis
 * contract's reference arm is `positive`, and a second hand-rolled implementation of the
 * Thresholds here would let the eval and the product disagree about where sepsis suspicion
 * begins without either of them noticing. The THREE criteria are medprotocol's — respiratory
 * rate >= 22, systolic blood pressure <= 100, and GCS < 15 — and a positive screen is any two.
 */
export interface QSOFAScreen {
  /** 0-3, the number of criteria met. */
  score: number
  /** Score >= 2. */
  positive: boolean
  /** The three inputs, echoed back so one parse of each lives in this pipeline. */
  respiratoryRate: number
  systolic: number
  gcs: number
}

/**
 * Evaluate a Quick SOFA screen through the CLI.
 *
 * `rr`, `sbp` and `gcs` are the three inputs the CLI requires, and all three are required
 * here too: a qSOFA screen with one of them missing is a screen that never ran, and a
 * reference arm that guesses a missing criterion is a rule that reports a number it did not
 * derive. The CLI refuses rather than defaults, and so does this.
 */
export const evaluateQSOFA = (rule: MedprotocolRule, rr: number, sbp: number, gcs: number): QSOFAScreen => {
  const o = run(rule, ['sepsis', 'qsofa', '--rr', String(rr), '--sbp', String(sbp), '--gcs', String(gcs)])
  if (typeof o.score !== 'number' || typeof o.positive !== 'boolean') {
    throw new ProfileError(
      `medprotocol sepsis qsofa returned no usable score/positive for rr ${rr} sbp ${sbp} gcs ${gcs}: ` +
        JSON.stringify(o).slice(0, 200),
    )
  }
  return {
    score: o.score,
    positive: o.positive,
    respiratoryRate: rr,
    systolic: sbp,
    gcs,
  }
}
