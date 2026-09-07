/**
 * The shock contract: the rule, the payloads, the answer key and the scorer.
 *
 * Nothing here talks to a model. This contract's reference arm is code, so the parts worth
 * testing are the parts a run would otherwise report a number about without anyone noticing:
 * a threshold reimplemented as `>=`, a corpus that never exercises abstention, an answer key
 * that has drifted from the rule it restates, and a scorer that credits a category reached
 * from findings the payload does not contain.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPack } from '../src/core/pack.ts'
import { openTrace } from '../src/core/trace.ts'
import { clinicalRedactor } from '../src/profiles/clinical/redact.ts'
import { loadSampling } from '../src/profiles/clinical/settings.ts'
import { gatePasses } from '../src/profiles/clinical/set-eval.ts'
import { PROFILE } from '../src/profiles/clinical/profile.ts'
import { ProfileError } from '../src/core/profile.ts'
import { runShockEval } from '../src/profiles/clinical/shock-eval.ts'
import {
  CONTRACTS,
  TASKS,
  buildRequest,
  hasContract,
} from '../src/profiles/clinical/contracts.ts'
import {
  FINDING_NAMES,
  SHOCK_CATEGORIES,
  classify,
  concordance,
  gate,
  loadShockCases,
  loadShockRule,
  parseExam,
  parseShockReply,
  renderExam,
  resolveExam,
  resolveJvp,
  scoreReply,
  totals,
  type ShockCase,
  type ShockExam,
  type ShockReply,
} from '../src/profiles/clinical/shock.ts'
import { checkMedprotocolVersion, evaluateVitals, loadMedprotocolRule } from '../src/profiles/clinical/medprotocol.ts'

const pack = loadPack(join(import.meta.dirname, '..', 'packs', 'clinical'))
const rule = loadShockRule(pack)
const mp = loadMedprotocolRule(pack)
const cases = loadShockCases(pack, mp)

/** A payload in the rule's cohort, overridden per test. Shock unless a field says otherwise. */
const exam = (over: Partial<ShockExam> = {}): ShockExam => ({
  hypotension: { systolic: 80, diastolic: 52, duration_minutes: 60 },
  heart_rate: 118,
  skin_temperature: 'cool',
  jugular_venous_pressure: 'normal_or_low',
  capillary_refill: 'delayed',
  pulse_volume: 'thready',
  lung_exam: 'clear',
  ...over,
})

/**
 * A payload resolved through medprotocol, which is the only form `classify` accepts.
 *
 * These tests exercise the REAL CLI rather than a stub. That is deliberate: the whole point of
 * the change is that one tool decides every number for both the eval and the product, and a
 * stub here would be a second implementation of exactly the thing being delegated — the class of
 * bug this contract already paid for once.
 */
const resolved = (over: Partial<ShockExam> = {}) => resolveExam(exam(over), rule, mp)

// --- The rule ------------------------------------------------------------------------------

test('the 2x2 is the published one, all four cells', () => {
  const cell = (skin: 'warm' | 'cool', jvp: 'elevated' | 'normal_or_low') =>
    classify(resolved({ skin_temperature: skin, jugular_venous_pressure: jvp }))

  assert.deepEqual(cell('warm', 'normal_or_low'), { category: 'septic', reason: null })
  assert.deepEqual(cell('cool', 'elevated'), { category: 'cardiogenic', reason: null })
  assert.deepEqual(cell('cool', 'normal_or_low'), { category: 'hypovolemic', reason: null })
  // The paper assigns three cells and is silent on the fourth. Silence is not a default to the
  // nearest neighbour: it is the answer, and it has to survive as one.
  assert.deepEqual(cell('warm', 'elevated'), {
    category: 'indeterminate',
    reason: 'discordant_primary_findings',
  })
})

/**
 * The precondition is a RULE and not a preamble.
 *
 * Both halves, because they fail differently: a normotensive patient is caught by the number a
 * reader checks first, and a ten-minute dip passes that number and is disqualified on the next
 * line. The corpus has a case for each (sh-06, sh-07) and this pins the rule they grade against.
 */
test('a patient outside the studied cohort gets no category, however textbook the findings', () => {
  const septicPattern = { skin_temperature: 'warm', jugular_venous_pressure: 'normal_or_low' } as const

  assert.deepEqual(classify(resolved({ ...septicPattern, hypotension: { systolic: 104, diastolic: 55, duration_minutes: 90 } })), {
    category: 'indeterminate',
    reason: 'outside_studied_cohort',
  })
  assert.deepEqual(classify(resolved({ ...septicPattern, hypotension: { systolic: 78, diastolic: 55, duration_minutes: 10 } })), {
    category: 'indeterminate',
    reason: 'outside_studied_cohort',
  })
  // And the boundaries themselves, in the direction the study drew them: below 90, and MORE
  // than 30 minutes.
  assert.equal(classify(resolved({ ...septicPattern, hypotension: { systolic: 90, diastolic: 55, duration_minutes: 90 } })).category, 'indeterminate')
  assert.equal(classify(resolved({ ...septicPattern, hypotension: { systolic: 89, diastolic: 55, duration_minutes: 30 } })).category, 'septic')
})

test('either primary finding unassessable is indeterminate, not a guess from the other', () => {
  for (const over of [{ skin_temperature: 'not_assessed' }, { jugular_venous_pressure: 'not_assessed' }] as const) {
    assert.deepEqual(classify(resolved(over)), {
      category: 'indeterminate',
      reason: 'primary_finding_not_assessed',
    })
  }
})

