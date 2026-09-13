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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { loadPack, SPEC_CHANGES, specGap, SPEC_VERSION } from '../src/core/pack.ts'
import { loadSampling, loadSettings } from '../src/profiles/clinical/settings.ts'
import { gradedExpectations, loadVitalCases, parseDifficultyRange } from '../src/profiles/clinical/cases.ts'
import { GRADED_TASKS, gradedFields, TASK_SPEC, TASKS, vitalPrompt, vitalSchema, vitalSchemaGolden } from '../src/profiles/clinical/contracts.ts'
import { parseVitalSigns } from '../src/profiles/clinical/extraction.ts'
import { scoreCase, norm } from '../src/profiles/clinical/scorer.ts'
import { PROFILE } from '../src/profiles/clinical/profile.ts'
import { clinicalRedactor } from '../src/profiles/clinical/redact.ts'
import { openTrace } from '../src/core/trace.ts'
import type { Provider } from '../src/core/client.ts'

const pack = loadPack(join(import.meta.dirname, '..', 'packs', 'clinical'))
const fields = gradedFields(pack)
const { cases, fieldRecallFloor } = loadVitalCases(pack, fields)
// The scorer verifies quotes under the PACK's rule, the same one note formatting uses. It is
// a parameter rather than a default precisely so a task cannot quietly grade under its own.
const QUOTE_RULE = loadSettings(pack).quoteVerification

test('the pack declares the spec version this harness reads', () => {
  assert.equal(pack.spec, SPEC_VERSION)
  // Not a tautology: `spec` is read from the manifest and this is the reference pack, so the
  // assertion is that the pack was BUMPED with the format rather than left behind by it —
  // which is the mistake spec 2 exists to record. Two keys became load-bearing while the
  // manifest still said 1.
  assert.equal(pack.spec, 3)
  assert.deepEqual(specGap(pack.spec), [], 'the reference pack must not be older than the harness')
})

/**
 * A pack that predates a format change is told what changed, not merely which key is absent.
 *
 * The measured failure: `accentSensitive` became required, `spec` stayed at 1, and every pack
 * written the day before got a message about an incomplete TOML table with nothing anywhere
 * saying the format had moved.
 */
/**
 * The version the harness reads must be a version the harness can EXPLAIN.
 *
 * `specGap(SPEC_VERSION).length === 0` below proves the changelog holds nothing from the
 * future. It cannot prove the changelog holds anything at all about the present, and that is
 * the gap this test closes: spec went to 3 with the table form of `documents`, and both the
 * `SPEC_CHANGES` entry and the changelog section in `spec/pack.md` are what a pack author
 * reads when their pack is refused. A bump that lands without them reproduces the exact
 * failure the comment on SPEC_CHANGES was written to record, one version later.
 */
test('the current spec version is described in both places a pack author reads', () => {
  const changes = SPEC_CHANGES[SPEC_VERSION]
  assert.ok(
    Array.isArray(changes) && changes.length > 0,
    `SPEC_CHANGES has no entry for spec ${SPEC_VERSION} — a reader told their pack is older is told nothing else`,
  )

  const doc = readFileSync(join(import.meta.dirname, '..', 'spec', 'pack.md'), 'utf8')
  assert.match(doc, new RegExp(`^# Contract pack format — spec ${SPEC_VERSION}$`, 'm'), 'the format doc names the current version')
  assert.match(doc, new RegExp(`^\\*\\*spec ${SPEC_VERSION}\\.\\*\\*`, 'm'), 'the format doc has a changelog section for it')
})

