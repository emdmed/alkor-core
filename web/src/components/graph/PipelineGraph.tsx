/**
 * PipelineGraph — the execution view as a node graph.
 *
 * The graph replaces the old tree-and-steps panel with one persistent lane per
 * configured pipeline. Selection paints runtime state over the full map without
 * hiding any pipeline or route.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Circle, ChevronsDownUp, ChevronsUpDown, Columns3, ListTree, LoaderCircle, Maximize2, Minimize2, Rows3, ScrollText, X } from 'lucide-react'
import { Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, useReactFlow, useStore } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { GraphNode, GraphNodeData, CompactStepData } from '../../lib/graph/index.ts'
import { buildCompactGraph, buildExpandedPipelinesGraph, layoutHeightOf } from '../../lib/graph/index.ts'
import { fmtSec } from '../../lib/format.ts'
import { NODE_TYPES } from './nodes.tsx'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import type { ProjectState } from '../../../../src/tui/state.ts'

export interface PipelineGraphProps {
  state: ProjectState
  selectedPipeline: string
  onSelectedPipelineChange: (profile: string) => void
  /** Inspector-side: what node the user last clicked (rendered into the drawer). */
  onInspect: (data: GraphNodeData) => void
  onToggleActivity: () => void
  onToggleLog: () => void
  activityOpen: boolean
  logOpen: boolean
}

const shortId = (id: string): string => `#${id.slice(0, 6)}`

const statusColor = (status: GraphNodeData['status']): string =>
  status === 'active' || status === 'done' ? 'var(--success)' : status === 'failed' ? 'var(--destructive)' : 'var(--muted-foreground)'

const RunStatusIcon = ({ status }: { status: GraphNodeData['status'] }) =>
  status === 'active' ? <LoaderCircle className="status-spin" /> : status === 'done' ? <Check /> : status === 'failed' ? <X /> : <Circle />

const miniNodeSize = (node: GraphNode): { width: number; height: number } => {
  if (typeof node.style?.width === 'number' && typeof node.style?.height === 'number') {
    return { width: node.style.width, height: node.style.height }
  }
  switch (node.data.kind) {
    case 'step': return { width: 264, height: 90 }
    case 'stage':
    case 'route': return { width: 248, height: 74 }
    case 'branch': return { width: 168, height: 44 }
    case 'profile': return { width: 196, height: 62 }
    case 'compact-pipeline': return { width: 360, height: layoutHeightOf(node) }
    case 'gateway': return { width: 340, height: 56 }
    default: return { width: 240, height: 60 }
  }
}

const GraphMiniMap = ({ nodes }: { nodes: GraphNode[] }) => {
  const { setCenter, fitView } = useReactFlow()
  const transform = useStore((store) => store.transform)
  const flowWidth = useStore((store) => store.width)
  const flowHeight = useStore((store) => store.height)
  // Memoize bounds from the stable node input, not from the fresh `filter()` array.
  const bounds = useMemo(() => {
    const visible = nodes.filter((node) => node.data.kind !== 'group')
    if (visible.length === 0) return undefined
    const padding = 80
    const left = Math.min(...visible.map((node) => node.position.x)) - padding
    const top = Math.min(...visible.map((node) => node.position.y)) - padding
    const right = Math.max(...visible.map((node) => node.position.x + miniNodeSize(node).width)) + padding
    const bottom = Math.max(...visible.map((node) => node.position.y + miniNodeSize(node).height)) + padding
    return { left, top, width: right - left, height: bottom - top }
  }, [nodes])
  if (!bounds) return null

  const visible = nodes.filter((node) => node.data.kind !== 'group')
  const [translateX, translateY, zoom] = transform
  const viewport = {
    x: -translateX / zoom,
    y: -translateY / zoom,
    width: flowWidth / zoom,
    height: flowHeight / zoom,
  }
  const moveToPoint = (event: React.MouseEvent<SVGSVGElement>) => {
    const matrix = event.currentTarget.getScreenCTM()
    if (!matrix) return
    const point = event.currentTarget.createSVGPoint()
    point.x = event.clientX
    point.y = event.clientY
    const world = point.matrixTransform(matrix.inverse())
    void setCenter(world.x, world.y, { zoom, duration: 180 })
  }

  return (
    <svg
      className="graph-minimap"
      viewBox={`${bounds.left} ${bounds.top} ${bounds.width} ${bounds.height}`}
      preserveAspectRatio="xMidYMid meet"
      role="button"
      tabIndex={0}
      aria-label="Workflow overview. Click to move the viewport, or press Enter to fit the graph."
      onClick={moveToPoint}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') void fitView({ nodes, padding: 0.08 })
      }}
    >
      <title>Workflow overview and current viewport</title>
      {visible.map((node) => {
        const size = miniNodeSize(node)
        return (
          <rect
            key={node.id}
            className={`graph-minimap-node${node.data.traversed ? ' is-traversed' : ''}${node.data.muted ? ' is-muted' : ''}`}
            x={node.position.x}
            y={node.position.y}
            width={size.width}
            height={size.height}
            rx={12}
            fill={statusColor(node.data.status)}
          />
        )
      })}
      <rect className="graph-minimap-viewport" {...viewport} />
    </svg>
  )
}

