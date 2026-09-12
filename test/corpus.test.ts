/**
 * The pack corpus, enumerated for a reader.
 *
 * Two properties carry the weight here. One: listing and reading must not touch the pack's
 * opened-file set, because that set is what `digest()` reports as the files a run actually
 * read — a dashboard browsing notes must not write itself into a later run's record. Two:
 * a document id arrives over HTTP, so reading one must resolve through the corpus listing
 * rather than through path concatenation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPack } from '../src/core/pack.ts'
import { listCorpus, readCorpusDocument, CorpusError } from '../src/core/corpus.ts'
import { createServer as createAlkorServer } from '../src/server.ts'

/** A pack with two document kinds, one answer key, and a stray file in a corpus directory. */
const makePack = (): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), 'corpus-pack-'))
  mkdirSync(join(root, 'notes'))
  mkdirSync(join(root, 'transcripts'))
  mkdirSync(join(root, 'evals'))

  writeFileSync(join(root, 'notes', 'n-01.note.txt'), '\n\nBP 148/92 mmHg\nHR 78 bpm\n')
  writeFileSync(join(root, 'notes', 'n-02.note.txt'), 'Second note.\n')
  // One record over three visits: the case names them, and its own name is not a document.
  writeFileSync(join(root, 'notes', 'rec-a.note.txt'), 'Visit one.\n')
  writeFileSync(join(root, 'notes', 'rec-b.note.txt'), 'Visit two.\n')
  writeFileSync(join(root, 'notes', 'rec-c.note.txt'), 'Visit three.\n')
  // Not a note: it matches the directory but not the template's fixed halves.
  writeFileSync(join(root, 'notes', 'README.md'), 'not a case\n')
  writeFileSync(join(root, 'transcripts', 't-01.transcript.txt'), 'um so the patient\n')

  writeFileSync(
    join(root, 'evals', 'cases.json'),
    JSON.stringify({
      _comment: 'ignored — underscore keys are documentation',
      cases: [
        { name: 'n-01', note: 'The standard block.', difficulty: 1, class: 'block' },
        { name: 't-01', note: 'Rambling dictation.', difficulty: 3 },
        // Several documents, one case: the field is not a name this module knows.
        { name: 'rec-01-longitudinal', notes: ['rec-a', 'rec-b', 'rec-c'], note: 'One record, three visits.', class: 'longitudinal' },
      ],
    }),
  )
  // A second answer key that grades a note the first one already covers, by naming it in a
  // field of its own. The description must not be overwritten, and both keys must be listed.
  writeFileSync(
    join(root, 'evals', 'format.json'),
    JSON.stringify({ cases: [{ name: 'fmt-01', source: 'n-01', note: 'Reformatted.', class: 'letter' }] }),
  )
  // A declared JSON file with no `cases` array is not an answer key and must be skipped.
  writeFileSync(join(root, 'evals', 'schema.json'), JSON.stringify({ type: 'object' }))

  writeFileSync(
    join(root, 'pack.toml'),
    [
      'spec = 1',
      'name = "testpack"',
      '',
      '[documents]',
      'default = "notes/{case}.note.txt"',
      'transcript = "transcripts/{case}.transcript.txt"',
      '',
      '[files]',
      'cases = "evals/cases.json"',
      'formatCases = "evals/format.json"',
      'schema = "evals/schema.json"',
    ].join('\n'),
  )

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('listCorpus enumerates every kind and attaches the answer key', () => {
  const { root, cleanup } = makePack()
  try {
    const docs = listCorpus([loadPack(root)])
    assert.deepEqual(docs.map((d) => d.id), [
      'testpack/default/n-01',
      'testpack/default/n-02',
      'testpack/default/rec-a',
      'testpack/default/rec-b',
      'testpack/default/rec-c',
      'testpack/transcript/t-01',
    ])

    const first = docs[0]!
    assert.equal(first.kind, 'default')
    assert.equal(first.case, 'n-01')
    assert.equal(first.caseName, 'n-01')
    assert.equal(first.path, 'notes/n-01.note.txt')
    assert.equal(first.note, 'The standard block.')
    assert.equal(first.difficulty, 1)
    assert.equal(first.class, 'block')
    // Both answer keys reach this note; the first one's description is the one kept.
    assert.deepEqual(first.evals, ['cases', 'formatCases'])
    // The preview skips the leading blank lines rather than reporting an empty document.
    assert.equal(first.preview, 'BP 148/92 mmHg')

    // A document no answer key reaches still lists, with no description.
    const second = docs[1]!
    assert.equal(second.note, undefined)
    assert.equal(second.caseName, undefined)
    assert.deepEqual(second.evals, [])
  } finally {
    cleanup()
  }
})