/**
 * The three corroborating findings do not vote, in either direction.
 *
 * This is the contract's central claim and the one that would be easiest to erode by accident:
 * every permutation of the other three findings must leave the category exactly where skin
 * temperature and jugular venous pressure put it. The paper measured crackles and found them
 * WORSE than the jugular venous pressure for cardiogenic shock, so a tie broken by them is not
 * a clinical override — it is the arm the study rejected.
 */
test('no combination of the three secondary findings moves the category', () => {
  for (const skin of ['warm', 'cool'] as const) {
    for (const jvp of ['elevated', 'normal_or_low'] as const) {
      const base = classify(resolved({ skin_temperature: skin, jugular_venous_pressure: jvp }))
      for (const capillary_refill of ['brisk', 'delayed', 'not_assessed'] as const) {
        for (const pulse_volume of ['bounding', 'normal', 'thready', 'not_assessed'] as const) {
          for (const lung_exam of ['clear', 'bilateral_crackles', 'not_assessed'] as const) {
            const got = classify(
              resolved({ skin_temperature: skin, jugular_venous_pressure: jvp, capillary_refill, pulse_volume, lung_exam }),
            )
            assert.deepEqual(got, base, `${skin}/${jvp} moved by ${capillary_refill}/${pulse_volume}/${lung_exam}`)
          }
        }
      }
    }
  }
})

/**
 * The threshold is the pack's, and it is strictly ABOVE.
 *
 * 7 cmH2O is the study's cut and 7 itself is normal_or_low. The corpus pins this at
 * sh-13-jvp-at-threshold because it is the difference between a cool patient being called
 * hypovolemic and being called cardiogenic — one boundary, two different resuscitations.
 */
test('a measured jugular venous pressure is binned by the pack threshold, exclusively', () => {
  const at = (cm: number) => resolveJvp(exam({ jugular_venous_pressure: 'not_assessed', jugular_venous_pressure_cm_h2o: cm }), rule)
  assert.equal(at(rule.jvpElevatedAboveCmH2O + 1), 'elevated')
  assert.equal(at(rule.jvpElevatedAboveCmH2O), 'normal_or_low')
  assert.equal(at(rule.jvpElevatedAboveCmH2O - 1), 'normal_or_low')
})

/**
 * The examiner's judgement wins over the number they made it from.
 *
 * An examiner who recorded both has already interpreted the measurement — at their angle, on
 * their patient — and silently preferring the number would let a reading taken badly overrule
 * the person who took it.
 */
test('a categorical finding beats a measurement when the payload carries both', () => {
  const e = exam({ jugular_venous_pressure: 'normal_or_low', jugular_venous_pressure_cm_h2o: 14 })
  assert.equal(resolveJvp(e, rule), 'normal_or_low')
})

// --- Concordance ---------------------------------------------------------------------------

test('a finding that does not discriminate is neither support nor discordance', () => {
  // Cool + low is hypovolemic. A delayed refill and a thready pulse are equally the cardiogenic
  // patient, and a clear chest is equally the septic one: three findings, no evidence.
  const e = exam({ capillary_refill: 'delayed', pulse_volume: 'thready', lung_exam: 'clear' })
  assert.deepEqual(concordance(e, classify(resolveExam(e, rule, mp))), { supporting: [], discordant: [] })
})

test('crackles against a hypovolemic answer are reported, not resolved', () => {
  const e = exam({ lung_exam: 'bilateral_crackles' })
  const assessment = classify(resolveExam(e, rule, mp))
  assert.equal(assessment.category, 'hypovolemic')
  assert.deepEqual(concordance(e, assessment), { supporting: [], discordant: ['lung_exam'] })
})

test('an indeterminate answer has nothing for a finding to agree or disagree with', () => {
  const e = exam({ skin_temperature: 'warm', jugular_venous_pressure: 'elevated', lung_exam: 'bilateral_crackles' })
  assert.deepEqual(concordance(e, classify(resolveExam(e, rule, mp))), { supporting: [], discordant: [] })
})

// --- The rendering -------------------------------------------------------------------------

/**
 * The rendering is the contract, so the bytes are pinned like a schema golden.
 *
 * Two runtimes that render five findings differently grade different inputs while appearing to
 * share a prompt, and the difference need only be a line break to move a small model. This is
 * the same argument [clinical.summaryAssembly] makes, and the same kind of test.
 */
test('a payload renders to exactly the bytes the prompt was measured on', () => {
  assert.equal(
    renderExam(resolved({ skin_temperature: 'warm', jugular_venous_pressure: 'normal_or_low', capillary_refill: 'brisk', pulse_volume: 'bounding' })),
    'PHYSICAL EXAMINATION\n' +
      'blood_pressure: 80/52 mmHg (medprotocol: Low)\n' +
      'mean_arterial_pressure: 61.3 mmHg\n' +
      'heart_rate: 118 bpm (medprotocol: Elevated)\n' +
      'shock_index: 1.48\n' +
      'hypotension_duration: 60 minutes\n' +
      'in_studied_cohort: yes (systolic 80 is below 90 and it has lasted 60 minutes)\n' +
      'skin_temperature: warm\n' +
      'jugular_venous_pressure: normal_or_low\n' +
      'capillary_refill: brisk\n' +
      'pulse_volume: bounding\n' +
      'lung_exam: clear\n',
  )
})
/**
 * A measured jugular venous pressure is shown as the CATEGORY it produced, with the number
 * beside it.
 *
 * Showing only `4 cmH2O` would make the model apply the threshold as well — a second thing to
 * get wrong, folded into the number meant to measure the first. The model is asked to echo a
 * category, so it must be shown one.
 */