const GraphView = ({ state, selectedPipeline, onSelectedPipelineChange, onInspect, onToggleActivity, onToggleLog, activityOpen, logOpen }: PipelineGraphProps) => {
  const { fitView, getNodes, getViewport, setViewport } = useReactFlow()
  const canvasWidth = useStore((store) => store.width)
  const graphShellRef = useRef<HTMLDivElement>(null)
  const runs = useMemo(() => [...state.runs.values()], [state.runs])
  const [selectedId, setSelectedId] = useState<string>()
  const [userExpanded, setUserExpanded] = useState<Set<string>>(new Set())
  const [userCollapsed, setUserCollapsed] = useState<Set<string>>(new Set())
  const [compactExpanded, setCompactExpanded] = useState<Set<string>>(new Set())
  const [showLegend, setShowLegend] = useState(true)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [fullscreenFallback, setFullscreenFallback] = useState(false)
  const [graphMode, setGraphMode] = useState<'full' | 'compact'>('full')
  // Once the operator pans or zooms, the viewport is theirs. A run changes the board's
  // geometry on every event, and refitting through that is the view yanking itself out
  // from under someone who deliberately went to look at one card. Auto-fit resumes when
  // they ask for it — the fit control, a mode switch, or picking a different run.
  const [viewportPinned, setViewportPinned] = useState(false)

  const selected = runs.find((r) => r.runId === selectedId)
    ?? [...runs].reverse().find((r) => r.profile === selectedPipeline)
    ?? runs[runs.length - 1]

  // A new run is the operator's strongest intent. Follow it immediately without
  // replacing the system map: activity is an overlay on stable topology.
  const latestRunId = runs[runs.length - 1]?.runId
  useEffect(() => {
    if (!latestRunId) return
    const latest = runs[runs.length - 1]!
    setSelectedId(latestRunId)
    onSelectedPipelineChange(latest.profile)
  }, [latestRunId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onFullscreenChange = () => {
      const ownsFullscreen = document.fullscreenElement === graphShellRef.current
      setIsFullscreen(ownsFullscreen || fullscreenFallback)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !fullscreenFallback) return
      setFullscreenFallback(false)
      setIsFullscreen(false)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [fullscreenFallback])

  const toggleFullscreen = async () => {
    const shell = graphShellRef.current
    if (!shell) return
    // The canvas changes size wholesale here, so a viewport aimed at the old one is not
    // worth preserving: this is a request to be shown the board afresh.
    setViewportPinned(false)
    if (document.fullscreenElement === shell) {
      await document.exitFullscreen()
      return
    }
    if (fullscreenFallback) {
      setFullscreenFallback(false)
      setIsFullscreen(false)
      return
    }
    try {
      await shell.requestFullscreen()
    } catch {
      // iOS and embedded browsers can refuse the Fullscreen API. The fixed-position
      // fallback preserves the same obstruction-free graph and explicit exit control.
      setFullscreenFallback(true)
      setIsFullscreen(true)
    }
  }

  const toggleNode = (id: string, isExpanded: boolean) => {
    if (isExpanded) {
      setUserExpanded((prev) => new Set([...prev].filter((candidate) => candidate !== id)))
      setUserCollapsed((prev) => new Set(prev).add(id))
    } else {
      setUserCollapsed((prev) => new Set([...prev].filter((candidate) => candidate !== id)))
      setUserExpanded((prev) => new Set(prev).add(id))
    }
  }

  // Compact view expands a step embedded in a workflow card, so its disclosure set is
  // deliberately separate from Full view's node expansion set: neither mode mutates
  // the other mode's state, and toggling between them preserves each mode's own state.
  const toggleCompactStep = (key: string) => {
    setCompactExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const graphView = useMemo(() => {
    if (graphMode === 'compact') {
      const graph = buildCompactGraph(state, selected?.runId, compactExpanded)
      const nodes: GraphNode[] = graph.nodes.map((n) => {
        const steps = (n.data.steps as CompactStepData[] | undefined) ?? []
        return {
          ...n,
          data: {
            ...n.data,
            steps: steps.map((step) => ({
              ...step,
              onToggle: step.stages.length > 0 && step.expandKey
                ? () => toggleCompactStep(step.expandKey!)
                : undefined,
            })),
            onInspect: () => onInspect(n.data),
          },
        }
      })
      return { nodes, edges: graph.edges, title: graph.title, expanded: graph.expanded }
    }
    const graph = buildExpandedPipelinesGraph(state, selected?.runId, userExpanded, userCollapsed)
    const expandedKeys = graph.expanded
    // The model keeps the complete active lineage for navigation while identifying one
    // most-specific visible operation for the NOW badge.
    const nodes: GraphNode[] = graph.nodes.map((n) =>
      n.data.kind === 'group'
        ? n
        : {
            ...n,
            data: {
              ...n.data,
              expanded: expandedKeys.has(n.data.expandKey ?? n.id),
              onToggle: (n.data.childCount ?? 0) > 0
                ? () => toggleNode(n.data.expandKey ?? n.id, expandedKeys.has(n.data.expandKey ?? n.id))
                : undefined,
              onInspect: () => onInspect(n.data),
            },
          },
    )
    return { nodes, edges: graph.edges, title: graph.title, expanded: expandedKeys }
  }, [state, selected, userCollapsed, userExpanded, compactExpanded, onInspect, graphMode])
  const { nodes, edges, title, expanded } = graphView

  // Compact disclosure keys embed the workflow node identity and step number; when a
  // key's owning workflow is no longer rendered (switch of selected run, catalogue
  // change), prune it so stale run ids never accumulate across the session.
  useEffect(() => {
    if (graphMode !== 'compact') return
    setCompactExpanded((prev) => {
      if ([...prev].every((key) => graphView.expanded.has(key))) return prev
      return new Set([...prev].filter((key) => graphView.expanded.has(key)))
    })
  }, [graphMode, graphView.expanded])

  // Keep the current neighborhood readable. Fitting an arbitrarily long run into the
  // viewport recreates a minimap where the operator needs legible execution detail.
  const geometryKey = nodes
    .map((n) => `${n.id}:${n.position.x}:${n.position.y}:${String(n.style?.width ?? '')}:${String(n.style?.height ?? '')}${n.data.kind === 'compact-pipeline' ? `:h${layoutHeightOf(n)}` : ''}`)
    .join('|')
  useEffect(() => {
    if (nodes.length === 0 || viewportPinned) return
    const frame = requestAnimationFrame(() => {
      const trail = nodes.filter((node) => node.data.kind !== 'group')
      const currentIndex = trail.findIndex((node) => node.data.current)
      const windowSize = canvasWidth < 620 ? 1 : 5
      const center = currentIndex >= 0 ? currentIndex : 0
      const start = Math.max(0, Math.min(center - Math.floor(windowSize / 2), trail.length - windowSize))
      // Fit only what the flow store actually holds. A run replaces every node id at
      // once (the catalogue card becomes the run's card), and this frame can land before
      // the store has them: fitting a set it cannot match measures an empty box and
      // writes a viewport of NaN, which paints nothing at all — no cards, no edges, not
      // even the dot grid, since the background pattern rides the same transform. The
      // whole board is the honest fallback while the new ids land.
      const known = new Set(getNodes().map((node) => node.id))
      const focus = trail.slice(start, start + windowSize).filter((node) => known.has(node.id))
      void (async () => {
        await fitView({ nodes: focus.length > 0 ? focus : undefined, padding: canvasWidth < 620 ? 0.22 : 0.1, minZoom: 0.45, maxZoom: 1 })
        // Belt and braces: an unusable viewport is silent and unrecoverable without a
        // pan, so never keep one.
        const { x, y, zoom } = getViewport()
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(zoom) && zoom > 0) return
        const recovered = await fitView({ padding: 0.1, minZoom: 0.45, maxZoom: 1 })
        if (!recovered) setViewport({ x: 0, y: 0, zoom: 1 })
      })()
    })
    return () => cancelAnimationFrame(frame)
  }, [fitView, getNodes, getViewport, setViewport, geometryKey, nodes.length, isFullscreen, canvasWidth, viewportPinned])

  const expandAll = () => {
    const all = new Set<string>()
    for (const n of nodes) if ((n.data.childCount ?? 0) > 0) all.add(n.data.expandKey ?? n.id)
    setUserExpanded(all)
    setUserCollapsed(new Set())
  }
  const collapseAll = () => {
    setUserExpanded(new Set())
    setUserCollapsed(new Set(nodes.filter((n) => (n.data.childCount ?? 0) > 0).map((n) => n.data.expandKey ?? n.id)))
  }

  return (
    <div ref={graphShellRef} className={`graph-wrap${isFullscreen ? ' is-graph-fullscreen' : ''}`}>
      <div className="graph-toolbar">
        <div className="graph-heading">
          <div className="graph-heading-copy">
            <span className="graph-title">Data flow</span>
            {title && <span className="graph-subtitle">{title}</span>}
          </div>
          <RunPosition run={selected} nodes={nodes} />
        </div>

        <div className="graph-commandbar">
          <span className="graph-map-hint">Pipeline workflows · live activity highlights the route taken</span>
          <div className="graph-runs" aria-label="Recent runs">
            {runs.length === 0 && <span className="graph-waiting">Waiting for the first run…</span>}
            {runs.slice(-8).map((run) => {
              const on = run.runId === selected?.runId
              return (
                <button key={run.runId} className={`run-chip${on ? ' run-chip-on' : ''}`} onClick={() => {
                  setSelectedId(run.runId)
                  onSelectedPipelineChange(run.profile)
                  setViewportPinned(false)
                }} title={run.runId}>
                  <span className={on ? 'text-primary' : 'text-muted-foreground'}><RunStatusIcon status={run.status === 'started' ? 'active' : run.status === 'failed' ? 'failed' : 'done'} /></span>
                  <span>{run.profile}</span>
                  <span className="run-chip-id">{shortId(run.runId)}</span>
                </button>
              )
            })}
          </div>

          <div className="graph-tools" aria-label="Graph controls">
            <div className="graph-mode-toggle control-group">
              <Button variant={graphMode === 'full' ? 'secondary' : 'ghost'} size="sm" onClick={() => { setGraphMode('full'); setViewportPinned(false) }} title="Full topology view" aria-pressed={graphMode === 'full'}>
                <Columns3 />Full
              </Button>
              <Button variant={graphMode === 'compact' ? 'secondary' : 'ghost'} size="sm" onClick={() => { setGraphMode('compact'); setViewportPinned(false) }} title="Compact single-node view" aria-pressed={graphMode === 'compact'}>
                <Rows3 />Compact
              </Button>
            </div>
            {graphMode === 'full' && nodes.some((n) => (n.data.childCount ?? 0) > 0) && (
              <div className="control-group">
                <Button variant="ghost" size="sm" onClick={expandAll} title="Expand every step"><ChevronsUpDown />Expand</Button>
                <Button variant="ghost" size="sm" onClick={collapseAll} title="Collapse every step"><ChevronsDownUp />Collapse</Button>
              </div>
            )}
            <div className="control-group">
              <Button variant={showLegend ? 'secondary' : 'ghost'} size="sm" onClick={() => setShowLegend((v) => !v)} aria-pressed={showLegend} title={showLegend ? 'Hide legend' : 'Show legend'}>
                <ListTree />Legend
              </Button>
              <Button variant={activityOpen ? 'secondary' : 'ghost'} size="sm" onClick={onToggleActivity} aria-pressed={activityOpen}>
                <Rows3 />Activity
              </Button>
              <Button variant={logOpen ? 'secondary' : 'ghost'} size="sm" onClick={onToggleLog} aria-pressed={logOpen}>
                <ScrollText />Events
              </Button>
              <Button
                variant={isFullscreen ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => void toggleFullscreen()}
                aria-label={isFullscreen ? 'Exit graph fullscreen' : 'View graph fullscreen'}
                aria-pressed={isFullscreen}
                title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen graph'}
              >
                {isFullscreen ? <Minimize2 /> : <Maximize2 />}
                {isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
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
          minZoom={0.12}
          maxZoom={1.35}
          nodesConnectable={false}
          elementsSelectable={false}
          onMove={(event) => { if (event) setViewportPinned(true) }}
          onNodeClick={(_e, node) => {
            const d = node.data as GraphNodeData
            if (d.kind !== 'group') onInspect(d)
          }}
          onNodeDoubleClick={(_e, node) => {
            const d = node.data as GraphNodeData
            if ((d.childCount ?? 0) > 0) toggleNode(d.expandKey ?? node.id, expanded.has(d.expandKey ?? node.id))
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="var(--graph-grid)" />
          <Controls
            showInteractive={false}
            onFitView={() => {
              setViewportPinned(false)
              void fitView({ padding: canvasWidth < 620 ? 0.22 : 0.1, minZoom: 0.45, maxZoom: 1 })
            }}
          />
          {graphMode === 'full' && nodes.filter((node) => node.data.kind !== 'group').length > 6 && <GraphMiniMap nodes={nodes} />}
        </ReactFlow>
      </div>

      {showLegend && <Legend />}

      {nodes.length === 0 && (
        <div className="graph-empty">
          <div>No execution path</div>
          <div className="text-muted-foreground text-xs">Waiting for the pipeline workflow catalogue.</div>
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
      <span className="graph-legend-row"><span className="g-glyph ok" />path taken</span>
      <span className="graph-legend-row"><span className="legend-now" />running now</span>
      <span className="graph-legend-row"><span className="g-glyph err" />failed</span>
      <span className="graph-legend-row"><span className="g-glyph faint" />not visited</span>
    </div>
    <div className="graph-legend-group">
      <span className="graph-legend-title">Edges</span>
      <span className="graph-legend-row"><span className="legend-edge legend-edge-data" />data reference</span>
      <span className="graph-legend-row"><span className="legend-edge legend-edge-branch" />path taken</span>
      <span className="graph-legend-row"><span className="legend-edge legend-edge-ghost" />possible route</span>
    </div>
    <div className="graph-legend-group">
      <span className="graph-legend-title">Work</span>
      <span className="graph-legend-row"><span className="legend-work legend-work-model" />model</span>
      <span className="graph-legend-row"><span className="legend-work legend-work-code" />deterministic</span>
      <span className="graph-legend-row"><span className="legend-work legend-work-route" />decision</span>
    </div>
    <div className="graph-legend-note">Every route stays visible · green marks execution · click any node to inspect</div>
  </div>
)

/** Wrapper: the provider must wrap the canvas and its providers (controls, minimap). */
export const PipelineGraph = memo((props: PipelineGraphProps) => (
  <ReactFlowProvider>
    <GraphView {...props} />
  </ReactFlowProvider>
))
