/**
 * PipelineGraph — the execution view as a node graph.
 *
 * The graph replaces the old tree-and-steps panel: the whole pipeline paints as a
 * chain of cards on a pannable/zoomable canvas. The router steps fan out the
 * destinations they could have picked (the chosen one lights up and continues the
 * chain), and every step expands into the internal stages the mode painted.
 */
import { useMemo, useState } from 'react'
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { GraphNode, GraphNodeData } from '../../lib/graph.ts'
import { buildGraph } from '../../lib/graph.ts'
import { fmtSec, nodeMark } from '../../lib/format.ts'
import { NODE_TYPES } from './nodes.tsx'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import type { ProjectState } from '../../../../src/tui/state.ts'

export interface PipelineGraphProps {
  state: ProjectState
  /** Inspector-side: what node the user last clicked (rendered into the drawer). */
  onInspect: (data: GraphNodeData) => void
  onToggleActivity: () => void
  onToggleLog: () => void
  activityOpen: boolean
  logOpen: boolean
}

const shortId = (id: string): string => `#${id.slice(0, 6)}`

const statusColor = (status: GraphNodeData['status']): string =>
  status === 'active' ? '#46957e' : status === 'failed' ? '#bd656b' : status === 'done' ? '#4d87b4' : '#c3d2d5'

const statusGlyph = (status: GraphNodeData['status']): string => nodeMark[status]

const GraphView = ({ state, onInspect, onToggleActivity, onToggleLog, activityOpen, logOpen }: PipelineGraphProps) => {
  const runs = useMemo(() => [...state.runs.values()], [state.runs])
  const [selectedId, setSelectedId] = useState<string>()
  const [userExpanded, setUserExpanded] = useState<Set<string>>(new Set())
  const [showLegend, setShowLegend] = useState(true)

  const selected = runs.find((r) => r.runId === selectedId) ?? runs[runs.length - 1]

  // Live paint: steps that are actively running expand automatically; user picks stick.
  const autoExpanded = useMemo(() => {
    const set = new Set<string>(userExpanded)
    const tree = selected ? selected.runId : undefined
    if (tree) {
      for (const n of state.stages.values()) {
        if (n.runId === tree && n.status === 'started') set.add(`stage-${n.stageId}`)
      }
    }
    return set
  }, [state.stages, selected, userExpanded])

  const toggleNode = (id: string) => {
    setUserExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const { nodes, edges, title } = useMemo(() => {
    if (!selected) return { nodes: [] as GraphNode[], edges: [], title: '' }
    const graph = buildGraph(state, selected.runId, autoExpanded)
    // The model marks the complete active lineage, so both a pipeline step and its
    // active internal stage stay legible at their respective zoom levels.
    const nodes: GraphNode[] = graph.nodes.map((n) =>
      n.data.kind === 'group'
        ? n
        : {
            ...n,
            data: {
              ...n.data,
              expanded: autoExpanded.has(n.id) ? true : n.data.expanded,
              onToggle: (n.data.childCount ?? 0) > 0 ? () => toggleNode(n.id) : undefined,
              onInspect: () => onInspect(n.data),
            },
          },
    )
    return { nodes, edges: graph.edges, title: graph.title }
  }, [state, selected, autoExpanded, onInspect])
  // onInspect is stable? It's recreated on each App render. Keep memo deps honest.

  const expandAll = () => {
    const all = new Set<string>()
    for (const n of nodes) if ((n.data.childCount ?? 0) > 0) all.add(n.id)
    setUserExpanded(all)
  }
  const collapseAll = () => setUserExpanded(new Set())

  return (
    <div className="graph-wrap">
      <div className="graph-toolbar">
        <span className="graph-title">PIPELINE EXECUTION</span>
        {title && <span className="graph-subtitle">{title}</span>}
        <RunPosition run={selected} nodes={nodes} />

        <div className="graph-runs">
          {runs.length === 0 && <span className="text-muted-foreground text-xs">waiting for the first run…</span>}
          {runs.slice(-8).map((run) => {
            const on = run.runId === selected?.runId
            return (
              <button key={run.runId} className={`run-chip${on ? ' run-chip-on' : ''}`} onClick={() => setSelectedId(run.runId)} title={run.runId}>
                <span className={on ? 'text-primary' : 'text-muted-foreground'}>{statusGlyph(run.status === 'started' ? 'active' : run.status === 'failed' ? 'failed' : 'done')}</span>
                <span>{run.profile}</span>
                <span className="run-chip-id">{shortId(run.runId)}</span>
              </button>
            )
          })}
        </div>

        <div className="graph-tools">
          {runs.length > 0 && (
            <>
              <Button variant="outline" size="sm" onClick={expandAll}>Expand all</Button>
              <Button variant="ghost" size="sm" onClick={collapseAll}>Collapse all</Button>
            </>
          )}
          <Button variant={showLegend ? 'secondary' : 'ghost'} size="sm" onClick={() => setShowLegend((v) => !v)}>
            Legend
          </Button>
          <Button variant={activityOpen ? 'secondary' : 'outline'} size="sm" onClick={onToggleActivity}>
            Activity
          </Button>
          <Button variant={logOpen ? 'secondary' : 'outline'} size="sm" onClick={onToggleLog}>
            Log
          </Button>
        </div>
      </div>

      <div className="graph-canvas">
        <ReactFlow
          key={selected?.runId ?? 'empty'}
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          fitView
          minZoom={0.62}
          maxZoom={1.35}
          fitViewOptions={{ padding: 0.16, minZoom: 0.62, maxZoom: 1 }}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_e, node) => {
            const d = node.data as GraphNodeData
            if (d.kind !== 'group') onInspect(d)
          }}
          onNodeDoubleClick={(_e, node) => {
            const d = node.data as GraphNodeData
            if ((d.childCount ?? 0) > 0) toggleNode(node.id)
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="#d4e4e2" />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => statusColor((n as GraphNode).data.status)}
            maskColor="#f5fbfacc"
          />
        </ReactFlow>
      </div>

      {showLegend && <Legend />}

      {runs.length === 0 && (
        <div className="graph-empty">
          <div>No runs yet</div>
          <div className="text-muted-foreground text-xs">Follow the selected path from input to output. Alternative routes appear below it.</div>
          <div className="text-muted-foreground/60 text-xs">Listening for live events…</div>
        </div>
      )}
    </div>
  )
}

