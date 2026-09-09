/**
 * Custom ReactFlow node components for the pipeline graph.
 *
 * These are deliberately dumb: they paint `GraphNodeData` and wire the handles that
 * the (pure) layout in `lib/graph.ts` connects. Status colours and glyphs mirror the
 * terminal TUI and the rest of the dashboard via the `g-*` CSS classes in styles.css.
 */
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { GraphNode, GraphNodeData } from '../../lib/graph.ts'
import { fmtSec } from '../../lib/format.ts'
import { Check, ChevronDown, ChevronRight, Circle, LoaderCircle, X } from 'lucide-react'

const statusClass = (status: GraphNodeData['status']): string =>
  status === 'active' ? 'g-active' : status === 'failed' ? 'g-failed' : status === 'done' ? 'g-done' : 'g-idle'

const StatusGlyph = ({ status }: { status: GraphNodeData['status'] }) =>
  status === 'active' ? <LoaderCircle className="status-spin" /> : status === 'done' ? <Check /> : status === 'failed' ? <X /> : <Circle />

/** Small coloured graph node card — every real (non-group) node is one of these. */
const Card = ({ data, children }: { data: GraphNodeData; children?: React.ReactNode }) => (
  <div className={`g-card ${data.kind === 'branch' ? 'g-chip' : ''} ${statusClass(data.status)}${data.current ? ' g-current' : ''}`}>
    {data.current && <span className="g-now" aria-label="Current operation">NOW</span>}
    {children}
  </div>
)

/** Leading glyph + label row shared by every card. */
const Title = ({ data, chevron }: { data: GraphNodeData; chevron?: boolean }) => (
  <div className="g-title">
    {chevron ? (
      data.expanded ? (
        <span className="g-chev"><ChevronDown size={12} /></span>
      ) : (
        <span className="g-chev"><ChevronRight size={12} /></span>
      )
    ) : null}
    <span className="g-glyph" aria-label={data.status}><StatusGlyph status={data.status} /></span>
    <span className="g-label">{data.label}</span>
  </div>
)

const Meta = ({ className, children }: { className?: string; children: React.ReactNode }) => (
  <div className={`g-meta${className ? ` ${className}` : ''}`}>{children}</div>
)

/* ------------------------------------------------------------------ input/output */

export const InputNode = (props: NodeProps<GraphNode>) => {
  const { data } = props
  return (
    <div className="g-input">
      <Card data={data}>
        <Title data={data} />
        {data.detailText && <Meta>{data.detailText}</Meta>}
      </Card>
      <Handle id="s" type="source" position={Position.Right} />
    </div>
  )
}

export const OutputNode = (props: NodeProps<GraphNode>) => {
  const { data } = props
  return (
    <div className="g-output">
      <Card data={data}>
        <Title data={data} />
        {data.wallMs != null && <Meta>{fmtSec(data.wallMs)}</Meta>}
        {data.detailText && <Meta className="g-err-text">{data.detailText}</Meta>}
      </Card>
      <Handle id="t" type="target" position={Position.Left} />
    </div>
  )
}

/* ------------------------------------------------------------------ pipeline step */

