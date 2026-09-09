/**
 * PipelineGraph — the execution view as a node graph.
 *
 * The graph replaces the old tree-and-steps panel: every configured pipeline and
 * profile remains on a pannable/zoomable canvas while the selected run paints live
 * state over its lane. Router steps connect to every possible destination; choosing
 * one de-emphasises, but never removes, the alternatives.
 */
import { useEffect, useMemo, useState } from 'react'
import { Check, Circle, ChevronsDownUp, ChevronsUpDown, ListTree, LoaderCircle, Rows3, ScrollText, X } from 'lucide-react'
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { GraphNode, GraphNodeData } from '../../lib/graph.ts'
import { buildProjectGraph } from '../../lib/graph.ts'
import { fmtSec } from '../../lib/format.ts'
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

const RunStatusIcon = ({ status }: { status: GraphNodeData['status'] }) =>
  status === 'active' ? <LoaderCircle className="status-spin" /> : status === 'done' ? <Check /> : status === 'failed' ? <X /> : <Circle />

const GraphView = ({ state, onInspect, onToggleActivity, onToggleLog, activityOpen, logOpen }: PipelineGraphProps) => {
  const { fitView } = useReactFlow()
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
    const graph = buildProjectGraph(state, selected?.runId, autoExpanded)
    // The model marks the complete active lineage, so both a pipeline step and its
    // active internal stage stay legible at their respective zoom levels.
    const nodes: GraphNode[] = graph.nodes.map((n) =>
      n.data.kind === 'group'
        ? n
        : {
            ...n,
            data: {
              ...n.data,
              expanded: autoExpanded.has(n.data.expandKey ?? n.id) ? true : n.data.expanded,
              onToggle: (n.data.childCount ?? 0) > 0 ? () => toggleNode(n.data.expandKey ?? n.id) : undefined,
              onInspect: () => onInspect(n.data),
            },
          },
    )
    return { nodes, edges: graph.edges, title: graph.title }
  }, [state, selected, autoExpanded, onInspect])
  // onInspect is stable? It's recreated on each App render. Keep memo deps honest.

  // React Flow's fitView runs only when the canvas mounts. Expanded stage rails change
  // the graph's bounds later, so refit only when geometry changes (not for every live
  // status event) and keep the complete execution path reachable.
  const geometryKey = nodes
    .map((n) => `${n.id}:${n.position.x}:${n.position.y}:${String(n.style?.width ?? '')}:${String(n.style?.height ?? '')}`)
    .join('|')
  useEffect(() => {
    if (nodes.length === 0) return
    const frame = requestAnimationFrame(() => {
      void fitView({ padding: 0.14, minZoom: 0.08, maxZoom: 1 })
    })
    return () => cancelAnimationFrame(frame)
  }, [fitView, geometryKey, nodes.length])

  const expandAll = () => {
    const all = new Set<string>()
    for (const n of nodes) if ((n.data.childCount ?? 0) > 0) all.add(n.data.expandKey ?? n.id)
    setUserExpanded(all)
  }
  const collapseAll = () => setUserExpanded(new Set())

  return (
    <div className="graph-wrap">
      <div className="graph-toolbar">
        <div className="graph-heading">
          <div className="graph-heading-copy">
            <span className="graph-title">Project topology</span>
            {title && <span className="graph-subtitle">{title}</span>}
          </div>
          <RunPosition run={selected} nodes={nodes} />
        </div>

        <div className="graph-commandbar">
          <div className="graph-runs" aria-label="Recent runs">
            {runs.length === 0 && <span className="graph-waiting">Waiting for the first run…</span>}
            {runs.slice(-8).map((run) => {
              const on = run.runId === selected?.runId
              return (
                <button key={run.runId} className={`run-chip${on ? ' run-chip-on' : ''}`} onClick={() => setSelectedId(run.runId)} title={run.runId}>
                  <span className={on ? 'text-primary' : 'text-muted-foreground'}><RunStatusIcon status={run.status === 'started' ? 'active' : run.status === 'failed' ? 'failed' : 'done'} /></span>
                  <span>{run.profile}</span>
                  <span className="run-chip-id">{shortId(run.runId)}</span>
                </button>
              )
            })}
          </div>

          <div className="graph-tools" aria-label="Graph controls">
            {nodes.some((n) => (n.data.childCount ?? 0) > 0) && (
              <div className="control-group">
                <Button variant="ghost" size="sm" onClick={expandAll} title="Expand every step"><ChevronsUpDown />Expand</Button>
                <Button variant="ghost" size="sm" onClick={collapseAll} title="Collapse every step"><ChevronsDownUp />Collapse</Button>
              </div>
            )}
            <div className="control-group">
              <Button variant={showLegend ? 'secondary' : 'ghost'} size="sm" onClick={() => setShowLegend((v) => !v)}>
                <ListTree />Legend
              </Button>
              <Button variant={activityOpen ? 'secondary' : 'ghost'} size="sm" onClick={onToggleActivity}>
                <Rows3 />Activity
              </Button>
              <Button variant={logOpen ? 'secondary' : 'ghost'} size="sm" onClick={onToggleLog}>
                <ScrollText />Events
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="graph-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          fitView
          minZoom={0.08}
          maxZoom={1.35}
          fitViewOptions={{ padding: 0.16, minZoom: 0.08, maxZoom: 1 }}
          nodesConnectable={false}
          elementsSelectable={false}
          onNodeClick={(_e, node) => {
            const d = node.data as GraphNodeData
            if (d.kind !== 'group') onInspect(d)
          }}
          onNodeDoubleClick={(_e, node) => {
            const d = node.data as GraphNodeData
            if ((d.childCount ?? 0) > 0) toggleNode(d.expandKey ?? node.id)
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

      {nodes.length === 0 && (
        <div className="graph-empty">
          <div>No topology yet</div>
          <div className="text-muted-foreground text-xs">Connect to load configured pipelines, profiles, and routes.</div>
          <div className="text-muted-foreground/60 text-xs">Listening for the /health snapshot…</div>
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
      <span className="graph-legend-title">Status</span>
      <span className="graph-legend-row"><span className="g-glyph ok" />active</span>
      <span className="graph-legend-row"><span className="legend-now" />current</span>
      <span className="graph-legend-row"><span className="g-glyph info" />done</span>
      <span className="graph-legend-row"><span className="g-glyph err" />failed</span>
      <span className="graph-legend-row"><span className="g-glyph faint" />idle</span>
    </div>
    <div className="graph-legend-group">
      <span className="graph-legend-title">Edges</span>
      <span className="graph-legend-row"><span className="legend-edge legend-edge-data" />flow</span>
      <span className="graph-legend-row"><span className="legend-edge legend-edge-branch" />selected</span>
      <span className="graph-legend-row"><span className="legend-edge legend-edge-ghost" />available</span>
      <span className="graph-legend-row"><span className="legend-edge legend-edge-muted" />not selected</span>
    </div>
    <div className="graph-legend-note">All configured paths remain visible · click for details</div>
  </div>
)

/** Wrapper: the provider must wrap the canvas and its providers (controls, minimap). */
export const PipelineGraph = (props: PipelineGraphProps) => (
  <ReactFlowProvider>
    <GraphView {...props} />
  </ReactFlowProvider>
)
