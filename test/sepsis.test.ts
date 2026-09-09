/**
 * The sepsis contract: the rule, the payloads, the answer key and the scorer.
 *
 * Nothing here talks to a model. The screen is a decision delegated to the medprotocol CLI, so
 * the parts worth testing are the parts a run would otherwise report a number about without
 * anyone noticing: a threshold reimplemented as `>` or `<=`, a corpus that never exercises one
 * verdict, an answer key that has drifted from the rule it restates, and a scorer that credits a
 * verdict reached from inputs the payload does not contain.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPack } from '../src/core/pack.ts'
import { openTrace } from '../src/core/trace.ts'
import { clinicalRedactor } from '../src/profiles/clinical/redact.ts'
import { loadSampling } from '../src/profiles/clinical/settings.ts'
import { gatePasses } from '../src/profiles/clinical/set-eval.ts'
import { runSepsisEval } from '../src/profiles/clinical/sepsis-eval.ts'
import { ProfileError } from '../src/core/profile.ts'
import {
  CONTRACTS,
  TASKS,
  buildRequest,
} from '../src/profiles/clinical/contracts.ts'
import {
  CRITERIA,
  assess,
  gate,
  loadSepsisCases,
  loadSepsisRule,
  parseSepsis,
  parseSepsisReply,
  renderSepsis,
  resolveCriteria,
  resolveSepsis,
  scoreReply,
  totals,
  type SepsisCase,
  type SepsisExam,
  type SepsisReply,
} from '../src/profiles/clinical/sepsis.ts'
import { checkMedprotocolVersion, evaluateQSOFA, loadMedprotocolRule } from '../src/profiles/clinical/medprotocol.ts'

const pack = loadPack(join(import.meta.dirname, '..', 'packs', 'clinical'))
const rule = loadSepsisRule(pack)
const mp = loadMedprotocolRule(pack)
const cases = loadSepsisCases(pack, mp)

/** A qSOFA payload, overridden per test. Illustrative unless a field says otherwise. */
const exam = (over: Partial<SepsisExam> = {}): SepsisExam => ({
  respiratory_rate: 18,
  systolic_bp: 118,
  gcs: 15,
  ...over,
})

const resolved = (over: Partial<SepsisExam> = {}) => resolveSepsis(exam(over), rule, mp)

// --- The rule ------------------------------------------------------------------------------

test('the six eyes agree with medprotocol on every payload', () => {
  for (const over of [
    {},
    { respiratory_rate: 22, systolic_bp: 100, gcs: 14 },
    { respiratory_rate: 23, systolic_bp: 99, gcs: 15 },
    { respiratory_rate: 18, systolic_bp: 118, gcs: 13 },
    { respiratory_rate: 28, systolic_bp: 130, gcs: 15 },
    { respiratory_rate: 16, systolic_bp: 88, gcs: 15 },
  ]) {
    const r = resolved(over)
    const t = assess(r)
    assert.equal(t.score, r.screen.score, `score mismatch for ${JSON.stringify(over)}`)
    assert.equal(t.positive, r.screen.positive, `positive mismatch for ${JSON.stringify(over)}`)
  }
})

/**
 * The boundaries are the published ones, and each is pinned in the direction that matters.
 *
 * qSOFA is three comparisons and a two-of-three rule. The corpus pins the direction of each
 * comparison at the boundary (sp-09 through sp-12); this pins the rule they grade against.
 */
test('each threshold is inclusive or exclusive exactly as qSOFA draws it', () => {
  const rr = (v: number) => resolveCriteria(exam({ respiratory_rate: v }), rule)
  const sbp = (v: number) => resolveCriteria(exam({ systolic_bp: v }), rule)
  const gcs = (v: number) => resolveCriteria(exam({ gcs: v }), rule)
  assert.equal(rr(22).respiratory_rate, true, '22 meets the threshold (>=)')
  assert.equal(rr(21).respiratory_rate, false, '21 does not')
  assert.equal(sbp(100).systolic_bp, true, '100 meets the threshold (<=)')
  assert.equal(sbp(101).systolic_bp, false, '101 does not')
  assert.equal(gcs(15).altered_mental_status, false, 'a GCS of 15 is alert')
  assert.equal(gcs(14).altered_mental_status, true, 'a GCS of 14 is altered (< 15)')
})

