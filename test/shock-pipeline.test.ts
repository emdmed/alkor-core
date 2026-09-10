/**
 * shock-pipeline: prose → extraction → classification, end-to-end.
 *
 * Every test drives the real evaluator through a stub `Provider`, so what is exercised is the
 * production chain — both requests, both parsers, `resolveExam`, `renderExam` and the gates —
 * with only the transport replaced. The medprotocol fixture stands in for the CLI.
 *
 * The gates are what these tests are mostly about. An eval that reports a passing number on
 * evidence it never collected is worse than one that fails, because the failure is legible and
 * the false pass is not, so each denominator gets a test that would catch it being widened.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { loadPack } from '../src/core/pack.ts'
import { nullTrace } from '../src/core/trace.ts'
import type { ChatOptions, Provider } from '../src/core/client.ts'
import { gatePasses } from '../src/profiles/clinical/set-eval.ts'

process.env.MEDPROTOCOL_BIN = join(import.meta.dirname, 'fixtures', 'medprotocol.js')

const { runShockPipelineEval } = await import('../src/profiles/clinical/shock-pipeline-eval.ts')
const { loadShockExtractionCases } = await import('../src/profiles/clinical/shock-extraction-eval.ts')

const pack = loadPack(join(import.meta.dirname, '..', 'packs', 'clinical'))

/** The gold payload for a case, as the pack states it — the extractor's expectation. */
const goldExam = (name: string): Record<string, unknown> =>
  JSON.parse(pack.document(name, 'exam')) as Record<string, unknown>

/** A well-formed classification reply. Fields default to a correct septic reading of sh-01. */
const reply = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    skin_temperature: 'warm',
    jugular_venous_pressure: 'normal_or_low',
    shock_category: 'septic',
    supporting_findings: ['skin_temperature', 'jugular_venous_pressure'],
    discordant_findings: [],
    indeterminate_reason: null,
    assessment_confidence: 0.9,
    notes: null,
    ...over,
  })

/**
 * Run the evaluator over one case with scripted stage replies.
 *
 * `--difficulty 1` is the whole prose corpus today; `only` narrows it to a single note so a
 * test can script two stages without knowing the order the others would run in.
 */
const run = async (o: {
  only: string
  extraction: (name: string) => string
  classification: (name: string, payload: string) => string
}) => {
  let current = o.only
  const seen: string[] = []
  const provider: Provider = {
    async chat(c: ChatOptions): Promise<string> {
      seen.push(c.label ?? '?')
      if (c.label === 'shock-extraction') return o.extraction(current)
      if (c.label === 'shock') return o.classification(current, c.userPrompt)
      throw new Error(`unexpected label ${c.label}`)
    },
    async toolChat() {
      return { content: '', toolCalls: [] }
    },
    async streamChat() {
      return { content: '', toolCalls: [], chunks: 0 }
    },
    async identify() {
      return { model: 'shock-pipeline-stub', identified: true }
    },
  }

  // One note at a time. The pack's difficulty tiers do not separate the three prose cases, so
  // the narrowing happens by filtering the corpus the evaluator would otherwise walk.
  const all = loadShockExtractionCases(pack).cases.map((c) => c.name)
  assert.ok(all.includes(o.only), `${o.only} is in the prose corpus`)
  const narrowed = Object.create(pack) as typeof pack
  Object.defineProperty(narrowed, 'read', {
    value: (key: string) => {
      const raw = pack.read(key)
      if (key !== 'shockExtractionCases') return raw
      const parsed = JSON.parse(raw) as { cases: Array<{ name: string }> }
      parsed.cases = parsed.cases.filter((c) => c.name === o.only)
      return JSON.stringify(parsed)
    },
  })

  current = o.only
  const result = await runShockPipelineEval({
    pack: narrowed,
    trace: nullTrace(),
    constrain: false,
    provider,
    identity: { model: 'shock-pipeline-stub', identified: true },
  })
  return { result, seen }
}

const gate = (result: { gates?: Array<{ name: string; score: number; floor: number; measured: boolean }> }, name: string) => {
  const g = result.gates?.find((x) => x.name === name)
  assert.ok(g, `gate ${name} is reported`)
  return g
}

test('perfect extraction and a correct classification clears every gate', async () => {
  const { result, seen } = await run({
    only: 'sh-01-septic-classic',
    extraction: (n) => JSON.stringify(goldExam(n)),
    classification: () => reply(),
  })

  assert.deepEqual(seen, ['shock-extraction', 'shock'])
  assert.equal(result.measured, true)
  assert.equal(result.score, 1)
  assert.ok(gatePasses({ score: result.score, floor: result.floor, measured: result.measured }))
  for (const g of result.gates ?? []) {
    assert.ok(gatePasses(g), `${g.name} clears its floor (${g.score} vs ${g.floor})`)
  }
  assert.equal(gate(result, 'extractionExact').score, 1)
  assert.equal(gate(result, 'pipelineCompletion').score, 1)
})

test('a wrong extracted primary finding fails extraction and carries into the category', async () => {
  // `skin_temperature: cool` with a normal_or_low JVP is the hypovolemic cell, so an extractor
  // that misreads the one finding the rule acts on moves the whole pipeline to another answer.
  const { result } = await run({
    only: 'sh-01-septic-classic',
    extraction: (n) => JSON.stringify({ ...goldExam(n), skin_temperature: 'cool' }),
    // The classifier reads the payload it was handed FAITHFULLY — this is the case that
    // separates the two failures. Its reading of the extracted exam is correct; the pipeline
    // is still wrong, because the note described a septic patient.
    classification: () => reply({ skin_temperature: 'cool', shock_category: 'hypovolemic' }),
  })

  assert.equal(result.score, 0, 'the pipeline did not reach the category the note describes')
  assert.equal(gate(result, 'extractionExact').score, 0)
  assert.ok(!gatePasses(gate(result, 'extractionExact')))
  // The classifier read its input correctly, and the echo sub-gate says so. That is the whole
  // point of grading the two separately: this run needs a prompt fix upstream, not downstream.
  assert.equal(gate(result, 'echoFidelity').score, 1)
  assert.equal(gate(result, 'pipelineCompletion').score, 1)
})

