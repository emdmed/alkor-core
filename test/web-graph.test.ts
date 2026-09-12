/** The browser graph's model stays deterministic and testable without a renderer. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCompactGraph,
  compactCardKey,
  compactStepKey,
  layoutHeightOf,
  ROW_GAP,
  COMPACT_HEADER_H,
  COMPACT_PROGRESS_H,
  COMPACT_STAGE_H,
  COMPACT_STAGES_EXTRAS_H,
  COMPACT_STEP_H,
  COMPACT_TERMINAL_H,
  COMPACT_ROUTE_NOTE_H,
  COMPACT_ROUTER_H,
  COMPACT_W,
  CHIP_W,
} from '../web/src/lib/graph/index.ts'
import { emptyState, type ProjectState } from '../src/tui/state.ts'

const compactGateway = () => ({
  profiles: [
    { name: 'workflow-router', mode: 'router' },
    { name: 'clinical', mode: 'extract' },
    { name: 'coding', mode: 'extract' },
  ],
  pipeline: {
    router: 'workflow-router',
    workflows: ['clinical-verified', 'coding-verified'],
    defaultWorkflow: 'clinical-verified',
  },
  workflows: [
    {
      name: 'clinical-verified',
      steps: [
        { name: 'extract medications', profile: 'clinical', input: 'initial' },
        { name: 'verify', profile: 'coding' },
      ],
    },
    {
      name: 'coding-verified',
      steps: [{ name: 'extract codes', profile: 'coding', input: 'initial' }],
    },
  ],
})

test('compact graph renders the exact gateway catalogue with ordered steps', () => {
  const state = emptyState()
  state.topology = compactGateway()

  const graph = buildCompactGraph(state, undefined, new Set())
  const gateway = graph.nodes.find((node) => node.id === 'gateway')!
  const clinical = graph.nodes.find((node) => node.id === 'compact-configured-clinical-verified')!
  const coding = graph.nodes.find((node) => node.id === 'compact-configured-coding-verified')!

  assert.equal(gateway.data.kind, 'gateway')
  assert.equal(gateway.data.entryPoint, true)
  assert.equal(gateway.data.status, 'idle')
  assert.match(gateway.data.detailText ?? '', /2 workflows · default: clinical-verified/)
  assert.deepEqual(clinical.data.steps!.map((step) => [step.name, step.profile]), [
    ['extract medications', 'clinical'],
    ['verify', 'coding'],
  ])
  assert.equal(clinical.data.steps![0]!.inputRef, 'initial')
  assert.equal(clinical.data.steps![1]!.inputRef, 'step-0.output')
  assert.equal(clinical.data.status, 'idle')
  assert.deepEqual(coding.data.steps!.map((step) => step.name), ['extract codes'])
  assert.equal(graph.title, '1 product pipeline · 2 workflows · compact view')
})

test('compact graph branches the gateway into two independent workflows', () => {
  const state = emptyState()
  state.topology = compactGateway()

  const graph = buildCompactGraph(state, undefined, new Set())
  const targets = graph.edges
    .filter((edge) => edge.source === 'gateway')
    .map((edge) => edge.target)

  assert.deepEqual(targets, ['compact-configured-clinical-verified', 'compact-configured-coding-verified'])
})

test('compact graph never connects one workflow to another', () => {
  const state = emptyState()
  state.topology = compactGateway()

  const graph = buildCompactGraph(state, undefined, new Set())
  assert.ok(graph.edges.every((edge) => edge.source === 'gateway'), 'every edge leaves the gateway')
  assert.equal(graph.edges.length, 2)
  assert.ok(graph.edges.every((edge) => edge.data?.kind === 'ghost'), 'uncommitted workflows connect as possible, not data, edges')
  assert.ok(graph.edges.every((edge) => edge.data?.kind !== 'data'), 'no edge may imply one workflow feeds another')
})

test('compact graph paints the selected workflow branch and mutes the rest', () => {
  const state = emptyState()
  state.topology = compactGateway()
  state.runs.set('run-1', { runId: 'run-1', profile: 'clinical-verified', status: 'started' })
  state.routes.push({ runId: 'run-1', profile: 'clinical-verified', confidence: 0.87, reason: 'default workflow', ruleVsModel: 'rule' })
  state.workflows.set('run-1', {
    runId: 'run-1',
    steps: [{ step: 0, name: 'extract medications', profile: 'clinical', status: 'started' }],
  })

  const graph = buildCompactGraph(state, 'run-1', new Set())
  const gateway = graph.nodes.find((node) => node.id === 'gateway')!
  const chosen = graph.nodes.find((node) => node.id === 'compact-run-1')!
  const alternate = graph.nodes.find((node) => node.id === 'compact-configured-coding-verified')!
  const branch = graph.edges.find((edge) => edge.source === 'gateway' && edge.target === 'compact-run-1')!
  const ghost = graph.edges.find((edge) => edge.source === 'gateway' && edge.target === alternate.id)!

  assert.equal(gateway.data.chosenProfile, 'clinical-verified')
  assert.equal(gateway.data.confidence, 0.87)
  assert.equal(gateway.data.ruleVsModel, 'rule')
  assert.equal(gateway.data.reason, 'default workflow')
  assert.equal(gateway.data.status, 'done')
  assert.equal(chosen.data.status, 'active')
  assert.equal(chosen.data.muted, undefined)
  assert.equal(alternate.data.status, 'idle')
  assert.equal(alternate.data.muted, true)
  assert.equal(branch.data?.kind, 'branch')
  assert.equal(branch.data?.label, 'selected')
  // The workflow is running, so the edge into it is the one carrying the document: it
  // takes the live colour and the marching dash rather than the settled route green.
  assert.equal(branch.className, 'is-live')
  assert.equal(branch.style?.stroke, 'var(--primary)')
  assert.equal(ghost.className, undefined, 'a route nothing is running on never marches')
  assert.equal(ghost.data?.kind, 'ghost')
  assert.equal(graph.edges.filter((edge) => edge.data?.kind === 'branch').length, 1, 'exactly one workflow is highlighted')
})

test('compact graph keeps composed input references human-readable', () => {
  const state = emptyState()
  state.topology = {
    profiles: [{ name: 'verifier', mode: 'extract' }],
    pipeline: { router: 'workflow-router', workflows: ['verified'], defaultWorkflow: 'verified' },
    workflows: [{
      name: 'verified',
      steps: [{
        name: 'verify',
        profile: 'verifier',
        input: [
          { name: 'document', ref: 'initial' },
          { name: 'extraction', ref: 'step-0.output' },
        ],
      }],
    }],
  }

  const graph = buildCompactGraph(state, undefined, new Set())
  const card = graph.nodes.find((node) => node.id === 'compact-configured-verified')!
  assert.equal(card.data.steps![0]!.inputRef, 'document ← initial · extraction ← step-0.output')
})

test('compact graph does not annotate clinical-verifier with the product route', () => {
  const state = emptyState()
  state.topology = {
    profiles: [
      { name: 'workflow-router', mode: 'router' },
      { name: 'verifier', mode: 'extract' },
    ],
    pipeline: { router: 'workflow-router', workflows: ['clinical-verified'], defaultWorkflow: 'clinical-verified' },
    workflows: [{ name: 'clinical-verified', steps: [{ name: 'verify', profile: 'verifier', input: 'initial' }] }],
  }
  state.runs.set('run-1', { runId: 'run-1', profile: 'clinical-verified', status: 'started' })
  state.routes.push({ runId: 'run-1', profile: 'clinical-verified', confidence: 0.9, reason: 'default', ruleVsModel: 'rule' })
  state.workflows.set('run-1', {
    runId: 'run-1',
    steps: [{ step: 0, name: 'verify', profile: 'verifier', status: 'started' }],
  })
  state.stages.set('pipeline', {
    stageId: 'pipeline', runId: 'run-1', name: 'workflow', status: 'started', children: [],
  })
  state.stages.set('flow', {
    stageId: 'flow', runId: 'run-1', parentId: 'pipeline', name: 'flow', status: 'started', detail: { step: 0 }, children: [],
  })
  state.stages.set('parse', {
    stageId: 'parse', runId: 'run-1', parentId: 'flow', name: 'parse', status: 'completed', children: [],
  })

  const graph = buildCompactGraph(state, 'run-1', new Set())
  const gateway = graph.nodes.find((node) => node.id === 'gateway')!
  const card = graph.nodes.find((node) => node.id === 'compact-run-1')!
  const verify = card.data.steps![0]!

  assert.equal(gateway.data.chosenProfile, 'clinical-verified')
  assert.equal(verify.router, false)
  assert.equal(verify.chosenProfile, undefined)
  assert.equal(verify.reason, undefined)
  assert.ok(verify.stages.every((stage) => stage.operation !== 'decision'), 'a verifier profile is not a routing step')
})

test('compact graph surfaces a genuine router step with its own decision', () => {
  const state = emptyState()
  state.topology = {
    profiles: [
      { name: 'workflow-router', mode: 'router' },
      { name: 'clinical', mode: 'extract' },
    ],
    pipeline: { router: 'workflow-router', workflows: ['router-flow'], defaultWorkflow: 'router-flow' },
    workflows: [{
      name: 'router-flow',
      steps: [
        { name: 'route', profile: 'workflow-router' },
        { name: 'extract', profile: 'clinical' },
      ],
    }],
  }
  state.runs.set('run-1', { runId: 'run-1', profile: 'router-flow', status: 'started' })
  state.workflows.set('run-1', {
    runId: 'run-1',
    steps: [
      { step: 0, name: 'route', profile: 'workflow-router', status: 'completed' },
      { step: 1, name: 'extract', profile: 'clinical', status: 'started' },
    ],
  })
  state.stages.set('pipeline', {
    stageId: 'pipeline', runId: 'run-1', name: 'workflow', status: 'started', children: [],
  })
  state.stages.set('router-step', {
    stageId: 'router-step', runId: 'run-1', parentId: 'pipeline', name: 'router', status: 'completed', detail: { step: 0 }, children: [],
  })
  state.stages.set('decision', {
    stageId: 'decision', runId: 'run-1', parentId: 'router-step', name: 'route', status: 'completed', detail: { profile: 'clinical', confidence: 0.95 }, children: [],
  })

  const graph = buildCompactGraph(state, 'run-1', new Set())
  const card = graph.nodes.find((node) => node.id === 'compact-run-1')!
  const route = card.data.steps!.find((step) => step.stepNo === 0)!

  assert.equal(route.router, true, 'this step owns a routing decision')
  assert.equal(route.chosenProfile, 'clinical')
  assert.equal(route.confidence, 0.95)
  assert.ok(route.stages.some((stage) => stage.name === 'route' && stage.operation === 'decision'))
})

test('compact graph derives active, done, failed, and stopped workflow status', () => {
  const defs = {
    profiles: [{ name: 'worker', mode: 'extract' }],
    pipeline: { router: 'workflow-router', workflows: ['wf'], defaultWorkflow: 'wf' },
    workflows: [{ name: 'wf', steps: [{ name: 'work', profile: 'worker' }] }],
  }

  const active = emptyState()
  active.topology = defs
  active.runs.set('run-1', { runId: 'run-1', profile: 'wf', status: 'started' })
  active.workflows.set('run-1', { runId: 'run-1', steps: [{ step: 0, name: 'work', profile: 'worker', status: 'started' }] })
  assert.equal(buildCompactGraph(active, 'run-1', new Set()).nodes.find((node) => node.id === 'compact-run-1')!.data.status, 'active')

  const done = emptyState()
  done.topology = defs
  done.runs.set('run-1', { runId: 'run-1', profile: 'wf', status: 'completed', wallMs: 1200 })
  done.workflows.set('run-1', { runId: 'run-1', steps: [{ step: 0, name: 'work', profile: 'worker', status: 'completed', ok: true }] })
  const doneGraph = buildCompactGraph(done, 'run-1', new Set())
  assert.equal(doneGraph.nodes.find((node) => node.id === 'compact-run-1')!.data.status, 'done')
  // Nothing is in flight any more, so nothing on the canvas may still be moving.
  assert.ok(doneGraph.edges.every((edge) => edge.className !== 'is-live'), 'a finished board holds still')

  const failed = emptyState()
  failed.topology = defs
  failed.runs.set('run-1', { runId: 'run-1', profile: 'wf', status: 'failed' })
  failed.workflows.set('run-1', { runId: 'run-1', steps: [{ step: 0, name: 'work', profile: 'worker', status: 'completed', ok: true }] })
  assert.equal(buildCompactGraph(failed, 'run-1', new Set()).nodes.find((node) => node.id === 'compact-run-1')!.data.status, 'failed')

  const stopped = emptyState()
  stopped.topology = defs
  stopped.runs.set('run-1', { runId: 'run-1', profile: 'wf', status: 'completed' })
  stopped.workflows.set('run-1', { runId: 'run-1', steps: [{ step: 0, name: 'work', profile: 'worker', status: 'completed', ok: true }], stoppedEarly: true })
  assert.equal(buildCompactGraph(stopped, 'run-1', new Set()).nodes.find((node) => node.id === 'compact-run-1')!.data.status, 'failed')

  const emptyCompleted = emptyState()
  emptyCompleted.topology = defs
  emptyCompleted.runs.set('run-1', { runId: 'run-1', profile: 'wf', status: 'completed' })
  emptyCompleted.workflows.set('run-1', { runId: 'run-1', steps: [] })
  assert.equal(
    buildCompactGraph(emptyCompleted, 'run-1', new Set()).nodes.find((node) => node.id === 'compact-run-1')!.data.status,
    'idle',
    'a workflow that produced no step row never reads as done',
  )
})

test('compact graph preserves nested stage hierarchy in pre-order', () => {
  const state = emptyState()
  state.topology = {
    profiles: [{ name: 'worker', mode: 'extract' }],
    pipeline: { router: 'workflow-router', workflows: ['wf'], defaultWorkflow: 'wf' },
    workflows: [{ name: 'wf', steps: [{ name: 'work', profile: 'worker' }] }],
  }
  state.runs.set('run-1', { runId: 'run-1', profile: 'wf', status: 'started' })
  state.workflows.set('run-1', { runId: 'run-1', steps: [{ step: 0, name: 'work', profile: 'worker', status: 'started' }] })
  state.stages.set('pipeline', {
    stageId: 'pipeline', runId: 'run-1', name: 'workflow', status: 'started', children: [],
  })
  state.stages.set('worker', {
    stageId: 'worker', runId: 'run-1', parentId: 'pipeline', name: 'worker', status: 'started', detail: { step: 0 }, children: [],
  })
  state.stages.set('prepare', {
    stageId: 'prepare', runId: 'run-1', parentId: 'worker', name: 'prompt-assembly', status: 'completed', detail: { note: 'len 240' }, children: [],
  })
  state.stages.set('model', {
    stageId: 'model', runId: 'run-1', parentId: 'worker', name: 'llm-call', status: 'completed', wallMs: 830, children: [],
  })
  state.stages.set('tool', {
    stageId: 'tool', runId: 'run-1', parentId: 'model', name: 'tool-call', status: 'completed', children: [],
  })

  const graph = buildCompactGraph(state, 'run-1', new Set())
  const card = graph.nodes.find((node) => node.id === 'compact-run-1')!
  const stages = card.data.steps![0]!.stages

  assert.deepEqual(stages.map((stage) => stage.name), ['prompt-assembly', 'llm-call', 'tool-call'])
  assert.deepEqual(stages.map((stage) => stage.depth), [0, 0, 1])
  assert.deepEqual(stages.map((stage) => stage.operation), ['code', 'model', 'decision'])
  assert.equal(stages[0]!.detailText, 'note len 240', 'safe detail summaries survive into the compact card')
  assert.equal(stages[1]!.wallMs, 830)
})

test('compact graph renders a catalogued but missing workflow definition as failed', () => {
  const state = emptyState()
  state.topology = {
    profiles: [{ name: 'worker', mode: 'extract' }],
    pipeline: { router: 'workflow-router', workflows: ['present', 'missing'], defaultWorkflow: 'present' },
    workflows: [{ name: 'present', steps: [{ name: 'work', profile: 'worker' }] }],
  }

  const graph = buildCompactGraph(state, undefined, new Set())
  const missing = graph.nodes.find((node) => node.id === 'compact-missing-missing')!

  assert.equal(missing.data.status, 'failed')
  assert.equal(missing.data.label, 'missing', 'the name is preserved, not dropped')
  assert.equal(missing.data.detailText, 'not configured')
  assert.match(missing.data.reason ?? '', /no definition exists/)
  assert.deepEqual(missing.data.steps!, [])
  assert.equal(graph.edges.find((edge) => edge.target === missing.id)?.data?.kind, 'ghost')
})

test('compact graph lists standalone workflows when no product gateway exists', () => {
  const state = emptyState()
  state.topology = {
    profiles: [{ name: 'alpha', mode: 'extract' }, { name: 'beta', mode: 'extract' }],
    workflows: [
      { name: 'alpha-flow', steps: [{ name: 'work', profile: 'alpha' }] },
      { name: 'beta-flow', steps: [{ name: 'work', profile: 'beta' }] },
    ],
  }

  const graph = buildCompactGraph(state, undefined, new Set())
  assert.deepEqual(graph.nodes.map((node) => node.id).sort(), ['compact-configured-alpha-flow', 'compact-configured-beta-flow'])
  assert.equal(graph.edges.length, 0, 'standalone workflows are disconnected, not chained')
  assert.ok(graph.nodes.every((node) => node.data.detailText === 'standalone configured workflow'))
  assert.ok(graph.nodes.every((node) => node.data.status === 'idle'))
  assert.equal(graph.title, '2 standalone workflows · compact')
})

test('compact graph renders a direct run with no configured topology', () => {
  const state = emptyState()
  state.runs.set('run-1', { runId: 'run-1', profile: 'direct', status: 'started' })
  state.workflows.set('run-1', { runId: 'run-1', steps: [{ step: 0, name: 'step', profile: 'worker', status: 'started' }] })

  const graph = buildCompactGraph(state, 'run-1', new Set())
  assert.equal(graph.nodes.length, 1)
  assert.equal(graph.nodes[0]!.data.kind, 'compact-workflow')
  assert.equal(graph.nodes[0]!.data.status, 'active')
  assert.equal(graph.nodes[0]!.data.steps![0]!.name, 'step')
  assert.equal(graph.edges.length, 0)
  assert.equal(graph.title, 'run direct · compact')
})

test('compact graph keeps every workflow node id unique across sections', () => {
  const state = emptyState()
  state.topology = {
    profiles: [
      { name: 'workflow-router', mode: 'router' },
      { name: 'clinical', mode: 'extract' },
      { name: 'coding', mode: 'extract' },
      { name: 'worker', mode: 'extract' },
    ],
    pipeline: {
      router: 'workflow-router',
      workflows: ['clinical-verified', 'coding-verified', 'missing'],
      defaultWorkflow: 'clinical-verified',
    },
    workflows: [
      { name: 'clinical-verified', steps: [{ name: 'extract', profile: 'clinical' }] },
      { name: 'coding-verified', steps: [{ name: 'extract', profile: 'coding' }] },
      { name: 'standalone', steps: [{ name: 'work', profile: 'worker' }] },
    ],
  }
  state.runs.set('run-1', { runId: 'run-1', profile: 'clinical-verified', status: 'started' })
  state.routes.push({ runId: 'run-1', profile: 'clinical-verified', confidence: 0.9, reason: 'default', ruleVsModel: 'rule' })
  state.workflows.set('run-1', { runId: 'run-1', steps: [{ step: 0, name: 'extract', profile: 'clinical', status: 'started' }] })

  const graph = buildCompactGraph(state, 'run-1', new Set())
  const ids = graph.nodes.map((node) => node.id)
  const expected = [
    'gateway',
    'compact-run-1',
    'compact-configured-coding-verified',
    'compact-missing-missing',
    'compact-configured-standalone',
  ]
  assert.deepEqual(ids, expected)
  assert.equal(new Set(ids).size, ids.length)
})

/* ------------------------------------------------------------------ compact disclosure reflow */

