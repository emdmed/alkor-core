/**
 * Clinical router unit tests: shape detection, rule precedence, and override behaviour.
 *
 * No model calls; every test is deterministic and fast.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  routeClinicalShape,
  taskForShape,
  DEFAULT_CLINICAL_RULES,
} from '../src/profiles/clinical/clinical-router.ts'
import {
  type ClinicalShape,
  DEFAULT_TASK_FOR_SHAPE,
  NOTE_DEFAULT_TASKS,
  UNREVIEWABLE_TASKS,
  type Task,
} from '../src/profiles/clinical/contracts.ts'
import type { ProfileTopologyRoute } from '../src/core/topology.ts'
import { clinicalStages } from '../src/profiles/clinical/stages.ts'
import { loadPack } from '../src/core/pack.ts'
import { createActivity, withActivity } from '../src/core/activity.ts'

process.env.MEDPROTOCOL_BIN = join(import.meta.dirname, 'fixtures', 'medprotocol.js')

// --- Shape detection -----------------------------------------------------------------------

test('exam-json shape: JSON with shock keys routes to shock', () => {
  const r = routeClinicalShape(JSON.stringify({ systolic_bp: 90, heart_rate: 72 }))
  assert.equal(r.shape, 'exam-json')
  assert.equal(r.task, 'shock')
  assert.equal(r.confidence, 1.0)
})

test('exam-json shape: JSON with actual shock payload keys routes to shock', () => {
  const r = routeClinicalShape(
    JSON.stringify({
      hypotension: { systolic: 80, diastolic: 50, duration_minutes: 45 },
      heart_rate: 110,
      skin_temperature: 'cool',
      jugular_venous_pressure: 'elevated',
      capillary_refill: 'delayed',
      pulse_volume: 'thready',
      lung_exam: 'bilateral_crackles',
    }),
  )
  assert.equal(r.shape, 'exam-json')
  assert.equal(r.task, 'shock')
})

test('a combined shock and qSOFA payload routes through both workflows in order', () => {
  const r = routeClinicalShape(JSON.stringify({
    respiratory_rate: 24,
    systolic_bp: 88,
    gcs: 12,
    hypotension: { systolic: 88, diastolic: 54, duration_minutes: 45 },
    heart_rate: 118,
    skin_temperature: 'warm',
    jugular_venous_pressure: 'normal_or_low',
    capillary_refill: 'brisk',
    pulse_volume: 'bounding',
    lung_exam: 'clear',
  }))

  assert.equal(r.task, 'shock')
  assert.deepEqual(r.tasks, ['shock', 'sepsis'])
  assert.equal(r.confidence, 1)
  assert.match(r.reason, /qsofa-json/)
  assert.match(r.reason, /exam-json/)
})

test('exam-json shape: JSON without shock keys falls through to note', () => {
  const r = routeClinicalShape(JSON.stringify({ foo: 'bar', baz: 123 }))
  assert.equal(r.shape, 'note')
  assert.equal(r.task, 'vital-signs')
})

test('summary-input shape: JSON array of strings routes to summary', () => {
  const r = routeClinicalShape(JSON.stringify(['note1.txt', 'note2.txt']))
  assert.equal(r.shape, 'summary-input')
  assert.equal(r.task, 'summary')
  assert.equal(r.confidence, 1.0)
})

test('summary-input shape: newline-separated list of file paths routes to summary', () => {
  const r = routeClinicalShape('notes/patient-a.note.txt\nnotes/patient-b.note.txt\n')
  assert.equal(r.shape, 'summary-input')
  assert.equal(r.task, 'summary')
})

test('summary-input shape: single line does not route to summary', () => {
  const r = routeClinicalShape('notes/patient-a.note.txt')
  assert.notEqual(r.shape, 'summary-input')
})

test('dialogue shape: two speaker turns routes to transcript', () => {
  const r = routeClinicalShape('Doctor: How are you?\nPatient: I have chest pain.')
  assert.equal(r.shape, 'dialogue')
  assert.equal(r.task, 'transcript')
  assert.equal(r.confidence, 0.95)
})

test('dialogue shape: D: and P: labels routes to transcript', () => {
  const r = routeClinicalShape('D: BP 120/80.\nP: HR 72.')
  assert.equal(r.shape, 'dialogue')
  assert.equal(r.task, 'transcript')
})

test('dictation shape: starts with Dictation: routes to transcript', () => {
  const r = routeClinicalShape('Dictation: patient reports chest pain radiating to left arm.')
  assert.equal(r.shape, 'dictation')
  assert.equal(r.task, 'transcript')
  assert.equal(r.confidence, 0.95)
})

test('dictation shape: starts with Transcribed: routes to transcript', () => {
  const r = routeClinicalShape('Transcribed: BP 120 over 80, heart rate 72.')
  assert.equal(r.shape, 'dictation')
  assert.equal(r.task, 'transcript')
})

test('dictation shape: starts with Audio: routes to transcript', () => {
  const r = routeClinicalShape('Audio: the patient says they feel dizzy.')
  assert.equal(r.shape, 'dictation')
  assert.equal(r.task, 'transcript')
})

test('vitals-note shape: contains BP and HR routes to vital-signs', () => {
  const r = routeClinicalShape('Patient BP 120/80, HR 72, feeling well.')
  assert.equal(r.shape, 'vitals-note')
  assert.equal(r.task, 'vital-signs')
  assert.equal(r.confidence, 0.9)
})

test('vitals-note shape: contains SpO2 and RR routes to vital-signs', () => {
  const r = routeClinicalShape('SpO2 97% on room air, RR 16.')
  assert.equal(r.shape, 'vitals-note')
  assert.equal(r.task, 'vital-signs')
})

test('vitals-note shape: requires at least two distinct abbreviations', () => {
  const r = routeClinicalShape('The patient has a BP cuff but no reading taken yet.')
  assert.notEqual(r.shape, 'vitals-note')
})

test('note shape: clinical prose without vitals routes to vital-signs (default)', () => {
  const r = routeClinicalShape('Patient admitted for chest pain, treated with aspirin, discharge planned.')
  assert.equal(r.shape, 'note')
  assert.equal(r.task, 'vital-signs')
  assert.equal(r.confidence, 0.7)
})

test('note shape: defaultTask note-format overrides to note-format', () => {
  const r = routeClinicalShape(
    'Patient admitted for chest pain, treated with aspirin, discharge planned.',
    'note-format',
  )
  assert.equal(r.shape, 'note')
  assert.equal(r.task, 'note-format')
})

// --- Shock suspicion shape -----------------------------------------------------------------

test('shock-suspicion shape: two shock criteria routes to shock-extraction', () => {
  const r = routeClinicalShape('Patient hypotensive, tachycardic, cool peripheries.')
  assert.equal(r.shape, 'shock-suspicion')
  assert.equal(r.task, 'shock-extraction')
  assert.deepEqual(r.tasks, ['shock-extraction', 'shock'])
  assert.equal(r.confidence, 0.92)
})

test('shock-suspicion shape: hypotension + oliguria routes to shock-extraction', () => {
  const r = routeClinicalShape('Patient with hypotension and oliguria.')
  assert.equal(r.shape, 'shock-suspicion')
  assert.equal(r.task, 'shock-extraction')
})

test('shock-suspicion shape: shock term + one criterion routes to shock-extraction', () => {
  const r = routeClinicalShape('Patient in shock, confused and lethargic.')
  assert.equal(r.shape, 'shock-suspicion')
  assert.equal(r.task, 'shock-extraction')
})

test('shock-suspicion shape: single criterion does not match', () => {
  const r = routeClinicalShape('Patient has hypotension.')
  assert.notEqual(r.shape, 'shock-suspicion')
})

test('shock-suspicion shape: exam-json overrides shock-suspicion (1.0 > 0.92)', () => {
  const r = routeClinicalShape(
    JSON.stringify({ hypotension: { systolic: 80, diastolic: 50, duration_minutes: 45 }, heart_rate: 110 }),
  )
  assert.equal(r.shape, 'exam-json')
  assert.equal(r.task, 'shock')
})

test('empty string falls back to defaultTask', () => {
  const r = routeClinicalShape('', 'vital-signs')
  assert.equal(r.shape, 'note')
  assert.equal(r.task, 'vital-signs')
  assert.equal(r.confidence, 0)
})

test('non-clinical input falls back to defaultTask', () => {
  const r = routeClinicalShape('hello world', 'vital-signs')
  assert.equal(r.shape, 'note')
  assert.equal(r.task, 'vital-signs')
  assert.equal(r.confidence, 0)
})

// --- Rule precedence -----------------------------------------------------------------------

test('exam-json wins over dialogue because confidence 1.0 > 0.95', () => {
  const r = routeClinicalShape(
    JSON.stringify({ heart_rate: 72 }) + '\nDoctor: How are you?\nPatient: Fine.',
  )
  assert.equal(r.shape, 'exam-json')
  assert.equal(r.confidence, 1.0)
})

test('dialogue overrides dictation when both present (both 0.95, dialogue first in rule order)', () => {
  const r = routeClinicalShape('Dictation: Doctor: How are you?\nPatient: Fine.')
  // dialogue is checked before dictation in the rule list, so it wins even though
  // both have the same confidence. The first rule at a given confidence wins.
  assert.equal(r.shape, 'dialogue')
})

test('dictation wins over vitals-note because confidence 0.95 > 0.9', () => {
  const r = routeClinicalShape('Dictation: BP 120/80, HR 72.')
  assert.equal(r.shape, 'dictation')
  assert.equal(r.task, 'transcript')
})

test('vitals-note wins over note because confidence 0.9 > 0.7', () => {
  const r = routeClinicalShape('Patient admitted for chest pain. BP 140/90, HR 88.')
  assert.equal(r.shape, 'vitals-note')
  assert.equal(r.task, 'vital-signs')
})

test('shock-suspicion wins over vitals-note because confidence 0.92 > 0.9', () => {
  const r = routeClinicalShape('Patient BP 78/38, HR 118, hypotensive, cool peripheries, oliguria.')
  assert.equal(r.shape, 'shock-suspicion')
  assert.equal(r.task, 'shock-extraction')
})

// --- Sepsis suspicion, and the two questions one note can raise -----------------------------

test('sepsis-suspicion shape: infection plus a qSOFA criterion routes through extraction', () => {
  const r = routeClinicalShape('Patient with suspected urinary tract infection, tachypneic at 24, GCS 13.')
  assert.equal(r.shape, 'sepsis-suspicion')
  assert.equal(r.task, 'sepsis-extraction')
  assert.deepEqual(r.tasks, ['sepsis-extraction', 'sepsis'])
  assert.equal(r.confidence, 0.92)
})

test('sepsis-suspicion shape: a single criterion does not match', () => {
  const r = routeClinicalShape('Patient treated for a wound infection, now comfortable.')
  assert.notEqual(r.shape, 'sepsis-suspicion')
})

/**
 * The case the whole two-kind rule split exists for.
 *
 * Septic shock is not a third condition to detect — it is a note that meets the shock criteria
 * and the sepsis criteria at once, and both workflows have to run. Under the old
 * winner-take-all collapse only the higher-confidence rule survived, and since these two sit at
 * the same confidence by design, a tie was the ONLY way both ever ran. That is an accident, not
 * a policy, and this asserts the policy: the plan is the union, in dependency order.
 */
