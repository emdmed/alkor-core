/**
 * Compact graph builder: one gateway node representing the product pipeline front
 * door, branching to one compact card per workflow. Workflows are independent and
 * never feed each other. The gateway owns the routing decision; each workflow card
 * shows its own steps and their observed data.
 */
import { stageTreeForRun } from '../../../../src/tui/state.ts'
import type { PipelineDefinition, PipelineStepEntry, ProjectState, RunEntry, StageEntry } from '../../../../src/tui/state.ts'
import { CHIP_GAP, CHIP_W, COMPACT_W, MAIN_X, MAIN_Y, ROUTE_GAP, ROW_GAP, compactStepKey, detailTextOf, flowEdge, layoutHeightOf, llmOf, node, obj, operationFor, shortDigest, stageState, stepIndexOf } from './core.ts'
import { declaredRouteGroups, inputReference, matchTopology, routeForRun, type RouteGroup } from './run.ts'
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
      operation: operationFor(s.name, s.name === 'route', s.operation),
      llm: llmData,
      detailText: s.name !== 'llm-call' ? String(detailTextOf(s.detail)).slice(0, 80) || undefined : undefined,
    }
    const children = s.children.length > 0 ? compactStages(s.children, requests, depth + 1) : []
    return [self, ...children]
  })

/** The destination a step-local route stage decided on, if its subtree has one. */
interface StepRouteDecision {
  profile?: string
  task?: string
  /** Every task the decision selected. A note can raise more than one question. */
  tasks?: string[]
  confidence?: number
  reason?: string
}

