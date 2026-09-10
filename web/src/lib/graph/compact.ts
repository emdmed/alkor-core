/**
 * Compact graph builder: one gateway node representing the product pipeline front
 * door, branching to one compact card per workflow. Workflows are independent and
 * never feed each other. The gateway owns the routing decision; each workflow card
 * shows its own steps and their observed data.
 */
import { stageTreeForRun } from '../../../../src/tui/state.ts'
import type { PipelineDefinition, PipelineStepEntry, ProjectState, RunEntry, StageEntry } from '../../../../src/tui/state.ts'
import { MAIN_X, MAIN_Y, ROW_GAP, detailTextOf, flowEdge, layoutHeightOf, llmOf, node, obj, operationFor, shortDigest, stageState, stepIndexOf } from './core.ts'
import { inputReference, matchTopology, routeForRun } from './run.ts'
import type { CompactStageData, CompactStepData, ExpandedGraphBuild, GraphEdge, GraphNode } from './types.ts'

/* ------------------------------------------------------------------ compact step data */

const compactStages = (stages: StageEntry[], requests: Map<string, unknown>, depth = 0): CompactStageData[] =>
  stages.flatMap((s) => {
    const llmData = llmOf(s, requests as Parameters<typeof llmOf>[1])
    const self: CompactStageData = {
      stageId: s.stageId,
      name: s.name,
      status: stageState(s, requests as Parameters<typeof stageState>[1]),
      depth,
      wallMs: s.wallMs,
      operation: operationFor(s.name, s.name === 'route'),
      llm: llmData,
      detailText: s.name !== 'llm-call' ? String(detailTextOf(s.detail)).slice(0, 80) || undefined : undefined,
    }
    const children = s.children.length > 0 ? compactStages(s.children, requests, depth + 1) : []
    return [self, ...children]
  })

/** The destination a step-local route stage decided on, if its subtree has one. */
const stageRouteDecision = (root?: StageEntry): { profile?: string; task?: string; confidence?: number; reason?: string } => {
  if (!root) return {}
  const visit = (s: StageEntry): { profile?: string; task?: string; confidence?: number; reason?: string } | undefined => {
    if (s.name === 'route') {
      const d = obj(s.detail) ?? {}
      const profile = typeof d['profile'] === 'string' ? d['profile'] as string : undefined
      const task = typeof d['task'] === 'string' ? d['task'] as string : undefined
      if (profile || task) {
        const confidence = typeof d['confidence'] === 'number' ? d['confidence'] as number : undefined
        const reason = typeof d['reason'] === 'string' ? d['reason'] as string : undefined
        return { profile, task, confidence: confidence != null && confidence > 1 ? confidence / 100 : confidence, reason }
      }
    }
    for (const child of s.children) {
      const found = visit(child)
      if (found) return found
    }
    return undefined
  }
  return visit(root) ?? {}
}

const buildCompactSteps = (state: ProjectState, run: RunEntry, tree: StageEntry[], expanded: Set<string>): CompactStepData[] => {
  const entry = state.pipelines.get(run.runId)
  const def = matchTopology(state, entry, run.profile)
  const pipelineRoot = tree.find((n) => n.name === 'pipeline' && n.parentId === undefined)

  const defSteps = def?.steps ?? []
  const executed = entry?.steps ?? []
  const n = Math.max(executed.length, defSteps.length)
  const steps: CompactStepData[] = []

  for (let i = 0; i < n; i++) {
    const ex = executed.find((e) => e.step === i)
    const d = defSteps[i]
    const name = ex?.name ?? d?.name ?? `step ${i + 1}`
    const profile = ex?.profile ?? d?.profile ?? '?'
    const status: CompactStepData['status'] = !ex ? 'idle' : ex.status === 'started' ? 'active' : ex.ok === false ? 'failed' : 'done'

    // Derive inputRef from executed step or definition
    const exInput = ex?.input
    const dInput = d?.input
    const inputRef = inputReference(exInput) ?? inputReference(dInput) ?? (i === 0 ? 'initial' : `step-${i - 1}.output`)

    const stageEntries = pipelineRoot?.children.find((c) => stepIndexOf(c) === i)

    // Show step-level route information ONLY when this step's own stage subtree
    // contains a genuine routing decision. A profile implemented using router mode
    // is not itself the product workflow decision.
    const stepRoute = stageRouteDecision(stageEntries)
    const isRouter = Boolean(stepRoute.profile || stepRoute.task)

    const stages = stageEntries ? compactStages(stageEntries.children, state.llmRequests) : []

    steps.push({
      name,
      profile,
      status,
      stepNo: i,
      wallMs: ex?.wallMs,
      inputRef,
      router: isRouter,
      chosenProfile: isRouter ? (stepRoute.profile ?? stepRoute.task) : undefined,
      confidence: isRouter ? stepRoute.confidence : undefined,
      ruleVsModel: isRouter ? undefined : undefined,
      reason: isRouter ? stepRoute.reason : undefined,
      stages,
    })
  }
  return steps
}