test('a positive screen is at least two criteria, and the corpus has one- and two-criterion cases', () => {
  assert.equal(rule.criteriaForPositive, 2)
  // Each single criterion, alone, is a negative screen.
  assert.equal(assess(resolved({ respiratory_rate: 24, systolic_bp: 130, gcs: 15 })).positive, false)
  assert.equal(assess(resolved({ respiratory_rate: 16, systolic_bp: 88, gcs: 15 })).positive, false)
  assert.equal(assess(resolved({ respiratory_rate: 16, systolic_bp: 120, gcs: 10 })).positive, false)
  // Any two, even when the one that fails is the eye-catching one, is positive.
  assert.equal(assess(resolved({ respiratory_rate: 21, systolic_bp: 90, gcs: 10 })).positive, true)
  assert.equal(assess(resolved({ respiratory_rate: 24, systolic_bp: 101, gcs: 8 })).positive, true)
})

// --- The rendering -------------------------------------------------------------------------

/**
 * The rendering is the contract, so the bytes are pinned like a schema golden.
 *
 * Two runtimes that render the same six lines differently grade different inputs while appearing
 * to share a prompt, and the difference need only be a line break to move a small model.
 */
test('a payload renders to exactly the bytes the prompt was measured on', () => {
  assert.equal(
    renderSepsis(resolved({ respiratory_rate: 24, systolic_bp: 88, gcs: 12 })),
    'QUICK SOFA SCREEN\n' +
      'respiratory_rate: 24 breaths/min\n' +
      'systolic_bp: 88 mmHg\n' +
      'gcs: 12\n' +
      'qsofa_score: 3 (medprotocol: positive)\n' +
      'criteria_met: respiratory_rate, systolic_bp, altered_mental_status\n' +
      'positive_screen: yes\n',
  )
})

test('the screen is pre-decided in the rendering; the model is never asked to compute it', () => {
  assert.match(
    renderSepsis(resolved({ respiratory_rate: 18, systolic_bp: 118, gcs: 15 })),
    /qsofa_score: 0 \(medprotocol: negative\)/,
  )
  assert.match(
    renderSepsis(resolved({ respiratory_rate: 24, systolic_bp: 101, gcs: 8 })),
    /criteria_met: respiratory_rate, altered_mental_status/,
  )
})

// --- Loading ---------------------------------------------------------------------------

test('the answer key is reconciled against the reference rule at load', () => {
  // No mismatch can survive loadSepsisCases's cross-check, so the check is that the loader is
  // what carries it: the case file's `expect` must equal the derived screen for every case.
  for (const c of cases.cases) {
    assert.equal(c.expect, assess(c.resolved).positive, `${c.name} drifts from the CLI screen`)
  }
})

test('the loader refuses an answer key that disagrees with the CLI', () => {
  const one = cases.cases[1]
  const withFlip = cases.cases.map((c) => (c === one ? { ...c, exam: undefined, resolved: undefined, expect: !c.expect } : { ...c, exam: undefined, resolved: undefined }))
  assert.throws(
    () =>
      loadSepsisCases({ ...pack, read: (k: string) => (k === 'fake' ? JSON.stringify({ ...cases, cases: withFlip }) : pack.read(k)) } as any, mp, 'fake'),
    /disagree/,
  )
})

test('a corpus with only one verdict is refused', () => {
  // Take only the genuinely positive cases — every one agrees with the CLI, so the cross-check
  // passes, and the corpus is still all-positive, which is the shape the refusal exists for.
  const onlyPositive = cases.cases.filter((c) => c.expect).map(({ exam, resolved, ...c }) => c)
  assert.ok(onlyPositive.length >= 2, 'the corpus holds more than one positive case')
  assert.throws(
    () =>
      loadSepsisCases({ ...pack, read: (k: string) => (k === 'fake' ? JSON.stringify({ ...cases, cases: onlyPositive }) : pack.read(k)) } as any, mp, 'fake'),
    /positive case/,
  )
})

