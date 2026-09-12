/**
 * Shared palette for every graph builder: leaf predicates, the node/edge factories,
 * and the fixed geometry the deterministic layout advances by.
 *
 * The graph is deliberately laid out without a DOM measurement pass, so the geometry
 * here is a contract both `run.ts` and `project.ts` build against. Advancing by the
 * old one-size estimates would let the next card land on top of a reserved row.
 */
import type { StageEntry, LlmRequestEntry } from '../../../../src/monitor/state.ts'
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

/**
 * What performs a stage.
 *
 * `declared` is what the emitter or the published topology SAID, and it always wins. The
 * name table below is the fallback for a stream or a profile that says nothing — an older
 * backend, or a profile that has not been taught to declare yet. It is deliberately not the
 * primary path: a list of names maintained over here goes stale every time a profile adds a
 * pass, and it did, which is why `medication-pass` was the only clinical bracket it knew.
 */
export const operationFor = (name: string, decision = false, declared?: GraphOperation): GraphOperation => {
  if (declared) return declared
  if (decision || name === 'route' || name === 'tool-call') return 'decision'
  if (name === 'llm-call' || name === 'medication-pass' || name === 'transcript-repair') return 'model'
  if (name === 'prompt-assembly' || name === 'parse' || name === 'verify' || name === 'rule-match' || name === 'gateway') return 'code'
  return 'orchestrator'
}

/**
 * Can a router send an input to this profile?
 *
 * A `workflow` is a recipe rather than a destination, a `router` is the thing doing the
 * sending, and a `code` profile is a step inside a recipe — a deterministic composer or
 * checker that nothing routes TO. Drawing any of them as a candidate branch invents a choice
 * the deployment does not offer.
 */
