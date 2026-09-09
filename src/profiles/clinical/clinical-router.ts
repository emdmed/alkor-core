/**
 * Clinical internal router: shape detection, routing rules, confidence scoring.
 *
 * The router classifies the *shape* of a clinical input and selects the right
 * contract workflow(s), with a confidence score and a fallback to the caller's explicit
 * `--task` override. It is fast and deterministic (rule-based, no model call),
 * and runs *before* any GPU pass so the wrong schema is never sent.
 *
 * Shapes are properties of the input bytes, not contract names. Most shapes map to one
 * task. A payload satisfying more than one definitive shape returns an ordered task plan;
 * for example, a combined shock/qSOFA payload runs shock before sepsis.
 */

import { type ClinicalShape, DEFAULT_TASK_FOR_SHAPE, TASKS, type Task } from './contracts.ts'

export interface ClinicalRouteRule {
  name: string
  shape: ClinicalShape
  detect: (input: string) => boolean
  confidence: number
}

export interface ClinicalRouteResult {
  /** First workflow in the ordered route plan, retained for single-route callers. */
  task: Task
  /** Every workflow that should run, in execution order. */
  tasks: Task[]
  shape: ClinicalShape
  confidence: number
  reason: string
}

// --- Shape detection ----------------------------------------------------------------------

const SHOCK_EXAM_KEYS = [
  'capillary_refill',
  'mental_status',
  'skin_appearance',
  'hypotension',
  'skin_temperature',
  'jugular_venous_pressure',
  'pulse_volume',
  'lung_exam',
  'heart_rate',
]

// A qSOFA payload is the three numbers a Quick SOFA screen reads: respiratory rate, systolic
// blood pressure, and GCS. `gcs` is the discriminator that keeps it apart from the shock exam
// payload — the shock payload never carries a GCS — so it is required, not merely present in
// the candidate list.
const QSOFA_KEYS = ['respiratory_rate', 'systolic_bp', 'gcs', 'qsofa']


const isSepsisJson = (input: string): boolean => {
  const tryParse = (text: string): Record<string, unknown> | null => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as Record<string, unknown>
  }

  const whole = tryParse(input)
  if (whole) return (whole as Record<string, unknown>).gcs !== undefined && QSOFA_KEYS.some((k) => k in whole)

  // Try parsing from the first '{' to handle mixed inputs.
  const brace = input.indexOf('{')
  const bracket = input.indexOf('[')
  const start = brace === -1 ? bracket : bracket === -1 ? brace : Math.min(brace, bracket)
  if (start === -1) return false

  let search = input
  while (true) {
    const closeBrace = search.lastIndexOf('}')
    const closeBracket = search.lastIndexOf(']')
    const end = Math.max(closeBrace, closeBracket)
    if (end <= start) break
    const sub = search.slice(start, end + 1)
    const parsed = tryParse(sub)
    if (parsed && (parsed as Record<string, unknown>).gcs !== undefined) return QSOFA_KEYS.some((k) => k in parsed)
    search = search.slice(0, end)
  }
  return false
}

const isExamJson = (input: string): boolean => {
  const tryParse = (text: string): Record<string, unknown> | null => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as Record<string, unknown>
  }

  // Try the whole string first.
  const whole = tryParse(input)
  if (whole) return SHOCK_EXAM_KEYS.some((k) => k in whole)

  // Try parsing from the first '{' or '[' to handle mixed inputs.
  const brace = input.indexOf('{')
  const bracket = input.indexOf('[')
  const start = brace === -1 ? bracket : bracket === -1 ? brace : Math.min(brace, bracket)
  if (start === -1) return false

  // Walk backwards from the end of the string, trying to find a valid JSON substring
  // that starts at the first brace or bracket. We skip to the nearest closing brace/bracket.
  let search = input
  while (true) {
    const closeBrace = search.lastIndexOf('}')
    const closeBracket = search.lastIndexOf(']')
    const end = Math.max(closeBrace, closeBracket)
    if (end <= start) break
    const sub = search.slice(start, end + 1)
    const parsed = tryParse(sub)
    if (parsed) return SHOCK_EXAM_KEYS.some((k) => k in parsed)
    search = search.slice(0, end)
  }
  return false
}

