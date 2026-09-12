/**
 * Run-scoped graph primitives: how a selected execution is read out of activity state.
 *
 * This module used to end in a set of builders that painted a run as a full left-to-right
 * spine of steps and stages, and a sibling `project.ts` that drew every configured
 * pipeline at once. Both are gone: the dashboard ships the compact board only, because
 * full topology could not be complete and legible on one canvas and reading it was the
 * thing users found confusing. What is left here is what `compact.ts` actually consumes —
 * topology matching, input references, route groups, and the run's routing decision.
 */
import { stageTreeForRun } from '../../../../src/tui/state.ts'
import type { WorkflowDefinition, WorkflowStepEntry, ProjectState, RunEntry, StageEntry } from '../../../../src/tui/state.ts'
import type { ProfileTopologyRoute, ProfileTopologyStage } from '../../../../src/core/topology.ts'
import type { NodeState } from '../format.ts'
import {
  MAIN_X,
  MAIN_Y,
  asNum,
  asStr,
  clip,
  columnX,
  detailTextOf,
  flowEdge,
  isRoutableSpecialist,
  layoutHeightOf,
  layoutWidthOf,
  llmOf,
  node,
  obj,
  operationFor,
  shortDigest,
  stageState,
  stepIndexOf,
  SUB_GAP,
} from './core.ts'
import type { BuildCtx, ChainItem, GraphBuild, GraphEdge, GraphNode } from './types.ts'

/* ------------------------------------------------------------------ endpoint nodes */

const buildInput = (run: RunEntry): GraphNode =>
  // Receiving run.started means input preparation has already finished. The
  // input remains useful context, but it is never the current operation after
  // the run exists in state.
  node('input', 'input', 'Prompt input', 'done', {
    detailText: `${run.inputChars ?? '?'} chars · sha:${shortDigest(run.inputDigest) || '—'}`,
    operation: 'orchestrator',
    runId: run.runId,
  })

const buildOutput = (run: RunEntry): GraphNode =>
  // There is no output work in flight: this endpoint changes only when the run
  // settles. Treating run.started as an active output painted a false NOW badge.
  node('output', 'output', 'Pipeline output', run.status === 'started' ? 'idle' : run.status === 'failed' ? 'failed' : 'done', {
    wallMs: run.wallMs,
    detailText: run.error ? clip(run.error, 90) : undefined,
    runId: run.runId,
    operation: 'orchestrator',
  })

/* ------------------------------------------------------------------ stage tree */

/**
 * Everything the layout needs to draw one stage: the node itself and its children.
 * Where a step expands, the live stage trail runs inside it.
 */
interface StageItemResult {
  node: GraphNode
  children: ChainItem[]
}

/** A stage is a chain item; an internal router stage also carries its chosen chip. */
const stageItem = (s: StageEntry, ctx: BuildCtx): StageItemResult => {
  const isRouter = s.name === 'route'
  const d = obj(s.detail) ?? {}
  const chosen = isRouter ? (asStr(d, 'task') ?? asStr(d, 'profile')) : undefined
  const chosenConfidence = asNum(d, 'confidence')
  const chosenTasks = Array.isArray(d['tasks'])
    ? d['tasks'].filter((candidate): candidate is string => typeof candidate === 'string')
    : undefined

  const children: ChainItem[] = s.children.map((c) => stageItem(c, ctx))
  if (isRouter && chosen) {
    children.push({
      node: node(`chip-${s.stageId}-${chosen}`, 'branch', chosen, 'done', {
        chosen: true,
        confidence: chosenConfidence,
        runId: ctx.run.runId,
      }),
      children: [],
    })
  }

  const llm = s.name === 'llm-call' ? llmOf(s, ctx.requests) : undefined
  const kind: 'route' | 'stage' = isRouter ? 'route' : 'stage'

  return {
    node: node(
      `stage-${s.stageId}`,
      kind,
      s.name,
      stageState(s, ctx.requests),
      {
        wallMs: s.wallMs,
        detail: s.detail,
        detailText: kind === 'stage' && s.name !== 'llm-call' ? detailTextOf(s.detail) : undefined,
        confidence: isRouter ? chosenConfidence : undefined,
        shape: isRouter ? asStr(d, 'shape') : undefined,
        task: isRouter ? asStr(d, 'task') : undefined,
        tasks: isRouter ? chosenTasks : undefined,
        profile: isRouter ? ifRouterProfile(d) : undefined,
        reason: isRouter ? asStr(d, 'reason') : undefined,
        llm,
        operation: llm ? 'model' : operationFor(s.name, isRouter, s.operation),
        expanded: isRouter,
        childCount: children.length,
        runId: ctx.run.runId,
        // Carried so a click on this node can narrow the event feed to the stage itself
        // rather than to every event the run produced.
        stageId: s.stageId,
      },
    ),
    children,
  }
}

