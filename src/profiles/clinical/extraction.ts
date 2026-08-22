/**
 * Parsing a vital-signs reply.
 *
 * Deliberately stricter than the schema in one direction and more lenient in another, and
 * both choices are about keeping the eval's numbers readable rather than about robustness:
 *
 * - **A missing KEY and a null value mean the same thing** — the note said nothing about
 *   this sign — even though the schema requires every key. The schema requires it because
 *   an optional property gives the grammar a legal way to stop early, which is how a run
 *   comes back as `{}`. That is a decoding concern. For SCORING, one absent sign must not
 *   count as two different outcomes.
 * - **`{"value": null}` is a parse error, not an absence.** There must be exactly one way
 *   to say a sign is absent, or detection counts split across two spellings and recall
 *   stops meaning anything. The schema forbids it under constrained decoding; this keeps
 *   it out on the unconstrained arm, where the same run is measured without a grammar.
 *
 * The field list arrives from the schema (see contracts.ts) rather than being written
 * here, so this module names no vital sign at all.
 */
import type { GradedField } from './contracts.ts'

export interface Measurement {
  value: number
  unit?: string
  raw_text?: string
}

export interface BloodPressure {
  systolic: number
  diastolic: number
  unit?: string
  raw_text?: string
}

export type Reading = Measurement | BloodPressure | null

/** Field name -> what the model said about it. Every gradeable slot has an entry. */
export type VitalSigns = Record<string, Reading>

export const isBloodPressure = (r: Reading): r is BloodPressure =>
  r !== null && 'systolic' in r && 'diastolic' in r

export const parseVitalSigns = (raw: string, fields: GradedField[]): VitalSigns => {
  const obj = parseJson(raw)
  const out: VitalSigns = {}
  for (const field of fields) out[field.name] = readReading(obj[field.name], field)
  return out
}

/**
 * The JSON gate, shared by all three tasks.
 *
 * `label` names the task in the diagnosis and is the only thing that varies: a fence, a
 * truncation and a prose reply fail identically whatever contract was asked for, and three
 * copies of this function would drift in exactly the direction that makes two tasks' failure
 * counts incomparable.
 */
const parseJson = (raw: string, label = 'vital-signs'): Record<string, unknown> => {
  // A fenced reply is NOT quietly unwrapped, and the refusal is deliberate. The eval must
  // report what a caller actually receives: an application that does not strip fences gets
  // nothing from this reply, so scoring it as a success would measure a leniency the
  // product does not have. But a bare "not valid JSON" hides which failure this is —
  // measured on gemma-3-4b, every unconstrained reply was fenced and every one of them was
  // good JSON inside, so the run scored 0% for a reason that has nothing to do with whether
  // the model can read a note. Name it, and the fix (a grammar, or a pack whose
  // application strips fences and says so) is one line away instead of an afternoon.
  if (raw.trim().startsWith('```')) {
    throw new Error(
      'the reply is wrapped in a markdown code fence, so it is not JSON — the content inside may be ' +
        'perfectly good. Constrained decoding makes this impossible: a grammar cannot emit a backtick ' +
        'outside the JSON',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    // Quote a bounded prefix: a failed extraction is usually diagnosable from its first
    // line, and printing an 8k completion into a test report helps nobody.
    throw new Error(`${label} extraction is not valid JSON: ${(e as Error).message} — got ${raw.slice(0, 120)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} extraction must be a JSON object, got ${JSON.stringify(parsed)?.slice(0, 120)}`)
  }
  return parsed as Record<string, unknown>
}

const readReading = (v: unknown, field: GradedField): Reading => {
  if (v === null || v === undefined) return null
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`${field.name} was ${JSON.stringify(v)}, expected an object or null`)
  }
  const o = v as Record<string, unknown>

  if (field.shape === 'bloodPressure') {
    if (typeof o.systolic !== 'number' || typeof o.diastolic !== 'number') {
      throw new Error(`${field.name} needs numeric systolic and diastolic, got ${JSON.stringify(o)}`)
    }
    return { systolic: o.systolic, diastolic: o.diastolic, unit: str(o.unit), raw_text: str(o.raw_text) }
  }

  if (typeof o.value !== 'number') {
    throw new Error(`${field.name} needs a numeric value, got ${JSON.stringify(o)}`)
  }
  return { value: o.value, unit: str(o.unit), raw_text: str(o.raw_text) }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

// --- Patient summary ---------------------------------------------------------------------

/** Three sets, in schema order. Every field is an array; `[]` is the only way to say empty. */
export type PatientSummary = Record<string, string[]>

export const SUMMARY_FIELDS = ['history', 'usual_medication', 'pending'] as const