test('septic shock prose raises both questions and plans all four workflows in order', () => {
  const r = routeClinicalShape(
    'Patient with suspected pneumonia. Hypotensive at 88/54 for 45 minutes, tachypneic with ' +
      'respiratory rate 24, GCS 12 and confused. Peripheries warm, capillary refill brisk.',
  )
  assert.deepEqual(r.tasks, ['shock-extraction', 'shock', 'sepsis-extraction', 'sepsis'])
  assert.match(r.reason, /shock-suspicion/)
  assert.match(r.reason, /sepsis-suspicion/)
})

test('shock prose without infection does not raise the sepsis question', () => {
  const r = routeClinicalShape(
    'Patient hypotensive with cool mottled extremities and delayed capillary refill after major haemorrhage.',
  )
  assert.deepEqual(r.tasks, ['shock-extraction', 'shock'])
})

/**
 * A structured shock exam says `hypotension` and can say `mental_status`, which reads as two
 * sepsis criteria and very nearly routed a payload with no respiratory rate and no GCS into an
 * extraction pass that had no prose to extract them from.
 */
test('a structured shock exam payload is not sent to the sepsis workflow', () => {
  const r = routeClinicalShape(
    JSON.stringify({
      hypotension: { systolic: 80, diastolic: 50, duration_minutes: 45 },
      heart_rate: 110,
      mental_status: 'confused',
    }),
  )
  assert.equal(r.shape, 'exam-json')
  assert.deepEqual(r.tasks, ['shock'])
})