/** Router stage detail names its destination `profile`; the clinical stage names it `task`. */
function ifRouterProfile(d: Record<string, unknown>): string | undefined {
  return asStr(d, 'profile')
}

/* ------------------------------------------------------------------ pipeline topology */

/** Match an executed pipeline entry to the static definition that produced it.
 *
 * Matching order:
 *  1. Exact workflow definition name when available (from the run's profile).
 *  2. Observed pipeline step signature (profile sequence).
 *  3. Configured prefix of an in-progress run (executed steps are a prefix of a definition).
 *  4. Explicit fallback to the first configured definition (an unmatched direct run).
 */
export const matchTopology = (state: ProjectState, entry?: { steps?: WorkflowStepEntry[] }, runProfile?: string): WorkflowDefinition | undefined => {
  const defs = state.topology.workflows
  if (defs.length === 0) return undefined
  const profiles = (entry?.steps ?? []).map((s) => s.profile).filter(Boolean)
  if (runProfile) {
    for (const d of defs) {
      if (d.name === runProfile) return d
    }
  }
  if (profiles.length === 0) return defs[0]
  for (const d of defs) {
    const dp = d.steps.map((s) => s.profile)
    if (dp.length === profiles.length && dp.every((p, i) => p === profiles[i])) return d
  }
  for (const d of defs) {
    const dp = d.steps.map((s) => s.profile)
    if (dp.length >= profiles.length && dp.slice(0, profiles.length).every((p, i) => p === profiles[i])) return d
  }
  return defs[0]
}

interface StepRow {
  step: number
  name: string
  profile: string
  status: NodeState
  wallMs?: number
  inputRef?: string
  inputIsInitial?: boolean
}

/** Activity keeps composed inputs as structured mappings. Never coerce that array: its
 * default string form leaks `[object Object]` into an operator-facing graph. */
export const inputReference = (input: WorkflowStepEntry['input'] | WorkflowDefinition['steps'][number]['input']): string | undefined => {
  if (!input) return undefined
  if (typeof input === 'string') return input
  if (Array.isArray(input)) return input.map(({ name, ref }) => `${name} ← ${ref}`).join(' · ')
  if (typeof input.ref === 'string') return `${input.ref}${input.field ? `.${input.field}` : ''}`
  return input.ref.map(({ name, ref }) => `${name} ← ${ref}`).join(' · ')
}

const mergeSteps = (executed: WorkflowStepEntry[], def?: WorkflowDefinition): StepRow[] => {
  const defSteps = def?.steps ?? []
  const n = Math.max(executed.length, defSteps.length)
  const rows: StepRow[] = []
  for (let i = 0; i < n; i++) {
    const ex = executed.find((e) => e.step === i)
    const d = defSteps[i]
    const ref = inputReference(ex?.input) ?? inputReference(d?.input)
    rows.push({
      step: i,
      name: ex?.name ?? d?.name ?? `step ${i + 1}`,
      profile: ex?.profile ?? d?.profile ?? '?',
      status: !ex ? 'idle' : ex.status === 'started' ? 'active' : ex.ok === false ? 'failed' : 'done',
      wallMs: ex?.wallMs,
      inputRef: ref,
      inputIsInitial: ex?.input?.ref === 'initial',
    })
  }
  return rows
}

