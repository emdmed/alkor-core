# Plan: Compact Mode for Pipeline Graph

## Overview

Add a "Compact Mode" as an alternative to the existing "Full Mode" graph. In Compact Mode,
each pipeline is rendered as a **single container node** with all steps listed inside it,
dramatically reducing canvas size while keeping all workflow steps visible at all times.

The existing topology becomes "FULL MODE" and the new single-container approach becomes
"COMPACT MODE", toggled from the graph toolbar.

## Files to Create

### 1. `web/src/lib/graph/compact.ts` — Compact graph builder

A new builder function `buildCompactGraph` that takes the same inputs as
`buildExpandedPipelinesGraph` but produces one `'compact-pipeline'` node per pipeline
instead of individual step/stage/branch nodes.

**Data packed into each node:**

```ts
interface CompactStepData {
  name: string
  profile: string
  status: NodeState
  stepNo: number
  wallMs?: number
  inputRef?: string
  router?: boolean
  chosenProfile?: string
  confidence?: number
  ruleVsModel?: string
  reason?: string
  stages: CompactStageData[]
}

interface CompactStageData {
  name: string
  status: NodeState
  wallMs?: number
  operation?: GraphOperation
  llm?: GraphLlm
  detailText?: string
}
```

The builder reuses `mergeSteps`, `matchTopology`, `routeForRun`, `declaredRouteTargets`,
and `stageTreeForRun` from existing modules. It constructs step rows the same way
`buildPipeline` does, then packs them into one node.

**Geometry:** Single node positioned at `(MAIN_X, MAIN_Y)`, width `420px`, height
computed from step count (~36px per step + header/footer).

### 2. `web/src/components/graph/CompactPipelineNode.tsx` — React component

A new ReactFlow node component that renders the single container node. Structure:

- **Header:** Pipeline name + status glyph + progress bar
- **Input row:** FileInput icon + "Input" label + char count
- **Steps list:** Numbered rows, each with status dot, label, operation badge, profile
  name, wall time
  - Router steps show inline chip rows beneath them (chosen in green, alternatives muted)
  - Expandable stages shown as indented sub-rows (toggle to show/hide)
- **Output row:** FileOutput icon + "Output" label + wall time or error

## Files to Modify

### 3. `web/src/lib/graph/types.ts` — Add node kind

Add `'compact-pipeline'` to the `GraphNodeKind` union (line 14):

```ts
export type GraphNodeKind = 'input' | 'route' | 'step' | 'stage' | 'branch' | 'profile' | 'output' | 'group' | 'compact-pipeline'
```

### 4. `web/src/lib/graph/core.ts` — Add geometry

Add layout functions for the compact node kind:

- `layoutHeightOf`: handle `'compact-pipeline'` case (compute from step count)
- `layoutWidthOf`: return `420` for `'compact-pipeline'`

### 5. `web/src/lib/graph/index.ts` — Export new builder

Add export:

```ts
export { buildCompactGraph } from './compact.ts'
```

### 6. `web/src/components/graph/nodes.tsx` — Register node type

- Import `CompactPipelineNode` from the new component file
- Register in `NODE_TYPES`:

```ts
export const NODE_TYPES = {
  ...existing,
  'compact-pipeline': CompactPipelineNode,
} as const
```

### 7. `web/src/components/graph/PipelineGraph.tsx` — Add mode toggle

- Add `graphMode` state: `'full' | 'compact'` (default `'full'`)
- Add a toggle button group in the toolbar (next to Legend/Activity/Events buttons)
- In compact mode, call `buildCompactGraph` instead of `buildExpandedPipelinesGraph`
- The minimap is hidden in compact mode (everything fits in viewport)
- Expand/collapse all controls are repurposed to expand/collapse stages within compact
  nodes

### 8. `web/src/styles.css` — Add compact node styles

New CSS classes:

- `.g-compact` — The container node wrapper
- `.g-compact-header` — Pipeline name + progress bar row
- `.g-compact-steps` — Step list container
- `.g-compact-step` — Individual step row
- `.g-compact-step-num` — Step number circle
- `.g-compact-chips` — Router decision chip container
- `.g-compact-stages` — Expandable stages sub-list
- `.g-compact-terminal` — Input/output rows
- `.g-compact-progress` — Progress bar

## Data Flow Summary

```
Full Mode (existing):
  buildExpandedPipelinesGraph → many nodes (input, step×N, stage×M, branch×K, output, group)
  → ReactFlow renders each as separate card

Compact Mode (new):
  buildCompactGraph → 1 node per pipeline (kind: 'compact-pipeline')
  → CompactPipelineNode renders steps as a list inside one card
```

## Key Design Decisions

1. **Same `GraphBuild` return type** — The compact builder returns `{ nodes, edges, title }`
   just like existing builders, so `PipelineGraph.tsx` can swap builders without structural
   changes.

2. **Edges in compact mode** — For multiple pipelines, edges connect pipeline nodes
   vertically. For a single pipeline, no edges needed (everything is inside one node).

3. **Expand/collapse in compact mode** — Toggling a step expands/collapses its internal
   stages within the same node, not as separate ReactFlow nodes.

4. **Inspector integration** — Clicking a step row inside the compact node calls
   `onInspect` with the step's `GraphNodeData`, so the inspector drawer still works.

5. **Run selection** — The compact node shows the selected run's state. Multiple runs are
   still selectable via the run chips in the toolbar.

## Implementation Order

1. `types.ts` — Add kind
2. `core.ts` — Add geometry
3. `compact.ts` — Build the compact graph
4. `index.ts` — Export
5. `CompactPipelineNode.tsx` — Render the node
6. `nodes.tsx` — Register the type
7. `styles.css` — Add styles
8. `PipelineGraph.tsx` — Wire the mode toggle

## Verification

- `npm run typecheck` — No type errors
- `npm test` — Existing tests pass (no behavioral change to full mode)
- Manual: open dashboard, toggle to Compact Mode, verify pipeline renders as single node
  with all steps visible
- Manual: run a pipeline, verify step statuses update in real-time
- Manual: click a step in compact mode, verify inspector opens
- Manual: expand a router step, verify inline chips appear
