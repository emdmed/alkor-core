/**
 * Trace redaction for the clinical profile.
 *
 * This is the one hook in the harness whose failure mode is patient data on disk rather than
 * a wrong number, and it spent its whole existence as a comment: `eval.ts` said `redact` was
 * "what makes this safe to leave on for a pack whose notes are real" while the profile
 * declared no redactor at all, so the trace default — identity — wrote every completion.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { loadPack } from '../src/core/pack.ts'
import { redactor } from '../src/core/profile.ts'
import { PROFILE } from '../src/profiles/clinical/profile.ts'
import { clinicalRedactor, redactClinical } from '../src/profiles/clinical/redact.ts'
import { loadSettings } from '../src/profiles/clinical/contracts.ts'

const pack = loadPack(join(import.meta.dirname, '..', 'packs', 'clinical'))

const EVENT = {
  event: 'case',
  case: 'vs-en-01-vitals-block',
  ok: false,
  completion: '{"heart_rate": {"value": 78, "raw_text": "Mrs Ada Whitfield, HR 78 bpm"}}',
  error: 'vital-signs extraction is not valid JSON — got {"heart_rate": {"raw_text": "Mrs Ada Whitfield',
  misses: [{ case: 'c', field: 'heart_rate', reason: 'quote', detail: "raw_text is not in the note: 'Mrs Ada Whitfield, HR 78'" }],
  tally: { detected: 1 },
}

test('a pack that has not declared its corpus synthetic gets its content elided', () => {
  const out = clinicalRedactor(undefined)(EVENT)
  assert.ok(!JSON.stringify(out).includes('Ada Whitfield'), 'no note-derived text survives, in any field')
  assert.match(String(out.completion), /^\[redacted \d+ chars, sha256:[0-9a-f]{16}\]$/)
  assert.match(String((out.misses as { detail: string }[])[0]!.detail), /^\[redacted/)
  // Everything that is NOT content is untouched: a redacted trace is still a trace.
  assert.equal(out.case, 'vs-en-01-vitals-block')
  assert.deepEqual(out.tally, { detected: 1 })
  assert.equal((out.misses as { reason: string }[])[0]!.reason, 'quote')
})

test('false is treated exactly as an absent declaration', () => {
  assert.match(String(clinicalRedactor(false)(EVENT).completion), /^\[redacted/)
})

/** The digest is what keeps a redacted trace useful: two runs stay comparable without the text. */
test('the same completion redacts to the same digest, a different one does not', () => {
  const a = clinicalRedactor(false)(EVENT).completion
  const b = clinicalRedactor(false)({ ...EVENT }).completion
  const c = clinicalRedactor(false)({ ...EVENT, completion: `${EVENT.completion} ` }).completion
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('a pack that states its corpus is synthetic traces verbatim', () => {
  const out = clinicalRedactor(true)(EVENT)
  assert.equal(out.completion, EVENT.completion)
  assert.equal(out, EVENT, 'identity, not a copy — the pack made this decision explicitly')
})

/**
 * The wiring, not just the function. A redactor nobody reaches is the bug this file is about.
 */
test('the clinical profile resolves a redactor for the pack it is given', () => {
  assert.equal(loadSettings(pack).corpusSynthetic, true, 'the reference notes were written for this corpus')
  const forPack = redactor(PROFILE, pack)
  assert.ok(forPack, 'the profile supplies one')
  assert.equal(forPack!(EVENT).completion, EVENT.completion)

  // With no pack in hand — an agent run, a profile with no contracts — nothing has claimed
  // the corpus is synthetic, so the safe reading is the redacting one.
  assert.match(String(redactor(PROFILE, undefined)!(EVENT).completion), /^\[redacted/)
})

test('an event with no content is passed through unharmed', () => {
  const run = { event: 'run', model: 'qwen', constrained: true }
  assert.deepEqual(redactClinical(run), run)
})

/**
 * A SECOND pass writes its reply under a key of its own, and the top-level loop never saw it.
 *
 * This was a real gap rather than a hypothetical: `repair.completion` has been written to
 * every repaired run's trace since the pass existed, and on a pack of real records it went to
 * disk unredacted in the one file whose whole purpose is to be safe to keep. The medication
 * pass writes `medication.completion` in the same shape, so the fix is general and this test
 * is what keeps a third pass from re-opening it.
 */
test('a nested pass completion is elided too, not only the top-level one', () => {
  const event = {
    event: 'case',
    completion: 'the first pass said this',
    repair: { tally: { offered: 1 }, completion: 'the repair said this', error: 'and failed like this' },
    medication: { ran: true, before: 1, after: 3, completion: 'the medication pass said this' },
  }
  const out = redactClinical(event) as any

  assert.match(out.completion, /^\[redacted 24 chars, sha256:/)
  assert.match(out.repair.completion, /^\[redacted 20 chars, sha256:/, 'a repair reply is note-derived text')
  assert.match(out.repair.error, /^\[redacted/, 'and so is the error, which quotes the reply')
  assert.match(out.medication.completion, /^\[redacted 29 chars, sha256:/)

  // Everything that is NOT content survives: a trace redacted into uselessness is one nobody
  // keeps, and the counts are what a later reader compares runs by.
  assert.deepEqual(out.repair.tally, { offered: 1 })
  assert.equal(out.medication.ran, true)
  assert.equal(out.medication.after, 3)
})
