/**
 * Graph model for the pipeline execution view.
 *
 * Turns the flat activity reducer state back into the graph it was produced from:
 * a linear chain of steps (input → route → specialists → output) with routing fans
 * between them, where every step can expand into the internal stages the mode painted.
 *
 * Pure and deterministic: the layout is computed, not negotiated with a physics engine,
 * so a given run always draws the same picture. Nothing here touches the DOM or knows
 * about React — it only says which nodes and edges a run paints.
 */
import type { Edge, Node } from '@xyflow/react'
import type {
  LlmRequestEntry,
  PipelineDefinition,
  PipelineStepEntry,
  ProjectState,
  RunEntry,
  StageEntry,
} from '../../../src/tui/state.ts'
import { stageTreeForRun } from '../../../src/tui/state.ts'
import type { NodeState } from './format.ts'

export type GraphNodeKind = 'input' | 'route' | 'step' | 'stage' | 'branch' | 'output' | 'group'

export interface GraphLlm {
  constrained: boolean
  /** `prompt→completion tok` when known. */
  tokens?: string
  finish?: string
  error?: string
}

export interface GraphNodeData {
  kind: GraphNodeKind
  label: string
  status: NodeState
  wallMs?: number
  /** The underlying record the node was built from, for the inspector. */
  detail?: unknown
  detailText?: string
  profile?: string
  stepNo?: number
  inputRef?: string
  router?: boolean
  shape?: string
  task?: string
  confidence?: number
  ruleVsModel?: string
  reason?: string
  expanded?: boolean
  childCount?: number
  chosen?: boolean
  chosenProfile?: string
  llm?: GraphLlm
  runId?: string
  /** Injected by the view layer: toggles this node's sub-graph. */
  onToggle?: () => void
  /** Injected by the view layer: opens the inspector on this node. */
  onInspect?: () => void
  /** The most specific active node for this run; called out by the operating view. */
  current?: boolean
  /** ReactFlow's `Node<T>` requires an index signature; keep it honest. */
  [key: string]: unknown
}

export type GraphNode = Node<GraphNodeData>
export type GraphEdge = Edge

export interface GraphBuild {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Human title for the selected run, mirroring what the old panel showed. */
  title: string
}

/* ------------------------------------------------------------------ helpers */

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

const obj = (d: unknown): Record<string, unknown> | undefined =>
  typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : undefined

const asNum = (d: Record<string, unknown>, k: string): number | undefined => {
  const v = d[k]
  return typeof v === 'number' ? v : undefined
}

const asStr = (d: Record<string, unknown>, k: string): string | undefined => {
  const v = d[k]
  return typeof v === 'string' ? v : undefined
}

const okFalse = (d: unknown): boolean => obj(d)?.['ok'] === false

/** The `{ step }` the pipeline stamps on each per-step stage, to join stage ↔ step. */
const stepIndexOf = (s: StageEntry): number | undefined => {
  const v = obj(s.detail)?.['step']
  return typeof v === 'number' ? v : undefined
}

const shortDigest = (d?: string): string => (d ? d.slice(0, 8) : '')

/** One-line detail summary for a stage's payload — closed scalar union, always plain. */
export const detailTextOf = (detail: unknown): string => {
  if (detail == null) return ''
  if (typeof detail === 'string') return clip(detail, 90)
  if (typeof detail === 'number' || typeof detail === 'boolean') return String(detail)
  if (Array.isArray(detail)) return detail.map((d) => detailTextOf(d)).slice(0, 4).join(' ')
  const e = obj(detail)
  if (!e) return ''
  return Object.entries(e)
    .map(([k, v]) => (v == null ? k : `${k} ${typeof v === 'object' ? JSON.stringify(v).slice(0, 40) : String(v)}`))
    .slice(0, 6)
    .join(' · ')
    .slice(0, 130)
}