/**
 * One thing a routing profile can decide to DO, with everything that decision drags in.
 *
 * A profile's route fan is not flat: `shock-extraction` exists to feed `shock`, and a
 * reader who sees them as two peers has to know the domain to know they are one answer to
 * one question. The `feeds` edge the topology already publishes says which, so a chain of
 * routes collapses into the group its terminal route names — `shock`, `sepsis` — with the
 * feeders kept in execution order inside it.
 */
export interface RouteGroup {
  /** The terminal route's name: what this branch of the profile is called. */
  name: string
  /** Every route in the chain, feeders first, terminal last. */
  routes: ProfileTopologyRoute[]
  /** False when the runtime declares it can name this route but not execute it. */
  available: boolean
}

/**
 * The route groups a profile's own decision stage can choose between.
 *
 * Read off the published topology and nothing else: a profile that declares no routes has
 * no groups, and the dashboard then draws it as the single opaque step it is.
 */
export const declaredRouteGroups = (state: ProjectState, profileName: string): RouteGroup[] => {
  const profile = state.topology.profiles.find((candidate) => candidate.name === profileName)
  const routes: ProfileTopologyRoute[] = []
  const visit = (stages: ProfileTopologyStage[]): void => {
    for (const stage of stages) {
      for (const route of stage.routes ?? []) routes.push(route)
    }
  }
  if (profile?.topology) visit(profile.topology.stages)
  if (routes.length === 0) return []

  const byName = new Map(routes.map((route) => [route.name, route]))
  // A route that feeds another is a step of that other route's answer, never a peer of it.
  const feeders = new Set(routes.filter((route) => route.feeds && byName.has(route.feeds)).map((route) => route.name))

  const groups: RouteGroup[] = []
  for (const route of routes) {
    if (feeders.has(route.name)) continue
    // Declared order is execution order, and a feeder is declared before what it feeds.
    // Chains may be longer than one link, so the feeders are collected transitively.
    const upstream = (name: string): ProfileTopologyRoute[] =>
      routes.filter((candidate) => candidate.feeds === name).flatMap((candidate) => [...upstream(candidate.name), candidate])
    const members = [...upstream(route.name), route]
    groups.push({
      name: route.name,
      routes: members,
      available: members.every((member) => member.available !== false),
    })
  }
  return groups
}

/**
 * The stages a profile runs BEFORE its own decision — work that belongs to no route.
 *
 * A profile's topology is not only a fan. The clinical profile reads a note's vital signs and
 * puts the numbers through the medprotocol CLI before it decides which syndrome the note
 * raises, because no word list reads a blood pressure. Both of those are published as ordinary
 * top-level stages, and `declaredRouteGroups` above collects `stage.routes` and nothing else —
 * so a stage with no routes was drawn nowhere at all, and the picture showed a decision being
 * made on evidence that appeared from nowhere.
 *
 * Everything before the first decision stage, in declared order. A profile with no decision has
 * no fan to precede, so it has nothing here: it is already drawn as the single step it is.
 */
export const declaredPreDecisionStages = (
  state: ProjectState,
  profileName: string,
): ProfileTopologyStage[] => {
  const profile = state.topology.profiles.find((candidate) => candidate.name === profileName)
  const stages = profile?.topology?.stages ?? []
  const decision = stages.findIndex((stage) => stage.kind === 'decision' || (stage.routes?.length ?? 0) > 0)
  if (decision <= 0) return []
  return stages.slice(0, decision)
}

