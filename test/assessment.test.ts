/**
 * The ending, as a unit: what it states, what it refuses to state, and what it never invents.
 *
 * No model and no workflow. The renderer is a pure function of a run structure, which is the
 * property that makes these tests worth writing at all — every assertion below is about bytes
 * that are fully determined by the fixture above it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  claimLines,
  composeAssessment,
  renderAssessment,
  type RunView,
} from '../src/profiles/clinical-assessment/assessment.ts'
import { PROFILE } from '../src/profiles/clinical-assessment/profile.ts'
import { nullTrace } from '../src/core/trace.ts'

const SHOCK_REPLY = {
  skin_temperature: 'cool',
  jugular_venous_pressure: 'elevated',
  shock_category: 'cardiogenic',
  supporting_findings: ['lung_exam'],
  discordant_findings: ['capillary_refill'],
  indeterminate_reason: null,
  assessment_confidence: 0.95,
  notes: null,
}

const EXAM = {
  hypotension: { systolic: 68, diastolic: 50, duration_minutes: 200 },
  heart_rate: 115,
  skin_temperature: 'cool',
  jugular_venous_pressure: 'elevated',
  capillary_refill: 'brisk',
  pulse_volume: 'thready',
  lung_exam: 'bilateral_crackles',
}

const SEPSIS_REPLY = {
  respiratory_rate: 24,
  systolic_bp: 95,
  gcs: 15,
  qsofa_score: 2,
  positive: true,
  criteria_met: ['respiratory_rate', 'systolic_bp'],
  screen_reason: 'two criteria met',
  assessment_confidence: 0.9,
  notes: null,
}

const run = (o: {
  routes: string[]
  results: Record<string, unknown>
  stoppedEarly?: boolean
  steps?: RunView['steps']
  initialInput?: string
}): RunView => ({
  initialInput: o.initialInput ?? 'a clinical note',
  stoppedEarly: o.stoppedEarly ?? false,
  steps: o.steps ?? [
    { step: 0, name: 'extract', profile: 'clinical', ok: true, output: { routes: o.routes, results: o.results } },
    { step: 1, name: 'verify-derived', profile: 'clinical-verifier', ok: true },
    { step: 2, name: 'verify-source', profile: 'verifier', ok: true, report: { verified: true, issues: [] } },
  ],
})

const shockRun = (overrides: Record<string, unknown> = {}): RunView =>
  run({
    initialInput: JSON.stringify(EXAM),
    routes: ['shock-extraction', 'shock'],
    results: {
      'shock-extraction': { ok: true, output: { exam: EXAM } },
      shock: { ok: true, output: { ...SHOCK_REPLY, ...overrides } },
    },
  })

test('the ending states the category, its citations, and where the numbers came from', () => {
  const page = renderAssessment(composeAssessment(shockRun(), { name: 'clinical', spec: 3, medprotocol: '0.7.10' }))

  assert.match(page, /^ASSESSMENT — supplied input/)
  assert.match(page, /Shock: cardiogenic/)
  assert.match(page, /echo: skin cool · JVP elevated/)
  assert.match(page, /supporting: lung_exam/)
  assert.match(page, /discordant: capillary_refill/)
  assert.match(page, /Verification: derived passed · source passed \(0 issues\)/)
  assert.match(page, /pack clinical spec 3 · medprotocol 0\.7\.10/)
  assert.match(page, /Not a diagnosis and not a medical device/)
})

test('a model confidence is printed as self-reported, never as a measurement', () => {
  const page = renderAssessment(composeAssessment(shockRun()))
  assert.match(page, /model confidence: 0\.95 \(self-reported, not measured\)/)
})

test('model prose is quoted verbatim and never merged into a sentence of ours', () => {
  const page = renderAssessment(
    composeAssessment(
      shockRun({ shock_category: 'indeterminate', indeterminate_reason: 'the patient is outside the studied cohort' }),
    ),
  )
  assert.match(page, /Shock: indeterminate/)
  assert.match(page, /^ {2}"the patient is outside the studied cohort"$/m)
})

test('findings nobody assessed are named rather than left out', () => {
  const page = renderAssessment(
    composeAssessment(
      run({
        initialInput: JSON.stringify(EXAM),
        routes: ['shock-extraction', 'shock'],
        results: {
          'shock-extraction': { ok: true, output: { exam: { ...EXAM, lung_exam: 'not_assessed', pulse_volume: 'not_assessed' } } },
          shock: { ok: true, output: SHOCK_REPLY },
        },
      }),
    ),
  )
  // The difference between "the lungs were clear" and "nobody listened" is the whole point.
  assert.match(page, /Not assessed: pulse_volume, lung_exam|Not assessed: lung_exam, pulse_volume/)
})

test('a qSOFA screen states the score and the verdict', () => {
  const page = renderAssessment(
    composeAssessment(run({ routes: ['sepsis'], results: { sepsis: { ok: true, output: SEPSIS_REPLY } } })),
  )
  assert.match(page, /Sepsis screen: qSOFA 2 — POSITIVE/)
  assert.match(page, /echo: RR 24 · SBP 95 · GCS 15/)
  assert.match(page, /criteria: respiratory_rate, systolic_bp/)
  assert.match(page, /^ {2}"two criteria met"$/m)
})

test('both syndromes appear when one document raised both', () => {
  const page = renderAssessment(
    composeAssessment(
      run({
        initialInput: JSON.stringify(EXAM),
        routes: ['shock-extraction', 'shock', 'sepsis'],
        results: {
          'shock-extraction': { ok: true, output: { exam: EXAM } },
          shock: { ok: true, output: SHOCK_REPLY },
          sepsis: { ok: true, output: SEPSIS_REPLY },
        },
      }),
    ),
  )
  assert.match(page, /Shock: cardiogenic/)
  assert.match(page, /Sepsis screen: qSOFA 2 — POSITIVE/)
})

test('a refused run states no verdict, names the step that refused, and gives its reason', () => {
  const refused = run({
    initialInput: JSON.stringify(EXAM),
    routes: ['shock'],
    results: { shock: { ok: true, output: SHOCK_REPLY } },
    stoppedEarly: true,
    steps: [
      { step: 0, name: 'extract', profile: 'clinical', ok: true, output: { routes: ['shock'], results: { shock: { ok: true, output: SHOCK_REPLY } } } },
      { step: 1, name: 'verify-derived', profile: 'clinical-verifier', ok: false, error: 'results.shock.output.shock_category: expected hypovolemic' },
    ],
  })
  const assessment = composeAssessment(refused)
  const page = renderAssessment(assessment)

  assert.equal(assessment.status, 'withheld')
  assert.equal(assessment.syndromes.length, 0)
  assert.match(page, /^NO ASSESSMENT — /)
  assert.match(page, /Withheld at step 'verify-derived' \(clinical-verifier\)/)
  assert.match(page, /expected hypovolemic/)
  // The category the model DID produce must not leak through. A verdict printed beside its
  // own refusal is worse than no page at all: a reader takes the verdict and not the caveat.
  assert.doesNotMatch(page, /Shock: cardiogenic/)
  assert.match(page, /Not a diagnosis and not a medical device/)
})

test('the first step to refuse is the one named, not the last', () => {
  const assessment = composeAssessment(
    run({
      routes: [],
      results: {},
      stoppedEarly: true,
      steps: [
        { step: 0, name: 'extract', profile: 'clinical', ok: false, error: 'the extraction never parsed' },
        { step: 1, name: 'verify-derived', profile: 'clinical-verifier', ok: false, error: 'nothing to verify' },
      ],
    }),
  )
  assert.equal(assessment.withheld?.step, 'extract')
})

test('source-verification issues are listed with the field each is about', () => {
  const page = renderAssessment(
    composeAssessment(
      run({
        initialInput: JSON.stringify(EXAM),
        routes: ['shock'],
        results: { shock: { ok: true, output: SHOCK_REPLY } },
        steps: [
          { step: 0, name: 'extract', profile: 'clinical', ok: true, output: { routes: ['shock'], results: { shock: { ok: true, output: SHOCK_REPLY } } } },
          { step: 1, name: 'verify-derived', profile: 'clinical-verifier', ok: true },
          {
            step: 2,
            name: 'verify-source',
            profile: 'verifier',
            ok: true,
            report: { verified: true, issues: [{ field: 'heart_rate', issue: 'quote is abbreviated', severity: 'minor' }] },
          },
        ],
      }),
    ),
  )
  assert.match(page, /Verification: derived passed · source passed \(1 issue\)/)
  assert.match(page, /heart_rate: quote is abbreviated \(minor\)/)
})

test('a check that never ran says so rather than reporting a pass', () => {
  const assessment = composeAssessment(
    run({
      routes: ['shock'],
      results: { shock: { ok: true, output: SHOCK_REPLY } },
      steps: [{ step: 0, name: 'extract', profile: 'clinical', ok: true, output: { routes: ['shock'], results: { shock: { ok: true, output: SHOCK_REPLY } } } }],
    }),
  )
  assert.equal(assessment.verification.derived, 'not-run')
  assert.equal(assessment.verification.source, 'not-run')
  assert.match(renderAssessment(assessment), /derived not-run · source not-run/)
})

test('a run that answers no clinical question says so instead of assembling one', () => {
  const assessment = composeAssessment(
    run({ routes: ['transcript'], results: { transcript: { ok: true, output: { turns: [] } } } }),
  )
  assert.equal(assessment.status, 'no-verdict')
  const page = renderAssessment(assessment)
  assert.match(page, /No syndrome verdict/)
  assert.match(page, /transcript: ran, states no syndrome verdict/)
  assert.doesNotMatch(page, /^Shock: /m)
})

test('a reply that does not parse is reported as unreadable, never rendered as a guess', () => {
  const assessment = composeAssessment(
    run({ routes: ['shock'], results: { shock: { ok: true, output: { shock_category: 'kind of septic' } } } }),
  )
  assert.equal(assessment.status, 'no-verdict')
  assert.equal(assessment.syndromes.length, 0)
  // The parser's own refusal is carried through verbatim — whichever field it rejected first.
  assert.match(renderAssessment(assessment), /unreadable — shock: \w+ was /)
})

test('a single-task route hands over a bare completion, and it still reads', () => {
  const assessment = composeAssessment(
    run({
      routes: [],
      results: {},
      initialInput: JSON.stringify(EXAM),
      steps: [{ step: 0, name: 'extract', profile: 'clinical', ok: true, output: JSON.stringify(SHOCK_REPLY) }],
    }),
  )
  assert.equal(assessment.status, 'assessed')
  assert.equal(assessment.syndromes[0]?.headline.text, 'Shock: cardiogenic')
  // No extraction route ran, so the payload is the input — and the citation says so.
  assert.ok(claimLines(assessment).every((line) => line.field.startsWith('results.') || line.field.startsWith('initial.')))
})

test('every printed claim carries the field it came from', () => {
  const assessment = composeAssessment(shockRun())
  const lines = claimLines(assessment)
  assert.ok(lines.length > 0)
  for (const line of lines) {
    assert.ok(line.field.length > 0, `'${line.text}' cites nothing`)
    assert.ok(line.text.length > 0)
  }
})

test('the same run renders to the same bytes', () => {
  const a = renderAssessment(composeAssessment(shockRun(), { name: 'clinical', spec: 3 }))
  const b = renderAssessment(composeAssessment(shockRun(), { name: 'clinical', spec: 3 }))
  assert.equal(a, b)
})

test('the profile refuses anything that is not the workflow run value', async () => {
  const ctx = { pack: undefined, trace: nullTrace(), options: {}, input: { kind: 'text', text: 'just some prose' } } as const
  const result = await PROFILE.review!(ctx as never)
  assert.equal(result.ok, false)
  assert.match(result.text, /expects the workflow's `run` value/)
})

test('the profile renders the run it is handed', async () => {
  const result = await PROFILE.review!({
    pack: undefined,
    trace: nullTrace(),
    options: {},
    input: { kind: 'text', text: JSON.stringify(shockRun()), label: 'workflow-step' },
  } as never)
  assert.equal(result.ok, true)
  assert.match(result.text, /Shock: cardiogenic/)
  assert.equal((result.report as { status: string }).status, 'assessed')
})
