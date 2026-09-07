/**
 * The three set-extraction contracts — summary, note formatting, dictated transcripts —
 * checked without a model.
 *
 * Same standard as test/clinical.test.ts: everything here is the pack agreeing with itself,
 * and none of it asserts that any model scored anything. These tasks are the new ones, so the
 * checks that matter most are the ones that catch a contract which LOOKS measurable and is
 * not — a case naming a document that does not exist, a matcher that can never match, an
 * expectation on a field the schema does not define, and for the transcript corpus an
 * expectation whose terms are spread across paragraphs of a dictation, which no answer can
 * satisfy while also deriving its text from one quoted span.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPack, type Pack } from '../src/core/pack.ts'
import {
  loadSettings,
  isDialogue,
  loadSampling,
  setMatching as setMatching_
} from '../src/profiles/clinical/settings.ts'
import {
  loadFormatCases,
  loadTranscriptCases,
  loadSummaryCases,
  loadVitalCases,
  requiredSetExpectations
} from '../src/profiles/clinical/cases.ts'
import {
  formatPrompt,
  formatSchema,
  formatSchemaGolden,
  gradedFields,
  summaryPrompt,
  transcriptPrompt,
  transcriptRequest,
  summarySchema,
  summarySchemaGolden,
  SAMPLING_KEY,
  TASKS,
  CONTRACTS,
  DOCUMENT_KIND,
  type ContractSpec,
  hasMedicationContract,
  medicationPrompt,
  medicationSchema,
  medicationSchemaGolden,
  takesMedicationPass
} from '../src/profiles/clinical/contracts.ts'
import {
  FORMAT_LIST_FIELDS,
  SUMMARY_FIELDS,
  parseMedicationOnly,
  parseNoteFormat,
  parsePatientSummary,
} from '../src/profiles/clinical/extraction.ts'
import { applyMedication } from '../src/profiles/clinical/medication.ts'
import {
  DEFAULT_MEDICATION_NAME,
  DEFAULT_NEGATORS,
  matchesAny,
  scoreFormatCase,
  scoreSet,
  verifyMedicationName,
} from '../src/profiles/clinical/set-scorer.ts'
import { gatePasses } from '../src/profiles/clinical/set-eval.ts'
import { assembleDocument } from '../src/core/assemble.ts'

const pack = loadPack(join(import.meta.dirname, '..', 'packs', 'clinical'))
const summary = loadSummaryCases(pack)
const format = loadFormatCases(pack)
const transcript = loadTranscriptCases(pack)
const settings = loadSettings(pack)

test('both schemas serialize to their goldens', () => {
  assert.equal(JSON.stringify(summarySchema(pack)), summarySchemaGolden(pack).trim())
  assert.equal(JSON.stringify(formatSchema(pack)), formatSchemaGolden(pack).trim())
})

/**
 * Property order is compiled into the grammar. For note-format one pair of it is load-bearing
 * beyond the usual: `plan` is decoded BEFORE `current_medication`, because a model that
 * partitions by the note's own headings otherwise leaves the medication section empty.
 */
test('schema property order is the order the grammar will impose', () => {
  const s = summarySchema(pack) as { properties: Record<string, unknown> }
  assert.deepEqual(Object.keys(s.properties), [...SUMMARY_FIELDS])

  const f = formatSchema(pack) as { properties: Record<string, unknown> }
  const keys = Object.keys(f.properties)
  assert.deepEqual(keys, ['presenting_complaint', 'history', 'plan', 'current_medication'])
  assert.ok(keys.indexOf('plan') < keys.indexOf('current_medication'), 'measured: medication first empties the section')
})

/**
 * A GBNF grammar cannot emit EOS while an array is open, so every array in both schemas
 * needs a bound — and maxItems without uniqueItems is padded to the cap with duplicates.
 */
test('every array in both schemas is bounded and deduplicated', () => {
  const arrays = (schema: any): any[] => [
    ...Object.values(schema.properties ?? {}),
    ...Object.values(schema.$defs ?? {}),
  ].filter((p: any) => p?.type === 'array')

  for (const [name, schema] of [['summary', summarySchema(pack)], ['note-format', formatSchema(pack)]] as const) {
    const found = arrays(schema)
    assert.ok(found.length >= 3, `${name} should declare arrays`)
    for (const a of found as any[]) {
      assert.equal(typeof a.maxItems, 'number', `${name}: an unbounded array leaves the model no way to stop`)
      assert.equal(a.uniqueItems, true, `${name}: maxItems alone is padded to the cap with duplicates`)
    }
  }
})

test('every summary case names notes that exist, in a record of more than one', () => {
  for (const c of summary.cases) {
    assert.ok(c.notes.length >= 2, `${c.name} is a single note; that is the vital-signs task's shape, not this one`)
    for (const n of c.notes) {
      assert.ok(existsSync(join(pack.root, 'notes', `${n}.note.txt`)), `${c.name} names a missing note '${n}'`)
      assert.ok(pack.document(n).length > 100, `${n} is suspiciously short`)
    }
  }
})

/**
 * The corpus is SHARED rather than duplicated: a format case names a vital-signs case and
 * reads its note. A `source` that no longer exists would make the case unrunnable, and the
 * failure would arrive as a filesystem error in the middle of a graded run.
 */
test('every note-format case sources a note from the vital-signs corpus', () => {
  const vitalNames = new Set(loadVitalCases(pack, gradedFields(pack)).cases.map((c) => c.name))
  for (const c of format.cases) {
    assert.ok(vitalNames.has(c.source), `${c.name} sources '${c.source}', which is not a vital-signs case`)
    assert.ok(pack.document(c.source).length > 100)
  }
})

test('expectations only name fields their schema defines', () => {
  for (const c of summary.cases) {
    for (const e of c.fields) {
      assert.ok((SUMMARY_FIELDS as readonly string[]).includes(e.field), `${c.name} expects unknown field '${e.field}'`)
    }
  }
  const formatFields = ['presenting_complaint', ...FORMAT_LIST_FIELDS]
  for (const c of format.cases) {
    for (const e of c.fields) {
      assert.ok(formatFields.includes(e.field), `${c.name} expects unknown field '${e.field}'`)
      // A dose expectation on a section that has no doses can never fail, which makes it
      // worse than no expectation: it reads as a check.
      if ('dose' in e.expect || 'doseNull' in e.expect) {
        assert.equal(e.field, 'current_medication', `${c.name}: a dose expectation only means something on a medication`)
      }
    }
  }
})