/* ------------------------------------------------------------------ compact pipeline node builder */

const buildCompactPipelineNode = (
  state: ProjectState,
  run: RunEntry,
  tree: StageEntry[],
  expanded: Set<string>,
): GraphNode => {
  const steps = buildCompactSteps(state, run, tree, expanded)
  const entry = state.pipelines.get(run.runId)

  const hasActive = steps.some((s) => s.status === 'active')
  const anyFailed = steps.some((s) => s.status === 'failed')
  const allDone = steps.length > 0 && steps.every((s) => s.status === 'done')
  // Authoritative status: a failed run is failed even if every step row looks done;
  // a run that completed without producing any step row never reads as done.
  const pipelineStatus: CompactStepData['status'] =
    run.status === 'failed' ? 'failed'
    : hasActive ? 'active'
    : anyFailed ? 'failed'
    : entry?.stoppedEarly ? 'failed'
    : allDone ? 'done'
    : 'idle'

  return node(`compact-${run.runId}`, 'compact-pipeline', `${run.profile} workflow`, pipelineStatus, {
    profile: run.profile,
    wallMs: run.wallMs,
    runId: run.runId,
    steps,
    operation: 'orchestrator',
  })
}

const buildIdleCompactPipeline = (def: PipelineDefinition): GraphNode => {
  const steps: CompactStepData[] = def.steps.map((s, i) => ({
    name: s.name,
    profile: s.profile,
    status: 'idle' as const,
    stepNo: i,
    inputRef: inputReference(s.input) ?? (i === 0 ? 'initial' : `step-${i - 1}.output`),
    stages: [],
  }))

  return node(`compact-configured-${def.name}`, 'compact-pipeline', `${def.name} workflow`, 'idle', {
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
  const gateway = state.topology.pipeline

  // Nothing to show: no product gateway, no configured workflows, and no running pipeline.
  if (!gateway && state.topology.pipelines.length === 0 && !selected) {
    return { nodes: [], edges: [], title: '', expanded: _expanded }
  }

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  let yOffset = MAIN_Y

  const tree = selected ? stageTreeForRun(state.stages, selected.runId) : []
  const route = selected ? routeForRun(state, selected.runId, tree) : {}
  const chosenWorkflowName = route.profile ?? selected?.profile

  if (gateway) {
    // --- Gateway node: the product pipeline front door. It owns the routing decision,
    // so the run-scoped route lives here, never on a downstream step. ---
    const gatewayNode = node('gateway', 'gateway', `Product pipeline`, route.profile ? 'done' : 'idle', {
      entryPoint: true,
      chosenProfile: chosenWorkflowName,
      confidence: route.confidence,
      ruleVsModel: route.ruleVsModel,
      reason: route.reason,
      detailText: `${gateway.workflows.length} workflow${gateway.workflows.length === 1 ? '' : 's'}${gateway.defaultWorkflow ? ` · default: ${gateway.defaultWorkflow}` : ''}`,
      operation: 'decision',
    })
    gatewayNode.position = { x: MAIN_X, y: MAIN_Y }
    nodes.push(gatewayNode)
    yOffset = MAIN_Y + layoutHeightOf(gatewayNode) + ROW_GAP

    // --- One compact card per catalogued workflow; a missing definition fails loud. ---
    const configuredNames = new Set(state.topology.pipelines.map((p) => p.name))
    for (const wfName of gateway.workflows) {
      const def = state.topology.pipelines.find((p) => p.name === wfName)
      const isActiveRun = chosenWorkflowName === wfName && selected
      const compactNode = isActiveRun && def
        ? buildCompactPipelineNode(state, selected, tree, _expanded)
        : def
          ? buildIdleCompactPipeline(def)
          : buildMissingWorkflowNode(wfName)
      compactNode.position = { x: MAIN_X, y: yOffset }

      const isChosen = chosenWorkflowName === wfName
      // With a run in the books, every unchosen catalogue workflow stays visible but
      // clearly de-emphasised next to the executed one.
      if (selected && !isChosen) compactNode.data.muted = true
      nodes.push(compactNode)

      // Edge from gateway to this workflow: solid success branch for the chosen
      // workflow, dashed ghost for every possible alternative. Never a data edge —
      // workflows are independent, so no edge may imply one feeds another.
      edges.push(flowEdge(gatewayNode, compactNode, isChosen ? 'branch' : 'ghost', isChosen ? 'selected' : undefined))

      yOffset += layoutHeightOf(compactNode) + ROW_GAP
    }

    // --- Unconfigured direct run: executed but absent from the catalogue ---
    if (selected && !gateway.workflows.includes(selected.profile) && !configuredNames.has(selected.profile)) {
      const compactNode = buildCompactPipelineNode(state, selected, tree, _expanded)
      compactNode.position = { x: MAIN_X, y: yOffset }
      nodes.push(compactNode)
      // Connects as a ghost branch: a direct run, not a declared route.
      edges.push(flowEdge(gatewayNode, compactNode, 'ghost', 'direct run'))
      yOffset += layoutHeightOf(compactNode) + ROW_GAP
    }

    // --- Standalone configured workflows not referenced by the catalogue ---
    for (const def of state.topology.pipelines) {
      if (gateway.workflows.includes(def.name)) continue
      if (selected?.profile === def.name) continue
      const idleNode = buildIdleCompactPipeline(def)
      idleNode.data.detailText = 'standalone configured workflow'
      idleNode.position = { x: MAIN_X, y: yOffset }
      nodes.push(idleNode)
      yOffset += layoutHeightOf(idleNode) + ROW_GAP
    }
  } else {
    // --- No product gateway: standalone configured workflows render on their own,
    // and a selected direct run wins the top card ---
    if (selected) {
      const compactNode = buildCompactPipelineNode(state, selected, tree, _expanded)
      compactNode.position = { x: MAIN_X, y: MAIN_Y }
      nodes.push(compactNode)
      yOffset = MAIN_Y + layoutHeightOf(compactNode) + ROW_GAP
    }
    for (const def of state.topology.pipelines) {
      const idleNode = buildIdleCompactPipeline(def)
      idleNode.data.detailText = 'standalone configured workflow'
      idleNode.position = { x: MAIN_X, y: yOffset }
      nodes.push(idleNode)
      yOffset += layoutHeightOf(idleNode) + ROW_GAP
    }
  }

  const title = gateway
    ? `1 product pipeline · ${gateway.workflows.length} workflow${gateway.workflows.length === 1 ? '' : 's'} · compact view${selected ? ` · run ${selected.profile} ${shortDigest(selected.runId)}` : ''}`
    : state.topology.pipelines.length > 0
      ? `${state.topology.pipelines.length} standalone workflow${state.topology.pipelines.length === 1 ? '' : 's'} · compact`
      : selected
        ? `run ${selected.profile} · compact`
        : ''

  return { nodes, edges, title, expanded: _expanded }
}

/** Render a workflow that the gateway names but no definition exists for. */
const buildMissingWorkflowNode = (name: string): GraphNode =>
  node(`compact-missing-${name}`, 'compact-pipeline', `${name}`, 'failed', {
    profile: name,
    detailText: 'not configured',
    reason: 'Gateway names this workflow but no definition exists',
    steps: [],
    operation: 'orchestrator',
  })