test('a pack older than the harness is refused by version, not only by key', () => {
  assert.ok(specGap(1).some((c) => c.includes('accentSensitive')), 'the changelog must name the key')
  assert.equal(specGap(SPEC_VERSION).length, 0)

  const stale = {
    name: 'stale',
    spec: 1,
    root: mkdtempSync(join(tmpdir(), 'alkor-stale-')),
  }
  writeFileSync(
    join(stale.root, 'pack.toml'),
    'spec = 1\nname = "stale"\n[clinical]\ndefaultTask = "vital-signs"\n' +
      '[clinical.quoteVerification]\ncollapseWhitespace = true\ncaseSensitive = true\n' +
      '[clinical.textDerivation]\ndeletionOnly = true\n[clinical.summaryAssembly]\ntotalChars = 10000\n',
  )
  const staleManifest = parseToml(readFileSync(join(stale.root, 'pack.toml'), 'utf8')) as Record<string, unknown>
  assert.throws(() => loadSettings({ ...stale, manifest: staleManifest } as unknown as typeof pack), (e: Error) => {
    assert.match(e.message, /accentSensitive/, 'the key')
    assert.match(e.message, /declares spec 1/, 'the version the pack claims')
    assert.match(e.message, new RegExp(`reads spec ${SPEC_VERSION}`), 'the version the harness reads')
    return true
  })
  rmSync(stale.root, { recursive: true, force: true })
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
  assert.equal(cases.length, 30)
  assert.equal(gradedExpectations(cases), 132)
  // The floor is unchanged by the corpus growing, deliberately. It is a requirement of the
  // contract rather than a number fitted to a model, so nine notes written against the failure
  // modes two models actually showed must move the MEASUREMENT and not the bar.
  assert.equal(fieldRecallFloor, 0.9)
})

/**
 * The two sub-gates, pinned where the evidence put them.
 *
 * Detection saturated on this corpus — 87/88 and 88/88 across two models, at every tier —
 * while unit ran 86/87 against 81/88. A floor at 0.95 is the statement that a model with
 * PERFECT detection and the weaker model's unit rate (92%) does not pass, which is exactly
 * the run that used to. Asserted here rather than left to the case file so a floor lowered
 * to make a run go green is a test failure and not a quiet edit.
 */
test('value and unit gate, at a floor the weaker measured model fails', () => {
  const { valueFloor, unitFloor } = loadVitalCases(pack, fields)
  assert.equal(valueFloor, 0.95)
  assert.equal(unitFloor, 0.95)
  // 81/88 and 82/88 are what gemma-3-4b measured beside a clean 88/88 detection.
  assert.ok(81 / 88 < unitFloor, 'a gate that the measured failure clears is not a gate')
  assert.ok(82 / 88 < valueFloor)
  // ... and what Qwen3-4B measured, which must still pass.
  assert.ok(86 / 87 >= unitFloor && 86 / 87 >= valueFloor, 'the floor must be reachable')
})

/**
 * Difficulty rates the NOTE, so it is a property of the corpus: it does not move when the
 * weights do, and a per-tier score from two different models is comparing the same texts.
 * Pinned per tier for the same reason the total is pinned — a case whose rating drifted
 * would move slots between buckets and the breakdown would keep printing, just wrong.
 */
test('every case rates how hard its note is, and the tiers hold their weight', () => {
  const slots = new Map<number, number>()
  for (const c of cases) {
    assert.ok(Number.isInteger(c.difficulty) && c.difficulty >= 1 && c.difficulty <= 5, `${c.name} is unrated`)
    const graded = c.fields.filter((f) => f.expect.kind === 'value' || f.expect.kind === 'bp').length
    slots.set(c.difficulty, (slots.get(c.difficulty) ?? 0) + graded)
  }
  assert.deepEqual([...slots.entries()].sort(), [
    [1, 6],
    [2, 22],
    [3, 22],
    [4, 42],
    [5, 40],
  ])
  // A corpus with no hard end cannot tell a good extractor from a lucky one. Half the
  // graded slots sit at 4 and 5 on purpose.
  const hard = (slots.get(4) ?? 0) + (slots.get(5) ?? 0)
  assert.ok(hard >= gradedExpectations(cases) / 3, `only ${hard} graded slots above difficulty 3`)
})

test('the case file states the rubric the ratings mean', () => {
  const raw = pack.json<Record<string, string>>('vitalSignsCases')
  assert.ok(raw._difficulty?.includes('1 - '), 'the rubric must define what a 1 is')
  assert.ok(raw._difficulty?.includes('5 - '), 'the rubric must define what a 5 is')
})

/**
 * An unrated case is refused at load rather than defaulted. A default would put a case's
 * slots in a bucket its author never chose, and the breakdown would go on printing.
 */
test('a case with no difficulty, or one off the scale, is refused at load', () => {
  const stub = (difficulty: unknown) =>
    ({
      name: 'stub',
      json: () => ({
        fieldRecallFloor: 0.9,
        valueFloor: 0.95,
        unitFloor: 0.95,
        cases: [{ name: 'c1', class: 'block', difficulty, fields: [] }],
      }),
    }) as unknown as Parameters<typeof loadVitalCases>[0]

  for (const bad of [undefined, 0, 6, 2.5, '3']) {
    assert.throws(() => loadVitalCases(stub(bad), fields), /needs an integer 1-5/, `difficulty ${bad} was accepted`)
  }
  assert.doesNotThrow(() => loadVitalCases(stub(3), fields))
})

