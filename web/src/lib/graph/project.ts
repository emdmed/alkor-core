/**
 * Project-map builders: the complete configured system on one canvas.
 *
 * `buildProjectGraph` shows every configured pipeline as a lane plus every profile as a
 * blueprint row, so no possible route disappears after a decision — alternatives are
 * only de-emphasised. `buildPipelinesGraph` turns the same model into separately
 * readable per-pipeline lanes, and `buildExpandedPipelinesGraph` resolves the default
 * disclosure (what opens before any user interaction) to a fixed point.
 */
import { stageTreeForRun } from '../../../../src/tui/state.ts'
import type { PipelineDefinition, ProfileEntry, ProjectState, RunEntry, StageEntry } from '../../../../src/tui/state.ts'
import type { ProfileTopologyStage } from '../../../../src/core/topology.ts'
import {
  CHIP_W,
  MAIN_X,
  MAIN_Y,
  ROW_GAP,
  STAGE_W,
  asStr,
  columnX,
  detailTextOf,
  flowEdge,
  graphBounds,
  layoutHeightOf,
  llmOf,
  muteEdge,
  node,
  obj,
  operationFor,
  placeGraph,
  shortDigest,
  stageState,
  stepIndexOf,
} from './core.ts'
import { buildConfiguredPipeline, buildGraph, declaredRouteTargets, markCurrentOperation, matchTopology } from './run.ts'
import type { ExpandedGraphBuild, GraphBuild, GraphEdge, GraphNode } from './types.ts'

/* ------------------------------------------------------------------ shared workspace */

/** Mutable collections every lane, blueprint row, and connector paints into. */
interface ProjectSurface {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** The summary routing cards a run actually executed, for cross-lane connectors. */
  routerSources: GraphNode[]
  /** First non-group node of each lane, so one shared entry point can serve them all. */
  laneFirstSteps: GraphNode[]
  /** Route branches inside a blueprint that point at a whole other profile. */
  crossProfileRoutes: CrossProfileRoute[]
}

interface CrossProfileRoute {
  source: GraphNode
  target: string
  chosen: boolean
  muted: boolean
}

/** What drives one profile's blueprint row and its recursive route rendering. */
interface BlueprintView {
  state: ProjectState
  surface: ProjectSurface
  expanded: Set<string>
  /** The profile this row belongs to (configured status folded in). */
  profile: ProfileEntry & { configured: boolean }
  selected?: RunEntry
  chosenProfiles: Set<string>
  /** Task choices observed during the selected run, keyed by stage name. */
  chosenTasksByStage: Map<string, string[]>
  /** Live stage per (profile, stage-name), keyed by profile name. */
  observedStagesByProfile: Map<string, Map<string, StageEntry>>
  /**
   * Widest right edge across the whole blueprint row. The renderer folds every
   * recursive scope into this so the caller can size the row group — mirroring the
   * original closure so a deep route can never be clipped by the group's width.
   */
  scopeRight: number
}

