/**
 * The interactive extraction path — one note in, one reading out.
 *
 * Nothing here starts a server. What is checkable without a model is the part that decides
 * whether a reading can be trusted: that every slot is accounted for in the report, that a
 * quote is verified against the note it claims to come from, and that the document a
 * `--case` selects is one the pack actually holds.
 *
 * The last of those is the one that would otherwise be found in production. `documents` is
 * a path TEMPLATE, so a mistyped case name is not a lookup failure — it is a filesystem
 * read of a path nobody typed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { loadPack } from '../src/core/pack.ts'
import { requireDocumentName, ProfileError, type ProfileModule } from '../src/core/profile.ts'
import { gradedFields, vitalRequest } from '../src/profiles/clinical/contracts.ts'
import { loadSettings } from '../src/profiles/clinical/settings.ts'
import type { VitalSigns } from '../src/profiles/clinical/extraction.ts'
import { PROFILE } from '../src/profiles/clinical/profile.ts'
import { checkQuote, renderReading, vitalDocumentNames } from '../src/profiles/clinical/review.ts'

const pack = loadPack(join(import.meta.dirname, '..', 'packs', 'clinical'))
const fields = gradedFields(pack)
// The rule the PACK declares, which is the one the eval grades under. A review that judged
// its quotes by anything else would report a provenance the measured number does not describe.
const RULE = loadSettings(pack).quoteVerification

const NOTE = 'Vitals: BP 148/92 mmHg, HR 78 bpm.\nPatient comfortable at rest.'

/**
 * The reading is assembled the same way for the graded path and the used path. If these
 * two ever differ, `eval` is measuring a prompt, a schema or a cap that `extract` does not
 * run — which is the one claim this repository makes about its own numbers.
 */
test('the eval and the review assemble the same request', () => {
  const a = vitalRequest(pack, true)
  const b = vitalRequest(pack, true)
  assert.equal(JSON.stringify(a.schema), JSON.stringify(b.schema))
  assert.equal(a.prompt, b.prompt)
  assert.equal(a.schemaName, b.schemaName)
  assert.deepEqual(a.sampling, b.sampling)
})

test('the unconstrained arm carries no schema, and the constrained one does', () => {
  assert.equal(vitalRequest(pack, false).schema, undefined)
  assert.ok(vitalRequest(pack, true).schema)
})

/**
 * A report that listed only what was found would read as a complete account of the note
 * while being a list of the model's successes — and the slot a clinician needs is the one
 * nobody printed.
 */
test('every slot appears in the report, including the ones with nothing in them', () => {
  const vitals: VitalSigns = Object.fromEntries(fields.map((f) => [f.name, null]))
  vitals.blood_pressure = { systolic: 148, diastolic: 92, unit: 'mmHg', raw_text: 'BP 148/92 mmHg' }
  const text = renderReading(fields, vitals, NOTE, RULE)

  for (const f of fields) assert.ok(text.includes(f.name), `${f.name} is missing from the report`)
  assert.match(text, /148\/92 mmHg/)
  assert.match(text, /1 of \d+ slots read/)
  // Every unread slot says so in words rather than by omission.
  assert.equal(text.match(/not in the note/g)?.length, fields.length - 1)
})

/**
 * The check no grammar can perform: no JSON Schema keyword says "substring of the prompt",
 * and GBNF has no back-reference to the context.
 */
test('a quote that is not in the note is reported as unverified, not as a reading', () => {
  const vitals: VitalSigns = Object.fromEntries(fields.map((f) => [f.name, null]))
  vitals.heart_rate = { value: 78, unit: 'bpm', raw_text: 'the heart rate was documented as 78' }
  const text = renderReading(fields, vitals, NOTE, RULE)

  assert.match(text, /UNVERIFIED/)
  assert.match(text, /1 NOT verified/)
  // The value is still shown. It may well be right; what is not established is the evidence.
  assert.match(text, /78 bpm/)
})

test('a reading with no quote at all names the contract it did not meet', () => {
  const vitals: VitalSigns = Object.fromEntries(fields.map((f) => [f.name, null]))
  vitals.heart_rate = { value: 78, unit: 'bpm' }
  assert.match(renderReading(fields, vitals, NOTE, RULE), /NO QUOTE/)
})

test('a quote spanning a line break still matches the note it came from', () => {
  const across = 'Vitals: BP 148/92 mmHg,\n   HR 78 bpm.'
  assert.equal(checkQuote({ value: 78, unit: 'bpm', raw_text: 'HR 78 bpm' }, across, RULE), 'quoted')
})

/**
 * A Spanish note is where this bites, and the pack decides what it means. Under THIS pack's
 * rule — copy it character for character — a quote that drops the accent and lowercases the
 * capital is an edit, so it does not verify. What it must never be called is a fabrication:
 * the sentence is in the note, the model just tidied it, and those are different accusations
 * with different fixes. The eval counts this row apart for exactly that reason.
 */
test('an accent dropped from a quote is an edit, not an invention', () => {
  const es = 'Constantes: Presión arterial 138/86 mmHg.'
  const drifted = { systolic: 138, diastolic: 86, raw_text: 'presion arterial 138/86' }
  assert.equal(checkQuote(drifted, es, RULE), 'edited')
  assert.equal(checkQuote({ ...drifted, raw_text: 'Presión arterial 138/86' }, es, RULE), 'quoted')
  // A pack that would rather not grade its models on typography says so, and gets the
  // reading it asked for from the same function.
  assert.equal(checkQuote(drifted, es, { ...RULE, caseSensitive: false, accentSensitive: false }), 'quoted')
})

test('the pack offers its case names as documents that can be asked for', () => {
  const names = vitalDocumentNames(pack)
  assert.ok(names.includes('vs-en-01-vitals-block'))
  assert.equal(names.length, new Set(names).size, 'two documents share a name')
  assert.deepEqual(PROFILE.documentNames!(pack), names)
})

test('an unknown --case lists what the pack does hold', () => {
  assert.throws(
    () => requireDocumentName(PROFILE, pack, 'vs-en-01'),
    (e: Error) => {
      assert.ok(e instanceof ProfileError)
      assert.match(e.message, /no document 'vs-en-01'/)
      assert.match(e.message, /vs-en-01-vitals-block/)
      return true
    },
  )
})

test('a known --case is accepted unchanged', () => {
  assert.equal(requireDocumentName(PROFILE, pack, 'vs-en-05-no-vitals'), 'vs-en-05-no-vitals')
})

/** A profile with no named documents is a different mistake, and --note is the answer. */
test('a profile exposing no documents says so instead of listing nothing', () => {
  const bare = { name: 'bare', mode: 'extract', needsPack: true, runEval: async () => ({ pass: true, summary: '' }) }
  assert.throws(
    () => requireDocumentName(bare as ProfileModule, pack, 'anything'),
    /exposes no named documents.*--note/s,
  )
})
