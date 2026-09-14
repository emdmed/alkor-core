import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { loadPack } from '../src/core/pack.ts'
import { nullTrace } from '../src/core/trace.ts'
import { PROFILE } from '../src/profiles/clinical-verifier/profile.ts'
import type { SepsisReply } from '../src/profiles/clinical/sepsis.ts'

process.env.MEDPROTOCOL_BIN = join(import.meta.dirname, 'fixtures', 'medprotocol.js')

const pack = loadPack(join(import.meta.dirname, '..', 'packs', 'clinical'))
const document = pack.document('sh-02-cardiogenic-classic')

const extraction = (category = 'cardiogenic') => ({
  routes: ['shock-extraction', 'shock'],
  results: {
    'shock-extraction': {
      ok: true,
      output: {
        exam: {
          hypotension: { systolic: 68, diastolic: 50, duration_minutes: 200 },
          heart_rate: 115,
          skin_temperature: 'cool',
          jugular_venous_pressure: 'elevated',
          capillary_refill: 'brisk',
          pulse_volume: 'thready',
          lung_exam: 'bilateral_crackles',
        },
        confirmation: { confirmed: true, systolic: 68, shockIndex: Math.round((115 / 68) * 100) / 100 },
      },
    },
    shock: {
      ok: true,
      output: {
        skin_temperature: 'cool',
        jugular_venous_pressure: 'elevated',
        shock_category: category,
        supporting_findings: ['lung_exam'],
        discordant_findings: ['capillary_refill'],
        indeterminate_reason: null,
        assessment_confidence: 0.95,
        notes: null,
      },
    },
  },
})

const review = (value: unknown) => PROFILE.review!({
  pack,
  trace: nullTrace(),
  input: { kind: 'text', text: JSON.stringify({ document, extraction: value }) },
  options: {},
})

/** Review with an explicit document, for the non-composite sepsis shapes. */
const reviewWith = (doc: string, extraction: unknown) => PROFILE.review!({
  pack,
  trace: nullTrace(),
  input: { kind: 'text', text: JSON.stringify({ document: doc, extraction }) },
  options: {},
})

test('clinical verifier checks derivations and emits source observations only', async () => {
  const result = await review(extraction())
  assert.equal(result.ok, true)
  assert.deepEqual(result.report, {
    document,
    extraction: {
      'shock-extraction': {
        exam: extraction().results['shock-extraction'].output.exam,
      },
    },
  })
  assert.doesNotMatch(JSON.stringify(result.report), /shockIndex|shock_category|discordant_findings/)
})

/**
 * A note that records a blood pressure but never says how long it has been low. The extraction
 * contract answers that with 0, and the model verifier downstream reads absence only in `null` —
 * so the sentinel is translated here rather than handed on as a claim of "zero minutes". The
 * DERIVED half still sees the real 0: the cohort gate must fail on an unstated duration.
 */
test('the extraction contract\'s numeric sentinels reach the source verifier as null', async () => {
  const value = extraction()
  const exam = value.results['shock-extraction'].output.exam
  exam.hypotension.duration_minutes = 0
  exam.heart_rate = 0
  value.results['shock-extraction'].output.confirmation = { confirmed: true, systolic: 68, shockIndex: 0 }
  // Outside the cohort on the duration, so the deterministic rule's category moves with it.
  const shock = value.results.shock.output as Record<string, unknown>
  shock.shock_category = 'indeterminate'
  shock.indeterminate_reason = 'the duration is not stated'
  shock.supporting_findings = []
  shock.discordant_findings = []

  const result = await review(value)
  assert.equal(result.ok, true)
  const sent = (result.report as { extraction: Record<string, { exam: Record<string, unknown> }> }).extraction
  const sentExam = sent['shock-extraction']!.exam
  assert.equal((sentExam.hypotension as { duration_minutes: unknown }).duration_minutes, null)
  assert.equal(sentExam.heart_rate, null)
  // A real reading is never rewritten.
  assert.equal((sentExam.hypotension as { systolic: unknown }).systolic, 68)
})

test('clinical verifier rejects a classification that disagrees with the deterministic rule', async () => {
  const result = await review(extraction('septic'))
  assert.equal(result.ok, false)
  assert.match(result.text, /shock_category: expected cardiogenic/)
})

test('clinical verifier rejects a wrong deterministic confirmation', async () => {
  const value = extraction()
  value.results['shock-extraction'].output.confirmation.shockIndex = 0.5
  const result = await review(value)
  assert.equal(result.ok, false)
  assert.match(result.text, /does not match deterministic confirmation/)
})

// --- Routed sepsis: deterministic qSOFA verification -----------------------------------------

/** The qSOFA payload a routed sepsis request starts from (sp-01: all three criteria met). */
const sepsisDocument = pack.document('sp-01-three-meet', 'exam')