export const stageState = (s: StageEntry, requests: Map<string, LlmRequestEntry>): NodeState => {
  if (s.status === 'started') return 'active'
  if (okFalse(s.detail)) return 'failed'
  if (requests.get(s.stageId)?.status === 'error') return 'failed'
  return 'done'
}

const llmOf = (s: StageEntry, requests: Map<string, LlmRequestEntry>): GraphLlm | undefined => {
  const req = requests.get(s.stageId)
  if (!req) return undefined
  return {
    constrained: req.constrained,
    tokens: req.completionTokens != null ? `${req.promptTokens ?? '?'}→${req.completionTokens} tok` : undefined,
    finish: req.finishReason,
    error: req.status === 'error' ? clip(req.errorMessage ?? 'request failed', 90) : undefined,
  }
}

/* ------------------------------------------------------------------ node facts */

const node = (
  id: string,
  kind: GraphNodeKind,
  label: string,
  status: NodeState,
  extra: Partial<GraphNodeData> = {},
): GraphNode => ({
  id,
  type: kind,
  position: { x: 0, y: 0 },
  data: { kind, label, status, ...extra } as GraphNodeData,
  connectable: false,
  selectable: false,
  draggable: false,
  zIndex: kind === 'group' ? 0 : 10,
})

/**
 * The graph is deliberately laid out without a DOM measurement pass.  These are
 * therefore *reserved* card heights, rather than a generic height per node type:
 * a router or an expanded stage has extra, always-visible rows.  Advancing by the
 * old one-size estimates let the next card land on top of those rows.
 */
const layoutHeightOf = (n: GraphNode): number => {
  const d = n.data
  switch (d.kind) {
    case 'input': return 60
    case 'output': return d.detailText ? 84 : 60
    case 'branch': return 44
    case 'route': return 104
    case 'stage': return 68 + (d.llm?.error ? 18 : 0) + ((d.childCount ?? 0) > 0 ? 24 : 0)
    case 'step':
      return 70
        + (d.router ? 30 : 0)
        + (d.inputRef ? 18 : 0)
        + ((d.childCount ?? 0) > 0 ? 24 : 0)
    case 'group': return 0
  }
}

/* Layout bed: the main run advances left → right; expanded detail lives below it. */
const MAIN_X = 44
const MAIN_Y = 40
const STEP_W = 264
const STAGE_W = 248
const CHIP_W = 168
const GAP = 76
const SUB_GAP = 22
const CLUSTER_INDENT = 14

/* ------------------------------------------------------------------ build tree */

/**
 * Everything the layout needs to draw a node: the ReactFlow node itself, its option-
 * ally-expanded children, a router fan, and the ref label on the incoming edge.
 */
interface ChainItem {
  node: GraphNode
  children: ChainItem[]
  fan?: GraphNode[]
  facet?: 'router'
}

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

interface BuildCtx {
  state: ProjectState
  run: RunEntry
  expanded: Set<string>
  requests: Map<string, LlmRequestEntry>
  route: { profile?: string; confidence?: number; reason?: string; ruleVsModel?: string }
}

const buildInput = (run: RunEntry): GraphNode =>
  // Receiving run.started means input preparation has already finished. The
  // input remains useful context, but it is never the current operation after
  // the run exists in state.
  node('input', 'input', 'input', 'done', {
    detailText: `${run.inputChars ?? '?'} chars · sha:${shortDigest(run.inputDigest) || '—'}`,
    runId: run.runId,
  })

const buildOutput = (run: RunEntry): GraphNode =>
  // There is no output work in flight: this endpoint changes only when the run
  // settles. Treating run.started as an active output painted a false NOW badge.
  node('output', 'output', 'output', run.status === 'started' ? 'idle' : run.status === 'failed' ? 'failed' : 'done', {
    wallMs: run.wallMs,
    detailText: run.error ? clip(run.error, 90) : undefined,
    runId: run.runId,
  })

