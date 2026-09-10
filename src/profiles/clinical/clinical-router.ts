/**
 * Clinical internal router: shape detection, routing rules, confidence scoring.
 *
 * The router classifies the *shape* of a clinical input and selects the right
 * contract workflow(s), with a confidence score and a fallback to the caller's explicit
 * `--task` override. It is fast and deterministic (rule-based, no model call),
 * and runs *before* any GPU pass so the wrong schema is never sent.
 *
 * Shapes are properties of the input bytes, not contract names. Most shapes map to one task,
 * and an input that raises more than one clinical question returns an ordered task plan: a
 * septic-shock note runs the shock workflow and the sepsis workflow, four passes in all.
 *
 * THE PLAN IS A UNION, NOT A WINNER, and that distinction is the reason the rules carry a
 * `kind`. This router used to collapse to the single highest-confidence rule, which meant the
 * only way two workflows ever ran together was if their rules happened to sit at exactly the
 * same confidence — an accident of two numbers in a table, not a decision. Septic shock is
 * precisely the case that made it wrong: it is not a third condition to detect, it is a note
 * that meets the shock criteria and the sepsis criteria at once, and detecting only the more
 * confident of the two answers half the question and reports it as the whole one.
 */

import { type ClinicalShape, DEFAULT_TASK_FOR_SHAPE, NOTE_DEFAULT_TASKS, TASK_FEEDS, TASK_ORDER, TASKS, type Task } from './contracts.ts'

/**
 * What a rule is answering, which is what decides whether it may share a plan.
 *
 * `modality` rules describe the SHAPE OF THE DOCUMENT — a dialogue, a dictation, a list of
 * paths, a note with vitals in it. A document has exactly one of these, so they compete and
 * the highest confidence wins.
 *
 * `question` rules describe WHAT IS BEING ASKED ABOUT THE PATIENT — is this shock, is this
 * sepsis. A patient can be both, and septic shock is precisely the case where they are: it
 * meets the shock criteria and the sepsis criteria at once, and answering only the more
 * confident of the two answers half the question. So question rules do not compete with each
 * other; every one that fires contributes its workflow to the plan.
 */
export type ClinicalRuleKind = 'modality' | 'question'

