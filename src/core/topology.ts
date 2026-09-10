import type { StageOperation } from './activity-types.ts'

/** A declared route from one profile-internal decision. */
export interface ProfileTopologyRoute {
  /** Operator-facing route name, such as a task or destination profile. */
  name: string
  /** Cross-profile destination when this route delegates outside the profile. */
  targetProfile?: string
  /** False when the decision can name the route but this runtime cannot execute it. */
  available?: boolean
  /** Stages that exist only on this route. */
  stages?: ProfileTopologyStage[]
  /** A later sibling route that consumes this route's output; the sibling remains a valid direct entry. */
  feeds?: string
}

/** One possible internal stage in a profile's execution shape. */
export interface ProfileTopologyStage {
  name: string
  kind?: 'stage' | 'decision'
  /** What performs it — the same fact the stage event carries, known before a run starts. */
  operation?: StageOperation
  optional?: boolean
  repeatable?: boolean
  routes?: ProfileTopologyRoute[]
}

/** Static execution truth published to topology clients before a run starts. */
export interface ProfileTopology {
  stages: ProfileTopologyStage[]
}
