/**
 * Unit tests for derived calculations from extracted vital signs.
 *
 * No model, no server, no pack — just the calculation functions against the data shapes
 * the extraction module produces.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type VitalSigns, type Measurement, type BloodPressure } from '../src/profiles/clinical/extraction.ts'
import {
  calcBMI,
  calcPaFi,
  calcBPCategory,
  calcHeartRateCategory,
  calcRespiratoryRateCategory,
  calcTemperatureStatus,
  calculateDerived,
  renderDerived,
} from '../src/profiles/clinical/calculations.ts'

const m = (value: number, unit?: string): Measurement => ({ value, unit, raw_text: 'test' })
const bp = (systolic: number, diastolic: number): BloodPressure => ({ systolic, diastolic, unit: 'mmHg', raw_text: 'test' })

test('BMI from metric height and weight', () => {
  const vitals: VitalSigns = { weight: m(70, 'kg'), height: m(1.75, 'm') }
  const result = calcBMI(vitals)
  assert.ok(result)
  assert.equal(result!.value, 22.9)
  assert.equal(result!.category, 'Normal')
})

test('BMI from imperial height and weight', () => {
  const vitals: VitalSigns = { weight: m(154, 'lb'), height_ft: m(5, 'ft'), height_in: m(9, 'in') }
  const result = calcBMI(vitals)
  assert.ok(result)
  assert.equal(result!.value, 22.7)
  assert.equal(result!.category, 'Normal')
})

test('BMI from height in cm', () => {
  const vitals: VitalSigns = { weight: m(70, 'kg'), height_cm: m(175, 'cm') }
  const result = calcBMI(vitals)
  assert.ok(result)
  assert.equal(result!.value, 22.9)
})

test('BMI absent when weight is missing', () => {
  const vitals: VitalSigns = { height: m(1.75, 'm') }
  assert.equal(calcBMI(vitals), undefined)
})

test('BMI absent when height is missing', () => {
  const vitals: VitalSigns = { weight: m(70, 'kg') }
  assert.equal(calcBMI(vitals), undefined)
})

test('BMI underweight category', () => {
  const vitals: VitalSigns = { weight: m(50, 'kg'), height: m(1.75, 'm') }
  const result = calcBMI(vitals)
  assert.equal(result!.category, 'Underweight')
})

test('BMI obese category', () => {
  const vitals: VitalSigns = { weight: m(100, 'kg'), height: m(1.75, 'm') }
  const result = calcBMI(vitals)
  assert.equal(result!.category, 'Obese')
})

test('PaO2/FiO2 ratio with normal values', () => {
  const vitals: VitalSigns = { pao2: m(80, 'mmHg'), fio2: m(40, '%') }
  const result = calcPaFi(vitals)
  assert.ok(result)
  assert.equal(result!.value, 200)
  assert.equal(result!.classification, 'Mild ARDS')
  assert.equal(result!.severity, 'mild')
})

test('PaO2/FiO2 ratio with fraction FiO2', () => {
  const vitals: VitalSigns = { pao2: m(80, 'mmHg'), fio2: m(0.4) }
  const result = calcPaFi(vitals)
  assert.ok(result)
  assert.equal(result!.value, 200)
})

test('PaO2/FiO2 ratio with severe ARDS', () => {
  const vitals: VitalSigns = { pao2: m(60, 'mmHg'), fio2: m(80, '%') }
  const result = calcPaFi(vitals)
  assert.equal(result!.value, 75)
  assert.equal(result!.classification, 'Severe ARDS')
  assert.equal(result!.severity, 'severe')
})

test('PaO2/FiO2 absent when pao2 is missing', () => {
  const vitals: VitalSigns = { fio2: m(40, '%') }
  assert.equal(calcPaFi(vitals), undefined)
})

test('PaO2/FiO2 absent for invalid FiO2', () => {
  const vitals: VitalSigns = { pao2: m(80, 'mmHg'), fio2: m(110, '%') }
  assert.equal(calcPaFi(vitals), undefined)
})

test('blood pressure category — high', () => {
  const vitals: VitalSigns = { blood_pressure: bp(140, 90) }
  const result = calcBPCategory(vitals)
  assert.equal(result!.value, 'High')
})

test('blood pressure category — low', () => {
  const vitals: VitalSigns = { blood_pressure: bp(85, 55) }
  const result = calcBPCategory(vitals)
  assert.equal(result!.value, 'Low')
})

test('blood pressure category — normal', () => {
  const vitals: VitalSigns = { blood_pressure: bp(120, 80) }
  const result = calcBPCategory(vitals)
  assert.equal(result!.value, 'Normal')
})

test('blood pressure category absent when field is missing', () => {
  const vitals: VitalSigns = {}
  assert.equal(calcBPCategory(vitals), undefined)
})

test('heart rate category — elevated', () => {
  const vitals: VitalSigns = { heart_rate: m(110, 'bpm') }
  const result = calcHeartRateCategory(vitals)
  assert.equal(result!.value, 'Elevated')
})

test('heart rate category — low', () => {
  const vitals: VitalSigns = { heart_rate: m(55, 'bpm') }
  const result = calcHeartRateCategory(vitals)
  assert.equal(result!.value, 'Low')
})

test('heart rate category — normal', () => {
  const vitals: VitalSigns = { heart_rate: m(72, 'bpm') }
  const result = calcHeartRateCategory(vitals)
  assert.equal(result!.value, 'Normal')
})

test('respiratory rate category — elevated', () => {
  const vitals: VitalSigns = { respiratory_rate: m(24, 'breaths/min') }
  const result = calcRespiratoryRateCategory(vitals)
  assert.equal(result!.value, 'Elevated')
})

test('respiratory rate category — low', () => {
  const vitals: VitalSigns = { respiratory_rate: m(10, 'breaths/min') }
  const result = calcRespiratoryRateCategory(vitals)
  assert.equal(result!.value, 'Low')
})

test('respiratory rate category — normal', () => {
  const vitals: VitalSigns = { respiratory_rate: m(16, 'breaths/min') }
  const result = calcRespiratoryRateCategory(vitals)
  assert.equal(result!.value, 'Normal')
})

test('temperature status — fever in Celsius', () => {
  const vitals: VitalSigns = { temperature: m(38.5, '°C') }
  const result = calcTemperatureStatus(vitals)
  assert.equal(result!.value, 'Fever')
})

test('temperature status — fever in Fahrenheit', () => {
  const vitals: VitalSigns = { temperature: m(101.3, '°F') }
  const result = calcTemperatureStatus(vitals)
  assert.equal(result!.value, 'Fever')
})

test('temperature status — hypothermia', () => {
  const vitals: VitalSigns = { temperature: m(35.0, '°C') }
  const result = calcTemperatureStatus(vitals)
  assert.equal(result!.value, 'Hypothermia')
})

test('temperature status — normal', () => {
  const vitals: VitalSigns = { temperature: m(37.0, '°C') }
  const result = calcTemperatureStatus(vitals)
  assert.equal(result!.value, 'Normal')
})

test('temperature status — absent when unit is unrecognised', () => {
  const vitals: VitalSigns = { temperature: m(37.0, 'kelvin') }
  assert.equal(calcTemperatureStatus(vitals), undefined)
})

test('calculateDerived returns all available calculations', () => {
  const vitals: VitalSigns = {
    weight: m(70, 'kg'),
    height: m(1.75, 'm'),
    pao2: m(80, 'mmHg'),
    fio2: m(40, '%'),
    blood_pressure: bp(120, 80),
    heart_rate: m(72, 'bpm'),
    respiratory_rate: m(16, 'breaths/min'),
    temperature: m(37.0, '°C'),
  }
  const derived = calculateDerived(vitals)
  assert.equal(derived.bmi!.value, 22.9)
  assert.equal(derived.paFi!.value, 200)
  assert.equal(derived.bloodPressureCategory!.value, 'Normal')
  assert.equal(derived.heartRateCategory!.value, 'Normal')
  assert.equal(derived.respiratoryRateCategory!.value, 'Normal')
  assert.equal(derived.temperatureStatus!.value, 'Normal')
})

test('calculateDerived skips missing fields', () => {
  const vitals: VitalSigns = { weight: m(70, 'kg') }
  const derived = calculateDerived(vitals)
  assert.equal(derived.bmi, undefined)
  assert.equal(derived.paFi, undefined)
  assert.equal(derived.bloodPressureCategory, undefined)
})

test('renderDerived produces readable lines', () => {
  const vitals: VitalSigns = {
    weight: m(70, 'kg'),
    height: m(1.75, 'm'),
    blood_pressure: bp(140, 90),
    heart_rate: m(72, 'bpm'),
    temperature: m(37.0, '°C'),
  }
  const lines = renderDerived(calculateDerived(vitals))
  assert.ok(lines.some((l) => l.includes('BMI: 22.9')))
  assert.ok(lines.some((l) => l.includes('Blood Pressure: High')))
  assert.ok(lines.some((l) => l.includes('Heart Rate: Normal')))
  assert.ok(lines.some((l) => l.includes('Temperature: Normal')))
  // PaFi and respiratory rate are absent, so they should not appear
  assert.ok(!lines.some((l) => l.includes('PaO2/FiO2')))
  assert.ok(!lines.some((l) => l.includes('Respiratory Rate')))
})