export interface ClinicalRouteRule {
  name: string
  shape: ClinicalShape
  kind: ClinicalRuleKind
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

// --- Sepsis suspicion detection ----------------------------------------------------------

/**
 * A suspected source of infection. Sepsis is organ dysfunction caused by INFECTION, so a note
 * with organ dysfunction and no infection anywhere in it is describing something else — which
 * is what keeps a haemorrhagic shock note out of the sepsis workflow.
 */
const INFECTION_TERMS = [
  'infection', 'infected', 'pneumonia', 'urinary tract infection', 'uti', 'pyelonephritis',
  'cellulitis', 'meningitis', 'cholangitis', 'cholecystitis', 'abscess', 'bacteremia',
  'bacteraemia', 'endocarditis', 'empyema', 'osteomyelitis', 'peritonitis',
  'fever', 'febrile', 'pyrexia', 'source of infection', 'antibiotics', 'purulent',
]

/**
 * The three qSOFA criteria as they appear in PROSE, one group per criterion.
 *
 * These are deliberately the same three the screening contract scores — respiratory rate,
 * systolic blood pressure, and mental status — rather than a wider net of sepsis-adjacent
 * words. A router that fired on a criterion the downstream contract does not read would send
 * notes to a screen that cannot use them.
 */
const QSOFA_PROSE_GROUPS = [
  ['tachypnea', 'tachypnoea', 'tachypneic', 'tachypnoeic', 'respiratory rate', 'breathing fast', 'rapid breathing', 'increased work of breathing'],
  ['hypotension', 'hypotensive', 'low blood pressure', 'low bp', 'systolic', 'sbp'],
  ['altered mental status', 'altered mental state', 'confusion', 'confused', 'obtunded', 'obtundation', 'gcs', 'glasgow coma', 'drowsy', 'lethargic', 'encephalopathy', 'unresponsive'],
]

/** Explicit naming of the syndrome, which counts as one criterion the way `shock` does. */
const SEPSIS_GENERAL_TERMS = ['sepsis', 'septic', 'septicaemia', 'septicemia', 'qsofa', 'q-sofa']

/**
 * Two independent signals of sepsis, on the shock rule's terms and for the same reason:
 * one alone is too common in an ordinary note to route on, and the extraction pass this
 * leads to is a GPU call that a stray mention of a fever should not buy.
 *
 * STRUCTURED PAYLOADS ARE EXCLUDED, both kinds, and the two exclusions are not the same
 * argument. A qSOFA payload is excluded because it has its own definitive route: it can go
 * straight to the screen with no extraction pass in front of it. A SHOCK exam payload is
 * excluded because it cannot be screened at all — it carries a systolic, but no respiratory
 * rate and no GCS, so two of the three criteria are absent and there is no prose left to
 * extract them from. Firing here would buy a GPU call that can only fail, and it nearly did:
 * the exam payload says `hypotension` and `mental_status`, which reads as two criteria.
 */
const isSepsisSuspicion = (input: string): boolean => {
  if (isSepsisJson(input) || isExamJson(input)) return false
  const lower = input.toLowerCase()

  let criteria = 0
  if (INFECTION_TERMS.some((k) => (k.includes(' ') ? lower.includes(k) : new RegExp(`\\b${k}\\b`, 'i').test(input)))) criteria++
  for (const group of QSOFA_PROSE_GROUPS) {
    if (group.some((k) => (k.includes(' ') ? lower.includes(k) : new RegExp(`\\b${k}\\b`, 'i').test(input)))) criteria++
  }
  if (SEPSIS_GENERAL_TERMS.some((k) => new RegExp(`\\b${k}\\b`, 'i').test(input))) criteria++

  return criteria >= 2
}

// --- Rule set ------------------------------------------------------------------------------

export const DEFAULT_CLINICAL_RULES: ClinicalRouteRule[] = [
  {
    name: 'qsofa-json',
    shape: 'qsofa-json',
    kind: 'question',
    detect: isSepsisJson,
    confidence: 1.0,
  },
  {
    name: 'exam-json',
    shape: 'exam-json',
    kind: 'question',
    detect: isExamJson,
    confidence: 1.0,
  },
  {
    name: 'summary-input',
    shape: 'summary-input',
    kind: 'modality',
    detect: isSummaryInput,
    confidence: 1.0,
  },
  {
    name: 'dialogue',
    shape: 'dialogue',
    kind: 'modality',
    detect: isDialogue,
    confidence: 0.95,
  },
  {
    name: 'dictation',
    shape: 'dictation',
    kind: 'modality',
    detect: isDictation,
    confidence: 0.95,
  },
  {
    name: 'shock-suspicion',
    shape: 'shock-suspicion',
    kind: 'question',
    detect: isShockSuspicion,
    confidence: 0.92,
  },
  {
    name: 'sepsis-suspicion',
    shape: 'sepsis-suspicion',
    kind: 'question',
    detect: isSepsisSuspicion,
    confidence: 0.92,
  },
  {
    name: 'vitals-note',
    shape: 'vitals-note',
    kind: 'modality',
    detect: isVitalsNote,
    confidence: 0.9,
  },
  {
    name: 'note',
    shape: 'note',
    kind: 'modality',
    detect: isClinicalNote,
    confidence: 0.7,
  },
]

/** Which shape maps to which task, with the `note` shape reading the pack's default. */
export const taskForShape = (shape: ClinicalShape, defaultTask?: string): Task => {
  if (shape === 'note' && NOTE_DEFAULT_TASKS.includes(defaultTask as Task)) return defaultTask as Task
  return DEFAULT_TASK_FOR_SHAPE[shape]
}

// --- Router --------------------------------------------------------------------------------

/**
 * Classify the clinical input and return the ordered workflow plan it needs.
 *
 * Highest confidence still picks the winner and still fills the backwards-compatible `task`
 * and `shape`. What decides the rest of the plan is the winner's KIND — see `ClinicalRuleKind`
 * — because a document has one shape but can raise several clinical questions.
 *
 * The plan is returned in DEPENDENCY ORDER, and the two prose arms expand as they go: a
 * `shock-extraction` in the plan implies the `shock` pass that consumes its payload, and a
 * `sepsis-extraction` implies the `sepsis` screen. A structured payload skips its extraction
 * because it already is the payload.
 *
 * @param input — the raw document text or payload
 * @param defaultTask — the pack's declared `defaultTask`, used only for the `note` shape
 */
export const routeClinicalShape = (input: string, defaultTask?: string): ClinicalRouteResult => {
  const fired = DEFAULT_CLINICAL_RULES.filter((rule) => rule.detect(input))

  // The winner decides which KIND of rule this document is answered by, and the highest
  // confidence still picks it. What changed is what happens next: when a question rule wins,
  // every OTHER question rule that fired joins the plan regardless of its own confidence,
  // because they are not rival readings of one document — they are separate clinical
  // questions the same note raises. Septic shock is the case: `exam-json` or
  // `shock-suspicion` wins on confidence, and the sepsis question is still open.
  //
  // A modality winner keeps the old behaviour exactly, ties included: a document has one
  // shape, so a dialogue is not also a list of paths.
  let top: ClinicalRouteRule | undefined
  for (const rule of fired) if (!top || rule.confidence > top.confidence) top = rule

  const contributing = top === undefined
    ? []
    : top.kind === 'question'
      ? fired.filter((rule) => rule.kind === 'question')
      : fired.filter((rule) => rule.kind === 'modality' && rule.confidence === top!.confidence)

  if (top !== undefined && contributing.length > 0) {
    const confidence = top.confidence
    const matches = contributing.map((rule) => ({
      task: taskForShape(rule.shape, defaultTask),
      shape: rule.shape,
      rule: rule.name,
    }))
    const matchedTasks = [...new Set(matches.map((match) => match.task))]
    // A prose route is a two-contract workflow on both arms: extract the closed payload first,
    // then hand that measured payload to the contract that reasons over it. Structured
    // payloads — an exam or a qSOFA screen — enter their contract directly. Which task feeds
    // which is `TASK_FEEDS`, so the plan and the drawn topology cannot disagree.
    const expand = (task: Task): Task[] => {
      const chain: Task[] = []
      let current: Task | undefined = task
      while (current && !chain.includes(current)) {
        chain.push(current)
        current = TASK_FEEDS[current]
      }
      return chain
    }
    const tasks = [...new Set(matchedTasks.flatMap(expand))].sort(
      (a, b) => TASK_ORDER.indexOf(a) - TASK_ORDER.indexOf(b),
    )
    // The reported shape is the WINNER's, not the plan's: a plan has no single shape, and the
    // caller that reads this field wants to know what the router recognised most strongly.
    return {
      task: tasks[0]!,
      tasks,
      shape: top.shape,
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
