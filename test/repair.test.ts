/**
 * The repair pass, checked without a model.
 *
 * Everything here is about the same claim, which is the only thing that makes a second turn
 * admissible in a harness whose core forbids one: THE MODEL PROPOSES AND THE VERIFIER
 * DISPOSES. So these tests are mostly about repairs being REFUSED. A pass that accepted a
 * good repair would be easy to write and worth nothing; the value is entirely in what it
 * throws away, and every one of those paths is a silent one — a refused repair looks exactly
 * like a pass that was never run, which is precisely why it needs a test rather than an
 * inspection.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPack } from '../src/core/pack.ts'
import { applyRepair, needsRepair, parseRepairs, repairBriefing, type Repair } from '../src/profiles/clinical/repair.ts'
import {
  readingFromItems,
  verifyReading,
  type ReviewedItem,
} from '../src/profiles/clinical/review-transcript.ts'
import { hasRepairContract, loadSettings, repairSchema, repairSchemaGolden, repairRequest } from '../src/profiles/clinical/contracts.ts'
import type { DerivationRule, QuoteRule } from '../src/core/verify.ts'

const pack = loadPack('packs/clinical')
const QUOTE: QuoteRule = loadSettings(pack).quoteVerification
const DERIVE: DerivationRule = loadSettings(pack).textDerivation

const DOC =
  'Hola, yo tengo un paciente de 28 años con antecedentes de hipertensión, está medicado con ' +
  'enalapril y amblodipina. En alapril 2.5 miligramos cada 8 horas. Viene a control de salud, ' +
  'así que lo cito de vuelta en dos meses.'

/** One item as the first pass left it, verified against DOC. */
const item = (section: string, quote: string, text: string, dose?: string | null): ReviewedItem =>
  verifyReading(
    section === 'current_medication'
      ? { presenting_complaint: null, history: [], plan: [], current_medication: [{ quote, text, dose: dose ?? null }] }
      : section === 'presenting_complaint'
        ? { presenting_complaint: { quote, text }, history: [], plan: [], current_medication: [] }
        : { presenting_complaint: null, history: section === 'history' ? [{ quote, text }] : [], plan: section === 'plan' ? [{ quote, text }] : [], current_medication: [] },
    DOC,
    QUOTE,
    DERIVE,
  )[0]!

const repair = (over: Partial<Repair>): Repair => ({ item: 1, found: true, quote: '', text: '', dose: null, ...over })

const apply = (i: ReviewedItem, r: Repair) => applyRepair(i, r, DOC, QUOTE, DERIVE)

test('the pack declares a repair contract, and it assembles', () => {
  assert.equal(hasRepairContract(pack), true)
  const req = repairRequest(pack, true, DOC)
  assert.ok(req.prompt.length > 500, 'a repair prompt that short is not the file')
  assert.equal(req.schemaName, 'quote_repair')
  assert.ok(req.schema, 'the constrained arm must send the schema')
})

test('the repair schema serializes to its golden', () => {
  assert.equal(JSON.stringify(repairSchema(pack)), repairSchemaGolden(pack).trim())
})

/**
 * The case this whole pass was built for: a citation reworded rather than copied.
 *
 * "tiene antecedentes de" for "con antecedentes de" — the same claim, one substituted word,
 * and an item a clinician cannot see anchored anywhere.
 */
test('a reworded citation is repaired, and the item says what it used to be', () => {
  const before = item('history', 'tiene antecedentes de hipertensión', 'hipertensión')
  assert.equal(before.verification.quote.drift, 'absent')
  assert.equal(needsRepair(before), true)

  const after = apply(before, repair({ quote: 'con antecedentes de hipertensión', text: 'hipertensión' }))
  assert.ok(after, 'a quote that IS in the transcript must be accepted')
  assert.equal(after.verification.quote.ok, true)
  assert.equal(after.repaired, true)
  // The audit trail is the point: a verified quote must be able to say what it replaced.
  assert.equal(after.before?.quote, 'tiene antecedentes de hipertensión')
  assert.equal(after.before?.verification.quote.drift, 'absent')
  assert.equal(after.section, before.section, 'a repair may never move an item')
})

test('a repair whose quote is ALSO not in the transcript is refused', () => {
  const before = item('history', 'tiene antecedentes de hipertensión', 'hipertensión')
  // Plausible, clinical, and never said.
  assert.equal(apply(before, repair({ quote: 'refiere antecedentes de hipertensión', text: 'hipertensión' })), null)
})

/**
 * The failure mode this pass actually produced on the first live run, before the prompt named
 * it: two real fragments joined with the words between them dropped. It reads perfectly and
 * the recording does not contain it.
 */
test('a quote stitched from two non-adjacent fragments is refused', () => {
  const before = item('current_medication', 'está medicado con enalapril y amblodipina', 'enalapril', '2.5 miligramos cada 8 horas')
  assert.equal(before.verification.dose?.ok, false)
  const stitched = 'está medicado con enalapril y amblodipina 2.5 miligramos cada 8 horas'
  assert.equal(apply(before, repair({ quote: stitched, text: 'enalapril', dose: '2.5 miligramos cada 8 horas' })), null)
})