// --- The scorer -------------------------------------------------------------------------

test('a perfect reply scores perfect on every axis', () => {
  const c = cases.cases.find((c) => c.expect)!
  const r = c.resolved
  const reply: SepsisReply = {
    respiratory_rate: r.exam.respiratory_rate,
    systolic_bp: r.exam.systolic_bp,
    gcs: r.exam.gcs,
    qsofa_score: r.screen.score,
    positive: r.screen.positive,
    criteria_met: CRITERIA.filter((cc) => r.criteria[cc]),
    screen_reason: 'two criteria are met and the screen is positive',
    assessment_confidence: 0.9,
    notes: null,
  }
  assert.deepEqual(scoreReply(reply, r), {
    screenAgrees: true,
    echoCorrect: true,
    echoErrors: [],
    criteriaCorrect: true,
    criteriaErrors: [],
    statedScore: r.screen.score,
  })
})

/**
 * The axis that matters most is not the headline one.
 *
 * A model that echoes the CLI verdict but invented a criterion — or dropped one the payload met —
 * is not reading the screen, it is reasoning around it, and that is the exact failure this
 * contract exists to expose. Each is its own accusation, so the score names which criterion.
 */
test('a wrong echo is caught on each input', () => {
  const c = cases.cases.find((c) => c.expect)!
  const r = c.resolved
  const good: SepsisReply = {
    respiratory_rate: r.exam.respiratory_rate,
    systolic_bp: r.exam.systolic_bp,
    gcs: r.exam.gcs,
    qsofa_score: r.screen.score,
    positive: r.screen.positive,
    criteria_met: CRITERIA.filter((cc) => r.criteria[cc]),
    screen_reason: null,
    assessment_confidence: 0.9,
    notes: null,
  }
  for (const [field, value] of [
    ['respiratory_rate', r.exam.respiratory_rate + 1],
    ['systolic_bp', r.exam.systolic_bp - 1],
    ['gcs', r.exam.gcs === 15 ? 14 : 15],
  ] as const) {
    const s = scoreReply({ ...good, [field]: value }, r)
    assert.equal(s.echoCorrect, false, `${field} should be a misread`)
    assert.deepEqual(s.criteriaCorrect, true, 'the verdict and criteria can still be right from bad inputs')
  }
})

test('a listed criterion that is not met is its own accusation', () => {
  // Pick a positive case with exactly two criteria met, so there is a real non-met criterion
  // the model could over-cite.
  const c = cases.cases.find((c) => c.expect && assess(c.resolved).score === 2)!
  const r = c.resolved
  const met = CRITERIA.filter((cc) => r.criteria[cc])
  assert.equal(met.length, 2, `expected a two-criterion positive case, found ${met.length} on ${c.name}`)
  const over = CRITERIA.find((cc) => !r.criteria[cc])!
  const good: SepsisReply = {
    respiratory_rate: r.exam.respiratory_rate,
    systolic_bp: r.exam.systolic_bp,
    gcs: r.exam.gcs,
    qsofa_score: r.screen.score,
    positive: r.screen.positive,
    criteria_met: met,
    screen_reason: 'criteria are met and the screen is positive',
    assessment_confidence: 0.9,
    notes: null,
  }
  const withOver = scoreReply({ ...good, criteria_met: [...met, over] }, r)
  assert.equal(withOver.criteriaCorrect, false)
  assert.deepEqual(withOver.criteriaErrors, [over])
})

test('a met criterion that is omitted is caught, and a screen that got the verdict right still fails', () => {
  const c = cases.cases.find((c) => c.expect && assess(c.resolved).score >= 2)!
  const r = c.resolved
  const met = CRITERIA.filter((cc) => r.criteria[cc])
  assert.ok(met.length >= 2, 'this is a positive case')
  const reply: SepsisReply = {
    respiratory_rate: r.exam.respiratory_rate,
    systolic_bp: r.exam.systolic_bp,
    gcs: r.exam.gcs,
    qsofa_score: r.screen.score,
    positive: r.screen.positive,
    criteria_met: met.slice(1),
    screen_reason: 'some criteria are met and the screen is positive',
    assessment_confidence: 0.9,
    notes: null,
  }
  const s = scoreReply(reply, r)
  assert.equal(s.screenAgrees, true, 'the verdict is right')
  assert.equal(s.criteriaCorrect, false, 'but the criteria list is incomplete')
  assert.deepEqual(s.criteriaErrors, [met[0]])
})