/**
 * A term that is not in the note can never be matched by any correct answer, so the
 * expectation is unfalsifiable in the wrong direction: it will simply always miss, and the
 * floor will be tuned around a corpus defect. Checked against the source note for the format
 * cases, where there IS one note to check against.
 */
test('every note-format expectation could in principle be satisfied by its note', () => {
  for (const c of format.cases) {
    const note = pack.document(c.source).toLowerCase()
    for (const e of c.fields) {
      if (e.expect.kind !== 'present') continue
      const satisfiable = e.expect.match.some((group) =>
        group.every((term) => note.normalize('NFD').replace(/\p{Mn}/gu, '').includes(term.normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase())),
      )
      assert.ok(satisfiable, `${c.name}: no alternative of ${JSON.stringify(e.expect.match)} appears in ${c.source}`)
    }
  }
})

/**
 * The truncation path, graded rather than merely unit-tested.
 *
 * It was a stated gap in the summary case file: the corpus was three short records, none of
 * them reached `totalChars`, and no graded case ever handed a model a PREFIX of a record. The
 * assembler's truncation branch was covered by test/assemble.ts and by nothing that produced a
 * number. Asserted here so the property cannot be lost by an edit to a note.
 */
test('one summary record is long enough to be truncated, and exactly one is', () => {
  const rule = settings.summaryAssembly
  const assembled = summary.cases.map((c) => ({
    name: c.name,
    ...assembleDocument(c.notes.map((n) => pack.document(n)), rule),
  }))
  const truncated = assembled.filter((a) => a.truncated)
  assert.equal(truncated.length, 1, 'the corpus must exercise the path, and must not do so by accident everywhere')
  assert.ok(truncated[0]!.used < summary.cases.find((c) => c.name === truncated[0]!.name)!.notes.length)
  // And every other record must fit whole, or its answer key is describing an input the model
  // was never given.
  for (const a of assembled.filter((x) => !x.truncated)) {
    assert.ok(a.text.length < rule.totalChars, `${a.name} is at the limit by luck rather than by design`)
  }
})

test('the denominators and floors are what the corpora were authored against', () => {
  assert.equal(summary.cases.length, 10)
  assert.equal(requiredSetExpectations(summary.cases), 56)
  // The floor does not move when the corpus does. At 13 items one hallucination moved this
  // score by eight points, which made it a baseline rather than a measurement; at 56 it moves
  // it by under two, and the SAME floor now means something it could not mean before.
  assert.equal(summary.itemRecallFloor, 0.8)

  assert.equal(format.cases.length, 15)
  assert.equal(requiredSetExpectations(format.cases), 47)
  assert.equal(format.itemRecallFloor, 0.75)
  // The sub-gates are the point of the task; a run that finds every item while inventing the
  // spans it cites must not pass.
  assert.equal(format.quoteFloor, 0.9)
  assert.equal(format.derivationFloor, 0.9)
  // Fabrication is floored apart from provenance, because the two failures a provenance
  // number covers are different accusations: a lowercased capital is a model tidying, an
  // absent span is a model inventing a sentence and citing it. Measured on this corpus the
  // two came apart completely — one model's failures were all the first kind, another's five
  // on the flowsheet were all the second.
  assert.equal(format.fabricationFloor, 1.0, 'an invented citation is not a budget item')
  assert.ok(format.fabricationFloor! >= format.quoteFloor, 'below the quote floor it could never bind')
})

/**
 * A cap that binds on a legal answer measures the budget rather than the model — it turns a
 * good reply into a parse failure and reports it as a model that cannot read.
 *
 * The floor is 1024 for the four extraction tasks, whose realistic maximal answer is large and
 * whose schemas could in principle produce far more than their caps allow (note-format's could
 * emit ~7500 tokens against a 2048 cap; the pack's comment explains why that is sized to a
 * realistic maximum rather than to the schema's ceiling). `shock` is exempted by meeting a
 * STRICTLY STRONGER condition instead: its cap is above what its schema can legally emit at
 * all, so no answer exists that this cap could truncate. That is a property the other four
 * cannot claim, so it is checked rather than asserted — the exemption has to be earned by the
 * schema on every run, or the day someone raises `maxLength` on `indeterminate_reason` this
 * test fails instead of the eval quietly reporting truncations as wrong answers.
 */
test('every task declares its own sampling, and every graded one is deterministic', () => {
  for (const task of TASKS) {
    const s = loadSampling(pack, SAMPLING_KEY[task])
    assert.equal(s.temperature, 0, `${task} must be deterministic to be graded`)
    const ceiling = Math.ceil(schemaCharCeiling(pack.json(CONTRACTS[task].schemaKey)) / 3)
    assert.ok(
      s.max_tokens >= 1024 || s.max_tokens > ceiling,
      `${task}: cap ${s.max_tokens} is under 1024 and under the ~${ceiling} tokens its schema can emit — ` +
        'a cap that truncates a legal answer measures the budget',
    )
  }
})

/**
 * An upper bound on the CHARACTERS a schema can legally serialize to, from its own bounds.
 *
 * Deliberately crude and deliberately generous: `maxLength`, `maxItems` and the widest enum
 * member, with no attempt to model whitespace or realistic content. It is used only to let a
 * small contract prove its cap cannot bind, so an over-estimate is the safe direction — it
 * makes the exemption harder to claim, never easier.
 */
const schemaCharCeiling = (schema: any, defs?: any): number => {
  const d = defs ?? schema?.$defs ?? {}
  const s = schema
  if (!s) return 0
  if (s.$ref) return schemaCharCeiling(d[String(s.$ref).split('/').pop()!], d)
  if (s.anyOf) return Math.max(...s.anyOf.map((a: any) => schemaCharCeiling(a, d)))
  if (s.enum) return Math.max(...s.enum.map((e: any) => String(e).length)) + 2
  if (s.type === 'array') return (s.maxItems ?? 50) * (schemaCharCeiling(s.items, d) + 1) + 2
  if (s.type === 'object') {
    return Object.entries(s.properties ?? {}).reduce(
      (n, [k, v]) => n + k.length + 4 + schemaCharCeiling(v, d),
      2,
    )
  }
  if (s.type === 'string') return (s.maxLength ?? 500) + 2
  if (s.type === 'number' || s.type === 'integer') return 8
  return 4
}