test('widening the quote across a full stop is accepted, because the span is really there', () => {
  const before = item('current_medication', 'está medicado con enalapril y amblodipina', 'enalapril', '2.5 miligramos cada 8 horas')
  const wide = 'está medicado con enalapril y amblodipina. En alapril 2.5 miligramos cada 8 horas'
  const after = apply(before, repair({ quote: wide, text: 'enalapril', dose: '2.5 miligramos cada 8 horas' }))
  assert.ok(after)
  assert.equal(after.verification.quote.ok, true)
  assert.equal(after.verification.dose?.ok, true)
})

/**
 * A repair that fixes one check by breaking another is not an improvement, and the tally must
 * not be able to call it one.
 */
test('a repair that fixes the quote and breaks the text is refused', () => {
  const before = item('history', 'tiene antecedentes de hipertensión', 'hipertensión')
  // Real span, but the text no longer derives from it.
  assert.equal(apply(before, repair({ quote: 'Viene a control de salud', text: 'hipertensión' })), null)
})

test('an unchanged proposal is refused rather than recorded as a repair', () => {
  const before = item('plan', 'lo cito de vuelta en dos meses', 'revisión en dos meses')
  assert.equal(before.verification.text.ok, false)
  assert.equal(apply(before, repair({ quote: 'lo cito de vuelta en dos meses', text: 'revisión en dos meses' })), null)
})

test('deleting the invented word instead of widening the span is a repair', () => {
  const before = item('plan', 'lo cito de vuelta en dos meses', 'revisión en dos meses')
  const after = apply(before, repair({ quote: 'lo cito de vuelta en dos meses', text: 'cito de vuelta en dos meses' }))
  assert.ok(after)
  assert.equal(after.verification.text.ok, true)
})

/**
 * The one thing the verifier genuinely cannot catch on its own: both drugs are real spans of
 * this transcript, so a swap verifies perfectly and changes what the record says the patient
 * takes.
 */
test('a repair that quietly becomes a different item is refused even though it verifies', () => {
  // A reworded citation, so the item genuinely needs repairing — "toma" for "está medicado con".
  const before = item('current_medication', 'toma enalapril y amblodipina', 'enalapril', null)
  assert.equal(before.verification.quote.drift, 'absent')
  const swapped = apply(before, repair({ quote: 'está medicado con enalapril y amblodipina', text: 'amblodipina' }))
  assert.equal(swapped, null, 'a proposal sharing no word with the item it replaces is not a repair')
  // The same span, keeping the subject, is accepted — so the guard is not simply refusing.
  const kept = apply(before, repair({ quote: 'está medicado con enalapril y amblodipina', text: 'enalapril' }))
  assert.ok(kept)
})

test('a dose dropped to null is not counted as an improvement', () => {
  const before = item('current_medication', 'está medicado con enalapril y amblodipina', 'enalapril', '2.5 miligramos cada 8 horas')
  // Losing the dose removes the failing check without citing anything: a fact leaves the
  // record and the tally would otherwise read as a success.
  assert.equal(apply(before, repair({ quote: 'está medicado con enalapril y amblodipina', text: 'enalapril', dose: null })), null)
})

test('items back into a reading round-trip through verifyReading', () => {
  const reading = {
    presenting_complaint: { quote: 'Viene a control de salud', text: 'control de salud' },
    history: [{ quote: 'con antecedentes de hipertensión', text: 'hipertensión' }],
    plan: [{ quote: 'lo cito de vuelta en dos meses', text: 'cito de vuelta en dos meses' }],
    current_medication: [{ quote: 'está medicado con enalapril y amblodipina', text: 'enalapril', dose: null }],
  }
  assert.deepEqual(readingFromItems(verifyReading(reading, DOC, QUOTE, DERIVE)), reading)
})

test('the briefing names the fault per item rather than leaving it to be re-derived', () => {
  const items = [
    item('history', 'tiene antecedentes de hipertensión', 'hipertensión'),
    item('plan', 'lo cito de vuelta en dos meses', 'revisión en dos meses'),
  ]
  const brief = repairBriefing(DOC, items)
  assert.match(brief, /NOT IN THE TRANSCRIPT/)
  assert.match(brief, /TEXT NOT DERIVED/)
  assert.match(brief, /'revisión'/)
  assert.ok(brief.includes(DOC.trim()), 'the whole transcript, so "nowhere in it" is answerable')
})

test('a reply about an item nobody asked about parses, and repairs nothing', () => {
  const { repairs } = parseRepairs(JSON.stringify({ repairs: [{ item: 9, found: true, quote: 'x', text: 'y', dose: null }] }))
  assert.equal(repairs.length, 1)
  assert.equal(repairs[0]!.item, 9)
})

test('a found:false entry parses without a quote, because there is nothing to quote', () => {
  const { repairs } = parseRepairs(JSON.stringify({ repairs: [{ item: 1, found: false, quote: '', text: '', dose: null }] }))
  assert.equal(repairs[0]!.found, false)
})

test('a reply that is not a repair list is refused with a diagnosis', () => {
  assert.throws(() => parseRepairs('{"items":[]}'), /no 'repairs' array/)
  assert.throws(() => parseRepairs('not json'), /not JSON/)
  assert.throws(
    () => parseRepairs(JSON.stringify({ repairs: [{ item: 1, found: true, dose: null }] })),
    /no string quote\/text/,
  )
})