/**
 * Modality still wins outright, and this is the boundary of the change: a dialogue is a
 * document shape, not a clinical question, so a transcript that mentions shock is transcribed
 * rather than fanned out into extraction passes over a two-speaker conversation.
 */
test('a dialogue mentioning shock is still transcribed, not fanned out', () => {
  const r = routeClinicalShape(
    'Doctor: Your blood pressure is low and you seem confused.\nPatient: I feel faint, I think I am in shock.',
  )
  assert.equal(r.shape, 'dialogue')
  assert.deepEqual(r.tasks, ['transcript'])
})

// --- taskForShape --------------------------------------------------------------------------

const allShapes: ClinicalShape[] = ['exam-json', 'qsofa-json', 'shock-suspicion', 'sepsis-suspicion', 'dialogue', 'dictation', 'vitals-note', 'note', 'summary-input']

for (const shape of allShapes) {
  test(`taskForShape(${shape}) returns the default task`, () => {
    const expected = DEFAULT_TASK_FOR_SHAPE[shape as ClinicalShape]
    assert.equal(taskForShape(shape as ClinicalShape), expected)
  })
}

test('taskForShape(note) with defaultTask note-format returns note-format', () => {
  assert.equal(taskForShape('note', 'note-format'), 'note-format')
})

test('taskForShape(note) with defaultTask vital-signs returns vital-signs', () => {
  assert.equal(taskForShape('note', 'vital-signs'), 'vital-signs')
})

test('taskForShape(note) with unknown defaultTask returns vital-signs', () => {
  assert.equal(taskForShape('note', 'unknown'), 'vital-signs')
})

// --- Router edge cases --------------------------------------------------------------------

test('routeClinicalShape with invalid JSON falls through', () => {
  const r = routeClinicalShape('{"broken": ')
  assert.equal(r.shape, 'note')
})

test('routeClinicalShape with JSON object that is not exam falls through', () => {
  const r = routeClinicalShape('{"patient": "John", "age": 30}')
  assert.equal(r.shape, 'note')
})

test('dialogue detection requires two speaker labels for generic pattern', () => {
  const r = routeClinicalShape('Speaker: hello world')
  assert.notEqual(r.shape, 'dialogue')
})

test('dictation marker must be at the start of the string', () => {
  const r = routeClinicalShape('The note says Dictation: something here.')
  assert.notEqual(r.shape, 'dictation')
})

test('vitals-note does not trigger on single abbreviation', () => {
  const r = routeClinicalShape('The patient has a BP cuff.')
  assert.notEqual(r.shape, 'vitals-note')
})

test('vitals-note is case-insensitive', () => {
  const r = routeClinicalShape('bp 120/80, hr 72')
  assert.equal(r.shape, 'vitals-note')
})

test('note shape requires at least one clinical term', () => {
  const r = routeClinicalShape('The weather is nice today.')
  assert.equal(r.shape, 'note')
  assert.equal(r.confidence, 0)
})

// --- Checkpointing -------------------------------------------------------------------------

const pack = loadPack(join(import.meta.dirname, '..', 'packs', 'clinical'))