/** One lane of a project map: a configured or observed pipeline, kept separately readable. */
const addLane = (
  surface: ProjectSurface,
  raw: GraphBuild,
  prefix: string,
  label: string,
  alignOutput: boolean,
  laneY: number,
  pipelineOutputRank: number,
): number => {
  // Route alternatives are represented once, as real configured profile nodes below.
  const branchIds = new Set(raw.nodes.filter((n) => n.data.kind === 'branch').map((n) => n.id))
  const clean: GraphBuild = {
    ...raw,
    nodes: raw.nodes.filter((n) => !branchIds.has(n.id)),
    edges: raw.edges.filter((e) => !branchIds.has(e.source) && !branchIds.has(e.target)),
  }

  // Strip the per-lane input node so a single shared entry point can serve all lanes.
  const inputNode = clean.nodes.find((n) => n.data.kind === 'input')
  let stripped = clean
  if (inputNode) {
    const outEdge = clean.edges.find((e) => e.source === inputNode.id)
    stripped = {
      ...clean,
      nodes: clean.nodes.filter((n) => n.id !== inputNode.id),
      edges: clean.edges.filter((e) => e.id !== outEdge?.id),
    }
  }

  const placed = placeGraph(stripped, prefix, laneY - MAIN_Y)
  if (alignOutput) {
    const output = placed.nodes.find((candidate) => candidate.data.kind === 'output')
    // Align short configured lanes to the shared output column, but never pull an
    // expanded runtime output backward over the stages that now precede it.
    if (output) output.position.x = Math.max(output.position.x, columnX(pipelineOutputRank))
  }

  const bounds = graphBounds(placed.nodes)
  surface.nodes.push({
    ...node(`${prefix}/lane`, 'group', label, 'idle'),
    position: { x: bounds.left - 20, y: bounds.top - 30 },
    style: { width: bounds.right - bounds.left + 40, height: bounds.bottom - bounds.top + 50 },
  })
  surface.nodes.push(...placed.nodes)
  surface.edges.push(...placed.edges)
  const summaryRouters = placed.nodes.filter((n) => n.data.kind === 'step' && n.data.router)
  surface.routerSources.push(...(summaryRouters.length > 0 ? summaryRouters : placed.nodes.filter((n) => n.data.kind === 'route')))

  const firstStep = placed.nodes.find((n) => n.data.kind !== 'group')
  if (firstStep) surface.laneFirstSteps.push(firstStep)

  return bounds.bottom + ROW_GAP
}

/** A single shared entry point serves every lane instead of one input per pipeline. */
const addSharedEntry = (surface: ProjectSurface, selected: RunEntry | undefined): void => {
  if (surface.laneFirstSteps.length === 0) return
  const sharedInput = node('input', 'input', 'Prompt input', selected ? 'done' : 'idle', {
    runId: selected?.runId,
    traversed: Boolean(selected),
    operation: 'orchestrator',
  })
  const firstCenters = surface.laneFirstSteps.map((target) => target.position.y + layoutHeightOf(target) / 2)
  sharedInput.position = {
    x: columnX(0),
    y: (Math.min(...firstCenters) + Math.max(...firstCenters)) / 2 - layoutHeightOf(sharedInput) / 2,
  }
  surface.nodes.push(sharedInput)
  for (const target of surface.laneFirstSteps) {
    surface.edges.push(flowEdge(sharedInput, target, 'data', undefined, 's', 't'))
  }
}

/* ------------------------------------------------------------------ topology facts */

const topologyRoutes = (
  state: ProjectState,
  profileName: string,
): Array<{ name: string; targetProfile?: string; available?: boolean }> => {
  const profile = state.topology.profiles.find((candidate) => candidate.name === profileName)
  const found: Array<{ name: string; targetProfile?: string; available?: boolean }> = []
  const visit = (stages: ProfileTopologyStage[]): void => {
    for (const stage of stages) {
      for (const route of stage.routes ?? []) {
        found.push(route)
        if (route.stages) visit(route.stages)
      }
    }
  }
  if (profile?.topology) visit(profile.topology.stages)
  return found
}

/** Every profile a declared internal route can reach, plus the legacy mode fallback. */
const computeRoutedTargets = (state: ProjectState): Set<string> => {
  const routedTargets = new Set(
    state.topology.profiles.flatMap((profile) => topologyRoutes(state, profile.name).flatMap((route) => route.targetProfile ? [route.targetProfile] : [])),
  )
  if (state.topology.profiles.some((profile) => profile.mode === 'router' && topologyRoutes(state, profile.name).every((route) => !route.targetProfile))) {
    for (const profile of state.topology.profiles) {
      if (profile.mode !== 'pipeline' && profile.mode !== 'router') routedTargets.add(profile.name)
    }
  }
  return routedTargets
}

const routedProfile = (source: GraphNode): string | undefined =>
  source.data.kind === 'route' ? source.data.profile : source.data.chosenProfile

/* ------------------------------------------------------------------ observed activity */

interface ObservedActivity {
  chosenTasksByStage: Map<string, string[]>
  observedStagesByProfile: Map<string, Map<string, StageEntry>>
}

const emptyObserved = (): ObservedActivity => ({
  chosenTasksByStage: new Map(),
  observedStagesByProfile: new Map(),
})

