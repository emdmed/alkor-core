/**
 * One shock-examination payload in, one structured assessment out.
 *
 * Assembled from `buildRequest` exactly as `runShockEval` assembles it, and parsed by
 * `parseShockReply` exactly as that eval parses it. The difference is that there is no
 * answer key: the review path reports what the model read and whether the payload parsed,
 * rather than a percentage.
 */
import type { Pack } from '../../core/pack.ts'
import type { ReviewResult } from '../../core/profile.ts'
import type { Trace } from '../../core/trace.ts'
import type { Activity } from '../../core/activity.ts'
import { nextStageId } from '../../core/activity.ts'
import { serverModel } from '../../core/client.ts'
import { HARNESS_VERSION } from '../../core/version.ts'
import { extract } from '../../modes/extract.ts'
import { CONTRACTS, buildRequest } from './contracts.ts'
import {
  classify,
  loadShockCases,
  loadShockRule,
  parseExam,
  parseShockReply,
  renderExam,
  resolveExam,
  type ShockExam,
} from './shock.ts'
import type { Provider } from '../../core/client.ts'
import { checkMedprotocolVersion, loadMedprotocolRule } from './medprotocol.ts'

export interface ShockReviewOptions {
  pack: Pack
  baseUrl?: string
  trace: Trace
  constrain: boolean
  input: { kind: 'case'; name: string } | { kind: 'text'; text: string; label?: string }
  provider?: Provider
  activity?: Activity
}

export const reviewShock = async (o: ShockReviewOptions): Promise<ReviewResult> => {
  const req = buildRequest(CONTRACTS.shock, o.pack, o.constrain)

  const rule = loadShockRule(o.pack)
  const mp = loadMedprotocolRule(o.pack)
  checkMedprotocolVersion(mp, o.pack.name)

  let exam: ShockExam
  let label: string

  if (o.input.kind === 'case') {
    const caseName = o.input.name
    const cases = loadShockCases(o.pack, mp)
    const c = cases.cases.find((c) => c.name === caseName)
    if (!c) throw new Error(`pack '${o.pack.name}' has no shock case '${caseName}'`)
    exam = c.exam
    label = caseName
  } else {
    exam = parseExam(o.input.text, 'supplied document')
    label = o.input.label ?? 'supplied document'
  }

  const resolved = resolveExam(exam, rule, mp)
  const payload = renderExam(resolved)
  const truth = classify(resolved)

  const served = (await serverModel(o.baseUrl)) ?? '(server did not say)'
  o.trace.write({
    event: 'run',
    kind: 'review',
    task: 'shock',
    harness: HARNESS_VERSION,
    model: served,
    baseUrl: o.baseUrl,
    constrained: o.constrain,
    sampling: req.sampling,
    pack: { name: o.pack.name, spec: o.pack.spec },
    document: label,
  })

  const classificationStage = o.activity ? nextStageId() : undefined
  o.activity?.emit({ kind: 'stage', stageId: classificationStage, name: 'shock-classification', status: 'started' })
  const classificationStart = performance.now()
  const outcome = await extract({
    systemPrompt: req.prompt,
    document: payload,
    parse: parseShockReply,
    schema: req.schema,
    schemaName: req.schemaName,
    maxTokens: req.sampling.max_tokens,
    temperature: req.sampling.temperature,
    timeoutMs: req.sampling.timeout_secs * 1000,
    baseUrl: o.baseUrl,
    label: 'shock',
    provider: o.provider,
    activity: o.activity,
  })
  o.activity?.emit({ kind: 'stage', stageId: classificationStage, name: 'shock-classification', status: 'completed', wallMs: performance.now() - classificationStart })

  const header =
    `\n=== shock assessment · ${label} ===\n` +
    `model '${served}' · pack '${o.pack.name}' spec ${o.pack.spec} · ` +
    `${o.constrain ? 'constrained' : 'unconstrained'} · ` +
    `temp ${req.sampling.temperature} · max_tokens ${req.sampling.max_tokens}\n`

  let text: string
  if (outcome.parsed) {
    const reply = outcome.parsed
    const agrees = reply.shock_category === truth.category
    o.activity?.emit({
      kind: 'stage',
      stageId: nextStageId(),
      name: 'verify',
      status: 'completed',
      detail: { ok: true, category: reply.shock_category, expects: truth.category, agrees },
    })
    text =
      `${header}\n` +
      `category:   ${reply.shock_category}\n` +
      `echo:       skin ${reply.skin_temperature}, jvp ${reply.jugular_venous_pressure}\n` +
      `rule says:  ${truth.category}${truth.reason ? ` (${truth.reason})` : ''}\n` +
      `agreement:  ${agrees ? 'yes' : 'NO'}\n` +
      `confidence: ${reply.assessment_confidence}\n` +
      (reply.notes ? `notes:      ${reply.notes}\n` : '')
  } else {
    o.activity?.emit({ kind: 'stage', stageId: nextStageId(), name: 'verify', status: 'completed', detail: { ok: false } })
    text = `${header}\nno assessment: ${outcome.error}`
  }

  o.trace.write({
    event: 'review',
    task: 'shock',
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

  return { text, ok: Boolean(outcome.parsed), raw: outcome.raw, document: payload, label }
}
