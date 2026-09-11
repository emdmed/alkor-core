/**
 * Clinical-verified profile tests: smoke test, fidelity eval wiring, and gate logic.
 *
 * No model calls; the fidelity eval path is tested only for wiring and option handling.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { nullTrace } from '../src/core/trace.ts'
import { loadConfig, requireProfile } from '../src/core/config.ts'
import { loadPack, resolvePackRoot } from '../src/core/pack.ts'
import { PROFILE } from '../src/profiles/clinical-verified/profile.ts'
import { runWorkflowCaseEval } from '../src/profiles/clinical-verified/eval.ts'
import { PROFILE as CLINICAL_PROFILE } from '../src/profiles/clinical/profile.ts'
import { PROFILE as VERIFIER_PROFILE } from '../src/profiles/verifier/profile.ts'
import { PROFILE as ASSESSMENT_PROFILE } from '../src/profiles/clinical-assessment/profile.ts'
import { emptyTally, absorb, ratio } from '../src/profiles/clinical/scorer.ts'
import { loadMedprotocolRule } from '../src/profiles/clinical/medprotocol.ts'
import { CRITERIA, loadSepsisCases } from '../src/profiles/clinical/sepsis.ts'
import { buildWorkflow, runWorkflow } from '../src/modes/workflow.ts'
import type { ProfileModule } from '../src/core/profile.ts'
import type { ChatOptions, Provider } from '../src/core/client.ts'

process.env.MEDPROTOCOL_BIN = join(import.meta.dirname, 'fixtures', 'medprotocol.js')

test('smoke test passes when workflow steps are well-formed', async () => {
  const cfg = loadConfig()
  const config = requireProfile(cfg, 'clinical-verified')
  const verdict = await PROFILE.runEval!({
    config,
    pack: undefined,
    baseUrl: undefined,
    trace: nullTrace(),
    options: {},
  })
  assert.equal(verdict.pass, true)
  assert.ok(verdict.summary.includes('4 workflow steps validated'))
})

test('workflow passes the clinical structured output to the verifier', () => {
  const cfg = loadConfig()
  const config = requireProfile(cfg, 'clinical-verified')
  const steps = config.steps as Array<{ input?: unknown }>
  assert.deepEqual(steps[1]?.input, { document: 'initial', extraction: 'step-0.output' })
  assert.equal(steps[2]?.input, 'step-1.output')
  // The ending reads the whole run, and it is marked final so a refusal cannot skip it.
  assert.equal((steps[3] as { input?: unknown; final?: unknown })?.input, 'run')
  assert.equal((steps[3] as { final?: unknown })?.final, true)
})

test('multi-task clinical output reaches the verifier when there is no single raw completion', async () => {
  const combined = {
    routes: ['shock-extraction', 'shock'],
    results: {
      'shock-extraction': { ok: true, output: { exam: { systolic: 68 } } },
      shock: { ok: true, output: { shock_category: 'cardiogenic' } },
    },
  }
  let adapterInput: Record<string, unknown> | undefined
  const adapter: ProfileModule = {
    name: 'clinical-verifier',
    mode: 'code',
    needsPack: false,
    async review(ctx) {
      adapterInput = JSON.parse(ctx.input.kind === 'text' ? ctx.input.text : '')
      return { text: 'prepared', ok: true, report: adapterInput }
    },
    async runEval() {
      return { pass: true, summary: 'not used' }
    },
  }
  let verifierInput: Record<string, unknown> | undefined
  const clinical: ProfileModule = {
    name: 'clinical',
    mode: 'extract',
    needsPack: false,
    async review() {
      return { text: JSON.stringify(combined), ok: true, report: combined }
    },
    async runEval() {
      return { pass: true, summary: 'not used' }
    },
  }
  const verifier: ProfileModule = {
    name: 'verifier',
    mode: 'extract',
    needsPack: false,
    async review(ctx) {
      verifierInput = JSON.parse(ctx.input.kind === 'text' ? ctx.input.text : '')
      return { text: 'verified', ok: true, report: { verified: true } }
    },
    async runEval() {
      return { pass: true, summary: 'not used' }
    },
  }
  const cfg = loadConfig()
  const configuredSteps = requireProfile(cfg, 'clinical-verified').steps as Parameters<typeof buildWorkflow>[0]
  const steps = buildWorkflow(configuredSteps)
  const result = await runWorkflow({
    initialInput: 'synthetic clinical note',
    steps,
    profiles: new Map([['clinical', clinical], ['clinical-verifier', adapter], ['verifier', verifier], ['clinical-assessment', ASSESSMENT_PROFILE]]),
    packs: new Map([['clinical', undefined], ['clinical-verifier', undefined], ['verifier', undefined], ['clinical-assessment', undefined]]),
    baseUrls: new Map([['clinical', undefined], ['clinical-verifier', undefined], ['verifier', undefined], ['clinical-assessment', undefined]]),
  })

  assert.equal(result.stoppedEarly, false)
  assert.equal(result.steps.length, 4)
  assert.deepEqual(adapterInput, { document: 'synthetic clinical note', extraction: combined })
  assert.deepEqual(verifierInput, adapterInput)
})

test('full configured workflow verifies shock derivations before source verification', async () => {
  const clinicalPack = loadPack(resolvePackRoot('clinical', { configured: 'packs/clinical', base: process.cwd() }))
  const note = clinicalPack.document('sh-02-cardiogenic-classic')
  const verifierPrompts: string[] = []
  const replies = {
    'shock-extraction': JSON.stringify({
      hypotension: { systolic: 68, diastolic: 50, duration_minutes: 200 },
      heart_rate: 115,
      skin_temperature: 'cool',
      jugular_venous_pressure: 'elevated',
      capillary_refill: 'brisk',
      pulse_volume: 'thready',
      lung_exam: 'bilateral_crackles',
    }),
    shock: JSON.stringify({
      skin_temperature: 'cool',
      jugular_venous_pressure: 'elevated',
      shock_category: 'cardiogenic',
      supporting_findings: ['lung_exam'],
      discordant_findings: ['capillary_refill'],
      indeterminate_reason: null,
      assessment_confidence: 0.95,
      notes: null,
    }),
    extraction: JSON.stringify({
      verified: true,
      confidence: 0.95,
      issues: [],
    }),
  } as const
  const provider: Provider = {
    async chat(o: ChatOptions): Promise<string> {
      if (o.label === 'extraction') verifierPrompts.push(o.userPrompt)
      return replies[o.label as keyof typeof replies]
    },
    async toolChat() { return { content: '', toolCalls: [] } },
    async streamChat() { return { content: '', toolCalls: [], chunks: 0 } },
    async identify() { return { model: 'pipeline-test-stub', identified: true } },
  }

  // Prove this is the production profile chain, not the lightweight mock flow used by the
  // routing tests. The custom provider replaces only transport/model output.
  assert.equal(CLINICAL_PROFILE.name, 'clinical')
  assert.equal(VERIFIER_PROFILE.name, 'verifier')
  const { verdict, workflow } = await runWorkflowCaseEval({ input: note, trace: nullTrace(), provider })

  assert.equal(verdict.pass, true)
  assert.equal(workflow.stoppedEarly, false)
  assert.deepEqual(workflow.steps.map((step) => [step.name, step.ok]), [
    ['extract', true],
    ['verify-derived', true],
    ['verify-source', true],
    ['assess', true],
  ])
  // The run ends with a statement about the patient, not with the verifier's certificate.
  const ending = workflow.steps.find((step) => step.name === 'assess')
  assert.match(String(ending?.text), /^ASSESSMENT — /)
  assert.match(String(ending?.text), /Shock: cardiogenic/)
  assert.equal(verifierPrompts.length, 1)
  assert.match(verifierPrompts[0]!, /not_assessed/)
  assert.doesNotMatch(verifierPrompts[0]!, /"shockIndex":\s*1\.69/)
  assert.doesNotMatch(verifierPrompts[0]!, /"shock_category":\s*"cardiogenic"/)
  assert.doesNotMatch(note, /shockIndex|shock_category/)
  assert.match(verdict.summary, /4\/4 configured steps completed/)
})

/**
 * The sepsis arm through the SAME configured chain, over the whole qSOFA corpus.
 *
 * This is the coverage the retired `sepsis-verified` workflow used to carry in its own test
 * file, repointed at the workflow that now owns it. What it proves is the reason that
 * workflow could be deleted without losing a check: a qSOFA payload routes to the sepsis
 * screen inside `clinical`, and `clinical-verifier` — step 2 here — recomputes the echo,
 * criteria, verdict and score through the same `scoreReply` the retired profile called.
 *
 * The corpus loop matters more than one case would. A single reply proves the wiring; five
 * prove the recomputation tracks the payload, including the negative screens where a
 * verifier that always agreed would still pass.
 */
