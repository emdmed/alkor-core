/**
 * Run-scoped graph builders: one selected execution painted as a single chronological
 * spine (input → steps → output), with expanded stages inserted inline and a router's
 * unchosen alternatives shown as a ghost fan.
 *
 * These builders read the observed run from activity state and paint only that run.
 * The full project map (all configured pipelines and profiles at once) lives in
 * `project.ts`, which reuses the trail builders for the selected lane.
 */
import { stageTreeForRun } from '../../../../src/tui/state.ts'
import type { PipelineDefinition, PipelineStepEntry, ProjectState, RunEntry, StageEntry } from '../../../../src/tui/state.ts'
import type { ProfileTopologyRoute, ProfileTopologyStage } from '../../../../src/core/topology.ts'
import type { NodeState } from '../format.ts'
import {
  MAIN_X,
  MAIN_Y,
  asNum,
  asStr,
  clip,
  columnX,
  detailTextOf,
  flowEdge,
  layoutHeightOf,
  layoutWidthOf,
  llmOf,
  node,
  obj,
  operationFor,
  shortDigest,
  stageState,
  stepIndexOf,
  SUB_GAP,
} from './core.ts'
import type { BuildCtx, ChainItem, GraphBuild, GraphEdge, GraphNode } from './types.ts'

/* ------------------------------------------------------------------ endpoint nodes */

const buildInput = (run: RunEntry): GraphNode =>
  // Receiving run.started means input preparation has already finished. The
  // input remains useful context, but it is never the current operation after
  // the run exists in state.
  node('input', 'input', 'Prompt input', 'done', {
    detailText: `${run.inputChars ?? '?'} chars · sha:${shortDigest(run.inputDigest) || '—'}`,
    operation: 'orchestrator',
    runId: run.runId,
  })

const buildOutput = (run: RunEntry): GraphNode =>
  // There is no output work in flight: this endpoint changes only when the run
  // settles. Treating run.started as an active output painted a false NOW badge.
  node('output', 'output', 'Pipeline output', run.status === 'started' ? 'idle' : run.status === 'failed' ? 'failed' : 'done', {
    wallMs: run.wallMs,
    detailText: run.error ? clip(run.error, 90) : undefined,
    runId: run.runId,
    operation: 'orchestrator',
  })

/* ------------------------------------------------------------------ stage tree */

/**
 * Everything the layout needs to draw one stage: the node itself and its children.
 * Where a step expands, the live stage trail runs inside it.
 */
interface StageItemResult {
  node: GraphNode
  children: ChainItem[]
}

/** A stage is a chain item; an internal router stage also carries its chosen chip. */
const stageItem = (s: StageEntry, ctx: BuildCtx): StageItemResult => {
  const isRouter = s.name === 'route'
  const d = obj(s.detail) ?? {}
  const chosen = isRouter ? (asStr(d, 'task') ?? asStr(d, 'profile')) : undefined
  const chosenConfidence = asNum(d, 'confidence')
  const chosenTasks = Array.isArray(d['tasks'])
    ? d['tasks'].filter((candidate): candidate is string => typeof candidate === 'string')
    : undefined

  const children: ChainItem[] = s.children.map((c) => stageItem(c, ctx))
  if (isRouter && chosen) {
    children.push({
      node: node(`chip-${s.stageId}-${chosen}`, 'branch', chosen, 'done', {
        chosen: true,
        confidence: chosenConfidence,
        runId: ctx.run.runId,
      }),
      children: [],
    })
  }

  const llm = s.name === 'llm-call' ? llmOf(s, ctx.requests) : undefined
  const kind: 'route' | 'stage' = isRouter ? 'route' : 'stage'

  return {
    node: node(
      `stage-${s.stageId}`,
      kind,
      s.name,
      stageState(s, ctx.requests),
      {
        wallMs: s.wallMs,
        detail: s.detail,
        detailText: kind === 'stage' && s.name !== 'llm-call' ? detailTextOf(s.detail) : undefined,
        confidence: isRouter ? chosenConfidence : undefined,
        shape: isRouter ? asStr(d, 'shape') : undefined,
        task: isRouter ? asStr(d, 'task') : undefined,
        tasks: isRouter ? chosenTasks : undefined,
        profile: isRouter ? ifRouterProfile(d) : undefined,
        reason: isRouter ? asStr(d, 'reason') : undefined,
        llm,
        operation: llm ? 'model' : operationFor(s.name, isRouter, s.operation),
        expanded: isRouter,
        childCount: children.length,
        runId: ctx.run.runId,
      },
    ),
    children,
  }
}