export const declaredRouteTargets = (state: ProjectState, profileName: string): string[] => {
  const profile = state.topology.profiles.find((candidate) => candidate.name === profileName)
  const targets: string[] = []
  const visit = (stages: ProfileTopologyStage[]): void => {
    for (const stage of stages) {
      for (const route of stage.routes ?? []) {
        if (route.targetProfile && !targets.includes(route.targetProfile)) targets.push(route.targetProfile)
        if (route.stages) visit(route.stages)
      }
    }
  }
  if (profile?.topology) visit(profile.topology.stages)
  return targets
}

/** The specialist profiles the router could have handed the note to. */
const routerCandidates = (state: ProjectState, routerProfile: string, chosen?: string): string[] => {
  const declared = declaredRouteTargets(state, routerProfile)
  const seen = new Set<string>(declared)
  // Older profiles did not publish route topology. Preserve their useful fallback,
  // but never mix unrelated profiles into a router that declares exact targets.
  if (declared.length === 0) {
    for (const p of state.topology.profiles) {
      if (isRoutableSpecialist(p.mode) && p.name !== routerProfile) seen.add(p.name)
    }
    for (const r of state.routes) if (r.profile !== routerProfile) seen.add(r.profile)
  }
  if (chosen) seen.add(chosen)
  const list = [...seen]
  if (chosen) {
    const ix = list.indexOf(chosen)
    if (ix > 0) {
      list.splice(ix, 1)
      list.unshift(chosen)
    }
  }
  return list.slice(0, 6)
}

/** Route decision for this run: reducer-captured route.decided, else a router stage outside any step subtree. */
export const routeForRun = (state: ProjectState, runId: string, tree: StageEntry[] = []): NonNullable<BuildCtx['route']> => {
  const re = [...state.routes].reverse().find((r) => r.runId === runId)
  if (re) return { profile: re.profile, confidence: re.confidence, reason: re.reason, ruleVsModel: re.ruleVsModel }
  // Older activity buffers may predate run-scoped route.decided events. The tree is
  // already scoped to this run; walk only product-level router stages so a decision
  // a workflow step made for itself never gets lifted to the workflow's route.
  const visit = (stages: StageEntry[]): NonNullable<BuildCtx['route']> | undefined => {
    for (const stage of stages) {
      if (stage.name === 'route') {
        const detail = obj(stage.detail) ?? {}
        const profile = asStr(detail, 'profile')
        if (profile) {
          const confidence = asNum(detail, 'confidence')
          return {
            profile,
            confidence: confidence != null && confidence > 1 ? confidence / 100 : confidence,
            reason: asStr(detail, 'reason'),
          }
        }
      }
      // A step wrapper owns its subtree: a routing stage nested inside an observed
      // step is that step's own decision, never the run- or workflow-level route.
      const stepOwned = typeof obj(stage.detail)?.['step'] === 'number'
      if (stepOwned) continue
      const nested = visit(stage.children)
      if (nested) return nested
    }
    return undefined
  }
  const stageRoute = visit(tree)
  if (stageRoute) return stageRoute
  return {}
}

/* ------------------------------------------------------------------ active lineage */

/**
 * An active internal stage is also the active work of every enclosing step.  Keep
 * that lineage on the model instead of selecting one leaf in the React view: the
 * graph can then show where the work sits at both zoom levels.
 */
const markCurrentLineage = (item: ChainItem): boolean => {
  const descendantIsCurrent = item.children.some((child) => markCurrentLineage(child))
  const isCurrent = item.node.data.status === 'active' || descendantIsCurrent
  if (isCurrent) item.node.data.current = true
  return isCurrent
}

const markChainCurrentLineage = (chain: ChainItem[]): void => {
  for (const item of chain) markCurrentLineage(item)
}

/**
 * Pick one visible operation from the active lineage. When detail is expanded, the
 * deepest stage wins; when it is collapsed, the enclosing step becomes the visible
 * current operation. Ancestors remain active without each claiming a NOW badge.
 */
