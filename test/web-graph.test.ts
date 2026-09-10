/** The browser graph's model stays deterministic and testable without a renderer. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCompactGraph,
  buildExpandedPipelinesGraph,
  buildGraph,
  buildPipelinesGraph,
  buildProgressGraph,
  buildProjectGraph,
  compactStepKey,
  layoutHeightOf,
  ROW_GAP,
  COMPACT_HEADER_H,
  COMPACT_PROGRESS_H,
  COMPACT_STAGE_H,
  COMPACT_STAGES_EXTRAS_H,
  COMPACT_STEP_H,
  COMPACT_TERMINAL_H,
} from '../web/src/lib/graph/index.ts'
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

  assert.equal(step?.data.current, true, 'the summary step remains in the active lineage')
  assert.equal(leaf?.data.current, true, 'the active leaf remains in the active lineage')
  assert.equal(step?.data.currentOperation, false, 'the active ancestor does not claim NOW')
  assert.equal(leaf?.data.currentOperation, true, 'the deepest visible active stage claims NOW')
  assert.ok(step!.position.x < leaf!.position.x, 'the live stage follows its owning step')
  assert.equal(step!.position.y, leaf!.position.y, 'the execution trail stays on one axis')
  assert.equal(graph.nodes.some((n) => n.data.kind === 'group'), false, 'the trail needs no secondary detail lane')
  assert.equal(input?.data.status, 'done', 'run.started means input preparation has finished')
  assert.equal(input?.data.current, undefined, 'input is not current for the whole run')
  assert.equal(output?.data.status, 'idle', 'output remains pending while work is in flight')
  assert.equal(output?.data.current, undefined, 'output is not current before the run settles')

  const collapsed = buildGraph(state, 'run-1', new Set())
  assert.equal(collapsed.nodes.find((n) => n.id === 'step-0')?.data.currentOperation, true, 'a collapsed step represents its hidden current stage')
  assert.equal(collapsed.nodes.filter((n) => n.data.currentOperation).length, 1, 'only one visible node claims NOW')

  const composed = buildExpandedPipelinesGraph(state, 'run-1', new Set(), new Set())
  assert.equal(composed.nodes.filter((n) => n.data.currentOperation).length, 1, 'composed topology overlays do not duplicate NOW')

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
            { name: 'extraction', ref: 'step-0.output' },
          ],
        },
      ],
    }],
  }

  const graph = buildProgressGraph(state, undefined, new Set(), 'verified-flow')
  const verify = graph.nodes.find((node) => node.id === 'step-1')
  const transfer = graph.edges.find((edge) => edge.target === 'step-1')

  assert.equal(verify?.data.inputRef, 'document ← initial · extraction ← step-0.output')
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

test('pipeline graph keeps every workflow as a detailed left-to-right lane', () => {
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

  assert.match(graph.title, /^1 pipeline · 2 workflows/)
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
  const firstLaneBottom = laneGroups[0]!.position.y + Number(laneGroups[0]!.style?.height)
  assert.ok(laneGroups[1]!.position.y - firstLaneBottom >= 32, 'pipeline groups keep a clear section gutter')
  for (const lane of laneGroups) {
    const prefix = `pipeline-lane-${lane.id.slice('pipeline-lane-group-'.length)}/`
    const nested = graph.nodes.filter((node) => node.data.kind === 'group' && node.id.startsWith(prefix))
    const laneRight = lane.position.x + Number(lane.style?.width)
    const laneBottom = lane.position.y + Number(lane.style?.height)
    assert.ok(nested.every((node) => node.position.x >= lane.position.x + 20))
    assert.ok(nested.every((node) => node.position.x + Number(node.style?.width) <= laneRight - 20))
    assert.ok(nested.every((node) => node.position.y >= lane.position.y + 24))
    assert.ok(nested.every((node) => node.position.y + Number(node.style?.height) <= laneBottom - 20))
  }

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

test('expanded runtime stages keep the pipeline output after the complete trail', () => {
  const state = emptyState()
  state.topology = {
    profiles: [
      { name: 'flow', mode: 'pipeline' },
      { name: 'worker', mode: 'extract', topology: { stages: [{ name: 'prompt-assembly' }, { name: 'llm-call' }] } },
    ],
    pipelines: [{ name: 'flow', steps: [{ name: 'extract', profile: 'worker', input: 'initial' }] }],
  }
  state.runs.set('run-1', { runId: 'run-1', profile: 'flow', status: 'completed', wallMs: 1200 })
  state.pipelines.set('run-1', {
    runId: 'run-1',
    steps: [{ step: 0, name: 'extract', profile: 'worker', status: 'completed', wallMs: 900 }],
  })
  state.stages.set('pipeline', {
    stageId: 'pipeline', runId: 'run-1', name: 'pipeline', status: 'completed', children: [],
  })
  state.stages.set('worker', {
    stageId: 'worker', runId: 'run-1', parentId: 'pipeline', name: 'worker', status: 'completed', detail: { step: 0 }, children: [],
  })
  state.stages.set('prepare', {
    stageId: 'prepare', runId: 'run-1', parentId: 'worker', name: 'prompt-assembly', status: 'completed', children: [],
  })
  state.stages.set('model', {
    stageId: 'model', runId: 'run-1', parentId: 'worker', name: 'llm-call', status: 'completed', children: [],
  })

  const graph = buildExpandedPipelinesGraph(state, 'run-1', new Set(), new Set())
  const execution = graph.nodes.filter((node) => node.id.startsWith('pipeline-lane-flow/pipeline-flow/'))
  const output = execution.find((node) => node.data.kind === 'output')!
  const predecessors = execution.filter((node) => node.data.kind !== 'output' && node.data.kind !== 'group')

  const widthOf = (node: (typeof predecessors)[number]): number =>
    node.data.kind === 'step' ? 264 : node.data.kind === 'stage' || node.data.kind === 'route' ? 248 : 240
  const sameRow = predecessors.filter((node) => node.position.y === output.position.y)

  assert.ok(sameRow.length > 2, 'the regression requires expanded runtime stages')
  assert.ok(
    sameRow.every((node) => node.position.x + widthOf(node) + 56 <= output.position.x),
    'output keeps a full trail gutter after every preceding operation',
  )
})

test('project graph renders every configured pipeline and profile before any run', () => {
  const state = emptyState()
  state.topology = {
    profiles: [
      { name: 'alpha-flow', mode: 'pipeline' },
      { name: 'beta-flow', mode: 'pipeline' },
      { name: 'router', mode: 'router', topology: { stages: [{ name: 'route', kind: 'decision', routes: [
        { name: 'alpha', targetProfile: 'alpha' },
        { name: 'beta', targetProfile: 'beta' },
      ] }] } },
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
  const stepGhosts = graph.edges.filter((edge) => edge.source === 'pipeline-alpha-flow/step-0' && edge.data?.kind === 'ghost')
  assert.deepEqual(
    stepGhosts.map((edge) => edge.target).sort(),
    ['profile-alpha', 'profile-beta'],
    'the router step fans only to its declared specialist routes',
  )
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
  assert.equal(routeEdges.find((edge) => edge.target === 'profile-clinical')?.style?.stroke, 'var(--route-selected)')
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
  assert.equal(connection?.style?.stroke, 'var(--route-selected)')
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

/* ------------------------------------------------------------------ compact graph */

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
  pipelines: [
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
  state.pipelines.set('run-1', {
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
  assert.equal(branch.style?.stroke, 'var(--route-selected)')
  assert.equal(ghost.data?.kind, 'ghost')
  assert.equal(graph.edges.filter((edge) => edge.data?.kind === 'branch').length, 1, 'exactly one workflow is highlighted')
})

test('compact graph keeps composed input references human-readable', () => {
  const state = emptyState()
  state.topology = {
    profiles: [{ name: 'verifier', mode: 'extract' }],
    pipeline: { router: 'workflow-router', workflows: ['verified'], defaultWorkflow: 'verified' },
    pipelines: [{
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
    pipelines: [{ name: 'clinical-verified', steps: [{ name: 'verify', profile: 'verifier', input: 'initial' }] }],
  }
  state.runs.set('run-1', { runId: 'run-1', profile: 'clinical-verified', status: 'started' })
  state.routes.push({ runId: 'run-1', profile: 'clinical-verified', confidence: 0.9, reason: 'default', ruleVsModel: 'rule' })
  state.pipelines.set('run-1', {
    runId: 'run-1',
    steps: [{ step: 0, name: 'verify', profile: 'verifier', status: 'started' }],
  })
  state.stages.set('pipeline', {
    stageId: 'pipeline', runId: 'run-1', name: 'pipeline', status: 'started', children: [],
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
    pipelines: [{
      name: 'router-flow',
      steps: [
        { name: 'route', profile: 'workflow-router' },
        { name: 'extract', profile: 'clinical' },
      ],
    }],
  }
  state.runs.set('run-1', { runId: 'run-1', profile: 'router-flow', status: 'started' })
  state.pipelines.set('run-1', {
    runId: 'run-1',
    steps: [
      { step: 0, name: 'route', profile: 'workflow-router', status: 'completed' },
      { step: 1, name: 'extract', profile: 'clinical', status: 'started' },
    ],
  })
  state.stages.set('pipeline', {
    stageId: 'pipeline', runId: 'run-1', name: 'pipeline', status: 'started', children: [],
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
    pipelines: [{ name: 'wf', steps: [{ name: 'work', profile: 'worker' }] }],
  }

  const active = emptyState()
  active.topology = defs
  active.runs.set('run-1', { runId: 'run-1', profile: 'wf', status: 'started' })
  active.pipelines.set('run-1', { runId: 'run-1', steps: [{ step: 0, name: 'work', profile: 'worker', status: 'started' }] })
  assert.equal(buildCompactGraph(active, 'run-1', new Set()).nodes.find((node) => node.id === 'compact-run-1')!.data.status, 'active')

  const done = emptyState()
  done.topology = defs
  done.runs.set('run-1', { runId: 'run-1', profile: 'wf', status: 'completed', wallMs: 1200 })
  done.pipelines.set('run-1', { runId: 'run-1', steps: [{ step: 0, name: 'work', profile: 'worker', status: 'completed', ok: true }] })
  assert.equal(buildCompactGraph(done, 'run-1', new Set()).nodes.find((node) => node.id === 'compact-run-1')!.data.status, 'done')

  const failed = emptyState()
  failed.topology = defs
  failed.runs.set('run-1', { runId: 'run-1', profile: 'wf', status: 'failed' })
  failed.pipelines.set('run-1', { runId: 'run-1', steps: [{ step: 0, name: 'work', profile: 'worker', status: 'completed', ok: true }] })
  assert.equal(buildCompactGraph(failed, 'run-1', new Set()).nodes.find((node) => node.id === 'compact-run-1')!.data.status, 'failed')

  const stopped = emptyState()
  stopped.topology = defs
  stopped.runs.set('run-1', { runId: 'run-1', profile: 'wf', status: 'completed' })
  stopped.pipelines.set('run-1', { runId: 'run-1', steps: [{ step: 0, name: 'work', profile: 'worker', status: 'completed', ok: true }], stoppedEarly: true })
  assert.equal(buildCompactGraph(stopped, 'run-1', new Set()).nodes.find((node) => node.id === 'compact-run-1')!.data.status, 'failed')

  const emptyCompleted = emptyState()
  emptyCompleted.topology = defs
  emptyCompleted.runs.set('run-1', { runId: 'run-1', profile: 'wf', status: 'completed' })
  emptyCompleted.pipelines.set('run-1', { runId: 'run-1', steps: [] })
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
    pipelines: [{ name: 'wf', steps: [{ name: 'work', profile: 'worker' }] }],
  }
  state.runs.set('run-1', { runId: 'run-1', profile: 'wf', status: 'started' })
  state.pipelines.set('run-1', { runId: 'run-1', steps: [{ step: 0, name: 'work', profile: 'worker', status: 'started' }] })
  state.stages.set('pipeline', {
    stageId: 'pipeline', runId: 'run-1', name: 'pipeline', status: 'started', children: [],
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
    pipelines: [{ name: 'present', steps: [{ name: 'work', profile: 'worker' }] }],
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
    pipelines: [
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
  state.pipelines.set('run-1', { runId: 'run-1', steps: [{ step: 0, name: 'step', profile: 'worker', status: 'started' }] })

  const graph = buildCompactGraph(state, 'run-1', new Set())
  assert.equal(graph.nodes.length, 1)
  assert.equal(graph.nodes[0]!.data.kind, 'compact-pipeline')
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
    pipelines: [
      { name: 'clinical-verified', steps: [{ name: 'extract', profile: 'clinical' }] },
      { name: 'coding-verified', steps: [{ name: 'extract', profile: 'coding' }] },
      { name: 'standalone', steps: [{ name: 'work', profile: 'worker' }] },
    ],
  }
  state.runs.set('run-1', { runId: 'run-1', profile: 'clinical-verified', status: 'started' })
  state.routes.push({ runId: 'run-1', profile: 'clinical-verified', confidence: 0.9, reason: 'default', ruleVsModel: 'rule' })
  state.pipelines.set('run-1', { runId: 'run-1', steps: [{ step: 0, name: 'extract', profile: 'clinical', status: 'started' }] })

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
const compactExpansionState = () => {
  const state = emptyState()
  state.topology = compactGateway()
  state.runs.set('run-1', { runId: 'run-1', profile: 'clinical-verified', status: 'completed', wallMs: 12 })
  state.routes.push({ runId: 'run-1', profile: 'clinical-verified', confidence: 0.87, reason: 'default workflow', ruleVsModel: 'rule' })
  state.pipelines.set('run-1', {
    runId: 'run-1',
    steps: [
      { step: 0, name: 'extract medications', profile: 'clinical', status: 'completed', ok: true },
      { step: 1, name: 'verify', profile: 'coding', status: 'completed', ok: true },
    ],
  })
  state.stages.set('pipeline', { stageId: 'pipeline', runId: 'run-1', name: 'pipeline', status: 'completed', children: [] })
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
    .filter((node) => node.data.kind === 'compact-pipeline')
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

test('compact graph keeps card positions stable with no disclosures open', () => {
  const state = compactExpansionState()
  const graph = buildCompactGraph(state, 'run-1', new Set())
  const gateway = graph.nodes.find((node) => node.id === 'gateway')!
  const run = graph.nodes.find((node) => node.id === 'compact-run-1')!
  const coding = graph.nodes.find((node) => node.id === 'compact-configured-coding-verified')!

  assert.equal(gateway.position.y, 40, 'the gateway never moves when a workflow below it grows')
  assert.equal(layoutHeightOf(run), COMPACT_BASE_H + 2 * COMPACT_STEP_H, 'collapsed height counts header, terminals, and step rows only')
  assert.equal(run.position.y, 40 + layoutHeightOf(gateway) + ROW_GAP)
  assert.equal(coding.position.y, run.position.y + layoutHeightOf(run) + ROW_GAP, 'with nothing open the catalogue order advances as before')
  assert.deepEqual(graph.nodes.map((node) => node.id), ['gateway', 'compact-run-1', 'compact-configured-coding-verified'])
})

test('expanding compact step 0 adds the complete stage block to the workflow height', () => {
  const state = compactExpansionState()
  const collapsed = buildCompactGraph(state, 'run-1', new Set())
  const key = compactStepKey('compact-run-1', 0)
  const expanded = buildCompactGraph(state, 'run-1', new Set([key]))

  const collapsedNode = collapsed.nodes.find((node) => node.id === 'compact-run-1')!
  const expandedNode = expanded.nodes.find((node) => node.id === 'compact-run-1')!
  const step = expandedNode.data.steps![0]!
  assert.equal(step.expanded, true)
  assert.equal(step.stageRowCount, 4, 'every visible stage row inside the disclosed step counts')
  assert.equal(layoutHeightOf(expandedNode) - layoutHeightOf(collapsedNode), COMPACT_STAGES_EXTRAS_H + 4 * COMPACT_STAGE_H)
})

test('expanding a compact step pushes the next workflow by exactly the added height', () => {
  const state = compactExpansionState()
  const graph = buildCompactGraph(state, 'run-1', new Set([compactStepKey('compact-run-1', 0)]))
  const run = graph.nodes.find((node) => node.id === 'compact-run-1')!
  const coding = graph.nodes.find((node) => node.id === 'compact-configured-coding-verified')!

  assert.equal(coding.position.y, run.position.y + layoutHeightOf(run) + ROW_GAP, 'the following card steps over the full expanded height')
  assert.ok(run.position.y + layoutHeightOf(run) <= coding.position.y - ROW_GAP)
})

test('expanding two compact steps is additive and each collapse removes exactly its contribution', () => {
  const state = compactExpansionState()
  const key0 = compactStepKey('compact-run-1', 0)
  const key1 = compactStepKey('compact-run-1', 1)
  const collapsedHeight = layoutHeightOf(buildCompactGraph(state, 'run-1', new Set()).nodes.find((node) => node.id === 'compact-run-1')!)

  const step0Block = COMPACT_STAGES_EXTRAS_H + 4 * COMPACT_STAGE_H
  const step1Block = COMPACT_STAGES_EXTRAS_H + 1 * COMPACT_STAGE_H

  const only0 = buildCompactGraph(state, 'run-1', new Set([key0])).nodes.find((node) => node.id === 'compact-run-1')!
  const only1 = buildCompactGraph(state, 'run-1', new Set([key1])).nodes.find((node) => node.id === 'compact-run-1')!
  const both = buildCompactGraph(state, 'run-1', new Set([key0, key1])).nodes.find((node) => node.id === 'compact-run-1')!

  assert.equal(layoutHeightOf(only0) - collapsedHeight, step0Block)
  assert.equal(layoutHeightOf(only1) - collapsedHeight, step1Block)
  assert.equal(layoutHeightOf(both) - collapsedHeight, step0Block + step1Block, 'each disclosure owns its own stage container and rows')
})

test('nested compact stage depth changes indentation, never height or order', () => {
  const state = compactExpansionState()
  const graph = buildCompactGraph(state, 'run-1', new Set([compactStepKey('compact-run-1', 0)]))
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
    pipelines: [
      { name: 'aflow', steps: [{ name: 'work', profile: 'a' }] },
      { name: 'bflow', steps: [{ name: 'work', profile: 'b' }] },
    ],
  }
  asserts.push({ title: 'standalone', graph: buildCompactGraph(standalone, undefined, new Set()) })

  const direct = emptyState()
  direct.runs.set('run-1', { runId: 'run-1', profile: 'direct', status: 'completed', wallMs: 5 })
  direct.pipelines.set('run-1', { runId: 'run-1', steps: [{ step: 0, name: 'work', profile: 'worker', status: 'completed', ok: true }] })
  direct.stages.set('pipeline', { stageId: 'pipeline', runId: 'run-1', name: 'pipeline', status: 'completed', children: [] })
  direct.stages.set('worker', {
    stageId: 'worker', runId: 'run-1', parentId: 'pipeline', name: 'worker', status: 'completed', detail: { step: 0 }, children: [],
  })
  direct.stages.set('leaf', { stageId: 'leaf', runId: 'run-1', parentId: 'worker', name: 'llm-call', status: 'completed', children: [] })
  asserts.push({ title: 'direct-run', graph: buildCompactGraph(direct, 'run-1', new Set([compactStepKey('compact-run-1', 0)])) })

  const missing = emptyState()
  missing.topology = {
    profiles: [{ name: 'workflow-router', mode: 'router' }],
    pipeline: { router: 'workflow-router', workflows: ['present', 'absent'], defaultWorkflow: 'present' },
    pipelines: [{ name: 'present', steps: [{ name: 'work', profile: 'worker' }] }],
  }
  asserts.push({ title: 'missing-definition', graph: buildCompactGraph(missing, undefined, new Set()) })

  for (const { title, graph } of asserts) {
    const keys = graph.nodes.flatMap((node) => (node.data.steps ?? []).map((step) => step.expandKey).filter(Boolean))
    assert.equal(new Set(keys).size, keys.length, `${title}: every disclosure key is unique per rendered workflow`)
    assertNoCompactOverlap(graph.nodes)
  }

  for (const { title, graph } of asserts) {
    assert.equal(graph.nodes.filter((node) => node.data.kind !== 'gateway' && node.data.kind !== 'compact-pipeline').length, 0, `${title}: only gateway and workflow cards exist`)
  }
  const directGraph = asserts.find((a) => a.title === 'direct-run')!.graph
  assert.equal(layoutHeightOf(directGraph.nodes[0]!), COMPACT_BASE_H + 1 * COMPACT_STEP_H + COMPACT_STAGES_EXTRAS_H + 1 * COMPACT_STAGE_H, 'a direct run expands exactly like a catalogued workflow')
})

test('compact graph returns the same expanded set the steps paint', () => {
  const state = compactExpansionState()
  const key0 = compactStepKey('compact-run-1', 0)
  const key1 = compactStepKey('compact-run-1', 1)
  const graph = buildCompactGraph(state, 'run-1', new Set([key0]))

  const painted = new Set<string>()
  for (const node of graph.nodes) {
    for (const step of node.data.steps ?? []) {
      if (step.expandKey && step.expanded) painted.add(step.expandKey)
    }
  }
  assert.deepEqual([...graph.expanded].sort(), [...painted].sort(), 'the view-level set is the union of the steps held open')
  assert.equal(graph.expanded.has(key0), true)
  assert.equal(graph.expanded.has(key1), false, 'a closed step never leaks into the view-level set')
  assert.equal(compactStepKey('compact-run-1', 3), 'compact-run-1/step-3')
})
