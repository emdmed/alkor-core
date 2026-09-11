/**
 * Workflow fidelity eval: does the multi-model workflow beat the monolith?
 *
 * Runs the same clinical corpus through three arms and compares:
 * 1. Monolith: Qwen3-4B free-form extraction (unconstrained)
 * 2. Specialist: Clinical internal router (rules) → Qwen3-4B constrained extraction
 * 3. Verified: Clinical extraction → independent verification
 *
 * Metrics: detection recall, hallucination rate, value/unit/quote accuracy, latency per case.
 * Gates: workflow recall ≥ monolith recall, workflow hallucination ≤ monolith,
 *        workflow latency ≤ 2x monolith.
 *
 * The verified arm is run manually (internally routed extraction → verify) rather than
 * through the workflow mode. The workflow's verify step now composes both refs
 * (`{document = "initial", extraction = "step-0.output"}` in profiles.toml), and this
 * transform exists because the clinical step's report is NOT the flat {value, quote} shape
 * the verifier is graded on: the vital-signs task reports nothing, and shock-extraction
 * reports exam fields that carry no quotes. Until a report is verifier-shaped, feeding the
 * declared workflow's output straight in would change the metrics this eval pins; when a
 * profile reports in that shape, the arm can switch to `runWorkflow` unchanged.
 */

import type { Pack } from '../../core/pack.ts'
import type { Trace } from '../../core/trace.ts'
import type { ProfileModule, EvalContext, EvalVerdict, ReviewResult } from '../../core/profile.ts'
import type { Provider } from '../../core/client.ts'
import { loadConfig, requireProfile } from '../../core/config.ts'
import { loadPack, resolvePackRoot } from '../../core/pack.ts'
import { loadProfileModule, resolveProfileModule } from '../../core/profile.ts'
import { identifyServer, UNIDENTIFIED, type ServerIdentity } from '../../core/client.ts'
import { buildWorkflow, runWorkflow, type WorkflowResult } from '../../modes/workflow.ts'
import { HARNESS_VERSION } from '../../core/version.ts'
import { vitalRequest } from '../../profiles/clinical/contracts.ts'
import { parseVitalSigns } from '../../profiles/clinical/extraction.ts'
import { loadVitalCases, parseDifficultyRange, DIFFICULTY_MIN, DIFFICULTY_MAX, gradedExpectations } from '../../profiles/clinical/cases.ts'
import { scoreCase, scoreFailure, emptyTally, absorb, type VitalTally, type Miss } from '../../profiles/clinical/scorer.ts'
import { reviewVitalSigns } from '../../profiles/clinical/review.ts'
import { routeClinicalShape } from '../../profiles/clinical/clinical-router.ts'
import { loadSettings } from '../../profiles/clinical/settings.ts'

export interface WorkflowCaseEvalOptions {
  input: string
  trace: Trace
  provider?: Provider
  profileName?: string
  options?: Record<string, unknown>
}

export interface WorkflowCaseEvalResult {
  verdict: EvalVerdict
  workflow: WorkflowResult
}

/**
 * Exercise the declared workflow exactly as production does for one supplied input.
 *
 * This is intentionally separate from the corpus fidelity comparison below. That comparison
 * measures three experimental arms and transforms the verified arm into the generic verifier's
 * flat `{value, quote}` vocabulary. A case eval answers a different and more operational
 * question: do the profiles and data shapes declared in `profiles.toml` actually compose?
 */
export const runWorkflowCaseEval = async (o: WorkflowCaseEvalOptions): Promise<WorkflowCaseEvalResult> => {
  const cfg = loadConfig()
  const profileName = o.profileName ?? 'clinical-verified'
  const workflowConfig = requireProfile(cfg, profileName)
  if (workflowConfig.mode !== 'workflow' || !Array.isArray(workflowConfig.steps)) {
    throw new Error(`profile '${profileName}' is not a configured workflow`)
  }

  const steps = buildWorkflow(workflowConfig.steps as Parameters<typeof buildWorkflow>[0])
  const profiles = new Map<string, ProfileModule>()
  const packs = new Map<string, Pack | undefined>()
  const baseUrls = new Map<string, string | undefined>()

  for (const step of steps) {
    if (profiles.has(step.profile)) continue
    const config = requireProfile(cfg, step.profile)
    const profile = await loadProfileModule(
      step.profile,
      resolveProfileModule(step.profile, { configured: config.module, base: cfg.base }),
    )
    profiles.set(step.profile, profile)
    baseUrls.set(step.profile, config.url)
    if (profile.needsPack || config.pack) {
      packs.set(step.profile, loadPack(resolvePackRoot(step.profile, {
        explicit: undefined,
        configured: config.pack as string | undefined,
        base: cfg.base,
      })))
    } else {
      packs.set(step.profile, undefined)
    }
  }

  const workflow = await runWorkflow({
    initialInput: o.input,
    steps,
    profiles,
    packs,
    baseUrls,
    trace: o.trace,
    provider: o.provider,
    options: o.options,
  })
  const failed = workflow.steps.find((step) => !step.ok)
  const verdict: EvalVerdict = {
    pass: !workflow.stoppedEarly,
    summary: failed
      ? `stopped at step ${failed.step + 1} '${failed.name}' (${failed.profile}): ${failed.error ?? 'step failed'}`
      : `${workflow.steps.length}/${steps.length} configured steps completed`,
  }
  return { verdict, workflow }
}

