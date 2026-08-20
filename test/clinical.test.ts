/**
 * The reference pack's contract, checked without a model.
 *
 * Everything here is about the pack agreeing with itself. None of it starts a server, and
 * none of it asserts that any model scored anything — those numbers belong to a machine
 * with weights on it and are quoted only where they were measured.
 *
 * The pack ships in this repository, so unlike a parity test against somebody else's
 * contracts these do not skip. If they fail, the corpus is inconsistent and every number
 * measured on it afterwards is uninterpretable.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadPack } from '../src/core/pack.ts'
import {
  gradedExpectations,
  gradedFields,
  loadSampling,
  loadSettings,
  loadVitalCases,
  vitalPrompt,
  vitalSchema,
  vitalSchemaGolden,
} from '../src/profiles/clinical/contracts.ts'
import { parseVitalSigns } from '../src/profiles/clinical/extraction.ts'
import { scoreCase, norm } from '../src/profiles/clinical/scorer.ts'

const pack = loadPack(join(import.meta.dirname, '..', 'packs', 'clinical'))
const fields = gradedFields(pack)
const { cases, fieldRecallFloor } = loadVitalCases(pack, fields)

test('the pack declares the spec version this harness reads', () => {
  assert.equal(pack.spec, 1)
})

/**
 * Property order is compiled into the GBNF grammar, so the model is forced to emit the
 * properties in this order. Deep-equality would call a reordering identical; the bytes do
 * not, which is the only reason the golden exists.
 */
test('the schema serializes to its golden', () => {
  assert.equal(JSON.stringify(vitalSchema(pack)), vitalSchemaGolden(pack).trim())
})

/**
 * The slot list is DERIVED from the schema rather than written down twice. This asserts
 * the derivation still finds what the corpus was authored against — if a schema edit
 * changed the set, the denominator would move silently and every percentage after it would
 * be a percentage of something else.
 */
test('the gradeable slots are derived from the schema, in schema order', () => {
  assert.deepEqual(
    fields.map((f) => f.name),
    [
      'blood_pressure',
      'heart_rate',
      'temperature',
      'weight',
      'height',
      'oxygen_saturation',
      'respiratory_rate',
      'blood_glucose',
      'bmi',
    ],
  )
  // Shape, not name, is what makes a slot gradeable — and what makes exactly one of them
  // a two-number reading.
  assert.deepEqual(
    fields.filter((f) => f.shape === 'bloodPressure').map((f) => f.name),
    ['blood_pressure'],
  )
})

test('extraction_confidence and notes are metadata, never graded', () => {
  const schema = vitalSchema(pack) as { properties: Record<string, unknown> }
  for (const meta of ['extraction_confidence', 'notes']) {
    assert.ok(meta in schema.properties, `${meta} should be in the schema`)
    assert.ok(!fields.some((f) => f.name === meta), `${meta} must not be gradeable`)
  }
})

test('every case names a note that exists', () => {
  for (const c of cases) {
    const path = join(pack.root, 'notes', `${c.name}.note.txt`)
    assert.ok(existsSync(path), `${c.name} has no note at ${path}`)
    assert.ok(pack.document(c.name).length > 100, `${c.name}'s note is suspiciously short`)
  }
})

test('every case accounts for every slot, exactly once', () => {
  for (const c of cases) {
    assert.equal(c.fields.length, fields.length, `${c.name} does not account for all ${fields.length} slots`)
    assert.equal(new Set(c.fields.map((f) => f.field)).size, fields.length, `${c.name} has a duplicate field`)
  }
})

/**
 * The denominator the floor was authored against. Pinned because a percentage of a total
 * nobody intended is the failure mode this whole file exists to prevent: it does not look
 * like an error, it looks like a score.
 */
test('the graded denominator is what the floor was authored against', () => {
  assert.equal(cases.length, 12)
  assert.equal(gradedExpectations(cases), 46)
  assert.equal(fieldRecallFloor, 0.9)
})

test('the corpus keeps its discriminating classes', () => {
  const classes = new Set(cases.map((c) => c.class))
  // Each of these is a distinct way for an extractor to fail, and a corpus that loses one
  // stops being able to tell that failure from success.
  for (const needed of ['block', 'units', 'prose', 'temporal', 'none', 'qualitative', 'language', 'repeat', 'negative-controls', 'extreme', 'derived']) {
    assert.ok(classes.has(needed), `the corpus no longer covers '${needed}'`)
  }
  // Both halves of the BMI pair, or the control proves nothing.
  assert.ok(cases.some((c) => c.fields.some((f) => f.field === 'bmi' && f.expect.kind === 'value')))
  assert.ok(cases.some((c) => c.fields.some((f) => f.field === 'bmi' && f.expect.kind === 'absent')))
})