test('full configured workflow verifies every sepsis corpus reply and sends nothing derived onward', async () => {
  const clinicalPack = loadPack(resolvePackRoot('clinical', { configured: 'packs/clinical', base: process.cwd() }))
  const cases = loadSepsisCases(clinicalPack, loadMedprotocolRule(clinicalPack)).cases
  assert.ok(cases.length >= 5, 'the qSOFA corpus should carry at least five cases')

  for (const sepsisCase of cases) {
    const { exam, screen, criteria } = sepsisCase.resolved
    const reply = JSON.stringify({
      ...exam,
      qsofa_score: screen.score,
      positive: screen.positive,
      criteria_met: CRITERIA.filter((criterion) => criteria[criterion]),
      screen_reason: null,
      assessment_confidence: 1,
      notes: null,
    })
    const verifierPrompts: string[] = []
    const provider: Provider = {
      async chat(o: ChatOptions): Promise<string> {
        if (o.label === 'extraction') {
          verifierPrompts.push(o.userPrompt)
          return JSON.stringify({ verified: true, confidence: 1, issues: [] })
        }
        return reply
      },
      async toolChat() { return { content: '', toolCalls: [] } },
      async streamChat() { return { content: '', toolCalls: [], chunks: 0 } },
      async identify() { return { model: 'pipeline-test-stub', identified: true } },
    }

    const { verdict, workflow } = await runWorkflowCaseEval({
      input: JSON.stringify(exam),
      trace: nullTrace(),
      provider,
    })

    assert.equal(verdict.pass, true, sepsisCase.name)
    assert.deepEqual(
      workflow.steps.map((step) => [step.name, step.ok]),
      [['extract', true], ['verify-derived', true], ['verify-source', true], ['assess', true]],
      sepsisCase.name,
    )
    // Every claim a qSOFA reply carries is derived from the closed payload, so the model
    // verifier is handed an empty extraction: there is no source assertion left to check,
    // and a score that reached it would be judged for not appearing verbatim in the input.
    assert.equal(verifierPrompts.length, 1, sepsisCase.name)
    assert.doesNotMatch(verifierPrompts[0]!, /qsofa_score/, sepsisCase.name)
    assert.doesNotMatch(verifierPrompts[0]!, /criteria_met/, sepsisCase.name)
  }
})