test('a measured jugular venous pressure renders as its bin, with the measurement alongside', () => {
  const line = renderExam(resolved({ jugular_venous_pressure: 'not_assessed', jugular_venous_pressure_cm_h2o: 4 }))
    .split('\n')
    .find((l) => l.startsWith('jugular_venous_pressure:'))
  assert.equal(line, 'jugular_venous_pressure: normal_or_low (measured 4 cmH2O)')
})

// --- The payload parser ---------------------------------------------------------------------

/**
 * A misspelled finding is a LOAD error, not a model failure.
 *
 * `"cold"` for `"cool"` would fall through `classify` to the fourth cell and come back
 * `indeterminate`; the model would say `hypovolemic`; the case would be recorded as a wrong
 * answer. A typo in the corpus, charged to the weights, on a run that still prints a
 * percentage.
 */
test('a finding outside the vocabulary is refused rather than classified', () => {
  assert.throws(
    () => parseExam(JSON.stringify({ ...exam(), skin_temperature: 'cold' }), 'test'),
    /skin_temperature.*not one of/s,
  )
})

test('a payload without the hypotension precondition is refused', () => {
  const { hypotension, ...rest } = exam()
  assert.throws(() => parseExam(JSON.stringify(rest), 'test'), /hypotension/)
  assert.throws(() => parseExam(JSON.stringify({ ...rest, hypotension: { systolic: 80 } }), 'test'), /duration_minutes/)
})

// --- The contract, as the pack declares it ------------------------------------------------

test('the pack ships the shock contract whole', () => {
  assert.ok(hasContract(CONTRACTS.shock, pack))
})

test('the schema serializes to its golden', () => {
  assert.equal(JSON.stringify(pack.json(CONTRACTS.shock.schemaKey)), pack.read(CONTRACTS.shock.goldenKey).trim())
})

/**
 * Property order is compiled into the grammar, and one pair of it is load-bearing beyond the
 * usual: the two echoes must precede the category, because on this contract the echo IS the
 * reasoning — the rule is a lookup on exactly those two findings. Reversed, the model commits
 * to a category and then writes down the findings that justify it, which is a rationalisation
 * recorded as a reason.
 */
test('schema property order is the order the grammar will impose', () => {
  const schema = pack.json<{ properties: Record<string, unknown> }>(CONTRACTS.shock.schemaKey)
  const keys = Object.keys(schema.properties)
  assert.deepEqual(keys, [
    'skin_temperature',
    'jugular_venous_pressure',
    'shock_category',
    'supporting_findings',
    'discordant_findings',
    'indeterminate_reason',
    'assessment_confidence',
    'notes',
  ])
  assert.ok(keys.indexOf('jugular_venous_pressure') < keys.indexOf('shock_category'), 'the echo is the reasoning')
  assert.ok(keys.indexOf('shock_category') < keys.indexOf('supporting_findings'), 'support needs a claim to support')
  assert.ok(keys.indexOf('assessment_confidence') > keys.indexOf('shock_category'), 'commit before scoring yourself')
})

/** A grammar cannot emit EOS while an array is open, and maxItems alone is padded with dupes. */
test('every array in the schema is bounded and deduplicated', () => {
  const schema = pack.json<{ properties: Record<string, { type?: string; maxItems?: number; uniqueItems?: boolean }> }>(
    CONTRACTS.shock.schemaKey,
  )
  const arrays = Object.entries(schema.properties).filter(([, p]) => p.type === 'array')
  assert.equal(arrays.length, 2)
  for (const [name, p] of arrays) {
    assert.ok(typeof p.maxItems === 'number', `${name} needs maxItems`)
    assert.equal(p.uniqueItems, true, `${name} needs uniqueItems`)
  }
})

/**
 * The schema's category enum and the code's list are one statement.
 *
 * They can only disagree in one direction that matters: a category the grammar can emit and
 * the scorer has never heard of would be compared against every expectation and match none,
 * arriving as a model that is wrong on every case.
 */
test('the schema and the code agree about the vocabulary', () => {
  const schema = pack.json<any>(CONTRACTS.shock.schemaKey)
  assert.deepEqual(schema.properties.shock_category.enum, [...SHOCK_CATEGORIES])
  assert.deepEqual(schema.$defs.findingName.enum, [...FINDING_NAMES])
})

test('the contract assembles into a request, and honours the unconstrained arm', () => {
  const req = buildRequest(CONTRACTS.shock, pack, true)
  assert.ok(req.prompt.includes('indeterminate'))
  assert.ok(req.schema)
  assert.equal(req.schemaName, 'shock_category')
  assert.equal(req.sampling.temperature, 0)
  assert.equal(buildRequest(CONTRACTS.shock, pack, false).schema, undefined)
})

// --- The answer key -------------------------------------------------------------------------

/**
 * The corpus's expectations and the reference rule agree — checked at load, asserted here so
 * the check itself cannot be removed without a test going red.
 *
 * `loadShockCases` throws on a disagreement, which is the only place one can be acted on: an
 * expectation derived from the rule alone would let a bug in the rule redefine truth for all
 * thirteen cases with every number staying green.
 */
test('every case expectation matches what the rule computes from its payload', () => {
  assert.equal(cases.cases.length, 20)
  for (const c of cases.cases) {
    const truth = classify(c.resolved)
    assert.equal(truth.category, c.expect, c.name)
    assert.equal(truth.reason, c.expectReason, c.name)
  }
})

test('the corpus exercises every cell of the rule, including all three ways to decline', () => {
  const seen = new Set(cases.cases.map((c) => c.expect))
  for (const category of SHOCK_CATEGORIES) assert.ok(seen.has(category), `no case expects ${category}`)

  const reasons = new Set(cases.cases.map((c) => c.expectReason).filter(Boolean))
  assert.deepEqual(
    [...reasons].sort(),
    ['discordant_primary_findings', 'outside_studied_cohort', 'primary_finding_not_assessed'],
  )
})

