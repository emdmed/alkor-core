/**
 * One clinical note in, one ShockExam payload out.
 *
 * This is the extraction half of the end-to-end shock pipeline: it reads free-text prose
 * and produces the structured JSON payload that the shock-reasoning contract consumes.
 * The parser is deliberately strict: the downstream rule is a table lookup on two findings,
 * and a model that echoes the wrong finding has answered about a patient the payload does not
 * describe. The extraction must be exact before reasoning can be measured.
 */
import type { Pack } from '../../core/pack.ts'
import type { ReviewResult } from '../../core/profile.ts'
import type { Trace } from '../../core/trace.ts'
import type { Activity } from '../../core/activity.ts'
import { serverModel } from '../../core/client.ts'
import type { Provider } from '../../core/client.ts'
import { HARNESS_VERSION } from '../../core/version.ts'
import { extract } from '../../modes/extract.ts'
import { CONTRACTS, buildRequest } from './contracts.ts'
import { clinicalStages } from './stages.ts'
import { parseJson } from './extraction.ts'
import { confirmShock, loadShockRule, type ShockExam } from './shock.ts'
import { checkMedprotocolVersion, loadMedprotocolRule } from './medprotocol.ts'

export interface ShockExtractionReviewOptions {
  pack: Pack
  baseUrl?: string
  trace: Trace
  constrain: boolean
  input: { kind: 'case'; name: string } | { kind: 'text'; text: string; label?: string }
  provider?: Provider
  activity?: Activity
}

export const reviewShockExtraction = async (o: ShockExtractionReviewOptions): Promise<ReviewResult> => {
  const req = buildRequest(CONTRACTS['shock-extraction'], o.pack, o.constrain)
  const document = o.input.kind === 'case' ? o.pack.document(o.input.name) : o.input.text
  const label = o.input.kind === 'case' ? o.input.name : (o.input.label ?? 'supplied document')

  const served = (await serverModel(o.baseUrl)) ?? '(server did not say)'
  o.trace.write({
    event: 'run',
    kind: 'review',
    task: 'shock-extraction',
    harness: HARNESS_VERSION,
    model: served,
    baseUrl: o.baseUrl,
    constrained: o.constrain,
    sampling: req.sampling,
    pack: { name: o.pack.name, spec: o.pack.spec },
    document: label,
  })

  const stages = clinicalStages('shock-extraction', o.activity)
  const outcome = await stages.around('shock-extraction', () => extract({
    systemPrompt: req.prompt,
    document,
    parse: (raw) => parseShockExam(raw),
    schema: req.schema,
    schemaName: req.schemaName,
    maxTokens: req.sampling.max_tokens,
    temperature: req.sampling.temperature,
    timeoutMs: req.sampling.timeout_secs * 1000,
    baseUrl: o.baseUrl,
    label: 'shock-extraction',
    provider: o.provider,
    activity: o.activity,
  }))

  const header =
    `\n=== shock extraction · ${label} ===\n` +
    `model '${served}' · pack '${o.pack.name}' spec ${o.pack.spec} · ` +
    `${o.constrain ? 'constrained' : 'unconstrained'} · ` +
    `temp ${req.sampling.temperature} · max_tokens ${req.sampling.max_tokens}\n`

  let text: string
  let report: unknown | undefined
  if (outcome.parsed) {
    const exam = outcome.parsed as ShockExam
    const mp = loadMedprotocolRule(o.pack)
    checkMedprotocolVersion(mp, o.pack.name)
    const rule = loadShockRule(o.pack)
    const confirmation = confirmShock(exam, mp, rule)
    stages.done('gateway', {
      via: 'confirmShock',
      confirmed: confirmation.confirmed,
      systolic: confirmation.systolic,
      shockIndex: confirmation.shockIndex,
    })
    text =
      `${header}\n` +
      `  hypotension: ${exam.hypotension.systolic}/${exam.hypotension.diastolic} mmHg ` +
      `(${exam.hypotension.duration_minutes} min)\n` +
      `  heart_rate: ${exam.heart_rate} bpm\n` +
      `  skin_temperature: ${exam.skin_temperature}\n` +
      `  jugular_venous_pressure: ${exam.jugular_venous_pressure}\n` +
      `  capillary_refill: ${exam.capillary_refill}\n` +
      `  pulse_volume: ${exam.pulse_volume}\n` +
      `  lung_exam: ${exam.lung_exam}\n` +
      `  shock_confirmation: ${confirmation.confirmed ? 'CONFIRMED' : 'NOT CONFIRMED'} ` +
      `(${confirmation.reason})\n`
    report = { exam, confirmation }
  } else {
    text = `${header}\nno extraction: ${outcome.error}`
  }

  o.trace.write({
    event: 'review',
    task: 'shock-extraction',
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

const parseShockExam = (raw: string): ShockExam => {
  const obj = parseJson(raw, 'shock-extraction')
  const h = obj.hypotension as Record<string, unknown> | undefined
  if (!h || typeof h.systolic !== 'number' || typeof h.diastolic !== 'number' || typeof h.duration_minutes !== 'number') {
    throw new Error('hypotension must be an object with systolic, diastolic and duration_minutes as numbers')
  }
  if (typeof obj.heart_rate !== 'number') {
    throw new Error('heart_rate must be a number')
  }
  const enums: Record<string, readonly string[]> = {
    skin_temperature: ['warm', 'cool', 'not_assessed'],
    jugular_venous_pressure: ['elevated', 'normal_or_low', 'not_assessed'],
    capillary_refill: ['brisk', 'delayed', 'not_assessed'],
    pulse_volume: ['bounding', 'normal', 'thready', 'not_assessed'],
    lung_exam: ['clear', 'bilateral_crackles', 'not_assessed'],
  }
  for (const [name, allowed] of Object.entries(enums)) {
    const v = obj[name]
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
      throw new Error(`${name} was ${JSON.stringify(v)}, expected one of ${allowed.join(', ')}`)
    }
  }
  return obj as unknown as ShockExam
}