/**
 * A verification rule that defaulted would report a perfect rate having checked nothing —
 * a number indistinguishable from a model that never paraphrases.
 */
test('the pack states its verification rules rather than defaulting them', () => {
  assert.equal(settings.quoteVerification.collapseWhitespace, true)
  assert.equal(settings.quoteVerification.caseSensitive, true)
  assert.equal(settings.textDerivation.deletionOnly, true)
  assert.equal(settings.summaryAssembly.totalChars, 10000)
  assert.ok(settings.summaryAssembly.lineFormat.includes('{content}'))
})

test('the three prompts carry no placeholders', () => {
  assert.doesNotMatch(summaryPrompt(pack), /\{\{[A-Z0-9_]+\}\}/)
  assert.doesNotMatch(formatPrompt(pack), /\{\{[A-Z0-9_]+\}\}/)
  assert.doesNotMatch(transcriptPrompt(pack), /\{\{[A-Z0-9_]+\}\}/)
})

// --- dictated transcripts -------------------------------------------------------------------

/**
 * The corpus is NOT shared with the note tasks, and that is the one thing to check hardest: a
 * transcript case reads `transcripts/{case}.transcript.txt` through the `transcript` documents
 * kind, so a case whose file is missing would fail in the middle of a graded run, and a case
 * read through the DEFAULT kind would grade a written note against a dictation answer key and
 * report a number for it.
 */
test('every transcript case reads a transcript of its own name, not a note', () => {
  for (const c of transcript.cases) {
    assert.ok(
      existsSync(join(pack.root, 'transcripts', `${c.name}.transcript.txt`)),
      `${c.name} has no transcript`,
    )
    const doc = pack.document(c.name, 'transcript')
    assert.ok(doc.length > 100, `${c.name} is suspiciously short`)
    assert.ok(
      !existsSync(join(pack.root, 'notes', `${c.name}.note.txt`)),
      `${c.name} also exists as a note; the two corpora must not collide by name`,
    )
  }
})

/**
 * A term absent from the transcript can never be matched by any correct answer, so the
 * expectation always misses and the floor gets tuned around a corpus defect.
 *
 * Checked per LINE rather than per document, which is stricter than the note-format version of
 * this test and has to be: every item's `text` must be a DELETION of one quoted span, and a
 * span is contiguous. An AND-group whose two terms sit in different paragraphs of a dictation
 * describes an answer that satisfies the matcher and cannot satisfy the derivation rule at the
 * same time — an expectation no correct run can pass, which is the failure this whole test
 * exists to catch and which document-level containment would call satisfiable.
 */
test('every transcript expectation is satisfiable from one span of its transcript', () => {
  const flat = (s: string): string => s.normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase()
  for (const c of transcript.cases) {
    const lines = pack.document(c.name, 'transcript').split('\n').map(flat)
    for (const e of c.fields) {
      if (e.expect.kind !== 'present') continue
      const satisfiable = e.expect.match.some((group) => lines.some((l) => group.every((term) => l.includes(flat(term)))))
      assert.ok(satisfiable, `${c.name}: no line holds any alternative of ${JSON.stringify(e.expect.match)}`)
      // A dose has to come out of a span too, and out of the SAME kind of span — see above.
      if ('dose' in e.expect && e.expect.dose) {
        const doseOk = e.expect.dose.some((group) => lines.some((l) => group.every((term) => l.includes(flat(term)))))
        assert.ok(doseOk, `${c.name}: no line holds any alternative of dose ${JSON.stringify(e.expect.dose)}`)
      }
    }
  }
})

/**
 * The task shares the note-format SCHEMA and nothing else. Asserted rather than assumed,
 * because the sharing is the design decision most likely to be undone by someone adding a
 * transcript-shaped schema file: a clinician reads one structure, and two schemas for one
 * structure are two things free to drift in property order, which is what the grammar compiles.
 */
test('the transcript task sends the note-format contract under its own label', () => {
  const req = transcriptRequest(pack, true)
  assert.deepEqual(req.schema, formatSchema(pack))
  assert.equal(req.prompt, transcriptPrompt(pack))
  assert.notEqual(req.prompt, formatPrompt(pack), 'speech and prose cannot share one instruction')
  assert.equal(req.schemaName, settings.transcriptSchemaName)
  assert.notEqual(req.schemaName, settings.noteFormatSchemaName, 'a pinned body must say which task sent it')
})

/**
 * Shape routing, which is a different question from language routing and asked first.
 *
 * The reason it is worth a test rather than a comment: the fallback is SILENT and correct-looking
 * in every direction. A detector that stops recognising turn labels reads every consultation as a
 * dictation and produces a number, not an error — which is exactly what the task did before the
 * dialogue prompt existed, and it scored 91%.
 */
test('a consultation takes the dialogue prompt and a dictation does not', () => {
  const dictation = pack.document('tr-en-01-rambling', 'transcript')
  const dialogue = pack.document('tr-en-18-dialogue', 'transcript')
  const spanish = pack.document('tr-es-20-dialogo', 'transcript')

  assert.ok(!isDialogue(pack, dictation), 'a one-voice dictation has no labelled turns')
  assert.ok(isDialogue(pack, dialogue))
  assert.ok(isDialogue(pack, spanish))

  // The four prompts are four distinct files, and the pairs that matter are the ones a wiring
  // mistake would collapse: shape without language, and language without shape.
  assert.notEqual(transcriptPrompt(pack, dialogue), transcriptPrompt(pack, dictation))
  assert.notEqual(transcriptPrompt(pack, spanish), transcriptPrompt(pack, dialogue))
  assert.equal(transcriptPrompt(pack, dialogue), pack.read('dialoguePrompt'))
  assert.equal(transcriptPrompt(pack, spanish), pack.read('dialoguePromptEs'))
  assert.equal(transcriptPrompt(pack, dictation), pack.read('transcriptPrompt'))
  // No transcript at all is the default, exactly as it was before shape routing existed.
  assert.equal(transcriptPrompt(pack), pack.read('transcriptPrompt'))
})

/**
 * Both floors, from the side each one guards. `minSpeakers` is the one that would otherwise go
 * untested, because the corpus contains no labelled monologue — and a labelled monologue is a
 * DICTATION, however it is punctuated: the dialogue prompt's whole subject is a fact arriving in
 * a voice that is not the record-keeper's.
 */
