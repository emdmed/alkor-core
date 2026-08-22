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