/** What actually executed during the selected run, so blueprints can paint over topology. */
const collectObservedActivity = (state: ProjectState, selected: RunEntry): ObservedActivity => {
  const chosenTasksByStage = new Map<string, string[]>()
  for (const stage of state.stages.values()) {
    if (stage.runId !== selected.runId) continue
    const detail = obj(stage.detail)
    const chosen = chosenTasksByStage.get(stage.name) ?? []
    const add = (task: string): void => {
      if (!chosen.includes(task)) chosen.push(task)
    }
    const task = detail ? asStr(detail, 'task') : undefined
    if (task) add(task)
    const tasks = detail?.['tasks']
    if (Array.isArray(tasks)) {
      for (const candidate of tasks) if (typeof candidate === 'string') add(candidate)
    }
    if (chosen.length > 0) chosenTasksByStage.set(stage.name, chosen)
  }

  const observedStagesByProfile = new Map<string, Map<string, StageEntry>>()
  const pipelineEntry = state.pipelines.get(selected.runId)
  const pipelineDefinition = matchTopology(state, pipelineEntry)
  const directProfile = pipelineEntry ? undefined : selected.profile
  const profileForStep = (step: number): string | undefined =>
    pipelineEntry?.steps.find((candidate) => candidate.step === step)?.profile
    ?? pipelineDefinition?.steps[step]?.profile
  const remember = (profile: string, stage: StageEntry): void => {
    const byName = observedStagesByProfile.get(profile) ?? new Map<string, StageEntry>()
    const previous = byName.get(stage.name)
    if (!previous || (previous.status === 'completed' && stage.status === 'started')) byName.set(stage.name, stage)
    observedStagesByProfile.set(profile, byName)
  }
  const visitObserved = (stages: StageEntry[], inheritedProfile?: string): void => {
    for (const stage of stages) {
      const step = stepIndexOf(stage)
      const profile = step == null ? inheritedProfile : profileForStep(step) ?? inheritedProfile
      if (profile && stage.name !== 'pipeline') remember(profile, stage)
      visitObserved(stage.children, profile)
    }
  }
  visitObserved(stageTreeForRun(state.stages, selected.runId), directProfile)

  return { chosenTasksByStage, observedStagesByProfile }
}

/* ------------------------------------------------------------------ blueprint rows */

interface BlueprintRow {
  right: number
  bottom: number
  last: GraphNode
  lastRank: number
  nextRank: number
}

/**
 * Place one profile's configured workflow as a row that follows the shared column grid.
 * A decision stage fans its routes vertically beneath it; a selected route advances its
 * continuation (and anything it `feeds`) to the next columns. Every recursive scope
 * folds its widths into `view.scopeRight`, so the caller sizes the row group once the
 * deepest route has finished — a route branch can never be clipped by the group edge.
 */