const stageRouteDecision = (root?: StageEntry): StepRouteDecision => {
  if (!root) return {}
  const visit = (s: StageEntry): StepRouteDecision | undefined => {
    if (s.name === 'route') {
      const d = obj(s.detail) ?? {}
      const profile = typeof d['profile'] === 'string' ? d['profile'] as string : undefined
      const task = typeof d['task'] === 'string' ? d['task'] as string : undefined
      const tasks = Array.isArray(d['tasks'])
        ? d['tasks'].filter((candidate): candidate is string => typeof candidate === 'string')
        : undefined
      if (profile || task || (tasks && tasks.length > 0)) {
        const confidence = typeof d['confidence'] === 'number' ? d['confidence'] as number : undefined
        const reason = typeof d['reason'] === 'string' ? d['reason'] as string : undefined
        return { profile, task, tasks, confidence: confidence != null && confidence > 1 ? confidence / 100 : confidence, reason }
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

const buildCompactSteps = (nodeId: string, state: ProjectState, run: RunEntry, tree: StageEntry[], expanded: Set<string>): CompactStepData[] => {
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
    const chosenTasks = stepRoute.tasks && stepRoute.tasks.length > 0
      ? stepRoute.tasks
      : stepRoute.task ? [stepRoute.task] : []
    const isRouter = Boolean(stepRoute.profile || chosenTasks.length > 0)

    const stages = stageEntries ? compactStages(stageEntries.children, state.llmRequests) : []
    const expandKey = compactStepKey(nodeId, i)
    const isExpanded = expanded.has(expandKey)

    steps.push({
      name,
      profile,
      status,
      stepNo: i,
      wallMs: ex?.wallMs,
      inputRef,
      router: isRouter,
      // A plan of several tasks is ONE decision, so it reads as one chip rather than as
      // the first task with the rest dropped: a septic-shock note answers two questions.
      chosenProfile: isRouter ? (stepRoute.profile ?? (chosenTasks.length > 0 ? chosenTasks.join(' + ') : undefined)) : undefined,
      tasks: chosenTasks.length > 0 ? chosenTasks : undefined,
      confidence: isRouter ? stepRoute.confidence : undefined,
      ruleVsModel: isRouter ? undefined : undefined,
      reason: isRouter ? stepRoute.reason : undefined,
      stages,
      expandKey,
      expanded: isExpanded,
      stageRowCount: isExpanded && stages.length > 0 ? stages.length : 0,
    })
  }
  return steps
}

/* ------------------------------------------------------------------ route branch cards */

/**
 * Where a workflow's steps end and one profile's own routes begin.
 *
 * A step whose profile publishes route topology is not one opaque box: `clinical` decides
 * which syndrome a note raises and then runs that syndrome's passes. Drawing it as a single
 * `extract` row hides the only branch in the whole picture that a clinician would ask about,
 * so the routes come out onto the canvas as their own cards, hanging off the workflow that
 * contains them. The card stays the container; the syndromes are what is inside it.
 */
const ROUTE_STAGE = 'route'

/** The declared stage names of one route, in the order the topology publishes them. */
const declaredStageNames = (group: RouteGroup, routeName: string): string[] =>
  group.routes.find((route) => route.name === routeName)?.stages?.map((stage) => stage.name) ?? []

/**
 * Split one step's flat stage list across the tasks that produced it.
 *
 * The runtime emits a multi-task route's stages as one flat sequence — nothing in the event
 * stream says where `shock` stopped and `sepsis` started. What does say it is the topology:
 * each route publishes its stage names in order, so walking the observed stages against the
 * planned sequence recovers the boundary. A name the plan does not contain stays with the
 * task in progress rather than being dropped, so an unrecognised stage is still visible.
 */
const stagesByTask = (
  stages: CompactStageData[],
  plan: { task: string; names: string[] }[],
): Map<string, CompactStageData[]> => {
  const assigned = new Map<string, CompactStageData[]>(plan.map(({ task }) => [task, []]))
  let planIndex = 0
  let nameIndex = 0
  let current = plan[0]?.task
  let skipping = false
  for (const stage of stages) {
    // The decision itself belongs to no branch: it is what chose between them, and the
    // step that made it already shows it. Copying it into a branch — with whatever it
    // nests — would read as work that branch did.
    if (stage.depth === 0) skipping = stage.name === ROUTE_STAGE
    if (skipping) continue
    // Only a top-level stage can open a task; a nested one belongs to its parent's task.
    if (stage.depth === 0) {
      let candidateIndex = planIndex
      let cursor = nameIndex
      while (candidateIndex < plan.length) {
        const found = plan[candidateIndex]!.names.indexOf(stage.name, cursor)
        if (found >= 0) {
          planIndex = candidateIndex
          nameIndex = found + 1
          current = plan[candidateIndex]!.task
          break
        }
        candidateIndex++
        cursor = 0
      }
    }
    if (current) assigned.get(current)!.push(stage)
  }
  return assigned
}

/** A declared-but-not-yet-run stage row, so an idle branch still shows what it would do. */
const idleStageRows = (nodeId: string, routeName: string, group: RouteGroup): CompactStageData[] =>
  (group.routes.find((route) => route.name === routeName)?.stages ?? []).map((stage, index) => ({
    stageId: `${nodeId}/${routeName}/${index}`,
    name: stage.name,
    status: 'idle' as const,
    depth: 0,
    operation: operationFor(stage.name, stage.kind === 'decision', stage.operation),
    detailText: stage.optional ? 'optional' : undefined,
  }))

/** Roll a branch's observed stage rows up into one status for the row that owns them. */
const rowStatus = (stages: CompactStageData[], ran: boolean): CompactStepData['status'] => {
  if (!ran || stages.length === 0) return 'idle'
  if (stages.some((stage) => stage.status === 'failed')) return 'failed'
  if (stages.some((stage) => stage.status === 'active')) return 'active'
  return 'done'
}

/**
 * One card per route group the routing step could have chosen.
 *
 * The chosen groups paint what actually ran, stage by stage; the rest stay on the canvas as
 * muted alternatives, because a fan that disappears once a decision is made cannot be read
 * as a decision. A group the runtime declares unavailable says so rather than looking idle.
 */
const buildRouteGroupNodes = (
  ownerId: string,
  step: CompactStepData,
  groups: RouteGroup[],
  expanded: Set<string>,
): GraphNode[] => {
  const chosen = step.tasks ?? []
  const decided = chosen.length > 0
  const plan = chosen.map((task) => ({
    task,
    names: groups.flatMap((group) => declaredStageNames(group, task)),
  }))
  const observed = decided ? stagesByTask(step.stages, plan) : new Map<string, CompactStageData[]>()

  const raised = (group: RouteGroup): boolean => group.routes.some((route) => chosen.includes(route.name))
  // What the note actually raised leads the fan; the declared order holds within each half,
  // so a branch never moves between two runs that made the same decision.
  const ordered = decided ? [...groups.filter(raised), ...groups.filter((group) => !raised(group))] : groups

  return ordered.map((group) => {
    const nodeId = `${ownerId}-route-${group.name}`
    const isChosen = raised(group)

    const steps: CompactStepData[] = group.routes.map((route, index) => {
      const ran = chosen.includes(route.name)
      const stages = ran ? observed.get(route.name) ?? [] : idleStageRows(nodeId, route.name, group)
      const expandKey = compactStepKey(nodeId, index)
      const isExpanded = expanded.has(expandKey)
      return {
        name: route.name,
        profile: step.profile,
        status: rowStatus(stages, ran),
        stepNo: index,
        stages,
        expandKey,
        expanded: isExpanded,
        stageRowCount: isExpanded && stages.length > 0 ? stages.length : 0,
      }
    })

    // A route the runtime declares unavailable is not a failure — nothing went wrong, the
    // profile says up front it cannot run it here. It stays idle and says so.
    const status: CompactStepData['status'] = !group.available || !isChosen ? 'idle'
      : steps.some((row) => row.status === 'failed') ? 'failed'
      : steps.some((row) => row.status === 'active') ? 'active'
      : steps.every((row) => row.status === 'done') ? 'done'
      : 'idle'

    const note = !group.available ? 'declared, not runnable here'
      : isChosen ? undefined
      : decided ? 'not raised by this note' : 'possible route'

    // Once the decision is in, a route it did not raise has no work to show — every pass
    // inside it is hypothetical. It shrinks to a chip so the branches that DID run own the
    // row, and so the whole fan still fits on one line: a second row of cards can only be
    // reached by edges that cross the first row, and an edge drawn through a card reads as
    // an edge leaving that card.
    if (decided && !isChosen) {
      return node(nodeId, 'branch', group.name, 'idle', {
        chosen: false,
        muted: true,
        routeOf: step.profile,
        // A chip has one line for metadata, and four chips repeating the same sentence is
        // noise; the short form says the same thing beside a muted card.
        detailText: group.available ? 'not raised' : 'not runnable here',
        operation: 'decision',
      })
    }

    const card = node(nodeId, 'compact-pipeline', group.name, status, {
      profile: step.profile,
      steps,
      operation: 'orchestrator',
      // These cards live INSIDE a workflow step; the workflow's own card already owns the
      // input the run arrived on and the output it produced, so repeating terminals here
      // would draw two mouths for one document.
      terminals: false,
      routeOf: step.profile,
      detailText: note,
      reason: group.available ? undefined : `${step.profile} names this route but cannot execute it`,
    })
    if (!group.available) card.data.muted = true
    return card
  })
}

/**
 * Lay a step's branches out as ONE row beneath the workflow that contains them.
 *
 * One row, never two, and that is a correctness property rather than a taste: everything in
 * this fan is connected to the workflow card above it, so a second row could only be reached
 * by edges running down through the first row's cards — which is exactly how a viewer comes
 * to believe that `shock` points at `transcript`. Chips stack in the last column instead,
 * keeping every target inside the same horizontal band as its edge.
 */
const placeRouteRow = (branches: GraphNode[], top: number): number => {
  let bottom = top
  let x = MAIN_X
  for (const branch of branches) {
    const isChip = branch.data.kind === 'branch'
    // Every branch shares one top edge. An orthogonal edge turns at the midpoint between
    // its endpoints, so targets that all start at the same y turn ABOVE the row — put one
    // lower and its edge turns inside the row and saws through the cards beside it.
    branch.position = { x, y: top }
    bottom = Math.max(bottom, top + layoutHeightOf(branch))
    x += isChip ? CHIP_W + CHIP_GAP : COMPACT_W + ROUTE_GAP
  }
  return bottom
}

/* ------------------------------------------------------------------ compact pipeline node builder */

const buildCompactPipelineNode = (
  state: ProjectState,
  run: RunEntry,
  tree: StageEntry[],
  expanded: Set<string>,
): GraphNode => {
  const nodeId = `compact-${run.runId}`
  const steps = buildCompactSteps(nodeId, state, run, tree, expanded)
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

  return node(nodeId, 'compact-pipeline', `${run.profile} workflow`, pipelineStatus, {
    profile: run.profile,
    wallMs: run.wallMs,
    runId: run.runId,
    steps,
    operation: 'orchestrator',
  })
}

const buildIdleCompactPipeline = (def: PipelineDefinition): GraphNode => {
  const nodeId = `compact-configured-${def.name}`
  const steps: CompactStepData[] = def.steps.map((s, i) => ({
    name: s.name,
    profile: s.profile,
    status: 'idle' as const,
    stepNo: i,
    inputRef: inputReference(s.input) ?? (i === 0 ? 'initial' : `step-${i - 1}.output`),
    stages: [],
    expandKey: compactStepKey(nodeId, i),
    expanded: false,
    stageRowCount: 0,
  }))

  return node(nodeId, 'compact-pipeline', `${def.name} workflow`, 'idle', {
    profile: def.name,
    steps,
    operation: 'orchestrator',
  })
}

/**
 * Hang every route card a workflow's own steps declare beneath that workflow's card.
 *
 * Returns the bottom the next workflow card must clear, so the routes of one workflow can
 * never land on top of the workflow below it.
 */
const attachRouteBranches = (
  state: ProjectState,
  workflow: GraphNode,
  expanded: Set<string>,
  top: number,
): { nodes: GraphNode[]; edges: GraphEdge[]; bottom: number } => {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  let bottom = top

  for (const step of (workflow.data.steps as CompactStepData[] | undefined) ?? []) {
    const groups = declaredRouteGroups(state, step.profile)
    if (groups.length === 0) continue
    const cards = buildRouteGroupNodes(workflow.id, step, groups, expanded)
    bottom = placeRouteRow(cards, bottom)
    for (const card of cards) {
      nodes.push(card)
      // Solid where the note actually went, dashed where it could have gone. The edge
      // leaves the workflow card because that card is the container these routes run in.
      edges.push(flowEdge(workflow, card, card.data.muted || step.tasks === undefined ? 'ghost' : 'branch'))
    }
  }

  return { nodes, edges, bottom }
}

/* ------------------------------------------------------------------ compact graph builder */

export const buildCompactGraph = (
  state: ProjectState,
  runId: string | undefined,
  expanded: Set<string>,
): ExpandedGraphBuild => {
  const selected = runId ? state.runs.get(runId) : undefined
  const gateway = state.topology.pipeline

  // Nothing to show: no product gateway, no configured workflows, and no running pipeline.
  if (!gateway && state.topology.pipelines.length === 0 && !selected) {
    return { nodes: [], edges: [], title: '', expanded }
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
        ? buildCompactPipelineNode(state, selected, tree, expanded)
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
      // Only the workflow in play opens its internals. Expanding every alternative's
      // routes as well would bury the branch the run actually took — and at rest, with
      // nothing selected, the default workflow is the one an operator is looking at.
      const opensRoutes = selected ? !compactNode.data.muted : wfName === (gateway.defaultWorkflow ?? gateway.workflows[0])
      if (opensRoutes) {
        const branches = attachRouteBranches(state, compactNode, expanded, yOffset)
        nodes.push(...branches.nodes)
        edges.push(...branches.edges)
        if (branches.nodes.length > 0) yOffset = branches.bottom + ROW_GAP
      }
    }

    // --- Unconfigured direct run: executed but absent from the catalogue ---
    if (selected && !gateway.workflows.includes(selected.profile) && !configuredNames.has(selected.profile)) {
      const compactNode = buildCompactPipelineNode(state, selected, tree, expanded)
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
      const compactNode = buildCompactPipelineNode(state, selected, tree, expanded)
      compactNode.position = { x: MAIN_X, y: MAIN_Y }
      nodes.push(compactNode)
      yOffset = MAIN_Y + layoutHeightOf(compactNode) + ROW_GAP
      const branches = attachRouteBranches(state, compactNode, expanded, yOffset)
      nodes.push(...branches.nodes)
      edges.push(...branches.edges)
      if (branches.nodes.length > 0) yOffset = branches.bottom + ROW_GAP
    }
    for (const def of state.topology.pipelines) {
      const idleNode = buildIdleCompactPipeline(def)
      idleNode.data.detailText = 'standalone configured workflow'
      idleNode.position = { x: MAIN_X, y: yOffset }
      nodes.push(idleNode)
      yOffset += layoutHeightOf(idleNode) + ROW_GAP
    }
  }

  // Only keys a rendered step actually holds open count: a key whose workflow node is
  // no longer on the canvas (switched run, collapsed catalogue entry) drops out here.
  const renderedExpanded = new Set<string>()
  for (const n of nodes) {
    for (const step of (n.data.steps as CompactStepData[] | undefined) ?? []) {
      if (step.expandKey && step.expanded) renderedExpanded.add(step.expandKey)
    }
  }

  const title = gateway
    ? `1 product pipeline · ${gateway.workflows.length} workflow${gateway.workflows.length === 1 ? '' : 's'} · compact view${selected ? ` · run ${selected.profile} ${shortDigest(selected.runId)}` : ''}`
    : state.topology.pipelines.length > 0
      ? `${state.topology.pipelines.length} standalone workflow${state.topology.pipelines.length === 1 ? '' : 's'} · compact`
      : selected
        ? `run ${selected.profile} · compact`
        : ''

  return { nodes, edges, title, expanded: renderedExpanded }
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
