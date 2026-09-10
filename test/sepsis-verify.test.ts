import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { loadConfig, requireProfile } from '../src/core/config.ts'
import { loadPack } from '../src/core/pack.ts'
import { loadProfileModule } from '../src/core/profile.ts'
import type { Provider } from '../src/core/client.ts'
import { nullTrace } from '../src/core/trace.ts'
import { buildPipeline, runPipeline } from '../src/modes/pipeline.ts'
import { loadMedprotocolRule } from '../src/profiles/clinical/medprotocol.ts'
import { PROFILE as CLINICAL_PROFILE } from '../src/profiles/clinical/profile.ts'
import {
  CRITERIA,
  loadSepsisCases,
  type SepsisExam,
  type SepsisReply,
} from '../src/profiles/clinical/sepsis.ts'
import { PROFILE, type SepsisVerificationReport } from '../src/profiles/sepsis-verify/profile.ts'

process.env.MEDPROTOCOL_BIN = join(import.meta.dirname, 'fixtures', 'medprotocol.js')

const pack = loadPack(join(import.meta.dirname, '..', 'packs', 'clinical'))
const cases = loadSepsisCases(pack, loadMedprotocolRule(pack)).cases

const replyFor = (index: number): SepsisReply => {
  const resolved = cases[index]!.resolved
  return {
    ...resolved.exam,
    qsofa_score: resolved.screen.score,
    positive: resolved.screen.positive,
    criteria_met: CRITERIA.filter((criterion) => resolved.criteria[criterion]),
    screen_reason: null,
    assessment_confidence: 1,
    notes: null,
  }
}

const review = (document: SepsisExam, extraction: string) => PROFILE.review!({
  pack,
  trace: nullTrace(),
  input: { kind: 'text', text: JSON.stringify({ document, extraction }) },
  options: {},
})

test('the two-step pipeline verifies five sepsis corpus replies with a stubbed extractor', async () => {
  for (let i = 0; i < 5; i++) {
    const raw = JSON.stringify(replyFor(i))
    const provider: Provider = {
      chat: async () => raw,
      toolChat: async () => ({ content: raw, toolCalls: [] }),
      streamChat: async () => ({ content: raw, toolCalls: [], chunks: 1 }),
      identify: async () => ({ model: 'stub', identified: true }),
    }
    const result = await runPipeline({
      initialInput: JSON.stringify(cases[i]!.exam),
      steps: buildPipeline([
        { name: 'extract', profile: 'clinical', input: 'initial' },
        { name: 'verify', profile: 'sepsis-verify', input: { document: 'initial', extraction: 'step-0.raw' } },
      ]),
      profiles: new Map([
        ['clinical', CLINICAL_PROFILE],
        ['sepsis-verify', PROFILE],
      ]),
      packs: new Map([
        ['clinical', pack],
        ['sepsis-verify', pack],
      ]),
      baseUrls: new Map([
        ['clinical', 'http://127.0.0.1:1'],
        ['sepsis-verify', undefined],
      ]),
      options: { constrain: true },
      provider,
    })
    assert.equal(result.stoppedEarly, false, cases[i]!.name)
    assert.equal(result.steps.length, 2, cases[i]!.name)
    assert.equal(result.steps[1]!.ok, true, cases[i]!.name)
    assert.deepEqual(result.steps[1]!.report, {
      echoOk: true,
      criteriaOk: true,
      screenOk: true,
      scoreOk: true,
      issues: [],
    })
  }
})

test('reports echo, criteria, screen, and score mismatches independently', async () => {
  const base = replyFor(0)
  const mutations: Array<[keyof SepsisVerificationReport, SepsisReply]> = [
    ['echoOk', { ...base, respiratory_rate: base.respiratory_rate - 1 }],
    ['criteriaOk', { ...base, criteria_met: base.criteria_met.slice(1) }],
    ['screenOk', { ...base, positive: !base.positive }],
    ['scoreOk', { ...base, qsofa_score: base.qsofa_score - 1 }],
  ]

  for (const [field, reply] of mutations) {
    const result = await review(cases[0]!.exam, JSON.stringify(reply))
    assert.equal(result.ok, false, field)
    const report = result.report as SepsisVerificationReport
    assert.equal(report[field], false, field)
    assert.equal(report.issues.length, 1, field)
  }
})

test('duplicate criteria are refused like a fence, never accepted as an exact criteria match', async () => {
  const base = replyFor(0)
  const result = await review(cases[0]!.exam, JSON.stringify({
    ...base,
    criteria_met: [...base.criteria_met, base.criteria_met[0]],
  }))
  assert.equal(result.ok, false)
  const report = result.report as SepsisVerificationReport
  assert.equal(report.criteriaOk, false)
  assert.match(report.issues[0]!, /more than once/)
})

test('refuses malformed composed input and malformed extraction JSON', async () => {
  const malformedInput = await PROFILE.review!({
    pack,
    trace: nullTrace(),
    input: { kind: 'text', text: '{}' },
    options: {},
  })
  assert.equal(malformedInput.ok, false)
  assert.match(malformedInput.text, /document/)

  const malformedExtraction = await review(cases[0]!.exam, 'not JSON')
  assert.equal(malformedExtraction.ok, false)
  assert.match(malformedExtraction.text, /JSON/)
})

test('config wires raw clinical output into the deterministic verifier', async () => {
  const config = requireProfile(loadConfig(), 'sepsis-verified')
  const steps = config.steps as Array<{ input?: unknown }>
  assert.deepEqual(steps[1]?.input, { document: 'initial', extraction: 'step-0.raw' })
  assert.equal((await loadProfileModule('sepsis-verify')).name, 'sepsis-verify')
  assert.equal((await loadProfileModule('sepsis-verified')).name, 'sepsis-verified')
})