const renderBlueprintStages = (
  view: BlueprintView,
  stages: ProfileTopologyStage[],
  path: string,
  startRank: number,
  y: number,
  source: GraphNode,
  inheritedMuted: boolean,
): BlueprintRow => {
  const { state, surface, profile } = view
  let rank = startRank
  let bottom = y
  let from = source
  let lastRank = startRank - 1
  let localRight = columnX(startRank)

  for (const [stageIndex, stage] of stages.entries()) {
    const stageRank = rank
    const x = columnX(stageRank)
    const kind = stage.kind === 'decision' ? 'route' : 'stage'
    const flags = [stage.optional ? 'optional pass' : '', stage.repeatable ? 'repeatable' : ''].filter(Boolean).join(' · ')
    const observed = inheritedMuted ? undefined : view.observedStagesByProfile.get(profile.name)?.get(stage.name)
    const observedStatus = observed ? stageState(observed, state.llmRequests) : 'idle'
    const stageNode = node(`blueprint-${profile.name}-${path}-${stageIndex}`, kind, stage.name, observedStatus, {
      profile: profile.name,
      detail: observed?.detail,
      detailText: observed ? detailTextOf(observed.detail) || flags || undefined : flags || undefined,
      wallMs: observed?.wallMs,
      llm: observed ? llmOf(observed, state.llmRequests) : undefined,
      runId: observed ? view.selected?.runId : undefined,
      traversed: Boolean(observed),
      current: observedStatus === 'active',
      muted: inheritedMuted,
      operation: operationFor(stage.name, stage.kind === 'decision'),
    })
    stageNode.position = { x, y }
    surface.nodes.push(stageNode)
    const connector = flowEdge(from, stageNode, 'ghost', undefined, 's', 't')
    if (inheritedMuted) muteEdge(connector)
    surface.edges.push(connector)
    bottom = Math.max(bottom, y + layoutHeightOf(stageNode))
    localRight = Math.max(localRight, x + STAGE_W)

    if ((stage.routes?.length ?? 0) > 0) {
      const localChoiceOrder = view.chosenTasksByStage.get(stage.name) ?? []
      const externalChoiceOrder = (stage.routes ?? [])
        .filter((route) => route.targetProfile && view.chosenProfiles.has(route.targetProfile))
        .map((route) => route.name)
      const directChoiceOrder = [...new Set([...localChoiceOrder, ...externalChoiceOrder])]
        .filter((name) => stage.routes?.some((route) => route.name === name))
      const directChoices = new Set(directChoiceOrder)
      let routeY = y
      let routeRight = x + STAGE_W
      let maxRouteRank = stageRank
      const routes = stage.routes ?? []

      // Selecting the producer route also selects the shared continuation it feeds.
      const chosenPath = new Set<string>()
      for (const choice of directChoices) {
        chosenPath.add(choice)
        let cursor = routes.find((route) => route.name === choice)
        while (cursor?.feeds && !chosenPath.has(cursor.feeds)) {
          chosenPath.add(cursor.feeds)
          cursor = routes.find((route) => route.name === cursor?.feeds)
        }
      }

      const renderedRoutes = new Map<string, { terminal: GraphNode; terminalRank: number; right: number; y: number; muted: boolean; chosen: boolean }>()
      for (const [routeIndex, route] of routes.entries()) {
        const isChosen = chosenPath.has(route.name)
        const directChoice = directChoices.has(route.name)
        const routeMuted = inheritedMuted || Boolean(directChoices.size > 0 && !isChosen)
        const unavailable = route.available === false
        const feeder = routes.find((candidate) => candidate.feeds === route.name)
        const directIndex = directChoiceOrder.indexOf(route.name)
        const runtimeFeeder = directIndex > 0 ? renderedRoutes.get(directChoiceOrder[directIndex - 1]!) : undefined
        const renderedFeeder = (feeder ? renderedRoutes.get(feeder.name) : undefined) ?? runtimeFeeder
        const branchRank = renderedFeeder ? renderedFeeder.terminalRank + 1 : stageRank + 1
        const branchX = columnX(branchRank)
        const branchY = renderedFeeder?.y ?? routeY
        const branchId = `blueprint-${profile.name}-${path}-${stageIndex}-route-${routeIndex}`
        // The catalogue starts as a compact workflow index. During an observed run the
        // full chosen/unchosen comparison remains visible for diagnostic value.
        const branchExpanded = Boolean(view.selected) || view.expanded.has(branchId)
        const branch = node(branchId, 'branch', route.name, unavailable ? 'failed' : isChosen ? 'done' : 'idle', {
          chosen: isChosen,
          muted: routeMuted,
          detailText: unavailable
            ? 'not runnable in review'
            : route.feeds
              ? `workflow · continues to ${route.feeds}`
              : route.targetProfile
                ? 'profile destination'
                : 'clinical workflow',
          profile: route.targetProfile,
          operation: 'decision',
          expanded: branchExpanded,
          childCount: route.stages?.length ?? 0,
        })
        branch.position = { x: branchX, y: branchY }
        surface.nodes.push(branch)
        const routeEntry = directChoice && !runtimeFeeder
        const routeEdge = flowEdge(stageNode, branch, routeEntry ? 'branch' : 'ghost', routeEntry ? 'selected' : undefined, 's', 'left')
        if (routeMuted || (directChoices.size > 0 && !routeEntry)) muteEdge(routeEdge)
        surface.edges.push(routeEdge)

        let branchRight = branch.position.x + CHIP_W
        let branchBottom = branchY + layoutHeightOf(branch)
        let terminal = branch
        let terminalRank = branchRank
        if (route.stages?.length && branchExpanded) {
          const nested = renderBlueprintStages(view, route.stages, `${path}-${stageIndex}-route-${routeIndex}`, branchRank + 1, branchY, branch, routeMuted)
          branchRight = nested.right
          branchBottom = Math.max(branchBottom, nested.bottom)
          terminal = nested.last
          terminalRank = nested.lastRank
        }
        renderedRoutes.set(route.name, { terminal, terminalRank, right: branchRight, y: branchY, muted: routeMuted, chosen: isChosen })
        if (renderedFeeder) {
          const feedEdge = flowEdge(renderedFeeder.terminal, branch, renderedFeeder.chosen ? 'branch' : 'ghost', undefined, 's', 'left')
          if (renderedFeeder.muted) muteEdge(feedEdge)
          surface.edges.push(feedEdge)
        }
        if (route.targetProfile) surface.crossProfileRoutes.push({ source: branch, target: route.targetProfile, chosen: isChosen, muted: routeMuted })
        routeRight = Math.max(routeRight, branchRight)
        maxRouteRank = Math.max(maxRouteRank, terminalRank)
        bottom = Math.max(bottom, branchBottom)
        if (!renderedFeeder) routeY = branchBottom + 24
      }
      localRight = Math.max(localRight, routeRight)
      rank = maxRouteRank + 1
    } else {
      rank = stageRank + 1
    }
    from = stageNode
    lastRank = stageRank
  }

  view.scopeRight = Math.max(view.scopeRight, localRight)
  return { right: localRight, bottom, last: from, lastRank, nextRank: rank }
}