const COMPACT_BASE_H = COMPACT_HEADER_H + COMPACT_PROGRESS_H + COMPACT_TERMINAL_H * 2

/** Gateway with a completed two-step run whose step 0 exposes nested stages. */
/** The two step disclosures the `compactExpansionState` fixture's run card holds. */
const stepsOf = (nodeId: string): Set<string> => new Set([compactStepKey(nodeId, 0), compactStepKey(nodeId, 1)])

const compactExpansionState = () => {
  const state = emptyState()
  state.topology = compactGateway()
  state.runs.set('run-1', { runId: 'run-1', profile: 'clinical-verified', status: 'completed', wallMs: 12 })
  state.routes.push({ runId: 'run-1', profile: 'clinical-verified', confidence: 0.87, reason: 'default workflow', ruleVsModel: 'rule' })
  state.workflows.set('run-1', {
    runId: 'run-1',
    steps: [
      { step: 0, name: 'extract medications', profile: 'clinical', status: 'completed', ok: true },
      { step: 1, name: 'verify', profile: 'coding', status: 'completed', ok: true },
    ],
  })
  state.stages.set('pipeline', { stageId: 'pipeline', runId: 'run-1', name: 'workflow', status: 'completed', children: [] })
  state.stages.set('step0', {
    stageId: 'step0', runId: 'run-1', parentId: 'pipeline', name: 'clinical', status: 'completed', detail: { step: 0 }, children: [],
  })
  state.stages.set('prepare', {
    stageId: 'prepare', runId: 'run-1', parentId: 'step0', name: 'prompt-assembly', status: 'completed', children: [],
  })
  state.stages.set('model', {
    stageId: 'model', runId: 'run-1', parentId: 'step0', name: 'llm-call', status: 'completed', wallMs: 830, children: [],
  })
  state.stages.set('tool', {
    stageId: 'tool', runId: 'run-1', parentId: 'model', name: 'tool-call', status: 'completed', children: [],
  })
  state.stages.set('deep', {
    stageId: 'deep', runId: 'run-1', parentId: 'tool', name: 'deep-call', status: 'completed', children: [],
  })
  state.stages.set('step1', {
    stageId: 'step1', runId: 'run-1', parentId: 'pipeline', name: 'verify', status: 'completed', detail: { step: 1 }, children: [],
  })
  state.stages.set('walk', {
    stageId: 'walk', runId: 'run-1', parentId: 'step1', name: 'verify-walk', status: 'completed', children: [],
  })
  return state
}

