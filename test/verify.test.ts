/**
 * Provenance checking, which is the one check in the harness that must not be permissive.
 *
 * Every test here is a way a verifier passes something it should have caught: an empty quote
 * that is a substring of everything, a corrupted drug name inside a perfect citation, a
 * regex-flavoured character that a pattern-based check would have mis-escaped.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyDerivation, verifyQuote } from '../src/core/verify.ts'

const RULE = { collapseWhitespace: true, caseSensitive: true, accentSensitive: true }
const NOTE = `Attends with a productive cough.
Started ceftriaxona 2 g every 24 hours; review in 48 hours.
BP 118/76 mmHg (seated), SpO2 96 % on air.`

test('a quote spanning a line break still verifies', () => {
  const v = verifyQuote('productive cough. Started ceftriaxona 2 g', NOTE, RULE)
  assert.equal(v.ok, true, 'the notes are hard-wrapped; without collapsing this measures the wrapping')
})

test('an edited capital is named apart from an invented sentence', () => {
  const edited = verifyQuote('attends with a productive cough', NOTE, RULE)
  assert.deepEqual(edited, { ok: false, drift: 'case' }, 'tidied, not fabricated')

  const invented = verifyQuote('Attends with severe chest pain', NOTE, RULE)
  assert.deepEqual(invented, { ok: false, drift: 'absent' }, 'absent under any relaxation')

  // The same edit passes when the pack says case is not part of the claim.
  assert.equal(verifyQuote('attends with a productive cough', NOTE, { ...RULE, caseSensitive: false }).ok, true)
})

/**
 * The drift is named per DIMENSION because a pack may care about one and not the other, and
 * because the two are different habits: a lowercased capital is a model being tidy, a dropped
 * accent is a model transliterating a language it is reading. Permitting one must not permit
 * the other, which is the whole reason the verdict says which happened.
 */
test('a dropped accent is its own drift, and its own decision', () => {
  const es = 'Constantes: Presión arterial 138/86 mmHg, frecuencia 82 lpm.'
  assert.deepEqual(verifyQuote('Presion arterial 138/86', es, RULE), { ok: false, drift: 'accent' })
  assert.deepEqual(verifyQuote('presion arterial 138/86', es, RULE), { ok: false, drift: 'case+accent' })

  const loose = { ...RULE, accentSensitive: false }
  assert.equal(verifyQuote('Presion arterial 138/86', es, loose).ok, true, 'the pack accepted this one')
  assert.equal(
    verifyQuote('presion arterial 138/86', es, loose).ok,
    false,
    'accents forgiven, capitals not — a pack permits what it permits, not what is nearby',
  )
  assert.equal(verifyQuote('Presión arterial 138/86', es, RULE).ok, true, 'copied as written')
})

/**
 * `''` is a substring of every document, so the permissive reading would make an empty
 * citation the safest output a model could produce — a perfect provenance score for saying
 * nothing.
 */
test('an empty quote fails rather than vacuously passing', () => {
  assert.equal(verifyQuote('', NOTE, RULE).ok, false)
  assert.equal(verifyQuote('   \n  ', NOTE, RULE).ok, false)
})

/**
 * The characters that would have to be escaped in a pattern. A regex-based verifier gets
 * this wrong in the direction that passes, which is why the check is literal containment.
 */
test('regex metacharacters in a quote are matched literally', () => {
  assert.equal(verifyQuote('BP 118/76 mmHg (seated)', NOTE, RULE).ok, true)
  assert.equal(verifyQuote('SpO2 96 % on air', NOTE, RULE).ok, true)
  // A quote that WOULD match if it were read as a pattern must still fail as a string.
  assert.equal(verifyQuote('BP 118.76 mmHg', NOTE, RULE).ok, false)
})

// --- derivation -------------------------------------------------------------------------

const DELETION = { deletionOnly: true }
const QUOTE = 'Started ceftriaxona 2 g every 24 hours; review in 48 hours'

test('a text that deletes machinery from its quote is derived from it', () => {
  assert.deepEqual(verifyDerivation('ceftriaxona 2 g every 24 hours', QUOTE, DELETION), { ok: true })
  assert.deepEqual(verifyDerivation('ceftriaxona', QUOTE, DELETION), { ok: true })
  // Punctuation and a leading capital are not words: an item may end without the semicolon.
  assert.deepEqual(verifyDerivation('Ceftriaxona 2 g', QUOTE, DELETION), { ok: true })
})

/**
 * The measured failure this rule exists for, on a sibling pack: a quote that verifies
 * character for character, beside an item naming a drug that does not exist.
 */
test('a corrupted drug name fails even inside a perfect quote', () => {
  const v = verifyDerivation('ceptriaxona 2 g every 24 hours', QUOTE, DELETION)
  assert.equal(v.ok, false)
  assert.equal(v.ok === false && v.reason, 'introduced')
  assert.equal(v.ok === false && v.token, 'ceptriaxona', 'the offending token is reported, not just the failure')
})

test('a reordering is refused, and named as its own mistake', () => {
  const v = verifyDerivation('24 hours every', QUOTE, DELETION)
  assert.equal(v.ok, false)
  assert.equal(v.ok === false && v.reason, 'reordered', 'every word is present; the claim still changed')
})

test('a connective the model added is an introduction, however harmless it reads', () => {
  const v = verifyDerivation('started on ceftriaxona', QUOTE, DELETION)
  assert.equal(v.ok, false)
  assert.equal(v.ok === false && v.token, 'on')
})

test('with the rule off, nothing is checked — and the pack has to say so', () => {
  assert.deepEqual(verifyDerivation('anything at all', QUOTE, { deletionOnly: false }), { ok: true })
})

test('NFC/NFD equivalent text is treated as identical', () => {
  const nfc = 'Presión arterial 138/86 mmHg, frecuencia 82 lpm.'
  const nfd = 'Presio\u0301n arterial 138/86 mmHg, frecuencia 82 lpm.'
  assert.equal(verifyQuote('Presión arterial 138/86', nfc, RULE).ok, true, 'NFC quote against NFC document')
  assert.equal(verifyQuote('Presión arterial 138/86', nfd, RULE).ok, true, 'NFC quote against NFD document')
  assert.equal(verifyQuote('Presio\u0301n arterial 138/86', nfc, RULE).ok, true, 'NFD quote against NFC document')
  assert.equal(verifyQuote('Presion arterial 138/86', nfd, RULE).drift, 'accent')
})
