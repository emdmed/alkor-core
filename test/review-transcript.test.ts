/**
 * The interactive path for the dictated-transcript contract — one transcript in, one
 * verified reading out.
 *
 * Nothing here starts a server, for the same reason `review.test.ts` does not: what is
 * checkable without a model is the part that decides whether a reading can be trusted. The
 * additional thing this file has to check, and the reason it exists apart from that one, is
 * that the review and the eval verify by the SAME rules. A second implementation of this
 * contract is compared against what `extract --task transcript --json` produces, so a review
 * that checked quotes more leniently than the eval would hand a Rust runtime a fixture that
 * agrees with nothing anybody measured.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { loadPack } from '../src/core/pack.ts'
import { requireDocumentName, ProfileError } from '../src/core/profile.ts'
import { loadSettings } from '../src/profiles/clinical/settings.ts'
import { formatRequest, transcriptRequest } from '../src/profiles/clinical/contracts.ts'
import type { NoteFormat } from '../src/profiles/clinical/extraction.ts'
import { PROFILE } from '../src/profiles/clinical/profile.ts'
import { scoreFormatCase } from '../src/profiles/clinical/set-scorer.ts'
import { renderTranscriptReading, tallyReviewed, transcriptDocumentNames, verifyReading, type TranscriptReport } from '../src/profiles/clinical/review-transcript.ts'

const pack = loadPack(join(import.meta.dirname, '..', 'packs', 'clinical'))
const settings = loadSettings(pack)
const RULES = { quote: settings.quoteVerification, derivation: settings.textDerivation }

const TRANSCRIPT =
  'right dictating on mister alan reid he came in with a cough for three weeks comma ' +
  'background of copd period start him on amoxicillin 500 mg three times a day for five days'

const reading = (over: Partial<NoteFormat> = {}): NoteFormat => ({
  presenting_complaint: { quote: 'he came in with a cough for three weeks', text: 'cough for three weeks' },
  history: [{ quote: 'background of copd period', text: 'copd' }],
  plan: [],
  current_medication: [
    {
      quote: 'start him on amoxicillin 500 mg three times a day for five days',
      text: 'amoxicillin',
      dose: '500 mg three times a day',
    },
  ],
  ...over,
})

/**
 * The one property that makes the output a reference rather than an opinion: the eval and the
 * review assemble the same request. Not "an equivalent" one — the same call, so a drift would
 * have to be a change to `transcriptRequest` itself.
 */
test('the transcript eval and the transcript review assemble the same request', () => {
  const a = transcriptRequest(pack, true)
  const b = transcriptRequest(pack, true)
  assert.equal(a.prompt, b.prompt)
  assert.equal(a.schemaName, b.schemaName)
  assert.deepEqual(a.sampling, b.sampling)
  // Shares the note-format SCHEMA and not its label. A pinned body must still say which task
  // sent it, or a server log cannot tell two tasks apart that emit one contract.
  assert.equal(JSON.stringify(a.schema), JSON.stringify(formatRequest(pack, true).schema))
  assert.notEqual(a.schemaName, formatRequest(pack, true).schemaName)
})

test('the unconstrained arm carries no schema, and the constrained one does', () => {
  assert.equal(transcriptRequest(pack, false).schema, undefined)
  assert.ok(transcriptRequest(pack, true).schema)
})

/**
 * The check with teeth. Both paths run over one reading and must agree item for item about
 * what verified — the review counting a quote the eval refused is a fixture that describes a
 * runtime nobody measured.
 */
test('the review verifies exactly what the eval scores, item for item', () => {
  const got = reading({
    history: [
      { quote: 'background of copd period', text: 'copd' },
      // Absent: no relaxation of case or accents finds this. The eval calls it a fabricated
      // span; so must this.
      { quote: 'he has type 2 diabetes', text: 'type 2 diabetes' },
    ],
    // Introduced word: every check the quote passes, and the item still says something the
    // speaker did not.
    plan: [{ quote: 'for five days', text: 'review in five days' }],
  })

  const items = verifyReading(got, TRANSCRIPT, RULES.quote, RULES.derivation)
  const t = tallyReviewed(items)
  // No answer key: `fields` is empty, so the set half scores nothing and only the provenance
  // half of the tally is being compared. That is the half a review can produce.
  const scored = scoreFormatCase('t', [], got, TRANSCRIPT, RULES)

  assert.equal(t.items, scored.tally.quotes)
  assert.equal(t.quotesVerified, scored.tally.quotesVerified)
  assert.equal(t.quotesEditedOnly, scored.tally.quotesEditedOnly)
  assert.equal(t.derivationsChecked, scored.tally.derivations)
  assert.equal(t.derivationsOk, scored.tally.derivationsOk)
  assert.equal(t.quotesAbsent, 1, 'the invented span is named as invented')
})

/**
 * Derivation is checked against the quote the model GAVE, even when that quote failed
 * verification. Two independent questions — is the span real, is the item an edit of it — and
 * a review that skipped the second for a failed first would hide the compound failure, where a
 * model invents a span and then derives something else from it.
 */