const isSummaryInput = (input: string): boolean => {
  // JSON array of strings/objects
  try {
    const parsed = JSON.parse(input)
    if (Array.isArray(parsed) && parsed.length > 0) return true
  } catch {
    // fall through to path-list check
  }
  // Newline-separated list of file paths
  const lines = input.trim().split('\n').filter((l) => l.trim().length > 0)
  if (lines.length >= 2) {
    // A file path looks like it contains a slash or ends with an extension
    return lines.every((l) => /[\/]/.test(l) || /\.[a-zA-Z0-9]+$/.test(l.trim()))
  }
  return false
}

const DIALOGUE_PATTERN = /^(Doctor|Dr|Patient|Pt|D|P):\s/mi

const isDialogue = (input: string): boolean => {
  // Named speaker labels
  if (DIALOGUE_PATTERN.test(input)) return true
  // Two or more speaker labels on separate lines (word followed by colon)
  const matches = input.match(/^\w+:\s.*$/gm)
  return matches !== null && matches.length >= 2
}

const DICTATION_MARKERS = ['Dictation:', 'Transcribed:', 'Audio:', 'Speech-to-text:', 'Audio recording:']

const isDictation = (input: string): boolean => {
  const trimmed = input.trim()
  return DICTATION_MARKERS.some((m) => trimmed.startsWith(m))
}

const VITALS_ABBREVIATIONS = ['BP', 'HR', 'Temp', 'SpO2', 'RR', 'O2', 'BMI', 'weight', 'height']

const isVitalsNote = (input: string): boolean => {
  if (isDialogue(input)) return false
  const found = new Set<string>()
  const text = input.toUpperCase()
  for (const abbr of VITALS_ABBREVIATIONS) {
    // Match as a whole word to avoid false positives (e.g., 'temp' inside 'temperature' is fine,
    // but 'o2' inside 'co2' is not). We use a simple regex boundary.
    const regex = new RegExp(`\\b${abbr.toUpperCase().replace(/\s/g, '\\s')}\\b`, 'i')
    if (regex.test(input)) found.add(abbr)
  }
  return found.size >= 2
}

const CLINICAL_TERMS = ['patient', 'admitted', 'treated', 'discharge', 'medication', 'diagnosis', 'prescription', 'symptom', 'disease', 'therapy']

const isClinicalNote = (input: string): boolean => {
  if (isDialogue(input)) return false
  const lower = input.toLowerCase()
  return CLINICAL_TERMS.some((t) => lower.includes(t))
}

// --- Shock suspicion detection -----------------------------------------------------------

const SHOCK_SUSPICION_GROUPS = [
  ['hypotension', 'hypotensive', 'low blood pressure', 'low bp', 'bp low'],
  ['tachycardia', 'tachycardic', 'elevated heart rate', 'fast heart rate', 'high heart rate', 'heart rate elevated', 'heart rate high'],
  ['hypoperfusion', 'peripheral hypoperfusion', 'poor perfusion', 'cool peripheries', 'cool extremities', 'warm peripheries', 'warm extremities', 'clammy skin', 'mottled skin', 'delayed capillary refill', 'cold extremities', 'cold peripheries', 'poor peripheral perfusion'],
  ['oliguria', 'oliguric', 'low urine output', 'decreased urine output', 'anuria', 'anuric', 'reduced urine output', 'urine output low'],
  ['encephalopathy', 'altered mental status', 'altered mental state', 'confusion', 'obtundation', 'decreased consciousness', 'altered consciousness', 'confused', 'drowsy', 'lethargic', 'unresponsive', 'reduced consciousness'],
]

const SHOCK_GENERAL_TERMS = ['shock', 'septic shock', 'cardiogenic shock', 'hypovolemic shock', 'distributive shock', 'obstructive shock', 'hemorrhagic shock', 'shock index']

