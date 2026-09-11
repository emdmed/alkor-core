/**
 * The end of the run: what the pipeline established about this patient, in one page.
 *
 * THIS MODULE COMPUTES NOTHING. It does not classify, it does not score, it does not re-read
 * the note. Every fact it prints was produced by an earlier step and already checked by
 * `clinical-verifier`; this is a rendering of those values and nothing else. That is the whole
 * design, and it buys two things. A second computation here would be a second answer standing
 * beside the first with no way to say which one the run means. And because the output is a
 * pure function of structures the run already holds, it can be graded by exact match at no
 * GPU cost — see `eval.ts`, which is the only reason an ending like this can be trusted at all.
 *
 * What it does decide is what NOT to say. A run whose gate refused gets no verdict, only the
 * refusal and its reason; a run that produced no syndrome verdict says so rather than
 * assembling the nearest thing to one. Declining is a rendered outcome here, not an error page.
 *
 * Free text the model wrote — `indeterminate_reason`, `screen_reason`, `notes` — is quoted
 * verbatim and attributed to its field. It is never paraphrased into a sentence of ours,
 * because the moment it is paraphrased nobody can tell which words were the model's.
 */

import { parseShockReply, parseExam, type ShockReply, type ShockExam, FINDING_NAMES } from '../clinical/shock.ts'
import { parseSepsisReply, type SepsisReply } from '../clinical/sepsis.ts'

/**
 * One printed fact and the input field it came from.
 *
 * The field is not decoration: `eval.ts` gates on every line having one that resolves in the
 * input, which is what makes "the ending invented something" a test failure rather than a
 * thing someone notices in a demo.
 */
export interface ClaimLine {
  field: string
  text: string
  /** Verbatim model prose. Rendered in quotes, never merged into surrounding text. */
  quoted?: boolean
}

export interface AssessedSyndrome {
  name: 'shock' | 'sepsis'
  headline: ClaimLine
  lines: ClaimLine[]
}

export type CheckState = 'passed' | 'failed' | 'not-run'

export interface AssessmentIssue {
  field: string
  issue: string
  severity?: string
}

/**
 * `assessed` — at least one syndrome verdict is stated.
 * `no-verdict` — the run finished and produced nothing that answers a clinical question.
 * `withheld` — a gate refused, so no verdict may be stated at all.
 */
export type AssessmentStatus = 'assessed' | 'no-verdict' | 'withheld'

export interface Assessment {
  status: AssessmentStatus
  label?: string
  syndromes: AssessedSyndrome[]
  /** Routes that ran and answer no clinical question — a transcript, a reformatted note. */
  other: ClaimLine[]
  verification: { derived: CheckState; source: CheckState; issues: AssessmentIssue[] }
  notAssessed: ClaimLine[]
  withheld?: { step: string; profile: string; reason: string }
  provenance: { pack?: string; spec?: number; medprotocol?: string }
}

/** One step of the run, as the terminal step receives it. */
export interface StepView {
  step: number
  name: string
  profile: string
  ok: boolean
  output?: unknown
  report?: unknown
  text?: string
  error?: string
}

export interface RunView {
  initialInput: string
  steps: StepView[]
  stoppedEarly: boolean
}

export interface PackView {
  name?: string
  spec?: number
  medprotocol?: string
  label?: string
}

type JsonObject = Record<string, unknown>

const object = (value: unknown): JsonObject | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined

/** Steps are found by PROFILE, never by index: reordering a recipe must not re-aim the ending. */
const stepOf = (run: RunView, profile: string): StepView | undefined =>
  run.steps.find((step) => step.profile === profile)

const issuesOf = (value: unknown): AssessmentIssue[] => {
  const report = object(value)
  const raw = Array.isArray(report?.issues) ? report.issues : []
  return raw.flatMap((entry) => {
    const issue = object(entry)
    if (!issue) return []
    return [{
      field: String(issue.field ?? 'unknown'),
      issue: String(issue.issue ?? 'unknown'),
      severity: typeof issue.severity === 'string' ? issue.severity : undefined,
    }]
  })
}