/** A correct sepsis reply for that payload, overridden per test. */
const sepsisReply = (over: Partial<SepsisReply> = {}): SepsisReply => ({
  respiratory_rate: 24,
  systolic_bp: 88,
  gcs: 12,
  qsofa_score: 3,
  positive: true,
  criteria_met: ['respiratory_rate', 'systolic_bp', 'altered_mental_status'],
  screen_reason: 'all three criteria',
  assessment_confidence: 0.9,
  notes: null,
  ...over,
})

/** A composite extraction carrying a routed sepsis result, the multi-task shape. */
const sepsisExtraction = (reply: SepsisReply) => ({
  routes: ['sepsis'],
  results: {
    sepsis: { ok: true, output: reply },
  },
})

/** Review a routed-sepsis composite against the qSOFA document. */
const reviewSepsis = (reply: SepsisReply) => reviewWith(sepsisDocument, sepsisExtraction(reply))

/**
 * The `{routes, results}` composite shape: a routed sepsis result is verified down each axis
 * and nothing derived is handed to the generic verifier. This is the shape a combined
 * shock+qSOFA payload produces, and the plan's five failure axes are all accused separately.
 */
test('routed sepsis with a correct completion verifies, and the generic verifier gets nothing derived', async () => {
  const result = await reviewSepsis(sepsisReply())
  assert.equal(result.ok, true)
  const r = result.report as Record<string, unknown>
  assert.equal(r.document, sepsisDocument)
  assert.deepEqual(r.extraction, { sepsis: {} })
  // The derived claims — the computed score, the cited criteria, the verdict — are removed, not
  // handed to the model verifier as if they appeared in the source. (The payload echo spends the
  // qSOFA numbers as SOURCE, so those legitimately remain inside `document`.)
  assert.doesNotMatch(JSON.stringify(r.extraction), /qsofa_score|criteria_met|assessment_confidence/)
})

test('routed sepsis failures are separate accusations on each axis', async () => {
  const cases: Array<[string, SepsisReply, RegExp]> = [
    ['echo', sepsisReply({ respiratory_rate: 23 }), /incorrect qSOFA echo/],
    ['criteria', sepsisReply({ criteria_met: ['respiratory_rate'] }), /criteria list does not match/],
    ['verdict', sepsisReply({ positive: false }), /verdict disagrees with medprotocol/],
    ['score', sepsisReply({ qsofa_score: 2 }), /score disagrees with medprotocol/],
    [
      'duplicate',
      sepsisReply({
        criteria_met: ['respiratory_rate', 'respiratory_rate', 'systolic_bp', 'altered_mental_status'],
      }),
      /more than once/,
    ],
  ]
  for (const [axis, reply, pattern] of cases) {
    const result = await reviewSepsis(reply)
    assert.equal(result.ok, false, `${axis} should fail`)
    assert.match(result.text, pattern, `${axis} should name its own cause`)
  }
})

/**
 * The bare single-task shape: a pure qSOFA input routes to sepsis alone, so `step-0.output`
 * is the raw completion with no `routes`/`results` wrapper. The initial input's qSOFA shape is
 * what identifies it, and once verified there is nothing left for the source verifier.
 */
test('a raw single-task sepsis completion is verified against the qSOFA document', async () => {
  const good = await reviewWith(sepsisDocument, JSON.stringify(sepsisReply()))
  assert.equal(good.ok, true)
  const gr = good.report as Record<string, unknown>
  assert.deepEqual(gr.extraction, {}, 'nothing source-shaped survives a qSOFA payload')
  assert.doesNotMatch(JSON.stringify(gr), /qsofa_score|criteria_met/)

  const wrong = await reviewWith(sepsisDocument, JSON.stringify(sepsisReply({ positive: false })))
  assert.equal(wrong.ok, false)
  assert.match(wrong.text, /verdict disagrees with medprotocol/)

  const fenced = await reviewWith(sepsisDocument, '```json\n{"positive":true}\n```')
  assert.equal(fenced.ok, false)
  assert.match(fenced.text, /markdown code fence/)
})

/**
 * A source-shaped document (a note, or a shock exam) must NOT be mistaken for sepsis: the
 * qSOFA discriminator is that the initial input parses as a payload, and a note never does.
 */
test('a non-sepsis document is preserved for the generic verifier, unchanged', async () => {
  const result = await reviewWith(document, { bones: ['break'] })
  assert.equal(result.ok, true)
  const rr = result.report as Record<string, unknown>
  assert.deepEqual(rr, { document, extraction: { bones: ['break'] } })
})

// --- The PROSE sepsis arm: the payload is a model output, not the input ----------------------

