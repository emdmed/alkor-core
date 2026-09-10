/**
 * Graph model — public surface.
 *
 * This is the only module of the graph package callers outside it import from (the
 * dashboard components, the tests, and `App.tsx`). Builders stay pure and deterministic
 * so a given run always paints the same picture; the `graph/` modules never touch the
 * DOM or know about React.
 */
export type {
  BuildCtx,
  ChainItem,
  CompactStageData,
  CompactStepData,
  ExpandedGraphBuild,
  GraphBuild,
  GraphEdge,
  GraphLlm,
  GraphNode,
  GraphNodeData,
  GraphNodeKind,
  GraphOperation,
} from './types.ts'

export { detailTextOf, stageState } from './core.ts'

export { buildGraph, buildProgressGraph } from './run.ts'

export { buildExpandedPipelinesGraph, buildPipelinesGraph, buildProjectGraph } from './project.ts'

export { buildCompactGraph } from './compact.ts'