test('one voice is a dictation however it is punctuated, and a dictated colon is not a turn', () => {
  const monologue = ['dr: first line', 'dr: second line', 'dr: third line', 'dr: fourth line'].join('\n')
  assert.ok(!isDialogue(pack, monologue), 'four turns, one speaker')

  // The dictated-markup corpus says "colon" aloud rather than writing one, but a pack whose
  // transcriber writes the punctuation would have lines like this, and none of them is a turn:
  // what precedes the colon is a sentence, not a name.
  const dictated = ['subjective: cough for three weeks', 'plan: repeat the hba1c', 'medications: none'].join('\n')
  assert.ok(!isDialogue(pack, dictated))
})

test('every dialogue case is detected as one, and no dictation is', () => {
  const dialogues = transcript.cases.filter((c) => c.class === 'dialogue').map((c) => c.name)
  assert.equal(dialogues.length, 3, 'two English and one Spanish, added 2026-09-04')
  for (const c of transcript.cases) {
    const detected = isDialogue(pack, pack.document(c.name, 'transcript'))
    assert.equal(detected, dialogues.includes(c.name), `${c.name}: detector disagrees with the case's class`)
  }
})

test('the transcript corpus spans the tiers and states its floors', () => {
  assert.equal(transcript.cases.length, 20)
  assert.equal(requiredSetExpectations(transcript.cases), 131)
  // Not all hard. Without an easy dictation the tier distribution collapses to 3-5 and a
  // prompt change that helps only the well-behaved speaker is invisible.
  const tiers = new Set(transcript.cases.map((c) => c.difficulty))
  assert.ok(tiers.has(2) && tiers.has(5), `tiers present: ${[...tiers].sort().join(',')}`)
  // The axis with no analogue in the note corpus, in both languages: a speaker who retracts
  // what they just said. If these cases go, the task is note formatting with worse input.
  const corrections = transcript.cases.filter((c) => c.class === 'self-correction')
  assert.equal(corrections.length, 3)
  assert.deepEqual([...new Set(corrections.map((c) => c.name.slice(0, 5)))].sort(), ['tr-en', 'tr-es'])
  // MEASURED floors, set 2026-08-22 from two agreeing runs of the declared weights over all
  // thirteen transcripts — 95% recall, 100% provenance, 99% derivation — each sitting a few
  // items under what was measured. Pinned here rather than left to the pack alone because the
  // DIRECTION of a floor change is the thing worth noticing in a diff: a gate that drifts
  // downward to fit a run is how a pack stops measuring, and it looks like a one-character
  // edit. See RESULTS.md.
  //
  // These went UP, from 80/95/90, and the route matters. Adding tr-es-13-control took
  // derivation to 85% — six points under the old floor — and the run went red rather than
  // being absorbed. The defect was that prompts/transcript.md never said what language to
  // answer in, so Spanish transcripts came back as English notes that verified every quote and
  // derived no text. The prompt now states the rule; derivation went 85% -> 99% on the same
  // weights and the floors followed the measurement. The next person to move these numbers
  // should be moving them up too.
  assert.equal(transcript.itemRecallFloor, 0.9)
  assert.equal(transcript.quoteFloor, 0.95)
  assert.equal(transcript.derivationFloor, 0.95)
  assert.equal(transcript.fabricationFloor, 1.0, 'an invented citation is not a budget item')
})

/**
 * Every case naming two or more drugs must carry the merged-item trap.
 *
 * Asserted rather than left to review because the gap it closes is invisible in a report: a
 * model that emits one medication item naming three drugs scores 3/3 on the drugs, since a set
 * matcher finds "folic acid" in a merged string exactly as well as in its own item. The first
 * graded run did precisely that and the case reported 6/8. The schema says this cannot be
 * enforced by a JSON Schema keyword, so the answer key is the only place it can be checked —
 * and a trap present on five of six multi-drug cases would be a check that looks complete.
 */
test('every multi-drug transcript case can catch two drugs in one item', () => {
  for (const c of transcript.cases) {
    const drugs = c.fields.filter((e) => e.field === 'current_medication' && e.expect.kind === 'present')
    if (drugs.length < 2) continue
    const trap = c.fields.some(
      (e) =>
        e.field === 'current_medication' &&
        e.expect.kind === 'absent' &&
        e.expect.match.some((group) => group.length >= 2),
    )
    assert.ok(trap, `${c.name} expects ${drugs.length} drugs and cannot catch them merged into one item`)
  }
})

/**
 * `documents` as a TABLE — the spec 3 addition. A pack whose tasks read different KINDS of
 * source document declares them by name, and asking for a kind it does not declare is an error
 * rather than a fallback: falling back to `default` would hand a written note to a dictation
 * task and produce a number for it.
 */
test('a documents kind the pack does not declare is refused, not defaulted', () => {
  assert.throws(() => pack.document('tr-en-01-rambling', 'recordings'), /declares no 'recordings' documents template/)
  // And the two declared kinds resolve to different files for the same name.
  assert.notEqual(pack.document('vs-en-09-distractors'), pack.document('tr-en-01-rambling', 'transcript'))
})

test('a documents template with no {case} is refused at load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pack-docs-'))
  writeFileSync(join(dir, 'pack.toml'), 'spec = 3\nname = "x"\n\n[documents]\ndefault = "notes/only.txt"\n')
  assert.throws(() => loadPack(dir), /contains no '\{case\}'/)
})

// --- parsers ------------------------------------------------------------------------------

test('a summary with a missing or null list is a parse failure, not an empty list', () => {
  assert.throws(() => parsePatientSummary('{"history": [], "usual_medication": []}'), /no 'pending'/)
  assert.throws(() => parsePatientSummary('{"history": [], "usual_medication": [], "pending": null}'), /is empty is \[\]/)
  const ok = parsePatientSummary('{"history": ["Asthma", "  "], "usual_medication": [], "pending": []}')
  assert.deepEqual(ok.history, ['Asthma'], 'a blank item is not a finding')
})

test('a format item without its quote is refused rather than dropped', () => {
  const body = (pc: string) => `{"presenting_complaint": ${pc}, "history": [], "plan": [], "current_medication": []}`
  assert.throws(() => parseNoteFormat(body('{"text": "cough"}')), /has no quote/)
  assert.equal(parseNoteFormat(body('null')).presenting_complaint, null)
  // An empty-string dose is the model saying there is none, in the wrong spelling.
  const med = parseNoteFormat(
    '{"presenting_complaint": null, "history": [], "plan": [], "current_medication": [{"quote": "takes metformin", "text": "metformin", "dose": ""}]}',
  )
  assert.equal(med.current_medication[0]!.dose, null)
})

