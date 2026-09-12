/**
 * PipelineGraph — the execution view as a node graph.
 *
 * The graph replaces the old tree-and-steps panel with one persistent lane per
 * configured pipeline. Selection paints runtime state over the full map without
 * hiding any pipeline or route.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronsDownUp, ChevronsUpDown, Circle, LoaderCircle, Maximize2, Minimize2, SlidersHorizontal, X } from 'lucide-react'
import { Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, useReactFlow, useStore } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { GraphNode, GraphNodeData, CompactStepData } from '../../lib/graph/index.ts'
import { buildCompactGraph, buildExpandedWorkflowsGraph, layoutHeightOf } from '../../lib/graph/index.ts'
import { fmtSec } from '../../lib/format.ts'
import { NODE_TYPES } from './nodes.tsx'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '../ui/dropdown-menu'
import type { ProjectState } from '../../../../src/tui/state.ts'

export interface PipelineGraphProps {
  state: ProjectState
  selectedWorkflow: string
  onSelectedWorkflowChange: (profile: string) => void
  /** Inspector-side: what node the user last clicked (rendered into the rail). */
  onInspect: (data: GraphNodeData) => void
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
    case 'compact-workflow': return { width: 360, height: layoutHeightOf(node) }
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
      {/* The viewport frame is only information while something is outside it. When the
          whole board is on screen it draws a box around the entire thumbnail, which reads
          as the loudest object in the workspace while saying nothing at all. */}
      {(viewport.width < bounds.width * 0.98 || viewport.height < bounds.height * 0.98) && (
        <rect className="graph-minimap-viewport" {...viewport} />
      )}
    </svg>
  )
}

