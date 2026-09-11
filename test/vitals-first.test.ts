/**
 * The front door: detect vitals, measure them through the CLI, route on the numbers.
 *
 * No model calls. The extraction the front door performs in a real run is graded by the
 * vital-signs eval against its own corpus; what is under test here is everything around it —
 * which documents buy the pass, what the CLI is asked, and whether the router reads what comes
 * back. `MEDPROTOCOL_BIN` points at the same fixture the shock and sepsis tests use.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

process.env.MEDPROTOCOL_BIN = join(import.meta.dirname, 'fixtures', 'medprotocol.js')

const { hasVitalSigns, vitalsDetected, measureVitals, seedWithMeasured, routeThresholds } = await import(
  '../src/profiles/clinical/vitals-first.ts'
)
const { routeClinicalShape, skipsFrontDoor } = await import('../src/profiles/clinical/clinical-router.ts')
const { loadPack, resolvePackRoot } = await import('../src/core/pack.ts')

const pack = loadPack(resolvePackRoot('clinical', { configured: 'packs/clinical', base: process.cwd() }))
const RULE = { command: [process.env.MEDPROTOCOL_BIN!], version: '0.7.10' }
const THRESHOLDS = routeThresholds(pack)

// --- Detection --------------------------------------------------------------------------------

test('one written vital sign is enough to open the front door', () => {
  // The bar is deliberately lower than the router's `vitals-note` rule, which needs two
  // abbreviations to call a document a vitals note. A septic-shock note is not a vitals note and
  // is full of vitals.
  assert.ok(hasVitalSigns('BP 76/44, peripheries cool.'))
  assert.ok(hasVitalSigns('Hypotensive at 88/54 mmHg for 45 minutes.'))
  assert.ok(hasVitalSigns('Heart rate 128 and rising.'))
  assert.ok(hasVitalSigns('Pulse 122, looks unwell.'))
  assert.ok(hasVitalSigns('Respiratory rate 26 on arrival.'))
  assert.ok(hasVitalSigns('SpO2 91% on room air.'))
  assert.ok(hasVitalSigns('Weight 71 kg today.'))
})

test('prose with no reading in it never buys a pass', () => {
  assert.equal(hasVitalSigns('Patient admitted for an elective hernia repair, discharged the same day.'), false)
  assert.equal(hasVitalSigns('The patient has a BP cuff but no reading was taken.'), false)
  assert.equal(hasVitalSigns('Reviewed in clinic, ongoing confusion attributed to dementia.'), false)
})

test('the detector names what it saw, so a trace can show the decision', () => {
  assert.deepEqual(vitalsDetected('BP 88/54, HR 118, RR 24'), ['blood_pressure', 'heart_rate', 'respiratory_rate'])
})

test('structured payloads and transcripts skip the front door', () => {
  // An exam or a qSOFA payload already IS the numbers; a dialogue or a dictation is a modality
  // that wins the route outright, so the pass would be bought and then not used.
  assert.ok(skipsFrontDoor(JSON.stringify({ hypotension: true, heart_rate: 118, capillary_refill: 'delayed' })))
  assert.ok(skipsFrontDoor(JSON.stringify({ respiratory_rate: 24, systolic_bp: 88, gcs: 12 })))
  assert.ok(skipsFrontDoor('Doctor: How are you?\nPatient: BP was 88 over 54.'))
  assert.ok(skipsFrontDoor('Dictation: blood pressure 88 over 54, heart rate 118.'))
  assert.ok(skipsFrontDoor('notes/a.note.txt\nnotes/b.note.txt'))
  assert.equal(skipsFrontDoor('BP 88/54, HR 118, peripheries cool.'), false)
})

// --- Measurement ------------------------------------------------------------------------------

const reading = (over: Record<string, unknown> = {}) => ({
  blood_pressure: { systolic: 76, diastolic: 44, unit: 'mmHg' },
  heart_rate: { value: 128, unit: 'bpm' },
  respiratory_rate: { value: 26, unit: 'breaths/min' },
  temperature: null,
  ...over,
})

test('the CLI is asked once and its parse wins', () => {
  const m = measureVitals(reading() as any, RULE)
  assert.equal(m.cliRan, true)
  assert.equal(m.systolic, 76)
  assert.equal(m.diastolic, 44)
  assert.equal(m.bloodPressureCategory, 'Low')
  assert.equal(m.heartRateCategory, 'Elevated')
  assert.equal(m.meanArterialPressure, 54.7)
  assert.ok(Math.abs(m.shockIndex! - 128 / 76) < 1e-9, 'shock index is HR/SBP, unrounded')
  // Readings the CLI is not asked about still travel, because the router counts them.
  assert.equal(m.respiratoryRate, 26)
})

test('a blood pressure with no heart rate is not sent — the CLI refuses that call', () => {
  const m = measureVitals(reading({ heart_rate: null }) as any, RULE)
  assert.equal(m.cliRan, false)
  assert.match(m.cliSkipped!, /heart rate/)
  // The reading it did get is reported; an absent number is absent, never zero.
  assert.equal(m.systolic, 76)
  assert.equal(m.shockIndex, undefined)
  assert.equal(m.heartRateCategory, undefined)
})

test('a Fahrenheit temperature is converted, a Celsius one is left alone', () => {
  assert.equal(measureVitals(reading({ temperature: { value: 101.3, unit: 'F' } }) as any, RULE).temperatureC, 38.5)
  assert.equal(measureVitals(reading({ temperature: { value: 38.5, unit: 'C' } }) as any, RULE).temperatureC, 38.5)
})

test('the thresholds come from the pack, not from the router', () => {
  assert.equal(THRESHOLDS.hypotensionSystolicBelow, (pack.manifest as any).clinical.shockExam.hypotensionSystolicBelow)
  assert.equal(THRESHOLDS.shockIndexAbove, (pack.manifest as any).clinical.shockExam.shockIndexAbove)
  assert.equal(THRESHOLDS.respiratoryRateAtLeast, (pack.manifest as any).clinical.sepsisScreen.respiratoryRateAtLeast)
  assert.equal(THRESHOLDS.systolicAtMost, (pack.manifest as any).clinical.sepsisScreen.systolicAtMost)
})

// --- Routing on the numbers ---------------------------------------------------------------------

const NUMERIC_SHOCK = 'BP 76/44, heart rate 128, delayed capillary refill.'

test('a note that states shock only in numbers reaches the shock arm', () => {
  // Words alone: one criterion, so no arm. This is the behaviour the front door was built to fix,
  // and it is asserted rather than assumed so the fix cannot quietly stop mattering.
  assert.deepEqual(routeClinicalShape(NUMERIC_SHOCK).tasks, ['vital-signs'])

  const measured = measureVitals(reading({ respiratory_rate: null }) as any, RULE)
  const routed = routeClinicalShape(NUMERIC_SHOCK, undefined, { measured, thresholds: THRESHOLDS })
  assert.deepEqual(routed.tasks, ['shock-extraction', 'shock'])
  assert.match(routed.reason, /systolic 76 < 90/)
  assert.match(routed.reason, /heart rate 128 \(Elevated\)/)
  // The index is not quoted: at a systolic of 76 it is the same finding arriving twice.
  assert.doesNotMatch(routed.reason, /shock index/)
})

test('a measured criterion and the word for it count once, not twice', () => {
  // `hypotensive` and a systolic of 76 are one finding stated twice. Counting both would clear a
  // bar of two criteria on a single blood pressure.
  const measured = measureVitals(
    { blood_pressure: { systolic: 76, diastolic: 44 }, heart_rate: { value: 70 } } as any,
    RULE,
  )
  assert.equal(measured.heartRateCategory, 'Normal')
  const routed = routeClinicalShape('Patient is hypotensive.', undefined, { measured, thresholds: THRESHOLDS })
  assert.notEqual(routed.shape, 'shock-suspicion')

  // And the shock index, which a systolic of 76 pushes to 0.92 on its own, is not the second
  // criterion either: it is a ratio of the same two readings.
  assert.ok(measured.shockIndex! > THRESHOLDS.shockIndexAbove)
})

test('ordinary observations meet no criterion at all', () => {
  const measured = measureVitals(
    {
      blood_pressure: { systolic: 118, diastolic: 72 },
      heart_rate: { value: 76 },
      respiratory_rate: { value: 14 },
    } as any,
    RULE,
  )
  const routed = routeClinicalShape('Post-op check, comfortable and mobilising.', undefined, {
    measured,
    thresholds: THRESHOLDS,
  })
  assert.deepEqual(routed.tasks, ['vital-signs'])
})

test('a measured respiratory rate meets the qSOFA criterion the words did not state', () => {
  const measured = measureVitals(
    { blood_pressure: { systolic: 124, diastolic: 78 }, heart_rate: { value: 84 }, respiratory_rate: { value: 26 } } as any,
    RULE,
  )
  const routed = routeClinicalShape('Chest infection, coughing up green sputum.', undefined, {
    measured,
    thresholds: THRESHOLDS,
  })
  assert.deepEqual(routed.tasks, ['sepsis-extraction', 'sepsis'])
  assert.match(routed.reason, /respiratory rate 26 >= 22/)
})

test('evidence the CLI could not produce changes nothing', () => {
  const measured = measureVitals({ blood_pressure: null, heart_rate: null } as any, RULE)
  assert.equal(measured.cliRan, false)
  const withEvidence = routeClinicalShape(NUMERIC_SHOCK, undefined, { measured, thresholds: THRESHOLDS })
  assert.deepEqual(withEvidence.tasks, routeClinicalShape(NUMERIC_SHOCK).tasks)
})

// --- Seeding ------------------------------------------------------------------------------------

test('the extraction arms are handed the numbers as facts, with the prose still under them', () => {
  const measured = measureVitals(reading() as any, RULE)
  const seeded = seedWithMeasured('Peripheries cool, JVP not seen.', measured)
  assert.match(seeded, /Peripheries cool, JVP not seen\./, 'the prose survives — the findings are in it')
  assert.match(seeded, /MEASURED VITAL SIGNS/)
  assert.match(seeded, /blood pressure: 76\/44 mmHg/)
  assert.match(seeded, /heart rate: 128 bpm/)
  assert.match(seeded, /respiratory rate: 26 breaths\/min/)
  assert.match(seeded, /do not re-read them/, 'the block says which source wins')
})

test('nothing to seed leaves the document untouched', () => {
  const measured = measureVitals({ blood_pressure: null, heart_rate: null } as any, RULE)
  assert.equal(seedWithMeasured('Peripheries cool.', measured), 'Peripheries cool.')
})
