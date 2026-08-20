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

const parseJson = (raw: string): Record<string, unknown> => {
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
    throw new Error(`vital-signs extraction is not valid JSON: ${(e as Error).message} — got ${raw.slice(0, 120)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`vital-signs extraction must be a JSON object, got ${JSON.stringify(parsed)?.slice(0, 120)}`)
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