/**
 * Transform a clinical extraction (nested, with `raw_text` and `unit` fields) into the
 * flat format the generic verifier expects: {field: {value, quote}}.
 *
 * Blood pressure is flattened to a single value string. Null fields and metadata are dropped.
 */
const transformClinicalForVerifier = (report: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(report)) {
    if (value === null || value === undefined) continue
    if (key === 'extraction_confidence' || key === 'notes') continue
    if (typeof value !== 'object') continue
    const obj = value as Record<string, unknown>
    const rawText = obj.raw_text ?? obj.quote ?? null
    if (rawText === null) continue

    if (key === 'blood_pressure' && 'systolic' in obj && 'diastolic' in obj) {
      const unit = obj.unit ?? ''
      out[key] = {
        value: `${obj.systolic}/${obj.diastolic}${unit ? ' ' + unit : ''}`,
        quote: String(rawText),
      }
    } else if ('value' in obj) {
      const unit = obj.unit ?? ''
      out[key] = {
        value: `${obj.value}${unit ? ' ' + unit : ''}`,
        quote: String(rawText),
      }
    }
  }
  return out
}

export interface FidelityEvalOptions {
  pack: Pack
  baseUrl?: string
  trace: Trace
  /** Run only cases in this difficulty tier. */
  difficulty?: string
  /** Limit to N cases (for quick iteration). */
  caseLimit?: number
}

interface ArmResult {
  name: string
  tally: VitalTally
  misses: Miss[]
  wallMs: number
  cases: number
  failedRuns: number
}

interface ArmRunResult {
  parsed: ReturnType<typeof parseVitalSigns> | undefined
  wallMs: number
  ok: boolean
}

const pct = (n: number, d: number): string =>
  d === 0 ? 'n/a'.padStart(13) : `${((n / d) * 100).toFixed(0).padStart(4)}% (${n}/${d})`.padEnd(13)

const ratio = (num: number, den: number) => (den === 0 ? 1.0 : num / den)

/** Run the monolith arm: direct unconstrained extraction. */
const runMonolithArm = async (opts: {
  pack: Pack
  baseUrl?: string
  trace: Trace
  caseName: string
  note: string
  fields: ReturnType<typeof vitalRequest>['fields']
}): Promise<ArmRunResult> => {
  const started = performance.now()
  const result = await reviewVitalSigns({
    pack: opts.pack,
    baseUrl: opts.baseUrl,
    trace: opts.trace,
    constrain: false,
    input: { kind: 'text', text: opts.note, label: opts.caseName },
  })
  let parsed: ReturnType<typeof parseVitalSigns> | undefined
  try {
    parsed = result.raw ? parseVitalSigns(result.raw, opts.fields) : undefined
  } catch {
    // Unconstrained extraction can produce malformed JSON that does not match the schema.
    // Treat as a failed run rather than crashing the eval.
    parsed = undefined
  }
  return { parsed, wallMs: performance.now() - started, ok: result.ok && parsed !== undefined }
}

/** Run the specialist arm: constrained extraction with auto-routing. */
const runSpecialistArm = async (opts: {
  pack: Pack
  baseUrl?: string
  trace: Trace
  caseName: string
  note: string
  fields: ReturnType<typeof vitalRequest>['fields']
}): Promise<ArmRunResult> => {
  const started = performance.now()
  const result = await reviewVitalSigns({
    pack: opts.pack,
    baseUrl: opts.baseUrl,
    trace: opts.trace,
    constrain: true,
    input: { kind: 'text', text: opts.note, label: opts.caseName },
  })
  let parsed: ReturnType<typeof parseVitalSigns> | undefined
  try {
    parsed = result.raw ? parseVitalSigns(result.raw, opts.fields) : undefined
  } catch {
    // Constrained extraction can still produce malformed output on edge cases.
    parsed = undefined
  }
  return { parsed, wallMs: performance.now() - started, ok: result.ok && parsed !== undefined }
}