// --- scoring ------------------------------------------------------------------------------

test('matching is AND within an alternative and OR across them', () => {
  assert.ok(matchesAny(['metformin 850 mg twice daily'], [['metformin', '850']]))
  assert.equal(matchesAny(['metformin stopped'], [['metformin', '850']]), undefined, 'the dose term is what stops the opposite fact matching')
  assert.ok(matchesAny(['essential hypertension'], [['high blood pressure'], ['hypertension']]), 'one fact, two correct spellings')
  // Accent- and case-insensitive, because the corpus is bilingual.
  assert.ok(matchesAny(['Fibrilación auricular'], [['fibrilacion']]))
})

test('an `empty` expectation counts every item as a hallucination', () => {
  const s = scoreSet('c', [{ field: 'usual_medication', expect: { kind: 'empty' } }], {
    usual_medication: ['paracetamol', 'ibuprofen'],
  })
  assert.equal(s.tally.hallucinations, 2)
  assert.equal(s.misses[0]!.reason, 'not-empty')
})

const RULES = {
  quote: { collapseWhitespace: true, caseSensitive: true, accentSensitive: true },
  derivation: { deletionOnly: true },
}
const NOTE = 'Attends for review. Continue amlodipine 5 mg daily. Review in three months.'

test('provenance is checked on every emitted item, not only the expected ones', () => {
  const got = {
    presenting_complaint: { quote: 'Attends for review', text: 'review' },
    history: [{ quote: 'a sentence that is not in the note', text: 'invented' }],
    plan: [{ quote: 'Review in three months', text: 'Review in three months' }],
    current_medication: [{ quote: 'Continue amlodipine 5 mg daily', text: 'amlodipine', dose: '5 mg daily' }],
  }
  const { tally } = scoreFormatCase('c', [], got, NOTE, RULES)
  assert.equal(tally.quotes, 4, 'an item with no expectation is exactly where a fabricated citation hides')
  assert.equal(tally.quotesVerified, 3)
  assert.equal(tally.derivations, 5, 'four texts plus one dose')
  assert.equal(tally.derivationsOk, 4, 'the invented item cannot be derived from a quote that is not in the note')
})

test('a dose the note does not give is an error, counted apart from the drug', () => {
  const got = {
    presenting_complaint: null,
    history: [],
    plan: [],
    current_medication: [{ quote: 'Continue amlodipine 5 mg daily', text: 'amlodipine', dose: '5 mg daily' }],
  }
  const expectNull = [{ field: 'current_medication', expect: { kind: 'present' as const, match: [['amlodipine']], doseNull: true } }]
  const { tally, misses } = scoreFormatCase('c', expectNull, got, NOTE, RULES)
  assert.equal(tally.found, 1, 'the drug was found')
  assert.equal(tally.doseErrors, 1, 'and its dose was invented — a different failure, counted apart')
  assert.ok(misses.some((m) => m.reason === 'dose'))
})

/**
 * The three checks on a medication item ask three different questions, and this is the one
 * that was missing. Every assertion below is a MEASURED reading: a dictated transcript where
 * the model, pushed to stop merging its medication into one item, split it into three items
 * that each still carried their dose — and the pack called the merge fixed.
 */
test('a dose left inside the drug name is caught, where the other two checks pass it', () => {
  const note = 'her usual medication is metformin 500 mg twice daily and atorvastatin 20 mg at night'
  const got = {
    presenting_complaint: null,
    history: [],
    plan: [],
    current_medication: [
      { quote: note, text: 'metformin 500 mg twice daily', dose: '500 mg twice daily' },
      { quote: note, text: 'atorvastatin', dose: '20 mg at night' },
    ],
  }
  const expect = [{ field: 'current_medication', expect: { kind: 'present' as const, match: [['metformin']], dose: [['500 mg']] } }]
  const { tally, misses } = scoreFormatCase('c', expect, got, note, RULES)

  // The three axes that already existed all pass on the bad item, which is why the check had
  // to be added rather than derived from them.
  assert.equal(tally.quotesVerified, 2, 'both quotes are in the note')
  assert.equal(tally.derivationsOk, tally.derivations, 'a dose-laden name is still its quote with words deleted')
  assert.equal(tally.found, 1, 'and containment finds `metformin` inside it')
  assert.equal(tally.doseErrors, 0, 'and the dose field itself is right')

  assert.equal(tally.names, 2, 'every emitted medication item is checked, expectation or not')
  assert.equal(tally.namesOk, 1, 'only the second item is a drug name and nothing else')
  const miss = misses.find((m) => m.reason === 'name')
  assert.ok(miss, 'the failure is reported as its own reason, not folded into derivation')
  assert.match(miss!.detail, /'500'/, 'and it names the token that made it a dose')
})

test('a name too long to be a name is a different failure from a dose in the name', () => {
  assert.deepEqual(verifyMedicationName('amlodipine', DEFAULT_MEDICATION_NAME), { ok: true })
  assert.deepEqual(verifyMedicationName('folic acid', DEFAULT_MEDICATION_NAME), { ok: true }, 'two words is a drug name')
  assert.deepEqual(verifyMedicationName('alendronic acid', DEFAULT_MEDICATION_NAME), { ok: true })
  assert.deepEqual(
    verifyMedicationName('metformina 850 dos veces al día', DEFAULT_MEDICATION_NAME),
    { ok: false, reason: 'dose-in-name', token: '850' },
    'the default list is English AND Spanish, because the reference corpus is',
  )
  assert.deepEqual(
    verifyMedicationName('salbutamol inhaler as required', DEFAULT_MEDICATION_NAME),
    { ok: false, reason: 'dose-in-name', token: 'required' },
    'a schedule with no number in it is still a schedule',
  )
  // Five words, none of them a dose word: not a dose in a name, just not a name. The token
  // reported is everything past the cap, so a reader sees what overflowed rather than one word.
  assert.deepEqual(verifyMedicationName('her usual water tablet please', DEFAULT_MEDICATION_NAME), {
    ok: false,
    reason: 'not-a-name',
    token: 'tablet please',
  })
})