test('a correct extraction with a wrong category isolates the classifier', async () => {
  const { result } = await run({
    only: 'sh-01-septic-classic',
    extraction: (n) => JSON.stringify(goldExam(n)),
    classification: () => reply({ shock_category: 'cardiogenic' }),
  })

  assert.equal(result.score, 0)
  assert.equal(gate(result, 'extractionExact').score, 1, 'extraction was perfect')
  assert.equal(gate(result, 'echoFidelity').score, 1, 'the findings were echoed correctly')
  assert.ok(!gatePasses({ score: result.score, floor: result.floor, measured: result.measured }))
})

test('a malformed stage-1 reply fails the measurement rather than passing on an empty denominator', async () => {
  const { result, seen } = await run({
    only: 'sh-01-septic-classic',
    extraction: () => 'I am unable to produce JSON for this note.',
    classification: () => reply(),
  })

  // Stage 2 never ran: there was no payload to classify.
  assert.deepEqual(seen, ['shock-extraction'])
  assert.equal(result.measured, false, 'nothing was scored, so nothing can pass')
  assert.equal(gate(result, 'extractionExact').score, 0)
  assert.equal(gate(result, 'pipelineCompletion').score, 0)
  assert.ok(!gatePasses(gate(result, 'pipelineCompletion')))
  assert.ok(!gatePasses({ score: result.score, floor: result.floor, measured: result.measured }))
})

test('a classification that never parses cannot inflate the extraction share above 1.0', async () => {
  // The regression this test exists for: the extraction gate once divided exact matches by the
  // count of SCORED runs, so an attempt that extracted perfectly and then failed to classify
  // was counted in the numerator and dropped from the denominator — 1/0. The share is a share
  // of attempts, and an attempt that got nowhere is still an attempt.
  const { result } = await run({
    only: 'sh-01-septic-classic',
    extraction: (n) => JSON.stringify(goldExam(n)),
    classification: () => 'not json at all',
  })

  const g = gate(result, 'extractionExact')
  assert.ok(Number.isFinite(g.score), 'the extraction share is a finite number')
  assert.ok(g.score <= 1, `the extraction share is at most 1.0, got ${g.score}`)
  assert.equal(g.score, 1)
  assert.equal(gate(result, 'pipelineCompletion').score, 0)
  assert.ok(!gatePasses(gate(result, 'pipelineCompletion')), 'the completion gate catches it')
  assert.equal(result.measured, false)
})

test('the prose corpus states a category for every note and the rule agrees with it', async () => {
  const { loadMedprotocolRule } = await import('../src/profiles/clinical/medprotocol.ts')
  const mp = loadMedprotocolRule(pack)
  const { cases } = loadShockExtractionCases(pack, mp)
  assert.ok(cases.length > 0)
  for (const c of cases) {
    assert.ok(
      ['septic', 'cardiogenic', 'hypovolemic', 'indeterminate'].includes(c.expectCategory),
      `${c.name} names a category`,
    )
  }
})

test('the loader refuses a prose case whose stated category the rule does not compute', async () => {
  const { loadMedprotocolRule } = await import('../src/profiles/clinical/medprotocol.ts')
  const mp = loadMedprotocolRule(pack)
  const wrong = Object.create(pack) as typeof pack
  Object.defineProperty(wrong, 'read', {
    value: (key: string) => {
      const raw = pack.read(key)
      if (key !== 'shockExtractionCases') return raw
      const parsed = JSON.parse(raw) as { cases: Array<{ name: string; expect: string }> }
      // sh-01 is septic by the rule. Claiming cardiogenic is the disagreement the cross-check
      // exists to name — a bug in `classify` would otherwise redefine truth silently.
      for (const c of parsed.cases) if (c.name === 'sh-01-septic-classic') c.expect = 'cardiogenic'
      return JSON.stringify(parsed)
    },
  })

  assert.throws(
    () => loadShockExtractionCases(wrong, mp),
    /expects cardiogenic but the rule computes septic/,
  )
})

test('the loader refuses a pipeline floor block that is missing or out of range', async () => {
  const strip = (mutate: (p: Record<string, unknown>) => void) => {
    const p = Object.create(pack) as typeof pack
    Object.defineProperty(p, 'read', {
      value: (key: string) => {
        const raw = pack.read(key)
        if (key !== 'shockExtractionCases') return raw
        const parsed = JSON.parse(raw) as Record<string, unknown>
        mutate(parsed)
        return JSON.stringify(parsed)
      },
    })
    return p
  }

  await assert.rejects(
    () =>
      runShockPipelineEval({
        pack: strip((p) => delete p.pipeline),
        trace: nullTrace(),
        constrain: false,
        identity: { model: 'stub', identified: true },
      }),
    /must state a \[pipeline\] floor block/,
  )

  await assert.rejects(
    () =>
      runShockPipelineEval({
        pack: strip((p) => {
          ;(p.pipeline as Record<string, unknown>).completionFloor = 1.5
        }),
        trace: nullTrace(),
        constrain: false,
        identity: { model: 'stub', identified: true },
      }),
    /pipeline\.completionFloor must be a number in 0\.\.1/,
  )
})