/* ------------------------------------------------------------------ runtime overlay */

/** Runtime activity is a semantic overlay on the stable system map. A traversed node
 * stays green after it completes; an edge turns green only when data reached both ends,
 * so untouched alternatives remain visibly available but unselected. */
const paintTrailOverlay = (nodes: GraphNode[], edges: GraphEdge[], selected: RunEntry | undefined): void => {
  if (!selected) return
  const traversed = new Set<string>()
  for (const candidate of nodes) {
    const observed = candidate.data.runId === selected.runId && candidate.data.status !== 'idle'
    const chosenTopology = candidate.data.chosen === true
    if (!observed && !chosenTopology) continue
    candidate.data.traversed = true
    traversed.add(candidate.id)
  }
  for (const edge of edges) {
    if (!traversed.has(edge.source) || !traversed.has(edge.target)) continue
    edge.style = { ...edge.style, stroke: 'var(--route-selected)', strokeWidth: 2.6, strokeDasharray: undefined, opacity: 1 }
    edge.markerEnd = { type: 'arrowclosed', width: 14, height: 14, color: 'var(--route-selected)' }
    edge.animated = nodes.find((candidate) => candidate.id === edge.target)?.data.status === 'active'
    edge.data = { ...edge.data, traversed: true }
  }
}

/* ------------------------------------------------------------------ project map */

/**
 * Render the complete configured project continuously. A selected run paints one lane
 * with observed state and stages, while every other pipeline remains visible as idle
 * topology. Router destinations remain in vertically stacked profile rows so no possible
 * route is removed after the decision; alternatives are only de-emphasised.
 */