const list = (names: readonly string[]): string => (names.length ? names.join(', ') : 'none')

// --- Reading what the clinical step produced ------------------------------------------------

interface ClinicalReading {
  /** Task name to the parsed reply, for the two syndromes this ending can state. */
  shock?: ShockReply
  sepsis?: SepsisReply
  /** The payload a shock verdict was computed from, when a route supplied one. */
  exam?: ShockExam
  /**
   * Where that payload came from, so a line about it can name its own source. The two are
   * genuinely different provenance — one is a model's reading of prose, the other is the
   * input itself — and a citation that named the wrong one would be a wrong citation.
   */
  examSource?: 'route' | 'initial'
  /** Routes that ran and are not a syndrome verdict. */
  other: string[]
  /** Why a syndrome that WAS routed could not be read. */
  unreadable: string[]
}

const readExam = (value: unknown): ShockExam | undefined => {
  try {
    return parseExam(JSON.stringify(value), 'assessment input')
  } catch {
    return undefined
  }
}

/**
 * Read the clinical step's output.
 *
 * Two shapes arrive here and both are legitimate. A multi-task route returns
 * `{routes, results}`; a single-task route returns the bare constrained completion as a
 * string. The string is tried against each syndrome parser in turn — not to guess, but because
 * the two contracts share no required field, so at most one of them can accept it.
 */
const readClinical = (output: unknown, initialInput: string): ClinicalReading => {
  const reading: ClinicalReading = { other: [], unreadable: [] }

  const composite = object(output)
  if (composite && Array.isArray(composite.routes) && object(composite.results)) {
    const results = object(composite.results)!
    for (const route of composite.routes) {
      if (typeof route !== 'string') continue
      const value = object(results[route])?.output
      if (route === 'shock') {
        try {
          reading.shock = parseShockReply(typeof value === 'string' ? value : JSON.stringify(value))
        } catch (e) {
          reading.unreadable.push(`shock: ${(e as Error).message}`)
        }
      } else if (route === 'sepsis') {
        try {
          reading.sepsis = parseSepsisReply(typeof value === 'string' ? value : JSON.stringify(value))
        } catch (e) {
          reading.unreadable.push(`sepsis: ${(e as Error).message}`)
        }
      } else if (route === 'shock-extraction') {
        reading.exam = readExam(object(value)?.exam)
        if (reading.exam) reading.examSource = 'route'
        reading.other.push(route)
      } else {
        reading.other.push(route)
      }
    }
  } else if (typeof output === 'string') {
    try {
      reading.shock = parseShockReply(output)
    } catch {
      try {
        reading.sepsis = parseSepsisReply(output)
      } catch {
        // Neither contract; the run answered some other question and says so below.
      }
    }
  }

  // A shock verdict states two findings about a payload. When no extraction route supplied
  // one, the initial input may itself BE the payload — which is a read, not a derivation.
  if (reading.shock && !reading.exam) {
    try {
      reading.exam = parseExam(initialInput, 'assessment input')
      reading.examSource = 'initial'
    } catch {
      // The input was prose no route extracted a payload from; nothing to say about it.
    }
  }

  return reading
}

// --- Composing ------------------------------------------------------------------------------

const shockSyndrome = (reply: ShockReply): AssessedSyndrome => {
  const at = (field: string) => `results.shock.output.${field}`
  const lines: ClaimLine[] = [
    { field: at('skin_temperature'), text: `echo: skin ${reply.skin_temperature} · JVP ${reply.jugular_venous_pressure}` },
    { field: at('supporting_findings'), text: `supporting: ${list(reply.supporting_findings)}` },
    { field: at('discordant_findings'), text: `discordant: ${list(reply.discordant_findings)}` },
  ]
  if (reply.indeterminate_reason) {
    lines.push({ field: at('indeterminate_reason'), text: reply.indeterminate_reason, quoted: true })
  }
  if (reply.notes) lines.push({ field: at('notes'), text: reply.notes, quoted: true })
  lines.push({
    field: at('assessment_confidence'),
    text: `model confidence: ${reply.assessment_confidence} (self-reported, not measured)`,
  })
  return {
    name: 'shock',
    headline: { field: at('shock_category'), text: `Shock: ${reply.shock_category}` },
    lines,
  }
}

