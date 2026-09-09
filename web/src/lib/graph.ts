/**
 * Graph model for the pipeline execution view.
 *
 * Turns configured topology plus the flat activity reducer state into graph models.
 * The operating view uses a single selected execution trail; the fuller project-map
 * builders remain available for callers that explicitly need topology inspection.
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
  ProfileEntry,
  ProjectState,
  RunEntry,
  StageEntry,
} from '../../../src/tui/state.ts'
import { stageTreeForRun } from '../../../src/tui/state.ts'
import type { ProfileTopologyStage } from '../../../src/core/topology.ts'
import type { NodeState } from './format.ts'

export type GraphNodeKind = 'input' | 'route' | 'step' | 'stage' | 'branch' | 'profile' | 'output' | 'group'
export type GraphOperation = 'model' | 'code' | 'orchestrator' | 'decision'

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
  tasks?: string[]
  confidence?: number
  ruleVsModel?: string
  reason?: string
  expanded?: boolean
  childCount?: number
  chosen?: boolean
  chosenProfile?: string
  mode?: string
  configured?: boolean
  /** A visible-but-deemphasised alternative after a router has committed. */
  muted?: boolean
  /** The project's configured front-door routing decision. */
  entryPoint?: boolean
  /** Stable un-namespaced id used by expansion state in a composed project graph. */
  expandKey?: string
  llm?: GraphLlm
  runId?: string
  /** What performs this operation; used to separate model boundaries from deterministic code. */
  operation?: GraphOperation
  /** Injected by the view layer: toggles this node's sub-graph. */
  onToggle?: () => void
  /** Injected by the view layer: opens the inspector on this node. */
  onInspect?: () => void
  /** The most specific active node for this run; called out by the operating view. */
  current?: boolean
  /** This node received data during the selected run; persists after completion. */
  traversed?: boolean
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

const operationFor = (name: string, decision = false): GraphOperation => {
  if (decision || name === 'route' || name === 'tool-call') return 'decision'
  if (name === 'llm-call' || name === 'medication-pass' || name === 'transcript-repair') return 'model'
  if (name === 'prompt-assembly' || name === 'parse' || name === 'verify' || name === 'rule-match' || name === 'gateway') return 'code'
  return 'orchestrator'
}

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
    case 'profile': return 62
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
const COLUMN_PITCH = STEP_W + GAP
const ROW_GAP = 82
const columnX = (rank: number): number => MAIN_X + rank * COLUMN_PITCH

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

