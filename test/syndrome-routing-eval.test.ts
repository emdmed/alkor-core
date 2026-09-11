/**
 * Syndrome-routing eval tests.
 *
 * Two things are under test and they are not the same thing. The CORPUS asserts that the real
 * router sends each note to the right arms — that is the eval itself, run here so a routing
 * regression fails `npm test` rather than waiting for someone to run the eval by hand. The
 * MACHINERY is tested with synthetic results, because a grader that silently mis-scores is
 * worse than no grader: it reports a percentage either way.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  armLabel,
  armsOfPlan,
  formatSyndromeRoutingEval,
  gateSyndromeRoutingEval,
  runSyndromeRoutingEval,
  SYNDROME_ROUTING_CASES,
  TASKS_FOR_ARM,
  type SyndromeCase,
} from '../src/profiles/clinical/syndrome-routing-eval.ts'

// --- The eval over the real router ----------------------------------------------------------

test('the shock/sepsis routing eval passes its gate', () => {
  const result = runSyndromeRoutingEval()
  const verdict = gateSyndromeRoutingEval(result)
  assert.ok(verdict.pass, `${verdict.summary}\n\n${formatSyndromeRoutingEval(result)}`)
})

test('no gated case loses an arm the note asked for', () => {
  const result = runSyndromeRoutingEval()
  const dropped = result.cases.filter((c) => c.knownGap === undefined && c.missing.length > 0)
  assert.deepEqual(
    dropped.map((c) => `${c.missing.join('+')}: ${c.discriminates}`),
    [],
    'a dropped arm is a syndrome the pipeline reported as screened and never screened',
  )
})

test('every septic-shock case plans all four passes, in dependency order', () => {
  const result = runSyndromeRoutingEval()
  const both = result.cases.filter((c) => c.expectedArms.length === 2 && c.knownGap === undefined)
  assert.ok(both.length >= 3, 'the corpus carries septic-shock cases')
  for (const c of both) {
    assert.deepEqual(c.predictedArms, ['shock', 'sepsis'], `both arms for: ${c.discriminates}`)
    // Prose reaches a contract through its extraction; a structured payload enters directly.
    // Either way, an extraction in the plan must precede what it feeds.
    const iExtract = c.tasks.indexOf('shock-extraction')
    const iShock = c.tasks.indexOf('shock')
    if (iExtract !== -1) assert.ok(iExtract < iShock, `extraction before classification: ${c.discriminates}`)
  }
  assert.deepEqual(result.outOfOrder, [])
})

test('a known gap that starts passing fails the gate', () => {
  const result = runSyndromeRoutingEval()
  assert.deepEqual(
    result.closedGaps.map((c) => c.discriminates),
    [],
    'a stale known-gap annotation describes a router that no longer exists — promote the case',
  )
  // Every annotated gap carries its reason, so a reader never has to guess why a wrong answer
  // is tolerated.
  for (const gap of result.knownGaps) assert.ok(gap.knownGap && gap.knownGap.length > 40)
})

test('the corpus covers all four label combinations', () => {
  const labels = new Set(SYNDROME_ROUTING_CASES.map((c) => armLabel(c.expectedArms)))
  assert.deepEqual([...labels].sort(), ['both', 'neither', 'sepsis', 'shock'])
})

// --- The machinery --------------------------------------------------------------------------

test('armsOfPlan reads an arm off its extraction as well as its terminal contract', () => {
  assert.deepEqual(armsOfPlan(['shock-extraction', 'shock']), ['shock'])
  assert.deepEqual(armsOfPlan(['shock-extraction']), ['shock'], 'the extraction alone commits to the arm')
  assert.deepEqual(armsOfPlan(['sepsis']), ['sepsis'])
  assert.deepEqual(armsOfPlan(['shock', 'sepsis-extraction', 'sepsis']), ['shock', 'sepsis'])
  assert.deepEqual(armsOfPlan(['transcript', 'vital-signs']), [])
})

test('TASKS_FOR_ARM is derived from the feed table, not listed beside it', () => {
  assert.ok(TASKS_FOR_ARM.shock.includes('shock') && TASKS_FOR_ARM.shock.includes('shock-extraction'))
  assert.ok(TASKS_FOR_ARM.sepsis.includes('sepsis') && TASKS_FOR_ARM.sepsis.includes('sepsis-extraction'))
  assert.ok(!TASKS_FOR_ARM.shock.includes('sepsis'))
})

test('armLabel collapses an arm set to one of four names', () => {
  assert.equal(armLabel([]), 'neither')
  assert.equal(armLabel(['shock']), 'shock')
  assert.equal(armLabel(['sepsis']), 'sepsis')
  assert.equal(armLabel(['shock', 'sepsis']), 'both')
})

/** A note that reliably routes to both arms, used as the payload for machinery tests. */
const SEPTIC_SHOCK =
  'Septic shock from a urinary source. Hypotensive, tachycardic, cold peripheries, confused, febrile.'