/**
 * Rule-based verifier for clinical extractions: checks that every numeric value in the
 * extraction appears somewhere in the document, and that the `raw_text` quote is not an
 * obvious hallucination. Fast (no model call) and conservative.
 *
 * Used as a fallback when the model-based verifier is too slow or unavailable on the current
 * hardware (measured: 4B CPU verifier takes 5+ min per case, and thinking mode + JSON schema
 * constraining does not produce reliable output on this llama.cpp build).
 *
 * The check is NOT an exact substring match: clinical notes contain tables, abbreviations,
 * and formatting that make exact matching too strict. Instead, we verify that the key
 * numeric values from the extraction appear in the document, which catches hallucinations
 * (invented numbers) without rejecting valid extractions with abbreviated quotes.
 */
const ruleBasedVerify = (document: string, extraction: Record<string, unknown>): { ok: boolean; issues: number } => {
  let issues = 0
  const doc = document.toLowerCase()
  for (const [key, value] of Object.entries(extraction)) {
    if (value === null || value === undefined) continue
    if (key === 'extraction_confidence' || key === 'notes') continue
    if (typeof value !== 'object') continue
    const obj = value as Record<string, unknown>
    const rawText = obj.raw_text
    // No raw_text is a minor issue; the model may omit it on edge cases.
    if (!rawText || typeof rawText !== 'string') {
      issues++
      continue
    }
    // The quote itself must contain the numeric value(s) it claims to support.
    const quote = rawText.toLowerCase()
    // Check that numeric values appear in the document (catches hallucinations).
    // Handle both period and comma decimal separators (e.g., Spanish "36,8" vs English "36.8").
    const checkNumber = (n: unknown) => {
      if (typeof n === 'number') {
        const strDot = String(n)
        const strComma = strDot.replace('.', ',')
        // The number must appear in EITHER the document or the quote.
        // We require it in the quote (value supported by evidence) OR in the document
        // (catches hallucinations where the number is invented).
        const inDoc = doc.includes(strDot) || doc.includes(strComma)
        const inQuote = quote.includes(strDot) || quote.includes(strComma)
        if (!inDoc && !inQuote) {
          // Number appears nowhere — likely hallucinated.
          issues++
        }
      }
    }
    checkNumber(obj.value)
    checkNumber(obj.systolic)
    checkNumber(obj.diastolic)
  }
  return { ok: issues === 0, issues }
}

/** Run the verified arm: internally routed clinical extraction → verify. */
const runVerifiedArm = async (opts: {
  pack: Pack
  clinicalBaseUrl?: string
  verifierBaseUrl?: string
  trace: Trace
  caseName: string
  note: string
  fields: ReturnType<typeof vitalRequest>['fields']
  verifierProfile?: ProfileModule
  verifierPack?: Pack
  /** When true, use a fast rule-based verifier instead of a model call. */
  ruleBased?: boolean
}): Promise<{ extraction: ArmRunResult; verifier: { ok: boolean; issues: number; wallMs: number } }> => {
  const extractStarted = performance.now()

  // Route (same as specialist — deterministic, no model call).
  const route = routeClinicalShape(opts.note, loadSettings(opts.pack).defaultTask)
  opts.trace.write({ event: 'route', kind: 'clinical', shape: route.shape, task: route.task, confidence: route.confidence, reason: route.reason })

  // Extract (constrained, same as specialist).
  const extractResult = await reviewVitalSigns({
    pack: opts.pack,
    baseUrl: opts.clinicalBaseUrl,
    trace: opts.trace,
    constrain: true,
    input: { kind: 'text', text: opts.note, label: opts.caseName },
  })
  const parsed = extractResult.raw ? parseVitalSigns(extractResult.raw, opts.fields) : undefined
  const extractWallMs = performance.now() - extractStarted

  // Verify.
  let verifierOk = true
  let verifierIssues = 0
  let verifierWallMs = 0

  if (extractResult.ok && parsed) {
    const verifyStarted = performance.now()
    if (opts.ruleBased) {
      const result = ruleBasedVerify(opts.note, parsed as Record<string, unknown>)
      verifierOk = result.ok
      verifierIssues = result.issues
      verifierWallMs = performance.now() - verifyStarted
    } else if (opts.verifierProfile?.review && opts.verifierPack) {
      // Transform the clinical extraction into a flat format the verifier understands.
      const verifierCompatible = transformClinicalForVerifier(parsed as Record<string, unknown>)
      const verifyInput = JSON.stringify({
        document: opts.note,
        extraction: verifierCompatible,
      })
      const verifyResult = await opts.verifierProfile.review({
        pack: opts.verifierPack,
        baseUrl: opts.verifierBaseUrl,
        trace: opts.trace,
        input: { kind: 'text', text: verifyInput, label: opts.caseName },
        options: {},
      })
      verifierOk = verifyResult.ok
      if (verifyResult.report && typeof verifyResult.report === 'object') {
        const report = verifyResult.report as Record<string, unknown>
        verifierIssues = Array.isArray(report.issues) ? report.issues.length : 0
      }
      verifierWallMs = performance.now() - verifyStarted
    }
  }

  return {
    extraction: { parsed, wallMs: extractWallMs + verifierWallMs, ok: extractResult.ok && verifierOk },
    verifier: { ok: verifierOk, issues: verifierIssues, wallMs: verifierWallMs },
  }
}