const sepsisSyndrome = (reply: SepsisReply): AssessedSyndrome => {
  const at = (field: string) => `results.sepsis.output.${field}`
  const lines: ClaimLine[] = [
    { field: at('respiratory_rate'), text: `echo: RR ${reply.respiratory_rate} · SBP ${reply.systolic_bp} · GCS ${reply.gcs}` },
    { field: at('criteria_met'), text: `criteria: ${list(reply.criteria_met)}` },
  ]
  if (reply.screen_reason) lines.push({ field: at('screen_reason'), text: reply.screen_reason, quoted: true })
  if (reply.notes) lines.push({ field: at('notes'), text: reply.notes, quoted: true })
  lines.push({
    field: at('assessment_confidence'),
    text: `model confidence: ${reply.assessment_confidence} (self-reported, not measured)`,
  })
  return {
    name: 'sepsis',
    headline: {
      field: at('qsofa_score'),
      text: `Sepsis screen: qSOFA ${reply.qsofa_score} — ${reply.positive ? 'POSITIVE' : 'negative'}`,
    },
    lines,
  }
}

/**
 * What the examination did not establish, named rather than left out.
 *
 * A finding the payload marks `not_assessed` is the difference between "this patient's JVP was
 * normal" and "nobody looked", and a summary that prints only what was found silently reports
 * the second as the first.
 */
const notAssessedOf = (exam: ShockExam | undefined, source: 'route' | 'initial' | undefined): ClaimLine[] => {
  if (!exam) return []
  const base = source === 'route' ? 'results.shock-extraction.output.exam' : 'initial'
  const record = exam as unknown as JsonObject
  return FINDING_NAMES.filter((name) => record[name] === 'not_assessed').map((name) => ({
    field: `${base}.${name}`,
    text: name,
  }))
}

const verificationOf = (run: RunView): Assessment['verification'] => {
  const derived = stepOf(run, 'clinical-verifier')
  const source = stepOf(run, 'verifier')
  const state = (step: StepView | undefined): CheckState =>
    step === undefined ? 'not-run' : step.ok ? 'passed' : 'failed'
  return {
    derived: state(derived),
    source: state(source),
    issues: [
      ...(derived && !derived.ok ? issuesOf(derived.report) : []),
      ...(source ? issuesOf(source.report) : []),
    ],
  }
}

/** The step that stopped the run, and what it said. */
const refusalOf = (run: RunView): Assessment['withheld'] | undefined => {
  const failed = run.steps.filter((step) => !step.ok).sort((a, b) => a.step - b.step)[0]
  if (!failed) return undefined
  return {
    step: failed.name,
    profile: failed.profile,
    reason: failed.error ?? failed.text ?? 'the step gave no reason',
  }
}

