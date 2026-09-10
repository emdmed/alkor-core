/**
 * Shared palette for every graph builder: leaf predicates, the node/edge factories,
 * and the fixed geometry the deterministic layout advances by.
 *
 * The graph is deliberately laid out without a DOM measurement pass, so the geometry
 * here is a contract both `run.ts` and `project.ts` build against. Advancing by the
 * old one-size estimates would let the next card land on top of a reserved row.
 */
import type { StageEntry, LlmRequestEntry } from '../../../../src/tui/state.ts'
import type { NodeState } from '../format.ts'
import type { GraphBuild, GraphEdge, GraphNode, GraphNodeData, GraphNodeKind, GraphOperation, CompactStepData } from './types.ts'

/* ------------------------------------------------------------------ leaf predicates */

export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

export const obj = (d: unknown): Record<string, unknown> | undefined =>
  typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : undefined

export const asNum = (d: Record<string, unknown>, k: string): number | undefined => {
  const v = d[k]
  return typeof v === 'number' ? v : undefined
}

export const asStr = (d: Record<string, unknown>, k: string): string | undefined => {
  const v = d[k]
  return typeof v === 'string' ? v : undefined
}

const okFalse = (d: unknown): boolean => obj(d)?.['ok'] === false

export const operationFor = (name: string, decision = false): GraphOperation => {
  if (decision || name === 'route' || name === 'tool-call') return 'decision'
  if (name === 'llm-call' || name === 'medication-pass' || name === 'transcript-repair') return 'model'
  if (name === 'prompt-assembly' || name === 'parse' || name === 'verify' || name === 'rule-match' || name === 'gateway') return 'code'
  return 'orchestrator'
}

export const shortDigest = (d?: string): string => (d ? d.slice(0, 8) : '')

/** The `{ step }` the pipeline stamps on each per-step stage, to join stage ↔ step. */
export const stepIndexOf = (s: StageEntry): number | undefined => {
  const v = obj(s.detail)?.['step']
  return typeof v === 'number' ? v : undefined
}

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

export const llmOf = (s: StageEntry, requests: Map<string, LlmRequestEntry>): GraphNodeData['llm'] => {
  const req = requests.get(s.stageId)
  if (!req) return undefined
  return {
    constrained: req.constrained,
    tokens: req.completionTokens != null ? `${req.promptTokens ?? '?'}→${req.completionTokens} tok` : undefined,
    finish: req.finishReason,
    error: req.status === 'error' ? clip(req.errorMessage ?? 'request failed', 90) : undefined,
  }
}

/* ------------------------------------------------------------------ node factory */

export const node = (
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

/* ------------------------------------------------------------------ edge factory */

export const flowEdge = (
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

/** De-emphasise an edge that denotes a real but unchosen alternative. */
export const muteEdge = (edge: GraphEdge): void => {
  edge.style = { ...edge.style, opacity: 0.52 }
  edge.labelStyle = { ...edge.labelStyle, opacity: 0.72 }
  edge.animated = false
  edge.data = { ...edge.data, muted: true }
}

/* ------------------------------------------------------------------ geometry */

/* Layout bed: the main run advances left → right; expanded detail lives below it. */
export const MAIN_X = 44
export const MAIN_Y = 40
export const STEP_W = 264
export const STAGE_W = 248
export const CHIP_W = 168
export const GAP = 76
export const SUB_GAP = 22
const COLUMN_PITCH = STEP_W + GAP
export const ROW_GAP = 82
export const columnX = (rank: number): number => MAIN_X + rank * COLUMN_PITCH

/**
 * Reserved card heights, rather than a generic height per node type: a router or an
 * expanded stage has extra, always-visible rows, and the layout must step past them.
 */
export const layoutHeightOf = (n: GraphNode): number => {
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
    case 'compact-pipeline': {
      const stepCount = (n.data.steps as CompactStepData[] | undefined)?.length ?? 0
      const routerCount = ((n.data.steps as CompactStepData[] | undefined) ?? []).filter((step) => step.router && step.chosenProfile).length
      return 97 + stepCount * 36 + routerCount * 27
    }
  }
}

export const layoutWidthOf = (n: GraphNode): number => {
  switch (n.data.kind) {
    case 'input':
    case 'output': return 240
    case 'step': return STEP_W
    case 'stage':
    case 'route': return STAGE_W
    case 'branch': return CHIP_W
    case 'profile': return 196
    case 'group': return 0
    case 'compact-pipeline': return 420
  }
}

export const graphBounds = (nodes: GraphNode[], includeGroups = false): { left: number; top: number; right: number; bottom: number } => {
  if (nodes.length === 0) return { left: MAIN_X, top: MAIN_Y, right: MAIN_X, bottom: MAIN_Y }
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const n of nodes) {
    if (n.data.kind === 'group' && !includeGroups) continue
    const width = typeof n.style?.width === 'number' ? n.style.width : n.measured?.width ?? (
      n.data.kind === 'step' ? STEP_W : n.data.kind === 'stage' || n.data.kind === 'route' ? STAGE_W : n.data.kind === 'profile' ? 196 : n.data.kind === 'branch' ? CHIP_W : n.data.kind === 'compact-pipeline' ? 420 : 240
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
export const placeGraph = (graph: GraphBuild, prefix: string, yOffset: number): GraphBuild => {
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
