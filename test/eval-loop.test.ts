/**
 * The eval loop itself, end to end, over a throwaway HTTP server.
 *
 * Every other test in this repository checks a pack against itself or a pure function against
 * its arguments. Nothing ran the LOOP — and the gap had a measured cost: `--difficulty` reached
 * `set-eval.ts`, was declared in its options, and was read by nothing. `eval --task all
 * --difficulty 5` graded five of twenty-one notes for one task and every case for the other
 * two, with no line of output saying so, and no test noticed for as long as the flag existed.
 * A filter silently not applied is worse than one refused: the run reports a number for a
 * corpus nobody asked about, in the format of the number they wanted.
 *
 * A stub server rather than a stubbed client, for the reason `test/extract.test.ts` gives: the
 * questions these tests exist for — how many requests, what was in the body, what the trace
 * holds afterwards — are properties of the transport boundary, so the tests serve one.
 *
 * No model, no weights, no numbers about any model's ability. The canned replies here are
 * chosen to make the ARITHMETIC checkable, not to resemble a good extraction.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPack } from '../src/core/pack.ts'
import { openTrace, TRACE_SPEC, type Trace } from '../src/core/trace.ts'
import { readTrace } from '../src/core/trace-read.ts'
import { loadSampling } from '../src/profiles/clinical/settings.ts'
import { loadFormatCases, loadSummaryCases, loadVitalCases } from '../src/profiles/clinical/cases.ts'
import { gradedFields, SAMPLING_KEY } from '../src/profiles/clinical/contracts.ts'
import { runVitalSignsEval } from '../src/profiles/clinical/eval.ts'
import { runNoteFormatEval, runSummaryEval, gatePasses } from '../src/profiles/clinical/set-eval.ts'
import { rescoreTrace, stripFence } from '../src/profiles/clinical/rescore.ts'
import { clinicalRedactor } from '../src/profiles/clinical/redact.ts'

const pack = loadPack(join(import.meta.dirname, '..', 'packs', 'clinical'))
const fields = gradedFields(pack)

// --- The stub -----------------------------------------------------------------------------

interface Stub {
  url: string
  bodies: Record<string, unknown>[]
  close: () => Promise<void>
}

/**
 * Serve one canned completion for every chat request, count the bodies, and answer the two
 * identity probes the run makes before it starts.
 *
 * `reply` is a function of the request so a test can vary the answer per case — which is what
 * the stability report needs in order to have anything to report.
 */
const serve = async (reply: (body: any, n: number) => string): Promise<Stub> => {
  const bodies: Record<string, unknown>[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const json = (v: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(v))
      }
      if (req.url?.includes('/v1/models')) return json({ data: [{ id: 'stub-model' }] })
      if (req.url?.includes('/props')) {
        return json({ model_ftype: 'Q4_K - Medium', total_slots: 1, default_generation_settings: { n_ctx: 32768 } })
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      const n = bodies.length
      bodies.push(body)
      json({
        choices: [{ message: { content: reply(body, n) }, finish_reason: 'stop' }],
        timings: { prompt_n: 100, prompt_ms: 50, predicted_n: 40, predicted_ms: 200, cache_n: 900 },
      })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    close: async () => {
      // The client's undici agent keeps its sockets alive, so `close()` alone waits for a
      // connection nobody is going to use again and the test process never exits.
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    },
  }
}

/**
 * The eval loop reports to the console by design — the printed block is the product. Under
 * `node --test` that is several hundred lines of somebody else's run interleaved with the test
 * names, so it is silenced here. What the loop PRINTS is not what these tests check; what it
 * sends, scores and records is.
 */
const quiet = <T,>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log
  const err = console.error
  console.log = () => {}
  console.error = () => {}
  return fn().finally(() => {
    console.log = log
    console.error = err
  })
}

