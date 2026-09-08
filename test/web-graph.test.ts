/** The browser graph's model stays deterministic and testable without a renderer. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph } from '../web/src/lib/graph.ts'
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
  assert.equal(group?.data.label, '1 stage · extract')
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