test('a pack states its own dose words, because they are the language\'s and not the code\'s', () => {
  const german = { maxWords: 3, doseTokens: ['taglich', 'morgens'] }
  assert.deepEqual(verifyMedicationName('ramipril morgens', german), { ok: false, reason: 'dose-in-name', token: 'morgens' })
  // And the inherited list finds nothing of its own — the failure mode the negator list already
  // taught this pack, in the direction that MISSES a bad item rather than rejecting a good one.
  assert.deepEqual(verifyMedicationName('ramipril morgens', DEFAULT_MEDICATION_NAME), { ok: true })
})

/**
 * Containment was `String.includes`, and it credited two things it should not have. Both are
 * measured false positives rather than hypotheticals — see set-scorer.ts.
 */
test('a term must start where a word starts', () => {
  assert.equal(matchesAny(['1500 mg'], [['500']]), undefined, 'a tenfold dose error is not the dose')
  assert.equal(matchesAny(['1500 mg'], [['500 mg']]), undefined)
  assert.ok(matchesAny(['500 mg twice daily'], [['500']]), 'the real dose still matches')
  // Stems are deliberate in the case files: one term covering diabetes, diabetic, diabético.
  assert.ok(matchesAny(['Type 2 diabetes mellitus'], [['diabet']]))
  assert.ok(matchesAny(['Paciente diabético'], [['diabet']]))
})

test('a negated mention is not a find', () => {
  assert.equal(matchesAny(['No diabetes mellitus'], [['diabet']]), undefined, 'the opposite fact')
  assert.equal(matchesAny(['Denies chest pain'], [['chest pain']]), undefined)
  assert.equal(matchesAny(['Sin alergias conocidas'], [['alergias']]), undefined)
  assert.equal(matchesAny(['No known history of diabetes'], [['diabet']]), undefined, 'the whole clause is negated')
  // A negator in a DIFFERENT clause says nothing about this one.
  assert.ok(matchesAny(['No allergies. Diabetes type 2'], [['diabet']]))
  assert.ok(matchesAny(['Diabetes with no complications'], [['diabet']]), 'the negation follows the fact')
  assert.ok(matchesAny(['Non-insulin dependent diabetes'], [['diabet']]), '"non-" is not a negator word')
})

/**
 * The negator list belongs to the PACK, and the default it inherits is a stated limit rather
 * than a hidden one.
 *
 * While the list was a constant in the scorer, its being English and Spanish was a property of
 * the code: a pack in a third language matched none of its own negations and scored every
 * negated item as a find — silently, and in the direction that inflates recall.
 */
test('a pack states which language it negates in', () => {
  const german = { negators: ['kein', 'keine', 'nicht'] }
  assert.equal(matchesAny(['Keine Diabetes mellitus'], [['diabet']], german), undefined)
  // Under the default — the reference corpus's two languages — the same item is a find, which
  // is exactly the silent failure this key exists to let a pack fix.
  assert.ok(matchesAny(['Keine Diabetes mellitus'], [['diabet']]), 'the default cannot know German')
  // And the pack's own list replaces the default rather than extending it, so a German pack
  // does not silently keep matching English clinical prose it never contains.
  assert.ok(matchesAny(['No diabetes mellitus'], [['diabet']], german))
  // Written as the language spells them: normalised the same way items are.
  assert.equal(matchesAny(['Sin alergias'], [['alergias']], { negators: ['SIN'] }), undefined)
})

test('a pack that declares the matching table must fill it', () => {
  const stub = (setMatching: unknown) => {
    const root = mkdtempSync(join(tmpdir(), 'medextract-match-'))
    writeFileSync(
      join(root, 'pack.toml'),
      `spec = 2\nname = "m"\n[clinical]\ndefaultTask = "vital-signs"\n` +
        // The four required labels. Noise for a test about negators, but a pack that loads has
        // to be a loadable pack: `loadSettings` refuses a missing one, because the label is
        // part of the request body.
        'vitalSignsSchemaName = "v"\nsummarySchemaName = "s"\n' +
        'noteFormatSchemaName = "f"\ntranscriptSchemaName = "t"\n' +
        '[clinical.quoteVerification]\ncollapseWhitespace = true\ncaseSensitive = true\naccentSensitive = true\n' +
        '[clinical.textDerivation]\ndeletionOnly = true\n[clinical.summaryAssembly]\ntotalChars = 10000\n' +
        (setMatching === undefined ? '' : `[clinical.setMatching]\nnegators = ${JSON.stringify(setMatching)}\n`),
    )
    return { name: 'm', spec: 2, root } as unknown as Parameters<typeof setMatching_>[0]
  }
  // Omitted means the documented default, which is the whole point of it being optional.
  assert.deepEqual(setMatching_(stub(undefined)).negators, DEFAULT_NEGATORS)
  assert.deepEqual(setMatching_(stub(['kein'])).negators, ['kein'])
  // Declared and empty is a typo, not a language without negations — and it would score every
  // "no diabetes" in the corpus as a find.
  assert.throws(() => setMatching_(stub([])), /declares no negators/)
})

/**
 * The vital-signs loader has always refused an expectation naming a field the schema does not
 * define. These two did not, and the gap was quiet in the worst direction: `scoreSet` reads
 * `got[field] ?? []`, so a mistyped field on an `absent` or `empty` expectation is scored as
 * satisfied for ever, and the hallucination check the author wrote never runs.
 */
test('a set expectation naming a section the contract does not have is refused', () => {
  // A pack stub rather than the real one: the point is what the LOADER does with a case file
  // nobody would commit, and the check has to be reachable through the door the eval uses.
  const packWith = (field: string): Pack =>
    ({
      ...pack,
      json: <T,>(key: string): T =>
        key === 'summaryCases'
          ? ({
              itemRecallFloor: 0.8,
              cases: [
                { name: 'stub', class: 'stub', difficulty: 3, notes: ['n'], fields: [{ field, expect: { kind: 'empty' } }] },
              ],
            } as T)
          : pack.json<T>(key),
    }) as Pack

  assert.throws(() => loadSummaryCases(packWith('usual_medications')), /does not define/, 'a plural typo must not pass silently')
  assert.throws(() => loadSummaryCases(packWith('medication')), /does not define/)
  // The field the contract really has still loads.
  assert.equal(loadSummaryCases(packWith('usual_medication')).cases.length, 1)
})

// --- gates ---------------------------------------------------------------------------------