/** A trace in a temp directory, and the lines it ends up holding. */
const tracing = (redact = clinicalRedactor(true)): { trace: Trace; dir: string; lines: () => string[] } => {
  const dir = mkdtempSync(join(tmpdir(), 'medextract-trace-'))
  const before = process.env.TRACE_DIR
  process.env.TRACE_DIR = dir
  const trace = openTrace('clinical-test', redact)
  if (before === undefined) delete process.env.TRACE_DIR
  else process.env.TRACE_DIR = before
  return { trace, dir, lines: () => readFileSync(trace.path, 'utf8').split('\n').filter(Boolean) }
}

/**
 * Which case a request is about, recovered from the note in its user message.
 *
 * The loop sends the document verbatim, so the stub can answer per case without the test
 * having to know the order the corpus is walked in.
 */
const caseOfBody = (body: any): string | undefined => {
  const sent = String(body?.messages?.[1]?.content ?? '')
  return loadVitalCases(pack, fields).cases.find((c) => pack.document(c.name) === sent)?.name
}

/** Every reading absent: parses, scores zero detection, and never hallucinates. */
const EMPTY_VITALS = JSON.stringify({
  ...Object.fromEntries(fields.map((f) => [f.name, null])),
  extraction_confidence: 0.5,
  notes: null,
})

const EMPTY_SUMMARY = JSON.stringify({ history: [], usual_medication: [], pending: [] })
const EMPTY_FORMAT = JSON.stringify({ presenting_complaint: null, history: [], plan: [], current_medication: [] })

// --- The filter that was never applied ----------------------------------------------------

test('--difficulty selects the cases it names, for every task', async (t) => {
  const all = loadVitalCases(pack, fields).cases
  const d5 = all.filter((c) => c.difficulty === 5)
  assert.ok(d5.length > 0 && d5.length < all.length, 'the corpus needs both tiers for this to mean anything')

  const s = await serve(() => EMPTY_VITALS)
  const { trace, dir } = tracing()
  const r = await quiet(() => runVitalSignsEval({ pack, baseUrl: s.url, trace, constrain: false, difficulty: '5' }))
  assert.equal(r.cases, d5.length)
  assert.equal(s.bodies.length, d5.length, 'one request per selected case, and none for the rest')
  rmSync(dir, { recursive: true, force: true })
  await s.close()

  // The two set tasks are where the flag reached the options and was read by nothing.
  const formatCases = loadFormatCases(pack).cases
  const formatD5 = formatCases.filter((c) => c.difficulty === 5)
  if (formatD5.length && formatD5.length < formatCases.length) {
    const s2 = await serve(() => EMPTY_FORMAT)
    const t2 = tracing()
    await quiet(() => runNoteFormatEval({ pack, baseUrl: s2.url, trace: t2.trace, constrain: false, difficulty: '5' }))
    assert.equal(s2.bodies.length, formatD5.length, 'note-format ignored --difficulty entirely')
    rmSync(t2.dir, { recursive: true, force: true })
    await s2.close()
  } else {
    t.diagnostic('note-format has no partial difficulty-5 selection to test')
  }

  const summaryCases = loadSummaryCases(pack).cases
  const summaryD5 = summaryCases.filter((c) => c.difficulty === 5)
  if (summaryD5.length && summaryD5.length < summaryCases.length) {
    const s3 = await serve(() => EMPTY_SUMMARY)
    const t3 = tracing()
    await quiet(() => runSummaryEval({ pack, baseUrl: s3.url, trace: t3.trace, constrain: false, difficulty: '5' }))
    assert.equal(s3.bodies.length, summaryD5.length)
    rmSync(t3.dir, { recursive: true, force: true })
    await s3.close()
  } else {
    t.diagnostic('summary has no partial difficulty-5 selection to test')
  }
})

/**
 * A filter that selects nothing is refused rather than run.
 *
 * A run over zero cases scores 1.0 on every rate — see `ratio`, where that is correct for a
 * CASE with nothing to find — so an empty selection would print a clean pass for a corpus of
 * nothing. The two set corpora have no easy tier at all, which makes them the natural place to
 * ask.
 */