/**
 * No placeholders is what keeps these bytes identical across every note, which is what
 * lets `cache_prompt` reuse the KV cache — and what would make a byte comparison against a
 * second runtime mean anything.
 */
test('the prompt carries no placeholders', () => {
  assert.doesNotMatch(vitalPrompt(pack), /\{\{[A-Z0-9_]+\}\}/)
})

/**
 * The prompt's worked examples must not contain a corpus answer. An example that happens
 * to carry the reading a case expects turns that case into a memory test, and the eval
 * would report a score the model did not earn. This caught a real one: an example used
 * `155 mg/dL`, which is exactly what vs-es-08 expects.
 */
test('the prompt does not leak a corpus answer', () => {
  const prompt = vitalPrompt(pack)
  for (const c of cases) {
    for (const e of c.fields) {
      if (e.expect.kind === 'bp') {
        const pair = `${e.expect.systolic}/${e.expect.diastolic}`
        assert.ok(!prompt.includes(pair), `the prompt contains ${c.name}'s answer '${pair}'`)
      } else if (e.expect.kind === 'value') {
        const reading = `${e.expect.value} ${e.expect.unit}`
        assert.ok(!norm(prompt).includes(norm(reading)), `the prompt contains ${c.name}'s answer '${reading}'`)
      }
    }
  }
})

test('sampling comes from the pack, not from a default', () => {
  const s = loadSampling(pack, 'vital_signs')
  assert.equal(s.temperature, 0, 'a graded task must be deterministic')
  assert.ok(s.max_tokens > 0 && s.max_tokens <= 4096)
  assert.throws(() => loadSampling(pack, 'no-such-task'), /declares no \[sampling\.no-such-task\]/)
})

test('the schema label the request carries is declared, not invented', () => {
  assert.equal(loadSettings(pack).vitalSignsSchemaName, 'vital_signs')
})

// --- the parser ------------------------------------------------------------------------

test('a missing key and a null value both mean absent', () => {
  const parsed = parseVitalSigns('{"heart_rate": null}', fields)
  assert.equal(parsed.heart_rate, null)
  assert.equal(parsed.weight, null, 'a key the model omitted is the same absence')
})

test('a measurement without a numeric value is a parse failure, not an absence', () => {
  // Two spellings of "absent" would split the detection count across both and make recall
  // unreadable, so this is refused rather than quietly read as null.
  assert.throws(() => parseVitalSigns('{"heart_rate": {"value": null}}', fields), /needs a numeric value/)
})

test('a half-populated blood pressure is refused', () => {
  assert.throws(
    () => parseVitalSigns('{"blood_pressure": {"systolic": 120}}', fields),
    /needs numeric systolic and diastolic/,
  )
})

test('prose instead of JSON fails with the prose in the message', () => {
  assert.throws(() => parseVitalSigns('I could not find any vital signs.', fields), /not valid JSON/)
})

/**
 * A fenced reply is a distinct failure from an unparseable one and is reported as such.
 * Measured on gemma-3-4b: unconstrained, every reply was fenced and every one held good
 * JSON, so the run scored 0% for a reason unrelated to reading a note. A run that cannot
 * tell those two apart sends someone to debug the wrong thing.
 */
test('a fenced reply is named as a fence, not as broken JSON', () => {
  assert.throws(
    () => parseVitalSigns('```json\n{"heart_rate": null}\n```', fields),
    /wrapped in a markdown code fence/,
  )
})

// --- the scorer ------------------------------------------------------------------------

const caseNamed = (name: string) => cases.find((c) => c.name === name)!