/**
 * Parse a summary reply.
 *
 * A missing key is an ERROR here, where a missing vital sign is an absence. The difference is
 * the contract: there, one absent sign has one spelling (`null`) and the key exists to force
 * the model past every slot; here the empty array IS the spelling, so a model that omitted
 * the key never said the list was empty — it said nothing, and scoring that as "correctly
 * found no medication" would hand a mark to a truncated reply.
 *
 * `null` is refused for the same reason: two spellings of empty split the counts.
 */
export const parsePatientSummary = (raw: string): PatientSummary => {
  const obj = parseJson(raw, 'patient-summary')
  const out: PatientSummary = {}
  for (const field of SUMMARY_FIELDS) {
    const v = obj[field]
    if (v === undefined) throw new Error(`patient-summary reply has no '${field}' — an empty list is written []`)
    if (v === null) throw new Error(`'${field}' was null; the one way to say a list is empty is []`)
    if (!Array.isArray(v)) throw new Error(`'${field}' must be an array of strings, got ${JSON.stringify(v).slice(0, 80)}`)
    // A non-string item is refused rather than stringified: `{"name": "metformin"}` coerced
    // to "[object Object]" would be scored as a wrong item instead of a broken contract.
    for (const item of v) {
      if (typeof item !== 'string') throw new Error(`'${field}' holds a non-string item: ${JSON.stringify(item).slice(0, 80)}`)
    }
    // Blank strings dropped: they are not items, and a list of three blanks would otherwise
    // read as three findings in every count that follows.
    out[field] = (v as string[]).map((s) => s.trim()).filter(Boolean)
  }
  return out
}

// --- Note formatting -----------------------------------------------------------------------

export interface FormatItem {
  quote: string
  text: string
}

export interface MedicationItem extends FormatItem {
  /** null when the note names the drug without a dose. Absent and null mean the same here. */
  dose: string | null
}

export interface NoteFormat {
  presenting_complaint: FormatItem | null
  history: FormatItem[]
  plan: FormatItem[]
  current_medication: MedicationItem[]
}

/** The list sections, in schema order — which is the order the grammar makes the model emit. */
export const FORMAT_LIST_FIELDS = ['history', 'plan', 'current_medication'] as const

/**
 * Parse a note-format reply.
 *
 * Every item must carry a non-empty `quote` and `text`. An item missing either is refused
 * rather than dropped: a section that silently lost its unquotable items would score better
 * for citing less, which inverts the incentive the whole task is built around.
 *
 * `presenting_complaint` is the one nullable field, because it is one item rather than a
 * list — and `{}` for it is an error, not an absence, for the same reason `{"value": null}`
 * is an error in a vital sign.
 */
export const parseNoteFormat = (raw: string): NoteFormat => {
  const obj = parseJson(raw, 'note-format')

  const item = (v: unknown, where: string): FormatItem => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      throw new Error(`${where} must be an object with a quote and a text, got ${JSON.stringify(v).slice(0, 80)}`)
    }
    const o = v as Record<string, unknown>
    const quote = str(o.quote)?.trim()
    const text = str(o.text)?.trim()
    if (!quote) throw new Error(`${where} has no quote — an item without its span cannot be verified`)
    if (!text) throw new Error(`${where} has no text`)
    return { quote, text }
  }

  const list = (field: string): unknown[] => {
    const v = obj[field]
    if (v === undefined) throw new Error(`note-format reply has no '${field}' — an empty section is written []`)
    if (v === null) throw new Error(`'${field}' was null; the one way to say a section is empty is []`)
    if (!Array.isArray(v)) throw new Error(`'${field}' must be an array, got ${JSON.stringify(v).slice(0, 80)}`)
    return v
  }

  const pc = obj.presenting_complaint
  if (pc === undefined) throw new Error(`note-format reply has no 'presenting_complaint' — say null when the note does not give one`)

  return {
    presenting_complaint: pc === null ? null : item(pc, 'presenting_complaint'),
    history: list('history').map((v, i) => item(v, `history[${i}]`)),
    plan: list('plan').map((v, i) => item(v, `plan[${i}]`)),
    current_medication: list('current_medication').map((v, i) => {
      const base = item(v, `current_medication[${i}]`)
      const dose = (v as Record<string, unknown>).dose
      if (dose !== null && dose !== undefined && typeof dose !== 'string') {
        throw new Error(`current_medication[${i}].dose must be a string or null, got ${JSON.stringify(dose).slice(0, 60)}`)
      }
      // An empty-string dose is normalised to null: it is the model saying there is none, in
      // the wrong spelling, and treating it as a dose would put an empty column in a chart.
      return { ...base, dose: str(dose)?.trim() || null }
    }),
  }
}