export const isRoutableSpecialist = (mode?: string): boolean =>
  mode !== 'workflow' && mode !== 'router' && mode !== 'code'

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
  // One weight per meaning, and the three are told apart by weight and dash before colour:
  // a reference is the thinnest solid line, the path the run took is the heaviest, and a
  // path it did not take is a fine dotted rule that reads as an absence rather than as the
  // border of some container. The data stroke is `--edge` because that is the value the
  // legend's own swatch paints, and a legend that does not match its edge explains nothing.
  const COLORS: Record<typeof kind, { stroke: string; width: number; dash?: string }> = {
    data: { stroke: 'var(--edge)', width: 1.5 },
    branch: { stroke: 'var(--route-selected)', width: 2 },
    ghost: { stroke: 'var(--route-possible)', width: 1.25, dash: '2 5' },
  }
  // The edge into a node that is running right now carries the document: it takes the live
  // colour, so "where is the work" is answerable from the canvas at any zoom, without
  // reading a single label.
  const live = target.data.status === 'active'
  const c = live ? { stroke: 'var(--primary)', width: 2, dash: undefined } : COLORS[kind]
  return {
    id: `${source.id}→${target.id}${label ? `:${label}` : ''}`,
    source: source.id,
    target: target.id,
    className: live ? 'is-live' : undefined,
    sourceHandle,
    targetHandle,
    type: 'smoothstep',
    // Orthogonal, but not mitred: a hard 90° corner is the default every node editor ships
    // with, and on a board of 10px-radius cards it is the one shape that says nobody chose
    // it. The radius is the card radius, so a turn and a corner are the same gesture.
    pathOptions: { borderRadius: 10 },
    animated: false,
    label,
    // An edge label is read once to find your place, which is exactly what the 11px label
    // step is for. It was set at 10px, below every step in the ramp.
    labelStyle: {
      fill: 'var(--muted-foreground)',
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase' as const,
      fontFamily: 'inherit' as const,
    },
    labelBgStyle: { fill: 'var(--card)', fillOpacity: 0.94 },
    labelBgPadding: [5, 2] as [number, number],
    labelBgBorderRadius: 5,
    style: {
      stroke: c.stroke,
      strokeWidth: c.width,
      strokeDasharray: c.dash,
    },
    markerEnd: {
      type: 'arrowclosed' as const,
      width: 11,
      height: 11,
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
/* Enough vertical air for a smoothstep edge to turn and land its arrowhead, and no
   more: the old 82 left the entry node marooned above a board it belongs to. */
export const ROW_GAP = 60
export const columnX = (rank: number): number => MAIN_X + rank * COLUMN_PITCH

/* Compact-card geometry contract. A CompactWorkflowNode card is rendered by the browser
   with natural height, so these constants must stay aligned with the `.g-compact`/`.c-*`
   CSS block in styles.css; the deterministic sibling layout advances by this model and
   nothing measures the DOM first. */
export const COMPACT_HEADER_H = 38 /* .c-header min-height, border-box */
export const COMPACT_PROGRESS_H = 3 /* .c-progress height */
export const COMPACT_TERMINAL_H = 28 /* .c-terminal min-height, border-box */
export const COMPACT_STEP_H = 36 /* .c-step-main min-height, border-box */
export const COMPACT_ROUTER_H = 27 /* .c-step-router-info min-height, border-box */
export const COMPACT_STAGE_H = 20 /* one .c-stage row: 2px pad top/bottom + 16px nowrap line */
export const COMPACT_STAGES_EXTRAS_H = 12 /* .c-stages pad-top 2 + pad-bottom 6 + margin-bottom 4 */
export const COMPACT_ROUTE_NOTE_H = 22 /* .c-route-note min-height, border-box */

/**
 * Which chrome rows one compact card draws.
 *
 * A card that owns the document draws both terminals; a route card nested in a workflow
 * draws neither; a workflow split across a branch draws the Input on its first segment and
 * the Output on its last. The note row takes the place of the Input row, so a card without
 * one still has somewhere to say what it is — which is the only place a route card's
 * "not raised by this note" has ever lived.
 *
 * Both the layout model here and `CompactWorkflowNode` read this, so the reserved height and
 * the rendered height cannot drift apart.
 */
export const compactChrome = (d: GraphNodeData): { input: boolean; output: boolean; note: boolean } => {
  const both = d.terminals !== false
  const input = d.showInput ?? both
  const output = d.showOutput ?? both
  return { input, output, note: !input && Boolean(d.detailText || d.reason) }
}
/** One compact card's rendered width; route cards sit side by side on this pitch. */
export const COMPACT_W = 360
/** Gap between two route cards of the same workflow, across and down. */
export const ROUTE_GAP = 40
/** Vertical gap between two stacked route chips in the fan's last column. */
export const CHIP_GAP = 12

/**
 * Stable disclosure key for one compact step disclosure. Formed from the owning
 * workflow node id and the step number so a different run of the same workflow never
 * reuses the same key, and a step's key never depends on DOM or ordering.
 */
export const compactStepKey = (nodeId: string, stepNo: number): string => `${nodeId}/step-${stepNo}`

/**
 * Stable disclosure key for a whole compact card, in the same namespace as its steps.
 *
 * A workflow the run did not take is collapsed to its header, and the only way back to its
 * steps is on the canvas — the inspector shows what a node IS, never what it contains. So the
 * card is a disclosure like any other, and it shares the one set the view already prunes.
 */
export const compactCardKey = (nodeId: string): string => `${nodeId}/card`

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
    // The front door grows a line once it has a decision to report.
    case 'gateway': return d.chosenProfile ? 76 : 56
    case 'compact-workflow': {
      // Collapsed to its header: the card still says what it is and how much it holds, and
      // nothing more. Its steps are still in the data, waiting to be disclosed. A card whose
      // note row IS its explanation — "not raised by this note" — keeps that one line, or
      // collapsing it would turn a stated reason into a silent absence.
      if (d.collapsed === true) return COMPACT_HEADER_H + (compactChrome(d).note ? COMPACT_ROUTE_NOTE_H : 0)
      const steps = (n.data.steps as CompactStepData[] | undefined) ?? []
      const routerCount = steps.filter((step) => step.router && step.chosenProfile).length
      // Each expanded step paints its own `.c-stages` container, so its padding and
      // margin land once per disclosed step, and each disclosed stage owns one row.
      const disclosed = steps.filter((step) => (step.stageRowCount ?? (step.expanded ? step.stages.length : 0)) > 0)
      const stageRows = disclosed.reduce((total, step) => total + (step.stageRowCount ?? step.stages.length), 0)
      // A route card inside a workflow renders no Input/Output rows, and a workflow segment
      // renders only the terminal at its end of the chain: the document arrives once and
      // leaves once, however many cards the workflow is drawn across.
      const chrome = compactChrome(d)
      const base = COMPACT_HEADER_H + COMPACT_PROGRESS_H
        + (chrome.input ? COMPACT_TERMINAL_H : 0)
        + (chrome.output ? COMPACT_TERMINAL_H : 0)
        + (chrome.note ? COMPACT_ROUTE_NOTE_H : 0)
      return base
        + steps.length * COMPACT_STEP_H
        + routerCount * COMPACT_ROUTER_H
        + disclosed.length * COMPACT_STAGES_EXTRAS_H
        + stageRows * COMPACT_STAGE_H
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
    // The front door stands in the same column, at the same width, as every workflow card it
    // opens. At 340 against the cards' 360 it was a box that nearly lined up, which on a
    // single-column board reads as a mistake — and its centred handle sat 10px off the spine.
    case 'gateway': return COMPACT_W
    case 'compact-workflow': return COMPACT_W
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
    // One table of widths, not two: this used to restate `layoutWidthOf` inline and the two
    // had already drifted apart on the gateway.
    const width = typeof n.style?.width === 'number' ? n.style.width : n.measured?.width ?? layoutWidthOf(n)
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
