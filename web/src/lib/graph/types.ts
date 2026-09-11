/**
 * Graph model types.
 *
 * The graph turns configured topology plus the flat activity reducer state into
 * ReactFlow nodes and edges. Everything here is pure and deterministic: the layout is
 * computed, not negotiated with a physics engine, so a given run always draws the same
 * picture. No module in `graph/` touches the DOM or knows about React components — it
 * only says which nodes and edges a run paints.
 */
import type { Edge, Node } from '@xyflow/react'
import type { LlmRequestEntry, ProjectState, RunEntry } from '../../../../src/tui/state.ts'
import type { NodeState } from '../format.ts'

export type GraphNodeKind = 'input' | 'route' | 'step' | 'stage' | 'branch' | 'profile' | 'output' | 'group' | 'compact-workflow' | 'gateway'

export interface CompactStepData {
  name: string
  profile: string
  status: NodeState
  stepNo: number
  wallMs?: number
  inputRef?: string
  router?: boolean
  chosenProfile?: string
  /** Every route this step's own decision selected; a note can raise more than one. */
  tasks?: string[]
  confidence?: number
  ruleVsModel?: string
  reason?: string
  stages: CompactStageData[]
  /** Stable disclosure key owned by this step (`<compact-node-id>/step-<n>`). */
  expandKey?: string
  /** Whether this step's stage rows are visible in this build. */
  expanded?: boolean
  /** Visible stage rows this build; what the modelled card height depends on. */
  stageRowCount?: number
  /** Injected by the view layer: toggles this step's stage disclosure. */
  onToggle?: () => void
}

export interface CompactStageData {
  /** Stable stage id, for stable React keys and stage identity. */
  stageId: string
  name: string
  status: NodeState
  /** Nesting depth within the step's stage subtree (0 = direct child). */
  depth: number
  wallMs?: number
  operation?: GraphOperation
  llm?: GraphLlm
  detailText?: string
}
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
  /** Compact-view card: the workflow's steps, in execution order. */
  steps?: CompactStepData[]
  /** False on a card nested inside a workflow: its Input/Output belong to the workflow. */
  terminals?: boolean
  /**
   * Per-end terminal overrides, for a workflow card split across a branch.
   *
   * A workflow that fans out is drawn as a chain of segments, and only the ends of that
   * chain own the document: the first segment takes the Input, the last takes the Output,
   * and a middle segment takes neither. Both default to `terminals !== false`.
   */
  showInput?: boolean
  showOutput?: boolean
  /** A continuation segment: the same workflow, picked back up after its branch merged. */
  continued?: boolean
  /**
   * Every step of the owning workflow, when this card holds only a slice of them.
   *
   * Progress is a property of the workflow, not of the piece of it a card happens to draw,
   * so a segment reports how far the whole run is rather than how far its own slice is.
   */
  allSteps?: CompactStepData[]
  /** The profile whose own decision produced this card, when the card is one of its routes. */
  routeOf?: string
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
  /** This card can be collapsed to its header; `expandKey` is the disclosure it holds. */
  collapsible?: boolean
  /** Collapsed right now: header only, steps withheld until disclosed. */
  collapsed?: boolean
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
  /** This node belongs to the active execution lineage. */
  current?: boolean
  /** The single most specific visible operation; this node alone receives the NOW badge. */
  currentOperation?: boolean
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

/**
 * A run-trail link: the ReactFlow node itself, its optionally-expanded children, a
 * router fan, and the facet of what kind of work it represents.
 */
export interface ChainItem {
  node: GraphNode
  children: ChainItem[]
  fan?: GraphNode[]
  facet?: 'router'
}

/** Everything a run-scoped builder needs from the reducer, the selected run, and the view. */
export interface BuildCtx {
  state: ProjectState
  run: RunEntry
  expanded: Set<string>
  requests: Map<string, LlmRequestEntry>
  route: { profile?: string; confidence?: number; reason?: string; ruleVsModel?: string }
}

export interface ExpandedGraphBuild extends GraphBuild {
  /** Disclosure keys this build drew OPEN. */
  expanded: Set<string>
  /** Disclosure keys this build drew CLOSED. Compact view only. */
  collapsed?: Set<string>
  /**
   * Every disclosure key on the canvas, open or closed.
   *
   * The compact view's default is derived from execution rather than from the last click, so
   * the operator's intent is two sets — deliberately opened, deliberately closed — and both
   * are pruned against what was actually drawn.
   */
  disclosures?: Set<string>
}