/**
 * `ratio(0, 0)` is 1.0, which is right for a case with nothing to extract and wrong for a
 * floor. The unconstrained gemma-3-4b run made the difference concrete: every case failed to
 * parse, no quote was ever checked, and the verdict still read `provenance 100%`.
 */
test('a gate with nothing to measure does not pass', () => {
  assert.equal(gatePasses({ score: 1, floor: 0.9, measured: false }), false, 'nothing was checked')
  assert.equal(gatePasses({ score: 1, floor: 0.9, measured: true }), true)
  assert.equal(gatePasses({ score: 0.5, floor: 0.9, measured: true }), false)
  // The floor itself may be 0 and the gate still has to have measured something.
  assert.equal(gatePasses({ score: 1, floor: 0, measured: false }), false)
})

// --- The medication pass ----------------------------------------------------------------
//
// A SECOND CALL on a dictation, and the checks below are the ones that would let it ship
// something the eval never measured: a schema that drifted from the one it replaces items in,
// a shape boundary decided in code rather than in the pack, and a parser that accepted an item
// the four-section parser would have refused.

test('the medication schema serializes to its golden', () => {
  assert.equal(JSON.stringify(medicationSchema(pack)), medicationSchemaGolden(pack).trim())
})

/**
 * The item definition is SHARED, and nothing but this test says so. An item the pass produces
 * goes into the section a four-section reading would have produced, so a drift here is a
 * shipped note whose two halves answer to different rules — invisible in either file.
 */
test('a medication item is defined identically in both schemas', () => {
  const one = (medicationSchema(pack) as any).$defs.medication
  const two = (formatSchema(pack) as any).$defs.medication
  assert.deepEqual(one, two, 'the pass replaces note-format items and must produce the same kind')
  const section = (medicationSchema(pack) as any).properties.current_medication
  assert.deepEqual(section, (formatSchema(pack) as any).properties.current_medication)
})

/**
 * The contract table is only worth having if a bad row fails loudly.
 *
 * Every fact a pass is assembled from now lives in one `CONTRACTS` row, which removed five
 * places a contract could be half-wired. It did not remove the possibility of MIS-wiring one,
 * and a mis-wired row is quiet in the way that matters: a contract pointed at another's
 * `[sampling.*]` runs at the wrong cap and reports a number for it, and a contract pointed at
 * another's label pins a body a server log cannot attribute. Neither is a type error — the
 * fields are all strings.
 */
test('every contract names keys that resolve, and names them alone', () => {
  // Typed as the interface rather than the literal rows: `as const satisfies` narrows each
  // row to exactly the fields it has, so an optional one is unreachable on the union.
  const specs: ContractSpec[] = Object.values(CONTRACTS)

  // The row's own name matches the key it is filed under, so a refusal quoting `spec.id`
  // names the contract a reader can find.
  for (const [key, spec] of Object.entries(CONTRACTS)) assert.equal(spec.id, key)

  // Sampling table and schema label are one-to-one with the contract. A shared one is the
  // silent mis-wiring: the run succeeds and describes the wrong cap or the wrong contract.
  for (const field of ['samplingKey', 'schemaNameField'] as const) {
    const seen = specs.map((s) => s[field])
    assert.equal(new Set(seen).size, seen.length, `two contracts share a ${field}: ${seen.join(', ')}`)
  }

  // Schema and golden, by contrast, MAY be shared — transcript sends the note-format schema
  // under its own label, on purpose. What may not happen is the two coming apart: a contract
  // reading one contract's schema and another's golden pins bytes it never sends.
  for (const s of specs) {
    const owner = specs.find((o) => o.schemaKey === s.schemaKey)
    assert.equal(s.goldenKey, owner?.goldenKey, `${s.id} pairs ${s.schemaKey} with a golden from elsewhere`)
  }

  // And every key resolves in the reference pack, which declares all six contracts.
  for (const s of specs) {
    for (const key of [s.promptKey, s.schemaKey, s.goldenKey]) {
      assert.ok(pack.has(key), `${s.id} names '${key}', which this pack does not declare`)
    }
    if (s.dialoguePromptKey) assert.ok(pack.has(s.dialoguePromptKey), `${s.id} names a dialogue prompt it lacks`)
    assert.ok(loadSampling(pack, s.samplingKey).max_tokens > 0, `${s.id} has no [sampling.${s.samplingKey}]`)
  }

  // Every graded task has a corpus, and no row without one is a task: a pass that gained a
  // `documentKind` would appear in `--task` with nothing to read, and a task that lost one
  // would read the `default` corpus and grade another task's notes against its own answer key.
  for (const t of TASKS) assert.ok('documentKind' in CONTRACTS[t], `task ${t} has no corpus`)

  // The converse is NOT that every row with a corpus is a task, and the exception is narrow
  // enough to state as a rule: a contract may declare a corpus before there is an eval mode
  // that runs it, and while that is true it is `optional` and no `--task` word names it.
  // `shock` is the first — it ships a schema, a prompt and thirteen payloads, and its reference
  // arm is a rule in code rather than an eval loop. What must never happen is a REQUIRED
  // contract with a corpus sitting outside TASKS: that is a graded task nobody can run, and it
  // would sit there reporting nothing while looking complete. So the day `optional` comes off
  // one of these, this assertion is what says it has to join TASKS in the same commit.
  for (const s of specs) {
    if (!('documentKind' in s) || (TASKS as string[]).includes(s.id)) continue
    assert.equal(s.optional, true, `${s.id} declares a corpus but is not a task, so it must be optional`)
  }
  for (const t of TASKS) assert.equal(DOCUMENT_KIND[t], CONTRACTS[t].documentKind)
})

test('the pack declares the whole medication contract, or the pass does not run', () => {
  assert.equal(hasMedicationContract(pack), true)
  assert.ok(medicationPrompt(pack).length > 500)
  // Routed by language exactly as the other three families are.
  const es = medicationPrompt(pack, pack.document('tr-es-14-polimedicado', 'transcript'))
  assert.ok(es.includes('UN ÍTEM POR FÁRMACO'), 'a Spanish dictation takes the Spanish prompt')
  const en = medicationPrompt(pack, pack.document('tr-en-01-rambling', 'transcript'))
  assert.ok(en.includes('ONE ITEM PER DRUG'), 'an English one takes the English prompt')
})