test('a difficulty that selects no case is refused, not run as an empty corpus', async () => {
  const s = await serve(() => EMPTY_FORMAT)
  const { trace, dir } = tracing()
  await assert.rejects(
    () => quiet(() => runNoteFormatEval({ pack, baseUrl: s.url, trace, constrain: false, difficulty: '1' })),
    /no note-format cases at difficulty '1'/,
  )
  await assert.rejects(
    () => quiet(() => runSummaryEval({ pack, baseUrl: s.url, trace, constrain: false, difficulty: '1-2' })),
    /no summary cases at difficulty '1-2'/,
  )
  assert.equal(s.bodies.length, 0, 'and it is refused before anything reaches the server')
  rmSync(dir, { recursive: true, force: true })
  await s.close()
})

// --- The gate arithmetic, at the edge that used to read as a pass -------------------------

/**
 * The failure this check exists for was measured: on the unconstrained gemma-3-4b arm every
 * case failed to parse, no quote was ever checked, and the verdict line read
 * `provenance 100%, derivation 100%`. A gate cleared by measuring nothing is indistinguishable
 * from one cleared on evidence, which is the single thing a gate exists to tell apart.
 */
test('a run where nothing parsed fails its sub-gates instead of clearing them', async () => {
  const s = await serve(() => 'I am afraid I cannot help with that.')
  const { trace, dir } = tracing()
  const r = await quiet(() => runNoteFormatEval({ pack, baseUrl: s.url, trace, constrain: false }))

  // The task gate DOES have a denominator: a failed case is scored as a total loss rather than
  // skipped, so every expectation it carried counts as a miss. It fails on the number.
  assert.equal(r.measured, true)
  assert.equal(r.score, 0)
  assert.ok(!gatePasses(r))
  // The sub-gates are the ones with nothing behind them — no quote was ever checked — and
  // those are the numbers that read as `provenance 100%, derivation 100%` in the measured
  // failure this test is named after.
  for (const g of r.gates ?? []) {
    assert.equal(g.measured, false, `${g.name} checked nothing`)
    assert.ok(!gatePasses(g), `${g.name} must not pass on a zero denominator`)
    // The rate itself is still 1.0 — that is `ratio`, and it is correct for a CASE with
    // nothing to find. `measured` is what stops it being read as a verdict.
    assert.equal(g.score, 1)
  }
  assert.match(r.summary, /not measured/)
  rmSync(dir, { recursive: true, force: true })
  await s.close()
})

test('a run that detected nothing cannot clear the value and unit sub-gates', async () => {
  const s = await serve(() => EMPTY_VITALS)
  const { trace, dir } = tracing()
  const r = await quiet(() => runVitalSignsEval({ pack, baseUrl: s.url, trace, constrain: false }))
  assert.equal(r.tally.detected, 0)
  assert.equal(r.tally.hallucinations, 0, 'nulls everywhere invent nothing')
  // Detection is a real 0 over a real denominator: that fails the floor on the numbers.
  assert.ok(r.recall < r.floor)
  // Value and unit are rates over what was detected, which is zero — so they are 1.0 and the
  // profile refuses them on `measured` rather than on the number.
  assert.equal(r.valueRate, 1)
  assert.ok(!gatePasses({ score: r.valueRate, floor: r.valueFloor, measured: r.tally.detected > 0 }))
  rmSync(dir, { recursive: true, force: true })
  await s.close()
})

// --- What reaches the wire ----------------------------------------------------------------

/**
 * The pack's declared sampling has to reach the request body for EVERY task, or the header and
 * the trace describe a run that did not happen.
 */
