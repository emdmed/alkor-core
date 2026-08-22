/**
 * What `--runs N` reports.
 *
 * It used to report a mean, and its own docstring admitted the mean is arithmetic on a
 * constant at temperature 0. The thing worth reporting is which cases MOVED, because the
 * harness has measured one moving: the same note, the same model, the same bytes returned
 * `"weight 61.4 kg"` in a 21-note run and `"Weight 61.4 kg"` in a five-note one, and under a
 * case-sensitive quote rule that capital is a verified span against a fabricated one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatStability, summarizeStability, type Observation } from '../src/core/stability.ts'

const obs = (name: string, run: number, completion: string, score: string): Observation => ({
  case: name,
  run,
  completion,
  score,
})

test('a case that repeated exactly is not reported as varied', () => {
  const s = summarizeStability([obs('a', 0, '{"x":1}', 'ok'), obs('a', 1, '{"x":1}', 'ok')])
  assert.equal(s.cases, 1)
  assert.equal(s.runs, 2)
  assert.equal(s.variedInText.length, 0)
  assert.equal(s.reproducibleShare, 1)
})

/** The measured flip, in the shape it arrived in: one capital, and a grade that moved with it. */
test('a case whose text moved is named, and so is the grade that moved with it', () => {
  const s = summarizeStability([
    obs('vs-en-16-addendum', 0, '{"weight":{"raw_text":"weight 61.4 kg"}}', '{"quoteVerified":1}'),
    obs('vs-en-16-addendum', 1, '{"weight":{"raw_text":"Weight 61.4 kg"}}', '{"quoteVerified":0}'),
    obs('vs-en-01-vitals-block', 0, '{"hr":78}', 'ok'),
    obs('vs-en-01-vitals-block', 1, '{"hr":78}', 'ok'),
  ])
  assert.deepEqual(s.variedInText.map((c) => c.case), ['vs-en-16-addendum'])
  assert.deepEqual(s.variedInScore.map((c) => c.case), ['vs-en-16-addendum'])
  assert.equal(s.reproducibleShare, 0.5)
  const lines = formatStability(s).join('\n')
  assert.match(lines, /vs-en-16-addendum/)
  assert.match(lines, /flipped a GRADE/)
  // The aggregate is one draw, and the report has to say so — that is the whole difference
  // between this and a mean.
  assert.match(lines, /not a measurement/)
})

/**
 * Text that moved without moving a grade is the quiet case: the model said something else and
 * the corpus could not see it. Worth naming, and worth naming differently.
 */
test('text that moved without changing a grade is reported as exactly that', () => {
  const s = summarizeStability([obs('a', 0, 'one', 'same'), obs('a', 1, 'two', 'same')])
  assert.equal(s.variedInText.length, 1)
  assert.equal(s.variedInScore.length, 0)
  assert.match(formatStability(s).join('\n'), /none of the variation changed a grade/)
})

/** One run per case measures nothing about repetition, and reporting 100% would be a lie. */
test('a single run says stability was not measured', () => {
  const s = summarizeStability([obs('a', 0, 'x', 'y'), obs('b', 0, 'x', 'y')])
  assert.equal(s.runs, 1)
  assert.match(formatStability(s).join('\n'), /not measured/)
})

/** A mean run count would be the same mistake this module exists to correct, one level up. */
test('cases asked a different number of times refuse to report one run count', () => {
  const s = summarizeStability([obs('a', 0, 'x', 'y'), obs('a', 1, 'x', 'y'), obs('b', 0, 'x', 'y')])
  assert.equal(s.runs, 0)
  assert.match(formatStability(s).join('\n'), /their runs/)
})