/** Router stage detail names its destination `profile`; the clinical stage names it `task`. */
function ifRouterProfile(d: Record<string, unknown>): string | undefined {
  return asStr(d, 'profile')
}

/* ------------------------------------------------------------------ pipeline topology */

/** Match an executed pipeline entry to the static definition that produced it.
 *
 * Matching order:
 *  1. Exact workflow definition name when available (from the run's profile).
 *  2. Observed pipeline step signature (profile sequence).
 *  3. Configured prefix of an in-progress run (executed steps are a prefix of a definition).
 *  4. Explicit fallback to the first configured definition (an unmatched direct run).
 */
export const matchTopology = (state: ProjectState, entry?: { steps?: PipelineStepEntry[] }, runProfile?: string): PipelineDefinition | undefined => {
  const defs = state.topology.pipelines
  if (defs.length === 0) return undefined
  const profiles = (entry?.steps ?? []).map((s) => s.profile).filter(Boolean)
  if (runProfile) {
    for (const d of defs) {
      if (d.name === runProfile) return d
    }
  }
  if (profiles.length === 0) return defs[0]
  for (const d of defs) {
    const dp = d.steps.map((s) => s.profile)
    if (dp.length === profiles.length && dp.every((p, i) => p === profiles[i])) return d
  }
  for (const d of defs) {
    const dp = d.steps.map((s) => s.profile)
    if (dp.length >= profiles.length && dp.slice(0, profiles.length).every((p, i) => p === profiles[i])) return d
  }
  return defs[0]
}

interface StepRow {
  step: number
  name: string
  profile: string
  status: NodeState
  wallMs?: number
  inputRef?: string
  inputIsInitial?: boolean
}

/** Activity keeps composed inputs as structured mappings. Never coerce that array: its
 * default string form leaks `[object Object]` into an operator-facing graph. */
export const inputReference = (input: PipelineStepEntry['input'] | PipelineDefinition['steps'][number]['input']): string | undefined => {
  if (!input) return undefined
  if (typeof input === 'string') return input
  if (Array.isArray(input)) return input.map(({ name, ref }) => `${name} ← ${ref}`).join(' · ')
  if (typeof input.ref === 'string') return `${input.ref}${input.field ? `.${input.field}` : ''}`
  return input.ref.map(({ name, ref }) => `${name} ← ${ref}`).join(' · ')
}

const mergeSteps = (executed: PipelineStepEntry[], def?: PipelineDefinition): StepRow[] => {
  const defSteps = def?.steps ?? []
  const n = Math.max(executed.length, defSteps.length)
  const rows: StepRow[] = []
  for (let i = 0; i < n; i++) {
    const ex = executed.find((e) => e.step === i)
    const d = defSteps[i]
    const ref = inputReference(ex?.input) ?? inputReference(d?.input)
    rows.push({
      step: i,
      name: ex?.name ?? d?.name ?? `step ${i + 1}`,
      profile: ex?.profile ?? d?.profile ?? '?',
      status: !ex ? 'idle' : ex.status === 'started' ? 'active' : ex.ok === false ? 'failed' : 'done',
      wallMs: ex?.wallMs,
      inputRef: ref,
      inputIsInitial: ex?.input?.ref === 'initial',
    })
  }
  return rows
}

/**
 * One thing a routing profile can decide to DO, with everything that decision drags in.
 *
 * A profile's route fan is not flat: `shock-extraction` exists to feed `shock`, and a
 * reader who sees them as two peers has to know the domain to know they are one answer to
 * one question. The `feeds` edge the topology already publishes says which, so a chain of
 * routes collapses into the group its terminal route names — `shock`, `sepsis` — with the
 * feeders kept in execution order inside it.
 */
export interface RouteGroup {
  /** The terminal route's name: what this branch of the profile is called. */
  name: string
  /** Every route in the chain, feeders first, terminal last. */
  routes: ProfileTopologyRoute[]
  /** False when the runtime declares it can name this route but not execute it. */
  available: boolean
}

/**
 * The route groups a profile's own decision stage can choose between.
 *
 * Read off the published topology and nothing else: a profile that declares no routes has
 * no groups, and the dashboard then draws it as the single opaque step it is.
 */
