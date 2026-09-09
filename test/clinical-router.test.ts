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
import { type ClinicalShape, DEFAULT_TASK_FOR_SHAPE, type Task } from '../src/profiles/clinical/contracts.ts'
import { loadPack } from '../src/core/pack.ts'
import { createActivity } from '../src/core/activity.ts'

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

// --- taskForShape --------------------------------------------------------------------------

const allShapes: ClinicalShape[] = ['exam-json', 'shock-suspicion', 'dialogue', 'dictation', 'vitals-note', 'note', 'summary-input']

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