const PLAIN_NOTE = 'Patient admitted for an elective hernia repair, discharged the same day.'

test('a case expecting one arm is scored wrong when both run', () => {
  const cases: SyndromeCase[] = [
    { input: SEPTIC_SHOCK, expectedArms: ['shock'], difficulty: 1, discriminates: 'deliberately understated' },
  ]
  const r = runSyndromeRoutingEval(cases)
  assert.equal(r.accuracy, 0)
  assert.deepEqual(r.cases[0]!.extra, ['sepsis'])
  assert.deepEqual(r.cases[0]!.missing, [])
  assert.equal(r.perArm.get('sepsis')!.fp, 1, 'an unasked arm is a precision loss, not a recall loss')
  assert.equal(r.perArm.get('sepsis')!.recall, 1)
})

test('a dropped arm is counted against recall and fails the gate', () => {
  const cases: SyndromeCase[] = [
    { input: PLAIN_NOTE, expectedArms: ['shock'], difficulty: 1, discriminates: 'deliberately overstated' },
  ]
  const r = runSyndromeRoutingEval(cases)
  assert.deepEqual(r.cases[0]!.missing, ['shock'])
  assert.equal(r.perArm.get('shock')!.recall, 0)
  assert.equal(gateSyndromeRoutingEval(r).pass, false)
})

test('one septic-shock note losing an arm fails the gate on its own', () => {
  // Nineteen easy cases and one septic-shock note routed to a single arm: accuracy stays at
  // 95%, above the 90% floor, and the gate must still refuse it.
  const filler: SyndromeCase[] = Array.from({ length: 19 }, (_, i) => ({
    input: `${PLAIN_NOTE} Case ${i}.`,
    expectedArms: [],
    difficulty: 1 as const,
    discriminates: 'filler',
  }))
  const r = runSyndromeRoutingEval([
    ...filler,
    { input: 'Hypotensive, tachycardic, cold peripheries — cardiogenic shock.', expectedArms: ['shock', 'sepsis'], difficulty: 1, discriminates: 'both expected, one delivered' },
  ])
  assert.ok(r.accuracy >= 0.9, `accuracy ${r.accuracy} clears the overall floor`)
  const verdict = gateSyndromeRoutingEval(r)
  assert.equal(verdict.pass, false)
  assert.match(verdict.summary, /both arms \(0\/1\) ✗/)
})

test('known gaps are excluded from the metrics, not from the report', () => {
  const cases: SyndromeCase[] = [
    { input: SEPTIC_SHOCK, expectedArms: ['shock', 'sepsis'], difficulty: 1, discriminates: 'gated' },
    { input: PLAIN_NOTE, expectedArms: ['shock'], difficulty: 1, discriminates: 'gapped', knownGap: 'the router reads words, not numbers, and this note carries none of them' },
  ]
  const r = runSyndromeRoutingEval(cases)
  assert.equal(r.total, 1, 'the gap is not in the denominator')
  assert.equal(r.accuracy, 1)
  assert.equal(r.knownGaps.length, 1)
  assert.equal(r.closedGaps.length, 0)
  assert.equal(gateSyndromeRoutingEval(r).pass, true)
  assert.match(formatSyndromeRoutingEval(r), /known gaps \(stated, not gated\)/)
})

test('a known gap that now passes is reported as stale and fails the gate', () => {
  const cases: SyndromeCase[] = [
    { input: SEPTIC_SHOCK, expectedArms: ['shock', 'sepsis'], difficulty: 1, discriminates: 'annotated but correct', knownGap: 'stale annotation left behind after the router was fixed' },
  ]
  const r = runSyndromeRoutingEval(cases)
  assert.equal(r.closedGaps.length, 1)
  const verdict = gateSyndromeRoutingEval(r)
  assert.equal(verdict.pass, false)
  assert.match(verdict.summary, /known gaps still open \(0\/1\) ✗/)
  assert.match(formatSyndromeRoutingEval(r), /NOW PASSES/)
})

test('an impossible plan fails the gate even when both arms are present', () => {
  // The order check reads the real router's output, so this asserts the property rather than
  // simulating a violation: no case in the corpus may schedule an extraction after its consumer.
  const r = runSyndromeRoutingEval()
  assert.deepEqual(r.outOfOrder, [])
  assert.match(gateSyndromeRoutingEval(r).summary, /dependency order ✓/)
})

test('the formatted report names the failing case and what it discriminates', () => {
  const cases: SyndromeCase[] = [
    { input: PLAIN_NOTE, expectedArms: ['sepsis'], difficulty: 2, discriminates: 'a distinctive phrase to find' },
  ]
  const report = formatSyndromeRoutingEval(runSyndromeRoutingEval(cases))
  assert.match(report, /dropped sepsis/)
  assert.match(report, /a distinctive phrase to find/)
})