const isShockSuspicion = (input: string): boolean => {
  if (isExamJson(input)) return false // structured JSON has its own route
  const lower = input.toLowerCase()

  let criteria = 0
  for (const group of SHOCK_SUSPICION_GROUPS) {
    if (group.some((k) => lower.includes(k))) criteria++
  }

  if (SHOCK_GENERAL_TERMS.some((k) => {
    if (k.includes(' ')) return lower.includes(k)
    return new RegExp(`\\b${k}\\b`, 'i').test(input)
  })) criteria++

  return criteria >= 2
}

// --- Rule set ------------------------------------------------------------------------------

export const DEFAULT_CLINICAL_RULES: ClinicalRouteRule[] = [
  {
    name: 'qsofa-json',
    shape: 'qsofa-json',
    detect: isSepsisJson,
    confidence: 1.0,
  },
  {
    name: 'exam-json',
    shape: 'exam-json',
    detect: isExamJson,
    confidence: 1.0,
  },
  {
    name: 'summary-input',
    shape: 'summary-input',
    detect: isSummaryInput,
    confidence: 1.0,
  },
  {
    name: 'dialogue',
    shape: 'dialogue',
    detect: isDialogue,
    confidence: 0.95,
  },
  {
    name: 'dictation',
    shape: 'dictation',
    detect: isDictation,
    confidence: 0.95,
  },
  {
    name: 'shock-suspicion',
    shape: 'shock-suspicion',
    detect: isShockSuspicion,
    confidence: 0.92,
  },
  {
    name: 'vitals-note',
    shape: 'vitals-note',
    detect: isVitalsNote,
    confidence: 0.9,
  },
  {
    name: 'note',
    shape: 'note',
    detect: isClinicalNote,
    confidence: 0.7,
  },
]

/** Which shape maps to which task, with the `note` shape reading the pack's default. */
export const taskForShape = (shape: ClinicalShape, defaultTask?: string): Task => {
  if (shape === 'note' && defaultTask === 'note-format') return 'note-format'
  return DEFAULT_TASK_FOR_SHAPE[shape]
}

// --- Router --------------------------------------------------------------------------------

/**
 * Classify the clinical input shape and return the ordered matching workflow plan.
 *
 * Rules are ordered by confidence for the primary, backwards-compatible `task`. All
 * equally definitive matches remain in `tasks`, because one payload can require more
 * than one workflow.
 *
 * @param input — the raw document text or payload
 * @param defaultTask — the pack's declared `defaultTask`, used only for the `note` shape
 */
export const routeClinicalShape = (input: string, defaultTask?: string): ClinicalRouteResult => {
  let confidence = -1
  const matches: Array<{ task: Task; shape: ClinicalShape; rule: string }> = []

  for (const rule of DEFAULT_CLINICAL_RULES) {
    if (rule.detect(input)) {
      if (rule.confidence > confidence) {
        confidence = rule.confidence
        matches.length = 0
      }
      if (rule.confidence === confidence) {
        matches.push({ task: taskForShape(rule.shape, defaultTask), shape: rule.shape, rule: rule.name })
      }
    }
  }

  if (matches.length > 0) {
    const order: Task[] = ['shock-extraction', 'shock', 'sepsis', 'vital-signs', 'note-format', 'transcript', 'summary']
    const matchedTasks = [...new Set(matches.map((match) => match.task))]
    // A prose shock route is a two-contract workflow: extract the closed exam payload first,
    // then hand that measured payload to the classifier. Structured shock payloads enter the
    // classifier directly.
    const tasks = [...new Set(matchedTasks.flatMap((task) => task === 'shock-extraction' ? [task, 'shock' as const] : [task]))]
      .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    const primary = matches.find((match) => match.task === tasks[0]) ?? matches[0]!
    return {
      task: tasks[0]!,
      tasks,
      shape: primary.shape,
      confidence,
      reason: `${matches.length === 1 ? 'rule' : 'rules'}: ${matches.map((match) => match.rule).join(', ')}`,
    }
  }

  // Nothing matched: fall back to the pack's default task, or vital-signs.
  const fallback: Task =
    defaultTask && (TASKS as readonly string[]).includes(defaultTask) ? (defaultTask as Task) : 'vital-signs'

  return {
    task: fallback,
    tasks: [fallback],
    shape: 'note',
    confidence: 0,
    reason: 'default: no shape matched',
  }
}
