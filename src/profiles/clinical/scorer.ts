/**
 * Scoring a vital-signs run.
 *
 * The asymmetry is the whole design: **detection is the only gated number**, because a
 * missed vital is invisible to the clinician while a spurious one is visible and rejected
 * in a click. Everything else is measured, printed, and never gates.
 *
 * Three things are reported SEPARATELY that a tidier scorer would merge:
 *
 * - **Value and unit.** A right number with a wrong unit is a different bug from a wrong
 *   number, and lumping them hides which one a prompt change fixed. On a sibling corpus a
 *   unit fix moved the score from 40 to 43 while values were already at 43; one combined
 *   column would have shown a single ambiguous jump.
 * - **Provenance.** The prompt's central rule is evidence-or-null, so `raw_text` is checked
 *   against the note it claims to come from. No JSON Schema keyword says "substring of the
 *   prompt" and GBNF has no back-reference to the context, so the schema can guarantee the
 *   shape of the quote and the truth of it not at all. This is the only check that catches
 *   a right-looking number attached to a fabricated citation.
 * - **Failed runs.** Scored as total misses, never skipped, so a model that fails outright
 *   cannot look merely quiet.
 */
import type { VitalCase, VitalExpectation } from './contracts.ts'
import { isBloodPressure, type Reading, type VitalSigns } from './extraction.ts'

/**
 * A zero denominator scores 1.0. Not a rounding detail: it decides whether an eval that
 * graded nothing PASSES its floor rather than failing it. It is correct here because the
 * corpus deliberately contains a case with nothing to extract, and "found none of the zero
 * things there were to find" is not a failure.
 */
export const ratio = (num: number, den: number) => (den === 0 ? 1.0 : num / den)

export const pct = (num: number, den: number): string =>
  den === 0 ? 'n/a'.padStart(13) : `${(ratio(num, den) * 100).toFixed(0).padStart(4)}% (${num}/${den})`.padEnd(13)

/**
 * Accent- and case-insensitive comparison.
 *
 * `ºC` vs `°C` is a transcription of the same unit rather than a unit error, and a note
 * written in Spanish will produce both spellings across a corpus. NFD then strip combining
 * marks, which also makes `mmHg` and `mmhg` the same answer.
 */
export const norm = (s: unknown): string =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .trim()

/** Collapse runs of whitespace, so a quote spanning a line break still matches its note. */
export const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

export interface VitalTally {
  /** Expectations of kind `value`/`bp`. The gated denominator. */
  gradedTotal: number
  detected: number
  /** Of those detected: the number was right. */
  valueExact: number
  /** Of those detected: the unit was right. Counted apart from `valueExact` on purpose. */
  unitExact: number
  /** Of those detected: `raw_text` is genuinely a fragment of the note. */
  quoteVerified: number
  /** A reading emitted where the corpus expects `absent` or `unresolved`. */
  hallucinations: number
  failedRuns: number
}

export const emptyTally = (): VitalTally => ({
  gradedTotal: 0,
  detected: 0,
  valueExact: 0,
  unitExact: 0,
  quoteVerified: 0,
  hallucinations: 0,
  failedRuns: 0,
})

export const absorb = (into: VitalTally, o: VitalTally): void => {
  into.gradedTotal += o.gradedTotal
  into.detected += o.detected
  into.valueExact += o.valueExact
  into.unitExact += o.unitExact
  into.quoteVerified += o.quoteVerified
  into.hallucinations += o.hallucinations
  into.failedRuns += o.failedRuns
}

export interface Miss {
  case: string
  field: string
  reason: 'missed' | 'value' | 'unit' | 'quote' | 'hallucination'
  detail: string
}

export interface CaseScore {
  tally: VitalTally
  misses: Miss[]
}

/** Score one case's extraction against its expectations. */
export const scoreCase = (c: VitalCase, got: VitalSigns, note: string): CaseScore => {
  const tally = emptyTally()
  const misses: Miss[] = []
  const haystack = norm(collapse(note))

  for (const e of c.fields) {
    const reading = got[e.field] ?? null

    if (e.expect.kind === 'absent' || e.expect.kind === 'unresolved') {
      if (reading !== null) {
        tally.hallucinations++
        misses.push({
          case: c.name,
          field: e.field,
          reason: 'hallucination',
          detail: `${e.expect.kind} in the note, model emitted ${describe(reading)}`,
        })
      }
      continue
    }

    tally.gradedTotal++
    if (reading === null) {
      misses.push({ case: c.name, field: e.field, reason: 'missed', detail: `expected ${describe(expected(e))}` })
      continue
    }
    tally.detected++

    if (valueMatches(e, reading)) tally.valueExact++
    else
      misses.push({
        case: c.name,
        field: e.field,
        reason: 'value',
        detail: `expected ${describe(expected(e))}, got ${describe(reading)}`,
      })

    const wantUnit = e.expect.unit
    if (norm(reading.unit) === norm(wantUnit)) tally.unitExact++
    else
      misses.push({
        case: c.name,
        field: e.field,
        reason: 'unit',
        detail: `expected unit '${wantUnit}', got '${reading.unit ?? '(none)'}'`,
      })

    // Literal containment after normalisation is the entire provenance check, and it is
    // deliberately not a regex: a pattern built from the model's own output has to escape
    // every '.', '(', '/' and '°' the quote contains, and one unescaped character turns a
    // failed verification into a passing one — the single failure mode a verifier must not
    // have.
    const quote = reading.raw_text
    if (quote && haystack.includes(norm(collapse(quote)))) tally.quoteVerified++
    else
      misses.push({
        case: c.name,
        field: e.field,
        reason: 'quote',
        detail: quote ? `raw_text is not in the note: '${quote}'` : 'no raw_text',
      })
  }

  return { tally, misses }
}

/** A whole case lost — the run failed, or its reply would not parse. Every slot is a miss. */
export const scoreFailure = (c: VitalCase): CaseScore => {
  const tally = emptyTally()
  tally.failedRuns = 1
  tally.gradedTotal = c.fields.filter((f) => f.expect.kind === 'value' || f.expect.kind === 'bp').length
  return { tally, misses: [{ case: c.name, field: '*', reason: 'missed', detail: 'run failed' }] }
}

const expected = (e: VitalExpectation): Reading =>
  e.expect.kind === 'bp'
    ? { systolic: e.expect.systolic, diastolic: e.expect.diastolic, unit: e.expect.unit }
    : e.expect.kind === 'value'
      ? { value: e.expect.value, unit: e.expect.unit }
      : null

const valueMatches = (e: VitalExpectation, got: NonNullable<Reading>): boolean => {
  if (e.expect.kind === 'bp') {
    // A half-right blood pressure is wrong. It is one reading with two numbers, and a
    // systolic paired with someone else's diastolic is not partially correct.
    return isBloodPressure(got) && got.systolic === e.expect.systolic && got.diastolic === e.expect.diastolic
  }
  if (e.expect.kind !== 'value' || isBloodPressure(got)) return false
  // Compare at the precision the corpus states. The notes carry at most one decimal, and
  // an exact float comparison would fail on a model that emits 36.400000000000006.
  return Math.abs(got.value - e.expect.value) < 0.005
}

const describe = (r: Reading): string =>
  r === null
    ? 'nothing'
    : isBloodPressure(r)
      ? `${r.systolic}/${r.diastolic} ${r.unit ?? ''}`.trim()
      : `${r.value} ${r.unit ?? ''}`.trim()
