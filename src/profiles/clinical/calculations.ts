/**
 * Derived calculations from extracted vital signs.
 *
 * Modelled after the medprotocol-core calculation utilities, but adapted for the
 * medextract data shapes: a `VitalSigns` record with optional `Reading` values,
 * where a `Reading` is either a `Measurement` (value + unit) or `BloodPressure`.
 *
 * Every calculator here is defensive: a missing field, a missing value, or an
 * unrecognised unit is treated as "not calculable" rather than throwing, because the
 * caller is a rendering pipeline that should report what it can and skip what it cannot.
 */

import { isBloodPressure, type BloodPressure, type Measurement, type Reading, type VitalSigns } from './extraction.ts'

// --- Types -------------------------------------------------------------------------------

export interface CalculatedValue<T = string> {
  value: T
  category?: string
  classification?: string
  severity?: string
  status?: string
  unit?: string
}

export interface CalculatedReadings {
  bmi?: CalculatedValue<number>
  paFi?: CalculatedValue<number>
  bloodPressureCategory?: CalculatedValue<string>
  heartRateCategory?: CalculatedValue<string>
  temperatureStatus?: CalculatedValue<string>
  respiratoryRateCategory?: CalculatedValue<string>
}

// --- Field helpers -----------------------------------------------------------------------

const asNumber = (r: Reading | undefined): number | null => {
  if (r === null || r === undefined) return null
  if (isBloodPressure(r)) return null
  const m = r as Measurement
  if (typeof m.value !== 'number') return null
  return m.value
}

const asMeasurement = (r: Reading | undefined): Measurement | null => {
  if (r === null || r === undefined || isBloodPressure(r)) return null
  return r as Measurement
}

const asBloodPressure = (r: Reading | undefined): BloodPressure | null => {
  if (r === null || r === undefined || !isBloodPressure(r)) return null
  return r
}

/**
 * Normalise a unit string to a canonical form for comparison.
 *
 * Lower-case, trim whitespace, drop the degree symbol, and accept common synonyms:
 * "kg", "kgs", "kilogram", "kilograms" all become "kg"; "cm" and "centimeter" become "cm";
 * "m", "meter", "meters" become "m"; "°c", "celsius", "c" become "c";
 * "°f", "fahrenheit", "f" become "f".
 */
const normUnit = (u?: string): string | undefined => {
  if (!u) return undefined
  const s = u.toLowerCase().trim().replace(/°/g, '').replace(/\s+/g, ' ')
  if (s === 'kgs' || s === 'kilogram' || s === 'kilograms') return 'kg'
  if (s === 'centimeter' || s === 'centimeters') return 'cm'
  if (s === 'meter' || s === 'meters') return 'm'
  if (s === 'celsius' || s === 'c') return 'c'
  if (s === 'fahrenheit' || s === 'f') return 'f'
  if (s === 'lbs' || s === 'lb' || s === 'pounds' || s === 'pound') return 'lb'
  if (s === 'feet' || s === 'foot' || s === 'ft') return 'ft'
  if (s === 'inches' || s === 'inch' || s === 'in') return 'in'
  if (s === 'mmhg' || s === 'mm hg') return 'mmhg'
  if (s === 'bpm' || s === 'beats per minute' || s === 'beats/min') return 'bpm'
  if (s === 'breaths per minute' || s === 'breaths/min' || s === 'rpm') return 'breaths/min'
  if (s === 'mmol/l' || s === 'mmol/l') return 'mmol/l'
  if (s === 'mg/dl' || s === 'mg/dl') return 'mg/dl'
  return s
}

const unitIs = (u: string | undefined, ...candidates: string[]): boolean => {
  const n = normUnit(u)
  return n !== undefined && candidates.includes(n)
}

// --- BMI ---------------------------------------------------------------------------------

const MAX_WEIGHT_KG = 700
const MAX_WEIGHT_LB = 1500
const MAX_HEIGHT_M = 2.75
const MAX_HEIGHT_CM = 275
const MAX_HEIGHT_FT = 9
const MAX_HEIGHT_IN = 108