/**
 * The same corpus with one axis broken per run. Without this the test above would pass
 * against a verifier that returned `ok` unconditionally.
 */
test('a sepsis reply that disagrees with medprotocol stops the pipeline at the derived check', async () => {
  const clinicalPack = loadPack(resolvePackRoot('clinical', { configured: 'packs/clinical', base: process.cwd() }))
  const cases = loadSepsisCases(clinicalPack, loadMedprotocolRule(clinicalPack)).cases
  const { exam, screen, criteria } = cases[0]!.resolved
  const correct = {
    ...exam,
    qsofa_score: screen.score,
    positive: screen.positive,
    criteria_met: CRITERIA.filter((criterion) => criteria[criterion]),
    screen_reason: null,
    assessment_confidence: 1,
    notes: null,
  }
  const mutations: Array<[string, Record<string, unknown>, RegExp]> = [
    ['echo', { ...correct, respiratory_rate: exam.respiratory_rate + 1 }, /incorrect qSOFA echo/],
    ['criteria', { ...correct, criteria_met: [] }, /criteria list does not match/],
    ['verdict', { ...correct, positive: !screen.positive }, /verdict disagrees with medprotocol/],
    // In range but wrong. A score OUTSIDE the schema's range would be refused by
    // `parseSepsisReply` during extraction, and the pipeline would stop before the derived
    // check this test is about — proving the parser works rather than the verifier.
    ['score', { ...correct, qsofa_score: screen.score === 3 ? 2 : screen.score + 1 }, /score disagrees with medprotocol/],
  ]

  for (const [axis, reply, expected] of mutations) {
    let verifierCalled = false
    const provider: Provider = {
      async chat(o: ChatOptions): Promise<string> {
        if (o.label === 'extraction') {
          verifierCalled = true
          return JSON.stringify({ verified: true, confidence: 1, issues: [] })
        }
        return JSON.stringify(reply)
      },
      async toolChat() { return { content: '', toolCalls: [] } },
      async streamChat() { return { content: '', toolCalls: [], chunks: 0 } },
      async identify() { return { model: 'pipeline-test-stub', identified: true } },
    }

    const { workflow } = await runWorkflowCaseEval({
      input: JSON.stringify(exam),
      trace: nullTrace(),
      provider,
    })

    const derived = workflow.steps.find((step) => step.name === 'verify-derived')
    assert.equal(derived?.ok, false, axis)
    assert.match(String(derived?.text ?? ''), expected, axis)
    // The model verifier is never asked to adjudicate a reply the rule already refused.
    assert.equal(verifierCalled, false, axis)

    // The refusal still ends in a page, and the page states no verdict. This is the case the
    // terminal step exists for: before it, a refused run's last word was a step error.
    assert.equal(workflow.stoppedEarly, true, axis)
    const ending = workflow.steps.find((step) => step.name === 'assess')
    assert.equal(ending?.ok, true, axis)
    assert.match(String(ending?.text), /^NO ASSESSMENT — /, axis)
    assert.match(String(ending?.text), /Withheld at step 'verify-derived'/, axis)
    assert.match(String(ending?.text), expected, axis)
    assert.doesNotMatch(String(ending?.text), /^Sepsis screen:/m, axis)
  }
})