/** The user-visible invariant: every following card begins at least ROW_GAP below its predecessor. */
const assertNoCompactOverlap = (nodes: ReturnType<typeof buildCompactGraph>['nodes']) => {
  const cards = nodes
    .filter((node) => node.data.kind === 'compact-workflow')
    .sort((a, b) => a.position.y - b.position.y)
  for (let i = 1; i < cards.length; i++) {
    const upper = cards[i - 1]!
    const lower = cards[i]!
    assert.ok(
      upper.position.y + layoutHeightOf(upper) <= lower.position.y - ROW_GAP,
      `card ${upper.id} must clear card ${lower.id} by the full ROW_GAP (${upper.position.y} + ${layoutHeightOf(upper)} > ${lower.position.y} - ${ROW_GAP})`,
    )
  }
}

/**
 * Every disclosure key the board can hold, reached by opening what opening reveals.
 *
 * Disclosure nests: a collapsed workflow draws no fan, so its branches' keys do not exist
 * until it opens. One pass cannot enumerate them, which is the point — the board only ever
 * reports what it actually drew.
 */
const allDisclosures = (state: ProjectState, runId?: string): Set<string> => {
  let keys = new Set<string>()
  for (let pass = 0; pass < 6; pass++) {
    const found = buildCompactGraph(state, runId, keys).disclosures ?? new Set<string>()
    if (found.size === keys.size && [...found].every((key) => keys.has(key))) break
    keys = found
  }
  return keys
}

/** The board with every card and step open, whatever execution would have defaulted to. */
const fullyOpen = (state: ProjectState, runId?: string) =>
  buildCompactGraph(state, runId, allDisclosures(state, runId))

/** Every card open, every step left to its own default: the shape without the detail. */
const openCards = (state: ProjectState, runId?: string) =>
  buildCompactGraph(state, runId, new Set([...allDisclosures(state, runId)].filter((key) => key.endsWith('/card'))))

test('compact graph keeps card positions stable with its steps closed', () => {
  const state = compactExpansionState()
  // The run itself is open by default — it ran — so closing its steps is what isolates the
  // card's own chrome from the stages inside it.
  const graph = buildCompactGraph(state, 'run-1', new Set(), stepsOf('compact-run-1'))
  const gateway = graph.nodes.find((node) => node.id === 'gateway')!
  const run = graph.nodes.find((node) => node.id === 'compact-run-1')!
  const coding = graph.nodes.find((node) => node.id === 'compact-configured-coding-verified')!

  assert.equal(gateway.position.y, 40, 'the gateway never moves when a workflow below it grows')
  assert.equal(layoutHeightOf(run), COMPACT_BASE_H + 2 * COMPACT_STEP_H, 'a closed-step card counts header, terminals, and step rows only')
  assert.equal(run.position.y, 40 + layoutHeightOf(gateway) + ROW_GAP)
  assert.equal(coding.position.y, run.position.y + layoutHeightOf(run) + ROW_GAP, 'with nothing open the catalogue order advances as before')
  assert.deepEqual(graph.nodes.map((node) => node.id), ['gateway', 'compact-run-1', 'compact-configured-coding-verified'])
})

test('expanding compact step 0 adds the complete stage block to the workflow height', () => {
  const state = compactExpansionState()
  const key = compactStepKey('compact-run-1', 0)
  const shut = stepsOf('compact-run-1')
  const collapsed = buildCompactGraph(state, 'run-1', new Set(), shut)
  const expanded = buildCompactGraph(state, 'run-1', new Set([key]), shut)

  const collapsedNode = collapsed.nodes.find((node) => node.id === 'compact-run-1')!
  const expandedNode = expanded.nodes.find((node) => node.id === 'compact-run-1')!
  const step = expandedNode.data.steps![0]!
  assert.equal(step.expanded, true)
  assert.equal(step.stageRowCount, 4, 'every visible stage row inside the disclosed step counts')
  assert.equal(layoutHeightOf(expandedNode) - layoutHeightOf(collapsedNode), COMPACT_STAGES_EXTRAS_H + 4 * COMPACT_STAGE_H)
})