/**
 * A corpus that is all-decided or all-indeterminate produces a full green table for a
 * discipline it never tested — `abstentionRecall` over an empty denominator is 1.0 by
 * construction. Refused at load rather than reported.
 */
test('a corpus with no indeterminate case is refused', () => {
  // Every case decided: the shape that makes abstentionRecall meaningless.
  assert.throws(
    () => loadShockCases({ ...pack, read: (k: string) => (k === 'fake' ? JSON.stringify({
      ...cases,
      cases: cases.cases.filter((c) => c.expect !== 'indeterminate').map(({ exam, ...c }) => c),
    }) : pack.read(k)) } as any, mp, 'fake'),
    /indeterminate case\(s\)/,
  )
})

// --- The scorer --------------------------------------------------------------------------------

const reply = (over: Partial<ShockReply> = {}): ShockReply => ({
  skin_temperature: 'cool',
  jugular_venous_pressure: 'normal_or_low',
  shock_category: 'hypovolemic',
  supporting_findings: [],
  discordant_findings: [],
  indeterminate_reason: null,
  assessment_confidence: 0.9,
  notes: null,
  ...over,
})

/**
 * A run over the whole corpus with both echoes read correctly, so the gate tests below isolate
 * category behaviour from grounding behaviour.
 *
 * They are different failures with different fixes — see the misread/misreasoned test above —
 * and a helper that let a wrong echo leak into an abstention test would be reporting one as
 * the other, which is the exact confusion `echoFidelity` exists to prevent.
 */
const run = (category: (c: (typeof cases.cases)[number]) => string) =>
  totals(
    cases.cases.map((c) =>
      scoreReply(reply({
          skin_temperature: c.exam.skin_temperature,
          jugular_venous_pressure: c.resolved.jvp,
          shock_category: category(c) as ShockReply['shock_category'],
        }), c.resolved),
    ),
  )

/**
 * The two failures a single accuracy number would merge.
 *
 * A model that misread `cool` as `warm` and then said `septic` applied the rule perfectly to a
 * patient it invented; a model that echoed both findings correctly and still said `septic`
 * cannot read the table. The first gets worse with a longer payload and the second gets better
 * with a worked example, so a run that scored them together would prescribe the wrong fix.
 */
test('a category reached from misread findings is not scored as a category reached', () => {
  const r = resolved() // cool + normal_or_low -> hypovolemic
  const misread = scoreReply(reply({ skin_temperature: 'warm', shock_category: 'septic' }), r)
  assert.equal(misread.categoryAgrees, false)
  assert.equal(misread.echoCorrect, false)
  assert.deepEqual(misread.echoErrors, ['skin_temperature'])

  const misreasoned = scoreReply(reply({ shock_category: 'septic' }), r)
  assert.equal(misreasoned.categoryAgrees, false)
  assert.equal(misreasoned.echoCorrect, true) // read the patient right, applied the rule wrong
})

/** The echo is checked against the RESOLVED category, so a binned measurement is comparable. */
test('the echo of a measured jugular venous pressure is checked against its bin', () => {
  const e = exam({ jugular_venous_pressure: 'not_assessed', jugular_venous_pressure_cm_h2o: 4 })
  const r = resolveExam(e, rule, mp)
  assert.equal(scoreReply(reply(), r).echoCorrect, true)
  // Echoing the payload's literal `not_assessed` contradicts the line the model was shown.
  assert.equal(scoreReply(reply({ jugular_venous_pressure: 'not_assessed' }), r).echoCorrect, false)
})

/**
 * Citing a finding nobody obtained is the analogue of a fabricated quote, and it is the more
 * dangerous half: the name is real, so a reader will not query it.
 */
test('a finding cited but not assessed is counted as invented', () => {
  const e = exam({ lung_exam: 'not_assessed' })
  const r = resolveExam(e, rule, mp)
  const s = scoreReply(reply({ discordant_findings: ['lung_exam'] }), r)
  assert.deepEqual(s.inventedFindings, ['lung_exam'])
  assert.equal(scoreReply(reply({ supporting_findings: ['capillary_refill'] }), r).inventedFindings.length, 0)
})

/**
 * Abstention is scored in BOTH directions, because the trivial way to win the first number is
 * to answer `indeterminate` every time.
 */
test('a model that always declines wins abstention recall and fails the gate on over-abstention', () => {
  const t = run(() => 'indeterminate')
  assert.equal(t.abstentionRecall, 1)
  assert.ok(t.overAbstention === 1, 'every one of the eleven decided cases was ducked')

  const g = gate(t, cases)
  assert.equal(g.pass, false)
  assert.ok(g.failed.includes('overAbstention'), 'the ceiling is what catches this model')
  assert.ok(g.failed.includes('categoryAgreement'))
})

/** And the mirror: a model that never declines looks mediocre on agreement and broken here. */
test('a model that never declines fails abstention recall rather than looking merely mediocre', () => {
  const t = run((c) => (c.expect === 'indeterminate' ? 'septic' : c.expect))
  assert.equal(t.abstentionRecall, 0)
  assert.equal(t.overAbstention, 0)
  // Agreement alone reads as a middling model rather than a broken one — the nine indeterminate
  // cases are absorbed by the eleven decided ones. This is why the number is reported apart.
  assert.ok(t.categoryAgreement > 0.5 && t.categoryAgreement < 0.6, `agreement was ${t.categoryAgreement}`)
  assert.deepEqual(gate(t, cases).failed, ['categoryAgreement', 'abstentionRecall'])
})