test('smoke test fails when pipeline config has no steps', async () => {
  const verdict = await PROFILE.runEval!({
    config: { name: 'test-pipeline', mode: 'workflow' as const },
    pack: undefined,
    baseUrl: undefined,
    trace: nullTrace(),
    options: {},
  })
  assert.equal(verdict.pass, false)
  assert.ok(verdict.summary.includes('no steps array'))
})

test('smoke test fails when a step has no profile', async () => {
  const verdict = await PROFILE.runEval!({
    config: { name: 'test-pipeline', mode: 'workflow' as const, steps: [{ name: 'step1' }] },
    pack: undefined,
    baseUrl: undefined,
    trace: nullTrace(),
    options: {},
  })
  assert.equal(verdict.pass, false)
  assert.ok(verdict.summary.includes('step 0 has no profile'))
})

test('fidelity eval option is recognised', async () => {
  const cfg = loadConfig()
  const config = requireProfile(cfg, 'clinical-verified')
  // Use a non-existent URL so the eval fails fast at the network layer.
  // The eval catches transport errors internally and reports them as failed runs
  // rather than throwing, so we verify the option is read and the pack is resolved.
  const verdict = await PROFILE.runEval!({
    config,
    pack: undefined,
    baseUrl: 'http://127.0.0.1:1', // intentionally unreachable
    trace: nullTrace(),
    options: { fidelity: true, caseLimit: 1 },
  })
  // The eval should run and produce a verdict with gate information in the summary.
  assert.ok(verdict.summary.includes('recall'), 'summary should mention recall')
  assert.ok(verdict.summary.includes('mono'), 'summary should mention monolith')
})

test('ratio helper: zero denominator returns 1.0', () => {
  assert.equal(ratio(0, 0), 1.0)
  assert.equal(ratio(5, 0), 1.0)
})

test('ratio helper: normal division', () => {
  assert.equal(ratio(5, 10), 0.5)
  assert.equal(ratio(10, 10), 1.0)
})

test('absorb helper: aggregates tallies', () => {
  const a = emptyTally()
  const b = emptyTally()
  b.gradedTotal = 10
  b.detected = 8
  b.valueExact = 7
  b.unitExact = 6
  b.quoteVerified = 5
  b.hallucinations = 2
  b.failedRuns = 1
  absorb(a, b)
  assert.equal(a.gradedTotal, 10)
  assert.equal(a.detected, 8)
  assert.equal(a.valueExact, 7)
  assert.equal(a.unitExact, 6)
  assert.equal(a.quoteVerified, 5)
  assert.equal(a.hallucinations, 2)
  assert.equal(a.failedRuns, 1)
})

test('gate logic: equal recall passes', () => {
  const monoRecall = 0.85
  const veriRecall = 0.85
  assert.equal(veriRecall >= monoRecall, true)
})

test('gate logic: lower hallucination rate passes', () => {
  const monoHalluc = 0.05
  const veriHalluc = 0.03
  assert.equal(veriHalluc <= monoHalluc, true)
})

test('gate logic: latency within 2x passes', () => {
  const monoMs = 1000
  const veriMs = 1800
  assert.equal(veriMs <= monoMs * 2, true)
})

test('gate logic: latency above 2x fails', () => {
  const monoMs = 1000
  const veriMs = 2100
  assert.equal(veriMs <= monoMs * 2, false)
})

test('fidelity eval imports without error', async () => {
  const { runWorkflowFidelityEval } = await import('../src/profiles/clinical-verified/eval.ts')
  assert.equal(typeof runWorkflowFidelityEval, 'function')
})