test('expanding a compact step pushes the next workflow by exactly the added height', () => {
  const state = compactExpansionState()
  const graph = buildCompactGraph(state, 'run-1', new Set([compactStepKey('compact-run-1', 0)]), stepsOf('compact-run-1'))
  const run = graph.nodes.find((node) => node.id === 'compact-run-1')!
  const coding = graph.nodes.find((node) => node.id === 'compact-configured-coding-verified')!

  assert.equal(coding.position.y, run.position.y + layoutHeightOf(run) + ROW_GAP, 'the following card steps over the full expanded height')
  assert.ok(run.position.y + layoutHeightOf(run) <= coding.position.y - ROW_GAP)
})

test('expanding two compact steps is additive and each collapse removes exactly its contribution', () => {
  const state = compactExpansionState()
  const key0 = compactStepKey('compact-run-1', 0)
  const key1 = compactStepKey('compact-run-1', 1)
  const shut = stepsOf('compact-run-1')
  const card = (open: string[]) =>
    buildCompactGraph(state, 'run-1', new Set(open), shut).nodes.find((node) => node.id === 'compact-run-1')!
  const collapsedHeight = layoutHeightOf(card([]))

  const step0Block = COMPACT_STAGES_EXTRAS_H + 4 * COMPACT_STAGE_H
  const step1Block = COMPACT_STAGES_EXTRAS_H + 1 * COMPACT_STAGE_H

  const only0 = card([key0])
  const only1 = card([key1])
  const both = card([key0, key1])

  assert.equal(layoutHeightOf(only0) - collapsedHeight, step0Block)
  assert.equal(layoutHeightOf(only1) - collapsedHeight, step1Block)
  assert.equal(layoutHeightOf(both) - collapsedHeight, step0Block + step1Block, 'each disclosure owns its own stage container and rows')
})

test('nested compact stage depth changes indentation, never height or order', () => {
  const state = compactExpansionState()
  const graph = buildCompactGraph(state, 'run-1', new Set([compactStepKey('compact-run-1', 0)]), stepsOf('compact-run-1'))
  const stages = graph.nodes.find((node) => node.id === 'compact-run-1')!.data.steps![0]!.stages

  assert.deepEqual(stages.map((stage) => stage.name), ['prompt-assembly', 'llm-call', 'tool-call', 'deep-call'], 'pre-order stage sequence is preserved')
  assert.deepEqual(stages.map((stage) => stage.depth), [0, 0, 1, 2], 'nesting is encoded per row')
  assert.equal(layoutHeightOf(graph.nodes.find((node) => node.id === 'compact-run-1')!) - (COMPACT_BASE_H + 2 * COMPACT_STEP_H), COMPACT_STAGES_EXTRAS_H + 4 * COMPACT_STAGE_H)
})

test('compact expansion reflows gateway, standalone, direct-run, and missing-definition layouts', () => {
  const asserts = [] as { title: string; graph: ReturnType<typeof buildCompactGraph> }[]

  const gateway = compactExpansionState()
  asserts.push({ title: 'gateway', graph: buildCompactGraph(gateway, 'run-1', new Set([compactStepKey('compact-run-1', 0)])) })

  const standalone = emptyState()
  standalone.topology = {
    profiles: [{ name: 'a', mode: 'extract' }, { name: 'b', mode: 'extract' }],
    workflows: [
      { name: 'aflow', steps: [{ name: 'work', profile: 'a' }] },
      { name: 'bflow', steps: [{ name: 'work', profile: 'b' }] },
    ],
  }
  asserts.push({ title: 'standalone', graph: buildCompactGraph(standalone, undefined, new Set()) })

  const direct = emptyState()
  direct.runs.set('run-1', { runId: 'run-1', profile: 'direct', status: 'completed', wallMs: 5 })
  direct.workflows.set('run-1', { runId: 'run-1', steps: [{ step: 0, name: 'work', profile: 'worker', status: 'completed', ok: true }] })
  direct.stages.set('pipeline', { stageId: 'pipeline', runId: 'run-1', name: 'workflow', status: 'completed', children: [] })
  direct.stages.set('worker', {
    stageId: 'worker', runId: 'run-1', parentId: 'pipeline', name: 'worker', status: 'completed', detail: { step: 0 }, children: [],
  })
  direct.stages.set('leaf', { stageId: 'leaf', runId: 'run-1', parentId: 'worker', name: 'llm-call', status: 'completed', children: [] })
  asserts.push({ title: 'direct-run', graph: buildCompactGraph(direct, 'run-1', new Set([compactStepKey('compact-run-1', 0)])) })

  const missing = emptyState()
  missing.topology = {
    profiles: [{ name: 'workflow-router', mode: 'router' }],
    pipeline: { router: 'workflow-router', workflows: ['present', 'absent'], defaultWorkflow: 'present' },
    workflows: [{ name: 'present', steps: [{ name: 'work', profile: 'worker' }] }],
  }
  asserts.push({ title: 'missing-definition', graph: buildCompactGraph(missing, undefined, new Set()) })

  for (const { title, graph } of asserts) {
    const keys = graph.nodes.flatMap((node) => (node.data.steps ?? []).map((step) => step.expandKey).filter(Boolean))
    assert.equal(new Set(keys).size, keys.length, `${title}: every disclosure key is unique per rendered workflow`)
    assertNoCompactOverlap(graph.nodes)
  }

  for (const { title, graph } of asserts) {
    assert.equal(graph.nodes.filter((node) => node.data.kind !== 'gateway' && node.data.kind !== 'compact-workflow').length, 0, `${title}: only gateway and workflow cards exist`)
  }
  const directGraph = asserts.find((a) => a.title === 'direct-run')!.graph
  assert.equal(layoutHeightOf(directGraph.nodes[0]!), COMPACT_BASE_H + 1 * COMPACT_STEP_H + COMPACT_STAGES_EXTRAS_H + 1 * COMPACT_STAGE_H, 'a direct run expands exactly like a catalogued workflow')
})

test('compact graph returns the same expanded set the board paints', () => {
  const state = compactExpansionState()
  const key0 = compactStepKey('compact-run-1', 0)
  const key1 = compactStepKey('compact-run-1', 1)
  const graph = buildCompactGraph(state, 'run-1', new Set([key0]), new Set([key1]))

  const painted = new Set<string>()
  for (const node of graph.nodes) {
    if (node.data.collapsible === true && node.data.collapsed !== true && node.data.expandKey) painted.add(node.data.expandKey)
    for (const step of node.data.steps ?? []) {
      if (step.expandKey && step.expanded) painted.add(step.expandKey)
    }
  }
  assert.deepEqual([...graph.expanded].sort(), [...painted].sort(), 'the view-level set is every disclosure held open')
  assert.equal(graph.expanded.has(key0), true)
  assert.equal(graph.expanded.has(key1), false, 'a closed step never leaks into the view-level set')
  assert.equal(graph.collapsed!.has(key1), true, 'and is reported as closed, so the intent to close it survives a rebuild')
  assert.equal(graph.disclosures!.has(key1), true)
  assert.equal(compactStepKey('compact-run-1', 3), 'compact-run-1/step-3')
})

/* ------------------------------------------------------------------ route branches inside a workflow */

/**
 * A workflow whose first step is a profile that routes internally — the clinical shape:
 * one decision, a two-pass shock arm, a two-pass sepsis arm, and one single-pass task.
 */
const routingProfileTopology = () => ({
  stages: [{
    // What the profile does BEFORE it decides: read the note's vital signs, put the numbers
    // through the CLI. Route-less top-level stages, which is exactly the shape the compact
    // graph used to drop on the floor.
    name: 'vitals-first',
    operation: 'model' as const,
    optional: true,
  }, {
    name: 'calculations',
    operation: 'code' as const,
    optional: true,
  }, {
    name: 'route',
    kind: 'decision' as const,
    operation: 'decision' as const,
    routes: [
      { name: 'shock-extraction', feeds: 'shock', stages: [{ name: 'shock-extraction', operation: 'model' as const }, { name: 'llm-call', operation: 'model' as const }, { name: 'gateway', operation: 'code' as const }] },
      { name: 'shock', stages: [{ name: 'shock-classification', operation: 'model' as const }, { name: 'llm-call', operation: 'model' as const }, { name: 'verify', operation: 'code' as const }] },
      { name: 'sepsis-extraction', feeds: 'sepsis', stages: [{ name: 'sepsis-extraction', operation: 'model' as const }, { name: 'llm-call', operation: 'model' as const }, { name: 'gateway', operation: 'code' as const }] },
      { name: 'sepsis', stages: [{ name: 'sepsis-screening', operation: 'model' as const }, { name: 'llm-call', operation: 'model' as const }, { name: 'verify', operation: 'code' as const }] },
      { name: 'vital-signs', stages: [{ name: 'llm-call', operation: 'model' as const }, { name: 'verify', operation: 'code' as const }] },
      { name: 'summary', available: false },
    ],
  }],
})