/**
 * The floors are reachable from both sides: three wrong categories pass, four do not.
 *
 * A gate nobody has tested at its own boundary is a gate whose number was chosen and never
 * checked — and on a corpus of twenty the difference between 0.84 and 0.85 is one case.
 */
test('the agreement floor tolerates three wrong categories and stops at four', () => {
  const wrong = (n: number) => run((c) => (cases.cases.indexOf(c) < n ? 'not_a_category' : c.expect))
  assert.equal(gate(wrong(3), cases).pass, true)
  assert.ok(gate(wrong(4), cases).failed.includes('categoryAgreement'))
})

/** A perfect run clears every floor, so the gate is known to be passable at all. */
test('a run that agrees with the rule everywhere clears every floor', () => {
  const perfect = cases.cases.map((c) =>
    scoreReply(reply({
        skin_temperature: c.exam.skin_temperature,
        jugular_venous_pressure: c.resolved.jvp,
        shock_category: c.expect,
      }), c.resolved),
  )
  const t = totals(perfect)
  assert.equal(t.categoryAgreement, 1)
  assert.equal(t.echoFidelity, 1)
  assert.equal(t.notInvented, 1)
  assert.equal(t.abstentionRecall, 1)
  assert.equal(t.overAbstention, 0)
  assert.deepEqual(gate(t, cases), { pass: true, failed: [] })
})

/** One invented citation on one case out of thirteen fails the run. notInventedFloor is 1.0. */
test('a single invented citation fails the gate', () => {
  const scores = cases.cases.map((c, i) =>
    scoreReply(reply({
        skin_temperature: c.exam.skin_temperature,
        jugular_venous_pressure: c.resolved.jvp,
        shock_category: c.expect,
        // The one case whose lung examination was not obtained gets it cited anyway.
        supporting_findings: i === 0 && c.exam.lung_exam === 'not_assessed' ? ['lung_exam'] : [],
      }), c.resolved),
  )
  // Force the condition on a case that definitely has an unassessed finding.
  const withUnassessed = cases.cases.find((c) => c.exam.jugular_venous_pressure === 'not_assessed' && !c.exam.jugular_venous_pressure_cm_h2o)
  assert.ok(withUnassessed, 'the corpus should contain an unassessable primary finding')
  scores.push(scoreReply(reply({ supporting_findings: ['jugular_venous_pressure'] }), withUnassessed.resolved))

  const g = gate(totals(scores), cases)
  assert.equal(g.pass, false)
  assert.ok(g.failed.includes('notInvented'))
})

// --- The eval loop, end to end --------------------------------------------------------------
//
// A stub server rather than a stubbed client, for the reason test/eval-loop.test.ts gives: the
// questions worth asking here — what reached the model, what the gate did with the reply, what
// the trace holds afterwards — are properties of the transport boundary. No model, no weights,
// and the canned replies are chosen to make the ARITHMETIC checkable rather than to resemble
// anything a model would say.

/** Serve one canned reply per request, and answer the two identity probes the run makes. */
const serve = async (reply: (body: any, n: number) => string) => {
  const bodies: any[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const json = (v: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(v))
      }
      if (req.url?.includes('/v1/models')) return json({ data: [{ id: 'stub-model' }] })
      if (req.url?.includes('/props')) {
        return json({ model_ftype: 'Q4_K - Medium', total_slots: 1, default_generation_settings: { n_ctx: 32768 } })
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      const n = bodies.length
      bodies.push(body)
      json({
        choices: [{ message: { content: reply(body, n) }, finish_reason: 'stop' }],
        timings: { prompt_n: 100, prompt_ms: 50, predicted_n: 40, predicted_ms: 200, cache_n: 900 },
      })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    close: async () => {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    },
  }
}

/** The printed block is the product, and several hundred lines of it is noise under --test. */
const quiet = <T,>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log
  const err = console.error
  console.log = () => {}
  console.error = () => {}
  return fn().finally(() => {
    console.log = log
    console.error = err
  })
}

const tracing = () => {
  const dir = mkdtempSync(join(tmpdir(), 'medextract-shock-'))
  const before = process.env.TRACE_DIR
  process.env.TRACE_DIR = dir
  const trace = openTrace('shock-test', clinicalRedactor(true))
  if (before === undefined) delete process.env.TRACE_DIR
  else process.env.TRACE_DIR = before
  return { trace, dir, lines: () => readFileSync(trace.path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) }
}

/**
 * Which case a request is about, recovered from the rendered payload in its user message.
 *
 * It THROWS on no match rather than returning undefined, and that is the useful behaviour: a
 * miss means the loop sent bytes no payload in the corpus renders to, which is the failure
 * these tests most need to catch and the one a silent `undefined` would turn into a confusing
 * assertion about a canned reply somewhere else.
 */
const caseOfBody = (body: any): ShockCase => {
  const sent = String(body?.messages?.[1]?.content ?? '')
  const found = cases.cases.find((c) => renderExam(c.resolved) === sent)
  if (!found) throw new Error(`the loop sent a payload no case renders to:\n${sent}`)
  return found
}

/** A reply that agrees with the rule on whatever case the request is about. */
const perfectFor = (c: ShockCase) =>
  JSON.stringify({
    skin_temperature: c.exam.skin_temperature,
    jugular_venous_pressure: c.resolved.jvp,
    shock_category: c.expect,
    supporting_findings: [],
    discordant_findings: [],
    indeterminate_reason: c.expectReason ? 'the rule does not reach; an echocardiogram would settle it' : null,
    assessment_confidence: 0.9,
    notes: null,
  })