test('every task sends the sampling, cap and schema label its pack declares', async () => {
  for (const [task, run, reply] of [
    ['vital-signs', runVitalSignsEval, EMPTY_VITALS],
    ['summary', runSummaryEval, EMPTY_SUMMARY],
    ['note-format', runNoteFormatEval, EMPTY_FORMAT],
  ] as const) {
    const s = await serve(() => reply)
    const { trace, dir } = tracing()
    await quiet(() => (run as (o: any) => Promise<unknown>)({ pack, baseUrl: s.url, trace, constrain: true, difficulty: undefined }))
    const declared = loadSampling(pack, SAMPLING_KEY[task])
    const body = s.bodies[0] as any
    assert.ok(body, `${task} sent no request`)
    assert.equal(body.max_tokens, declared.max_tokens, `${task} sent a cap the pack does not declare`)
    assert.equal(body.temperature, declared.temperature, `${task} sent a temperature the pack does not declare`)
    assert.equal(body.cache_prompt, true)
    // Constrained means a grammar, under the label the pack names — a body that differs from
    // the measured one is what the byte pins exist to prevent.
    assert.equal(body.response_format?.type, 'json_schema')
    assert.ok(body.response_format?.json_schema?.name, `${task} sent no schema label`)
    rmSync(dir, { recursive: true, force: true })
    await s.close()
  }
})

test('the unconstrained arm sends no grammar at all', async () => {
  const s = await serve(() => EMPTY_VITALS)
  const { trace, dir } = tracing()
  await quiet(() => runVitalSignsEval({ pack, baseUrl: s.url, trace, constrain: false, difficulty: '1' }))
  assert.equal((s.bodies[0] as any).response_format, undefined)
  rmSync(dir, { recursive: true, force: true })
  await s.close()
})

test('--no-cache-prompt reaches every request of a graded run', async () => {
  const s = await serve(() => EMPTY_VITALS)
  const { trace, dir } = tracing()
  await quiet(() => runVitalSignsEval({ pack, baseUrl: s.url, trace, constrain: false, difficulty: '1', cachePrompt: false }))
  assert.ok(s.bodies.length > 0)
  for (const b of s.bodies) assert.equal((b as any).cache_prompt, false)
  rmSync(dir, { recursive: true, force: true })
  await s.close()
})

// --- What the trace holds afterwards ------------------------------------------------------

test('the run event names what produced the run, and the record closes it', async () => {
  const s = await serve(() => EMPTY_VITALS)
  const { trace, dir } = tracing()
  await quiet(() => runVitalSignsEval({ pack, baseUrl: s.url, trace, constrain: false, difficulty: '1' }))

  const t = readTrace(trace.path)
  assert.equal(t.spec, TRACE_SPEC, 'every line carries the format it was written in')
  const run = t.events.find((e) => e.event === 'run')!
  assert.equal(run.model, 'stub-model', 'the SERVER is asked, not the pack')
  assert.equal(run.identified, true)
  const record = t.events.find((e) => e.event === 'record')!
  // Read rather than declared: the notes are named by a template, so a digest built from the
  // manifest's keys would pin the answer key and miss the measured input.
  assert.ok(Object.keys(record.contracts as object).some((p) => p.startsWith('notes/')))
  rmSync(dir, { recursive: true, force: true })
  await s.close()
})

/**
 * A server that will not say what it is serving produces a number nobody can attribute. The
 * flag is recorded so a consumer can refuse to quote it, rather than having to string-match a
 * placeholder that may be reworded.
 */
test('a run against a silent server is marked unidentified in its own trace', async () => {
  const server: Server = createServer((req, res) => {
    if (req.url?.includes('/v1/models') || req.url?.includes('/props')) {
      res.writeHead(404)
      return res.end()
    }
    let chunks = ''
    req.on('data', (c) => (chunks += c))
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: EMPTY_VITALS }, finish_reason: 'stop' }] }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  const { trace, dir } = tracing()
  await quiet(() => runVitalSignsEval({ pack, baseUrl: url, trace, constrain: false, difficulty: '1' }))
  const run = readTrace(trace.path).events.find((e) => e.event === 'run')!
  assert.equal(run.identified, false)
  assert.match(String(run.identityWarning), /should not be quoted/)
  assert.equal(readTrace(trace.path).events.find((e) => e.event === 'record')!.identified, false)

  rmSync(dir, { recursive: true, force: true })
  server.close()
  await once(server, 'close')
})