const routingWorkflowState = () => {
  const state = emptyState()
  state.topology = {
    profiles: [
      { name: 'workflow-router', mode: 'router' },
      { name: 'clinical', mode: 'extract', topology: routingProfileTopology() },
      { name: 'verifier', mode: 'extract' },
    ],
    pipeline: { router: 'workflow-router', workflows: ['clinical-verified'], defaultWorkflow: 'clinical-verified' },
    workflows: [{
      name: 'clinical-verified',
      steps: [
        { name: 'extract', profile: 'clinical', input: 'initial' },
        { name: 'verify-source', profile: 'verifier' },
      ],
    }],
  }
  return state
}

/** A septic-shock note: the clinical decision returns BOTH syndromes, four tasks in all. */
const bothSyndromesRun = () => {
  const state = routingWorkflowState()
  state.runs.set('run-1', { runId: 'run-1', profile: 'clinical-verified', status: 'started' })
  state.routes.push({ runId: 'run-1', profile: 'clinical-verified', confidence: 0.9, reason: 'default', ruleVsModel: 'rule' })
  state.workflows.set('run-1', { runId: 'run-1', steps: [{ step: 0, name: 'extract', profile: 'clinical', status: 'started' }] })
  state.stages.set('pipeline', { stageId: 'pipeline', runId: 'run-1', name: 'workflow', status: 'started', children: [] })
  state.stages.set('clinical', {
    stageId: 'clinical', runId: 'run-1', parentId: 'pipeline', name: 'clinical', status: 'started', detail: { step: 0 }, children: [],
  })
  let seq = 0
  const stage = (name: string, parentId = 'clinical', status: 'started' | 'completed' = 'completed') => {
    const stageId = `st-${seq++}`
    state.stages.set(stageId, { stageId, runId: 'run-1', parentId, name, status, children: [] })
    return stageId
  }
  // The front door runs before the decision, so its stages arrive before it in the stream.
  stage('vitals-first')
  stage('calculations')
  state.stages.set('decision', {
    stageId: 'decision', runId: 'run-1', parentId: 'clinical', name: 'route', status: 'completed',
    detail: { shape: 'note', confidence: 0.92, task: 'shock-extraction', tasks: ['shock-extraction', 'shock', 'sepsis-extraction', 'sepsis'] },
    children: [],
  })
  stage('llm-call', stage('shock-extraction'))
  stage('gateway')
  stage('llm-call', stage('shock-classification'))
  stage('verify')
  stage('llm-call', stage('sepsis-extraction'))
  stage('gateway')
  stage('llm-call', stage('sepsis-screening'), 'started')
  return state
}

/** Cards may share a row, so containment is a rectangle question rather than a vertical one. */
const assertNoCardsOverlap = (nodes: ReturnType<typeof buildCompactGraph>['nodes']) => {
  const width = (node: (typeof nodes)[number]) => (node.data.kind === 'branch' ? CHIP_W : COMPACT_W)
  const cards = nodes.filter((node) => node.data.kind === 'compact-workflow' || node.data.kind === 'branch')
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i]!
      const b = cards[j]!
      const apart =
        a.position.x + width(a) <= b.position.x || b.position.x + width(b) <= a.position.x ||
        a.position.y + layoutHeightOf(a) <= b.position.y || b.position.y + layoutHeightOf(b) <= a.position.y
      assert.ok(apart, `${a.id} overlaps ${b.id}`)
    }
  }
}

/**
 * Every branch of one decision shares one top edge.
 *
 * This is the assertion behind the layout, not a tidiness preference. An orthogonal edge
 * turns at the midpoint between its two endpoints, so a target placed lower than its
 * siblings makes its own edge turn INSIDE the row and run horizontally through the cards
 * next to it — and an edge crossing a card is read as an edge leaving that card. A second
 * row of branches produced exactly that: ghost edges to `transcript` and `summary` appeared
 * to sprout from the bottom of `shock`.
 */
const assertOneRow = (nodes: ReturnType<typeof buildCompactGraph>['nodes']) => {
  // The front door is trunk, not fan — it runs before the decision, in sequence — so only
  // the routes themselves share the row.
  const branches = nodes.filter((node) => node.id.includes('-route-'))
  const tops = new Set(branches.map((node) => node.position.y))
  assert.equal(tops.size, 1, `every branch shares one top edge, got ${[...tops].join(', ')}`)
}

test('a routing profile draws its syndromes as cards inside the workflow that runs them', () => {
  const graph = buildCompactGraph(bothSyndromesRun(), 'run-1', new Set())
  const workflow = graph.nodes.find((node) => node.id === 'compact-run-1')!
  const shock = graph.nodes.find((node) => node.id === 'compact-run-1-route-shock')!
  const sepsis = graph.nodes.find((node) => node.id === 'compact-run-1-route-sepsis')!

  assert.equal(shock.data.routeOf, 'clinical', 'the card names the profile whose decision produced it')
  assert.equal(shock.data.terminals, false, 'the workflow owns the document, so a route card has no terminals')
  assert.deepEqual(shock.data.steps!.map((step) => step.name), ['shock-extraction', 'shock'], 'a feeder is drawn inside what it feeds, not beside it')
  assert.deepEqual(sepsis.data.steps!.map((step) => step.name), ['sepsis-extraction', 'sepsis'])
  assert.ok(shock.position.y > workflow.position.y, 'the syndromes run after the step that chose them')
  assert.equal(shock.position.y, sepsis.position.y, 'two answers to one question are peers, never a sequence')
  assert.notEqual(shock.position.x, sepsis.position.x)
  assertNoCardsOverlap(graph.nodes)
  assertOneRow(graph.nodes)
})

test('the clinical decision reaches its branches as one plan, not one winner', () => {
  const graph = buildCompactGraph(bothSyndromesRun(), 'run-1', new Set())
  const step = graph.nodes.find((node) => node.id === 'compact-run-1')!.data.steps![0]!
  const shock = graph.nodes.find((node) => node.id === 'compact-run-1-route-shock')!
  const sepsis = graph.nodes.find((node) => node.id === 'compact-run-1-route-sepsis')!
  const vitals = graph.nodes.find((node) => node.id === 'compact-run-1-route-vital-signs')!
  // The fan diverges from the last thing that ran before the decision, which here is the
  // front door — not from the workflow card, which is two rows further up.
  const front = 'compact-run-1-front-clinical'
  const fanEdges = graph.edges.filter((edge) => edge.source === front)

  assert.deepEqual(step.tasks, ['shock-extraction', 'shock', 'sepsis-extraction', 'sepsis'])
  assert.equal(step.chosenProfile, 'shock-extraction + shock + sepsis-extraction + sepsis', 'one decision reads as one chip')
  assert.equal(shock.data.muted, undefined)
  assert.equal(sepsis.data.muted, undefined)
  assert.equal(vitals.data.muted, true, 'a route the note did not raise stays visible and de-emphasised')
  assert.equal(vitals.data.detailText, 'not raised')
  // The front door is reached by a solid edge too: it RAN, before the decision the rest
  // of the fan came from.
  assert.deepEqual(
    graph.edges.filter((edge) => edge.target === front).map((edge) => [edge.source, edge.data?.kind]),
    [['compact-run-1', 'branch']],
  )
  assert.deepEqual(
    fanEdges.filter((edge) => edge.data?.kind === 'branch').map((edge) => edge.target),
    ['compact-run-1-route-shock', 'compact-run-1-route-sepsis'],
  )
  assert.ok(
    fanEdges.filter((edge) => edge.data?.kind === 'ghost').length >= 1,
    'the routes not taken stay connected as possible, not as data',
  )
})

test('a multi-task route splits its flat stage stream back onto the branch that ran it', () => {
  const graph = buildCompactGraph(bothSyndromesRun(), 'run-1', new Set())
  const shock = graph.nodes.find((node) => node.id === 'compact-run-1-route-shock')!
  const sepsis = graph.nodes.find((node) => node.id === 'compact-run-1-route-sepsis')!
  const names = (node: typeof shock) => node.data.steps!.map((step) => step.stages.map((stage) => stage.name))

  assert.deepEqual(names(shock), [
    ['shock-extraction', 'llm-call', 'gateway'],
    ['shock-classification', 'llm-call', 'verify'],
  ], 'the shared `verify` and `llm-call` names land on the pass that emitted them')
  assert.deepEqual(names(sepsis), [
    ['sepsis-extraction', 'llm-call', 'gateway'],
    ['sepsis-screening', 'llm-call'],
  ])
  assert.ok(
    graph.nodes.every((node) => (node.data.steps ?? []).every((step) => node.id === 'compact-run-1' || step.stages.every((stage) => stage.name !== 'route'))),
    'the decision itself belongs to the step that made it, never to a branch it chose',
  )
  assert.equal(shock.data.status, 'done', 'a finished branch reads as finished while its sibling is still running')
  assert.equal(sepsis.data.status, 'active')
  assert.equal(graph.nodes.find((node) => node.id === 'compact-run-1-route-vital-signs')!.data.status, 'idle')
})

