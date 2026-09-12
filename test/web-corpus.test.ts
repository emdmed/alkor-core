/**
 * The dashboard's corpus filter.
 *
 * The picker is how an operator finds one document among a hundred, and the fields worth
 * searching are not the obvious ones: the case names are opaque slugs (`sh-04-mixed`), so
 * most real queries are words out of the answer key's description or out of the note's
 * own first line. A filter matching only the name would look like it worked and find
 * nothing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { familyLabel, groupDocuments, kindLabel, matchesQuery, type CorpusDocument } from '../web/src/lib/corpus.ts'

const doc = (partial: Partial<CorpusDocument>): CorpusDocument => ({
  id: 'clinical/default/sh-01-septic-classic',
  pack: 'clinical',
  kind: 'default',
  case: 'sh-01-septic-classic',
  path: 'notes/sh-01-septic-classic.note.txt',
  bytes: 205,
  lines: 2,
  preview: '62-year-old male, hypotensive for 90 minutes. Warm peripheries.',
  evals: ['shockCases'],
  ...partial,
})

test('kindLabel names the pack corpora a reader recognises', () => {
  // `default` is the pack's unnamed prose corpus; showing the literal word would tell a
  // reader the kind's implementation name rather than what the documents are.
  assert.equal(kindLabel('default'), 'Notes')
  assert.equal(kindLabel('transcript'), 'Transcripts')
  assert.equal(kindLabel('exam'), 'Exams')
  // An unknown kind is shown as the pack named it rather than hidden or relabelled.
  assert.equal(kindLabel('radiology'), 'radiology')
})

test('an empty query matches everything', () => {
  assert.equal(matchesQuery(doc({}), ''), true)
  assert.equal(matchesQuery(doc({}), '   '), true)
})

test('a query matches the name, the description, the class, and the text', () => {
  const d = doc({ note: 'Warm shock with a wide pulse pressure.', class: 'textbook' })
  assert.equal(matchesQuery(d, 'septic'), true, 'case name')
  assert.equal(matchesQuery(d, 'pulse pressure'), true, 'answer-key description')
  assert.equal(matchesQuery(d, 'textbook'), true, 'case class')
  assert.equal(matchesQuery(d, 'hypotensive'), true, "the document's own first line")
  assert.equal(matchesQuery(d, 'cardiogenic'), false)
})

test('a query matches the kind by label as well as by its manifest name', () => {
  const transcript = doc({ kind: 'transcript', case: 'tr-en-01-rambling' })
  assert.equal(matchesQuery(transcript, 'transcript'), true)
  // "Transcripts" is what the group heading says, so it is what someone will type.
  assert.equal(matchesQuery(transcript, 'transcripts'), true)
  assert.equal(matchesQuery(doc({}), 'notes'), true, 'the default kind is labelled Notes')
})

test('terms are matched independently, not as one substring', () => {
  const d = doc({ note: 'Warm shock with a wide pulse pressure.' })
  // Neither order appears verbatim anywhere in the document.
  assert.equal(matchesQuery(d, 'septic warm'), true)
  assert.equal(matchesQuery(d, 'warm septic'), true)
  // Every term still has to land somewhere.
  assert.equal(matchesQuery(d, 'septic cardiogenic'), false)
})

test('matching ignores case in both directions', () => {
  const d = doc({ note: 'Warm shock.' })
  assert.equal(matchesQuery(d, 'SEPTIC'), true)
  assert.equal(matchesQuery(d, 'warm'), true)
})

test('a document with no answer key is still findable by its own text', () => {
  const d = doc({ case: 'sum-en-01-a', note: undefined, class: undefined, preview: 'GENERAL PRACTICE - NEW PATIENT REGISTRATION' })
  assert.equal(matchesQuery(d, 'registration'), true)
  assert.equal(matchesQuery(d, 'sum-en-01'), true)
})

/* ------------------------------------------------------------------ grouping */

test('familyLabel turns a manifest key into the question it grades', () => {
  assert.equal(familyLabel('vitalSignsCases'), 'Vital signs')
  assert.equal(familyLabel('summaryCases'), 'Summary')
  assert.equal(familyLabel('shockExtractionCases'), 'Shock extraction')
  assert.equal(familyLabel('sepsisCases'), 'Sepsis')
  // A key that is not camelCase and does not end in Cases still reads as words.
  assert.equal(familyLabel('radiology'), 'Radiology')
  assert.equal(familyLabel('Cases'), 'Cases', 'stripping must not leave an empty label')
})

test('documents group by kind and by the answer key that grades them', () => {
  const groups = groupDocuments([
    doc({ id: 'p/default/vs-1', case: 'vs-1', evals: ['vitalSignsCases'] }),
    doc({ id: 'p/exam/sh-1', case: 'sh-1', kind: 'exam', evals: ['shockCases'] }),
    doc({ id: 'p/default/vs-2', case: 'vs-2', evals: ['vitalSignsCases'] }),
    doc({ id: 'p/transcript/tr-1', case: 'tr-1', kind: 'transcript', evals: ['transcriptCases'] }),
  ])

  // Prose first, payloads last — a reader browsing notes should not have to scroll past
  // the exam payloads to reach them.
  assert.deepEqual(groups.map((g) => `${g.kind}/${g.label}`), [
    'default/Vital signs',
    'transcript/Transcript',
    'exam/Shock',
  ])
  assert.equal(groups[0]!.documents.length, 2)
})

test('a document graded by several keys is filed under the first, not listed twice', () => {
  const groups = groupDocuments([
    doc({ id: 'p/default/vs-9', case: 'vs-9', evals: ['vitalSignsCases', 'noteFormatCases'] }),
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0]!.label, 'Vital signs')
  assert.equal(groups[0]!.documents.length, 1)
})

test('documents of one case become a run; documents of their own stay single', () => {
  const groups = groupDocuments([
    doc({ id: 'p/default/rec-a', case: 'rec-a', caseName: 'rec-01', evals: ['summaryCases'] }),
    doc({ id: 'p/default/rec-b', case: 'rec-b', caseName: 'rec-01', evals: ['summaryCases'] }),
    doc({ id: 'p/default/solo', case: 'solo', caseName: 'solo', evals: ['summaryCases'] }),
  ])

  const group = groups[0]!
  assert.equal(group.runs.length, 1)
  assert.equal(group.runs[0]!.caseName, 'rec-01')
  assert.deepEqual(group.runs[0]!.documents.map((d) => d.case), ['rec-a', 'rec-b'])
  assert.deepEqual(group.singles.map((d) => d.case), ['solo'])
})

test('documents with no case of their own are never merged into one run', () => {
  // Two unattributed documents share `caseName: undefined`, which a naive key would treat
  // as one case of two notes and label as a record that does not exist.
  const groups = groupDocuments([
    doc({ id: 'p/default/a', case: 'a', caseName: undefined, evals: [] }),
    doc({ id: 'p/default/b', case: 'b', caseName: undefined, evals: [] }),
  ])
  const group = groups[0]!
  assert.equal(group.label, 'Ungraded')
  assert.equal(group.runs.length, 0)
  assert.equal(group.singles.length, 2)
})