export const buildProjectGraph = (state: ProjectState, runId: string | undefined, expanded: Set<string>): GraphBuild => {
  const selected = runId ? state.runs.get(runId) : undefined
  if (state.topology.pipelines.length === 0 && state.topology.profiles.length === 0) {
    return selected ? buildGraph(state, selected.runId, expanded) : { nodes: [], edges: [], title: '' }
  }

  const surface: ProjectSurface = {
    nodes: [],
    edges: [],
    routerSources: [],
    laneFirstSteps: [],
    crossProfileRoutes: [],
  }
  let laneY = MAIN_Y
  let selectedPlaced = false
  const pipelineOutputRank = Math.max(0, ...state.topology.pipelines.map((pipeline) => pipeline.steps.length)) + 1

  for (const def of state.topology.pipelines) {
    const isSelected = selected?.profile === def.name
    const raw = isSelected ? buildGraph(state, selected.runId, expanded) : buildConfiguredPipeline(state, def)
    selectedPlaced ||= isSelected
    laneY = addLane(surface, raw, `pipeline-${def.name}`, `${def.name} · workflow`, true, laneY, pipelineOutputRank)
  }

  // A direct profile run is still useful operational detail, but it sits alongside the
  // configured topology instead of replacing it.
  if (selected && !selectedPlaced) {
    laneY = addLane(surface, buildGraph(state, selected.runId, expanded), `run-${selected.runId}`, `${selected.profile} · selected run`, false, laneY, pipelineOutputRank)
  }
  addSharedEntry(surface, selected)

  const routedTargets = computeRoutedTargets(state)
  const missingTargets = [...routedTargets].filter((name) => !state.topology.profiles.some((profile) => profile.name === name))
  const allProfiles: Array<ProfileEntry & { configured: boolean }> = [
    ...state.topology.profiles.map((profile) => ({ ...profile, configured: true })),
    ...missingTargets.map((name) => ({ name, mode: 'unconfigured', configured: false })),
  ]
  const chosenProfiles = new Set(surface.routerSources.map(routedProfile).filter((p): p is string => Boolean(p)))
  const observed = selected ? collectObservedActivity(state, selected) : emptyObserved()

  const profileNodes: GraphNode[] = []
  const lanesBottom = graphBounds(surface.nodes).bottom
  const profileX = columnX(0)
  // The preceding lane group extends 20px below its content and this profile group
  // begins 30px above its root. Reserve a further 32px between those boundaries.
  let profileY = lanesBottom + 82

  for (const profile of allProfiles) {
    const chosen = chosenProfiles.has(profile.name)
    const isAlternative = routedTargets.has(profile.name)
    const profileMuted = chosenProfiles.size > 0 && isAlternative && !chosen
    const profileNode = node(`profile-${profile.name}`, 'profile', profile.name, profile.configured === false ? 'failed' : chosen ? 'done' : 'idle', {
      profile: profile.name,
      mode: profile.mode,
      configured: profile.configured,
      chosen,
      muted: profileMuted,
      detail: profile,
    })
    profileNode.position = { x: profileX, y: profileY }
    profileNodes.push(profileNode)

    const view: BlueprintView = {
      state,
      surface,
      expanded,
      profile,
      selected,
      chosenProfiles,
      chosenTasksByStage: observed.chosenTasksByStage,
      observedStagesByProfile: observed.observedStagesByProfile,
      scopeRight: profileX + 196,
    }
    let rowRight = view.scopeRight
    let rowBottom = profileY + layoutHeightOf(profileNode)
    if (profile.topology?.stages.length) {
      const rendered = renderBlueprintStages(view, profile.topology.stages, 'root', 1, profileY, profileNode, profileMuted)
      rowRight = view.scopeRight
      rowBottom = Math.max(rowBottom, rendered.bottom)
    }

    surface.nodes.push({
      ...node(`profile-group-${profile.name}`, 'group', `${profile.name} · ${profile.mode}`, profile.configured === false ? 'failed' : 'idle'),
      position: { x: profileX - 20, y: profileY - 30 },
      style: { width: rowRight - profileX + 40, height: rowBottom - profileY + 50 },
    })
    profileY = rowBottom + ROW_GAP
  }

  surface.nodes.push(...profileNodes)

  for (const source of surface.routerSources) {
    const chosen = routedProfile(source)
    const sourceProfile = source.data.kind === 'step' ? source.data.profile : selected?.profile
    const declaredTargets = topologyRoutes(state, sourceProfile ?? '').flatMap((route) => route.targetProfile ? [route.targetProfile] : [])
    const fallbackTargets = state.topology.profiles
      .filter((profile) => profile.mode !== 'pipeline' && profile.mode !== 'router' && profile.name !== sourceProfile)
      .map((profile) => profile.name)
    const targets = new Set(declaredTargets.length > 0 ? declaredTargets : fallbackTargets)
    for (const profile of profileNodes.filter((candidate) => targets.has(String(candidate.data.profile)))) {
      const isChosen = chosen === profile.data.profile
      const edge = flowEdge(source, profile, isChosen ? 'branch' : 'ghost', isChosen ? 'selected' : undefined, 'detail', 'top')
      if (chosen && !isChosen) muteEdge(edge)
      surface.edges.push(edge)
    }
  }

  for (const route of surface.crossProfileRoutes) {
    const target = profileNodes.find((profile) => profile.data.profile === route.target)
    if (!target) continue
    const edge = flowEdge(route.source, target, route.chosen ? 'branch' : 'ghost', undefined, 's', 'top')
    if (route.muted) muteEdge(edge)
    surface.edges.push(edge)
  }

  // Several nodes can legitimately route at different scopes. Label only the configured
  // front door, and only when the graph would otherwise contain an ambiguous set of them.
  const routingNodes = surface.nodes.filter(
    (candidate) => candidate.data.kind === 'route' || (candidate.data.kind === 'step' && candidate.data.router),
  )
  if (routingNodes.length > 1) {
    const pinnedRouters = new Set(
      state.topology.profiles
        .filter((profile) => profile.mode === 'router' && profile.pinned)
        .map((profile) => profile.name),
    )
    const entryPoint = routingNodes.find(
      (candidate) => candidate.data.kind === 'step' && pinnedRouters.has(String(candidate.data.profile)),
    ) ?? routingNodes.find(
      (candidate) => candidate.data.kind === 'route' && pinnedRouters.has(String(candidate.data.profile)),
    )
    if (entryPoint) entryPoint.data.entryPoint = true
  }

  paintTrailOverlay(surface.nodes, surface.edges, selected)

  const count = state.topology.pipelines.length
  const runTitle = selected ? ` · selected run ${selected.profile} ${shortDigest(selected.runId)}` : ''
  const missingTitle = missingTargets.length > 0 ? ` · ${missingTargets.length} unresolved route target${missingTargets.length === 1 ? '' : 's'}` : ''
  return {
    nodes: surface.nodes,
    edges: surface.edges,
    title: `1 pipeline · ${count} workflow${count === 1 ? '' : 's'} · ${state.topology.profiles.length} configured profiles${missingTitle}${runTitle}`,
  }
}