export const composeAssessment = (run: RunView, pack: PackView = {}): Assessment => {
  const provenance = { pack: pack.name, spec: pack.spec, medprotocol: pack.medprotocol }
  const verification = verificationOf(run)

  // A refusal ends it. Not a degraded assessment, not a best guess with a warning attached —
  // the check that would license a verdict said no, so no verdict is stated.
  if (run.stoppedEarly) {
    return {
      status: 'withheld',
      label: pack.label,
      syndromes: [],
      other: [],
      verification,
      notAssessed: [],
      withheld: refusalOf(run) ?? { step: 'unknown', profile: 'unknown', reason: 'the run stopped early' },
      provenance,
    }
  }

  const clinical = stepOf(run, 'clinical')
  const reading = clinical ? readClinical(clinical.output, run.initialInput) : { other: [], unreadable: [] }

  const syndromes: AssessedSyndrome[] = []
  if (reading.shock) syndromes.push(shockSyndrome(reading.shock))
  if (reading.sepsis) syndromes.push(sepsisSyndrome(reading.sepsis))

  const other: ClaimLine[] = [
    ...reading.other.map((route) => ({ field: `results.${route}`, text: `${route}: ran, states no syndrome verdict` })),
    ...reading.unreadable.map((why) => ({ field: 'results', text: `unreadable — ${why}` })),
  ]

  return {
    status: syndromes.length ? 'assessed' : 'no-verdict',
    label: pack.label,
    syndromes,
    other,
    verification,
    notAssessed: notAssessedOf(reading.exam, reading.examSource),
    provenance,
  }
}

// --- Rendering --------------------------------------------------------------------------------

const CAVEAT =
  'Not a diagnosis and not a medical device. Agreement with a published bedside heuristic, not clinical truth.'

const renderLine = (line: ClaimLine): string => (line.quoted ? `  "${line.text}"` : `  ${line.text}`)

const renderVerification = (v: Assessment['verification']): string[] => {
  const out = [`Verification: derived ${v.derived} · source ${v.source} (${v.issues.length} issue${v.issues.length === 1 ? '' : 's'})`]
  for (const issue of v.issues) {
    out.push(`  ${issue.field}: ${issue.issue}${issue.severity ? ` (${issue.severity})` : ''}`)
  }
  return out
}

const renderProvenance = (p: Assessment['provenance']): string[] => {
  const parts: string[] = []
  if (p.pack) parts.push(`pack ${p.pack}${p.spec === undefined ? '' : ` spec ${p.spec}`}`)
  if (p.medprotocol) parts.push(`medprotocol ${p.medprotocol}`)
  return parts.length ? [parts.join(' · ')] : []
}

/** The assessment as a page. A pure function of the structure: same input, same bytes. */
export const renderAssessment = (a: Assessment): string => {
  const where = a.label ?? 'supplied input'
  const out: string[] = []

  if (a.status === 'withheld') {
    out.push(`NO ASSESSMENT — ${where}`, '')
    const w = a.withheld!
    out.push(`Withheld at step '${w.step}' (${w.profile}):`, `  ${w.reason}`, '')
    if (a.verification.issues.length) out.push(...renderVerification(a.verification), '')
    out.push(
      'What the run did establish is in the step output. No verdict is stated here, because the',
      'check that would license one refused.',
      '',
    )
    out.push(...renderProvenance(a.provenance))
    out.push(CAVEAT)
    return out.join('\n')
  }

  out.push(`ASSESSMENT — ${where}`, '')

  if (a.status === 'no-verdict') {
    out.push('No syndrome verdict: this run answered no clinical question this ending can state.', '')
  }

  for (const syndrome of a.syndromes) {
    out.push(syndrome.headline.text)
    for (const line of syndrome.lines) out.push(renderLine(line))
  }
  if (a.syndromes.length) out.push('')

  if (a.other.length) {
    for (const line of a.other) out.push(line.text)
    out.push('')
  }

  out.push(...renderVerification(a.verification), '')

  if (a.notAssessed.length) {
    out.push(`Not assessed: ${a.notAssessed.map((line) => line.text).join(', ')}`, '')
  }

  out.push(...renderProvenance(a.provenance))
  out.push(CAVEAT)
  return out.join('\n')
}

/** Every line the render is built from, for the closure gate in `eval.ts`. */
export const claimLines = (a: Assessment): ClaimLine[] => [
  ...a.syndromes.flatMap((syndrome) => [syndrome.headline, ...syndrome.lines]),
  ...a.other,
  ...a.notAssessed,
]