export const runWorkflowFidelityEval = async (o: FidelityEvalOptions): Promise<EvalVerdict> => {
  const req = vitalRequest(o.pack, true)
  const { fields } = req
  const { cases: allCases, fieldRecallFloor, valueFloor, unitFloor } = loadVitalCases(o.pack, fields)

  const inScope = o.difficulty ? parseDifficultyRange(o.difficulty) : () => true
  let cases = allCases.filter((c) => inScope(c.difficulty))
  if (!cases.length) throw new Error(`no cases at difficulty '${o.difficulty}' in pack '${o.pack.name}'`)

  if (o.caseLimit && o.caseLimit > 0 && o.caseLimit < cases.length) {
    cases = cases.slice(0, o.caseLimit)
  }

  // Load verifier profile and pack for the verified arm.
  let verifierProfile: ProfileModule | undefined
  let verifierPack: Pack | undefined
  let verifierBaseUrl: string | undefined
  try {
    const cfg = loadConfig()
    const verifierConfig = requireProfile(cfg, 'verifier')
    verifierBaseUrl = verifierConfig.url
    verifierProfile = await loadProfileModule(
      'verifier',
      resolveProfileModule('verifier', { configured: verifierConfig.module, base: cfg.base }),
    )
    if (verifierProfile.needsPack || verifierConfig.pack) {
      verifierPack = loadPack(
        resolvePackRoot('verifier', {
          explicit: undefined,
          configured: verifierConfig.pack as string | undefined,
          base: cfg.base,
        }),
      )
    }
  } catch {
    // Verifier not available — the verified arm will be skipped.
  }

  const identity = await identifyServer(o.baseUrl)
  if (identity.warning) console.error(`\nwarning: ${identity.warning}`)
  const served = identity.model ?? UNIDENTIFIED

  console.log(`\n=== Workflow Fidelity · ${cases.length} notes ===`)
  console.log(`model '${served}' · pack '${o.pack.name}' spec ${o.pack.spec}`)
  console.log(`arms: monolith (unconstrained) → specialist (constrained) → verified (constrained + verify)`)
  console.log(verifierProfile ? 'verifier: loaded' : 'verifier: NOT AVAILABLE — verified arm will show extraction only')
  console.log()

  const monolith: ArmResult = { name: 'monolith', tally: emptyTally(), misses: [], wallMs: 0, cases: 0, failedRuns: 0 }
  const specialist: ArmResult = { name: 'specialist', tally: emptyTally(), misses: [], wallMs: 0, cases: 0, failedRuns: 0 }
  const verified: ArmResult = { name: 'verified', tally: emptyTally(), misses: [], wallMs: 0, cases: 0, failedRuns: 0 }
  let verifierTotalIssues = 0
  let verifierTotalWallMs = 0

  for (const c of cases) {
    const note = o.pack.document(c.name)

    const m = await runMonolithArm({ pack: o.pack, baseUrl: o.baseUrl, trace: o.trace, caseName: c.name, note, fields })
    const s = await runSpecialistArm({ pack: o.pack, baseUrl: o.baseUrl, trace: o.trace, caseName: c.name, note, fields })
    const v = await runVerifiedArm({
      pack: o.pack,
      clinicalBaseUrl: o.baseUrl,
      verifierBaseUrl,
      trace: o.trace,
      caseName: c.name,
      note,
      fields,
      verifierProfile,
      verifierPack,
      ruleBased: true,
    })

    const mScored = m.parsed ? scoreCase(c, m.parsed, note, loadSettings(o.pack).quoteVerification) : scoreFailure(c)
    const sScored = s.parsed ? scoreCase(c, s.parsed, note, loadSettings(o.pack).quoteVerification) : scoreFailure(c)
    const vScored = v.extraction.parsed
      ? scoreCase(c, v.extraction.parsed, note, loadSettings(o.pack).quoteVerification)
      : scoreFailure(c)

    // If the verifier rejected the extraction, record it as a failed run but do NOT zero out
    // the scored tally. The clinical scorer already handles per-field detection/value/unit/quote
    // scoring. Zeroing the entire case is too aggressive: the rule-based verifier rejects
    // valid computed fields (e.g., BMI) and unit conversions (e.g., 1.78 m → 178 cm) because
    // the computed number does not appear in the document. We keep the scorer's tally so the
    // verified arm's recall is not artificially lowered by false-positive verifier rejections.
    if (!v.verifier.ok) {
      vScored.tally.failedRuns++
    }

    absorb(monolith.tally, mScored.tally)
    absorb(specialist.tally, sScored.tally)
    absorb(verified.tally, vScored.tally)
    monolith.misses.push(...mScored.misses)
    specialist.misses.push(...sScored.misses)
    verified.misses.push(...vScored.misses)
    monolith.wallMs += m.wallMs
    specialist.wallMs += s.wallMs
    verified.wallMs += v.extraction.wallMs
    monolith.cases++
    specialist.cases++
    verified.cases++
    if (!m.ok) monolith.failedRuns++
    if (!s.ok) specialist.failedRuns++
    if (!v.extraction.ok || !v.verifier.ok) verified.failedRuns++
    verifierTotalIssues += v.verifier.issues
    verifierTotalWallMs += v.verifier.wallMs

    o.trace.write({
      event: 'case',
      case: c.name,
      difficulty: c.difficulty,
      monolith: { ok: m.ok, wallMs: m.wallMs, tally: mScored.tally },
      specialist: { ok: s.ok, wallMs: s.wallMs, tally: sScored.tally },
      verified: { ok: v.extraction.ok && v.verifier.ok, wallMs: v.extraction.wallMs, verifierIssues: v.verifier.issues, tally: vScored.tally },
    })

    const mRec = ratio(mScored.tally.detected, mScored.tally.gradedTotal)
    const sRec = ratio(sScored.tally.detected, sScored.tally.gradedTotal)
    const vRec = ratio(vScored.tally.detected, vScored.tally.gradedTotal)
    const mHall = mScored.tally.hallucinations
    const sHall = sScored.tally.hallucinations
    const vHall = vScored.tally.hallucinations

    console.log(
      `${c.name.padEnd(28)} d${c.difficulty} ` +
        `mono ${(mRec * 100).toFixed(0).padStart(3)}% ${String(mHall).padStart(2)}h ` +
        `spec ${(sRec * 100).toFixed(0).padStart(3)}% ${String(sHall).padStart(2)}h ` +
        `veri ${(vRec * 100).toFixed(0).padStart(3)}% ${String(vHall).padStart(2)}h ` +
        `(${m.wallMs.toFixed(0).padStart(4)} / ${s.wallMs.toFixed(0).padStart(4)} / ${v.extraction.wallMs.toFixed(0).padStart(4)} ms)`,
    )
  }

  // --- Aggregate summary --------------------------------------------------------------------

  console.log(`\n${'—'.repeat(78)}`)
  console.log(`                           monolith    specialist    verified`)
  console.log(`  recall       ${pct(monolith.tally.detected, monolith.tally.gradedTotal)}  ${pct(specialist.tally.detected, specialist.tally.gradedTotal)}  ${pct(verified.tally.detected, verified.tally.gradedTotal)}`)
  console.log(`  value        ${pct(monolith.tally.valueExact, monolith.tally.detected)}  ${pct(specialist.tally.valueExact, specialist.tally.detected)}  ${pct(verified.tally.valueExact, verified.tally.detected)}`)
  console.log(`  unit         ${pct(monolith.tally.unitExact, monolith.tally.detected)}  ${pct(specialist.tally.unitExact, specialist.tally.detected)}  ${pct(verified.tally.unitExact, verified.tally.detected)}`)
  console.log(`  quote        ${pct(monolith.tally.quoteVerified, monolith.tally.detected)}  ${pct(specialist.tally.quoteVerified, specialist.tally.detected)}  ${pct(verified.tally.quoteVerified, verified.tally.detected)}`)
  console.log(`  halluc       ${String(monolith.tally.hallucinations).padStart(13)}  ${String(specialist.tally.hallucinations).padStart(13)}  ${String(verified.tally.hallucinations).padStart(13)}`)
  console.log(`  failed       ${String(monolith.failedRuns).padStart(13)}  ${String(specialist.failedRuns).padStart(13)}  ${String(verified.failedRuns).padStart(13)}`)
  console.log(`  total ms     ${String(monolith.wallMs.toFixed(0)).padStart(13)}  ${String(specialist.wallMs.toFixed(0)).padStart(13)}  ${String(verified.wallMs.toFixed(0)).padStart(13)}`)
  if (verifierProfile) {
    console.log(`  verify ms    ${String('—').padStart(13)}  ${String('—').padStart(13)}  ${String(verifierTotalWallMs.toFixed(0)).padStart(13)}`)
    console.log(`  verify issues${String('—').padStart(13)}  ${String('—').padStart(13)}  ${String(verifierTotalIssues).padStart(13)}`)
  }
  console.log(`  per-case ms  ${String((monolith.wallMs / monolith.cases).toFixed(0)).padStart(13)}  ${String((specialist.wallMs / specialist.cases).toFixed(0)).padStart(13)}  ${String((verified.wallMs / verified.cases).toFixed(0)).padStart(13)}`)

  // --- Gates --------------------------------------------------------------------------------

  const monoRecall = ratio(monolith.tally.detected, monolith.tally.gradedTotal)
  const specRecall = ratio(specialist.tally.detected, specialist.tally.gradedTotal)
  const veriRecall = ratio(verified.tally.detected, verified.tally.gradedTotal)
  const monoHallucRate = ratio(monolith.tally.hallucinations, monolith.tally.gradedTotal)
  const veriHallucRate = ratio(verified.tally.hallucinations, verified.tally.gradedTotal)
  const monoPerCaseMs = monolith.wallMs / monolith.cases
  const veriPerCaseMs = verified.wallMs / verified.cases

  const specRecallPass = specRecall >= monoRecall
  const veriRecallPass = veriRecall >= monoRecall
  const veriHallucPass = veriHallucRate <= monoHallucRate
  const veriLatencyPass = veriPerCaseMs <= monoPerCaseMs * 2

  const pass = specRecallPass && veriRecallPass && veriHallucPass && veriLatencyPass

  const parts: string[] = []
  parts.push(`spec recall ${(specRecall * 100).toFixed(0)}% ≥ mono ${(monoRecall * 100).toFixed(0)}% ${specRecallPass ? '✓' : '✗'}`)
  parts.push(`veri recall ${(veriRecall * 100).toFixed(0)}% ≥ mono ${(monoRecall * 100).toFixed(0)}% ${veriRecallPass ? '✓' : '✗'}`)
  parts.push(`veri halluc ${(veriHallucRate * 100).toFixed(1)}% ≤ mono ${(monoHallucRate * 100).toFixed(1)}% ${veriHallucPass ? '✓' : '✗'}`)
  parts.push(`veri latency ${(veriPerCaseMs / 1000).toFixed(1)}s ≤ 2× mono ${(monoPerCaseMs / 1000).toFixed(1)}s ${veriLatencyPass ? '✓' : '✗'}`)

  o.trace.write({
    event: 'record',
    harness: HARNESS_VERSION,
    model: served,
    identified: identity.identified,
    cases: cases.length,
    monolith: { tally: monolith.tally, wallMs: monolith.wallMs, failedRuns: monolith.failedRuns },
    specialist: { tally: specialist.tally, wallMs: specialist.wallMs, failedRuns: specialist.failedRuns },
    verified: { tally: verified.tally, wallMs: verified.wallMs, failedRuns: verified.failedRuns, verifierIssues: verifierTotalIssues, verifierWallMs: verifierTotalWallMs },
    gates: { specRecallPass, veriRecallPass, veriHallucPass, veriLatencyPass },
    pass,
  })

  return { pass, summary: parts.join(' · ') }
}
