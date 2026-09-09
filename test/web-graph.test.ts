/** The browser graph's model stays deterministic and testable without a renderer. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph, buildProjectGraph } from '../web/src/lib/graph.ts'
import { emptyState } from '../src/tui/state.ts'

test('an active nested stage marks its step lineage and renders in a group', () => {
  const state = emptyState()
  state.runs.set('run-1', { runId: 'run-1', profile: 'flow', status: 'started' })
  state.topology = {
    profiles: [{ name: 'flow', mode: 'pipeline' }, { name: 'worker', mode: 'extract' }],
    pipelines: [{ name: 'flow', steps: [{ name: 'extract', profile: 'worker', input: 'initial' }] }],
  }
  state.pipelines.set('run-1', {
    runId: 'run-1',
    steps: [{ step: 0, name: 'extract', profile: 'worker', status: 'started' }],
  })
  state.stages.set('pipeline', {
    stageId: 'pipeline', runId: 'run-1', name: 'pipeline', status: 'started', children: [],
  })
  state.stages.set('worker', {
    stageId: 'worker', runId: 'run-1', parentId: 'pipeline', name: 'worker', status: 'started', detail: { step: 0 }, children: [],
  })
  state.stages.set('llm', {
    stageId: 'llm', runId: 'run-1', parentId: 'worker', name: 'llm-call', status: 'started', children: [],
  })

  const graph = buildGraph(state, 'run-1', new Set(['step-0']))
  const step = graph.nodes.find((n) => n.id === 'step-0')
  const leaf = graph.nodes.find((n) => n.id === 'stage-llm')
  const group = graph.nodes.find((n) => n.id === 'group-step-0')
  const input = graph.nodes.find((n) => n.id === 'input')
  const output = graph.nodes.find((n) => n.id === 'output')

  assert.equal(step?.data.current, true, 'the summary step carries the live badge')
  assert.equal(leaf?.data.current, true, 'the active leaf carries the live badge')
  assert.equal(group?.data.current, true, 'the expanded live lineage highlights its group')
  assert.equal(input?.data.status, 'done', 'run.started means input preparation has finished')
  assert.equal(input?.data.current, undefined, 'input is not current for the whole run')
  assert.equal(output?.data.status, 'idle', 'output remains pending while work is in flight')
  assert.equal(output?.data.current, undefined, 'output is not current before the run settles')
  assert.equal(group?.data.label, 'extract · 1')
  assert.ok(Number(group?.style?.width) > 0)
  assert.ok(Number(group?.style?.height) > 0)

  state.runs.set('run-1', { ...state.runs.get('run-1')!, status: 'completed', wallMs: 1200 })
  const completed = buildGraph(state, 'run-1', new Set())
  assert.equal(completed.nodes.find((n) => n.id === 'output')?.data.status, 'done')
})

test('expanded step groups occupy a shared detail lane without overlapping', () => {
  const state = emptyState()
  state.runs.set('run-1', { runId: 'run-1', profile: 'flow', status: 'started' })
  state.topology = {
    profiles: [
      { name: 'flow', mode: 'pipeline' },
      { name: 'first', mode: 'extract' },
      { name: 'second', mode: 'extract' },
    ],
    pipelines: [{
      name: 'flow',
      steps: [
        { name: 'first', profile: 'first', input: 'initial' },
        { name: 'second', profile: 'second' },
      ],
    }],
  }
  state.pipelines.set('run-1', {
    runId: 'run-1',
    steps: [
      { step: 0, name: 'first', profile: 'first', status: 'completed' },
      { step: 1, name: 'second', profile: 'second', status: 'started' },
    ],
  })
  state.stages.set('pipeline', {
    stageId: 'pipeline', runId: 'run-1', name: 'pipeline', status: 'started', children: [],
  })
  for (const step of [0, 1]) {
    state.stages.set(`worker-${step}`, {
      stageId: `worker-${step}`,
      runId: 'run-1',
      parentId: 'pipeline',
      name: `worker-${step}`,
      status: step === 0 ? 'completed' : 'started',
      detail: { step },
      children: [],
    })
    state.stages.set(`leaf-${step}`, {
      stageId: `leaf-${step}`,
      runId: 'run-1',
      parentId: `worker-${step}`,
      name: 'llm-call',
      status: step === 0 ? 'completed' : 'started',
      children: [],
    })
  }

  const graph = buildGraph(state, 'run-1', new Set(['step-0', 'step-1']))
  const first = graph.nodes.find((n) => n.id === 'group-step-0')
  const second = graph.nodes.find((n) => n.id === 'group-step-1')
  assert.ok(first)
  assert.ok(second)
  const firstRight = first.position.x + Number(first.style?.width)

  assert.equal(first.position.y, second.position.y, 'expanded groups share a stable detail lane')
  assert.ok(firstRight < second.position.x, 'adjacent expanded groups have a visible gutter')
})

test('expanded stages form a compact vertical rail beneath their step', () => {
  const state = emptyState()
  state.runs.set('run-1', { runId: 'run-1', profile: 'flow', status: 'started' })
  state.topology = {
    profiles: [{ name: 'flow', mode: 'pipeline' }, { name: 'worker', mode: 'extract' }],
    pipelines: [{ name: 'flow', steps: [{ name: 'extract', profile: 'worker', input: 'initial' }] }],
  }
  state.pipelines.set('run-1', {
    runId: 'run-1',
    steps: [{ step: 0, name: 'extract', profile: 'worker', status: 'started' }],
  })
  state.stages.set('pipeline', {
    stageId: 'pipeline', runId: 'run-1', name: 'pipeline', status: 'started', children: [],
  })
  state.stages.set('worker', {
    stageId: 'worker', runId: 'run-1', parentId: 'pipeline', name: 'worker', status: 'started', detail: { step: 0 }, children: [],
  })
  for (const [index, name] of ['prompt-assembly', 'llm-call', 'parse'].entries()) {
    state.stages.set(name, {
      stageId: name, runId: 'run-1', parentId: 'worker', name, status: index < 2 ? 'completed' : 'started', children: [],
    })
  }

  const graph = buildGraph(state, 'run-1', new Set(['step-0']))
  const stages = ['prompt-assembly', 'llm-call', 'parse'].map((id) => graph.nodes.find((n) => n.id === `stage-${id}`)!)
  const group = graph.nodes.find((n) => n.id === 'group-step-0')!

  assert.ok(stages.every((stage) => stage.position.x === stages[0]!.position.x), 'stage cards share one readable column')
  assert.ok(stages[0]!.position.y < stages[1]!.position.y && stages[1]!.position.y < stages[2]!.position.y, 'execution order reads top to bottom')
  assert.ok(Number(group.style?.width) < 300, 'the detail rail stays compact enough to preserve the main path')
  assert.ok(Number(group.style?.height) > 250, 'the group encloses the complete stage rail')
})

test('expanded router alternatives branch from the routing decision', () => {
  const state = emptyState()
  state.runs.set('run-1', { runId: 'run-1', profile: 'flow', status: 'started' })
  state.topology = {
    profiles: [
      { name: 'flow', mode: 'pipeline' },
      { name: 'router', mode: 'router' },
      { name: 'clinical', mode: 'extract' },
      { name: 'coding', mode: 'extract' },
    ],
    pipelines: [{ name: 'flow', steps: [{ name: 'route', profile: 'router' }] }],
  }
  state.routes.push({ profile: 'clinical', confidence: 0.9, reason: 'rule match', ruleVsModel: 'rule', runId: 'run-1' })
  state.pipelines.set('run-1', {
    runId: 'run-1',
    steps: [{ step: 0, name: 'route', profile: 'router', status: 'completed' }],
  })
  state.stages.set('pipeline', {
    stageId: 'pipeline', runId: 'run-1', name: 'pipeline', status: 'started', children: [],
  })
  state.stages.set('router-step', {
    stageId: 'router-step', runId: 'run-1', parentId: 'pipeline', name: 'router', status: 'completed', detail: { step: 0 }, children: [],
  })
  state.stages.set('decision', {
    stageId: 'decision', runId: 'run-1', parentId: 'router-step', name: 'route', status: 'completed', detail: { profile: 'clinical' }, children: [],
  })

  const expanded = buildGraph(state, 'run-1', new Set(['step-0']))
  const expandedGhosts = expanded.edges.filter((edge) => edge.data?.kind === 'ghost')
  assert.ok(expandedGhosts.length > 0)
  assert.ok(expandedGhosts.every((edge) => edge.source === 'stage-decision'))

  const collapsed = buildGraph(state, 'run-1', new Set())
  const collapsedGhosts = collapsed.edges.filter((edge) => edge.data?.kind === 'ghost')
  assert.ok(collapsedGhosts.every((edge) => edge.source === 'step-0'))
})

test('project graph renders every configured pipeline and profile before any run', () => {
  const state = emptyState()
  state.topology = {
    profiles: [
      { name: 'alpha-flow', mode: 'pipeline' },
      { name: 'beta-flow', mode: 'pipeline' },
      { name: 'router', mode: 'router' },
      { name: 'alpha', mode: 'extract' },
      { name: 'beta', mode: 'agentic' },
    ],
    pipelines: [
      { name: 'alpha-flow', steps: [{ name: 'route', profile: 'router' }, { name: 'extract', profile: 'alpha' }] },
      { name: 'beta-flow', steps: [{ name: 'work', profile: 'beta' }] },
    ],
  }

  const graph = buildProjectGraph(state, undefined, new Set())
  assert.ok(graph.nodes.some((n) => n.id === 'pipeline-alpha-flow/step-0'))
  assert.ok(graph.nodes.some((n) => n.id === 'pipeline-beta-flow/step-0'))
  assert.deepEqual(
    graph.nodes.filter((n) => n.data.kind === 'profile').map((n) => n.data.profile),
    ['alpha-flow', 'beta-flow', 'router', 'alpha', 'beta'],
  )
  assert.equal(graph.edges.filter((edge) => edge.data?.kind === 'ghost').length, 2, 'router shows every specialist route')
})

test('project graph keeps unchosen routes visible at reduced opacity', () => {
  const state = emptyState()
  state.topology = {
    profiles: [
      { name: 'flow', mode: 'pipeline' },
      {
        name: 'router', mode: 'router', topology: {
          stages: [{ name: 'route', kind: 'decision', routes: [
            { name: 'clinical', targetProfile: 'clinical' },
            { name: 'verifier', targetProfile: 'verifier' },
          ] }],
        },
      },
      { name: 'clinical', mode: 'extract' },
      { name: 'verifier', mode: 'extract' },
      { name: 'coding', mode: 'agentic' },
    ],
    pipelines: [{ name: 'flow', steps: [{ name: 'route', profile: 'router' }, { name: 'extract', profile: 'clinical' }] }],
  }
  state.runs.set('run-1', { runId: 'run-1', profile: 'flow', status: 'started' })
  state.routes.push({ profile: 'clinical', confidence: 0.9, reason: 'rule match', ruleVsModel: 'rule', runId: 'run-1' })
  state.pipelines.set('run-1', {
    runId: 'run-1',
    steps: [{ step: 0, name: 'route', profile: 'router', status: 'completed' }],
  })

  const graph = buildProjectGraph(state, 'run-1', new Set())
  const chosen = graph.nodes.find((n) => n.id === 'profile-clinical')!
  const unchosen = graph.nodes.find((n) => n.id === 'profile-verifier')!
  const unrelated = graph.nodes.find((n) => n.id === 'profile-coding')!
  const routeEdges = graph.edges.filter((edge) => edge.source === 'pipeline-flow/step-0' && edge.target.startsWith('profile-'))

  assert.equal(chosen.data.chosen, true)
  assert.equal(chosen.data.muted, false)
  assert.equal(unchosen.data.muted, true)
  assert.equal(unrelated.data.muted, false, 'profiles outside the declared router are not faded')
  assert.equal(routeEdges.length, 2, 'no route disappears after selection')
  assert.equal(routeEdges.find((edge) => edge.target === 'profile-clinical')?.data?.kind, 'branch')
  assert.equal(routeEdges.find((edge) => edge.target === 'profile-verifier')?.data?.muted, true)
  assert.equal(routeEdges.find((edge) => edge.target === 'profile-verifier')?.style?.opacity, 0.22)
})

test('declared topology renders exact routes, internal stages, and missing targets', () => {
  const state = emptyState()
  state.topology = {
    profiles: [
      { name: 'flow', mode: 'pipeline', topology: { stages: [] } },
      {
        name: 'router',
        mode: 'router',
        pinned: true,
        topology: {
          stages: [{
            name: 'route',
            kind: 'decision',
            routes: [
              { name: 'worker', targetProfile: 'worker' },
              { name: 'missing', targetProfile: 'missing' },
            ],
          }],
        },
      },
      {
        name: 'worker',
        mode: 'extract',
        topology: {
          stages: [{
            name: 'choose-task',
            kind: 'decision',
            routes: [{ name: 'one', stages: [{ name: 'prepare' }, { name: 'execute' }] }],
          }],
        },
      },
      { name: 'unrelated', mode: 'agentic', topology: { stages: [{ name: 'llm-call', repeatable: true }] } },
    ],
    pipelines: [{ name: 'flow', steps: [{ name: 'route', profile: 'router' }] }],
  }

  const graph = buildProjectGraph(state, undefined, new Set())
  const targets = graph.edges
    .filter((edge) => edge.source === 'pipeline-flow/step-0' && edge.target.startsWith('profile-'))
    .map((edge) => edge.target)
  assert.deepEqual(targets.sort(), ['profile-missing', 'profile-worker'])
  assert.ok(!targets.includes('profile-unrelated'), 'declared routes replace profile-mode guesses')
  assert.equal(graph.nodes.find((node) => node.id === 'profile-missing')?.data.configured, false)
  assert.equal(graph.nodes.find((node) => node.id === 'profile-missing')?.data.status, 'failed')
  const entryPoints = graph.nodes.filter((node) => node.data.entryPoint)
  assert.deepEqual(entryPoints.map((node) => node.id), ['pipeline-flow/step-0'])
  const blueprintLabels = graph.nodes
    .filter((node) => node.id.startsWith('blueprint-worker-'))
    .map((node) => node.data.label)
  assert.deepEqual(blueprintLabels, ['choose-task', 'one', 'prepare', 'execute'])
})

test('a lone routing node is not redundantly tagged as the entry point', () => {
  const state = emptyState()
  state.topology = {
    profiles: [{
      name: 'router',
      mode: 'router',
      pinned: true,
      topology: { stages: [{ name: 'route', kind: 'decision' }] },
    }],
    pipelines: [],
  }

  const graph = buildProjectGraph(state, undefined, new Set())
  assert.equal(graph.nodes.filter((node) => node.data.kind === 'route').length, 1)
  assert.equal(graph.nodes.some((node) => node.data.entryPoint), false)
})

test('an internal task decision dims the complete unchosen task path', () => {
  const state = emptyState()
  state.topology = {
    profiles: [{
      name: 'worker',
      mode: 'extract',
      topology: {
        stages: [{
          name: 'route',
          kind: 'decision',
          routes: [
            { name: 'alpha', stages: [{ name: 'alpha-call' }] },
            { name: 'beta', stages: [{ name: 'beta-call' }] },
          ],
        }],
      },
    }],
    pipelines: [],
  }
  state.runs.set('run-1', { runId: 'run-1', profile: 'worker', status: 'started' })
  state.stages.set('route-1', {
    stageId: 'route-1', runId: 'run-1', name: 'route', status: 'completed', detail: { task: 'alpha' }, children: [],
  })

  const graph = buildProjectGraph(state, 'run-1', new Set())
  const alpha = graph.nodes.find((node) => node.data.kind === 'branch' && node.data.label === 'alpha')!
  const beta = graph.nodes.find((node) => node.data.kind === 'branch' && node.data.label === 'beta')!
  const betaCall = graph.nodes.find((node) => node.data.label === 'beta-call')!
  assert.equal(alpha.data.chosen, true)
  assert.equal(alpha.data.muted, false)
  assert.equal(beta.data.muted, true)
  assert.equal(betaCall.data.muted, true)
})