test('clinical profile checkpoints route to contextDir and resumes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'medextract-clinical-'))
  try {
    const { PROFILE } = await import('../src/profiles/clinical/profile.ts')
    const trace = { write: () => {}, close: () => {} } as any

    // First call: routes to vital-signs, then fails at network (fake URL) → ok: false.
    const result1 = await PROFILE.review!({
      pack,
      baseUrl: 'http://127.0.0.1:1',
      trace,
      input: { kind: 'text', text: 'Patient BP 120/80, HR 72', label: 'test' },
      options: { 'context-dir': dir },
    } as any)

    assert.equal(result1.ok, false)
    assert.ok(result1.text.includes('server') || result1.text.includes('cannot reach'))

    // route.json was written before the failure.
    assert.ok(existsSync(join(dir, 'clinical', 'route.json')))
    // result.json was NOT written because execution failed.
    assert.ok(!existsSync(join(dir, 'clinical', 'result.json')))

    const cached = JSON.parse(readFileSync(join(dir, 'clinical', 'route.json'), 'utf8'))
    assert.equal(cached.route.task, 'vital-signs')
    assert.equal(cached.route.shape, 'vitals-note')
    assert.equal(cached.text, 'Patient BP 120/80, HR 72')

    // Second call: resumes from route.json, skips routing, fails again at network.
    const result2 = await PROFILE.review!({
      pack,
      baseUrl: 'http://127.0.0.1:1',
      trace,
      input: { kind: 'text', text: 'completely different input', label: 'test' },
      options: { 'context-dir': dir },
    } as any)

    assert.equal(result2.ok, false)
    assert.ok(result2.text.includes('server') || result2.text.includes('cannot reach'))

    // route.json still has the original route (not re-computed from the different input).
    const cached2 = JSON.parse(readFileSync(join(dir, 'clinical', 'route.json'), 'utf8'))
    assert.equal(cached2.route.task, 'vital-signs')
    assert.equal(cached2.text, 'Patient BP 120/80, HR 72')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('clinical profile executes a multi-route plan sequentially and emits it for the dashboard', async () => {
  const { PROFILE } = await import('../src/profiles/clinical/profile.ts')
  const calls: string[] = []
  const provider = {
    async chat(o: { label: string }): Promise<string> {
      calls.push(o.label)
      if (o.label === 'shock') return JSON.stringify({
        skin_temperature: 'warm',
        jugular_venous_pressure: 'normal_or_low',
        shock_category: 'septic',
        supporting_findings: ['skin_temperature', 'jugular_venous_pressure'],
        discordant_findings: [],
        indeterminate_reason: null,
        assessment_confidence: 0.9,
        notes: null,
      })
      if (o.label === 'sepsis') return JSON.stringify({
        respiratory_rate: 24,
        systolic_bp: 88,
        gcs: 12,
        qsofa_score: 3,
        positive: true,
        criteria_met: ['respiratory_rate', 'systolic_bp', 'altered_mental_status'],
        screen_reason: 'all three criteria met',
        assessment_confidence: 0.9,
        notes: null,
      })
      throw new Error(`unexpected model call ${o.label}`)
    },
  } as any
  const activity = createActivity()
  const trace = { write: () => {}, close: () => {} } as any
  const input = JSON.stringify({
    respiratory_rate: 24,
    systolic_bp: 88,
    gcs: 12,
    hypotension: { systolic: 88, diastolic: 54, duration_minutes: 45 },
    heart_rate: 118,
    skin_temperature: 'warm',
    jugular_venous_pressure: 'normal_or_low',
    capillary_refill: 'brisk',
    pulse_volume: 'bounding',
    lung_exam: 'clear',
  })

  const result = await PROFILE.review!({
    pack,
    trace,
    input: { kind: 'text', text: input, label: 'combined' },
    options: {},
    provider,
    activity,
  } as any)

  assert.deepEqual(calls, ['shock', 'sepsis'])
  assert.equal(result.ok, true)
  assert.deepEqual((result.report as any).routes, ['shock', 'sepsis'])
  const route = activity.recent().find((event: any) => event.kind === 'stage' && event.name === 'route') as any
  assert.deepEqual(route.detail.tasks, ['shock', 'sepsis'])
})

/**
 * What the front door's vital-signs pass returns for the septic-shock note below.
 *
 * A blood pressure and a heart rate, because those are the two medprotocol's `vitals` command
 * requires: with either missing it refuses, and the CLI-derived half of the routing evidence —
 * the categories, the shock index — is simply absent. The respiratory rate is the qSOFA
 * criterion the front door can supply; the GCS is not here because the contract has no slot for
 * one, which is why the sepsis arm still runs its own extraction.
 */
const FRONT_DOOR_READING = JSON.stringify({
  blood_pressure: { systolic: 88, diastolic: 54, unit: 'mmHg', raw_text: 'Hypotensive at 88/54' },
  heart_rate: { value: 118, unit: 'bpm', raw_text: 'tachypneic with' },
  respiratory_rate: { value: 24, unit: 'breaths/min', raw_text: 'respiratory rate 24' },
  temperature: null,
  weight: null,
  height: null,
  oxygen_saturation: null,
  blood_glucose: null,
  bmi: null,
  extraction_confidence: 0.9,
  notes: null,
})

/**
 * The septic-shock note, end to end: two questions, five passes, two handoffs.
 *
 * What this is really guarding is that each reasoning contract reads ITS OWN extraction's
 * payload. Both extractions run over the same prose, and both downstream contracts parse their
 * input as a closed object, so a handoff that crossed the wires would not throw — the sepsis
 * screen would receive a shock exam, fail to find a respiratory rate, and report as though the
 * model could not answer. So the assertions are on the bytes each stage received, not just on
 * the order the stages ran in.
 */
test('a septic shock note runs both workflows, each reasoning over its own extraction', async () => {
  const { PROFILE } = await import('../src/profiles/clinical/profile.ts')

  const shockExam = {
    hypotension: { systolic: 88, diastolic: 54, duration_minutes: 45 },
    heart_rate: 118,
    skin_temperature: 'warm',
    jugular_venous_pressure: 'normal_or_low',
    capillary_refill: 'brisk',
    pulse_volume: 'bounding',
    lung_exam: 'clear',
  }
  const sepsisExam = { respiratory_rate: 24, systolic_bp: 88, gcs: 12 }

  const calls: string[] = []
  const received: Record<string, string> = {}
  const provider = {
    async chat(o: { label: string; userPrompt: string }): Promise<string> {
      calls.push(o.label)
      received[o.label] = o.userPrompt
      if (o.label === 'vital_signs') return FRONT_DOOR_READING
      if (o.label === 'shock-extraction') return JSON.stringify(shockExam)
      if (o.label === 'sepsis-extraction') return JSON.stringify(sepsisExam)
      if (o.label === 'shock') return JSON.stringify({
        skin_temperature: 'warm',
        jugular_venous_pressure: 'normal_or_low',
        shock_category: 'septic',
        supporting_findings: ['skin_temperature', 'jugular_venous_pressure'],
        discordant_findings: [],
        indeterminate_reason: null,
        assessment_confidence: 0.9,
        notes: null,
      })
      if (o.label === 'sepsis') return JSON.stringify({
        respiratory_rate: 24,
        systolic_bp: 88,
        gcs: 12,
        qsofa_score: 3,
        positive: true,
        criteria_met: ['respiratory_rate', 'systolic_bp', 'altered_mental_status'],
        screen_reason: 'all three criteria met',
        assessment_confidence: 0.9,
        notes: null,
      })
      throw new Error(`unexpected model call ${o.label}`)
    },
  } as any

  const note =
    'Patient with suspected pneumonia. Hypotensive at 88/54 for 45 minutes, tachypneic with ' +
    'respiratory rate 24, GCS 12 and confused. Peripheries warm, capillary refill brisk.'

  const activity = createActivity()
  const result = await PROFILE.review!({
    pack,
    trace: { write: () => {}, close: () => {} } as any,
    input: { kind: 'text', text: note, label: 'septic-shock-note' },
    options: {},
    provider,
    activity,
  } as any)

  // The vital signs are read FIRST, before the route is decided — see vitals-first.ts. The
  // reading is part of the plan rather than a pass made and discarded, so it appears in the
  // routes too, at the head of them.
  assert.deepEqual(calls, ['vital_signs', 'shock-extraction', 'shock', 'sepsis-extraction', 'sepsis'])
  assert.equal(result.ok, true)
  assert.deepEqual((result.report as any).routes, ['vital-signs', 'shock-extraction', 'shock', 'sepsis-extraction', 'sepsis'])

  // Both extractions read the note itself, with the measured numbers appended as already-decided
  // facts: they still have findings to extract that the vital-signs contract has no slot for,
  // and no reason to read a blood pressure the CLI has already parsed.
  assert.ok(received['shock-extraction']!.includes('suspected pneumonia'))
  assert.ok(received['sepsis-extraction']!.includes('suspected pneumonia'))
  for (const label of ['shock-extraction', 'sepsis-extraction']) {
    assert.match(received[label]!, /MEASURED VITAL SIGNS/, `${label} was not seeded with the measured vitals`)
    assert.match(received[label]!, /blood pressure: 88\/54 mmHg/, `${label} did not receive the parsed blood pressure`)
  }

  // Each reasoning pass read its own upstream payload, and neither read the prose.
  assert.ok(received['shock']!.includes('jugular_venous_pressure'))
  assert.ok(!received['shock']!.includes('suspected pneumonia'))
  assert.ok(received['sepsis']!.includes('24'))
  assert.ok(!received['sepsis']!.includes('jugular_venous_pressure'))

  const route = activity.recent().find((e: any) => e.kind === 'stage' && e.name === 'route') as any
  assert.deepEqual(route.detail.tasks, ['vital-signs', 'shock-extraction', 'shock', 'sepsis-extraction', 'sepsis'])

  // The decision names the numbers it turned on, at the cut-points the pack publishes, so a
  // reader can check the route by hand rather than taking `shock-suspicion` on trust.
  assert.match(route.detail.reason ?? '', /measured:/)
})

/**
 * A downstream contract must not fall back to the prose when its extraction came back empty.
 * The sepsis arm is checked here and the shock arm is unaffected: one failed extraction stops
 * its own workflow and no other.
 */
test('a failed sepsis extraction skips only its own screen', async () => {
  const { PROFILE } = await import('../src/profiles/clinical/profile.ts')

  const calls: string[] = []
  const provider = {
    async chat(o: { label: string }): Promise<string> {
      calls.push(o.label)
      if (o.label === 'vital_signs') return FRONT_DOOR_READING
      if (o.label === 'sepsis-extraction') return 'I cannot determine the GCS from this note.'
      if (o.label === 'shock-extraction') return JSON.stringify({
        hypotension: { systolic: 88, diastolic: 54, duration_minutes: 45 },
        heart_rate: 118,
        skin_temperature: 'warm',
        jugular_venous_pressure: 'normal_or_low',
        capillary_refill: 'brisk',
        pulse_volume: 'bounding',
        lung_exam: 'clear',
      })
      if (o.label === 'shock') return JSON.stringify({
        skin_temperature: 'warm',
        jugular_venous_pressure: 'normal_or_low',
        shock_category: 'septic',
        supporting_findings: ['skin_temperature', 'jugular_venous_pressure'],
        discordant_findings: [],
        indeterminate_reason: null,
        assessment_confidence: 0.9,
        notes: null,
      })
      throw new Error(`unexpected model call ${o.label}`)
    },
  } as any

  const result = await PROFILE.review!({
    pack,
    trace: { write: () => {}, close: () => {} } as any,
    input: {
      kind: 'text',
      text:
        'Patient with suspected pneumonia. Hypotensive at 88/54 for 45 minutes, tachypneic with ' +
        'respiratory rate 24, GCS 12 and confused. Peripheries warm, capillary refill brisk.',
      label: 'septic-shock-note',
    },
    options: {},
    provider,
  } as any)

  // The screen was never called: it is absent from the call list, not called with the prose.
  // The front door's reading is at the head of the list for every routed prose note now.
  assert.deepEqual(calls, ['vital_signs', 'shock-extraction', 'shock', 'sepsis-extraction'])
  assert.equal(result.ok, false)
  const results = (result.report as any).results
  assert.equal(results['shock'].ok, true)
  assert.equal(results['sepsis'].ok, false)
  assert.match(results['sepsis'].output, /sepsis-extraction produced no usable payload/)
})

/**
 * The eval dispatch used to end in an unguarded `else` that ran the TRANSCRIPT eval, so a task
 * in TASKS with no eval mode would have been graded against transcripts and the number filed
 * under its own name — a false pass that looks exactly like a real one. Both halves are pinned
 * here: `all` skips the ungraded task, and naming it explicitly refuses instead of grading
 * something else.
 */
test('an ungraded task is excluded from --task all and refused when named', async () => {
  const { GRADED_TASKS, TASKS, UNGRADED_TASKS } = await import('../src/profiles/clinical/contracts.ts')
  assert.ok(UNGRADED_TASKS.includes('sepsis-extraction' as Task))
  assert.ok(!GRADED_TASKS.includes('sepsis-extraction' as Task))
  assert.deepEqual(GRADED_TASKS, TASKS.filter((t) => !UNGRADED_TASKS.includes(t)))

  const { PROFILE } = await import('../src/profiles/clinical/profile.ts')
  await assert.rejects(
    () =>
      PROFILE.runEval!({
        pack,
        baseUrl: 'http://127.0.0.1:1',
        trace: { write: () => {}, close: () => {} } as any,
        options: { task: 'sepsis-extraction' },
      } as any),
    /has no eval mode/,
  )
})

test('clinical profile caches completed result and returns it on resume', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'medextract-clinical-'))
  try {
    const clinicalDir = join(dir, 'clinical')
    mkdirSync(clinicalDir, { recursive: true })

    // Pre-populate both checkpoints as if a previous run succeeded.
    writeFileSync(
      join(clinicalDir, 'route.json'),
      JSON.stringify({ route: { task: 'vital-signs', shape: 'vitals-note', confidence: 0.9, reason: 'rule: vitals-note' }, text: 'BP 120/80' }),
    )
    writeFileSync(
      join(clinicalDir, 'result.json'),
      JSON.stringify({ text: 'cached result', ok: true, raw: '{}' }),
    )

    const { PROFILE } = await import('../src/profiles/clinical/profile.ts')
    const trace = { write: () => {}, close: () => {} } as any

    const result = await PROFILE.review!({
      pack,
      baseUrl: 'http://127.0.0.1:1',
      trace,
      input: { kind: 'text', text: 'different input', label: 'test' },
      options: { 'context-dir': dir },
    } as any)

    // Should return the cached result without touching the network.
    assert.equal(result.text, 'cached result')
    assert.equal(result.ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('clinical profile explicit --task bypasses router in checkpoint mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'medextract-clinical-'))
  try {
    const { PROFILE } = await import('../src/profiles/clinical/profile.ts')
    const trace = { write: () => {}, close: () => {} } as any

    // Explicit --task shock with invalid JSON fails at parse, before network.
    await assert.rejects(
      () =>
        PROFILE.review!({
          pack,
          baseUrl: 'http://127.0.0.1:1',
          trace,
          input: { kind: 'text', text: 'not valid json', label: 'test' },
          options: { 'context-dir': dir, task: 'shock' },
        } as any),
      /not valid JSON/,
    )

    // route.json should NOT be written because --task bypasses the router.
    assert.ok(!existsSync(join(dir, 'clinical', 'route.json')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- Topology derivation -------------------------------------------------------------------

/**
 * The published route fan and the routes the runtime can actually take are one statement.
 *
 * These are the tests that make the derivation worth doing. Before, the topology was a
 * hand-written list beside the router, and nothing failed when a new shape was added and the
 * list was not — the dashboard simply drew a profile that no longer existed. Each test below
 * fails on exactly that.
 */
/** One note that raises every prose question the router knows, so one plan exercises both arms. */
const SEPTIC_SHOCK_NOTE =
  'Patient with suspected pneumonia. Hypotensive at 88/54 for 45 minutes, tachypneic with ' +
  'respiratory rate 24, GCS 12 and confused. Peripheries warm, capillary refill brisk.'

/** The decision fan the clinical profile publishes, loaded the way the other tests load it. */
const clinicalRouteFan = async (): Promise<ProfileTopologyRoute[]> => {
  const { PROFILE } = await import('../src/profiles/clinical/profile.ts')
  const decision = PROFILE.topology?.stages.find((stage) => stage.kind === 'decision')
  assert.ok(decision, 'the clinical profile publishes no decision stage')
  return decision.routes ?? []
}

test('every task a shape can route to is published as a route', async () => {
  const routes = new Set((await clinicalRouteFan()).map((route) => route.name))
  for (const shape of Object.keys(DEFAULT_TASK_FOR_SHAPE) as ClinicalShape[]) {
    assert.ok(routes.has(taskForShape(shape)), `shape '${shape}' routes to an unpublished task`)
  }
})

test('a pack default that re-points the note shape is published as a route', async () => {
  const routes = new Set((await clinicalRouteFan()).map((route) => route.name))
  for (const task of NOTE_DEFAULT_TASKS) {
    assert.equal(taskForShape('note', task), task)
    assert.ok(routes.has(task), `note-shape override '${task}' is not published as a route`)
  }
})

test('every published feeds edge is the plan the router actually returns', async () => {
  for (const route of await clinicalRouteFan()) {
    if (!route.feeds) continue
    const entry = DEFAULT_CLINICAL_RULES.find((rule) => taskForShape(rule.shape) === route.name)
    assert.ok(entry, `route '${route.name}' declares a feed but no shape reaches it`)
    const plan = routeClinicalShape(SEPTIC_SHOCK_NOTE).tasks
    const at = plan.indexOf(route.name as Task)
    assert.ok(at >= 0, `router plan for '${route.name}' does not include it: ${plan.join(', ')}`)
    assert.equal(plan[at + 1], route.feeds, `'${route.name}' feeds '${route.feeds}' but the plan says otherwise`)
  }
})

test('a route the profile cannot run over one document is published as unavailable', async () => {
  for (const route of await clinicalRouteFan()) {
    assert.equal(
      route.available === false,
      UNREVIEWABLE_TASKS.includes(route.name as Task),
      `route '${route.name}' disagrees with UNREVIEWABLE_TASKS about being runnable`,
    )
  }
})

test('the published route order is the order a multi-question plan runs in', async () => {
  const fan = (await clinicalRouteFan()).map((route) => route.name)
  // A septic-shock note raises both questions; its plan is a subsequence of the fan.
  const plan = routeClinicalShape(SEPTIC_SHOCK_NOTE).tasks
  assert.ok(plan.length > 1, `expected a multi-question plan, got: ${plan.join(', ')}`)
  const positions = plan.map((task) => fan.indexOf(task))
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `plan ${plan.join(', ')} is out of fan order`)
})

/**
 * The published shape and the run are the same statement, checked against a real run.
 *
 * This is the test the old hand-written topology could not have passed. It drew a
 * `medication-pass` node that nothing emitted and omitted the `gateway` stage both extraction
 * arms really run, and nothing failed, because the list and the emitters were unrelated text
 * in different files. Now the emitter refuses an undeclared name and this asserts the
 * converse — that everything declared for a task actually happens when that task runs.
 */
test('a real run emits exactly the stages its routes publish', async () => {
  const { PROFILE } = await import('../src/profiles/clinical/profile.ts')

  const shockExam = {
    hypotension: { systolic: 88, diastolic: 54, duration_minutes: 45 },
    heart_rate: 118,
    skin_temperature: 'warm',
    jugular_venous_pressure: 'normal_or_low',
    capillary_refill: 'brisk',
    pulse_volume: 'bounding',
    lung_exam: 'clear',
  }
  const provider = {
    async chat(o: { label: string }): Promise<string> {
      if (o.label === 'vital_signs') return FRONT_DOOR_READING
      if (o.label === 'shock-extraction') return JSON.stringify(shockExam)
      if (o.label === 'sepsis-extraction') return JSON.stringify({ respiratory_rate: 24, systolic_bp: 88, gcs: 12 })
      if (o.label === 'shock') return JSON.stringify({
        skin_temperature: 'warm',
        jugular_venous_pressure: 'normal_or_low',
        shock_category: 'septic',
        supporting_findings: [],
        discordant_findings: [],
        indeterminate_reason: null,
        assessment_confidence: 0.9,
        notes: null,
      })
      if (o.label === 'sepsis') return JSON.stringify({
        respiratory_rate: 24,
        systolic_bp: 88,
        gcs: 12,
        qsofa_score: 3,
        positive: true,
        criteria_met: ['respiratory_rate', 'systolic_bp', 'altered_mental_status'],
        screen_reason: 'all three met',
        assessment_confidence: 0.9,
        notes: null,
      })
      throw new Error(`unexpected model call ${o.label}`)
    },
  } as any

  const activity = createActivity()
  const result = await PROFILE.review!({
    pack,
    trace: { write: () => {}, close: () => {} } as any,
    input: { kind: 'text', text: SEPTIC_SHOCK_NOTE, label: 'septic-shock' },
    options: {},
    // Wrapped exactly as the server wraps it: `llm-call` is emitted by the wrapper, so an
    // unwrapped provider would be a run with no model boundary to compare against.
    provider: withActivity(provider, activity),
    activity,
  } as any)
  assert.equal(result.ok, true)

  const ran = (result.report as { routes: Task[] }).routes
  assert.deepEqual(ran, ['vital-signs', 'shock-extraction', 'shock', 'sepsis-extraction', 'sepsis'])

  const emitted = new Set(
    activity
      .recent()
      .filter((event: any) => event.kind === 'stage')
      .map((event: any) => event.name as string),
  )
  const fan = await clinicalRouteFan()

  // Everything the routes that ran declare, actually ran. `optional` stages are exempt —
  // that is what the flag means — and `route` is the decision itself, not a route's stage.
  for (const task of ran) {
    const route = fan.find((candidate) => candidate.name === task)
    assert.ok(route, `task '${task}' ran but publishes no route`)
    for (const stage of route.stages ?? []) {
      if (stage.optional) continue
      assert.ok(emitted.has(stage.name), `route '${task}' publishes '${stage.name}' but the run never emitted it`)
    }
  }

  // And nothing ran that no route declares. The profile's own top-level stages count as
  // declared — the front door and its CLI pass are published there, before the decision,
  // because they happen before a route exists to attach them to.
  const topLevel = (PROFILE.topology?.stages ?? []).map((stage) => stage.name)
  const publishable = new Set([...topLevel, ...fan.flatMap((route) => (route.stages ?? []).map((stage) => stage.name))])
  for (const name of emitted) {
    assert.ok(publishable.has(name), `the run emitted '${name}', which no route publishes`)
  }
})

test('a stage no task declares is refused at the emit site', () => {
  const stages = clinicalStages('shock', createActivity())
  assert.throws(() => stages.done('invented-stage'), /undeclared stage 'invented-stage'/)
  // The declared ones are accepted, so the refusal is about the table and not about emitting.
  assert.doesNotThrow(() => stages.done('verify', { ok: true }))
})

/**
 * What performs a stage travels with the stage, rather than being guessed from its name.
 *
 * The web graph used to keep its own list of which stage names were model calls, and that
 * list knew `medication-pass` but not `shock-classification`, `sepsis-screening` or
 * `gateway` — so three quarters of this profile's model boundaries were drawn as generic
 * orchestration. Both halves are asserted: the published shape says, and a real run says the
 * same thing for every stage it emits.
 */
test('every published stage says what performs it', async () => {
  for (const route of await clinicalRouteFan()) {
    for (const stage of route.stages ?? []) {
      assert.ok(stage.operation, `route '${route.name}' publishes '${stage.name}' without an operation`)
    }
  }
})

test('a real run stamps each stage with the operation its route published', async () => {
  const { PROFILE } = await import('../src/profiles/clinical/profile.ts')
  const provider = {
    async chat(o: { label: string }): Promise<string> {
      if (o.label === 'shock-extraction') return JSON.stringify({
        hypotension: { systolic: 88, diastolic: 54, duration_minutes: 45 },
        heart_rate: 118,
        skin_temperature: 'warm',
        jugular_venous_pressure: 'normal_or_low',
        capillary_refill: 'brisk',
        pulse_volume: 'bounding',
        lung_exam: 'clear',
      })
      return JSON.stringify({
        skin_temperature: 'warm',
        jugular_venous_pressure: 'normal_or_low',
        shock_category: 'septic',
        supporting_findings: [],
        discordant_findings: [],
        indeterminate_reason: null,
        assessment_confidence: 0.9,
        notes: null,
      })
    },
  } as any

  const activity = createActivity()
  await PROFILE.review!({
    pack,
    trace: { write: () => {}, close: () => {} } as any,
    input: {
      kind: 'text',
      text: 'Patient hypotensive with cool mottled extremities and delayed capillary refill after major haemorrhage.',
      label: 'shock',
    },
    options: {},
    provider: withActivity(provider, activity),
    activity,
  } as any)

  const published = new Map<string, string>()
  for (const route of await clinicalRouteFan()) {
    for (const stage of route.stages ?? []) if (stage.operation) published.set(stage.name, stage.operation)
  }

  const stages = activity.recent().filter((event: any) => event.kind === 'stage') as any[]
  assert.ok(stages.length > 0, 'the run emitted no stages at all')
  for (const stage of stages) {
    assert.ok(stage.operation, `the run emitted '${stage.name}' without saying what performs it`)
    const declared = published.get(stage.name)
    if (declared) {
      assert.equal(stage.operation, declared, `'${stage.name}' ran as ${stage.operation} but publishes ${declared}`)
    }
  }

  // The boundaries this profile's own passes own, which the web's name table never knew.
  const byName = new Map(stages.map((stage) => [stage.name as string, stage.operation as string]))
  assert.equal(byName.get('shock-extraction'), 'model')
  assert.equal(byName.get('shock-classification'), 'model')
  assert.equal(byName.get('gateway'), 'code')
  assert.equal(byName.get('verify'), 'code')
})