/**
 * A septic-shock note: one document raising both clinical questions, which since the router
 * learned to return a union is a single four-route plan rather than two runs.
 *
 * The note is prose, so neither payload is the document — `shock-extraction` produces one and
 * `sepsis-extraction` the other. That is the case this adapter used to get wrong: it looked
 * for the qSOFA payload in the INITIAL INPUT, found a note, and reported that a sepsis route
 * had been claimed without one. Every prose note reaching the sepsis screen failed derived
 * verification with an accusation about the router rather than about the model.
 */
const septicShockNote =
  '68-year-old woman, 3 days of fever and productive cough, treated for pneumonia. ' +
  'Hypotensive for 2 hours, BP 82/44. Heart rate 124 bpm. Respiratory rate 26. Confused, GCS 13. ' +
  'Warm peripheries, brisk capillary refill, jugular venous pressure normal to low. Bounding pulse. ' +
  'Lung examination not performed.'

const bothArms = () => ({
  routes: ['shock-extraction', 'shock', 'sepsis-extraction', 'sepsis'],
  results: {
    'shock-extraction': {
      ok: true,
      output: {
        exam: {
          hypotension: { systolic: 82, diastolic: 44, duration_minutes: 120 },
          heart_rate: 124,
          skin_temperature: 'warm',
          jugular_venous_pressure: 'normal_or_low',
          capillary_refill: 'brisk',
          pulse_volume: 'bounding',
          lung_exam: 'not_assessed',
        },
        confirmation: { confirmed: true, systolic: 82, shockIndex: Math.round((124 / 82) * 100) / 100 },
      },
    },
    shock: {
      ok: true,
      output: {
        skin_temperature: 'warm',
        jugular_venous_pressure: 'normal_or_low',
        shock_category: 'septic',
        supporting_findings: ['capillary_refill', 'pulse_volume'],
        discordant_findings: [],
        indeterminate_reason: null,
        assessment_confidence: 0.9,
        notes: null,
      },
    },
    'sepsis-extraction': {
      ok: true,
      output: {
        exam: { respiratory_rate: 26, systolic_bp: 82, gcs: 13 },
        screen: { positive: true, score: 3 },
      },
    },
    sepsis: {
      ok: true,
      output: {
        respiratory_rate: 26,
        systolic_bp: 82,
        gcs: 13,
        qsofa_score: 3,
        positive: true,
        criteria_met: ['respiratory_rate', 'systolic_bp', 'altered_mental_status'],
        screen_reason: null,
        assessment_confidence: 0.95,
        notes: null,
      },
    },
  },
})

test('a prose note routed to both arms verifies against the EXTRACTED qSOFA payload, not the note', async () => {
  const result = await reviewWith(septicShockNote, bothArms())
  assert.equal(result.ok, true, result.text)
  const report = result.report as Record<string, any>
  // The three qSOFA numbers are assertions about the prose and go on to the model verifier;
  // the screen beside them is arithmetic and is settled here — the same split the shock arm
  // makes between its exam and its confirmation.
  assert.deepEqual(report.extraction['sepsis-extraction'], {
    exam: { respiratory_rate: 26, systolic_bp: 82, gcs: 13 },
  })
  assert.deepEqual(report.extraction.sepsis, {})
  assert.equal(report.extraction.shock, undefined)
})

test('the extracted qSOFA screen is recomputed, not taken on trust', async () => {
  const bent = bothArms()
  bent.results['sepsis-extraction'].output.screen = { positive: false, score: 1 }
  const result = await reviewWith(septicShockNote, bent)
  assert.equal(result.ok, false)
  assert.match(result.text, /sepsis-extraction.output.screen.*deterministic qSOFA screen/)
})

test('each arm of a both-arms plan is refused on its own axis', async () => {
  const bends: Array<[string, (plan: ReturnType<typeof bothArms>) => void, RegExp]> = [
    ['sepsis verdict', (p) => { p.results.sepsis.output.positive = false }, /verdict disagrees with medprotocol/],
    ['sepsis score', (p) => { p.results.sepsis.output.qsofa_score = 2 }, /score disagrees with medprotocol/],
    ['sepsis echo', (p) => { p.results.sepsis.output.respiratory_rate = 20 }, /incorrect qSOFA echo/],
    ['shock category', (p) => { p.results.shock.output.shock_category = 'cardiogenic' }, /expected septic/],
    ['shock confirmation', (p) => { p.results['shock-extraction'].output.confirmation.confirmed = false }, /deterministic confirmation/],
  ]
  for (const [axis, bend, expected] of bends) {
    const plan = bothArms()
    bend(plan)
    const result = await reviewWith(septicShockNote, plan)
    assert.equal(result.ok, false, axis)
    assert.match(result.text, expected, axis)
  }
})

/**
 * Ordering must not be load-bearing. The router returns routes in TASK_ORDER, which happens to
 * put `sepsis-extraction` before `sepsis`, and a verifier that captured the payload mid-loop
 * would pass for that reason rather than because it is correct.
 */