/** A stage is a chain item; an internal router stage also carries its chosen chip. */
function stageItem(s: StageEntry, ctx: BuildCtx): ChainItem {
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
        operation: llm ? 'model' : operationFor(s.name, isRouter),
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
const inputReference = (input: PipelineStepEntry['input'] | PipelineDefinition['steps'][number]['input']): string | undefined => {
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

const profileMode = (state: ProjectState, profile: string): string | undefined =>
  state.topology.profiles.find((p) => p.name === profile)?.mode

const declaredRouteTargets = (state: ProjectState, profileName: string): string[] => {
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

/** Route decision for this run: reducer-captured route.decided, else the router stage detail. */
const routeForRun = (state: ProjectState, runId: string, tree: StageEntry[] = []): NonNullable<BuildCtx['route']> => {
  const re = [...state.routes].reverse().find((r) => r.runId === runId)
  if (re) return { profile: re.profile, confidence: re.confidence, reason: re.reason, ruleVsModel: re.ruleVsModel }
  // Older activity buffers may predate run-scoped route.decided events. The stage tree is
  // already scoped to this run, so its router result is an equally precise fallback.
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
      const nested = visit(stage.children)
      if (nested) return nested
    }
    return undefined
  }
  const stageRoute = visit(tree)
  if (stageRoute) return stageRoute
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
    route: routeForRun(state, run.runId, tree),
  }

  const chain: ChainItem[] = [{ node: buildInput(run), children: [] }]

  rows.forEach((row, i) => {
    const stage = pipelineRoot?.children.find((c) => stepIndexOf(c) === i)
    const isRouter = profileMode(state, row.profile) === 'router'
    if (isRouter) {
      const chosenProfile = ctx.route.profile
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
          confidence: ctx.route.confidence,
          ruleVsModel: ctx.route.ruleVsModel,
          reason: ctx.route.reason,
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
  const { nodes, edges } = layoutTrail(chain, ctx)
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
    branch: { stroke: 'var(--success)', width: 2.4 },
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
    animated: false,
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
  item.children.length > 0 && (item.node.data.kind === 'route' || ctx.expanded.has(item.node.id))

const layoutWidthOf = (n: GraphNode): number => {
  switch (n.data.kind) {
    case 'input':
    case 'output': return 240
    case 'step': return STEP_W
    case 'stage':
    case 'route': return STAGE_W
    case 'branch': return CHIP_W
    case 'profile': return 196
    case 'group': return 0
  }
}

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

/* ------------------------------------------------------------------ full configured topology */

/** Build an idle pipeline from configuration alone, before its first activity event. */
const buildConfiguredPipeline = (state: ProjectState, def: PipelineDefinition): GraphBuild => {
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
    const isRouter = profileMode(state, step.profile) === 'router'
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

const graphBounds = (nodes: GraphNode[]): { left: number; top: number; right: number; bottom: number } => {
  if (nodes.length === 0) return { left: MAIN_X, top: MAIN_Y, right: MAIN_X, bottom: MAIN_Y }
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const n of nodes) {
    if (n.data.kind === 'group') continue
    const width = typeof n.style?.width === 'number' ? n.style.width : n.measured?.width ?? (
      n.data.kind === 'step' ? STEP_W : n.data.kind === 'stage' || n.data.kind === 'route' ? STAGE_W : n.data.kind === 'profile' ? 196 : n.data.kind === 'branch' ? CHIP_W : 240
    )
    const height = typeof n.style?.height === 'number' ? n.style.height : layoutHeightOf(n)
    left = Math.min(left, n.position.x)
    top = Math.min(top, n.position.y)
    right = Math.max(right, n.position.x + width)
    bottom = Math.max(bottom, n.position.y + height)
  }
  return { left, top, right, bottom }
}

/** Namespace one run graph so every configured pipeline can coexist on one canvas. */
const placeGraph = (graph: GraphBuild, prefix: string, yOffset: number): GraphBuild => {
  const id = (raw: string): string => `${prefix}/${raw}`
  return {
    title: graph.title,
    nodes: graph.nodes.map((n) => ({
      ...n,
      id: id(n.id),
      position: { x: n.position.x, y: n.position.y + yOffset },
      data: { ...n.data, expandKey: n.data.expandKey ?? n.id },
    })),
    edges: graph.edges.map((e) => ({
      ...e,
      id: id(e.id),
      source: id(e.source),
      target: id(e.target),
    })),
  }
}

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

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const routerSources: GraphNode[] = []
  let laneY = MAIN_Y
  let selectedPlaced = false
  const pipelineOutputRank = Math.max(0, ...state.topology.pipelines.map((pipeline) => pipeline.steps.length)) + 1

  const laneFirstSteps: GraphNode[] = []

  const addLane = (raw: GraphBuild, prefix: string, label: string, alignOutput: boolean): void => {
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
      if (output) output.position.x = columnX(pipelineOutputRank)
    }

    const bounds = graphBounds(placed.nodes)
    nodes.push({
      ...node(`${prefix}/lane`, 'group', label, 'idle'),
      position: { x: bounds.left - 20, y: bounds.top - 30 },
      style: { width: bounds.right - bounds.left + 40, height: bounds.bottom - bounds.top + 50 },
    })
    nodes.push(...placed.nodes)
    edges.push(...placed.edges)
    const summaryRouters = placed.nodes.filter((n) => n.data.kind === 'step' && n.data.router)
    routerSources.push(...(summaryRouters.length > 0 ? summaryRouters : placed.nodes.filter((n) => n.data.kind === 'route')))

    // Track the first non-group node so the shared input can connect to it.
    const firstStep = placed.nodes.find((n) => n.data.kind !== 'group')
    if (firstStep) laneFirstSteps.push(firstStep)

    laneY = bounds.bottom + ROW_GAP
  }

  for (const def of state.topology.pipelines) {
    const isSelected = selected?.profile === def.name
    const raw = isSelected ? buildGraph(state, selected.runId, expanded) : buildConfiguredPipeline(state, def)
    selectedPlaced ||= isSelected
    addLane(raw, `pipeline-${def.name}`, `${def.name} · pipeline`, true)
  }

  // A direct profile run is still useful operational detail, but it sits alongside the
  // configured topology instead of replacing it.
  if (selected && !selectedPlaced) {
    addLane(buildGraph(state, selected.runId, expanded), `run-${selected.runId}`, `${selected.profile} · selected run`, false)
  }

  // A single shared entry point serves every lane instead of one input per pipeline.
  if (laneFirstSteps.length > 0) {
    const sharedInput = node('input', 'input', 'Prompt input', selected ? 'done' : 'idle', {
      runId: selected?.runId,
      traversed: Boolean(selected),
      operation: 'orchestrator',
    })
    const firstCenters = laneFirstSteps.map((target) => target.position.y + layoutHeightOf(target) / 2)
    sharedInput.position = {
      x: columnX(0),
      y: (Math.min(...firstCenters) + Math.max(...firstCenters)) / 2 - layoutHeightOf(sharedInput) / 2,
    }
    nodes.push(sharedInput)
    for (const target of laneFirstSteps) {
      edges.push(flowEdge(sharedInput, target, 'data', undefined, 's', 't'))
    }
  }

  const topologyRoutes = (profileName: string): Array<{ name: string; targetProfile?: string; available?: boolean }> => {
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
  const routedTargets = new Set(
    state.topology.profiles.flatMap((profile) => topologyRoutes(profile.name).flatMap((route) => route.targetProfile ? [route.targetProfile] : [])),
  )
  if (state.topology.profiles.some((profile) => profile.mode === 'router' && topologyRoutes(profile.name).every((route) => !route.targetProfile))) {
    for (const profile of state.topology.profiles) {
      if (profile.mode !== 'pipeline' && profile.mode !== 'router') routedTargets.add(profile.name)
    }
  }
  const missingTargets = [...routedTargets].filter((name) => !state.topology.profiles.some((profile) => profile.name === name))
  const allProfiles: Array<ProfileEntry & { configured: boolean }> = [
    ...state.topology.profiles.map((profile) => ({ ...profile, configured: true })),
    ...missingTargets.map((name) => ({ name, mode: 'unconfigured', configured: false })),
  ]
  const routedProfile = (source: GraphNode): string | undefined =>
    source.data.kind === 'route' ? source.data.profile : source.data.chosenProfile
  const chosenProfiles = new Set(routerSources.map(routedProfile).filter((p): p is string => Boolean(p)))
  const chosenTasksByStage = new Map<string, string[]>()
  const observedStagesByProfile = new Map<string, Map<string, StageEntry>>()
  if (selected) {
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
  }
  const profileNodes: GraphNode[] = []
  const crossProfileRoutes: Array<{ source: GraphNode; target: string; chosen: boolean; muted: boolean }> = []
  const lanesBottom = graphBounds(nodes).bottom
  const profileX = columnX(0)
  let profileY = lanesBottom + 58

  const muteEdge = (edge: GraphEdge): void => {
    edge.style = { ...edge.style, opacity: 0.52 }
    edge.labelStyle = { ...edge.labelStyle, opacity: 0.72 }
    edge.animated = false
    edge.data = { ...edge.data, muted: true }
  }

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

    let rowRight = profileX + 196
    let rowBottom = profileY + layoutHeightOf(profileNode)
    const renderStages = (
      stages: ProfileTopologyStage[],
      path: string,
      startRank: number,
      y: number,
      source: GraphNode,
      inheritedMuted: boolean,
    ): { right: number; bottom: number; last: GraphNode; lastRank: number; nextRank: number } => {
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
        const observed = inheritedMuted ? undefined : observedStagesByProfile.get(profile.name)?.get(stage.name)
        const observedStatus = observed ? stageState(observed, state.llmRequests) : 'idle'
        const stageNode = node(`blueprint-${profile.name}-${path}-${stageIndex}`, kind, stage.name, observedStatus, {
          profile: profile.name,
          detail: observed?.detail,
          detailText: observed ? detailTextOf(observed.detail) || flags || undefined : flags || undefined,
          wallMs: observed?.wallMs,
          llm: observed ? llmOf(observed, state.llmRequests) : undefined,
          runId: observed ? selected?.runId : undefined,
          traversed: Boolean(observed),
          current: observedStatus === 'active',
          muted: inheritedMuted,
          operation: operationFor(stage.name, stage.kind === 'decision'),
        })
        stageNode.position = { x, y }
        nodes.push(stageNode)
        const connector = flowEdge(from, stageNode, 'ghost', undefined, 's', 't')
        if (inheritedMuted) muteEdge(connector)
        edges.push(connector)
        bottom = Math.max(bottom, y + layoutHeightOf(stageNode))
        localRight = Math.max(localRight, x + STAGE_W)

        if ((stage.routes?.length ?? 0) > 0) {
          const localChoiceOrder = chosenTasksByStage.get(stage.name) ?? []
          const externalChoiceOrder = (stage.routes ?? [])
            .filter((route) => route.targetProfile && chosenProfiles.has(route.targetProfile))
            .map((route) => route.name)
          const directChoiceOrder = [...new Set([...localChoiceOrder, ...externalChoiceOrder])]
            .filter((name) => stage.routes?.some((route) => route.name === name))
          const directChoices = new Set(directChoiceOrder)
          let routeY = y
          let routeRight = x + STAGE_W
          let maxRouteRank = stageRank
          const routes = stage.routes ?? []
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
            // full chosen/unchosen comparison remains visible, preserving the diagnostic
            // value of the project graph for older callers.
            const branchExpanded = Boolean(selected) || expanded.has(branchId)
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
            nodes.push(branch)
            const routeEntry = directChoice && !runtimeFeeder
            const routeEdge = flowEdge(stageNode, branch, routeEntry ? 'branch' : 'ghost', routeEntry ? 'selected' : undefined, 's', 'left')
            if (routeMuted || (directChoices.size > 0 && !routeEntry)) muteEdge(routeEdge)
            edges.push(routeEdge)

            let branchRight = branch.position.x + CHIP_W
            let branchBottom = branchY + layoutHeightOf(branch)
            let terminal = branch
            let terminalRank = branchRank
            if (route.stages?.length && branchExpanded) {
              const nested = renderStages(route.stages, `${path}-${stageIndex}-route-${routeIndex}`, branchRank + 1, branchY, branch, routeMuted)
              branchRight = nested.right
              branchBottom = Math.max(branchBottom, nested.bottom)
              terminal = nested.last
              terminalRank = nested.lastRank
            }
            renderedRoutes.set(route.name, { terminal, terminalRank, right: branchRight, y: branchY, muted: routeMuted, chosen: isChosen })
            if (renderedFeeder) {
              const feedEdge = flowEdge(renderedFeeder.terminal, branch, renderedFeeder.chosen ? 'branch' : 'ghost', undefined, 's', 'left')
              if (renderedFeeder.muted) muteEdge(feedEdge)
              edges.push(feedEdge)
            }
            if (route.targetProfile) crossProfileRoutes.push({ source: branch, target: route.targetProfile, chosen: isChosen, muted: routeMuted })
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
      rowRight = Math.max(rowRight, localRight)
      return { right: localRight, bottom, last: from, lastRank, nextRank: rank }
    }

    if (profile.topology?.stages.length) {
      const rendered = renderStages(profile.topology.stages, 'root', 1, profileY, profileNode, profileMuted)
      rowRight = Math.max(rowRight, rendered.right)
      rowBottom = Math.max(rowBottom, rendered.bottom)
    }

    const profileGroup = {
      ...node(`profile-group-${profile.name}`, 'group', `${profile.name} · ${profile.mode}`, profile.configured === false ? 'failed' : 'idle'),
      position: { x: profileX - 20, y: profileY - 30 },
      style: { width: rowRight - profileX + 40, height: rowBottom - profileY + 50 },
    }
    nodes.push(profileGroup)
    profileY = rowBottom + ROW_GAP
  }

  nodes.push(...profileNodes)

  for (const source of routerSources) {
    const chosen = routedProfile(source)
    const sourceProfile = source.data.kind === 'step' ? source.data.profile : selected?.profile
    const declaredTargets = topologyRoutes(sourceProfile ?? '').flatMap((route) => route.targetProfile ? [route.targetProfile] : [])
    const fallbackTargets = state.topology.profiles
      .filter((profile) => profile.mode !== 'pipeline' && profile.mode !== 'router' && profile.name !== sourceProfile)
      .map((profile) => profile.name)
    const targets = new Set(declaredTargets.length > 0 ? declaredTargets : fallbackTargets)
    for (const profile of profileNodes.filter((candidate) => targets.has(String(candidate.data.profile)))) {
      const isChosen = chosen === profile.data.profile
      const edge = flowEdge(source, profile, isChosen ? 'branch' : 'ghost', isChosen ? 'selected' : undefined, 'detail', 'top')
      if (chosen && !isChosen) {
        muteEdge(edge)
      }
      edges.push(edge)
    }
  }

  for (const route of crossProfileRoutes) {
    const target = profileNodes.find((profile) => profile.data.profile === route.target)
    if (!target) continue
    const edge = flowEdge(route.source, target, route.chosen ? 'branch' : 'ghost', undefined, 's', 'top')
    if (route.muted) muteEdge(edge)
    edges.push(edge)
  }

  // Several nodes can legitimately route at different scopes. Label only the configured
  // front door, and only when the graph would otherwise contain an ambiguous set of them.
  const routingNodes = nodes.filter(
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

  // Runtime activity is a semantic overlay on the stable system map. A traversed
  // node stays green after it completes; an edge turns green only when data reached
  // both ends, so untouched alternatives remain visibly available but unselected.
  if (selected) {
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
      edge.style = { ...edge.style, stroke: 'var(--success)', strokeWidth: 2.6, strokeDasharray: undefined, opacity: 1 }
      edge.markerEnd = { type: 'arrowclosed', width: 14, height: 14, color: 'var(--success)' }
      edge.animated = nodes.find((candidate) => candidate.id === edge.target)?.data.status === 'active'
      edge.data = { ...edge.data, traversed: true }
    }
  }

  const count = state.topology.pipelines.length
  const runTitle = selected ? ` · selected run ${selected.profile} ${shortDigest(selected.runId)}` : ''
  const missingTitle = missingTargets.length > 0 ? ` · ${missingTargets.length} unresolved route target${missingTargets.length === 1 ? '' : 's'}` : ''
  return {
    nodes,
    edges,
    title: `${count} pipeline${count === 1 ? '' : 's'} · ${state.topology.profiles.length} configured profiles${missingTitle}${runTitle}`,
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
    const rawBounds = graphBounds(raw.nodes)
    const placed = placeGraph(raw, `pipeline-lane-${pipeline.name}`, nextY - rawBounds.top)
    const bounds = graphBounds(placed.nodes)
    nodes.push(...placed.nodes)
    edges.push(...placed.edges)

    nodes.push({
      ...node(`pipeline-lane-group-${pipeline.name}`, 'group', `${pipeline.name} · pipeline`, isSelected ? 'active' : 'idle', {
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

  const count = state.topology.pipelines.length
  return { nodes, edges, title: `${count} pipeline${count === 1 ? '' : 's'} · full process detail` }
}

export interface ExpandedGraphBuild extends GraphBuild {
  expanded: Set<string>
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