/**
 * The redactor, checked over a WHOLE trace from a real loop rather than over a hand-built
 * event.
 *
 * `redactClinical` elides `completion`, `error` and `misses[].detail`, and every one of those
 * was chosen by reading the code that writes them. That is exactly the method that misses the
 * fourth field. So: run the loop with the corpus treated as real, make the model echo a
 * distinctive phrase from a note, and scan every byte of the file for it.
 */
test('no line of a redacted trace contains note text', async () => {
  // A phrase from a real note in the corpus, so a leak has something recognisable to leak.
  const note = pack.document('vs-en-01-vitals-block')
  const phrase = note.split('\n').find((l) => l.trim().length > 25)!.trim()

  // The model quotes the note back in every field a trace event can carry it: the completion,
  // the parse error (which quotes the completion), and a miss detail (which quotes raw_text).
  const s = await serve(() =>
    JSON.stringify({
      ...Object.fromEntries(fields.map((f) => [f.name, null])),
      heart_rate: { value: 999, unit: 'bpm', raw_text: phrase },
      extraction_confidence: 0.9,
      notes: phrase,
    }),
  )
  // `false` is what a pack that does not declare its corpus synthetic gets — the safe default.
  const { trace, dir } = tracing(clinicalRedactor(false))
  await quiet(() => runVitalSignsEval({ pack, baseUrl: s.url, trace, constrain: false, difficulty: '1' }))

  const raw = readFileSync(trace.path, 'utf8')
  assert.ok(!raw.includes(phrase), 'a whole trace file must not contain a phrase from a note')
  // And the elision is a digest rather than a deletion, so two runs stay comparable.
  assert.match(raw, /\[redacted \d+ chars, sha256:[0-9a-f]{16}\]/)
  rmSync(dir, { recursive: true, force: true })
  await s.close()
})

test('the same trace with a synthetic corpus keeps the completion verbatim', async () => {
  const s = await serve(() => EMPTY_VITALS)
  const { trace, dir } = tracing(clinicalRedactor(true))
  await quiet(() => runVitalSignsEval({ pack, baseUrl: s.url, trace, constrain: false, difficulty: '1' }))
  assert.ok(readFileSync(trace.path, 'utf8').includes('extraction_confidence'), 'the trace is the evidence')
  rmSync(dir, { recursive: true, force: true })
  await s.close()
})

// --- Re-scoring what the trace kept -------------------------------------------------------

test('a fenced reply scores zero, and the same bytes score again with the fence stripped', async () => {
  /** The answer key for a case, as a reply — so the arithmetic is checkable without a model. */
  const perfect = (name: string): string => {
    const c = loadVitalCases(pack, fields).cases.find((x) => x.name === name)!
    return JSON.stringify({
      ...Object.fromEntries(fields.map((f) => [f.name, null])),
      ...Object.fromEntries(
        c.fields
          .filter((f) => f.expect.kind === 'value' || f.expect.kind === 'bp')
          .map((f) => [
            f.field,
            f.expect.kind === 'bp'
              ? { systolic: f.expect.systolic, diastolic: f.expect.diastolic, unit: f.expect.unit }
              : { value: (f.expect as { value: number }).value, unit: (f.expect as { unit: string }).unit },
          ]),
      ),
      extraction_confidence: 0.9,
      notes: null,
    })
  }

  // Every case answered from its own key and then wrapped in a markdown fence — the measured
  // failure mode of an unconstrained run, where every reply was fenced and every one of them
  // was right underneath.
  const s = await serve((body) => `\`\`\`json\n${perfect(caseOfBody(body)!)}\n\`\`\``)
  const { trace, dir } = tracing(clinicalRedactor(true))
  const live = await quiet(() => runVitalSignsEval({ pack, baseUrl: s.url, trace, constrain: false, difficulty: '1' }))

  // The graded path refuses the fence, deliberately: an application that does not strip one
  // receives nothing, and the eval reports what a caller actually gets.
  assert.equal(live.tally.detected, 0)
  assert.equal(live.tally.failedRuns, live.cases)

  // The trace kept the bytes, so the claim "that zero is a format failure, not a comprehension
  // failure" is checkable by anyone holding the file — which is the whole premise of writing it.
  const plain = rescoreTrace({ pack, path: trace.path })
  assert.equal(plain[0]!.rescored.detected, 0, 'the same refusal, off the recording')

  const stripped = rescoreTrace({ pack, path: trace.path, stripFences: true })
  assert.ok(stripped[0]!.rescored.gradedTotal > 0)
  assert.equal(stripped[0]!.rescored.detected, stripped[0]!.rescored.gradedTotal, 'every reading was there all along')
  // Every case that had a reading to lose moved; one with nothing to extract scored zero both
  // ways, which is correct and is why this is not a count of the whole selection.
  assert.ok(stripped[0]!.changed.length > 0, 'and the re-score says which cases moved')
  // A re-score never produces a pass. The floors belong to a run against a server.
  assert.ok(stripped[0]!.lines.join('\n').includes('re-scoring'))

  rmSync(dir, { recursive: true, force: true })
  await s.close()
})