test('a case that names several documents attributes itself to all of them', () => {
  const { root, cleanup } = makePack()
  try {
    const docs = listCorpus([loadPack(root)])
    const record = docs.filter((d) => d.case.startsWith('rec-'))
    assert.equal(record.length, 3)
    for (const doc of record) {
      // The point of the whole index: three documents that are one record say so, rather
      // than appearing as three unrelated slugs with no description between them.
      assert.equal(doc.caseName, 'rec-01-longitudinal')
      assert.equal(doc.note, 'One record, three visits.')
      assert.equal(doc.class, 'longitudinal')
      assert.deepEqual(doc.evals, ['cases'])
    }
    // The case's own name is not a document, so it must not appear as one.
    assert.ok(!docs.some((d) => d.case === 'rec-01-longitudinal'))
  } finally {
    cleanup()
  }
})

test('a case reaches a document named in any field, and never one named in prose', () => {
  const { root, cleanup } = makePack()
  try {
    const docs = listCorpus([loadPack(root)])
    // `source: "n-01"` is a reference; `class: "block"` and the prose are not, because no
    // document is named `block`.
    const n01 = docs.find((d) => d.case === 'n-01')!
    assert.deepEqual(n01.evals, ['cases', 'formatCases'])
    assert.equal(n01.caseName, 'n-01', 'the first key to reach it wins')
    // `fmt-01` names no document of its own, so it contributes no listing entry.
    assert.ok(!docs.some((d) => d.case === 'fmt-01'))
  } finally {
    cleanup()
  }
})

test('a file that does not match the template is not a case', () => {
  const { root, cleanup } = makePack()
  try {
    const docs = listCorpus([loadPack(root)])
    assert.ok(!docs.some((d) => d.case.includes('README')))
  } finally {
    cleanup()
  }
})

test('listing and reading leave the pack digest empty', () => {
  const { root, cleanup } = makePack()
  try {
    const pack = loadPack(root)
    // `loadPack` reads the manifest, so the digest is never empty. What must not change is
    // everything after that baseline.
    const baseline = pack.digest()
    assert.deepEqual(Object.keys(baseline), ['pack.toml'])

    listCorpus([pack])
    readCorpusDocument([pack], 'testpack/default/n-01')
    // This is the whole point: a run that loads this pack next must not report that it
    // read the notes or the answer keys a dashboard happened to browse.
    assert.deepEqual(pack.digest(), baseline)

    // And the mechanism still works for the run path that is supposed to record reads.
    pack.document('n-01')
    assert.deepEqual(Object.keys(pack.digest()), ['notes/n-01.note.txt', 'pack.toml'])
  } finally {
    cleanup()
  }
})

test('readCorpusDocument returns the text and refuses anything not in the listing', () => {
  const { root, cleanup } = makePack()
  try {
    const pack = loadPack(root)
    const { document, text } = readCorpusDocument([pack], 'testpack/transcript/t-01')
    assert.equal(document.kind, 'transcript')
    assert.equal(text, 'um so the patient\n')

    for (const id of [
      'testpack/default/nope',
      'testpack/default/../../../etc/passwd',
      '../../../etc/passwd',
      '/etc/passwd',
      'testpack/notes/n-01',
    ]) {
      assert.throws(() => readCorpusDocument([pack], id), CorpusError, `expected refusal for ${id}`)
    }
  } finally {
    cleanup()
  }
})

test('a pack with no documents template contributes nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'corpus-bare-'))
  try {
    writeFileSync(join(root, 'pack.toml'), 'spec = 1\nname = "bare"\n')
    assert.deepEqual(listCorpus([loadPack(root)]), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ----------------------------------------------------------------- endpoints */

const startServer = async (): Promise<{ server: Server; url: string; close: () => Promise<void> }> => {
  const server = await createAlkorServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    },
  }
}

test('GET /corpus lists the shipped pack corpus', async () => {
  const { url, close } = await startServer()
  try {
    const res = await fetch(`${url}/corpus`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as { documents: Array<Record<string, unknown>>; synthetic: boolean }

    assert.equal(body.synthetic, true)
    assert.ok(body.documents.length > 0)

    const kinds = new Set(body.documents.map((d) => d.kind))
    assert.ok(kinds.has('default'), 'the reference pack ships notes')
    assert.ok(kinds.has('transcript'), 'the reference pack ships transcripts')

    // Every entry is addressable by the id it was listed under.
    for (const doc of body.documents) {
      assert.equal(doc.id, `${doc.pack}/${doc.kind}/${doc.case}`)
    }

    // No duplicates: two profiles naming the same pack must not list it twice.
    const ids = body.documents.map((d) => d.id)
    assert.equal(new Set(ids).size, ids.length)
  } finally {
    await close()
  }
})

test('GET /corpus/<id> returns the document text, and 404s otherwise', async () => {
  const { url, close } = await startServer()
  try {
    const listed = (await (await fetch(`${url}/corpus`)).json()) as { documents: Array<{ id: string; bytes: number }> }
    const first = listed.documents[0]!

    const res = await fetch(`${url}/corpus/${first.id}`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as { id: string; text: string }
    assert.equal(body.id, first.id)
    assert.ok(body.text.length > 0)

    for (const id of ['clinical/default/no-such-case', encodeURIComponent('../../../etc/passwd')]) {
      const miss = await fetch(`${url}/corpus/${id}`)
      assert.equal(miss.status, 404, `expected 404 for ${id}`)
    }
  } finally {
    await close()
  }
})