/**
 * The whole loop, on a model that agrees with the rule everywhere.
 *
 * It checks the arithmetic AND the wiring: twenty requests for twenty payloads, the pack's cap
 * and label on every body, and a gate that passes. A perfect run passing is not a given — it is
 * how a gate is known to be reachable at all, and this pack has a floor of 1.0 on two axes.
 */
test('the eval runs the corpus and a rule-agreeing model clears every gate', async () => {
  const stub = await serve((body) => perfectFor(caseOfBody(body)))
  const { trace } = tracing()
  try {
    const result = await quiet(() =>
      runShockEval({ pack, baseUrl: stub.url, trace, constrain: true, cachePrompt: false }),
    )
    assert.equal(result.task, 'shock')
    assert.equal(result.score, 1)
    assert.equal(result.measured, true)
    assert.equal(gatePasses(result), true)
    for (const g of result.gates!) assert.equal(gatePasses(g), true, `${g.name} did not clear`)

    // One request per payload, and no retries: a parse failure would double a case silently.
    const chat = stub.bodies.filter((b) => b.messages)
    assert.equal(chat.length, 20)

    // The pack's declared cap and label, not a harness default. A header that names one number
    // while the body sends another is the specific lie this repository exists to prevent.
    const sampling = loadSampling(pack, CONTRACTS.shock.samplingKey)
    for (const b of chat) {
      assert.equal(b.max_tokens, sampling.max_tokens)
      assert.equal(b.temperature, 0)
      assert.equal(b.response_format?.json_schema?.name, 'shock_category')
    }
  } finally {
    await stub.close()
  }
})

/**
 * What reached the model is the RENDERING, not the payload file.
 *
 * The whole point of `renderExam` living in shock.ts is that the eval and the consuming
 * application send the same bytes. A loop that sent `JSON.stringify(exam)` — or the file — would
 * measure a prompt nobody ships, and every number would still look fine.
 */
test('the loop sends the rendered payload, and never the raw file', async () => {
  const stub = await serve((body) => perfectFor(caseOfBody(body)))
  const { trace } = tracing()
  try {
    await quiet(() => runShockEval({ pack, baseUrl: stub.url, trace, constrain: true, cachePrompt: false }))
    const sent = stub.bodies.filter((b) => b.messages).map((b) => String(b.messages[1].content))
    assert.equal(sent.length, 20)
    for (const s of sent) {
      assert.ok(s.startsWith('PHYSICAL EXAMINATION\n'), 'the rendering, not the file')
      assert.ok(!s.includes('"hypotension"'), 'the raw JSON payload must not reach the model')
    }
    // And the system prompt is byte-identical across every case, which is what makes
    // `cache_prompt` worth having and what a second runtime would compare against.
    const prompts = new Set(stub.bodies.filter((b) => b.messages).map((b) => String(b.messages[0].content)))
    assert.equal(prompts.size, 1)
  } finally {
    await stub.close()
  }
})

/**
 * A run whose every reply is unparseable scores nothing and must NOT pass.
 *
 * This is the failure `measured` exists for, and it is not hypothetical: an unconstrained
 * gemma-3-4b run on a sibling task fenced every reply, checked nothing, and printed
 * `provenance 100%`. Here the equivalent would be a gate cleared over an empty denominator.
 */
test('a run where nothing parsed fails rather than clearing a floor on zero cases', async () => {
  const stub = await serve(() => '```json\n{"shock_category":"septic"}\n```')
  const { trace } = tracing()
  try {
    const result = await quiet(() =>
      runShockEval({ pack, baseUrl: stub.url, trace, constrain: false, cachePrompt: false }),
    )
    assert.equal(result.measured, false)
    assert.equal(gatePasses(result), false)
    for (const g of result.gates!) assert.equal(gatePasses(g), false, `${g.name} cleared on nothing`)
  } finally {
    await stub.close()
  }
})

/**
 * An invented citation on ONE case out of twenty fails the whole run.
 *
 * notInventedFloor is 1.0, and the case chosen is the one where the temptation is real:
 * sh-19-primaries-only has nothing legitimate to cite, so a model that believes an answer needs
 * citations has to manufacture an examination to produce one.
 */
test('one invented citation on one case fails the run, with the category still perfect', async () => {
  const stub = await serve((body) => {
    const c = caseOfBody(body)
    const base = JSON.parse(perfectFor(c))
    if (c.name === 'sh-19-primaries-only') base.supporting_findings = ['lung_exam']
    return JSON.stringify(base)
  })
  const { trace, lines } = tracing()
  try {
    const result = await quiet(() =>
      runShockEval({ pack, baseUrl: stub.url, trace, constrain: true, cachePrompt: false }),
    )
    assert.equal(result.score, 1, 'every category still agrees with the rule')
    assert.equal(gatePasses(result), true, 'so the headline gate passes')
    const invented = result.gates!.find((g) => g.name === 'notInvented')!
    assert.equal(gatePasses(invented), false, 'and the run still fails, on the sub-gate')

    // The trace names the case and the finding, so the failure is actionable without a re-run.
    const bad = lines().find((l) => l.event === 'case' && l.case === 'sh-19-primaries-only')
    assert.deepEqual(bad.score.inventedFindings, ['lung_exam'])
  } finally {
    await stub.close()
  }
})

/**
 * The trace records the RULE's answer beside the model's, and the cut-points it came from.
 *
 * A disagreement that can only be understood by re-deriving the reference arm is a disagreement
 * nobody checks, and a number reproduced against a different threshold is a number about a
 * different contract.
 */
