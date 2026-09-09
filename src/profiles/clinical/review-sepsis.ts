/**
 * One Quick SOFA payload in, one structured screen report out.
 *
 * Assembled from `buildRequest` exactly as `runSepsisEval` assembles it, and parsed by
 * `parseSepsisReply` exactly as that eval parses it. The difference is that there is no answer
 * key: the review path reports what the model read and whether the payload parsed, rather than a
 * percentage.
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
  assess,
  loadSepsisCases,
  loadSepsisRule,
  parseSepsis,
  parseSepsisReply,
  renderSepsis,
  resolveSepsis,
  type SepsisExam,
} from './sepsis.ts'
import type { Provider } from '../../core/client.ts'
import { checkMedprotocolVersion, loadMedprotocolRule } from './medprotocol.ts'

export interface SepsisReviewOptions {
  pack: Pack
  baseUrl?: string
  trace: Trace
  constrain: boolean
  input: { kind: 'case'; name: string } | { kind: 'text'; text: string; label?: string }
  provider?: Provider
  activity?: Activity
}

export const reviewSepsis = async (o: SepsisReviewOptions): Promise<ReviewResult> => {
  const req = buildRequest(CONTRACTS.sepsis, o.pack, o.constrain)

  const rule = loadSepsisRule(o.pack)
  const mp = loadMedprotocolRule(o.pack)
  checkMedprotocolVersion(mp, o.pack.name)

  let exam: SepsisExam
  let label: string

  if (o.input.kind === 'case') {
    const caseName = o.input.name
    const cases = loadSepsisCases(o.pack, mp)
    const c = cases.cases.find((c) => c.name === caseName)
    if (!c) throw new Error(`pack '${o.pack.name}' has no sepsis case '${caseName}'`)
    exam = c.exam
    label = caseName
  } else {
    exam = parseSepsis(o.input.text, 'supplied document')
    label = o.input.label ?? 'supplied document'
  }

  const resolved = resolveSepsis(exam, rule, mp)
  const payload = renderSepsis(resolved)
  const truth = assess(resolved)

  const served = (await serverModel(o.baseUrl)) ?? '(server did not say)'
  o.trace.write({
    event: 'run',
    kind: 'review',
    task: 'sepsis',
    harness: HARNESS_VERSION,
    model: served,
    baseUrl: o.baseUrl,
    constrained: o.constrain,
    sampling: req.sampling,
    pack: { name: o.pack.name, spec: o.pack.spec },
    document: label,
  })

  const screeningStage = o.activity ? nextStageId() : undefined
  o.activity?.emit({ kind: 'stage', stageId: screeningStage, name: 'sepsis-screening', status: 'started' })
  const screeningStart = performance.now()
  const outcome = await extract({
    systemPrompt: req.prompt,
    document: payload,
    parse: parseSepsisReply,
    schema: req.schema,
    schemaName: req.schemaName,
    maxTokens: req.sampling.max_tokens,
    temperature: req.sampling.temperature,
    timeoutMs: req.sampling.timeout_secs * 1000,
    baseUrl: o.baseUrl,
    label: 'sepsis',
    provider: o.provider,
    activity: o.activity,
  })
  o.activity?.emit({ kind: 'stage', stageId: screeningStage, name: 'sepsis-screening', status: 'completed', wallMs: performance.now() - screeningStart })

  const header =
    `\n=== sepsis screen · ${label} ===\n` +
    `model '${served}' · pack '${o.pack.name}' spec ${o.pack.spec} · ` +
    `${o.constrain ? 'constrained' : 'unconstrained'} · ` +
    `temp ${req.sampling.temperature} · max_tokens ${req.sampling.max_tokens}\n`

  let text: string
  if (outcome.parsed) {
    const reply = outcome.parsed
    const agrees = reply.positive === truth.positive
    o.activity?.emit({
      kind: 'stage',
      stageId: nextStageId(),
      name: 'verify',
      status: 'completed',
      detail: { ok: true, positive: reply.positive, expects: truth.positive, agrees },
    })
    text =
      `${header}\n` +
      `screen:      ${reply.positive ? 'POSITIVE' : 'negative'}\n` +
      `score:       ${reply.qsofa_score}\n` +
      `echo:        rr ${reply.respiratory_rate}, sbp ${reply.systolic_bp}, gcs ${reply.gcs}\n` +
      `criteria:    ${reply.criteria_met.length ? reply.criteria_met.join(', ') : 'none'}\n` +
      `medprotocol: ${truth.positive ? 'POSITIVE' : 'negative'} (score ${truth.score})\n` +
      `agreement:   ${agrees ? 'yes' : 'NO'}\n` +
      `confidence:  ${reply.assessment_confidence}\n` +
      (reply.screen_reason ? `reason:      ${reply.screen_reason}\n` : '') +
      (reply.notes ? `notes:       ${reply.notes}\n` : '')
  } else {
    o.activity?.emit({ kind: 'stage', stageId: nextStageId(), name: 'verify', status: 'completed', detail: { ok: false } })
    text = `${header}\nno screen: ${outcome.error}`
  }

  o.trace.write({
    event: 'review',
    task: 'sepsis',
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