const lbToKg = (lb: number): number => lb * 0.453592
const ftInToM = (ft: number, inch: number): number => (ft * 12 + inch) * 0.0254
const cmToM = (cm: number): number => cm / 100

const calculateBMI = (weightKg: number, heightM: number): number | null => {
  if (weightKg <= 0 || weightKg > MAX_WEIGHT_KG) return null
  if (heightM <= 0 || heightM > MAX_HEIGHT_M) return null
  return parseFloat((weightKg / (heightM * heightM)).toFixed(1))
}

const bmiCategory = (bmi: number): string => {
  if (bmi < 18.5) return 'Underweight'
  if (bmi < 25) return 'Normal'
  if (bmi < 30) return 'Overweight'
  return 'Obese'
}

export const calcBMI = (vitals: VitalSigns): CalculatedValue<number> | undefined => {
  const w = asMeasurement(vitals['weight'])
  const h = asMeasurement(vitals['height']) ?? asMeasurement(vitals['height_cm']) ?? asMeasurement(vitals['height_ft'])

  if (!w || typeof w.value !== 'number') return undefined

  let weightKg: number | null = null
  const uW = normUnit(w.unit)
  if (uW === 'kg') weightKg = w.value
  else if (uW === 'lb' || uW === 'lbs') weightKg = lbToKg(w.value)
  else if (!w.unit) weightKg = w.value // assume kg when unit is absent

  if (weightKg === null || weightKg <= 0) return undefined

  let heightM: number | null = null
  // Single height field: try to infer from unit
  const hSingle = asMeasurement(vitals['height'])
  if (hSingle && typeof hSingle.value === 'number') {
    const uH = normUnit(hSingle.unit)
    if (uH === 'm') heightM = hSingle.value
    else if (uH === 'cm') heightM = cmToM(hSingle.value)
    else if (uH === 'ft') heightM = ftInToM(hSingle.value, 0)
    else if (uH === 'in') heightM = ftInToM(0, hSingle.value)
    else if (!hSingle.unit) heightM = hSingle.value // assume m when unit is absent
  }

  // Separate cm field
  const hCm = asMeasurement(vitals['height_cm'])
  if (heightM === null && hCm && typeof hCm.value === 'number') {
    heightM = cmToM(hCm.value)
  }

  // Separate ft + in fields
  const hFt = asMeasurement(vitals['height_ft'])
  const hIn = asMeasurement(vitals['height_in'])
  if (heightM === null && hFt && typeof hFt.value === 'number') {
    const inches = hIn && typeof hIn.value === 'number' ? hIn.value : 0
    heightM = ftInToM(hFt.value, inches)
  }

  if (heightM === null || heightM <= 0) return undefined

  const bmi = calculateBMI(weightKg, heightM)
  if (bmi === null) return undefined
  return { value: bmi, category: bmiCategory(bmi) }
}

// --- PaO2 / FiO2 ratio -------------------------------------------------------------------

export const calcPaFi = (vitals: VitalSigns): CalculatedValue<number> | undefined => {
  const pao2 = asMeasurement(vitals['pao2'])
  const fio2 = asMeasurement(vitals['fio2'])

  if (!pao2 || typeof pao2.value !== 'number' || pao2.value <= 0) return undefined
  if (!fio2 || typeof fio2.value !== 'number') return undefined

  // Accept FiO2 as fraction (0.21–1.0) or percentage (21–100)
  let fiO2Num = fio2.value
  if (fiO2Num > 1 && fiO2Num <= 100) fiO2Num = fiO2Num / 100
  if (fiO2Num < 0.21 || fiO2Num > 1) return undefined

  const ratio = pao2.value / fiO2Num
  const rounded = Math.round(ratio)

  let classification = 'Normal'
  let severity = 'normal'
  if (rounded < 100) {
    classification = 'Severe ARDS'
    severity = 'severe'
  } else if (rounded < 200) {
    classification = 'Moderate ARDS'
    severity = 'moderate'
  } else if (rounded < 300) {
    classification = 'Mild ARDS'
    severity = 'mild'
  }

  return { value: rounded, classification, severity, unit: 'mmHg' }
}