test('the trace carries the reference arm and the rule it was computed under', async () => {
  const stub = await serve((body) => perfectFor(caseOfBody(body)))
  const { trace, lines } = tracing()
  try {
    await quiet(() => runShockEval({ pack, baseUrl: stub.url, trace, constrain: true, cachePrompt: false }))
    const l = lines()
    const record = l.find((x) => x.event === 'record')
    assert.equal(record.rule.jvpElevatedAboveCmH2O, 7)
    assert.equal(record.rule.hypotensionSystolicBelow, 90)
    assert.equal(record.pass, true)

    const fourth = l.find((x) => x.event === 'case' && x.case === 'sh-16-measured-fourth-cell')
    assert.deepEqual(fourth.expected, { category: 'indeterminate', reason: 'discordant_primary_findings' })
    assert.equal(fourth.reply.jugular_venous_pressure, 'elevated', '8 cmH2O was binned before the model saw it')
  } finally {
    await stub.close()
  }
})

/** `--difficulty` actually filters, and the abstention gates say so rather than faking a 1.0. */
test('a difficulty-scoped run grades only that tier and refuses to gate on what it did not see', async () => {
  const stub = await serve((body) => perfectFor(caseOfBody(body)))
  const { trace } = tracing()
  try {
    // Tier 1 is the three textbook cells: all decided, none indeterminate.
    const result = await quiet(() =>
      runShockEval({ pack, baseUrl: stub.url, trace, constrain: true, cachePrompt: false, difficulty: '1' }),
    )
    assert.equal(stub.bodies.filter((b) => b.messages).length, 3)
    const abstention = result.gates!.find((g) => g.name === 'abstentionRecall')!
    assert.equal(abstention.measured, false, 'this tier contains no case the rule declines')
    assert.equal(gatePasses(abstention), false, 'so it must not clear itself on an empty denominator')
    assert.equal(result.gates!.find((g) => g.name === 'restraint')!.measured, true)
  } finally {
    await stub.close()
  }
})

// --- The reply parser -------------------------------------------------------------------------

/** Any case will do; the parser knows nothing about which payload a reply is about. */
const aCase = cases.cases[0]!

test('a fenced reply is named as fenced rather than as bad JSON', () => {
  assert.throws(() => parseShockReply('```json\n{}\n```'), /code fence/)
})

test('a category outside the enum is refused, and the field is named', () => {
  const good = JSON.parse(perfectFor(aCase))
  assert.throws(() => parseShockReply(JSON.stringify({ ...good, shock_category: 'unclear' })), /shock_category.*expected one of/s)
  assert.throws(() => parseShockReply(JSON.stringify({ ...good, skin_temperature: 'cold' })), /skin_temperature/)
})

/**
 * A MISSING array is not an empty one.
 *
 * On a contract whose subject is whether citations are grounded, reading an omission as
 * restraint would credit the model for a question it did not answer.
 */
test('an omitted citation array is refused rather than read as empty', () => {
  const { supporting_findings, ...rest } = JSON.parse(perfectFor(aCase))
  assert.throws(() => parseShockReply(JSON.stringify(rest)), /supporting_findings.*expected an array/s)
})

test('a finding name outside the payload vocabulary is refused', () => {
  const good = JSON.parse(perfectFor(aCase))
  assert.throws(
    () => parseShockReply(JSON.stringify({ ...good, discordant_findings: ['mottling'] })),
    /discordant_findings contains "mottling"/,
  )
})

/**
 * `extract --task shock` is refused with a reason that is TRUE of shock.
 *
 * The refusal used to be a ternary whose fallback arm belonged to note-format, so the moment
 * `shock` joined TASKS it was told it "reads the same notes vital signs reads" — false about
 * the one task in this pack that reads no notes at all. An unreachable task that misdescribes
 * itself is worse than one that says nothing, because the sentence is what the reader acts on.
 */
test('extract refuses the shock task, and says why shock in particular', async () => {
  const { trace } = tracing()
  await assert.rejects(
    () =>
      PROFILE.review!({
        pack,
        trace,
        input: { kind: 'text', text: '', label: 'test' },
        options: { task: 'shock' },
      } as any),
    (e: Error) => {
      assert.ok(e instanceof ProfileError, 'a setup mistake, not a crash')
      assert.match(e.message, /physical-examination payload/)
      assert.match(e.message, /eval --task shock/, 'and it says what to run instead')
      assert.doesNotMatch(e.message, /same notes vital signs reads/, "note-format's reason, not shock's")
      return true
    },
  )
})

/** Every graded task that `extract` cannot run gets a reason of its own, not an inherited one. */
test('each unreviewable task is refused with a distinct reason', async () => {
  const { trace } = tracing()
  const reasons = new Map<string, string>()
  for (const task of TASKS) {
    try {
      await PROFILE.review!({ pack, trace, input: { kind: 'text', text: '', label: 't' }, options: { task } } as any)
    } catch (e) {
      if (e instanceof ProfileError && e.message.includes('not a reviewable one')) reasons.set(task, e.message)
    }
  }
  assert.deepEqual([...reasons.keys()].sort(), ['note-format', 'shock', 'summary'])
  assert.equal(new Set(reasons.values()).size, 3, 'three tasks, three reasons — none inherited')
})

// --- medprotocol: the delegation, and the line it must not cross -----------------------------

/**
 * medprotocol parses the blood pressure and the pack decides what it means.
 *
 * THIS TEST IS THE WHOLE ARGUMENT FOR KEEPING THE COHORT GATE IN THE PACK. medprotocol's
 * `Low` fires on systolic < 90 OR diastolic < 60; the study enrolled on systolic < 90 alone.
 * Delegating the parse is right and delegating the CRITERION would silently re-point this
 * contract at a rule Vazquez et al. never published — starting with a patient at 120/55, who is
 * "Low" and is nobody's idea of shock.
 */