test('a difficulty scope is parsed, and a malformed one is refused', () => {
  const only4 = parseDifficultyRange('4')
  assert.ok(only4(4) && !only4(3) && !only4(5))
  const hard = parseDifficultyRange('4-5')
  assert.ok(hard(4) && hard(5) && !hard(3))
  // Refused rather than ignored: a run meant to be the hard tier that quietly graded the
  // whole corpus reports a number for a corpus nobody asked about.
  assert.throws(() => parseDifficultyRange('6'), /expects N or N-M/)
  assert.throws(() => parseDifficultyRange('hard'), /expects N or N-M/)
  assert.throws(() => parseDifficultyRange('5-4'), /is empty/)
})

test('the corpus keeps its discriminating classes', () => {
  const classes = new Set(cases.map((c) => c.class))
  // Each of these is a distinct way for an extractor to fail, and a corpus that loses one
  // stops being able to tell that failure from success.
  for (const needed of [
    'block',
    'units',
    'prose',
    'temporal',
    'none',
    'qualitative',
    'language',
    'repeat',
    'negative-controls',
    'extreme',
    'derived',
    // The hard end: a sign discussed but not measured, a range around one true reading,
    // somebody else's readings, a figure retracted further down, a chart instead of
    // sentences, an infant's normal values, a discharge summary made of other numbers,
    // and the characters a real letter is set in.
    'negation',
    'range',
    'attribution',
    'retraction',
    'tabular',
    'paediatric',
    'haystack',
    'typography',
    // Written against the failure modes two models actually showed, rather than against a
    // guess at what might be hard. `table` is the layout that broke one model on provenance
    // and another on value in the same note; `distractors` is a lab panel shaped like an
    // observation chart; `prompt-echo` is a note whose true figures CONTRADICT the prompt's
    // own worked example, which is the case the corpus could not previously produce — a model
    // emitted the example's `94 bpm` for a note with no heart rate in it.
    'table',
    'distractors',
    'prompt-echo',
  ]) {
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

/**
 * And a pack that omits one is refused at LOAD, not at assembly.
 *
 * `ClinicalSettings` types the four required labels `string`, but a manifest is TOML read at
 * runtime and that type is a promise nothing checked. A pack missing one used to typecheck,
 * load, and send `json_schema.name: undefined` — which llama-server accepts. The label is
 * part of the pinned request body, so that is a run whose body cannot be reproduced from the
 * pack that produced it, and nothing in its trace would say so.
 */
test('a required schema label is refused at load, not sent as undefined', () => {
  const root = mkdtempSync(join(tmpdir(), 'alkor-label-'))
  const manifest = (names: string) =>
    `spec = 2\nname = "n"\n[clinical]\ndefaultTask = "vital-signs"\n${names}` +
    '[clinical.quoteVerification]\ncollapseWhitespace = true\ncaseSensitive = true\naccentSensitive = true\n' +
    '[clinical.textDerivation]\ndeletionOnly = true\n[clinical.summaryAssembly]\ntotalChars = 10000\n'
  const stub = (extraManifest?: string) => {
    const m = manifest(extraManifest ?? all)
    writeFileSync(join(root, 'pack.toml'), m)
    return {
      name: 'n',
      spec: 2,
      root,
      manifest: parseToml(readFileSync(join(root, 'pack.toml'), 'utf8')) as Record<string, unknown>,
    } as unknown as Parameters<typeof loadSettings>[0]
  }

  const all = 'vitalSignsSchemaName = "v"\nsummarySchemaName = "s"\nnoteFormatSchemaName = "f"\ntranscriptSchemaName = "t"\n'
  assert.equal(loadSettings(stub(all)).transcriptSchemaName, 't')

  // Each of the four, named in its own refusal — a message that said "a label is missing"
  // would leave an author to diff four keys against the format.
  for (const key of ['vitalSignsSchemaName', 'summarySchemaName', 'noteFormatSchemaName', 'transcriptSchemaName']) {
    assert.throws(() => loadSettings(stub(all.replace(new RegExp(`^${key} = .*\n`, 'm'), ''))), new RegExp(`${key} is missing`), `${key} must be refused`)
  }

  // Declared and EMPTY is the same failure wearing a value: it reaches the body as `""`.
  assert.throws(() => loadSettings(stub(all.replace('vitalSignsSchemaName = "v"', 'vitalSignsSchemaName = ""'))), /vitalSignsSchemaName is missing/)
  rmSync(root, { recursive: true, force: true })
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
  const { tally, misses } = scoreCase(c, got, note, QUOTE_RULE)
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
  const { tally, misses } = scoreCase(c, { heart_rate: { value: 72, unit: 'bpm' } }, pack.document(c.name), QUOTE_RULE)
  assert.equal(tally.gradedTotal, 0, 'this case grades nothing — it can only lose points')
  assert.equal(tally.hallucinations, 1)
  assert.equal(misses[0]!.reason, 'hallucination')
})

test('a qualitative sign turned into a number is a hallucination', () => {
  const c = caseNamed('vs-en-06-qualitative')
  const got = { temperature: { value: 38.5, unit: '°C', raw_text: 'febrile' }, weight: { value: 64, unit: 'kg', raw_text: 'Weight 64 kg' } }
  const { tally } = scoreCase(c, got, pack.document(c.name), QUOTE_RULE)
  assert.equal(tally.hallucinations, 1, "'febrile' is not a temperature")
  assert.equal(tally.detected, 1, 'the weight is still detected')
})

test('a right number with a wrong unit is a unit failure, not a value failure', () => {
  const c = caseNamed('vs-en-02-imperial')
  const got = { temperature: { value: 101.2, unit: '°C', raw_text: 'Temp 101.2 F' } }
  const { tally, misses } = scoreCase(c, got, pack.document(c.name), QUOTE_RULE)
  assert.equal(tally.valueExact, 1)
  assert.equal(tally.unitExact, 0)
  assert.equal(misses.filter((m) => m.reason === 'unit').length, 1)
})

test('a half-right blood pressure is wrong', () => {
  const c = caseNamed('vs-en-01-vitals-block')
  const got = { blood_pressure: { systolic: 148, diastolic: 90, unit: 'mmHg', raw_text: 'BP 148/92 mmHg' } }
  const { tally } = scoreCase(c, got, pack.document(c.name), QUOTE_RULE)
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
  const { tally, misses } = scoreCase(c, got, pack.document(c.name), QUOTE_RULE)
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
  const { tally } = scoreCase(c, got, note, QUOTE_RULE)
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

// --- the run record ----------------------------------------------------------------------

/**
 * A saved result has to name the bytes it was measured against. `digest` reports what the
 * run READ, not what the manifest declares — the per-case notes are named by a template
 * rather than by a key, so a record built from `[files]` would pin the answer key and miss
 * the inputs.
 */
test('the digest covers the files a run actually reads, notes included', () => {
  const fresh = loadPack(join(import.meta.dirname, '..', 'packs', 'clinical'))
  const d0 = fresh.digest()
  assert.ok(d0['pack.toml'], 'the manifest is always pinned')
  assert.equal(Object.keys(d0).length, 1, 'a pack that has read nothing still attests its manifest')

  vitalPrompt(fresh)
  fresh.document('vs-en-01-vitals-block')
  const d = fresh.digest()

  assert.ok(d['pack.toml'], 'the manifest is in the digest')
  assert.ok(d['prompts/vital-signs.md'], 'the prompt was read and should be in the digest')
  assert.ok(d['notes/vs-en-01-vitals-block.note.txt'], 'the note is the measured input')
  assert.ok(!d['evals/vital-signs-cases.json'], 'the case file was not read by this run')
  for (const hash of Object.values(d)) assert.match(hash, /^[0-9a-f]{64}$/)

  // Sorted, so the same contracts produce a byte-identical record on any machine.
  assert.deepEqual(Object.keys(d), [...Object.keys(d)].sort())
})

test('the digest changes when a contract changes', () => {
  const a = loadPack(join(import.meta.dirname, '..', 'packs', 'clinical'))
  const b = loadPack(join(import.meta.dirname, '..', 'packs', 'clinical'))
  vitalPrompt(a)
  vitalPrompt(b)
  assert.deepEqual(a.digest(), b.digest(), 'the same bytes hash the same')
  assert.equal(Object.keys(a.digest()).length, 2)
})

test('the harness names its own version', async () => {
  const { HARNESS_VERSION } = await import('../src/core/version.ts')
  assert.match(HARNESS_VERSION, /^\d+\.\d+\.\d+/, 'a run record must name what produced it')
})

test('the release stage is read off the version, so it cannot outlive it', async () => {
  const { HARNESS_STAGE, HARNESS_VERSION, STAGE_NOTICE } = await import('../src/core/version.ts')
  const tagged = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)/.exec(HARNESS_VERSION)
  assert.equal(HARNESS_STAGE, tagged?.[1])
  // A stage with nothing that says what it means to the reader is a label, not a warning.
  if (HARNESS_STAGE) {
    assert.match(STAGE_NOTICE, new RegExp(HARNESS_STAGE))
    assert.match(STAGE_NOTICE, /released for testing/)
  } else {
    assert.equal(STAGE_NOTICE, '')
  }
})

/**
 * The task registry and the profile's dispatch tables, checked against each other.
 *
 * `contracts.ts` declares what each task IS — graded, reviewable, tooling — and `profile.ts`
 * wires what each task DOES. Nothing makes the two agree on its own, and the failure they
 * would produce is the quiet kind: a task the pack advertises as runnable that refuses on
 * arrival, or one the pack calls graded that `--task all` walks past. Both used to be
 * reachable only by running the command.
 */
test('every task the registry calls reviewable has a reviewer wired', async () => {
  // A provider that refuses to answer, so the check reaches the dispatch and stops before any
  // model call. Anything other than this sentinel — a ProfileError about wiring, most of all —
  // is the failure this test exists to catch.
  const SENTINEL = 'provider-reached'
  const refuse = () => Promise.reject(new Error(SENTINEL))
  const provider = {
    chat: refuse,
    toolChat: refuse,
    streamChat: refuse,
    identify: () => Promise.resolve({ model: 'stub', identified: true, props: {} }),
  } as unknown as Provider

  const dir = mkdtempSync(join(tmpdir(), 'alkor-wiring-'))
  const before = process.env.TRACE_DIR
  process.env.TRACE_DIR = dir
  const trace = openTrace('wiring-test', clinicalRedactor(true))
  if (before === undefined) delete process.env.TRACE_DIR
  else process.env.TRACE_DIR = before

  try {
    for (const task of TASKS) {
      const reviewable = TASK_SPEC[task].reviewable
      const attempt = PROFILE.review!({
        pack,
        trace,
        input: { kind: 'text', text: 'BP 90/60, HR 118, RR 24, temp 38.5C, GCS 15.' },
        options: { task, constrain: false },
        provider,
      })
      const err = await attempt.then(() => undefined, (e: Error) => e)

      if (!reviewable) {
        assert.match(
          String(err?.message),
          /not a reviewable one/,
          `${task} is declared unreviewable and should be refused by name`,
        )
        continue
      }
      assert.doesNotMatch(
        String(err?.message),
        /wires no reviewer/,
        `${task} is declared reviewable but profile.ts has no entry in its reviewer table`,
      )
    }
  } finally {
    trace.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every graded task is one --task all will actually run', () => {
  // GRADED_TASKS is derived from the registry; the eval dispatch is a separate table in
  // profile.ts. This asserts the registry does not promise a number nobody computes.
  for (const task of GRADED_TASKS) {
    assert.ok(TASK_SPEC[task].graded, `${task} is in GRADED_TASKS but the registry does not call it graded`)
  }
  for (const task of TASKS) {
    assert.equal(GRADED_TASKS.includes(task), TASK_SPEC[task].graded, `${task} disagrees with its own graded flag`)
  }
})

test('the registry is internally well-formed', () => {
  for (const task of TASKS) {
    const spec = TASK_SPEC[task]
    // A feed target that is not a task would be a chain the router walks into nothing.
    if (spec.feeds) assert.ok(TASKS.includes(spec.feeds), `${task} feeds '${spec.feeds}', which is not a task`)
    // Tooling is never routed, so a tooling task with a plan rank is a contradiction: the
    // rank only means anything inside a plan the router builds.
    if (spec.tooling) assert.equal(spec.order, undefined, `${task} is tooling and cannot hold a plan rank`)
  }
  const ranks = TASKS.map((t) => TASK_SPEC[t].order).filter((o) => o !== undefined)
  assert.equal(new Set(ranks).size, ranks.length, 'two tasks claim the same plan rank, so their order is undefined')
})