test('a sepsis route verified before its extraction route still finds the payload', async () => {
  const plan = bothArms()
  plan.routes = ['sepsis', 'sepsis-extraction', 'shock', 'shock-extraction']
  const result = await reviewWith(septicShockNote, plan)
  assert.equal(result.ok, true, result.text)
})

test('a sepsis route with no payload anywhere is still refused', async () => {
  const plan = bothArms()
  plan.routes = ['sepsis']
  const result = await reviewWith(septicShockNote, plan)
  assert.equal(result.ok, false)
  assert.match(result.text, /no qSOFA payload/)
})

/**
 * `indeterminate_reason` is graded on PRESENCE, not on wording, and these two tests pin both
 * directions of the pairing `prompts/shock.md` states: indeterminate is answered with a reason,
 * anything else with null.
 *
 * The check used to be `reply.indeterminate_reason !== truth.reason` — a string equality between
 * the model's sentence and one of the rule's three closed tokens. `shock.schema.json` types the
 * field free text and records that it is "NOT graded automatically"; every worked example in the
 * prompt fills it with a sentence. So the old check could only pass if the model ignored its own
 * prompt and emitted `outside_studied_cohort` verbatim, and a real septic-shock note that
 * correctly declined to categorise failed verification for having explained why.
 */
test('a declining answer verifies on the presence of a reason, not its wording', async () => {
  const plan = extraction('indeterminate')
  const exam = plan.results['shock-extraction'].output.exam as Record<string, unknown>
  // Cool skin with an unassessable JVP is the square the published table leaves empty.
  exam.jugular_venous_pressure = 'not_assessed'
  const shock = plan.results.shock.output as Record<string, unknown>
  shock.jugular_venous_pressure = 'not_assessed'
  shock.shock_category = 'indeterminate'
  shock.supporting_findings = []
  shock.discordant_findings = []
  shock.indeterminate_reason =
    'Step 2: the jugular venous pressure was not assessable, and it is the finding that separates ' +
    'cardiogenic from hypovolemic shock in a cool patient.'

  const result = await review(plan)
  assert.doesNotMatch(result.text, /indeterminate_reason/, result.text)
})

test('a reason attached to a decided category is still an accusation', async () => {
  const plan = extraction('cardiogenic')
  const shock = plan.results.shock.output as Record<string, unknown>
  shock.indeterminate_reason = 'The neck veins were hard to see.'

  const result = await review(plan)
  assert.equal(result.ok, false)
  assert.match(result.text, /a reason was given for a category that is not indeterminate/)
})

/*
 * The GCS provenance flag has to SURVIVE this projection.
 *
 * This is the step that dropped it. The flag is a sibling of `exam` on the extraction's output,
 * and this adapter rebuilt `exam` alone — so the source verifier was handed a bare `gcs: 15` on
 * a note that never mentions mental state and correctly called it a fabricated positive
 * assertion. Being `critical`, that withheld the assessment on a run that had agreed with the
 * rule on every other count.
 *
 * The verifier is asked to judge the PAIR (packs/verifier/prompt.md rule 3, Example 6b), so the
 * pair must arrive and must be adjacent.
 */
test('an assumed GCS keeps its provenance flag on the way to the source verifier', async () => {
  const plan = bothArms()
  plan.results['sepsis-extraction'].output = {
    exam: { respiratory_rate: 26, systolic_bp: 82, gcs: 15 },
    screen: { positive: true, score: 2 },
    gcs_documented: false,
  }
  plan.results.sepsis.output = {
    respiratory_rate: 26,
    systolic_bp: 82,
    gcs: 15,
    qsofa_score: 2,
    positive: true,
    criteria_met: ['respiratory_rate', 'systolic_bp'],
    screen_reason: null,
    assessment_confidence: 0.95,
    notes: null,
  }
  const result = await reviewWith(septicShockNote, plan)
  assert.equal(result.ok, true, result.text)
  const report = result.report as Record<string, any>
  // Inside the exam, beside the number it qualifies — not a sibling, and not dropped.
  assert.deepEqual(report.extraction['sepsis-extraction'], {
    exam: { respiratory_rate: 26, systolic_bp: 82, gcs: 15, gcs_documented: false },
  })
})

test('a documented GCS is forwarded as documented', async () => {
  const plan = bothArms()
  plan.results['sepsis-extraction'].output = {
    exam: { respiratory_rate: 26, systolic_bp: 82, gcs: 13 },
    screen: { positive: true, score: 3 },
    gcs_documented: true,
  }
  const result = await reviewWith(septicShockNote, plan)
  assert.equal(result.ok, true, result.text)
  const report = result.report as Record<string, any>
  assert.deepEqual(report.extraction['sepsis-extraction'], {
    exam: { respiratory_rate: 26, systolic_bp: 82, gcs: 13, gcs_documented: true },
  })
})
