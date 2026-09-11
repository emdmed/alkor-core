/**
 * Four gates on the ending, at no GPU cost.
 *
 * WHAT THIS MEASURES IS THE RENDERER, and saying so is the whole point of the file. It does
 * not measure a model, it does not measure the rule, and the numbers in its fixtures are
 * INPUTS rather than answers — a fixture that states `cardiogenic` is asking "does the page
 * say cardiogenic", not "is this patient in cardiogenic shock". No percentage produced here
 * may be quoted as clinical agreement; the shock and sepsis evals are where that is measured.
 *
 * It is cheap because the thing it grades is deterministic, and that is the reason the ending
 * was built deterministic. The gates:
 *
 * 1. CLOSURE — every line the page prints carries the input field it came from, and that field
 *    resolves in the input. This is the invention check. A renderer that composed a sentence
 *    out of its own vocabulary fails here rather than in front of a reader.
 * 2. AGREEMENT — the verdict printed is the verdict in the structure, character for character.
 * 3. SILENCE UNDER REFUSAL — a run a gate stopped prints no verdict at all, names the step that
 *    refused, and names the reason. Withholding is a graded behaviour, not an error path.
 * 4. DETERMINISM — the same structure renders to the same bytes.
 *
 * The corpus is the pack's own shock and qSOFA payloads, read through `pack.document(name,
 * 'exam')` and the two pure parsers. Nothing here runs medprotocol: resolving a payload is a
 * computation, and a test for a module whose contract is "computes nothing" should not need one.
 */

import type { Pack } from '../../core/pack.ts'
import type { EvalVerdict } from '../../core/profile.ts'
import { parseExam, type ShockCategory, type ShockExam } from '../clinical/shock.ts'
import { parseSepsis, type SepsisExam } from '../clinical/sepsis.ts'
import { claimLines, composeAssessment, renderAssessment, type RunView } from './assessment.ts'

type JsonObject = Record<string, unknown>

interface ShockFixture {
  name: string
  exam: ShockExam
  category: ShockCategory
  reason: string | null
}

interface SepsisFixture {
  name: string
  exam: SepsisExam
  positive: boolean
}

const readCases = (pack: Pack, key: string): JsonObject[] => {
  const raw = JSON.parse(pack.read(key)) as { cases?: unknown }
  return Array.isArray(raw.cases) ? (raw.cases as JsonObject[]) : []
}

const shockFixtures = (pack: Pack): ShockFixture[] =>
  readCases(pack, 'shockCases').map((c) => {
    const name = String(c.name)
    return {
      name,
      exam: parseExam(pack.document(name, 'exam'), `assessment eval fixture '${name}'`),
      category: c.expect as ShockCategory,
      reason: typeof c.expectReason === 'string' ? c.expectReason : null,
    }
  })

const sepsisFixtures = (pack: Pack): SepsisFixture[] =>
  readCases(pack, 'sepsisCases').map((c) => {
    const name = String(c.name)
    return {
      name,
      exam: parseSepsis(pack.document(name, 'exam'), `assessment eval fixture '${name}'`),
      positive: c.expect === true,
    }
  })

/**
 * A run as the workflow would hand it to the terminal step.
 *
 * Built here rather than by running the workflow, because a test of the renderer that needed
 * three models to produce its input would be a test nobody runs.
 */
const runFor = (options: {
  routes: string[]
  results: JsonObject
  initialInput?: string
  derivedOk?: boolean
  sourceOk?: boolean
  sourceIssues?: unknown[]
}): RunView => ({
  initialInput: options.initialInput ?? '',
  stoppedEarly: false,
  steps: [
    { step: 0, name: 'extract', profile: 'clinical', ok: true, output: { routes: options.routes, results: options.results } },
    { step: 1, name: 'verify-derived', profile: 'clinical-verifier', ok: options.derivedOk ?? true },
    {
      step: 2,
      name: 'verify-source',
      profile: 'verifier',
      ok: options.sourceOk ?? true,
      report: { verified: options.sourceOk ?? true, issues: options.sourceIssues ?? [] },
    },
  ],
})

const shockRun = (fixture: ShockFixture): RunView =>
  runFor({
    initialInput: JSON.stringify(fixture.exam),
    routes: ['shock-extraction', 'shock'],
    results: {
      'shock-extraction': { ok: true, output: { exam: fixture.exam } },
      shock: {
        ok: true,
        output: {
          skin_temperature: fixture.exam.skin_temperature,
          jugular_venous_pressure: fixture.exam.jugular_venous_pressure,
          shock_category: fixture.category,
          supporting_findings: [],
          discordant_findings: [],
          indeterminate_reason: fixture.reason === null ? null : `the payload is ${fixture.reason}`,
          assessment_confidence: 0.9,
          notes: null,
        },
      },
    },
  })

const qsofaScore = (fixture: SepsisFixture): number => (fixture.positive ? 2 : 1)

const sepsisRun = (fixture: SepsisFixture): RunView =>
  runFor({
    initialInput: JSON.stringify(fixture.exam),
    routes: ['sepsis'],
    results: {
      sepsis: {
        ok: true,
        output: {
          respiratory_rate: fixture.exam.respiratory_rate,
          systolic_bp: fixture.exam.systolic_bp,
          gcs: fixture.exam.gcs,
          qsofa_score: qsofaScore(fixture),
          positive: fixture.positive,
          criteria_met: [],
          screen_reason: null,
          assessment_confidence: 0.9,
          notes: null,
        },
      },
    },
  })

/**
 * Does a claim's field resolve in the run it was composed from?
 *
 * `results.*` paths are read against the clinical step's output and `initial.*` against the
 * initial input, because those are the two things the ending is allowed to read. A path that
 * lands on `undefined` is a line with no source, which is the failure this gate is for.
 */