test('a perfect extraction scores every slot and verifies every quote', () => {
  const c = caseNamed('vs-en-01-vitals-block')
  const note = pack.document(c.name)
  const got = {
    blood_pressure: { systolic: 148, diastolic: 92, unit: 'mmHg', raw_text: 'BP 148/92 mmHg' },
    heart_rate: { value: 78, unit: 'bpm', raw_text: 'HR 78 bpm' },
    temperature: { value: 36.4, unit: '°C', raw_text: 'T 36.4 C' },
    weight: { value: 82.5, unit: 'kg', raw_text: 'Weight 82.5 kg' },
    height: { value: 171, unit: 'cm', raw_text: 'Height 171 cm' },
    oxygen_saturation: { value: 97, unit: '%', raw_text: 'SpO2 97%' },
  }
  const { tally, misses } = scoreCase(c, got, note)
  assert.equal(tally.gradedTotal, 6)
  assert.equal(tally.detected, 6)
  assert.equal(tally.valueExact, 6)
  assert.equal(tally.unitExact, 6)
  assert.equal(tally.quoteVerified, 6)
  assert.equal(tally.hallucinations, 0)
  assert.deepEqual(misses, [])
})

test('a value invented where the note has none is a hallucination, not a miss', () => {
  const c = caseNamed('vs-en-05-no-vitals')
  const { tally, misses } = scoreCase(c, { heart_rate: { value: 72, unit: 'bpm' } }, pack.document(c.name))
  assert.equal(tally.gradedTotal, 0, 'this case grades nothing — it can only lose points')
  assert.equal(tally.hallucinations, 1)
  assert.equal(misses[0].reason, 'hallucination')
})

test('a qualitative sign turned into a number is a hallucination', () => {
  const c = caseNamed('vs-en-06-qualitative')
  const got = { temperature: { value: 38.5, unit: '°C', raw_text: 'febrile' }, weight: { value: 64, unit: 'kg', raw_text: 'Weight 64 kg' } }
  const { tally } = scoreCase(c, got, pack.document(c.name))
  assert.equal(tally.hallucinations, 1, "'febrile' is not a temperature")
  assert.equal(tally.detected, 1, 'the weight is still detected')
})

test('a right number with a wrong unit is a unit failure, not a value failure', () => {
  const c = caseNamed('vs-en-02-imperial')
  const got = { temperature: { value: 101.2, unit: '°C', raw_text: 'Temp 101.2 F' } }
  const { tally, misses } = scoreCase(c, got, pack.document(c.name))
  assert.equal(tally.valueExact, 1)
  assert.equal(tally.unitExact, 0)
  assert.equal(misses.filter((m) => m.reason === 'unit').length, 1)
})

test('a half-right blood pressure is wrong', () => {
  const c = caseNamed('vs-en-01-vitals-block')
  const got = { blood_pressure: { systolic: 148, diastolic: 90, unit: 'mmHg', raw_text: 'BP 148/92 mmHg' } }
  const { tally } = scoreCase(c, got, pack.document(c.name))
  assert.equal(tally.detected, 1, 'it was detected')
  assert.equal(tally.valueExact, 0, 'and it is still wrong')
})

/**
 * The check the schema cannot make. A grammar can guarantee that `raw_text` is a string;
 * nothing in JSON Schema or GBNF can say "and it appears in the prompt".
 */
test('provenance catches a right number attached to a fabricated quote', () => {
  const c = caseNamed('vs-en-01-vitals-block')
  const got = { heart_rate: { value: 78, unit: 'bpm', raw_text: 'pulse was 78 and regular' } }
  const { tally, misses } = scoreCase(c, got, pack.document(c.name))
  assert.equal(tally.valueExact, 1, 'the number is right')
  assert.equal(tally.quoteVerified, 0, 'the sentence it claims to come from is not in the note')
  assert.equal(misses.find((m) => m.reason === 'quote')?.field, 'heart_rate')
})

test('a quote broken across a line break still verifies', () => {
  const c = caseNamed('vs-en-03-prose')
  const note = pack.document(c.name)
  // The notes are hard-wrapped, so a quote that spans a wrap carries a newline where the
  // model wrote a space. Without collapsing, every multi-line quote would fail and the
  // metric would measure the wrapping rather than the model.
  const got = { heart_rate: { value: 88, unit: 'bpm', raw_text: 'the heart rate had settled to 88 beats per minute' } }
  const { tally } = scoreCase(c, got, note)
  assert.equal(tally.quoteVerified, 1)
})

test('a failed run is scored as total loss, never skipped', async () => {
  const { scoreFailure } = await import('../src/profiles/clinical/scorer.ts')
  const c = caseNamed('vs-en-01-vitals-block')
  const { tally } = scoreFailure(c)
  assert.equal(tally.failedRuns, 1)
  assert.equal(tally.gradedTotal, 6)
  assert.equal(tally.detected, 0, 'a model that fails outright must not look merely quiet')
})