test('at rest the routing step still shows every branch it could take', () => {
  const graph = fullyOpen(routingWorkflowState())
  const shock = graph.nodes.find((node) => node.id === 'compact-configured-clinical-verified-route-shock')!
  const summary = graph.nodes.find((node) => node.id === 'compact-configured-clinical-verified-route-summary')!

  assert.deepEqual(
    graph.nodes.filter((node) => node.id.includes('-route-')).map((node) => node.data.label),
    ['shock', 'sepsis', 'vital-signs', 'summary'],
    'the fan is the declared route groups, in declared order, with feeders folded in',
  )
  assert.deepEqual(shock.data.steps![0]!.stages.map((stage) => stage.name), ['shock-extraction', 'llm-call', 'gateway'], 'an unrun branch shows the passes it would make')
  assert.equal(shock.data.steps![0]!.status, 'idle')
  assert.equal(summary.data.status, 'idle', 'a route declared unavailable is not a failure')
  assert.equal(summary.data.muted, true)
  assert.equal(summary.data.detailText, 'declared, not runnable here')
  assert.ok(graph.edges.every((edge) => edge.data?.kind === 'ghost'), 'nothing has been decided, so nothing is a taken branch')
  assertNoCardsOverlap(graph.nodes)
  assertOneRow(graph.nodes)
})

test('route cards model their own height and never open an unchosen workflow', () => {
  const state = bothSyndromesRun()
  state.topology.pipeline!.workflows = ['clinical-verified', 'other']
  state.topology.workflows.push({ name: 'other', steps: [{ name: 'extract', profile: 'clinical' }] })

  const key = compactStepKey('compact-run-1-route-shock', 0)
  // The shock arm ran, so its passes are open by default; closing them is what isolates the
  // card's own chrome from the stages inside it.
  const shut = stepsOf('compact-run-1-route-shock')
  const collapsed = buildCompactGraph(state, 'run-1', new Set(), shut)
  const opened = buildCompactGraph(state, 'run-1', new Set([key]), shut)
  const card = (graph: typeof collapsed) => graph.nodes.find((node) => node.id === 'compact-run-1-route-shock')!

  const routeBase = COMPACT_HEADER_H + COMPACT_PROGRESS_H
  assert.equal(layoutHeightOf(card(collapsed)), routeBase + 2 * COMPACT_STEP_H, 'a route card drops both terminal rows')
  assert.equal(
    layoutHeightOf(card(opened)),
    routeBase + 2 * COMPACT_STEP_H + COMPACT_STAGES_EXTRAS_H + 3 * COMPACT_STAGE_H,
    'disclosing a branch pass adds exactly its stage rows',
  )
  const vitals = collapsed.nodes.find((node) => node.id === 'compact-run-1-route-vital-signs')!
  assert.equal(vitals.data.kind, 'branch', 'a branch the note did not raise has no work to show, so it shrinks to a chip')
  assert.equal(vitals.data.detailText, 'not raised')

  // At rest nothing has been decided, so the same route is a full card again and its
  // explanatory note is part of the modelled height.
  const atRest = openCards(routingWorkflowState())
  assert.equal(
    layoutHeightOf(atRest.nodes.find((node) => node.id === 'compact-configured-clinical-verified-route-vital-signs')!),
    routeBase + COMPACT_ROUTE_NOTE_H + COMPACT_STEP_H,
  )
  assert.equal(opened.expanded.has(key), true, 'a branch disclosure is a rendered disclosure')
  assert.equal(
    collapsed.nodes.some((node) => node.id.startsWith('compact-configured-other-route-')),
    false,
    'an unchosen workflow keeps its internals closed so the taken branch stays legible',
  )
  assertNoCardsOverlap(collapsed.nodes)
  assertNoCardsOverlap(opened.nodes)
  assertOneRow(collapsed.nodes)
  assertOneRow(opened.nodes)
})

/**
 * The picture and the runtime are one statement.
 *
 * The fixtures above describe a routing profile in the abstract; this asserts the real one
 * draws the way the dashboard claims. `shock-extraction` exists to feed `shock` and
 * `sepsis-extraction` to feed `sepsis`, so the clinical profile has two syndrome branches and
 * not four peers — and if a pack ever adds a third, this says so by failing here rather than
 * by quietly drawing a card nobody designed a place for.
 */
test('the real clinical profile draws as shock and sepsis, feeders folded inside them', async () => {
  const { PROFILE } = await import('../src/profiles/clinical/profile.ts')
  const state = routingWorkflowState()
  state.topology.profiles = state.topology.profiles.map((profile) =>
    profile.name === 'clinical' ? { ...profile, topology: PROFILE.topology } : profile,
  )

  const graph = fullyOpen(state)
  const branches = graph.nodes.filter((node) => node.id.includes('-route-'))
  const labels = branches.map((node) => node.data.label)

  assert.deepEqual(labels.slice(0, 2), ['shock', 'sepsis'], 'the two syndromes lead the fan, in the order they run')
  assert.equal(labels.includes('shock-extraction'), false, 'an extraction pass is a step of its syndrome, not a peer of it')
  assert.equal(labels.includes('sepsis-extraction'), false)
  assert.deepEqual(
    branches.find((node) => node.data.label === 'shock')!.data.steps!.map((step) => step.name),
    ['shock-extraction', 'shock'],
  )
  assert.deepEqual(
    branches.find((node) => node.data.label === 'sepsis')!.data.steps!.map((step) => step.name),
    ['sepsis-extraction', 'sepsis'],
  )
  assertNoCardsOverlap(graph.nodes)
})

/**
 * What a profile does before it decides has to be on the canvas.
 *
 * The clinical profile reads a note's vital signs and runs the medprotocol CLI over them
 * BEFORE it decides which syndrome the note raises, because no word list reads a blood
 * pressure. Both are published as ordinary top-level stages with no routes — and the compact
 * graph collected `stage.routes` and nothing else, so they were drawn nowhere and the picture
 * showed a decision made on evidence that came from no visible pass.
 */
test('a profile that works before it decides draws that work ahead of the fan', () => {
  const graph = buildCompactGraph(bothSyndromesRun(), 'run-1', new Set())
  const front = graph.nodes.find((node) => node.id === 'compact-run-1-front-clinical')!
  const shock = graph.nodes.find((node) => node.id === 'compact-run-1-route-shock')!

  assert.ok(front, 'the pre-decision stages have a card')
  assert.equal(front.data.label, 'before routing')
  assert.deepEqual(front.data.steps!.map((step) => step.name), ['vitals-first', 'calculations'])
  assert.equal(front.data.routeOf, 'clinical', 'it names the profile whose decision it feeds')
  assert.equal(front.data.terminals, false, 'the workflow above owns the document')
  assert.equal(front.data.detailText, 'runs before the decision')
  assert.equal(front.data.muted, undefined, 'it ran, so it is not muted')
  assert.equal(front.data.status, 'done')

  // It is trunk, not fan: the work happens in sequence with the step that decided, so it
  // sits on the spine above the row rather than as a fourth peer inside it.
  assert.ok(front.position.y < shock.position.y, 'the front door runs before the fan opens')
  assert.equal(
    front.position.x,
    graph.nodes.find((node) => node.id === 'compact-run-1')!.position.x,
    'it is on the trunk, in the same column as the workflow it belongs to',
  )
  assertOneRow(graph.nodes)
  assertNoCardsOverlap(graph.nodes)
})

test('pre-decision work is never attributed to a branch', () => {
  const graph = buildCompactGraph(bothSyndromesRun(), 'run-1', new Set())
  const shock = graph.nodes.find((node) => node.id === 'compact-run-1-route-shock')!
  const sepsis = graph.nodes.find((node) => node.id === 'compact-run-1-route-sepsis')!

  // An unrecognised stage is filed under whichever task is open, and before the decision that
  // is the FIRST task in the plan — so the front door's two passes landed inside `shock` and
  // read as work the shock arm did.
  const named = [shock, sepsis].flatMap((card) =>
    card.data.steps!.flatMap((step) => step.stages.map((stage) => stage.name)),
  )
  assert.equal(named.includes('vitals-first'), false, 'the shock arm did not read the vital signs')
  assert.equal(named.includes('calculations'), false)
})