export const declaredRouteGroups = (state: ProjectState, profileName: string): RouteGroup[] => {
  const profile = state.topology.profiles.find((candidate) => candidate.name === profileName)
  const routes: ProfileTopologyRoute[] = []
  const visit = (stages: ProfileTopologyStage[]): void => {
    for (const stage of stages) {
      for (const route of stage.routes ?? []) routes.push(route)
    }
  }
  if (profile?.topology) visit(profile.topology.stages)
  if (routes.length === 0) return []

  const byName = new Map(routes.map((route) => [route.name, route]))
  // A route that feeds another is a step of that other route's answer, never a peer of it.
  const feeders = new Set(routes.filter((route) => route.feeds && byName.has(route.feeds)).map((route) => route.name))

  const groups: RouteGroup[] = []
  for (const route of routes) {
    if (feeders.has(route.name)) continue
    // Declared order is execution order, and a feeder is declared before what it feeds.
    // Chains may be longer than one link, so the feeders are collected transitively.
    const upstream = (name: string): ProfileTopologyRoute[] =>
      routes.filter((candidate) => candidate.feeds === name).flatMap((candidate) => [...upstream(candidate.name), candidate])
    const members = [...upstream(route.name), route]
    groups.push({
      name: route.name,
      routes: members,
      available: members.every((member) => member.available !== false),
    })
  }
  return groups
}

/**
 * The stages a profile runs BEFORE its own decision — work that belongs to no route.
 *
 * A profile's topology is not only a fan. The clinical profile reads a note's vital signs and
 * puts the numbers through the medprotocol CLI before it decides which syndrome the note
 * raises, because no word list reads a blood pressure. Both of those are published as ordinary
 * top-level stages, and `declaredRouteGroups` above collects `stage.routes` and nothing else —
 * so a stage with no routes was drawn nowhere at all, and the picture showed a decision being
 * made on evidence that appeared from nowhere.
 *
 * Everything before the first decision stage, in declared order. A profile with no decision has
 * no fan to precede, so it has nothing here: it is already drawn as the single step it is.
 */
export const declaredPreDecisionStages = (
  state: ProjectState,
  profileName: string,
): ProfileTopologyStage[] => {
  const profile = state.topology.profiles.find((candidate) => candidate.name === profileName)
  const stages = profile?.topology?.stages ?? []
  const decision = stages.findIndex((stage) => stage.kind === 'decision' || (stage.routes?.length ?? 0) > 0)
  if (decision <= 0) return []
  return stages.slice(0, decision)
}

export const declaredRouteTargets = (state: ProjectState, profileName: string): string[] => {
  const profile = state.topology.profiles.find((candidate) => candidate.name === profileName)
  const targets: string[] = []
  const visit = (stages: ProfileTopologyStage[]): void => {
    for (const stage of stages) {
      for (const route of stage.routes ?? []) {
        if (route.targetProfile && !targets.includes(route.targetProfile)) targets.push(route.targetProfile)
        if (route.stages) visit(route.stages)
      }
    }
  }
  if (profile?.topology) visit(profile.topology.stages)
  return targets
}

/** The specialist profiles the router could have handed the note to. */
const routerCandidates = (state: ProjectState, routerProfile: string, chosen?: string): string[] => {
  const declared = declaredRouteTargets(state, routerProfile)
  const seen = new Set<string>(declared)
  // Older profiles did not publish route topology. Preserve their useful fallback,
  // but never mix unrelated profiles into a router that declares exact targets.
  if (declared.length === 0) {
    for (const p of state.topology.profiles) {
      if (p.mode !== 'pipeline' && p.mode !== 'router' && p.name !== routerProfile) seen.add(p.name)
    }
    for (const r of state.routes) if (r.profile !== routerProfile) seen.add(r.profile)
  }
  if (chosen) seen.add(chosen)
  const list = [...seen]
  if (chosen) {
    const ix = list.indexOf(chosen)
    if (ix > 0) {
      list.splice(ix, 1)
      list.unshift(chosen)
    }
  }
  return list.slice(0, 6)
}

