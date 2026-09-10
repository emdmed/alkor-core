/**
 * One clinical note in, one SepsisExam payload out.
 *
 * This is the extraction half of the end-to-end sepsis workflow: it reads free-text prose and
 * produces the structured JSON payload the sepsis-screening contract consumes. It is the
 * shock-extraction pass's opposite number, and it exists because `reviewSepsis` calls
 * `parseSepsis`, which requires all three qSOFA numbers — a note handed straight to the screen
 * does not screen a patient, it throws.
 *
 * THE PARSER IS `parseSepsis`, the screening contract's own, and reusing it rather than writing
 * a second validator here is the point of the module. The downstream contract will run that
 * function over these bytes anyway; if it is going to reject a payload, it should reject it at
 * the step that produced it, where the error can name the extraction rather than surfacing one
 * stage later as a mysterious refusal from a screen nobody invoked directly. It also means
 * there is exactly one statement in this repository of what a qSOFA payload must contain.
 */
import type { Pack } from '../../core/pack.ts'
import type { ReviewResult } from '../../core/profile.ts'
import type { Trace } from '../../core/trace.ts'
import type { Activity } from '../../core/activity.ts'
import { nextStageId } from '../../core/activity.ts'
import { serverModel } from '../../core/client.ts'
import type { Provider } from '../../core/client.ts'
import { HARNESS_VERSION } from '../../core/version.ts'
import { extract } from '../../modes/extract.ts'
import { CONTRACTS, buildRequest } from './contracts.ts'
import { assess, loadSepsisRule, parseSepsis, resolveSepsis, type SepsisExam } from './sepsis.ts'
import { checkMedprotocolVersion, loadMedprotocolRule } from './medprotocol.ts'

export interface SepsisExtractionReviewOptions {
  pack: Pack
  baseUrl?: string
  trace: Trace
  constrain: boolean
  input: { kind: 'case'; name: string } | { kind: 'text'; text: string; label?: string }
  provider?: Provider
  activity?: Activity
}

export const reviewSepsisExtraction = async (o: SepsisExtractionReviewOptions): Promise<ReviewResult> => {
  const req = buildRequest(CONTRACTS['sepsis-extraction'], o.pack, o.constrain)
  const document = o.input.kind === 'case' ? o.pack.document(o.input.name) : o.input.text
  const label = o.input.kind === 'case' ? o.input.name : (o.input.label ?? 'supplied document')

  const served = (await serverModel(o.baseUrl)) ?? '(server did not say)'
  o.trace.write({
    event: 'run',
    kind: 'review',
    task: 'sepsis-extraction',
    harness: HARNESS_VERSION,
    model: served,
    baseUrl: o.baseUrl,
    constrained: o.constrain,
    sampling: req.sampling,
    pack: { name: o.pack.name, spec: o.pack.spec },
    document: label,
  })

  const extractionStage = o.activity ? nextStageId() : undefined
  o.activity?.emit({ kind: 'stage', stageId: extractionStage, name: 'sepsis-extraction', status: 'started' })
  const extractionStart = performance.now()
  const outcome = await extract({
    systemPrompt: req.prompt,
    document,
    parse: (raw) => parseSepsis(raw, 'sepsis-extraction'),
    schema: req.schema,
    schemaName: req.schemaName,
    maxTokens: req.sampling.max_tokens,
    temperature: req.sampling.temperature,
    timeoutMs: req.sampling.timeout_secs * 1000,
    baseUrl: o.baseUrl,
    label: 'sepsis-extraction',
    provider: o.provider,
    activity: o.activity,
  })
  o.activity?.emit({ kind: 'stage', stageId: extractionStage, name: 'sepsis-extraction', status: 'completed', wallMs: performance.now() - extractionStart })

  const header =
    `\n=== sepsis extraction · ${label} ===\n` +
    `model '${served}' · pack '${o.pack.name}' spec ${o.pack.spec} · ` +
    `${o.constrain ? 'constrained' : 'unconstrained'} · ` +
    `temp ${req.sampling.temperature} · max_tokens ${req.sampling.max_tokens}\n`

  let text: string
  let report: unknown | undefined
  if (outcome.parsed) {
    const exam = outcome.parsed as SepsisExam
    // The reference screen, computed by the CLI on the numbers just extracted. This is the same
    // arithmetic the downstream contract will be graded against, and it is run HERE so the
    // extraction step reports what its own output implies rather than three numbers whose
    // consequence only appears a stage later. It is a FACT about the payload, not a verdict on
    // the model: nothing here scores anything.
    const mp = loadMedprotocolRule(o.pack)
    checkMedprotocolVersion(mp, o.pack.name)
    const rule = loadSepsisRule(o.pack)
    const screen = assess(resolveSepsis(exam, rule, mp))
    o.activity?.emit({
      kind: 'stage',
      name: 'gateway',
      status: 'completed',
      detail: { via: 'qsofa', score: screen.score, positive: screen.positive },
    })
    text =
      `${header}\n` +
      `  respiratory_rate: ${exam.respiratory_rate} breaths/min\n` +
      `  systolic_bp: ${exam.systolic_bp} mmHg\n` +
      `  gcs: ${exam.gcs}\n` +
      `  qsofa_screen: ${screen.positive ? 'POSITIVE' : 'NEGATIVE'} (score ${screen.score})\n`
    report = { exam, screen }
  } else {
    text = `${header}\nno extraction: ${outcome.error}`
  }

  o.trace.write({
    event: 'review',
    task: 'sepsis-extraction',
    document: label,
    ok: Boolean(outcome.parsed),
    error: outcome.error,
    completion: outcome.raw,
  })
  o.trace.write({
    event: 'record',
    harness: HARNESS_VERSION,
    model: served,
    constrained: o.constrain,
    contracts: o.pack.digest(),
  })

  return { text, ok: Boolean(outcome.parsed), raw: outcome.raw, document, label, report }
}