// --- Parser -----------------------------------------------------------------------------

test('parseSepsisReply accepts a legal reply and refuses each malformed one', () => {
  const ok = parseSepsisReply('{"respiratory_rate":24,"systolic_bp":88,"gcs":12,"qsofa_score":3,"positive":true,"criteria_met":["respiratory_rate","systolic_bp","altered_mental_status"],"screen_reason":"three criteria","assessment_confidence":0.9,"notes":null}')
  assert.equal(ok.positive, true)
  assert.equal(ok.criteria_met.length, 3)

  // The strictness is the point (see parseSepsisReply): an unconstrained run's fence or
  // out-of-range number is the failure the grammar was carrying.
  assert.throws(() => parseSepsisReply('```json\n{"respiratory_rate":24}\n```'), /markdown code fence/)
  assert.throws(() => parseSepsisReply('{"respiratory_rate":24,"systolic_bp":88,"gcs":12,"qsofa_score":3,"positive":"true","criteria_met":[],"screen_reason":null,"assessment_confidence":0.9,"notes":null}'), /positive/)
  assert.throws(() => parseSepsisReply('{"respiratory_rate":24,"systolic_bp":88,"gcs":12,"qsofa_score":3,"positive":true,"criteria_met":["capillary_refill"],"screen_reason":null,"assessment_confidence":0.9,"notes":null}'), /criteria/)
  assert.throws(() => parseSepsisReply('{"respiratory_rate":24,"systolic_bp":88,"gcs":12,"qsofa_score":3,"positive":true,"criteria_met":[],"screen_reason":null,"assessment_confidence":"certain","notes":null}'), /assessment_confidence/)
})

test('parseSepsis accepts a legal payload and refuses a missing or out-of-range input', () => {
  assert.equal(parseSepsis('{"respiratory_rate":24,"systolic_bp":88,"gcs":12}', 'where').gcs, 12)
  assert.throws(() => parseSepsis('{"respiratory_rate":24,"systolic_bp":88}', 'where'), /gcs/)
  assert.throws(() => parseSepsis('{"respiratory_rate":240,"systolic_bp":88,"gcs":12}', 'where'), /respiratory_rate/)
  assert.throws(() => parseSepsis('{"respiratory_rate":24,"systolic_bp":88,"gcs":2}', 'where'), /gcs/)
})

// --- The eval loop, end to end --------------------------------------------------------------

/**
 * The same stub server as shock.test.ts, for the same reason: the questions worth asking —
 * what reached the model, what the gate did with the reply, what the trace holds afterwards —
 * are properties of the transport boundary.
 */

const serve = async (reply: (body: any, n: number) => string) => {
  const bodies: any[] = []
  const server = createServer((req, res) => {
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
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    },
  }
}

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

const tracing = () => {
  const dir = mkdtempSync(join(tmpdir(), 'medextract-sepsis-'))
  const before = process.env.TRACE_DIR
  process.env.TRACE_DIR = dir
  const trace = openTrace('sepsis-test', clinicalRedactor(true))
  if (before === undefined) delete process.env.TRACE_DIR
  else process.env.TRACE_DIR = before
  return { trace, dir, lines: () => readFileSync(trace.path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) }
}

/**
 * Which case a request is about, recovered from the rendered payload in its user message.
 *
 * It THROWS on no match rather than returning undefined, and that is the useful behaviour: a
 * miss means the loop sent bytes no payload in the corpus renders to, which is the failure these
 * tests most need to catch and the one a silent `undefined` would turn into a confusing assertion
 * about a canned reply somewhere else.
 */