/** Route decision for this run: reducer-captured route.decided, else a router stage outside any step subtree. */
export const routeForRun = (state: ProjectState, runId: string, tree: StageEntry[] = []): NonNullable<BuildCtx['route']> => {
  const re = [...state.routes].reverse().find((r) => r.runId === runId)
  if (re) return { profile: re.profile, confidence: re.confidence, reason: re.reason, ruleVsModel: re.ruleVsModel }
  // Older activity buffers may predate run-scoped route.decided events. The tree is
  // already scoped to this run; walk only product-level router stages so a decision
  // a workflow step made for itself never gets lifted to the workflow's route.
  const visit = (stages: StageEntry[]): NonNullable<BuildCtx['route']> | undefined => {
    for (const stage of stages) {
      if (stage.name === 'route') {
        const detail = obj(stage.detail) ?? {}
        const profile = asStr(detail, 'profile')
        if (profile) {
          const confidence = asNum(detail, 'confidence')
          return {
            profile,
            confidence: confidence != null && confidence > 1 ? confidence / 100 : confidence,
            reason: asStr(detail, 'reason'),
          }
        }
      }
      // A step wrapper owns its subtree: a routing stage nested inside an observed
      // step is that step's own decision, never the run- or workflow-level route.
      const stepOwned = typeof obj(stage.detail)?.['step'] === 'number'
      if (stepOwned) continue
      const nested = visit(stage.children)
      if (nested) return nested
    }
    return undefined
  }
  const stageRoute = visit(tree)
  if (stageRoute) return stageRoute
  return {}
}

/* ------------------------------------------------------------------ active lineage */

/**
 * An active internal stage is also the active work of every enclosing step.  Keep
 * that lineage on the model instead of selecting one leaf in the React view: the
 * graph can then show where the work sits at both zoom levels.
 */
const markCurrentLineage = (item: ChainItem): boolean => {
  const descendantIsCurrent = item.children.some((child) => markCurrentLineage(child))
  const isCurrent = item.node.data.status === 'active' || descendantIsCurrent
  if (isCurrent) item.node.data.current = true
  return isCurrent
}

const markChainCurrentLineage = (chain: ChainItem[]): void => {
  for (const item of chain) markCurrentLineage(item)
}

/**
 * Pick one visible operation from the active lineage. When detail is expanded, the
 * deepest stage wins; when it is collapsed, the enclosing step becomes the visible
 * current operation. Ancestors remain active without each claiming a NOW badge.
 */
export const markCurrentOperation = (nodes: GraphNode[]): void => {
  const visible = nodes.filter((candidate) => candidate.data.kind !== 'group' && candidate.data.current)
  const deepestFirst = [...visible].reverse()
  const operation =
    visible.find((candidate) => candidate.data.currentOperation) ??
    deepestFirst.find((candidate) => candidate.data.status === 'active' && (candidate.data.kind === 'stage' || candidate.data.kind === 'route')) ??
    deepestFirst.find((candidate) => candidate.data.status === 'active') ??
    visible[0]
  for (const candidate of nodes) {
    candidate.data.currentOperation = candidate.id === operation?.id
  }
}

/* ------------------------------------------------------------------ trail layout */

const expandable = (item: ChainItem, ctx: BuildCtx): boolean =>
  item.children.length > 0 && (item.node.data.kind === 'route' || ctx.expanded.has(item.node.id))

/**
 * Place a selected execution as one chronological spine. Expanded stages are
 * inserted between their owning step and the following step; they never grow a
 * second lane or reconnect later with a return edge.
 */
function layoutTrail(chain: ChainItem[], ctx: BuildCtx): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const trail: ChainItem[] = []

  const append = (item: ChainItem): void => {
    trail.push(item)
    if (!expandable(item, ctx)) return
    for (const child of item.children) append(child)
  }
  for (const item of chain) append(item)

  let x = MAIN_X
  for (const item of trail) {
    nodes.push({ ...item.node, position: { x, y: MAIN_Y } })
    x += layoutWidthOf(item.node) + 56
  }

  for (let index = 0; index < trail.length - 1; index++) {
    const source = trail[index]!.node
    const target = trail[index + 1]!.node
    const kind = source.data.kind === 'route' ? 'branch' : 'data'
    const label = target.data.kind === 'step' ? target.data.inputRef : undefined
    edges.push(flowEdge(source, target, kind, label))
  }

  return { nodes, edges }
}

/**
 * The idle configured view: one lane with a shared column grid for all steps, and
 * expanded detail below the spine so it never reads as a detour through the pipeline.
 */