export const StepNode = (props: NodeProps<GraphNode>) => {
  const { data } = props
  const expandable = (data.childCount ?? 0) > 0
  const router = Boolean(data.router)
  return (
    <div className={`g-step${router ? ' g-router' : ''}`}>
      <Handle id="t" type="target" position={Position.Left} />
      <Handle id="s" type="source" position={Position.Right} />
      <Handle id="detail" type="source" position={Position.Bottom} />
      <Card data={data}>
        <Title data={data} chevron={expandable} />
        <Meta>
          <span className="g-prof">{data.stepNo != null ? `Step ${data.stepNo + 1} · ` : ''}{data.profile}</span>
          {data.wallMs != null && <span className="g-time">{fmtSec(data.wallMs)}</span>}
        </Meta>
        {router && (
          <div className="g-decide">
            <span className="g-route-line">{data.chosenProfile ? `Selected: ${data.chosenProfile}` : 'Choosing destination…'}</span>
            {data.confidence != null && <span className="g-conf">{(data.confidence * 100).toFixed(0)}%</span>}
            {data.ruleVsModel && <span className="g-rule-vs">{data.ruleVsModel}</span>}
          </div>
        )}
        {data.inputRef && <Meta className="g-refs">uses {data.inputRef === 'initial' ? 'original input' : data.inputRef}</Meta>}
        {expandable && (
          <button
            className="g-toggle"
            onClick={(e) => {
              e.stopPropagation()
              data.onToggle?.()
            }}
          >
            {data.expanded ? 'Hide stages' : `Show ${data.childCount} stage${data.childCount === 1 ? '' : 's'}`}
            {data.expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </button>
        )}
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ stage */

export const StageNode = (props: NodeProps<GraphNode>) => {
  const { data } = props
  const expandable = (data.childCount ?? 0) > 0
  return (
    <div className="g-stage">
      <Handle id="top" type="target" position={Position.Top} />
      <Handle id="t" type="target" position={Position.Left} />
      <Handle id="s" type="source" position={Position.Right} />
      <Handle id="detail" type="source" position={Position.Bottom} />
      <Card data={data}>
        <Title data={data} chevron={expandable} />
        {data.wallMs != null && <Meta>{fmtSec(data.wallMs)}</Meta>}
        {data.llm && (
          <Meta>
            {data.llm.constrained ? 'constrained' : 'unconstrained'}
            {data.llm.tokens ? ` · ${data.llm.tokens}` : ''}
            {data.llm.finish ? ` · ${data.llm.finish}` : ''}
          </Meta>
        )}
        {data.llm?.error && <Meta className="g-err-text">{data.llm.error}</Meta>}
        {!data.llm && data.detailText && <div className="g-detail">{data.detailText}</div>}
        {expandable && (
          <button className="g-toggle" onClick={(e) => { e.stopPropagation(); data.onToggle?.() }}>
            {data.expanded ? 'Hide details' : `Show ${data.childCount} more`}
            {data.expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </button>
        )}
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ internal router decision */

export const RouteNode = (props: NodeProps<GraphNode>) => {
  const { data } = props
  return (
    <div className="g-stage g-route">
      <Handle id="top" type="target" position={Position.Top} />
      <Handle id="t" type="target" position={Position.Left} />
      <Handle id="s" type="source" position={Position.Right} />
      <Handle id="detail" type="source" position={Position.Bottom} />
      <Card data={data}>
        <Title data={data} />
        <Meta>
          {data.shape && <span className="g-shape">{data.shape}</span>}
          {data.confidence != null && <span className="g-conf">{(data.confidence * 100).toFixed(0)}%</span>}
        </Meta>
        {data.task && <div className="g-detail">→ task <b>{data.task}</b></div>}
        {data.profile && <div className="g-detail">→ profile <b>{data.profile}</b></div>}
        {data.reason && <div className="g-detail">{data.reason}</div>}
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ routing fan chip */

export const BranchNode = (props: NodeProps<GraphNode>) => {
  const { data } = props
  return (
    <div className="g-chip-wrap">
      <Handle id="tl" type="target" position={Position.Top} />
      <Handle id="t" type="target" position={Position.Top} />
      <Card data={data}>
        {data.chosen && <span className="g-chip-dot" />}
        <span className="g-label">{data.label}</span>
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ cluster underline */

export const GroupNode = ({ data }: NodeProps<GraphNode>) => (
  <div className={`g-group${data.current ? ' g-group-current' : ''}`}>
    {data.label && <span className="g-group-label">{data.label}</span>}
  </div>
)

export const NODE_TYPES = {
  input: InputNode,
  output: OutputNode,
  step: StepNode,
  stage: StageNode,
  route: RouteNode,
  branch: BranchNode,
  group: GroupNode,
} as const