test('a redacted trace is refused for re-scoring rather than scored as prose', async () => {
  const s = await serve(() => EMPTY_VITALS)
  const { trace, dir } = tracing(clinicalRedactor(false))
  await quiet(() => runVitalSignsEval({ pack, baseUrl: s.url, trace, constrain: false, difficulty: '1' }))
  assert.throws(() => rescoreTrace({ pack, path: trace.path }), /redacted completion/)
  rmSync(dir, { recursive: true, force: true })
  await s.close()
})

test('a fence is unwrapped literally, and a reply without one is untouched', () => {
  assert.equal(stripFence('```json\n{"a":1}\n```'), '{"a":1}')
  assert.equal(stripFence('```\n{"a":1}\n```'), '{"a":1}')
  assert.equal(stripFence('{"a":1}'), '{"a":1}')
  // Not greedy into the middle of a reply: a fence inside content is content.
  assert.equal(stripFence('{"a":"```"}'), '{"a":"```"}')
})

// --- What a repeated run reports ----------------------------------------------------------

test('--runs reports which case moved, not an average of the runs', async () => {
  // ONE case answered two different ways across its two runs, the others steady — the measured
  // flip in miniature, and the report has to name the one rather than average all of them.
  const flips = new Map<string, number>()
  const s = await serve((body) => {
    const name = caseOfBody(body)!
    const nth = flips.get(name) ?? 0
    flips.set(name, nth + 1)
    const tidy = name === 'vs-en-01-vitals-block' && nth > 0
    return JSON.stringify({
      ...Object.fromEntries(fields.map((f) => [f.name, null])),
      blood_pressure: {
        systolic: 148,
        diastolic: 92,
        unit: 'mmHg',
        raw_text: tidy ? 'bp 148/92 mmhg' : 'BP 148/92 mmHg',
      },
      extraction_confidence: 0.9,
      notes: null,
    })
  })
  const { trace, dir } = tracing()
  const r = await quiet(() => runVitalSignsEval({ pack, baseUrl: s.url, trace, constrain: false, difficulty: '1', runs: 2 }))

  assert.equal(r.stability.runs, 2)
  assert.deepEqual(
    r.stability.variedInText.map((c) => c.case),
    ['vs-en-01-vitals-block'],
    'the case that answered differently is named, and only that one',
  )
  assert.ok(r.stability.reproducibleShare < 1)
  // Under a case-sensitive quote rule the lowercased span is a different GRADE, which is the
  // point: the aggregate above is one draw from that, not a measurement.
  assert.deepEqual(r.stability.variedInScore.map((c) => c.case), ['vs-en-01-vitals-block'])
  rmSync(dir, { recursive: true, force: true })
  await s.close()
})