function layout(chain: ChainItem[], ctx: BuildCtx): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  const groupFor = (owner: ChainItem, x: number, y: number, width: number, bottom: number): void => {
    const count = owner.children.length
    const inset = 14
    const header = 25
    const label = `${owner.node.data.label} · ${count}`
    nodes.push({
      ...node(`group-${owner.node.id}`, 'group', label, owner.node.data.status, {
        childCount: count,
        current: owner.node.data.current,
      }),
      position: { x: x - inset, y: y - header },
      style: {
        width: width + inset * 2,
        height: bottom - y + inset + header,
      },
    })
  }

  const placeStage = (items: ChainItem[], startRank: number, y: number): { right: number; spanW: number; bottom: number; nextRank: number } => {
    const startX = columnX(startRank)
    let rank = startRank
    let right = startX
    let bottom = y
    for (const it of items) {
      const x = columnX(rank)
      nodes.push({ ...it.node, position: { x, y } })
      const itemW = layoutWidthOf(it.node)
      const itemBottom = y + layoutHeightOf(it.node)
      right = Math.max(right, x + itemW)
      bottom = Math.max(bottom, itemBottom)
      if (expandable(it, ctx) && it.children.length > 0) {
        const nestedY = itemBottom + SUB_GAP
        const nested = placeStage(it.children, rank + 1, nestedY)
        groupFor(it, columnX(rank + 1), nestedY, nested.spanW, nested.bottom)
        right = Math.max(right, nested.right)
        bottom = Math.max(bottom, nested.bottom)
        rank = nested.nextRank
      } else {
        rank++
      }
    }
    return { right, spanW: right - startX, bottom, nextRank: rank }
  }

  // Lay out the primary path first. Every rank owns one x coordinate; expanded
  // paths use separate rows so their sequence can follow that same column grid.
  const placed: Array<{ item: ChainItem; x: number; height: number; rank: number }> = []
  chain.forEach((it, rank) => {
    const h = layoutHeightOf(it.node)
    const itemLeft = columnX(rank)
    nodes.push({ ...it.node, position: { x: itemLeft, y: MAIN_Y } })
    placed.push({ item: it, x: itemLeft, height: h, rank })
  })

  const mainBottom = MAIN_Y + Math.max(0, ...placed.map(({ height }) => height))
  let detailBottom = mainBottom + 52

  for (const { item, rank } of placed) {
    if (!expandable(item, ctx)) continue
    const clusterY = detailBottom
    const clusterX = columnX(rank + 1)
    const cluster = placeStage(item.children, rank + 1, clusterY)
    groupFor(item, clusterX, clusterY, cluster.spanW, cluster.bottom)
    detailBottom = cluster.bottom + 52
  }

  // Route alternatives share the next-step column and stack vertically beneath
  // implementation detail. Parallel choices therefore never look sequential.
  let fanY = detailBottom + 32
  for (const { item, rank } of placed) {
    if (!item.fan) continue
    const fx = columnX(rank + 1)
    for (const chip of item.fan) {
      nodes.push({ ...chip, position: { x: fx, y: fanY } })
      fanY += layoutHeightOf(chip) + 14
    }
    fanY += 32
  }

  // The primary path remains a single uninterrupted spine. Expanded stages are
  // diagnostic detail, not a detour through the pipeline: routing the spine through
  // them produced the long return loops that made execution direction unreadable.
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i]!
    const b = chain[i + 1]!
    const kind = a.node.data.kind === 'route' ? 'branch' : 'data'
    const transfer = b.node.data.kind === 'step' ? b.node.data.inputRef : undefined
    const label = kind === 'branch' && a.node.data.chosenProfile
      ? `selected: ${a.node.data.chosenProfile}`
      : transfer

    edges.push(flowEdge(a.node, b.node, kind, label))
  }

  const expandedEdges = (item: ChainItem): void => {
    if (!expandable(item, ctx)) return
    const children = item.children
    if (children.length === 0) return
    edges.push(flowEdge(item.node, children[0]!.node, 'data', undefined, 'detail', 't'))
    for (let i = 0; i < children.length - 1; i++) {
      edges.push(flowEdge(children[i]!.node, children[i + 1]!.node, 'data', undefined, 's', 't'))
      expandedEdges(children[i]!)
    }
    expandedEdges(children[children.length - 1]!)
  }
  for (const item of chain) expandedEdges(item)

  // A step that uses `initial` says so in its card. Drawing that dependency as a second
  // edge would overlap the selected route and look like a duplicate arrow; the primary
  // path therefore remains the only connector through the workflow.

  // Router fan edges (chosen path is the chain's branch edge; these are the ghosts).
  for (const it of chain) {
    if (!it.fan) continue
    // When the router detail is visible, alternatives belong to the decision that
    // produced them—not the summary card above it. This also prevents the fan edge
    // from painting over the expanded group's title and inbound connector.
    const fanSource = expandable(it, ctx)
      ? it.children.find((child) => child.node.data.kind === 'route')?.node ?? it.node
      : it.node
    for (const chip of it.fan) {
      edges.push(flowEdge(fanSource, chip, 'ghost', undefined, 's', 'left'))
    }
  }

  return { nodes, edges }
}