const GraphView = ({ state, selectedWorkflow, onSelectedWorkflowChange, onInspect }: PipelineGraphProps) => {
  const { fitView, getNodes, getViewport, setViewport } = useReactFlow()
  const canvasWidth = useStore((store) => store.width)
  const graphShellRef = useRef<HTMLDivElement>(null)
  // The run strip scrolls once the bar is full, and the chip most worth seeing is the one
  // the canvas is currently drawing. Without this it is the chip that ends up under the
  // fade at 1440.
  const selectedChipRef = useRef<HTMLButtonElement>(null)
  const runs = useMemo(() => [...state.runs.values()], [state.runs])
  const [selectedId, setSelectedId] = useState<string>()
  const [userExpanded, setUserExpanded] = useState<Set<string>>(new Set())
  const [userCollapsed, setUserCollapsed] = useState<Set<string>>(new Set())
  // Compact disclosure is derived from execution, not from the last click, so the operator's
  // intent needs both directions: a card that opens itself when it runs must be closable, and
  // a card that stays shut must be openable.
  const [compactExpanded, setCompactExpanded] = useState<Set<string>>(new Set())
  const [compactCollapsed, setCompactCollapsed] = useState<Set<string>>(new Set())
  // The legend floats over the canvas now, so it starts out of the way: it is reference
  // material, and a card parked on top of the board costs more than it explains. It is one
  // click away under View, and the nodes it describes are labelled in plain words anyway.
  const [showLegend, setShowLegend] = useState(false)

  // Keep the selected run reachable in the strip. `nearest` makes this a no-op when the
  // chip is already on screen, so it never fights a horizontal scroll the operator is
  // doing by hand.
  useEffect(() => {
    selectedChipRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selectedId, runs.length])

  // Mark which end of the run strip is actually cut, so the edge fade is painted only
  // where there is more to see. Doing this in CSS alone is not possible: a mask cannot ask
  // whether its element overflows, and an unconditional fade washes out the first chip on
  // every board that fits.
  const runStripRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = runStripRef.current
    if (!el) return
    const sync = () => {
      el.classList.toggle('is-overflow-start', el.scrollLeft > 1)
      el.classList.toggle('is-overflow-end', el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
    }
    sync()
    el.addEventListener('scroll', sync, { passive: true })
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', sync)
      ro.disconnect()
    }
  }, [runs.length])
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [fullscreenFallback, setFullscreenFallback] = useState(false)
  // Compact is the board at rest. Full detail cannot be both complete and legible on a
  // canvas this size — fitting the whole catalogue puts its type near five pixels — and
  // the compact board was built for exactly this: one card per workflow, a list of names
  // until a run lights a path through it. Full detail is one click away under View, and
  // that is the right way round, because detail is what you ask for once you know where
  // to look.
  const [graphMode, setGraphMode] = useState<'full' | 'compact'>('compact')
  // Once the operator pans or zooms, the viewport is theirs. A run changes the board's
  // geometry on every event, and refitting through that is the view yanking itself out
  // from under someone who deliberately went to look at one card. Auto-fit resumes when
  // they ask for it — the fit control, a mode switch, or picking a different run.
  const [viewportPinned, setViewportPinned] = useState(false)

  const selected = runs.find((r) => r.runId === selectedId)
    ?? [...runs].reverse().find((r) => r.profile === selectedWorkflow)
    ?? runs[runs.length - 1]

  // A new run is the operator's strongest intent. Follow it immediately without
  // replacing the system map: activity is an overlay on stable topology.
  const latestRunId = runs[runs.length - 1]?.runId
  useEffect(() => {
    if (!latestRunId) return
    const latest = runs[runs.length - 1]!
    setSelectedId(latestRunId)
    onSelectedWorkflowChange(latest.profile)
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

  // Compact view expands a card, or a step embedded in one, so its disclosure state is
  // deliberately separate from Full view's: neither mode mutates the other mode's state, and
  // toggling between them preserves each mode's own state.
  const toggleCompact = (key: string, isOpen: boolean) => {
    setCompactExpanded((prev) => {
      const next = new Set(prev)
      if (isOpen) next.delete(key)
      else next.add(key)
      return next
    })
    setCompactCollapsed((prev) => {
      const next = new Set(prev)
      if (isOpen) next.add(key)
      else next.delete(key)
      return next
    })
  }

  const graphView = useMemo(() => {
    if (graphMode === 'compact') {
      const graph = buildCompactGraph(state, selected?.runId, compactExpanded, compactCollapsed)
      const nodes: GraphNode[] = graph.nodes.map((n) => {
        const steps = (n.data.steps as CompactStepData[] | undefined) ?? []
        return {
          ...n,
          data: {
            ...n.data,
            steps: steps.map((step) => ({
              ...step,
              onToggle: step.stages.length > 0 && step.expandKey
                ? () => toggleCompact(step.expandKey!, Boolean(step.expanded))
                : undefined,
            })),
            // A collapsible card shares the step disclosure state, so a workflow reopened by
            // hand stays open while the run it is standing next to keeps updating.
            onToggle: n.data.collapsible === true && n.data.expandKey
              ? () => toggleCompact(n.data.expandKey!, n.data.collapsed !== true)
              : undefined,
            onInspect: () => onInspect(n.data),
          },
        }
      })
      return { nodes, edges: graph.edges, title: graph.title, expanded: graph.expanded, disclosures: graph.disclosures }
    }
    const graph = buildExpandedWorkflowsGraph(state, selected?.runId, userExpanded, userCollapsed)
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
    return { nodes, edges: graph.edges, title: graph.title, expanded: expandedKeys, disclosures: undefined }
  }, [state, selected, userCollapsed, userExpanded, compactExpanded, compactCollapsed, onInspect, graphMode])
  const { nodes, edges, expanded } = graphView

  // Compact disclosure keys embed the workflow node identity and step number; when a
  // key's owning card is no longer rendered (switch of selected run, catalogue change),
  // prune it so stale run ids never accumulate across the session. Both directions of
  // intent are pruned against everything the board actually drew — pruning against what
  // is OPEN would erase every deliberate collapse on the next rebuild.
  const disclosures = graphView.disclosures
  useEffect(() => {
    if (graphMode !== 'compact' || !disclosures) return
    const keep = (prev: Set<string>): Set<string> =>
      [...prev].every((key) => disclosures.has(key)) ? prev : new Set([...prev].filter((key) => disclosures.has(key)))
    setCompactExpanded(keep)
    setCompactCollapsed(keep)
  }, [graphMode, disclosures])

  // Keep the current neighborhood readable. Fitting an arbitrarily long run into the
  // viewport recreates a minimap where the operator needs legible execution detail.
  const geometryKey = nodes
    .map((n) => `${n.id}:${n.position.x}:${n.position.y}:${String(n.style?.width ?? '')}:${String(n.style?.height ?? '')}${n.data.kind === 'compact-workflow' ? `:h${layoutHeightOf(n)}` : ''}`)
    .join('|')
  useEffect(() => {
    if (nodes.length === 0 || viewportPinned) return
    const frame = requestAnimationFrame(() => {
      const trail = nodes.filter((node) => node.data.kind !== 'group')
      const currentIndex = trail.findIndex((node) => node.data.current)
      // While work is in flight the camera holds the live neighbourhood. When nothing is
      // live there is no neighbourhood to hold, and the two obvious fallbacks are both
      // wrong: the first five nodes of the catalogue park most of the canvas on empty
      // paper, and the whole board zooms out to the thumbnail this view exists to avoid.
      // What the operator came for is the route the run actually took, so frame that.
      const windowSize = canvasWidth < 620 ? 1 : 5
      const center = currentIndex >= 0 ? currentIndex : 0
      const start = Math.max(0, Math.min(center - Math.floor(windowSize / 2), trail.length - windowSize))
      const traversed = trail.filter((node) => node.data.traversed)
      // Three cases, not two. Work in flight holds the live neighbourhood; a landed run
      // frames the route it actually took; and a board where nothing has run yet has no
      // route to frame, so it fits whole. Slicing the catalogue in that last case is the
      // one framing this view exists to avoid — it parks the canvas on empty paper.
      const framed = currentIndex >= 0
        ? trail.slice(start, start + windowSize)
        : traversed.length > 0
          ? traversed
          // Nothing has run and there is no route to frame, so fit the board. Note that
          // `trail` is in build order, not layout order, so it cannot be sliced to pick
          // "the start" — the first element is not the leftmost card.
          : undefined
      // Fit only what the flow store actually holds. A run replaces every node id at
      // once (the catalogue card becomes the run's card), and this frame can land before
      // the store has them: fitting a set it cannot match measures an empty box and
      // writes a viewport of NaN, which paints nothing at all — no cards, no edges, not
      // even the dot grid, since the background pattern rides the same transform. The
      // whole board is the honest fallback while the new ids land.
      const known = new Set(getNodes().map((node) => node.id))
      const focus = framed?.filter((node) => known.has(node.id)) ?? []
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
    // In compact mode the board's default is execution, so "expand" is the operator saying
    // they want to see the whole catalogue and not only what ran.
    if (graphMode === 'compact') {
      setCompactExpanded(new Set(disclosures ?? []))
      setCompactCollapsed(new Set())
      return
    }
    const all = new Set<string>()
    for (const n of nodes) if ((n.data.childCount ?? 0) > 0) all.add(n.data.expandKey ?? n.id)
    setUserExpanded(all)
    setUserCollapsed(new Set())
  }
  const collapseAll = () => {
    if (graphMode === 'compact') {
      setCompactExpanded(new Set())
      setCompactCollapsed(new Set(disclosures ?? []))
      return
    }
    setUserExpanded(new Set())
    setUserCollapsed(new Set(nodes.filter((n) => (n.data.childCount ?? 0) > 0).map((n) => n.data.expandKey ?? n.id)))
  }

  const hasDisclosures = graphMode === 'compact'
    ? (disclosures?.size ?? 0) > 0
    : nodes.some((n) => (n.data.childCount ?? 0) > 0)

  // Whether every step that can open is already open, so a single control can name the move
  // it is about to make rather than offering both and letting one of them do nothing.
  const everyStepOpen = graphMode === 'compact'
    ? (disclosures?.size ?? 0) > 0
      && compactCollapsed.size === 0
      && compactExpanded.size >= (disclosures?.size ?? 0)
    : userCollapsed.size === 0
      && nodes
        .filter((n) => (n.data.childCount ?? 0) > 0)
        .every((n) => userExpanded.has(n.data.expandKey ?? n.id))

  return (
    <div ref={graphShellRef} className={`graph-wrap${isFullscreen ? ' is-graph-fullscreen' : ''}`}>
      {/* One bar, and it answers one question: which run am I looking at, and where has it
          got to. Everything that changes how the canvas is *drawn* folds into View. */}
      <div className="stagebar">
        <div className="stagebar-runs" ref={runStripRef} aria-label="Recent runs">
          {runs.length === 0 && <span className="stagebar-waiting">No runs yet — send one from the Run panel.</span>}
          {runs.slice(-8).map((run) => {
            const on = run.runId === selected?.runId
            return (
              <button key={run.runId} ref={on ? selectedChipRef : undefined} className={`run-chip${on ? ' run-chip-on' : ''}`} onClick={() => {
                setSelectedId(run.runId)
                onSelectedWorkflowChange(run.profile)
                setViewportPinned(false)
              }} title={run.runId} aria-pressed={on}>
                <span className={on ? 'text-primary' : 'text-muted-foreground'}><RunStatusIcon status={run.status === 'started' ? 'active' : run.status === 'failed' ? 'failed' : 'done'} /></span>
                <span>{run.profile}</span>
                <span className="run-chip-id">{shortId(run.runId)}</span>
              </button>
            )
          })}
        </div>

        <RunPosition run={selected} nodes={nodes} />

        <div className="stagebar-tools">
          {/* Disclosure is the one canvas control that does not live under View: on the
              compact board it is the move an operator makes constantly, and a menu trip per
              use is a menu trip too many. It names the direction it is about to go, so it is
              never a control that would do nothing. */}
          {hasDisclosures && (
            <Button
              variant="ghost"
              size="sm"
              className="stagebar-disclose"
              onClick={everyStepOpen ? collapseAll : expandAll}
              title={everyStepOpen ? 'Collapse every step' : 'Expand every step'}
            >
              {everyStepOpen ? <ChevronsDownUp aria-hidden="true" /> : <ChevronsUpDown aria-hidden="true" />}
              {everyStepOpen ? 'Collapse all' : 'Expand all'}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" title="How the canvas is drawn">
                <SlidersHorizontal aria-hidden="true" />View<ChevronDown className="text-muted-foreground" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>Detail</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={graphMode === 'full'}
                onCheckedChange={() => { setGraphMode('full'); setViewportPinned(false) }}
              >
                Full topology
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={graphMode === 'compact'}
                onCheckedChange={() => { setGraphMode('compact'); setViewportPinned(false) }}
              >
                Compact
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={showLegend}
                onCheckedChange={(next) => setShowLegend(next === true)}
                onSelect={(e) => e.preventDefault()}
              >
                Legend
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="sm"
            className="stagebar-icon"
            onClick={() => void toggleFullscreen()}
            aria-label={isFullscreen ? 'Exit graph fullscreen' : 'View graph fullscreen'}
            aria-pressed={isFullscreen}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen graph'}
          >
            {isFullscreen ? <Minimize2 /> : <Maximize2 />}
          </Button>
        </div>
      </div>

      <div className="graph-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          minZoom={0.12}
          maxZoom={1.35}
          // The canvas is the product's primary surface; the library's credit belongs in
          // NOTICE, not rendered over the board at 10px in the lowest contrast on screen.
          proOptions={{ hideAttribution: true }}
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

        {/* Three corners, one thing in each: legend reads top-left, zoom sits bottom-left
            with ReactFlow's own controls, the overview anchors bottom-right. */}
        {showLegend && <Legend onDismiss={() => setShowLegend(false)} />}

        {nodes.length === 0 && (
          <div className="graph-empty">
            <div>No execution path</div>
            <div className="text-muted-foreground text-xs">Waiting for the pipeline workflow catalogue.</div>
          </div>
        )}
      </div>
    </div>
  )
}

const RunPosition = ({
  run,
  nodes,
}: {
  run: { runId: string; status: 'started' | 'completed' | 'failed'; wallMs?: number } | undefined
  nodes: GraphNode[]
}) => {
  // FIRST VIEWPORT names three things for this bar: the run selector, stage progress, and
  // elapsed. Progress is read off the workflow card that owns the whole run rather than
  // off whichever segment happens to be drawn, so a branch does not restart the count.
  const progress = useMemo(() => {
    const owning = nodes
      .map((n) => (n.data.allSteps ?? n.data.steps) as CompactStepData[] | undefined)
      .filter((steps): steps is CompactStepData[] => Array.isArray(steps) && steps.length > 0)
      .sort((a, b) => b.length - a.length)[0]
    if (!owning) return undefined
    const active = owning.findIndex((s) => s.status === 'active')
    if (active >= 0) return `step ${active + 1} of ${owning.length}`
    const done = owning.filter((s) => s.status === 'done').length
    return done > 0 ? `${done} of ${owning.length} steps` : undefined
  }, [nodes])
  const runId = run?.runId ?? ''
  if (!run) return null
  // Prefer the live leaf for the summary while every enclosing node remains
  // visibly current on the canvas.
  const current =
    nodes.find((n) => n.data.current && n.data.status === 'active' && (n.data.kind === 'stage' || n.data.kind === 'route'))?.data ??
    nodes.find((n) => n.data.current && n.data.status === 'active')?.data ??
    nodes.find((n) => n.data.current)?.data
  // One line, one reading: the mark says what state the run is in, the name says where it
  // is. The old pill said "NOW RUNNING", then the step, then "active step" — three ways of
  // saying the same thing, stacked.
  //
  // The run's own status is the ONLY authority on whether anything is still working, and
  // it is tested before anything else. This used to read `current && status === 'started'`,
  // which meant a run with no node currently flagged — the gap between two stages, which on
  // a 19.5s-per-case pipeline is a gap you can watch — fell through to the branch below and
  // rendered a green "run complete" over a run that was still going. A dashboard whose one
  // job is to say where the work has got to may not say it finished when it has not.
  if (run.status === 'started') {
    return (
      <div className="stagebar-position is-live" role="status" aria-live="polite">
        <LoaderCircle className="status-spin" aria-hidden="true" />
        <span className="stagebar-position-name">
          {current == null ? 'working' : current.kind === 'input' ? 'preparing input' : current.label}
        </span>
        {progress && <span className="stagebar-position-step">{progress}</span>}
        <RunClock runId={runId} />
      </div>
    )
  }
  const failed = run.status === 'failed'
  return (
    <div className={`stagebar-position ${failed ? 'is-failed' : 'is-done'}`} role="status" aria-live="polite">
      {failed ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}
      <span className="stagebar-position-name">{failed ? 'run failed' : 'run complete'}</span>
      {run.wallMs != null && <span className="stagebar-position-time">{fmtSec(run.wallMs)}</span>}
    </div>
  )
}

/**
 * Elapsed time for a run that is still going.
 *
 * The server reports `wallMs` only once a run lands, so while one is in flight there is no
 * authoritative elapsed figure to show. This counts from the moment this dashboard first
 * saw the run instead, which is honest about what it is: an observer's clock, not the
 * harness's measurement. The moment the run completes, the component is replaced by the
 * branch above and the server's own `wallMs` takes over — so the approximate number is
 * never the one that gets read, quoted, or compared.
 *
 * Runs take minutes on this hardware, so a one-second tick is the right resolution and a
 * cheap one.
 */
const RunClock = ({ runId }: { runId: string }) => {
  const startedAt = useRef<Map<string, number>>(new Map())
  if (!startedAt.current.has(runId)) startedAt.current.set(runId, Date.now())
  const from = startedAt.current.get(runId) ?? Date.now()

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [runId])

  const secs = Math.max(0, Math.floor((now - from) / 1000))
  const mm = String(Math.floor(secs / 60)).padStart(2, '0')
  const ss = String(secs % 60).padStart(2, '0')
  return <span className="stagebar-position-time" aria-label={`elapsed ${secs} seconds`}>{mm}:{ss}</span>
}

const Legend = ({ onDismiss }: { onDismiss: () => void }) => (
  <div className="graph-legend" aria-label="Graph legend">
    <div className="graph-legend-head">
      <span className="graph-legend-heading">Legend</span>
      <button type="button" className="graph-legend-close" onClick={onDismiss} aria-label="Hide legend">
        <X aria-hidden="true" />
      </button>
    </div>
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
    <p className="graph-legend-note">Click any node to inspect it.</p>
  </div>
)

/** Wrapper: the provider must wrap the canvas and its providers (controls, minimap). */
export const PipelineGraph = memo((props: PipelineGraphProps) => (
  <ReactFlowProvider>
    <GraphView {...props} />
  </ReactFlowProvider>
))