/**
 * The boundary is MEASURED and it is the pack's: dictations gain three drugs and three doses
 * over nine cases, and the same pass over the three dialogues emits a retracted drug and keeps
 * a superseded cross-speaker dose. A runtime deciding this for itself would ship that failure.
 */
test('dictations take the medication pass and dialogues do not', () => {
  for (const name of ['tr-en-01-rambling', 'tr-en-02-self-correction', 'tr-es-14-polimedicado']) {
    assert.equal(takesMedicationPass(pack, pack.document(name, 'transcript')), true, `${name} is a dictation`)
  }
  for (const name of ['tr-en-18-dialogue', 'tr-en-19-dialogue-correction', 'tr-es-20-dialogo']) {
    assert.equal(takesMedicationPass(pack, pack.document(name, 'transcript')), false, `${name} is a consultation`)
  }
})

test('the medication parser refuses exactly what the note-format parser refuses', () => {
  const ok = parseMedicationOnly('{"current_medication":[{"quote":"on ramipril 5 mg","text":"ramipril","dose":"5 mg"}]}')
  assert.deepEqual(ok.current_medication, [{ quote: 'on ramipril 5 mg', text: 'ramipril', dose: '5 mg' }])
  // An empty-string dose is the model saying there is none, in the wrong spelling.
  const blank = parseMedicationOnly('{"current_medication":[{"quote":"her usual metformin","text":"metformin","dose":""}]}')
  assert.equal(blank.current_medication[0]!.dose, null)
  // An item with no quote cannot be verified, so it is refused rather than dropped: a section
  // that silently lost its unquotable items would score better for citing less.
  assert.throws(() => parseMedicationOnly('{"current_medication":[{"text":"ramipril","dose":"5 mg"}]}'), /quote/)
  assert.throws(() => parseMedicationOnly('{"current_medication":null}'), /\[\]/)
  assert.throws(() => parseMedicationOnly('{}'), /current_medication/)
})

/**
 * Every failure path returns the reading untouched. This pass can improve a reading and must
 * never be a new way to lose one — the same rule the repair pass follows.
 */
test('a medication outcome that did not run leaves the reading exactly as it was', () => {
  const reading = {
    presenting_complaint: null,
    history: [],
    plan: [],
    current_medication: [{ quote: 'on ramipril 5 mg', text: 'ramipril', dose: '5 mg' }],
  }
  const skipped = { ran: false, items: null, cost: [], attempts: 0, lostMs: 0, before: 1, after: 1 }
  assert.equal(applyMedication(reading, skipped), reading, 'the identity, not a copy')

  const replaced = {
    ran: true,
    items: [{ quote: 'on ramipril 5 mg and metformin 1 g', text: 'metformin', dose: '1 g' }],
    cost: [],
    attempts: 0,
    lostMs: 0,
    before: 1,
    after: 1,
  }
  const after = applyMedication(reading, replaced)
  assert.deepEqual(after.current_medication, replaced.items, 'the section is replaced wholesale')
  assert.equal(after.history, reading.history, 'and nothing else is touched')
})

/**
 * The literal string "null" as a dose, which is not a hypothesis: three of seventeen dictations
 * in one measured run of the medication pass returned it. Kept as a string it is a dose no
 * transcript contains — so it fails derivation, and it reaches a clinician as a drug dosed
 * "null". Coerced, and ONLY this word: any other unquotable dose is a real failure.
 */
test('a dose of "null" is the model saying there is none, in the worst spelling', () => {
  const one = parseMedicationOnly('{"current_medication":[{"quote":"on her usual furosemide","text":"furosemide","dose":"null"}]}')
  assert.equal(one.current_medication[0]!.dose, null)
  const two = parseMedicationOnly('{"current_medication":[{"quote":"on her usual furosemide","text":"furosemide","dose":"NULL"}]}')
  assert.equal(two.current_medication[0]!.dose, null)
  // Not a general amnesty: a dose the quote does not support is still a derivation failure.
  const real = parseMedicationOnly('{"current_medication":[{"quote":"on her usual furosemide","text":"furosemide","dose":"40 mg"}]}')
  assert.equal(real.current_medication[0]!.dose, '40 mg')
  // And the same rule reaches the four-section parser, because it is one contract.
  const reading = parseNoteFormat(
    '{"presenting_complaint":null,"history":[],"plan":[],"current_medication":[{"quote":"on her usual furosemide","text":"furosemide","dose":"null"}]}',
  )
  assert.equal(reading.current_medication[0]!.dose, null)
})

/**
 * One drug, one item. MEASURED on `tr-en-05`: the medication pass emitted `furosemide` with the
 * dose "[inaudible] milligrams in the morning" — which the contract says must be null — and
 * `furosemide` again with null. The key's doseNull expectation was satisfied by the second item
 * while the first stood, so a wrong dose and a right one scored as correct. `uniqueItems` in the
 * schema cannot catch it: the two items differ, in the field that makes one of them wrong.
 */
test('a drug emitted twice is counted, because nothing else can see it', () => {
  const note = 'she takes furosemide [inaudible] milligrams in the morning and her water tablet is the furosemide'
  const got = {
    presenting_complaint: null,
    history: [],
    plan: [],
    current_medication: [
      { quote: note, text: 'furosemide', dose: '[inaudible] milligrams in the morning' },
      { quote: note, text: 'Furosemide', dose: null },
    ],
  }
  const expect = [{ field: 'current_medication', expect: { kind: 'present' as const, match: [['furosemide']], doseNull: true } }]
  const { tally, misses } = scoreFormatCase('c', expect, got, note, RULES)

  assert.equal(tally.duplicateDrugs, 1, 'the second mention of one drug is one duplicate, not two items')
  const miss = misses.find((m) => m.reason === 'duplicate')
  assert.ok(miss, 'reported as its own reason')
  assert.match(miss!.detail, /already emitted/)

  // Compared by the answer key's own normaliser, so a capital does not buy a clean score.
  assert.equal(tally.names, 2, 'both are still checked as names')
})

test('two different drugs in one section are not duplicates', () => {
  const note = 'on ramipril 5 mg and metformin 1 g twice daily'
  const got = {
    presenting_complaint: null,
    history: [],
    plan: [],
    current_medication: [
      { quote: note, text: 'ramipril', dose: '5 mg' },
      { quote: note, text: 'metformin', dose: '1 g twice daily' },
    ],
  }
  assert.equal(scoreFormatCase('c', [], got, note, RULES).tally.duplicateDrugs, 0)
})
