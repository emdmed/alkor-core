/**
 * Compact graph builder: each pipeline as one container node with all steps listed
 * inside it. Dramatically reduces canvas size while keeping all workflow steps
 * visible at all times.
 */
import { stageTreeForRun } from '../../../../src/tui/state.ts'
import type { PipelineStepEntry, ProjectState, RunEntry, StageEntry } from '../../../../src/tui/state.ts'
import { MAIN_X, MAIN_Y, ROW_GAP, flowEdge, layoutHeightOf, layoutWidthOf, llmOf, node, obj, operationFor, shortDigest, stageState, stepIndexOf } from './core.ts'
import { declaredRouteTargets, matchTopology, routeForRun } from './run.ts'
import type { CompactStageData, CompactStepData, ExpandedGraphBuild, GraphBuild, GraphEdge, GraphNode } from './types.ts'

/* ------------------------------------------------------------------ compact step data */

const compactStages = (stages: StageEntry[], requests: Map<string, unknown>): CompactStageData[] =>
  stages.map((s) => {
    const llmData = llmOf(s, requests as Parameters<typeof llmOf>[1])
    return {
      name: s.name,
      status: stageState(s, requests as Parameters<typeof stageState>[1]),
      wallMs: s.wallMs,
      operation: operationFor(s.name, s.name === 'route'),
      llm: llmData,
      detailText: s.name !== 'llm-call' ? undefined : undefined,
    }
  })

const buildCompactSteps = (state: ProjectState, run: RunEntry, tree: StageEntry[], expanded: Set<string>): CompactStepData[] => {
  const entry = state.pipelines.get(run.runId)
  const def = matchTopology(state, entry)
  const route = routeForRun(state, run.runId, tree)
  const pipelineRoot = tree.find((n) => n.name === 'pipeline' && n.parentId === undefined)

  const defSteps = def?.steps ?? []
  const executed = entry?.steps ?? []
  const n = Math.max(executed.length, defSteps.length)
  const steps: CompactStepData[] = []

  const profileMode = (profile: string): string | undefined =>
    state.topology.profiles.find((p) => p.name === profile)?.mode

  for (let i = 0; i < n; i++) {
    const ex = executed.find((e) => e.step === i)
    const d = defSteps[i]
    const name = ex?.name ?? d?.name ?? `step ${i + 1}`
    const profile = ex?.profile ?? d?.profile ?? '?'
    const status: CompactStepData['status'] = !ex ? 'idle' : ex.status === 'started' ? 'active' : ex.ok === false ? 'failed' : 'done'
    const isRouter = profileMode(profile) === 'router'

    const stageEntries = pipelineRoot?.children.find((c) => stepIndexOf(c) === i)
    const stages = stageEntries ? compactStages(stageEntries.children, state.llmRequests) : []

    steps.push({
      name,
      profile,
      status,
      stepNo: i,
      wallMs: ex?.wallMs,
      router: isRouter,
      chosenProfile: isRouter ? route.profile : undefined,
      confidence: isRouter ? route.confidence : undefined,
      ruleVsModel: isRouter ? route.ruleVsModel : undefined,
      reason: isRouter ? route.reason : undefined,
      stages,
    })
  }
  return steps
}

/* ------------------------------------------------------------------ compact node builder */

const COMPACT_W = 420

const buildCompactPipelineNode = (
  state: ProjectState,
  run: RunEntry,
  tree: StageEntry[],
  expanded: Set<string>,
): GraphNode => {
  const steps = buildCompactSteps(state, run, tree, expanded)

  const hasActive = steps.some((s) => s.status === 'active')
  const allDone = steps.every((s) => s.status === 'done')
  const anyFailed = steps.some((s) => s.status === 'failed')
  const pipelineStatus: CompactStepData['status'] = hasActive ? 'active' : anyFailed ? 'failed' : allDone ? 'done' : 'idle'

  return node(`compact-${run.runId}`, 'compact-pipeline', `${run.profile} pipeline`, pipelineStatus, {
    profile: run.profile,
    wallMs: run.wallMs,
    runId: run.runId,
    steps,
    operation: 'orchestrator',
  })
}

const buildIdleCompactPipeline = (state: ProjectState, def: { name: string; steps: Array<{ name: string; profile: string }> }): GraphNode => {
  const steps: CompactStepData[] = def.steps.map((s, i) => ({
    name: s.name,
    profile: s.profile,
    status: 'idle' as const,
    stepNo: i,
    stages: [],
  }))

  return node(`compact-configured-${def.name}`, 'compact-pipeline', `${def.name} pipeline`, 'idle', {
    profile: def.name,
    steps,
    operation: 'orchestrator',
  })
}

/* ------------------------------------------------------------------ compact graph builder */

export const buildCompactGraph = (
  state: ProjectState,
  runId: string | undefined,
  _expanded: Set<string>,
): ExpandedGraphBuild => {
  const selected = runId ? state.runs.get(runId) : undefined

  if (state.topology.pipelines.length === 0) {
    if (!selected) return { nodes: [], edges: [], title: '', expanded: _expanded }
    const tree = stageTreeForRun(state.stages, selected.runId)
    const compactNode = buildCompactPipelineNode(state, selected, tree, _expanded)
    compactNode.position = { x: MAIN_X, y: MAIN_Y }
    return { nodes: [compactNode], edges: [], title: `run ${selected.profile} · compact`, expanded: _expanded }
  }

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  let yOffset = MAIN_Y

  for (const def of state.topology.pipelines) {
    const isSelected = selected?.profile === def.name
    const compactNode = isSelected
      ? buildCompactPipelineNode(state, selected!, stageTreeForRun(state.stages, selected!.runId), _expanded)
      : buildIdleCompactPipeline(state, def)
    compactNode.position = { x: MAIN_X, y: yOffset }
    nodes.push(compactNode)
    yOffset += layoutHeightOf(compactNode) + ROW_GAP
  }

  // A direct profile run that doesn't match a configured pipeline
  if (selected && !state.topology.pipelines.some((p) => p.name === selected.profile)) {
    const tree = stageTreeForRun(state.stages, selected.runId)
    const compactNode = buildCompactPipelineNode(state, selected, tree, _expanded)
    compactNode.position = { x: MAIN_X, y: yOffset }
    nodes.push(compactNode)
  }

  // Connect compact pipeline nodes vertically when there are multiple
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push(flowEdge(nodes[i]!, nodes[i + 1]!, 'data'))
  }

  const count = nodes.length
  const runTitle = selected ? ` · run ${selected.profile} ${shortDigest(selected.runId)}` : ''
  return {
    nodes,
    edges,
    title: `${count} pipeline${count === 1 ? '' : 's'} · compact view${runTitle}`,
    expanded: _expanded,
  }
}