test('medprotocol categorises the pressure; the pack decides the cohort', () => {
  const lowByDiastolic = evaluateVitals(mp, { systolic: 120, diastolic: 55 }, 80)
  assert.equal(lowByDiastolic.bloodPressureCategory, 'Low', 'the CLI calls this low')
  // ...and the contract does not admit it, because the gate is systolic-only.
  const r = resolved({ hypotension: { systolic: 120, diastolic: 55, duration_minutes: 600 } })
  assert.equal(r.vitals.bloodPressureCategory, 'Low')
  assert.equal(r.cohort.ok, false, 'a systolic of 120 is not the studied cohort, whatever the diastolic says')
  assert.equal(classify(r).reason, 'outside_studied_cohort')
})

/**
 * The boundary that three prompt formulations could not teach a 4B model, now decided by code.
 *
 * 89 is in, 90 is out, and the comparison happens once — in `resolveExam` — rather than in the
 * model's head on every case. `sh-17-systolic-at-cut` is the corpus case this protects.
 */
test('the cohort gate is exclusive on the systolic and inclusive on the duration', () => {
  const at = (systolic: number, duration_minutes: number) =>
    resolved({ hypotension: { systolic, diastolic: 55, duration_minutes } }).cohort.ok
  assert.equal(at(89, 60), true)
  assert.equal(at(90, 60), false, '90 is not below 90')
  assert.equal(at(80, 30), true, 'exactly 30 minutes is at least 30')
  assert.equal(at(80, 29), false)
})

/** The gate's stated reason names which half failed — it is quoted into the payload. */
test('the cohort reason names the half that failed', () => {
  assert.match(resolved({ hypotension: { systolic: 104, diastolic: 68, duration_minutes: 90 } }).cohort.why, /104 is not below 90/)
  assert.match(resolved({ hypotension: { systolic: 84, diastolic: 55, duration_minutes: 10 } }).cohort.why, /10 minutes, under the 30/)
})

/**
 * Both composites are derived from MEDPROTOCOL'S parse, not from the payload's own numbers.
 *
 * One parse of a blood pressure in the pipeline: if the CLI ever normalised a value, every
 * number downstream would move with it rather than silently disagreeing with it.
 */
test('MAP and shock index are computed from the parsed vitals', () => {
  const v = evaluateVitals(mp, { systolic: 90, diastolic: 60 }, 108)
  assert.equal(v.meanArterialPressure, 70) // 60 + (90-60)/3
  assert.equal(v.shockIndex, 1.2) // 108 / 90
})

/**
 * A bad invocation is a REFUSAL, not a silent undefined.
 *
 * medprotocol reports one as `{"error": ...}` on stdout with EXIT CODE 0. A caller checking the
 * exit status would read that as a result, find no systolic, and carry `undefined < 90` into the
 * gate — which is `false`, so every patient would land outside the cohort and the run would
 * report a plausible number for a rule that never ran.
 */
test('a medprotocol error is refused rather than read as a result', () => {
  assert.throws(() => evaluateVitals(mp, { systolic: NaN, diastolic: NaN }, 80), /medprotocol refused/)
})

/** The declared version is enforced: a different build is a different rule. */
test('a version mismatch refuses the run', () => {
  assert.equal(checkMedprotocolVersion(mp, pack.name), mp.version)
  assert.throws(
    () => checkMedprotocolVersion({ ...mp, version: '0.0.1' }, pack.name),
    /declares medprotocol 0\.0\.1 and this machine has/,
  )
})

/**
 * The prompt's worked examples show the payload format the model is actually sent.
 *
 * The rendering gained six lines when medprotocol arrived. A prompt still demonstrating the old
 * shape would be teaching the model to read a payload nobody sends — and every example would
 * still look plausible, which is why this is a test rather than a habit.
 */
test('every worked example in the prompt is in the current payload format', () => {
  const prompt = pack.read(CONTRACTS.shock.promptKey)
  const inputs = [...prompt.matchAll(/PHYSICAL EXAMINATION\n((?:    \w+: [^\n]+\n)+)/g)]
  assert.equal(inputs.length, 5)
  for (const [, body] of inputs) {
    const keys = body!.trim().split('\n').map((l) => l.trim().split(':')[0])
    assert.deepEqual(keys, [
      'blood_pressure',
      'mean_arterial_pressure',
      'heart_rate',
      'shock_index',
      'hypotension_duration',
      'in_studied_cohort',
      'skin_temperature',
      'jugular_venous_pressure',
      'capillary_refill',
      'pulse_volume',
      'lung_exam',
    ])
  }
})

/** And the cohort line the prompt teaches must agree with what the code would compute. */
test('the prompt never shows a cohort verdict the code disagrees with', () => {
  const prompt = pack.read(CONTRACTS.shock.promptKey)
  for (const [, body] of prompt.matchAll(/PHYSICAL EXAMINATION\n((?:    \w+: [^\n]+\n)+)/g)) {
    const f = Object.fromEntries(body!.trim().split('\n').map((l) => {
      const t = l.trim()
      const i = t.indexOf(': ')
      return [t.slice(0, i), t.slice(i + 2)]
    }))
    const [systolic, diastolic] = f.blood_pressure!.split(' ')[0]!.split('/').map(Number)
    const r = resolved({
      hypotension: { systolic: systolic!, diastolic: diastolic!, duration_minutes: parseInt(f.hypotension_duration!) },
      heart_rate: parseInt(f.heart_rate!),
    })
    assert.equal(
      `${r.cohort.ok ? 'yes' : 'no'} (${r.cohort.why})`,
      f.in_studied_cohort,
      'a worked example states a cohort verdict resolveExam does not produce',
    )
  }
})