/** A stage is a chain item; an internal router stage also carries its chosen chip. */
function stageItem(s: StageEntry, ctx: BuildCtx): ChainItem {
  const isRouter = s.name === 'route'
  const d = obj(s.detail) ?? {}
  const chosen = isRouter ? (asStr(d, 'task') ?? asStr(d, 'profile')) : undefined
  const chosenConfidence = asNum(d, 'confidence')

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
        profile: isRouter ? ifRouterProfile(d) : undefined,
        reason: isRouter ? asStr(d, 'reason') : undefined,
        llm,
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

/** Match an executed pipeline entry to the static definition that produced it. */
const matchTopology = (state: ProjectState, entry?: { steps?: PipelineStepEntry[] }): PipelineDefinition | undefined => {
  const defs = state.topology.pipelines
  if (defs.length === 0) return undefined
  const profiles = (entry?.steps ?? []).map((s) => s.profile).filter(Boolean)
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
const inputReference = (input: PipelineStepEntry['input']): string | undefined => {
  if (!input) return undefined
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
    const ref = inputReference(ex?.input)
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

const profileMode = (state: ProjectState, profile: string): string | undefined =>
  state.topology.profiles.find((p) => p.name === profile)?.mode

/** The specialist profiles the router could have handed the note to. */
const routerCandidates = (state: ProjectState, routerProfile: string, chosen?: string): string[] => {
  const seen = new Set<string>()
  for (const p of state.topology.profiles) {
    if (p.mode !== 'pipeline' && p.mode !== 'router' && p.name !== routerProfile) seen.add(p.name)
  }
  for (const r of state.routes) if (r.profile !== routerProfile) seen.add(r.profile)
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

/** Route decision for this run: reducer-captured route.decided, else the router stage detail. */
const routeForRun = (state: ProjectState, runId: string): NonNullable<BuildCtx['route']> => {
  const re = [...state.routes].reverse().find((r) => r.runId === runId)
  if (re) return { profile: re.profile, confidence: re.confidence, reason: re.reason, ruleVsModel: re.ruleVsModel }
  return {}
}

/* ------------------------------------------------------------------ build pipeline graph */

const buildPipeline = (state: ProjectState, run: RunEntry, tree: StageEntry[], userExpanded: Set<string>): GraphBuild => {
  const pipelineRoot = tree.find((n) => n.name === 'pipeline' && n.parentId === undefined)
  const entry = state.pipelines.get(run.runId)
  const def = matchTopology(state, entry)
  const rows = mergeSteps(entry?.steps ?? [], def)
  const ctx: BuildCtx = {
    state,
    run,
    expanded: userExpanded,
    requests: state.llmRequests,
    route: routeForRun(state, run.runId),
  }

  const chain: ChainItem[] = [{ node: buildInput(run), children: [] }]

  rows.forEach((row, i) => {
    const stage = pipelineRoot?.children.find((c) => stepIndexOf(c) === i)
    const isRouter = profileMode(state, row.profile) === 'router'
    if (isRouter) {
      const chosenProfile = ctx.route.profile
      const fan = routerCandidates(state, row.profile, chosenProfile)
        .filter((p) => p !== chosenProfile)
        .map((p) => node(`branch-${p}`, 'branch', p, 'idle', { chosen: false, runId: run.runId }))
      chain.push({
        node: node(`step-${i}`, 'step', row.name, row.status, {
          stepNo: row.step,
          profile: row.profile,
          router: true,
          wallMs: row.wallMs,
          inputRef: row.inputIsInitial ? 'initial' : undefined,
          confidence: ctx.route.confidence,
          ruleVsModel: ctx.route.ruleVsModel,
          reason: ctx.route.reason,
          chosen: Boolean(chosenProfile),
          chosenProfile,
          expanded: false,
          childCount: stage ? stage.children.length : 0,
          runId: run.runId,
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
        }),
        children: stage ? stage.children.map((c) => stageItem(c, ctx)) : [],
      })
    }
  })

  chain.push({ node: buildOutput(run), children: [] })
  markChainCurrentLineage(chain)
  const { nodes, edges } = layout(chain, ctx)
  return { nodes, edges, title: `run ${run.profile} · pipeline` }
}

/* ------------------------------------------------------------------ build stage graph (non-pipeline) */

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
  const { nodes, edges } = layout(chain, ctx)
  return { nodes, edges, title: `run ${run.profile}` }
}

/* ------------------------------------------------------------------ layout */

const flowEdge = (
  source: GraphNode,
  target: GraphNode,
  kind: 'data' | 'branch' | 'ghost' = 'data',
  label?: string,
  sourceHandle = 's',
  targetHandle = 't',
): GraphEdge => {
  const COLORS: Record<typeof kind, { stroke: string; width: number; dash?: string }> = {
    data: { stroke: 'var(--secondary-foreground)', width: 1.5 },
    branch: { stroke: 'var(--primary)', width: 2 },
    ghost: { stroke: 'var(--border)', width: 1.2, dash: '5 4' },
  }
  const c = COLORS[kind]
  return {
    id: `${source.id}→${target.id}${label ? `:${label}` : ''}`,
    source: source.id,
    target: target.id,
    sourceHandle,
    targetHandle,
    type: kind === 'ghost' ? 'smoothstep' : 'smoothstep',
    animated: kind === 'branch',
    label,
    labelStyle: { fill: 'var(--muted-foreground)', fontSize: 10, fontFamily: 'inherit' as const },
    labelBgStyle: { fill: 'var(--card)', fillOpacity: 0.94 },
    labelBgPadding: [3, 1] as [number, number],
    labelBgBorderRadius: 4,
    style: {
      stroke: c.stroke,
      strokeWidth: c.width,
      strokeDasharray: c.dash,
    },
    markerEnd: {
      type: 'arrowclosed' as const,
      width: 13,
      height: 13,
      color: c.stroke,
    },
    data: { kind, label },
  }
}

const expandable = (item: ChainItem, ctx: BuildCtx): boolean =>
  item.children.length > 0 && ctx.expanded.has(item.node.id)

function layout(chain: ChainItem[], ctx: BuildCtx): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  const layoutWidthOf = (n: GraphNode): number => {
    switch (n.data.kind) {
      case 'input':
      case 'output': return 240
      case 'step': return STEP_W
      case 'stage':
      case 'route': return STAGE_W
      case 'branch': return CHIP_W
      case 'group': return 0
    }
  }

  const groupFor = (owner: ChainItem, x: number, y: number, width: number, bottom: number): void => {
    const count = owner.children.length
    const inset = 14
    const header = 25
    const label = `${count} ${count === 1 ? 'stage' : 'stages'} · ${owner.node.data.label}`
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

  const placeStage = (items: ChainItem[], x: number, y: number, gap: number): { endX: number; spanW: number; bottom: number } => {
    let cx = x
    let bottom = y
    for (const it of items) {
      nodes.push({ ...it.node, position: { x: cx, y } })
      const itemW = layoutWidthOf(it.node)
      bottom = Math.max(bottom, y + layoutHeightOf(it.node))
      cx += itemW + gap
      if (expandable(it, ctx) && it.children.length > 0) {
        const nested = placeStage(it.children, cx - itemW, y + layoutHeightOf(it.node) + 42, SUB_GAP)
        groupFor(it, cx - itemW, y + layoutHeightOf(it.node) + 42, nested.spanW, nested.bottom)
        cx = nested.endX + gap
        bottom = Math.max(bottom, nested.bottom)
      }
    }
    return { endX: cx - gap, spanW: cx - x - gap, bottom }
  }

  // Lay out the primary path first. Disclosures get their own lane below the
  // spine; anchoring every cluster directly beneath its owner made adjacent
  // expanded steps paint on top of one another.
  const placed: Array<{ item: ChainItem; x: number; height: number }> = []
  let x = MAIN_X
  chain.forEach((it) => {
    const h = layoutHeightOf(it.node)
    const w = layoutWidthOf(it.node)
    const itemLeft = x
    nodes.push({ ...it.node, position: { x, y: MAIN_Y } })
    placed.push({ item: it, x: itemLeft, height: h })
    x = itemLeft + w + GAP
  })

  const mainBottom = MAIN_Y + Math.max(0, ...placed.map(({ height }) => height))
  const detailY = mainBottom + 52
  let detailCursor = MAIN_X
  let detailBottom = detailY

  for (const { item, x: itemLeft } of placed) {
    if (!expandable(item, ctx)) continue
    const clusterX = Math.max(itemLeft + CLUSTER_INDENT, detailCursor)
    const cluster = placeStage(item.children, clusterX, detailY, SUB_GAP)
    groupFor(item, clusterX, detailY, cluster.spanW, cluster.bottom)
    detailCursor = cluster.endX + 54
    detailBottom = Math.max(detailBottom, cluster.bottom + 14)
  }

  // Route alternatives form a separate, quiet lane beneath implementation
  // detail. Keeping these two kinds of disclosure apart makes their ownership
  // obvious and prevents the legend/branch tangle visible in dense runs.
  const fanY = detailBottom + 46
  let fanCursor = MAIN_X
  for (const { item, x: itemLeft } of placed) {
    if (!item.fan) continue
    let fx = Math.max(itemLeft, fanCursor)
    for (const chip of item.fan) {
      nodes.push({ ...chip, position: { x: fx, y: fanY } })
      fx += layoutWidthOf(chip) + 14
    }
    fanCursor = fx + 40
  }

  // The primary path remains a single uninterrupted spine. Expanded stages are
  // diagnostic detail, not a detour through the pipeline: routing the spine through
  // them produced the long return loops that made execution direction unreadable.
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i]!
    const b = chain[i + 1]!
    const kind = a.facet === 'router' ? 'branch' : a.node.data.kind === 'route' ? 'branch' : 'data'
    const label = kind === 'branch' && a.node.data.chosenProfile
      ? `selected: ${a.node.data.chosenProfile}`
      : !(b.node.data.kind === 'output' || b.node.data.kind === 'input')
      ? b.node.data.inputRef && b.node.data.inputRef !== 'initial'
        ? b.node.data.inputRef
        : undefined
      : undefined

    edges.push(flowEdge(a.node, b.node, kind, label))
  }

  const expandedEdges = (item: ChainItem): void => {
    if (!expandable(item, ctx)) return
    const children = item.children
    if (children.length === 0) return
    edges.push(flowEdge(item.node, children[0]!.node, 'data', undefined, 'detail', 'top'))
    for (let i = 0; i < children.length - 1; i++) {
      edges.push(flowEdge(children[i]!.node, children[i + 1]!.node))
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
    for (const chip of it.fan) {
      edges.push(flowEdge(it.node, chip, 'ghost', undefined, 'detail', 'tl'))
    }
  }

  return { nodes, edges }
}

/* ------------------------------------------------------------------ entry */

export const buildGraph = (state: ProjectState, runId: string, expanded: Set<string>): GraphBuild => {
  const run = state.runs.get(runId)
  if (!run) return { nodes: [], edges: [], title: '' }

  // Internal router stages always show their chosen chip, so a routing decision is
  // visible even before the user expands anything else.
  const tree = stageTreeForRun(state.stages, runId)
  const pipelineRoot = tree.find((n) => n.name === 'pipeline' && n.parentId === undefined)
  const pipelineEntry = state.pipelines.get(runId)
  const isPipeline = Boolean(pipelineRoot || (pipelineEntry && pipelineEntry.steps.length > 0))
  return isPipeline ? buildPipeline(state, run, tree, expanded) : buildStages(state, run, tree, expanded)
}