/**
 * Keep the selected pipeline's complete static internals, but place each referenced
 * profile at the pipeline step that owns it. This turns the topology catalogue into
 * one readable process: summaries on the top row, implementation detail below them,
 * and every deeper stage advancing to the next column.
 */
function buildConfiguredProgressTopology(
  state: ProjectState,
  pipeline: PipelineDefinition,
  expanded: Set<string>,
  runId?: string,
): GraphBuild {
  const profileRanks = new Map<string, number>()
  pipeline.steps.forEach((step, index) => {
    if (!profileRanks.has(step.profile)) profileRanks.set(step.profile, index + 1)
  })

  const queue = [...profileRanks.keys()]
  while (queue.length > 0) {
    const source = queue.shift()!
    const sourceRank = profileRanks.get(source) ?? 1
    for (const target of declaredRouteTargets(state, source)) {
      if (profileRanks.has(target)) continue
      profileRanks.set(target, sourceRank + 2)
      queue.push(target)
    }
  }

  const focusedState: ProjectState = {
    ...state,
    topology: {
      profiles: state.topology.profiles.filter((profile) => profileRanks.has(profile.name)),
      pipelines: [pipeline],
    },
  }
  const graph = buildProjectGraph(focusedState, runId, expanded)

  for (const [profile, rank] of profileRanks) {
    const root = graph.nodes.find((candidate) => candidate.id === `profile-${profile}`)
    if (!root) continue
    const dx = columnX(rank) - root.position.x
    for (const candidate of graph.nodes) {
      if (
        candidate.id === `profile-${profile}`
        || candidate.id === `profile-group-${profile}`
        || candidate.id.startsWith(`blueprint-${profile}-`)
      ) candidate.position = { ...candidate.position, x: candidate.position.x + dx }
    }
  }

  pipeline.steps.forEach((step, index) => {
    const source = graph.nodes.find((candidate) => candidate.id === `pipeline-${pipeline.name}/step-${index}`)
    const target = graph.nodes.find((candidate) => candidate.id === `profile-${step.profile}`)
    if (!source || !target || graph.edges.some((edge) => edge.source === source.id && edge.target === target.id)) return
    graph.edges.push(flowEdge(source, target, 'ghost', 'detail', 'detail', 'top'))
  })

  return {
    ...graph,
    title: `${pipeline.name} · ${pipeline.steps.length} step${pipeline.steps.length === 1 ? '' : 's'} · ready`,
  }
}