test('a failed quote does not excuse its item from the derivation check', () => {
  const items = verifyReading(
    reading({ history: [{ quote: 'he has a documented penicillin allergy', text: 'penicillin allergy' }] }),
    TRANSCRIPT,
    RULES.quote,
    RULES.derivation,
  )
  const h = items.find((i) => i.section === 'history')!
  assert.equal(h.verification.quote.ok, false)
  assert.equal(h.verification.quote.drift, 'absent')
  assert.equal(h.verification.text.ok, true, 'the item is still an honest deletion from the span it cites')
})

test('a dose is verified against its own item quote, and named when it is not derived', () => {
  const items = verifyReading(
    reading({
      current_medication: [
        {
          quote: 'start him on amoxicillin 500 mg three times a day for five days',
          text: 'amoxicillin',
          dose: '500 mg every 8 hours',
        },
      ],
    }),
    TRANSCRIPT,
    RULES.quote,
    RULES.derivation,
  )
  const m = items.find((i) => i.section === 'current_medication')!
  assert.equal(m.verification.quote.ok, true)
  assert.equal(m.verification.text.ok, true)
  assert.equal(m.verification.dose?.ok, false)
  assert.equal(m.verification.dose?.reason, 'introduced')
  assert.equal(m.verification.dose?.token, 'every')
})

test('a medication with no dose is not counted as a derivation that passed', () => {
  const withDose = tallyReviewed(verifyReading(reading(), TRANSCRIPT, RULES.quote, RULES.derivation))
  const without = tallyReviewed(
    verifyReading(
      reading({
        current_medication: [
          { quote: 'start him on amoxicillin 500 mg three times a day for five days', text: 'amoxicillin', dose: null },
        ],
      }),
      TRANSCRIPT,
      RULES.quote,
      RULES.derivation,
    ),
  )
  assert.equal(withDose.derivationsChecked - without.derivationsChecked, 1)
})

/**
 * Items in DECODE order — the order the grammar makes the model emit and the order the parser
 * reads. What a clinician should see first is a question for an interface; a fixture that
 * answered it would make a byte comparison depend on somebody's taste.
 */
test('the reviewed items are in decode order, not display order', () => {
  const items = verifyReading(
    reading({ plan: [{ quote: 'for five days', text: 'five days' }] }),
    TRANSCRIPT,
    RULES.quote,
    RULES.derivation,
  )
  assert.deepEqual(
    items.map((i) => i.section),
    ['presenting_complaint', 'history', 'plan', 'current_medication'],
  )
})

/**
 * An empty section is printed. Three cases in this corpus have an empty section as their
 * correct answer, and a report that showed only the sections with content would read as a
 * complete account of the consultation while being a list of the model's successes.
 */
test('every section is printed, including the empty ones', () => {
  const items = verifyReading(reading(), TRANSCRIPT, RULES.quote, RULES.derivation)
  const report = { items, totals: tallyReviewed(items) } as TranscriptReport
  const text = renderTranscriptReading(report)
  for (const section of ['presenting_complaint', 'history', 'plan', 'current_medication']) {
    assert.ok(text.includes(section), `${section} is missing from the report`)
  }
  assert.match(text, /plan\n {2}— none/, 'the empty section says so rather than being absent')
})

test('a flagged reading tells the reader to check it', () => {
  const items = verifyReading(
    reading({ history: [{ quote: 'he has type 2 diabetes', text: 'type 2 diabetes' }] }),
    TRANSCRIPT,
    RULES.quote,
    RULES.derivation,
  )
  const text = renderTranscriptReading({ items, totals: tallyReviewed(items) } as TranscriptReport)
  assert.match(text, /NOT in the transcript at all/)
  assert.match(text, /check the flagged items/)
})

// --- Which corpus `--case` reaches ---------------------------------------------------------

/**
 * The failure this would otherwise become in production: `documents` is a path TEMPLATE, so a
 * case name that belongs to the other corpus is not a lookup failure — it is a filesystem read
 * of a path nobody typed.
 */
test('--task transcript selects the transcript corpus, and nothing else does', () => {
  const names = transcriptDocumentNames(pack)
  assert.equal(names.length, 20)
  assert.ok(names.includes('tr-en-02-self-correction'))

  assert.equal(
    requireDocumentName(PROFILE, pack, 'tr-en-02-self-correction', { task: 'transcript' }),
    'tr-en-02-self-correction',
  )
  assert.throws(
    () => requireDocumentName(PROFILE, pack, 'tr-en-02-self-correction', {}),
    ProfileError,
    'a transcript must not be reachable from the note tasks',
  )
})

/**
 * Refused rather than defaulted. A typo that silently read vital signs would hand back a
 * reading against a schema nobody asked for, and it would look exactly like a successful run
 * of the task they wanted.
 */
test('a task that cannot be reviewed says why rather than falling back', async () => {
  await assert.rejects(
    () => PROFILE.review!({ pack, trace: { write() {}, close() {} } as never, input: { kind: 'text', text: '' }, options: { task: 'summary' } }),
    (e: Error) => e instanceof ProfileError && /assembled from many notes/.test(e.message),
  )
  await assert.rejects(
    () => PROFILE.review!({ pack, trace: { write() {}, close() {} } as never, input: { kind: 'text', text: '' }, options: { task: 'trasncript' } }),
    (e: Error) => e instanceof ProfileError && /unknown --task/.test(e.message),
  )
})