/* ------------------------------------------------------------------ builders */

/** Destination decided by a step-local route stage, if the step's subtree has one. */
const stepTreeRouteDecision = (root?: StageEntry): { profile?: string; confidence?: number; reason?: string } => {
  if (!root) return {}
  const visit = (s: StageEntry): { profile?: string; confidence?: number; reason?: string } | undefined => {
    if (s.name === 'route') {
      const d = obj(s.detail) ?? {}
      const profile = asStr(d, 'profile') ?? asStr(d, 'task')
      if (profile) {
        const confidence = asNum(d, 'confidence')
        return { profile, confidence: confidence != null && confidence > 1 ? confidence / 100 : confidence, reason: asStr(d, 'reason') }
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

const buildPipeline = (state: ProjectState, run: RunEntry, tree: StageEntry[], userExpanded: Set<string>): GraphBuild => {
  const pipelineRoot = tree.find((n) => n.name === 'pipeline' && n.parentId === undefined)
  const entry = state.pipelines.get(run.runId)
  const def = matchTopology(state, entry, run.profile)
  const rows = mergeSteps(entry?.steps ?? [], def)
  const ctx: BuildCtx = {
    state,
    run,
    expanded: userExpanded,
    requests: state.llmRequests,
    route: routeForRun(state, run.runId, tree),
  }

  const chain: ChainItem[] = [{ node: buildInput(run), children: [] }]

  rows.forEach((row, i) => {
    const stage = pipelineRoot?.children.find((c) => stepIndexOf(c) === i)
    // A step is a router only when ITS OWN stage subtree observed a routing decision
    // that named a destination, or when the step's profile itself publishes routing
    // topology (a declared router). A profile merely implemented with router mode is
    // not the product workflow decision.
    const stepRoute = stepTreeRouteDecision(stage)
    const declaresRoutes = declaredRouteTargets(state, row.profile).length > 0
    const isRouter = Boolean(stepRoute.profile) || declaresRoutes
    if (isRouter) {
      let chosenProfile = stepRoute.profile
      let confidence = stepRoute.confidence
      let reason = stepRoute.reason
      // A declared router with no step-local evidence reports the run-scoped route.
      if (!chosenProfile && declaresRoutes && ctx.route.profile) {
        chosenProfile = ctx.route.profile
        confidence = ctx.route.confidence
        reason = ctx.route.reason
      }
      const fan = routerCandidates(state, row.profile, chosenProfile)
        .filter((p) => p !== chosenProfile)
        .map((p) => {
          const configured = state.topology.profiles.some((profile) => profile.name === p)
          return node(`branch-${p}`, 'branch', p, configured ? 'idle' : 'failed', {
            chosen: false,
            runId: run.runId,
            detailText: configured ? undefined : 'not configured',
          })
        })
      chain.push({
        node: node(`step-${i}`, 'step', row.name, row.status, {
          stepNo: row.step,
          profile: row.profile,
          router: true,
          wallMs: row.wallMs,
          inputRef: row.inputIsInitial ? 'initial' : undefined,
          confidence,
          reason,
          chosen: Boolean(chosenProfile),
          chosenProfile,
          expanded: false,
          childCount: stage ? stage.children.length : 0,
          runId: run.runId,
          operation: 'orchestrator',
        }),
        children: stage ? stage.children.map((c) => stageItem(c, ctx)) : [],
        fan,
        facet: 'router',
      })
    } else {
      chain.push({
        node: node(`step-${i}`, 'step', row.name, row.status, {
          stepNo: row.step,
          profile: row.profile,
          wallMs: row.wallMs,
          inputRef: row.inputIsInitial ? 'initial' : row.inputRef,
          expanded: false,
          childCount: stage ? stage.children.length : 0,
          runId: run.runId,
          operation: 'orchestrator',
        }),
        children: stage ? stage.children.map((c) => stageItem(c, ctx)) : [],
      })
    }
  })

  chain.push({ node: buildOutput(run), children: [] })
  markChainCurrentLineage(chain)
  const { nodes, edges } = layoutTrail(chain, ctx)
  return { nodes, edges, title: `run ${run.profile} · pipeline` }
}

const buildStages = (state: ProjectState, run: RunEntry, tree: StageEntry[], userExpanded: Set<string>): GraphBuild => {
  const ctx: BuildCtx = {
    state,
    run,
    expanded: userExpanded,
    requests: state.llmRequests,
    route: {},
  }
  const chain: ChainItem[] = [{ node: buildInput(run), children: [] }]
  for (const root of tree) chain.push(stageItem(root, ctx))
  chain.push({ node: buildOutput(run), children: [] })
  markChainCurrentLineage(chain)
  const { nodes, edges } = layoutTrail(chain, ctx)
  return { nodes, edges, title: `run ${run.profile}` }
}

export const buildGraph = (state: ProjectState, runId: string, expanded: Set<string>): GraphBuild => {
  const run = state.runs.get(runId)
  if (!run) return { nodes: [], edges: [], title: '' }

  // Internal router stages always show their chosen chip, so a routing decision is
  // visible even before the user expands anything else.
  const tree = stageTreeForRun(state.stages, runId)
  const pipelineRoot = tree.find((n) => n.name === 'pipeline' && n.parentId === undefined)
  const pipelineEntry = state.pipelines.get(runId)
  const isPipeline = Boolean(pipelineRoot || (pipelineEntry && pipelineEntry.steps.length > 0))
  const graph = isPipeline ? buildPipeline(state, run, tree, expanded) : buildStages(state, run, tree, expanded)
  markCurrentOperation(graph.nodes)
  return graph
}

/** Build an idle pipeline from configuration alone, before its first activity event. */
export const buildConfiguredPipeline = (state: ProjectState, def: PipelineDefinition): GraphBuild => {
  const run: RunEntry = { runId: `configured-${def.name}`, profile: def.name, status: 'started' }
  const ctx: BuildCtx = {
    state,
    run,
    expanded: new Set(),
    requests: state.llmRequests,
    route: {},
  }
  const chain: ChainItem[] = [
    { node: node('input', 'input', 'Prompt input', 'idle', { profile: def.name, operation: 'orchestrator', detailText: 'raw user input' }), children: [] },
  ]
  for (const [index, step] of def.steps.entries()) {
    // Before activity no step-local decision exists, but a step whose profile
    // publishes routing topology is a declared router: its declared targets
    // stay visible in the configured view instead of vanishing.
    const isRouter = declaredRouteTargets(state, step.profile).length > 0
    chain.push({
      node: node(`step-${index}`, 'step', step.name, 'idle', {
        stepNo: index,
        profile: step.profile,
        router: isRouter,
        inputRef: inputReference(step.input) ?? (index === 0 ? 'initial' : `step-${index - 1}.output`),
        operation: 'orchestrator',
      }),
      children: [],
      facet: isRouter ? 'router' : undefined,
    })
  }
  chain.push({ node: node('output', 'output', 'Pipeline output', 'idle', { profile: def.name, operation: 'orchestrator', detailText: 'last produced step output' }), children: [] })
  const { nodes, edges } = layout(chain, ctx)
  return { nodes, edges, title: def.name }
}

/**
 * Build the one process the operator is following. Before activity starts this is the
 * selected configured pipeline; once a run exists, observed state paints that same
 * stable input → steps → output path and exposes only its own runtime detail.
 */
export const buildProgressGraph = (
  state: ProjectState,
  runId: string | undefined,
  expanded: Set<string>,
  previewProfile?: string,
): GraphBuild => {
  if (runId) return buildGraph(state, runId, expanded)
  const pipeline = state.topology.pipelines.find((candidate) => candidate.name === previewProfile)
    ?? state.topology.pipelines[0]
  if (!pipeline) return { nodes: [], edges: [], title: '' }
  const graph = buildConfiguredPipeline(state, pipeline)
  return {
    ...graph,
    title: `${pipeline.name} · ${pipeline.steps.length} step${pipeline.steps.length === 1 ? '' : 's'} · ready`,
  }
}
