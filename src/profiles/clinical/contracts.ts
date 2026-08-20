/**
 * The clinical profile's reading of its contract pack.
 *
 * Everything vital-signs-shaped lives here rather than in `src/core/`: the gradeable slot
 * list, the case format, the per-task sampling. Core hands this module a `Pack` and knows
 * nothing else about the domain.
 *
 * **The slot list is derived from the schema, not written down here.** That is the one
 * structural difference from how this task was first built, and it is deliberate. A
 * hardcoded list of nine field names is a second statement of something the schema already
 * says — in the one order that is load-bearing for the grammar — and two statements that
 * can disagree is how a denominator goes quietly wrong: the eval keeps reporting a
 * percentage, just of the wrong total. Deriving it also means a pack can add a tenth vital
 * sign by editing its schema and its cases, without touching this repository.
 *
 * What makes a property gradeable is its SHAPE, not its name: a slot is a reading if its
 * schema is `anyOf` with a `$ref` in it. `extraction_confidence` is a bare number and
 * `notes` is a nullable string, so both fall out as metadata without either being named.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { Pack } from '../../core/pack.ts'

/** How a reading is shaped. A blood pressure is one reading with two numbers, not two. */
export type FieldShape = 'measurement' | 'bloodPressure'

export interface GradedField {
  name: string
  shape: FieldShape
}

// --- [clinical] settings --------------------------------------------------------------

export interface ClinicalSettings {
  defaultTask: string
  vitalSignsSchemaName: string
}

export const loadSettings = (pack: Pack): ClinicalSettings => {
  // `[clinical]` is inert to core/pack.ts, which acts only on spec/name/files/documents/
  // include. Reading it here rather than adding a core concept keeps the harness free of
  // this domain's vocabulary, which is the arrangement's whole rule.
  const manifest = parseToml(readFileSync(join(pack.root, 'pack.toml'), 'utf8')) as { clinical?: ClinicalSettings }
  if (!manifest.clinical) throw new Error(`pack '${pack.name}' has no [clinical] table in its manifest`)
  return manifest.clinical
}

// --- models.default.toml --------------------------------------------------------------

export interface Sampling {
  temperature: number
  max_tokens: number
  timeout_secs: number
}

/**
 * Per-task sampling, from the same declaration a consuming application would seed from.
 *
 * Not defaulted: the harness's own cap is a backstop sized for an unbounded array, and a
 * pack whose application runs a smaller one must be measured at the cap it runs, or a
 * truncation that happens in production cannot happen in the eval. Reading it is the
 * difference between measuring the product and measuring something near it.
 */
export const loadSampling = (pack: Pack, task: string): Sampling => {
  const models = pack.toml<{ sampling?: Record<string, Partial<Sampling>> }>('models')
  const s = models.sampling?.[task]
  if (!s || typeof s.max_tokens !== 'number') {
    throw new Error(
      `pack '${pack.name}' declares no [sampling.${task}] with a max_tokens in its models file — ` +
        'the harness will not guess a cap the application does not run',
    )
  }
  return { temperature: s.temperature ?? 0, max_tokens: s.max_tokens, timeout_secs: s.timeout_secs ?? 300 }
}

// --- The schema, and the slots it defines ---------------------------------------------

interface SchemaShape {
  properties?: Record<string, { anyOf?: { $ref?: string }[] }>
}

export const vitalSchema = (pack: Pack): object => pack.json<object>('vitalSignsSchema')
export const vitalSchemaGolden = (pack: Pack): string => pack.read('vitalSignsSchemaGolden')
export const vitalPrompt = (pack: Pack): string => pack.read('vitalSignsPrompt')

/**
 * The gradeable slots, in SCHEMA order — which is the order the grammar makes the model
 * emit them, so it is also the order everything downstream should read them in.
 */
export const gradedFields = (pack: Pack): GradedField[] => {
  const schema = pack.json<SchemaShape>('vitalSignsSchema')
  const props = schema.properties
  if (!props) throw new Error(`pack '${pack.name}': the vital-signs schema declares no properties`)

  const fields: GradedField[] = []
  for (const [name, spec] of Object.entries(props)) {
    const ref = spec.anyOf?.find((a) => a.$ref)?.$ref
    if (!ref) continue // metadata: a bare number, or a nullable string
    fields.push({ name, shape: ref.endsWith('bloodPressure') ? 'bloodPressure' : 'measurement' })
  }
  if (!fields.length) {
    throw new Error(`pack '${pack.name}': no gradeable slots in the vital-signs schema — every property is metadata`)
  }
  return fields
}

// --- Cases ------------------------------------------------------------------------------

export type VitalExpect =
  | { kind: 'value'; value: number; unit: string }
  | { kind: 'bp'; systolic: number; diastolic: number; unit: string }
  | { kind: 'unresolved' }
  | { kind: 'absent' }

export interface VitalExpectation {
  field: string
  expect: VitalExpect
}

export interface VitalCase {
  name: string
  class: string
  note?: string
  fields: VitalExpectation[]
}

export interface VitalCases {
  fieldRecallFloor: number
  cases: VitalCase[]
}

/**
 * Load the cases, materialising the implicit `absent` expectations.
 *
 * The case file states the rule (`_implicitAbsent`): a gradeable field a case does not
 * list is expected absent. Expanding it here rather than at grading time is what makes
 * hallucination counting TOTAL rather than sampled — every slot is accounted for in every
 * case — and it is why the scorer never has to know the field list at all.
 *
 * An expectation naming a field the schema does not define is an error rather than a
 * skipped line. It means the two halves of the contract have drifted, and the run that
 * followed would report a percentage of a denominator nobody intended.
 */
export const loadVitalCases = (pack: Pack, fields: GradedField[]): VitalCases => {
  const raw = pack.json<VitalCases>('vitalSignsCases')
  const known = new Set(fields.map((f) => f.name))
  const cases = raw.cases.map((c) => {
    for (const e of c.fields) {
      if (!known.has(e.field)) {
        throw new Error(
          `case '${c.name}' expects field '${e.field}', which the schema does not define ` +
            `(gradeable slots: ${[...known].join(', ')})`,
        )
      }
    }
    const listed = new Set(c.fields.map((f) => f.field))
    const implicit = fields
      .filter((f) => !listed.has(f.name))
      .map((f): VitalExpectation => ({ field: f.name, expect: { kind: 'absent' } }))
    return { ...c, fields: [...c.fields, ...implicit] }
  })
  return { fieldRecallFloor: raw.fieldRecallFloor, cases }
}

/** The gated denominator: expectations the model must extract (`value` or `bp`). */
export const gradedExpectations = (cases: VitalCase[]): number =>
  cases.reduce((n, c) => n + c.fields.filter((f) => f.expect.kind === 'value' || f.expect.kind === 'bp').length, 0)