const caseOfBody = (body: any): SepsisCase => {
  const sent = String(body?.messages?.[1]?.content ?? '')
  const found = cases.cases.find((c) => renderSepsis(c.resolved) === sent)
  if (!found) throw new Error(`the loop sent a payload no case renders to:\n${sent}`)
  return found
}

/** A reply that agrees with the reference arm on whatever case the request is about. */
const perfectFor = (c: SepsisCase) => {
  const r = c.resolved
  return JSON.stringify({
    respiratory_rate: r.exam.respiratory_rate,
    systolic_bp: r.exam.systolic_bp,
    gcs: r.exam.gcs,
    qsofa_score: r.screen.score,
    positive: r.screen.positive,
    criteria_met: CRITERIA.filter((cc) => r.criteria[cc]),
    screen_reason: 'the criteria the screen met, and what that means',
    assessment_confidence: 0.9,
    notes: null,
  })
}

/**
 * The whole loop, on a model that agrees with the reference arm everywhere.
 *
 * It checks the arithmetic AND the wiring: fourteen requests for fourteen payloads, the pack's
 * cap and label on every body, and a gate that passes. A perfect run passing is not a given — it
 * is how a gate is known to be reachable at all, and this pack has a floor of 1.0 on two axes.
 */
test('the eval runs the corpus and a rule-agreeing model clears every gate', async () => {
  const stub = await serve((body) => perfectFor(caseOfBody(body)))
  const { trace } = tracing()
  try {
    const result = await quiet(() =>
      runSepsisEval({ pack, baseUrl: stub.url, trace, constrain: true, cachePrompt: false }),
    )
    assert.equal(result.task, 'sepsis')
    assert.equal(result.score, 1)
    assert.equal(result.measured, true)
    assert.equal(gatePasses(result), true)
    for (const g of result.gates!) assert.equal(gatePasses(g), true, `${g.name} did not clear`)

    // One request per payload, and no retries: a parse failure would double a case silently.
    const chat = stub.bodies.filter((b) => b.messages)
    assert.equal(chat.length, cases.cases.length)

    // The pack's declared cap and label, not a harness default. A header that names one number
    // while the body sends another is the specific lie this repository exists to prevent.
    const sampling = loadSampling(pack, CONTRACTS.sepsis.samplingKey)
    for (const b of chat) {
      assert.equal(b.max_tokens, sampling.max_tokens)
      assert.equal(b.temperature, 0)
      assert.equal(b.response_format?.json_schema?.name, 'sepsis_screen')
    }
  } finally {
    await stub.close()
  }
})

/**
 * What reached the model is the RENDERING, not the payload file.
 *
 * The whole point of `renderSepsis` living in sepsis.ts is that the eval and the consuming
 * application send the same bytes. A loop that sent `JSON.stringify(exam)` — or the file — would
 * measure a prompt nobody ships, and every number would still look fine.
 */
test('the loop sends the rendered payload, and never the raw file', async () => {
  const stub = await serve((body) => perfectFor(caseOfBody(body)))
  const { trace } = tracing()
  try {
    await quiet(() => runSepsisEval({ pack, baseUrl: stub.url, trace, constrain: true, cachePrompt: false }))
    const sent = stub.bodies.filter((b) => b.messages).map((b) => String(b.messages[1].content))
    assert.equal(sent.length, cases.cases.length)
    for (const s of sent) {
      assert.ok(s.startsWith('QUICK SOFA SCREEN\n'), 'the rendering, not the file')
      assert.ok(!s.includes('"respiratory_rate"'), 'the raw JSON payload must not reach the model')
    }
    // And the system prompt is byte-identical across every case, which is what makes
    // `cache_prompt` worth having and what a second runtime would compare against.
    const prompts = new Set(stub.bodies.filter((b) => b.messages).map((b) => String(b.messages[0].content)))
    assert.equal(prompts.size, 1)
  } finally {
    await stub.close()
  }
})

/**
 * A run whose every reply is unparseable scores nothing and must NOT pass.
 *
 * This is the failure `measured` exists for, and it is not hypothetical: an unconstrained
 * model that fenced every reply would otherwise clear a floor over an empty denominator and
 * read as a perfect screen.
 */