/** Every configured pipeline as a complete, separately readable process lane. */
export const buildPipelinesGraph = (
  state: ProjectState,
  runId: string | undefined,
  expanded: Set<string>,
): GraphBuild => {
  const selected = runId ? state.runs.get(runId) : undefined
  if (state.topology.pipelines.length === 0) {
    return selected ? buildGraph(state, selected.runId, expanded) : { nodes: [], edges: [], title: '' }
  }

  const selectedEntry = selected ? state.pipelines.get(selected.runId) : undefined
  const selectedDefinition = selectedEntry ? matchTopology(state, selectedEntry) : undefined
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  let nextY = MAIN_Y

  for (const pipeline of state.topology.pipelines) {
    const isSelected = Boolean(selected && selectedDefinition?.name === pipeline.name)
    const raw = buildConfiguredProgressTopology(state, pipeline, expanded, isSelected ? selected!.runId : undefined)
    const rawBounds = graphBounds(raw.nodes, true)
    const placed = placeGraph(raw, `pipeline-lane-${pipeline.name}`, nextY - rawBounds.top)
    const bounds = graphBounds(placed.nodes, true)
    nodes.push(...placed.nodes)
    edges.push(...placed.edges)

    nodes.push({
      ...node(`pipeline-lane-group-${pipeline.name}`, 'group', `${pipeline.name} · workflow`, isSelected ? 'active' : 'idle', {
        current: isSelected,
      }),
      position: { x: bounds.left - 24, y: bounds.top - 34 },
      style: { width: bounds.right - bounds.left + 48, height: bounds.bottom - bounds.top + 58 },
    })
    nextY = bounds.bottom + ROW_GAP + 34
  }

  if (selected && !selectedDefinition) {
    const raw = buildGraph(state, selected.runId, expanded)
    const rawBounds = graphBounds(raw.nodes)
    const placed = placeGraph(raw, `direct-run-${selected.runId}`, nextY - rawBounds.top)
    const bounds = graphBounds(placed.nodes)
    nodes.push(...placed.nodes)
    edges.push(...placed.edges)
    nodes.push({
      ...node(`direct-run-group-${selected.runId}`, 'group', `${selected.profile} · selected run`, 'active', { current: true }),
      position: { x: bounds.left - 24, y: bounds.top - 34 },
      style: { width: bounds.right - bounds.left + 48, height: bounds.bottom - bounds.top + 58 },
    })
  }

  // Composing lanes can duplicate the selected run's active operation in topology
  // overlays. Resolve those representations back to one visible NOW badge.
  markCurrentOperation(nodes)
  const count = state.topology.pipelines.length
  return { nodes, edges, title: `1 pipeline · ${count} workflow${count === 1 ? '' : 's'} · full process detail` }
}

/** Resolve default-open graph disclosure to a fixed point while respecting closes. */
export const buildExpandedPipelinesGraph = (
  state: ProjectState,
  runId: string | undefined,
  requested: Set<string>,
  collapsed: Set<string>,
): ExpandedGraphBuild => {
  const expanded = new Set([...requested].filter((key) => !collapsed.has(key)))
  let graph = buildPipelinesGraph(state, runId, expanded)

  while (true) {
    let changed = false
    for (const candidate of graph.nodes) {
      if (candidate.data.kind === 'group' || (candidate.data.childCount ?? 0) === 0) continue
      const key = candidate.data.expandKey ?? candidate.id
      if (collapsed.has(key) || expanded.has(key)) continue
      expanded.add(key)
      changed = true
    }
    if (!changed) return { ...graph, expanded }
    graph = buildPipelinesGraph(state, runId, expanded)
  }
}