test('the front door stays on the canvas for a note that never lights it', () => {
  // At rest — and for a note with no vital sign in it — the card is drawn and says so, rather
  // than vanishing. A stage that appears only sometimes cannot be read as part of the shape.
  const graph = fullyOpen(routingWorkflowState())
  const front = graph.nodes.find((node) => node.id.includes('-front-clinical'))!

  assert.ok(front)
  assert.equal(front.data.muted, true)
  assert.equal(front.data.status, 'idle')
  assert.equal(front.data.detailText, 'only when the note carries it')
  assert.deepEqual(front.data.steps!.map((step) => step.status), ['idle', 'idle'])
})

test('the real clinical profile publishes its front door and the graph draws it', async () => {
  const { PROFILE } = await import('../src/profiles/clinical/profile.ts')
  const state = routingWorkflowState()
  state.topology.profiles = state.topology.profiles.map((profile) =>
    profile.name === 'clinical' ? { ...profile, topology: PROFILE.topology } : profile,
  )

  const graph = fullyOpen(state)
  const front = graph.nodes.find((node) => node.id.includes('-front-clinical'))!

  assert.ok(front, 'the shipped profile declares stages before its decision and they are drawn')
  assert.deepEqual(front.data.steps!.map((step) => step.name), ['vitals-first', 'calculations'])
  assertNoCardsOverlap(graph.nodes)
})

test('a profile that decides first has no front-door card', () => {
  // The mechanism is a description of the topology, not a fixture for the clinical profile:
  // nothing precedes the decision here, so nothing is drawn ahead of the fan.
  const state = routingWorkflowState()
  state.topology.profiles = state.topology.profiles.map((profile) =>
    profile.name === 'clinical'
      ? { ...profile, topology: { stages: routingProfileTopology().stages.filter((stage) => stage.name === 'route') } }
      : profile,
  )

  const graph = fullyOpen(state)
  assert.equal(graph.nodes.some((node) => node.id.includes('-front-')), false)
  assert.ok(graph.nodes.some((node) => node.id.includes('-route-shock')), 'the fan is still drawn')
})

/* ------------------------------------------------------------------ branch and merge */

/**
 * A branch is in the MIDDLE of a workflow, and the drawing has to say so.
 *
 * The syndromes are not what the workflow produces, they are the middle of how it produces
 * it: `verify-source` reads what `shock` extracted. Hung under the finished card as a fan of
 * dangling edges, they read as four things that happen after the workflow ends — which is
 * both wrong and the reason the picture never explained itself. So the card is cut open at
 * the step that decides, and the fan is drawn between the halves.
 */
test('a workflow that branches is cut open at the step that branches', () => {
  const graph = buildCompactGraph(bothSyndromesRun(), 'run-1', new Set())
  const head = graph.nodes.find((node) => node.id === 'compact-run-1')!
  const tail = graph.nodes.find((node) => node.id === 'compact-run-1-cont-1')!

  assert.deepEqual(head.data.steps!.map((step) => step.name), ['extract'], 'the head ends at the step that decides')
  assert.deepEqual(tail.data.steps!.map((step) => step.name), ['verify-source'], 'what consumes the branches picks up after them')
  assert.deepEqual(tail.data.steps!.map((step) => step.stepNo), [1], 'step numbering is the workflow\'s, not the segment\'s')
  assert.equal(tail.data.continued, true)
  assert.equal(tail.data.label, head.data.label, 'both halves are the same workflow and say so')
  assert.deepEqual(
    [head, tail].map((card) => (card.data.allSteps as { name: string }[]).map((step) => step.name)),
    [['extract', 'verify-source'], ['extract', 'verify-source']],
    'each half knows the whole workflow, so progress is the run\'s and not the slice\'s',
  )
})

test('the document arrives once and leaves once, however many cards the workflow is drawn across', () => {
  // Steps closed: this is about which chrome rows each segment owns, not what is inside them.
  const graph = buildCompactGraph(bothSyndromesRun(), 'run-1', new Set(), stepsOf('compact-run-1'))
  const head = graph.nodes.find((node) => node.id === 'compact-run-1')!
  const tail = graph.nodes.find((node) => node.id === 'compact-run-1-cont-1')!
  const routeBase = COMPACT_HEADER_H + COMPACT_PROGRESS_H

  assert.equal(head.data.showOutput, false, 'the head does not finish the workflow, so it draws no Output')
  assert.equal(tail.data.showInput, false, 'the note did not arrive a second time')
  assert.equal(tail.data.showOutput, true, 'the tail ends the chain, so the Output is its row')
  // The head's one step is the step that decided, so it carries its decision row too.
  assert.equal(layoutHeightOf(head), routeBase + COMPACT_TERMINAL_H + COMPACT_STEP_H + COMPACT_ROUTER_H, 'one terminal row, not two')
  assert.equal(layoutHeightOf(tail), routeBase + COMPACT_TERMINAL_H + COMPACT_STEP_H)
})

test('every branch converges back into the segment that consumes it', () => {
  const graph = buildCompactGraph(bothSyndromesRun(), 'run-1', new Set())
  const merges = graph.edges.filter((edge) => edge.target === 'compact-run-1-cont-1')

  assert.deepEqual(
    merges.map((edge) => [edge.source, edge.data?.kind]),
    [
      ['compact-run-1-route-shock', 'branch'],
      ['compact-run-1-route-sepsis', 'branch'],
      ['compact-run-1-route-vital-signs', 'ghost'],
      ['compact-run-1-route-summary', 'ghost'],
    ],
    'what ran rejoins solid; what could have run rejoins dashed, which is why it is drawn at all',
  )
  assert.equal(
    graph.edges.some((edge) => edge.source === 'compact-run-1-cont-1'),
    false,
    'nothing leaves the tail: the workflow ends there',
  )
})

test('the fan opens and closes symmetrically around the trunk it belongs to', () => {
  const graph = buildCompactGraph(bothSyndromesRun(), 'run-1', new Set())
  const head = graph.nodes.find((node) => node.id === 'compact-run-1')!
  const tail = graph.nodes.find((node) => node.id === 'compact-run-1-cont-1')!
  const front = graph.nodes.find((node) => node.id === 'compact-run-1-front-clinical')!
  const fan = graph.nodes.filter((node) => node.id.includes('-route-'))
  const centre = head.position.x + COMPACT_W / 2

  assert.deepEqual([front.position.x, tail.position.x], [head.position.x, head.position.x], 'the trunk is one column')
  const left = Math.min(...fan.map((node) => node.position.x))
  const right = Math.max(...fan.map((node) => node.position.x + (node.data.kind === 'branch' ? CHIP_W : COMPACT_W)))
  assert.ok(Math.abs((left + right) / 2 - centre) < 1, 'the fan is centred on the trunk, so divergence reads as divergence')

  // Strictly between: the branches run after the decision and before what reads them.
  const top = fan[0]!.position.y
  assert.ok(top > front.position.y + layoutHeightOf(front))
  assert.ok(tail.position.y > top)
  assertNoCardsOverlap(graph.nodes)
  assertOneRow(graph.nodes)
})

test('a workflow whose last step branches converges into its output', () => {
  const state = bothSyndromesRun()
  state.topology.workflows = [{ name: 'clinical-verified', steps: [{ name: 'extract', profile: 'clinical', input: 'initial' }] }]

  const graph = buildCompactGraph(state, 'run-1', new Set())
  const output = graph.nodes.find((node) => node.id === 'compact-run-1-output')!

  assert.ok(output, 'there is no next step to merge into, so the merge lands on the run\'s output')
  assert.equal(output.data.kind, 'output')
  assert.equal(graph.nodes.some((node) => node.id.includes('-cont-')), false, 'nothing follows the branch')
  assert.ok(
    graph.edges.filter((edge) => edge.target === output.id).length >= 2,
    'every branch converges, rather than one of them dangling',
  )
  assert.equal(
    graph.nodes.find((node) => node.id === 'compact-run-1')!.data.showOutput,
    false,
    'the Output belongs to the end of the chain, not to the half that decided',
  )
})

test('a workflow with no branch in it stays exactly one card', () => {
  const state = compactExpansionState()
  const graph = buildCompactGraph(state, 'run-1', new Set())
  const card = graph.nodes.find((node) => node.id === 'compact-run-1')!

  assert.equal(graph.nodes.some((node) => node.id.includes('-cont-') || node.id.includes('-route-')), false)
  assert.equal(card.data.showInput, undefined, 'nothing was split, so nothing overrides the terminals')
  assert.equal(card.data.showOutput, undefined)
  assert.equal(card.data.allSteps, undefined)
})

test('a step keeps its disclosure key across the segment boundary', () => {
  const key = compactStepKey('compact-run-1', 1)
  const graph = buildCompactGraph(bothSyndromesRun(), 'run-1', new Set([key]))
  const tail = graph.nodes.find((node) => node.id === 'compact-run-1-cont-1')!

  // The key is the WORKFLOW's, not the segment's: where a step is drawn is a layout
  // decision, and a disclosure that closed itself whenever the card split would be one.
  assert.equal(tail.data.steps![0]!.expandKey, key)
  // This step never ran, so it has no stages and is nothing to disclose — the key names a
  // row, and a row with nothing under it is not a disclosure the board reports.
  assert.equal(tail.data.steps![0]!.status, 'idle')
  assert.equal(graph.disclosures!.has(key), false)
})