const resolves = (run: RunView, field: string): boolean => {
  const parts = field.split('.')
  const head = parts[0]!
  let cursor: unknown
  if (head === 'results') {
    cursor = (run.steps.find((s) => s.profile === 'clinical')?.output as JsonObject | undefined)?.results
  } else if (head === 'initial') {
    try {
      cursor = JSON.parse(run.initialInput)
    } catch {
      return false
    }
  } else {
    return false
  }
  for (const part of parts.slice(1)) {
    if (cursor === null || typeof cursor !== 'object') return false
    cursor = (cursor as JsonObject)[part]
  }
  return cursor !== undefined
}

interface Failure {
  gate: string
  case: string
  detail: string
}

export const runAssessmentEval = async (o: { pack: Pack }): Promise<EvalVerdict> => {
  const failures: Failure[] = []
  let checked = 0

  const check = (gate: string, name: string, ok: boolean, detail: string) => {
    if (!ok) failures.push({ gate, case: name, detail })
  }

  for (const fixture of shockFixtures(o.pack)) {
    const run = shockRun(fixture)
    const assessment = composeAssessment(run, { name: o.pack.name, spec: o.pack.spec })
    const page = renderAssessment(assessment)
    checked++

    for (const line of claimLines(assessment)) {
      check('closure', fixture.name, resolves(run, line.field), `'${line.text}' cites ${line.field}, which resolves to nothing`)
    }
    check('agreement', fixture.name, assessment.status === 'assessed', `status was ${assessment.status}`)
    check('agreement', fixture.name, page.includes(`Shock: ${fixture.category}`), `page does not state 'Shock: ${fixture.category}'`)
    check('determinism', fixture.name, renderAssessment(composeAssessment(run, { name: o.pack.name, spec: o.pack.spec })) === page, 'two renders of one run differ')
  }

  for (const fixture of sepsisFixtures(o.pack)) {
    const run = sepsisRun(fixture)
    const assessment = composeAssessment(run, { name: o.pack.name, spec: o.pack.spec })
    const page = renderAssessment(assessment)
    checked++

    for (const line of claimLines(assessment)) {
      check('closure', fixture.name, resolves(run, line.field), `'${line.text}' cites ${line.field}, which resolves to nothing`)
    }
    const expected = `Sepsis screen: qSOFA ${qsofaScore(fixture)} — ${fixture.positive ? 'POSITIVE' : 'negative'}`
    check('agreement', fixture.name, page.includes(expected), `page does not state '${expected}'`)
    check('determinism', fixture.name, renderAssessment(composeAssessment(run, { name: o.pack.name, spec: o.pack.spec })) === page, 'two renders of one run differ')
  }

  // Silence under refusal: the same payloads, with each gate refusing in turn. A verdict that
  // survives a refusal is the one failure that would make the whole ending untrustworthy.
  const refusals: Array<{ name: string; run: RunView; names: string }> = shockFixtures(o.pack).slice(0, 4).flatMap((fixture) => {
    const base = shockRun(fixture)
    return [
      {
        name: `${fixture.name}/derived-refused`,
        names: 'results.shock.output.shock_category',
        run: {
          ...base,
          stoppedEarly: true,
          steps: [
            base.steps[0]!,
            { step: 1, name: 'verify-derived', profile: 'clinical-verifier', ok: false, error: 'results.shock.output.shock_category: expected hypovolemic' },
          ],
        },
      },
      {
        name: `${fixture.name}/source-refused`,
        names: 'quote',
        run: {
          ...base,
          stoppedEarly: true,
          steps: [
            base.steps[0]!,
            base.steps[1]!,
            { step: 2, name: 'verify-source', profile: 'verifier', ok: false, error: 'verification failed: quote not present in document', report: { verified: false, issues: [] } },
          ],
        },
      },
    ]
  })

  for (const refusal of refusals) {
    const assessment = composeAssessment(refusal.run, { name: o.pack.name, spec: o.pack.spec })
    const page = renderAssessment(assessment)
    checked++
    check('silence', refusal.name, assessment.status === 'withheld', `status was ${assessment.status}`)
    check('silence', refusal.name, assessment.syndromes.length === 0, `${assessment.syndromes.length} verdict(s) survived a refusal`)
    check('silence', refusal.name, !/^Shock: |^Sepsis screen: /m.test(page), 'the page states a verdict after a refusal')
    check('silence', refusal.name, page.includes(refusal.names), `the page does not name what refused (${refusal.names})`)
    check('determinism', refusal.name, renderAssessment(composeAssessment(refusal.run, { name: o.pack.name, spec: o.pack.spec })) === page, 'two renders of one run differ')
  }

  const byGate = new Map<string, number>()
  for (const failure of failures) byGate.set(failure.gate, (byGate.get(failure.gate) ?? 0) + 1)

  for (const failure of failures.slice(0, 20)) {
    console.log(`  [${failure.gate}] ${failure.case}: ${failure.detail}`)
  }
  if (failures.length > 20) console.log(`  … and ${failures.length - 20} more`)

  const gates = ['closure', 'agreement', 'silence', 'determinism']
  for (const gate of gates) {
    const failed = byGate.get(gate) ?? 0
    console.log(`  ${gate.padEnd(12)} ${failed === 0 ? 'PASS' : `FAIL (${failed})`}`)
  }

  return {
    pass: failures.length === 0,
    summary:
      failures.length === 0
        ? `${checked} rendered assessments, all four gates clear (closure, agreement, silence, determinism) — renderer only, no model and no clinical claim`
        : `${failures.length} failure(s) across ${checked} rendered assessments: ${gates.filter((g) => byGate.get(g)).join(', ')}`,
  }
}