// --- Blood pressure categories -----------------------------------------------------------

const bpCategory = (systolic: number, diastolic: number): string => {
  if (systolic >= 130 || diastolic >= 90) return 'High'
  if (systolic < 90 || diastolic < 60) return 'Low'
  return 'Normal'
}

export const calcBPCategory = (vitals: VitalSigns): CalculatedValue<string> | undefined => {
  const bp = asBloodPressure(vitals['blood_pressure'])
  if (!bp || typeof bp.systolic !== 'number' || typeof bp.diastolic !== 'number') return undefined
  return { value: bpCategory(bp.systolic, bp.diastolic) }
}

// --- Heart rate categories ---------------------------------------------------------------

const hrCategory = (hr: number): string => {
  if (hr > 100) return 'Elevated'
  if (hr < 60) return 'Low'
  return 'Normal'
}

export const calcHeartRateCategory = (vitals: VitalSigns): CalculatedValue<string> | undefined => {
  const hr = asMeasurement(vitals['heart_rate'])
  if (!hr || typeof hr.value !== 'number') return undefined
  return { value: hrCategory(hr.value) }
}

// --- Respiratory rate categories ---------------------------------------------------------

const rrCategory = (rr: number): string => {
  if (rr > 20) return 'Elevated'
  if (rr < 12) return 'Low'
  return 'Normal'
}

export const calcRespiratoryRateCategory = (vitals: VitalSigns): CalculatedValue<string> | undefined => {
  const rr = asMeasurement(vitals['respiratory_rate'])
  if (!rr || typeof rr.value !== 'number') return undefined
  return { value: rrCategory(rr.value) }
}

// --- Temperature status ------------------------------------------------------------------

const celsius = (value: number, unit?: string): number | null => {
  const u = normUnit(unit)
  if (u === 'c') return value
  if (u === 'f') return (value - 32) * 5 / 9
  if (!u) return value // assume Celsius when unit is absent
  return null
}

const tempStatus = (c: number): string => {
  if (c >= 38.0) return 'Fever'
  if (c < 36.0) return 'Hypothermia'
  return 'Normal'
}

export const calcTemperatureStatus = (vitals: VitalSigns): CalculatedValue<string> | undefined => {
  const t = asMeasurement(vitals['temperature'])
  if (!t || typeof t.value !== 'number') return undefined
  const c = celsius(t.value, t.unit)
  if (c === null) return undefined
  return { value: tempStatus(c), unit: '°C' }
}

// --- Aggregate ---------------------------------------------------------------------------

export const calculateDerived = (vitals: VitalSigns): CalculatedReadings => ({
  bmi: calcBMI(vitals),
  paFi: calcPaFi(vitals),
  bloodPressureCategory: calcBPCategory(vitals),
  heartRateCategory: calcHeartRateCategory(vitals),
  temperatureStatus: calcTemperatureStatus(vitals),
  respiratoryRateCategory: calcRespiratoryRateCategory(vitals),
})

// --- Rendering ---------------------------------------------------------------------------

export const renderDerived = (derived: CalculatedReadings): string[] => {
  const lines: string[] = []
  const push = (label: string, c: CalculatedValue<unknown> | undefined): void => {
    if (!c) return
    let text = `${label}: ${c.value}`
    if (c.category) text += ` (${c.category})`
    if (c.severity && c.severity !== c.category) text += ` [${c.severity}]`
    if (c.status) text += ` — ${c.status}`
    if (c.unit) text += ` ${c.unit}`
    lines.push(text)
  }
  push('BMI', derived.bmi)
  push('PaO2/FiO2', derived.paFi)
  push('Blood Pressure', derived.bloodPressureCategory)
  push('Heart Rate', derived.heartRateCategory)
  push('Respiratory Rate', derived.respiratoryRateCategory)
  push('Temperature', derived.temperatureStatus)
  return lines
}