test('a run where nothing parsed fails rather than clearing a floor on zero cases', async () => {
  const stub = await serve(() => '```json\n{"positive":true}\n```')
  const { trace } = tracing()
  try {
    const result = await quiet(() =>
      runSepsisEval({ pack, baseUrl: stub.url, trace, constrain: false, cachePrompt: false }),
    )
    assert.equal(result.measured, false)
    assert.equal(gatePasses(result), false)
    for (const g of result.gates!) assert.equal(gatePasses(g), false, `${g.name} cleared on nothing`)
  } finally {
    await stub.close()
  }
})

/**
 * One invented criterion on ONE case out of fourteen fails the whole run.
 *
 * criteriaFidelityFloor is 1.0, so a single case where the model listed a criterion that was
 * not met is the whole difference between a pass and a fail. The case chosen exercises the
 * temptation: a model that believes a positive screen needs company adds the criterion that
 * tips it over, a respiratory rate one below the cut.
 */
test('one criterion that is not met fails the run, with the verdict still perfect', async () => {
  const stub = await serve((body) => {
    const c = caseOfBody(body)
    const base = JSON.parse(perfectFor(c))
    if (c.name === 'sp-13-rr-just-below') base.criteria_met = ['respiratory_rate', 'systolic_bp', 'altered_mental_status']
    return JSON.stringify(base)
  })
  const { trace, lines } = tracing()
  try {
    const result = await quiet(() =>
      runSepsisEval({ pack, baseUrl: stub.url, trace, constrain: true, cachePrompt: false }),
    )
    assert.equal(result.score, 1, 'every verdict still agrees with the screen')
    assert.equal(gatePasses(result), true, 'so the headline gate passes')
    const criteria = result.gates!.find((g) => g.name === 'criteriaFidelity')!
    assert.equal(gatePasses(criteria), false, 'and the run still fails, on the sub-gate')

    // The trace names the case and the criterion, so the failure is actionable without a re-run.
    const bad = lines().find((l) => l.event === 'case' && l.case === 'sp-13-rr-just-below')
    assert.deepEqual(bad.score.criteriaErrors, ['respiratory_rate'])
  } finally {
    await stub.close()
  }
})

/**
 * The trace records the reference arm's answer beside the model's, and the cuts it came from.
 *
 * A disagreement that can only be understood by re-deriving the screen is a disagreement nobody
 * checks, and a number reproduced against a different threshold is a number about a different
 * contract.
 */
test('the trace carries the reference arm and the rule it was computed under', async () => {
  const stub = await serve((body) => perfectFor(caseOfBody(body)))
  const { trace, lines } = tracing()
  try {
    await quiet(() => runSepsisEval({ pack, baseUrl: stub.url, trace, constrain: true, cachePrompt: false }))
    const l = lines()
    const record = l.find((x) => x.event === 'record')
    assert.equal(record.rule.gcsBelow, 15)
    assert.equal(record.rule.respiratoryRateAtLeast, 22)
    assert.equal(record.rule.systolicAtMost, 100)
    assert.equal(record.pass, true)

    const sp13 = l.find((x) => x.event === 'case' && x.case === 'sp-13-rr-just-below')
    assert.deepEqual(sp13.expected, { positive: true, score: 2, criteria: { respiratory_rate: false, systolic_bp: true, altered_mental_status: true } })
  } finally {
    await stub.close()
  }
})

// --- The routing ------------------------------------------------------------------------

test('the qsofa-json shape routes to the sepsis task', async () => {
  const { routeClinicalShape } = await import('../src/profiles/clinical/clinical-router.ts')
  const r = routeClinicalShape(JSON.stringify({ respiratory_rate: 24, systolic_bp: 88, gcs: 12 }))
  assert.equal(r.shape, 'qsofa-json')
  assert.equal(r.task, 'sepsis')
  // The shock exam payload must not be mistaken for a qSOFA payload.
  const shock = routeClinicalShape(JSON.stringify({ systolic_bp: 80, heart_rate: 118, capillary_refill: 'delayed' }))
  assert.equal(shock.shape, 'exam-json')
  assert.equal(shock.task, 'shock')
})