import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { loadPack } from '../src/core/pack.ts'
import { nullTrace } from '../src/core/trace.ts'
import { PROFILE } from '../src/profiles/clinical-verifier/profile.ts'

const pack = loadPack(join(import.meta.dirname, '..', 'packs', 'clinical'))
const document = pack.document('sh-02-cardiogenic-classic')

const extraction = (category = 'cardiogenic') => ({
  routes: ['shock-extraction', 'shock'],
  results: {
    'shock-extraction': {
      ok: true,
      output: {
        exam: {
          hypotension: { systolic: 68, diastolic: 50, duration_minutes: 200 },
          heart_rate: 115,
          skin_temperature: 'cool',
          jugular_venous_pressure: 'elevated',
          capillary_refill: 'brisk',
          pulse_volume: 'thready',
          lung_exam: 'bilateral_crackles',
        },
        confirmation: { confirmed: true, systolic: 68, shockIndex: 115 / 68 },
      },
    },
    shock: {
      ok: true,
      output: {
        skin_temperature: 'cool',
        jugular_venous_pressure: 'elevated',
        shock_category: category,
        supporting_findings: ['lung_exam'],
        discordant_findings: ['capillary_refill'],
        indeterminate_reason: null,
        assessment_confidence: 0.95,
        notes: null,
      },
    },
  },
})

const review = (value: unknown) => PROFILE.review!({
  pack,
  trace: nullTrace(),
  input: { kind: 'text', text: JSON.stringify({ document, extraction: value }) },
  options: {},
})

test('clinical verifier checks derivations and emits source observations only', async () => {
  const result = await review(extraction())
  assert.equal(result.ok, true)
  assert.deepEqual(result.report, {
    document,
    extraction: {
      'shock-extraction': {
        exam: extraction().results['shock-extraction'].output.exam,
      },
    },
  })
  assert.doesNotMatch(JSON.stringify(result.report), /shockIndex|shock_category|discordant_findings/)
})

test('clinical verifier rejects a classification that disagrees with the deterministic rule', async () => {
  const result = await review(extraction('septic'))
  assert.equal(result.ok, false)
  assert.match(result.text, /shock_category: expected cardiogenic/)
})

test('clinical verifier rejects a wrong deterministic confirmation', async () => {
  const value = extraction()
  value.results['shock-extraction'].output.confirmation.shockIndex = 0.5
  const result = await review(value)
  assert.equal(result.ok, false)
  assert.match(result.text, /does not match deterministic confirmation/)
})
