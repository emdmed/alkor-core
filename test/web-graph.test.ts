/** The browser graph's model stays deterministic and testable without a renderer. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildExpandedPipelinesGraph, buildGraph, buildPipelinesGraph, buildProgressGraph, buildProjectGraph } from '../web/src/lib/graph.ts'
import { emptyState } from '../src/tui/state.ts'

test('an active nested stage marks its step lineage and renders inline', () => {
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
  const input = graph.nodes.find((n) => n.id === 'input')
  const output = graph.nodes.find((n) => n.id === 'output')

  assert.equal(step?.data.current, true, 'the summary step carries the live badge')
  assert.equal(leaf?.data.current, true, 'the active leaf carries the live badge')
  assert.ok(step!.position.x < leaf!.position.x, 'the live stage follows its owning step')
  assert.equal(step!.position.y, leaf!.position.y, 'the execution trail stays on one axis')
  assert.equal(graph.nodes.some((n) => n.data.kind === 'group'), false, 'the trail needs no secondary detail lane')
  assert.equal(input?.data.status, 'done', 'run.started means input preparation has finished')
  assert.equal(input?.data.current, undefined, 'input is not current for the whole run')
  assert.equal(output?.data.status, 'idle', 'output remains pending while work is in flight')
  assert.equal(output?.data.current, undefined, 'output is not current before the run settles')

  state.runs.set('run-1', { ...state.runs.get('run-1')!, status: 'completed', wallMs: 1200 })
  const completed = buildGraph(state, 'run-1', new Set())
  assert.equal(completed.nodes.find((n) => n.id === 'output')?.data.status, 'done')
})

test('expanded steps form one ordered trail without parallel rows', () => {
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
  const trail = ['input', 'step-0', 'stage-leaf-0', 'step-1', 'stage-leaf-1', 'output']
    .map((id) => graph.nodes.find((node) => node.id === id)!)
  assert.ok(trail.every((node) => node.position.y === trail[0]!.position.y))
  assert.ok(trail.every((node, index) => index === 0 || node.position.x > trail[index - 1]!.position.x))
  assert.deepEqual(graph.edges.map((edge) => [edge.source, edge.target]), trail.slice(0, -1).map((node, index) => [node.id, trail[index + 1]!.id]))
})

test('expanded stages advance left to right one step column at a time', () => {
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

  assert.ok(stages.every((stage) => stage.position.y === stages[0]!.position.y), 'one execution path shares a row')
  assert.equal(stages[1]!.position.x - stages[0]!.position.x, 304)
  assert.equal(stages[2]!.position.x - stages[1]!.position.x, 304)
  assert.equal(graph.nodes.some((node) => node.data.kind === 'group'), false)
})

test('expanded router shows only the selected decision on the execution trail', () => {
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
  const branches = expanded.nodes.filter((node) => node.data.kind === 'branch')
  assert.deepEqual(branches.map((node) => node.data.label), ['clinical'])
  assert.equal(expanded.edges.some((edge) => edge.data?.kind === 'ghost'), false)
  const decisionIndex = expanded.nodes.findIndex((node) => node.id === 'stage-decision')
  assert.equal(expanded.nodes[decisionIndex + 1]?.data.label, 'clinical')

  const collapsed = buildGraph(state, 'run-1', new Set())
  assert.equal(collapsed.nodes.some((node) => node.data.kind === 'branch'), false)
  assert.equal(collapsed.edges.some((edge) => edge.data?.kind === 'ghost'), false)
})

test('progress graph previews only the selected configured pipeline', () => {
  const state = emptyState()
  state.topology = {
    profiles: [
      { name: 'alpha-flow', mode: 'pipeline' },
      { name: 'beta-flow', mode: 'pipeline' },
      { name: 'alpha', mode: 'extract' },
      { name: 'beta', mode: 'agentic', topology: { stages: [{ name: 'prepare prompt' }, { name: 'llm call' }] } },
    ],
    pipelines: [
      { name: 'alpha-flow', steps: [{ name: 'alpha step', profile: 'alpha' }] },
      { name: 'beta-flow', steps: [{ name: 'prepare', profile: 'beta' }, { name: 'finish', profile: 'beta' }] },
    ],
  }

  const graph = buildProgressGraph(state, undefined, new Set(), 'beta-flow')

  assert.match(graph.title, /^beta-flow · 2 steps · ready$/)
  assert.deepEqual(
    graph.nodes.filter((node) => node.data.kind === 'step').map((node) => node.data.label),
    ['prepare', 'finish'],
  )
  assert.equal(graph.nodes.some((node) => node.data.kind === 'profile'), false, 'the preview contains only the process spine')
  assert.ok(!graph.nodes.some((node) => node.data.label === 'alpha step'))
  const columns = ['input', 'step-0', 'step-1', 'output']
    .map((id) => graph.nodes.find((node) => node.id === id)!.position.x)
  assert.deepEqual(
    columns.slice(1).map((x, index) => x - columns[index]!),
    [340, 340, 340],
    'input, each process step, and output occupy consecutive columns',
  )
  assert.equal(graph.nodes.length, 4)
})

test('progress graph preserves composed data references between configured steps', () => {
  const state = emptyState()
  state.topology = {
    profiles: [
      { name: 'verified-flow', mode: 'pipeline' },
      { name: 'extractor', mode: 'extract' },
      { name: 'verifier', mode: 'extract' },
    ],
    pipelines: [{
      name: 'verified-flow',
      steps: [
        { name: 'extract', profile: 'extractor', input: 'initial' },
        {
          name: 'verify',
          profile: 'verifier',
          input: [
            { name: 'document', ref: 'initial' },
            { name: 'extraction', ref: 'step-0.raw' },
          ],
        },
      ],
    }],
  }

  const graph = buildProgressGraph(state, undefined, new Set(), 'verified-flow')
  const verify = graph.nodes.find((node) => node.id === 'step-1')
  const transfer = graph.edges.find((edge) => edge.target === 'step-1')

  assert.equal(verify?.data.inputRef, 'document ← initial · extraction ← step-0.raw')
  assert.equal(transfer?.label, verify?.data.inputRef)
})

test('progress graph renders one run without router alternatives', () => {
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
      { name: 'unrelated', mode: 'agentic' },
    ],
    pipelines: [{ name: 'flow', steps: [
      { name: 'route', profile: 'router' },
      { name: 'extract', profile: 'clinical' },
    ] }],
  }
  state.runs.set('run-1', { runId: 'run-1', profile: 'flow', status: 'started' })
  state.routes.push({ profile: 'clinical', confidence: 0.9, reason: 'rule match', ruleVsModel: 'rule', runId: 'run-1' })
  state.pipelines.set('run-1', {
    runId: 'run-1',
    steps: [
      { step: 0, name: 'route', profile: 'router', status: 'completed' },
      { step: 1, name: 'extract', profile: 'clinical', status: 'started' },
    ],
  })

  const graph = buildProgressGraph(state, 'run-1', new Set())

  assert.equal(graph.nodes.filter((node) => node.data.kind === 'profile').length, 0)
  assert.equal(graph.nodes.some((node) => node.data.kind === 'branch'), false)
  assert.equal(graph.edges.some((edge) => edge.data?.kind === 'ghost'), false)
  const columns = graph.nodes
    .filter((node) => ['input', 'step', 'output'].includes(node.data.kind))
    .map((node) => node.position.x)
  assert.deepEqual(columns.slice(1).map((x, index) => x - columns[index]!), [296, 320, 320])
})

test('pipelines graph keeps every pipeline as a detailed left-to-right lane', () => {
  const state = emptyState()
  state.topology = {
    profiles: [
      { name: 'alpha', mode: 'extract', topology: { stages: [{ name: 'prepare' }, { name: 'call' }] } },
      { name: 'beta', mode: 'extract', topology: { stages: [{ name: 'verify' }] } },
    ],
    pipelines: [
      { name: 'alpha-flow', steps: [{ name: 'extract', profile: 'alpha' }] },
      { name: 'beta-flow', steps: [{ name: 'extract', profile: 'beta' }] },
    ],
  }

  const graph = buildPipelinesGraph(state, undefined, new Set())
  const inputs = graph.nodes.filter((node) => node.data.kind === 'input')
  const steps = graph.nodes.filter((node) => node.data.kind === 'step')
  const profiles = graph.nodes.filter((node) => node.data.kind === 'profile')

  assert.match(graph.title, /^2 pipelines/)
  assert.equal(inputs.length, 2)
  assert.equal(steps.length, 2)
  assert.deepEqual(profiles.map((node) => node.data.profile), ['alpha', 'beta'])
  assert.ok(inputs.every((node) => node.position.x === inputs[0]!.position.x), 'every lane starts in the input column')
  assert.ok(steps.every((node) => node.position.x === steps[0]!.position.x), 'step one shares a column across lanes')
  assert.equal(steps[0]!.position.x - inputs[0]!.position.x, 340)
  assert.equal(new Set(inputs.map((node) => node.position.y)).size, 2, 'pipeline lanes occupy separate rows')
})

test('dashboard graph keeps every pipeline and opens nested route paths by default', () => {
  const state = emptyState()
  state.topology = {
    profiles: [
      {
        name: 'router', mode: 'router', topology: { stages: [{
          name: 'route', kind: 'decision', routes: [
            { name: 'alpha', stages: [{ name: 'alpha-work' }] },
            { name: 'beta', stages: [{ name: 'beta-work' }] },
          ],
        }] },
      },
      { name: 'worker', mode: 'extract', topology: { stages: [{ name: 'extract-work' }] } },
    ],
    pipelines: [
      { name: 'routed-flow', steps: [{ name: 'choose', profile: 'router' }] },
      { name: 'worker-flow', steps: [{ name: 'extract', profile: 'worker' }] },
    ],
  }

  const graph = buildExpandedPipelinesGraph(state, undefined, new Set(), new Set())
  const laneGroups = graph.nodes.filter((node) => node.id.startsWith('pipeline-lane-group-'))
  const alpha = graph.nodes.find((node) => node.data.label === 'alpha')!
  const beta = graph.nodes.find((node) => node.data.label === 'beta')!

  assert.equal(laneGroups.length, 2, 'selection never filters configured pipelines')
  assert.ok(graph.nodes.some((node) => node.data.label === 'alpha-work'))
  assert.ok(graph.nodes.some((node) => node.data.label === 'beta-work'))
  assert.equal(graph.expanded.has(alpha.data.expandKey ?? alpha.id), true)
  assert.equal(graph.expanded.has(beta.data.expandKey ?? beta.id), true)

  const collapsed = buildExpandedPipelinesGraph(
    state,
    undefined,
    new Set(),
    new Set([alpha.data.expandKey ?? alpha.id]),
  )
  assert.equal(collapsed.nodes.some((node) => node.data.label === 'alpha-work'), false, 'an explicit close overrides the default')
  assert.ok(collapsed.nodes.some((node) => node.data.label === 'beta-work'))
})

test('selecting a run paints its lane without hiding other pipelines or routes', () => {
  const state = emptyState()
  state.topology = {
    profiles: [
      { name: 'router', mode: 'router', topology: { stages: [{ name: 'route', kind: 'decision', routes: [
        { name: 'clinical', targetProfile: 'clinical' },
        { name: 'verifier', targetProfile: 'verifier' },
      ] }] } },
      { name: 'clinical', mode: 'extract' },
      { name: 'verifier', mode: 'extract' },
      { name: 'other', mode: 'extract' },
    ],
    pipelines: [
      { name: 'routed-flow', steps: [{ name: 'choose', profile: 'router' }] },
      { name: 'other-flow', steps: [{ name: 'extract', profile: 'other' }] },
    ],
  }
  state.runs.set('run-1', { runId: 'run-1', profile: 'routed-flow', status: 'started' })
  state.routes.push({ runId: 'run-1', profile: 'clinical', confidence: 0.9, reason: 'rule match', ruleVsModel: 'rule' })
  state.pipelines.set('run-1', {
    runId: 'run-1',
    steps: [{ step: 0, name: 'choose', profile: 'router', status: 'completed' }],
  })

  const graph = buildExpandedPipelinesGraph(state, 'run-1', new Set(), new Set())
  assert.equal(graph.nodes.filter((node) => node.id.startsWith('pipeline-lane-group-')).length, 2)
  const clinical = graph.nodes.find((node) => node.data.kind === 'profile' && node.data.profile === 'clinical')!
  const verifier = graph.nodes.find((node) => node.data.kind === 'profile' && node.data.profile === 'verifier')!
  assert.equal(clinical.data.chosen, true)
  assert.equal(clinical.data.muted, false)
  assert.equal(verifier.data.chosen, false)
  assert.equal(verifier.data.muted, true)
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
  const input = graph.nodes.find((n) => n.id === 'input')!
  const firstSteps = graph.nodes.filter((n) => n.id.match(/^pipeline-[^/]+\/step-0$/))
  const outputs = graph.nodes.filter((n) => n.id.match(/^pipeline-[^/]+\/output$/))
  const lanes = graph.nodes.filter((n) => n.id.match(/^pipeline-[^/]+\/lane$/))
  assert.ok(firstSteps.every((step) => step.position.x === firstSteps[0]!.position.x), 'step zero shares one column across pipelines')
  assert.ok(new Set(firstSteps.map((step) => step.position.y)).size === firstSteps.length, 'pipeline alternatives occupy distinct rows')
  assert.equal(firstSteps[0]!.position.x - input.position.x, 340, 'shared input occupies the preceding column')
  assert.ok(outputs.every((output) => output.position.x === outputs[0]!.position.x), 'pipeline outputs share the terminal column')
  assert.ok(lanes[0]!.position.y + Number(lanes[0]!.style?.height) < lanes[1]!.position.y, 'pipeline groups do not overlap')
  assert.deepEqual(
    graph.nodes.filter((n) => n.data.kind === 'profile').map((n) => n.data.profile),
    ['alpha-flow', 'beta-flow', 'router', 'alpha', 'beta'],
  )
  assert.equal(graph.edges.filter((edge) => edge.data?.kind === 'ghost').length, 2, 'router shows every specialist route')
})

test('project graph stacks profile paths while preserving shared step columns', () => {
  const state = emptyState()
  state.topology = {
    profiles: Array.from({ length: 8 }, (_, index) => ({
      name: `worker-${index}`,
      mode: 'extract',
      topology: { stages: [{ name: 'prepare' }, { name: 'llm-call' }, { name: 'verify' }] },
    })),
    pipelines: [],
  }

  const graph = buildProjectGraph(state, undefined, new Set())
  const groups = graph.nodes.filter((node) => node.id.startsWith('profile-group-'))
  const profiles = graph.nodes.filter((node) => node.data.kind === 'profile')
  const prepares = graph.nodes.filter((node) => node.data.label === 'prepare')
  const calls = graph.nodes.filter((node) => node.data.label === 'llm-call')
  const verifies = graph.nodes.filter((node) => node.data.label === 'verify')

  assert.equal(groups.length, 8)
  assert.equal(new Set(profiles.map((profile) => profile.position.x)).size, 1, 'every profile begins in the same column')
  assert.equal(new Set(profiles.map((profile) => profile.position.y)).size, profiles.length, 'profiles stack into separate rows')
  assert.equal(new Set(prepares.map((stage) => stage.position.x)).size, 1, 'first stages share a column')
  assert.equal(new Set(calls.map((stage) => stage.position.x)).size, 1, 'second stages share a column')
  assert.equal(new Set(verifies.map((stage) => stage.position.x)).size, 1, 'third stages share a column')
  assert.equal(prepares[0]!.position.x - profiles[0]!.position.x, 340)
  assert.equal(calls[0]!.position.x - prepares[0]!.position.x, 340)
  assert.equal(verifies[0]!.position.x - calls[0]!.position.x, 340)
  for (const group of groups) {
    const profileName = group.id.slice('profile-group-'.length)
    const profile = graph.nodes.find((node) => node.id === `profile-${profileName}`)!
    assert.ok(profile.position.x >= group.position.x)
    assert.ok(profile.position.y >= group.position.y)
    assert.ok(profile.position.x < group.position.x + Number(group.style?.width))
    assert.ok(profile.position.y < group.position.y + Number(group.style?.height))
  }
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
  assert.equal(chosen.data.traversed, true)
  assert.equal(chosen.data.muted, false)
  assert.equal(unchosen.data.traversed, undefined)
  assert.equal(unchosen.data.muted, true)
  assert.equal(unrelated.data.muted, false, 'profiles outside the declared router are not faded')
  assert.equal(routeEdges.length, 2, 'no route disappears after selection')
  assert.equal(routeEdges.find((edge) => edge.target === 'profile-clinical')?.data?.kind, 'branch')
  assert.equal(routeEdges.find((edge) => edge.target === 'profile-clinical')?.data?.traversed, true)
  assert.equal(routeEdges.find((edge) => edge.target === 'profile-clinical')?.style?.stroke, 'var(--success)')
  assert.equal(routeEdges.find((edge) => edge.target === 'profile-verifier')?.data?.muted, true)
  assert.equal(routeEdges.find((edge) => edge.target === 'profile-verifier')?.style?.opacity, 0.52)
})

test('project graph paints observed workflow stages and their connections as the path taken', () => {
  const state = emptyState()
  state.topology = {
    profiles: [
      { name: 'flow', mode: 'pipeline' },
      { name: 'worker', mode: 'extract', topology: { stages: [{ name: 'prompt-assembly' }, { name: 'llm-call' }] } },
    ],
    pipelines: [{ name: 'flow', steps: [{ name: 'extract', profile: 'worker' }] }],
  }
  state.runs.set('run-1', { runId: 'run-1', profile: 'flow', status: 'started' })
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
  state.stages.set('prepare', {
    stageId: 'prepare', runId: 'run-1', parentId: 'worker', name: 'prompt-assembly', status: 'completed', children: [],
  })
  state.stages.set('model', {
    stageId: 'model', runId: 'run-1', parentId: 'worker', name: 'llm-call', status: 'started', children: [],
  })

  const graph = buildProjectGraph(state, 'run-1', new Set())
  const prepare = graph.nodes.find((node) => node.id === 'blueprint-worker-root-0')!
  const model = graph.nodes.find((node) => node.id === 'blueprint-worker-root-1')!
  const connection = graph.edges.find((edge) => edge.source === prepare.id && edge.target === model.id)

  assert.equal(prepare.data.status, 'done')
  assert.equal(prepare.data.traversed, true)
  assert.equal(model.data.status, 'active')
  assert.equal(model.data.current, true)
  assert.equal(connection?.data?.traversed, true)
  assert.equal(connection?.style?.stroke, 'var(--success)')
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

  const graph = buildProjectGraph(state, undefined, new Set([
    'blueprint-worker-root-0-route-0',
  ]))
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
  const alphaCall = graph.nodes.find((node) => node.data.label === 'alpha-call')!
  const betaCall = graph.nodes.find((node) => node.data.label === 'beta-call')!
  assert.equal(alpha.data.chosen, true)
  assert.equal(alpha.data.muted, false)
  assert.equal(alpha.position.x, beta.position.x, 'parallel routes share one step column')
  assert.equal(alphaCall.position.x, betaCall.position.x, 'equivalent route stages share one step column')
  assert.equal(beta.data.muted, true)
  assert.equal(betaCall.data.muted, true)
})

test('an internal routing node can select more than one path', () => {
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
            { name: 'shock', stages: [{ name: 'classify' }] },
            { name: 'sepsis', stages: [{ name: 'screen' }] },
            { name: 'other', stages: [{ name: 'other-call' }] },
          ],
        }],
      },
    }],
    pipelines: [],
  }
  state.runs.set('run-1', { runId: 'run-1', profile: 'worker', status: 'started' })
  state.stages.set('route-1', {
    stageId: 'route-1', runId: 'run-1', name: 'route', status: 'completed',
    detail: { tasks: ['shock', 'sepsis'] }, children: [],
  })

  const graph = buildProjectGraph(state, 'run-1', new Set())
  const sepsis = graph.nodes.find((node) => node.data.kind === 'branch' && node.data.label === 'sepsis')!
  const shock = graph.nodes.find((node) => node.data.kind === 'branch' && node.data.label === 'shock')!
  const other = graph.nodes.find((node) => node.data.kind === 'branch' && node.data.label === 'other')!
  const classify = graph.nodes.find((node) => node.data.label === 'classify')!
  const continuation = graph.edges.find((edge) => edge.source === classify.id && edge.target === sepsis.id)

  assert.equal(sepsis.data.chosen, true)
  assert.equal(sepsis.data.muted, false)
  assert.equal(shock.data.chosen, true)
  assert.equal(shock.data.muted, false)
  assert.equal(continuation?.data?.kind, 'branch')
  assert.ok(sepsis.position.x > classify.position.x, 'the second workflow follows the first')
  assert.equal(other.data.chosen, false)
  assert.equal(other.data.muted, true)
})

test('a route that feeds a sibling is laid out upstream and selects the shared continuation', () => {
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
            { name: 'prepare', stages: [{ name: 'parse' }], feeds: 'classify' },
            { name: 'classify', stages: [{ name: 'infer' }] },
            { name: 'other', stages: [{ name: 'other-call' }] },
          ],
        }],
      },
    }],
    pipelines: [],
  }
  state.runs.set('run-1', { runId: 'run-1', profile: 'worker', status: 'started' })
  state.stages.set('route-1', {
    stageId: 'route-1', runId: 'run-1', name: 'route', status: 'completed', detail: { task: 'prepare' }, children: [],
  })

  const graph = buildProjectGraph(state, 'run-1', new Set())
  const prepare = graph.nodes.find((node) => node.data.kind === 'branch' && node.data.label === 'prepare')!
  const parse = graph.nodes.find((node) => node.data.label === 'parse')!
  const classify = graph.nodes.find((node) => node.data.kind === 'branch' && node.data.label === 'classify')!
  const other = graph.nodes.find((node) => node.data.kind === 'branch' && node.data.label === 'other')!
  const feed = graph.edges.find((edge) => edge.source === parse.id && edge.target === classify.id)

  assert.ok(classify.position.x > parse.position.x, 'the consumer sits after its producer')
  assert.equal(classify.position.x - parse.position.x, 340, 'a feed advances exactly one step column')
  assert.equal(other.position.x, prepare.position.x, 'an unrelated alternative stays in the route column')
  assert.equal(classify.position.y, prepare.position.y, 'the dependency reads as one horizontal workflow')
  assert.equal(classify.data.chosen, true, 'selecting the producer also selects its continuation')
  assert.equal(feed?.data?.kind, 'branch', 'the selected dependency is visibly connected')
  assert.equal(other.data.muted, true, 'unrelated sibling routes remain de-emphasised')
})