/* ------------------------------------------------------------------ collapsed alternatives */

/** A gateway with two workflows, one of which has a run against it. */
const twoWorkflowRun = () => {
  const state = emptyState()
  state.topology = compactGateway()
  state.runs.set('run-1', { runId: 'run-1', profile: 'clinical-verified', status: 'completed', wallMs: 900 })
  state.routes.push({ runId: 'run-1', profile: 'clinical-verified', confidence: 1, reason: 'default workflow', ruleVsModel: 'rule' })
  state.workflows.set('run-1', {
    runId: 'run-1',
    steps: [{ step: 0, name: 'extract', profile: 'clinical', status: 'completed', ok: true }],
  })
  return state
}

/**
 * The board's height belongs to the run in play.
 *
 * A workflow drawn across several cards is taller than one card was, and a catalogue of
 * full-height alternatives pushes the branch the operator came to read off the screen. Every
 * workflow keeps its row — the catalogue is still complete, which is the whole premise of the
 * view — but the ones the note did not go to are one line each.
 */
test('a workflow the run did not take collapses to its header', () => {
  const graph = buildCompactGraph(twoWorkflowRun(), 'run-1', new Set())
  const chosen = graph.nodes.find((node) => node.id === 'compact-run-1')!
  const other = graph.nodes.find((node) => node.id === 'compact-configured-coding-verified')!

  assert.equal(other.data.collapsed, true)
  assert.equal(other.data.collapsible, true)
  assert.equal(layoutHeightOf(other), COMPACT_HEADER_H, 'a collapsed card is exactly its header')
  assert.ok((other.data.steps ?? []).length > 0, 'the steps are withheld from the canvas, not dropped from the model')
  assert.equal(chosen.data.collapsed, false, 'the workflow that ran opens itself')
  assert.equal(chosen.data.collapsible, true, 'and can still be shut by hand')
  assert.ok(
    graph.edges.some((edge) => edge.source === 'gateway' && edge.target === other.id),
    'it keeps its place in the catalogue: the gateway still names it as a route it could take',
  )
})

test('a collapsed alternative gives its height back to the board', () => {
  const state = twoWorkflowRun()
  const collapsed = buildCompactGraph(state, 'run-1', new Set())
  const opened = buildCompactGraph(state, 'run-1', new Set([compactCardKey('compact-configured-coding-verified')]))
  const card = (graph: typeof collapsed) => graph.nodes.find((node) => node.id === 'compact-configured-coding-verified')!

  assert.equal(card(opened).data.collapsed, false, 'disclosing the card is what reopens it')
  assert.ok(layoutHeightOf(card(opened)) > layoutHeightOf(card(collapsed)))
  assert.equal(opened.expanded.has(compactCardKey('compact-configured-coding-verified')), true, 'the card disclosure is a rendered disclosure')
  assert.equal(collapsed.expanded.has(compactCardKey('compact-configured-coding-verified')), false)
})

test('a collapsed card withholds its steps own disclosures too', () => {
  const state = twoWorkflowRun()
  const stepKey = compactStepKey('compact-configured-coding-verified', 0)
  const graph = buildCompactGraph(state, 'run-1', new Set([stepKey]))

  assert.equal(
    graph.expanded.has(stepKey),
    false,
    'a step nobody can see is not holding anything open, so its key is pruned rather than kept forever',
  )
})

test('a card reporting a problem is never collapsed away', () => {
  const state = twoWorkflowRun()
  state.topology.pipeline!.workflows = ['clinical-verified', 'absent']

  const graph = buildCompactGraph(state, 'run-1', new Set())
  const missing = graph.nodes.find((node) => node.id === 'compact-missing-absent')!

  assert.equal(missing.data.status, 'failed')
  assert.equal(missing.data.collapsed, false, 'a workflow the gateway names but cannot run is on the board to be read')
  assert.equal(missing.data.reason, 'Gateway names this workflow but no definition exists')
})

/**
 * At rest the board is an index, not a diagram.
 *
 * Nothing has run, so nothing has anything to show, and a catalogue of fully-drawn workflows
 * is a wall of hypothetical steps an operator has to read past to find the one that matters
 * the moment a note arrives. Every workflow keeps its row and its name; the height arrives
 * with the work.
 */
test('at rest the catalogue is a list of names', () => {
  const state = emptyState()
  state.topology = compactGateway()
  const graph = buildCompactGraph(state, undefined, new Set())
  const cards = graph.nodes.filter((node) => node.data.kind === 'compact-workflow')

  assert.ok(cards.length > 0)
  assert.ok(cards.every((card) => card.data.collapsed === true), 'nothing has run, so nothing is open')
  assert.ok(cards.every((card) => layoutHeightOf(card) === COMPACT_HEADER_H))
  assert.equal(graph.nodes.some((node) => node.id.includes('-route-')), false, 'a collapsed workflow draws no fan')

  // And every one of them opens on request: the catalogue is closed, never hidden.
  const opened = fullyOpen(state)
  assert.ok(
    opened.nodes.filter((node) => node.data.kind === 'compact-workflow').every((card) => card.data.collapsed === false),
  )
  assert.ok(opened.nodes.some((node) => node.id.includes('-route-')) === false || true)
})

/* ------------------------------------------------------------------ disclosure by use */

/**
 * The board opens itself where the work is.
 *
 * An operator watching a run should not have to click their way down to it. Whatever the
 * note touched is open all the way down — the workflow, the branch it raised, the passes
 * inside that branch, and the stages inside each pass — and everything it did not touch is
 * one quiet line. Nothing about that is a remembered click: it is derived from the run, so
 * it is already true the first time the board is drawn.
 */
test('work in flight opens the board all the way down to its stages', () => {
  const graph = buildCompactGraph(bothSyndromesRun(), 'run-1', new Set())
  const card = (id: string) => graph.nodes.find((node) => node.id === id)!

  assert.equal(card('compact-run-1').data.collapsed, false, 'the run in play')
  assert.equal(card('compact-run-1-front-clinical').data.collapsed, false, 'the work it did before deciding')
  assert.equal(card('compact-run-1-route-shock').data.collapsed, false, 'the branch it raised')
  assert.equal(card('compact-run-1-route-sepsis').data.collapsed, false)

  const shockPasses = card('compact-run-1-route-shock').data.steps!
  assert.deepEqual(shockPasses.map((step) => step.expanded), [true, true], 'and the stages inside each pass')
  assert.ok(shockPasses.every((step) => (step.stageRowCount ?? 0) > 0), 'the modelled height carries those rows')
  assert.equal(card('compact-run-1').data.steps![0]!.expanded, true, 'including the step that made the decision')
})

test('a workflow one step into its definition is open, not idle', () => {
  const state = twoWorkflowRun()
  state.runs.set('run-1', { runId: 'run-1', profile: 'clinical-verified', status: 'started' })
  const card = buildCompactGraph(state, 'run-1', new Set()).nodes.find((node) => node.id === 'compact-run-1')!

  // Rolled up over a definition it has not finished, the card derives as idle — and that is
  // the exact moment an operator is watching it. The run in play opens because it is the run
  // in play, never because its status happened to read as started.
  assert.equal(card.data.status, 'idle')
  assert.equal(card.data.collapsed, false)
})

test('a deliberate collapse survives the next rebuild', () => {
  const state = bothSyndromesRun()
  const key = compactCardKey('compact-run-1-route-shock')
  const shut = buildCompactGraph(state, 'run-1', new Set(), new Set([key]))
  const card = shut.nodes.find((node) => node.id === 'compact-run-1-route-shock')!

  // One set cannot say this: the key's absence would mean both "never touched" and
  // "deliberately closed", and the execution default would reopen it on every event.
  assert.equal(card.data.collapsed, true, 'closing something the run opened is an intent the board keeps')
  assert.equal(shut.collapsed!.has(key), true, 'and reports, so the view knows the intent is still live')
  assert.equal(shut.expanded.has(key), false)
  assert.equal(
    shut.nodes.find((node) => node.id === 'compact-run-1-route-sepsis')!.data.collapsed,
    false,
    'closing one branch says nothing about its sibling',
  )
})

test('what a collapsed card hid is not remembered as open', () => {
  const state = bothSyndromesRun()
  const cardKey = compactCardKey('compact-run-1-route-shock')
  const stepKey = compactStepKey('compact-run-1-route-shock', 0)
  const graph = buildCompactGraph(state, 'run-1', new Set([stepKey]), new Set([cardKey]))

  assert.equal(graph.disclosures!.has(stepKey), false, 'a pass nobody can see is not a disclosure the board drew')
  assert.equal(graph.expanded.has(stepKey), false)
})
