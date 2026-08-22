/**
 * The assembly rule, which is the input half of a contract.
 *
 * A task that reads a whole record sends ONE message built from many documents. If two
 * runtimes build it differently they are grading different inputs while appearing to share
 * a prompt — so the rule is data, and these tests are about the ways applying it goes
 * quietly wrong: a cut landing mid-character, a document dropped because the total was
 * checked a line too early, a truncation nobody was told about.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assembleDocument, truncateOnCharBoundary } from '../src/core/assemble.ts'

const RULE = {
  perNoteBytes: 2500,
  totalChars: 10000,
  lineFormat: '{i}.{note_type}-{content}\n',
  truncationMarker: '...[further notes truncated]',
  noteType: 'Progress note',
}

test('the line format is applied verbatim, 1-based', () => {
  const { text, used, truncated } = assembleDocument(['first', 'second'], RULE)
  assert.equal(text, '1.Progress note-first\n2.Progress note-second\n')
  assert.equal(used, 2)
  assert.equal(truncated, false)
})

/**
 * A byte slice is the obvious implementation and the wrong one: clinical Spanish is full of
 * two-byte characters, and a cut between them yields a replacement character here and a
 * panic in a Rust runtime reading the same pack.
 */
test('a per-note cut never splits a character', () => {
  const spanish = 'á'.repeat(10) // 20 bytes
  const cut = truncateOnCharBoundary(spanish, 15)
  assert.equal(cut, 'á'.repeat(7), '15 bytes holds seven whole characters, not seven and a half')
  assert.ok(!cut.includes('�'))
  assert.equal(new TextEncoder().encode(cut).length, 14)
  // An emoji is four bytes and one character; a cap below it yields nothing rather than half.
  assert.equal(truncateOnCharBoundary('🩺', 3), '')
  assert.equal(truncateOnCharBoundary('short', 500), 'short', 'a document under the cap is untouched')
})

test('the note that crosses the total is included whole, and the marker follows it', () => {
  const rule = { ...RULE, totalChars: 30 }
  const { text, used, truncated } = assembleDocument(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc'], rule)
  assert.equal(truncated, true)
  assert.equal(used, 2, 'the second note crossed the line and was kept')
  assert.ok(text.includes('bbbbbbbbbb'), 'checking the total BEFORE appending would have dropped it')
  assert.ok(!text.includes('cccccccccc'))
  assert.ok(text.endsWith(rule.truncationMarker))
})

/**
 * A truncation that reaches the last document is not a truncation: there is nothing left to
 * warn about, and a marker there would tell the model it is reading a prefix of itself.
 */
test('reaching the total on the last note is not reported as truncation', () => {
  const rule = { ...RULE, totalChars: 30 }
  const { text, truncated, used } = assembleDocument(['aaaaaaaaaa', 'bbbbbbbbbb'], rule)
  assert.equal(truncated, false)
  assert.equal(used, 2)
  assert.ok(!text.includes(rule.truncationMarker))
})

test('an empty record assembles to an empty message rather than throwing', () => {
  assert.deepEqual(assembleDocument([], RULE), { text: '', used: 0, truncated: false })
})

/**
 * `String.replace` with a STRING replacement reads `$&`, '$`', `$'` and `$$` as patterns, so
 * a note containing any of them used to assemble into something that was not the note — the
 * literal `{content}` reappearing in the middle of the record. A rule whose entire purpose is
 * that two runtimes assemble identically cannot have a note that rewrites the template.
 */
test('a note containing $-patterns is inserted verbatim', () => {
  const note = 'Cost $& per dose, $$ total, see $` and $1'
  const { text } = assembleDocument([note], RULE)
  assert.ok(text.includes(note), 'the note appears exactly as written')
  assert.ok(!text.includes('{content}'), 'the placeholder was consumed, not resurrected by the replacement')
})