const RunPosition = ({
  run,
  nodes,
}: {
  run: { status: 'started' | 'completed' | 'failed'; wallMs?: number } | undefined
  nodes: GraphNode[]
}) => {
  if (!run) return null
  // Prefer the live leaf for the summary while every enclosing node remains
  // visibly current on the canvas.
  const current =
    nodes.find((n) => n.data.current && n.data.status === 'active' && (n.data.kind === 'stage' || n.data.kind === 'route'))?.data ??
    nodes.find((n) => n.data.current && n.data.status === 'active')?.data ??
    nodes.find((n) => n.data.current)?.data
  if (current) {
    return (
      <div className="graph-position graph-position-live" role="status" aria-live="polite">
        <span className="graph-position-kicker">NOW RUNNING</span>
        <span className="graph-position-name">{current.kind === 'input' ? 'preparing input' : current.label}</span>
        <span className="graph-position-context">{current.kind === 'stage' ? 'active stage' : current.kind === 'input' ? 'starting run' : 'active step'}</span>
      </div>
    )
  }
  const failed = run.status === 'failed'
  return (
    <div className={`graph-position ${failed ? 'graph-position-failed' : 'graph-position-done'}`} role="status" aria-live="polite">
      <span className="graph-position-kicker">{failed ? 'RUN FAILED' : 'RUN COMPLETE'}</span>
      {run.wallMs != null && <span className="graph-position-name">{fmtSec(run.wallMs)}</span>}
    </div>
  )
}

const Legend = () => (
  <div className="graph-legend" aria-label="Graph legend">
    <div className="graph-legend-group">
      <span className="graph-legend-title">STATUS</span>
      <span className="graph-legend-row"><span className="g-glyph ok" />active</span>
      <span className="graph-legend-row"><span className="legend-now" />current</span>
      <span className="graph-legend-row"><span className="g-glyph info" />done</span>
      <span className="graph-legend-row"><span className="g-glyph err" />failed</span>
      <span className="graph-legend-row"><span className="g-glyph faint" />idle</span>
    </div>
    <div className="graph-legend-group">
      <span className="graph-legend-title">EDGES</span>
      <span className="graph-legend-row"><span className="legend-edge legend-edge-data" />flow</span>
      <span className="graph-legend-row"><span className="legend-edge legend-edge-branch" />selected</span>
      <span className="graph-legend-row"><span className="legend-edge legend-edge-ghost" />available</span>
    </div>
    <div className="graph-legend-note">Click for details · double-click to expand</div>
  </div>
)

/** Wrapper: the provider must wrap the canvas and its providers (controls, minimap). */
export const PipelineGraph = (props: PipelineGraphProps) => (
  <ReactFlowProvider>
    <GraphView {...props} />
  </ReactFlowProvider>
)
