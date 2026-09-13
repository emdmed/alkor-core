/**
 * Compact graph builder: one gateway node representing the product pipeline front door,
 * branching to one workflow per catalogue entry. Workflows are independent and never feed
 * each other. The gateway owns the routing decision; each workflow shows its own steps and
 * their observed data.
 *
 * A workflow is one card until one of its steps branches. Then it is drawn as a chain —
 * trunk, fan, trunk — because the branch is in the MIDDLE of the workflow and not after it:
 * `clinical` decides which syndrome a note raises, runs that syndrome's passes, and the
 * steps that follow read what those passes produced. So the card is cut open at the step
 * that decides, the fan is drawn between the halves, and every branch converges back into
 * the segment that consumes it.
 */
import { stageTreeForRun } from '../../../../src/monitor/state.ts'
import type { WorkflowDefinition, WorkflowStepEntry, ProjectState, RunEntry, StageEntry } from '../../../../src/monitor/state.ts'
import { CHIP_GAP, CHIP_W, COMPACT_W, MAIN_X, MAIN_Y, ROUTE_GAP, ROW_GAP, compactCardKey, compactStepKey, detailTextOf, flowEdge, layoutHeightOf, layoutWidthOf, llmOf, node, obj, operationFor, shortDigest, stageState, stepIndexOf } from './core.ts'
import { declaredPreDecisionStages, declaredRouteGroups, inputReference, matchTopology, routeForRun, type RouteGroup } from './run.ts'
import type { ProfileTopologyStage } from '../../../../src/core/topology.ts'
import type { NodeState } from '../format.ts'
import type { CompactStageData, CompactStepData, ExpandedGraphBuild, GraphEdge, GraphNode } from './types.ts'

/**
 * The vertical line every trunk card is centred on.
 *
 * The spine stays in one place for every workflow on the board, so the left edge of the
 * catalogue never zigzags; a fan opens symmetrically around this line, which is what makes
 * a divergence look like one.
 */
const TRUNK_CENTER_X = MAIN_X + COMPACT_W / 2

/* ------------------------------------------------------------------ disclosure */

/**
 * What is open on the board, and why.
 *
 * The default is execution, not the last click: everything is closed until it runs, and
 * whatever ran is open all the way down — the workflow, the branch it took, and the stages
 * inside each pass. An operator should not have to go looking for the work; the board should
 * already be showing it, and should be quiet about everything that did not happen.
 *
 * That makes a default-open card something the operator may want to shut, which one set
 * cannot express — a key's absence would mean both "never touched" and "deliberately
 * closed". So intent is held as two sets and the derived default sits between them, the same
 * way the full view has always worked.
 */
interface Disclosure {
  expanded: Set<string>
  collapsed: Set<string>
}

const isOpen = (disclosure: Disclosure, key: string, byDefault: boolean): boolean =>
  disclosure.expanded.has(key) ? true : disclosure.collapsed.has(key) ? false : byDefault

/** A card is open once it has something to show: work in flight, work done, or work broken. */
const opensOnUse = (status: NodeState): boolean => status !== 'idle'

/**
 * Make one card a disclosure, open by default once it has been used.
 *
 * Every card on the board answers the same question the same way, whether it is a workflow,
 * the front door of a profile, or one branch of a decision: at rest it is a line naming
 * itself, and the moment work reaches it, it opens to show that work.
 */
const asDisclosure = (card: GraphNode, disclosure: Disclosure, byDefault?: boolean): GraphNode => {
  const key = compactCardKey(card.id)
  card.data.collapsible = true
  card.data.expandKey = key
  card.data.collapsed = !isOpen(disclosure, key, byDefault ?? opensOnUse(card.data.status))
  return card
}

/* ------------------------------------------------------------------ compact step data */

const compactStages = (stages: StageEntry[], requests: Map<string, unknown>, depth = 0): CompactStageData[] =>
  stages.flatMap((s) => {
    const llmData = llmOf(s, requests as Parameters<typeof llmOf>[1])
    const self: CompactStageData = {
      stageId: s.stageId,
      name: s.name,
      status: stageState(s, requests as Parameters<typeof stageState>[1]),
      depth,
      wallMs: s.wallMs,
      operation: operationFor(s.name, s.name === 'route', s.operation),
      llm: llmData,
      detailText: s.name !== 'llm-call' ? String(detailTextOf(s.detail)).slice(0, 80) || undefined : undefined,
    }
    const children = s.children.length > 0 ? compactStages(s.children, requests, depth + 1) : []
    return [self, ...children]
  })

/** The destination a step-local route stage decided on, if its subtree has one. */
interface StepRouteDecision {
  profile?: string
  task?: string
  /** Every task the decision selected. A note can raise more than one question. */
  tasks?: string[]
  confidence?: number
  reason?: string
}

const stageRouteDecision = (root?: StageEntry): StepRouteDecision => {
  if (!root) return {}
  const visit = (s: StageEntry): StepRouteDecision | undefined => {
    if (s.name === 'route') {
      const d = obj(s.detail) ?? {}
      const profile = typeof d['profile'] === 'string' ? d['profile'] as string : undefined
      const task = typeof d['task'] === 'string' ? d['task'] as string : undefined
      const tasks = Array.isArray(d['tasks'])
        ? d['tasks'].filter((candidate): candidate is string => typeof candidate === 'string')
        : undefined
      if (profile || task || (tasks && tasks.length > 0)) {
        const confidence = typeof d['confidence'] === 'number' ? d['confidence'] as number : undefined
        const reason = typeof d['reason'] === 'string' ? d['reason'] as string : undefined
        return { profile, task, tasks, confidence: confidence != null && confidence > 1 ? confidence / 100 : confidence, reason }
      }
    }
    for (const child of s.children) {
      const found = visit(child)
      if (found) return found
    }
    return undefined
  }
  return visit(root) ?? {}
}

/**
 * The stage that actually holds the run's steps.
 *
 * Two unrelated things emit a parentless stage called `workflow` in one product run: the mode
 * that RUNS a workflow, and the router whose decision is WHICH workflow to run. The router's
 * lands first, so matching on the name alone found the decision — a node with no children —
 * and every step came back with an empty stage list. That is the whole middle of the board:
 * no passes under a step, no route decision to read, so the fan stayed "possible route" and
 * `before routing` stayed "only when the note carries it" for a run that had gone through
 * both. The eye then saw the first step finish and the last segment finish with nothing
 * moving in between.
 *
 * The steps are what tell the two apart, so that is what is matched on; the name is only a
 * tie-break for the moment before the first step stage arrives.
 */
const workflowRootOf = (tree: StageEntry[]): StageEntry | undefined => {
  const roots = tree.filter((n) => n.parentId === undefined)
  const ownsSteps = (n: StageEntry): boolean => n.children.some((child) => stepIndexOf(child) !== undefined)
  const named = roots.filter((n) => n.name === 'workflow')
  // Last, not first: the runner's root is opened after whatever decided to run it.
  return named.find(ownsSteps) ?? roots.find(ownsSteps) ?? named[named.length - 1]
}

const buildCompactSteps = (nodeId: string, state: ProjectState, run: RunEntry, tree: StageEntry[], disclosure: Disclosure): CompactStepData[] => {
  const entry = state.workflows.get(run.runId)
  const def = matchTopology(state, entry, run.profile)
  const workflowRoot = workflowRootOf(tree)

  const defSteps = def?.steps ?? []
  const executed = entry?.steps ?? []
  const n = Math.max(executed.length, defSteps.length)
  const steps: CompactStepData[] = []

  for (let i = 0; i < n; i++) {
    const ex = executed.find((e) => e.step === i)
    const d = defSteps[i]
    const name = ex?.name ?? d?.name ?? `step ${i + 1}`
    const profile = ex?.profile ?? d?.profile ?? '?'
    const status: CompactStepData['status'] = !ex ? 'idle' : ex.status === 'started' ? 'active' : ex.ok === false ? 'failed' : 'done'

    // Derive inputRef from executed step or definition
    const exInput = ex?.input
    const dInput = d?.input
    const inputRef = inputReference(exInput) ?? inputReference(dInput) ?? (i === 0 ? 'initial' : `step-${i - 1}.output`)

    const stageEntries = workflowRoot?.children.find((c) => stepIndexOf(c) === i)

    // Show step-level route information ONLY when this step's own stage subtree
    // contains a genuine routing decision. A profile implemented using router mode
    // is not itself the product workflow decision.
    const stepRoute = stageRouteDecision(stageEntries)
    const chosenTasks = stepRoute.tasks && stepRoute.tasks.length > 0
      ? stepRoute.tasks
      : stepRoute.task ? [stepRoute.task] : []
    const isRouter = Boolean(stepRoute.profile || chosenTasks.length > 0)

    const stages = stageEntries ? compactStages(stageEntries.children, state.llmRequests) : []
    const expandKey = compactStepKey(nodeId, i)
    // A step that ran shows what it did, down to the stages, without being asked.
    const isExpanded = stages.length > 0 && isOpen(disclosure, expandKey, status !== 'idle')

    steps.push({
      name,
      profile,
      status,
      stepNo: i,
      wallMs: ex?.wallMs,
      inputRef,
      router: isRouter,
      // A plan of several tasks is ONE decision, so it reads as one chip rather than as
      // the first task with the rest dropped: a septic-shock note answers two questions.
      chosenProfile: isRouter ? (stepRoute.profile ?? (chosenTasks.length > 0 ? chosenTasks.join(' + ') : undefined)) : undefined,
      tasks: chosenTasks.length > 0 ? chosenTasks : undefined,
      confidence: isRouter ? stepRoute.confidence : undefined,
      ruleVsModel: isRouter ? undefined : undefined,
      reason: isRouter ? stepRoute.reason : undefined,
      stages,
      expandKey,
      expanded: isExpanded,
      stageRowCount: isExpanded && stages.length > 0 ? stages.length : 0,
    })
  }
  return steps
}

/* ------------------------------------------------------------------ route branch cards */

/**
 * Where a workflow's steps end and one profile's own routes begin.
 *
 * A step whose profile publishes route topology is not one opaque box: `clinical` decides
 * which syndrome a note raises and then runs that syndrome's passes. Drawing it as a single
 * `extract` row hides the only branch in the whole picture that a clinician would ask about,
 * so the routes come out onto the canvas as their own cards — on the spine of the workflow
 * that runs them, between the step that chose them and the step that reads what they found.
 */
const ROUTE_STAGE = 'route'

/** The declared stage names of one route, in the order the topology publishes them. */
const declaredStageNames = (group: RouteGroup, routeName: string): string[] =>
  group.routes.find((route) => route.name === routeName)?.stages?.map((stage) => stage.name) ?? []

/**
 * Split one step's flat stage list across the tasks that produced it.
 *
 * The runtime emits a multi-task route's stages as one flat sequence — nothing in the event
 * stream says where `shock` stopped and `sepsis` started. What does say it is the topology:
 * each route publishes its stage names in order, so walking the observed stages against the
 * planned sequence recovers the boundary. A name the plan does not contain stays with the
 * task in progress rather than being dropped, so an unrecognised stage is still visible.
 */
const stagesByTask = (
  stages: CompactStageData[],
  plan: { task: string; names: string[] }[],
): Map<string, CompactStageData[]> => {
  const assigned = new Map<string, CompactStageData[]>(plan.map(({ task }) => [task, []]))
  let planIndex = 0
  let nameIndex = 0
  let current = plan[0]?.task
  let skipping = false
  // Nothing belongs to a branch until the branches exist. A profile may work BEFORE it decides —
  // the clinical one reads the note's vital signs and runs the CLI over them, because the
  // decision depends on those numbers — and an unrecognised stage is otherwise filed under
  // whichever task is open, which before the decision is the first task in the plan. That drew
  // the front door's two passes inside `shock`, as work the shock arm did.
  let decided = false
  // The one exception, and it is the head of the plan only: a profile can name a task it
  // ALREADY ran. The clinical one reads the vital signs at the front door because the decision
  // is made on those numbers, then puts `vital-signs` at the head of the plan because it ran —
  // so that branch's passes are all behind it, and a rule that files nothing from before the
  // decision draws a raised branch with nothing in it. They are matched by the names the
  // topology declares for that task, so nothing else from before the decision is filed at all.
  let headRanUpFront = false
  let inHead = false
  for (const stage of stages) {
    // The decision itself belongs to no branch: it is what chose between them, and the
    // step that made it already shows it. Copying it into a branch — with whatever it
    // nests — would read as work that branch did.
    if (stage.depth === 0) skipping = stage.name === ROUTE_STAGE
    if (stage.depth === 0 && stage.name === ROUTE_STAGE) {
      decided = true
      // A head already spent at the front door must not capture the passes that follow it.
      if (headRanUpFront) {
        planIndex = 1
        nameIndex = 0
        current = plan[1]?.task
      }
    }
    if (skipping) continue
    if (!decided) {
      const head = plan[0]
      if (stage.depth === 0) inHead = head != null && head.names.includes(stage.name)
      if (!inHead || !head) continue
      headRanUpFront = true
      assigned.get(head.task)!.push(stage)
      continue
    }
    // Only a top-level stage can open a task; a nested one belongs to its parent's task.
    if (stage.depth === 0) {
      let candidateIndex = planIndex
      let cursor = nameIndex
      while (candidateIndex < plan.length) {
        const found = plan[candidateIndex]!.names.indexOf(stage.name, cursor)
        if (found >= 0) {
          planIndex = candidateIndex
          nameIndex = found + 1
          current = plan[candidateIndex]!.task
          break
        }
        candidateIndex++
        cursor = 0
      }
    }
    if (current) assigned.get(current)!.push(stage)
  }
  return assigned
}

/** A declared-but-not-yet-run stage row, so an idle branch still shows what it would do. */
const idleStageRows = (nodeId: string, routeName: string, group: RouteGroup): CompactStageData[] =>
  (group.routes.find((route) => route.name === routeName)?.stages ?? []).map((stage, index) => ({
    stageId: `${nodeId}/${routeName}/${index}`,
    name: stage.name,
    status: 'idle' as const,
    depth: 0,
    operation: operationFor(stage.name, stage.kind === 'decision', stage.operation),
    detailText: stage.optional ? 'optional' : undefined,
  }))

/** Roll a branch's observed stage rows up into one status for the row that owns them. */
const rowStatus = (stages: CompactStageData[], ran: boolean): CompactStepData['status'] => {
  if (!ran || stages.length === 0) return 'idle'
  if (stages.some((stage) => stage.status === 'failed')) return 'failed'
  if (stages.some((stage) => stage.status === 'active')) return 'active'
  return 'done'
}

/**
 * The card for what a profile does BEFORE it decides, or nothing when it decides first.
 *
 * It sits at the head of the route row and reads left to right the way the run happens: the
 * front door, then the fan it fed. Drawing it as a peer of the routes would be wrong in the
 * other direction — it is not an alternative to `shock`, it is what told the profile to
 * consider `shock` — so it carries its own note saying when it runs, and the routes keep the
 * vocabulary of a choice.
 *
 * Its rows are matched to the observed stages BY NAME rather than by position: these stages run
 * before the plan exists, so `stagesByTask` has no task to file them under and deliberately
 * leaves them out.
 */
const buildPreDecisionNode = (
  ownerId: string,
  step: CompactStepData,
  declared: ProfileTopologyStage[],
  disclosure: Disclosure,
): GraphNode | undefined => {
  if (declared.length === 0) return undefined
  const nodeId = `${ownerId}-front-${step.profile}`
  const observed = new Map(step.stages.filter((stage) => stage.depth === 0).map((stage) => [stage.name, stage]))

  const steps: CompactStepData[] = declared.map((stage, index) => {
    const seen = observed.get(stage.name)
    const rows: CompactStageData[] = seen
      ? [seen]
      : [{
          stageId: `${nodeId}/${stage.name}`,
          name: stage.name,
          status: 'idle' as const,
          depth: 0,
          operation: operationFor(stage.name, false, stage.operation),
          detailText: stage.optional ? 'optional' : undefined,
        }]
    const expandKey = compactStepKey(nodeId, index)
    const rowState = rowStatus(rows, Boolean(seen))
    const isExpanded = isOpen(disclosure, expandKey, opensOnUse(rowState))
    return {
      name: stage.name,
      profile: step.profile,
      status: rowState,
      stepNo: index,
      stages: rows,
      expandKey,
      expanded: isExpanded,
      stageRowCount: isExpanded && rows.length > 0 ? rows.length : 0,
    }
  })

  const ran = steps.some((row) => row.status !== 'idle')
  const status: CompactStepData['status'] = !ran ? 'idle'
    : steps.some((row) => row.status === 'failed') ? 'failed'
    : steps.some((row) => row.status === 'active') ? 'active'
    : 'done'

  const card = node(nodeId, 'compact-workflow', 'before routing', status, {
    profile: step.profile,
    steps,
    operation: 'orchestrator',
    terminals: false,
    routeOf: step.profile,
    // Every stage here is optional in the topology's sense — a note with no vital sign in it
    // never lights one — so an idle card is a statement about the note, not a pass that failed
    // to happen.
    detailText: ran ? 'runs before the decision' : 'only when the note carries it',
  })
  if (!ran) card.data.muted = true
  return asDisclosure(card, disclosure)
}

/**
 * One card per route group the routing step could have chosen.
 *
 * The chosen groups paint what actually ran, stage by stage; the rest stay on the canvas as
 * muted alternatives, because a fan that disappears once a decision is made cannot be read
 * as a decision. A group the runtime declares unavailable says so rather than looking idle.
 */
const buildRouteGroupNodes = (
  ownerId: string,
  step: CompactStepData,
  groups: RouteGroup[],
  disclosure: Disclosure,
): GraphNode[] => {
  const chosen = step.tasks ?? []
  const decided = chosen.length > 0
  const plan = chosen.map((task) => ({
    task,
    names: groups.flatMap((group) => declaredStageNames(group, task)),
  }))
  const observed = decided ? stagesByTask(step.stages, plan) : new Map<string, CompactStageData[]>()

  const raised = (group: RouteGroup): boolean => group.routes.some((route) => chosen.includes(route.name))
  // What the note actually raised leads the fan; the declared order holds within each half,
  // so a branch never moves between two runs that made the same decision.
  const ordered = decided ? [...groups.filter(raised), ...groups.filter((group) => !raised(group))] : groups

  return ordered.map((group) => {
    const nodeId = `${ownerId}-route-${group.name}`
    const isChosen = raised(group)

    const steps: CompactStepData[] = group.routes.map((route, index) => {
      const ran = chosen.includes(route.name)
      const stages = ran ? observed.get(route.name) ?? [] : idleStageRows(nodeId, route.name, group)
      const expandKey = compactStepKey(nodeId, index)
      const rowState = rowStatus(stages, ran)
      const isExpanded = isOpen(disclosure, expandKey, opensOnUse(rowState))
      return {
        name: route.name,
        profile: step.profile,
        status: rowState,
        stepNo: index,
        stages,
        expandKey,
        expanded: isExpanded,
        stageRowCount: isExpanded && stages.length > 0 ? stages.length : 0,
      }
    })

    // A route the runtime declares unavailable is not a failure — nothing went wrong, the
    // profile says up front it cannot run it here. It stays idle and says so.
    const status: CompactStepData['status'] = !group.available || !isChosen ? 'idle'
      : steps.some((row) => row.status === 'failed') ? 'failed'
      : steps.some((row) => row.status === 'active') ? 'active'
      : steps.every((row) => row.status === 'done') ? 'done'
      : 'idle'

    const note = !group.available ? 'declared, not runnable here'
      : isChosen ? undefined
      : decided ? 'not raised by this note' : 'possible route'

    // Once the decision is in, a route it did not raise has no work to show — every pass
    // inside it is hypothetical. It shrinks to a chip so the branches that DID run own the
    // row, and so the whole fan still fits on one line: a second row of cards can only be
    // reached by edges that cross the first row, and an edge drawn through a card reads as
    // an edge leaving that card.
    if (decided && !isChosen) {
      return node(nodeId, 'branch', group.name, 'idle', {
        chosen: false,
        muted: true,
        routeOf: step.profile,
        // A chip has one line for metadata, and four chips repeating the same sentence is
        // noise; the short form says the same thing beside a muted card.
        detailText: group.available ? 'not raised' : 'not runnable here',
        operation: 'decision',
      })
    }

    const card = node(nodeId, 'compact-workflow', group.name, status, {
      profile: step.profile,
      steps,
      operation: 'orchestrator',
      // These cards live INSIDE a workflow step; the workflow's own card already owns the
      // input the run arrived on and the output it produced, so repeating terminals here
      // would draw two mouths for one document.
      terminals: false,
      routeOf: step.profile,
      detailText: note,
      reason: group.available ? undefined : `${step.profile} names this route but cannot execute it`,
    })
    if (!group.available) card.data.muted = true
    return asDisclosure(card, disclosure)
  })
}

/** The pitch one branch card occupies in the fan row, including the gap that follows it. */
const fanPitch = (branch: GraphNode): number =>
  branch.data.kind === 'branch' ? CHIP_W + CHIP_GAP : COMPACT_W + ROUTE_GAP

/**
 * Lay a step's branches out as ONE row, centred on the trunk they diverge from.
 *
 * One row, never two, and that is a correctness property rather than a taste: every card in
 * this fan takes an edge from the trunk above it and gives one back to the trunk below it, so
 * a second row could only be reached by edges running down through the first row's cards —
 * which is exactly how a viewer comes to believe that `shock` points at `transcript`. Chips
 * stack in the last column instead, keeping every target inside the same horizontal band as
 * its edge.
 *
 * Centring is what makes the divergence read as a divergence: the fan opens symmetrically out
 * of the trunk card and closes symmetrically back into it, rather than hanging off its left
 * corner as a list of things that happen afterwards.
 */
const placeRouteRow = (branches: GraphNode[], top: number): number => {
  const span = branches.reduce((total, branch) => total + fanPitch(branch), 0)
    - (branches.length > 0 ? fanPitch(branches[branches.length - 1]!) - layoutWidthOf(branches[branches.length - 1]!) : 0)
  let bottom = top
  let x = TRUNK_CENTER_X - span / 2
  for (const branch of branches) {
    // Every branch shares one top edge. An orthogonal edge turns at the midpoint between
    // its endpoints, so targets that all start at the same y turn ABOVE the row — put one
    // lower and its edge turns inside the row and saws through the cards beside it.
    branch.position = { x, y: top }
    bottom = Math.max(bottom, top + layoutHeightOf(branch))
    x += fanPitch(branch)
  }
  return bottom
}

/* ------------------------------------------------------------------ compact pipeline node builder */

const buildCompactWorkflowNode = (
  state: ProjectState,
  run: RunEntry,
  tree: StageEntry[],
  disclosure: Disclosure,
): GraphNode => {
  const nodeId = `compact-${run.runId}`
  const steps = buildCompactSteps(nodeId, state, run, tree, disclosure)
  const entry = state.workflows.get(run.runId)

  const hasActive = steps.some((s) => s.status === 'active')
  const anyFailed = steps.some((s) => s.status === 'failed')
  const allDone = steps.length > 0 && steps.every((s) => s.status === 'done')
  // Authoritative status: a failed run is failed even if every step row looks done;
  // a run that completed without producing any step row never reads as done.
  const workflowStatus: CompactStepData['status'] =
    run.status === 'failed' ? 'failed'
    : hasActive ? 'active'
    : anyFailed ? 'failed'
    : entry?.stoppedEarly ? 'failed'
    : allDone ? 'done'
    : 'idle'

  return node(nodeId, 'compact-workflow', `${run.profile} workflow`, workflowStatus, {
    profile: run.profile,
    wallMs: run.wallMs,
    runId: run.runId,
    steps,
    operation: 'orchestrator',
  })
}

const buildIdleCompactWorkflow = (def: WorkflowDefinition): GraphNode => {
  const nodeId = `compact-configured-${def.name}`
  const steps: CompactStepData[] = def.steps.map((s, i) => ({
    name: s.name,
    profile: s.profile,
    status: 'idle' as const,
    stepNo: i,
    inputRef: inputReference(s.input) ?? (i === 0 ? 'initial' : `step-${i - 1}.output`),
    stages: [],
    expandKey: compactStepKey(nodeId, i),
    expanded: false,
    stageRowCount: 0,
  }))

  return node(nodeId, 'compact-workflow', `${def.name} workflow`, 'idle', {
    profile: def.name,
    steps,
    operation: 'orchestrator',
  })
}

/* ------------------------------------------------------------------ branch and merge */

/** One run of consecutive workflow steps, ending at the step that fans out (if any). */
interface WorkflowSegment {
  steps: CompactStepData[]
  /** The step whose profile decides between routes; the fan is drawn after this segment. */
  fan?: CompactStepData
}

/**
 * Cut a workflow's steps at every step that branches.
 *
 * A step whose profile publishes route topology is not one opaque row: `clinical` decides
 * which syndrome a note raises and then runs that syndrome's passes. Those passes are not
 * downstream of the workflow, they are the middle of it — the steps that follow consume what
 * the branches produced — so the workflow card is cut open at that step and the fan is drawn
 * between the halves, diverging out of the card above and converging into the card below.
 */
const segmentWorkflow = (state: ProjectState, steps: CompactStepData[]): WorkflowSegment[] => {
  const segments: WorkflowSegment[] = []
  let open: CompactStepData[] = []
  for (const step of steps) {
    open.push(step)
    if (declaredRouteGroups(state, step.profile).length > 0) {
      segments.push({ steps: open, fan: step })
      open = []
    }
  }
  if (open.length > 0) segments.push({ steps: open })
  return segments
}

/** One segment's own state, with the failure of a run that no step row recorded folded in. */
const segmentStatus = (steps: CompactStepData[], workflow: NodeState, ownsLastRun: boolean): NodeState => {
  const derived: NodeState = steps.some((step) => step.status === 'active') ? 'active'
    : steps.some((step) => step.status === 'failed') ? 'failed'
    : steps.length > 0 && steps.every((step) => step.status === 'done') ? 'done'
    : 'idle'
  // A run can fail between two steps — stopped early, or thrown before the next row exists.
  // The segment holding the last work that ran is where that failure happened.
  if (workflow === 'failed' && ownsLastRun && derived !== 'active') return 'failed'
  return derived
}

/**
 * Draw one workflow as a branching graph: trunk, fan, trunk, with the fan converging back.
 *
 * The first segment reuses the workflow node itself, so whatever already points at that card
 * — the gateway's chosen-route edge — keeps pointing at the head of the chain. Returns
 * `undefined` when the workflow has no branch in it at all, which is the common case: a
 * straight-line workflow stays exactly one card.
 */
const explodeWorkflow = (
  state: ProjectState,
  workflow: GraphNode,
  disclosure: Disclosure,
): { nodes: GraphNode[]; edges: GraphEdge[]; bottom: number } | undefined => {
  const all = (workflow.data.steps as CompactStepData[] | undefined) ?? []
  const segments = segmentWorkflow(state, all)
  if (!segments.some((segment) => segment.fan)) return undefined

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const workflowStatus = workflow.data.status
  const lastRun = [...all].reverse().find((step) => step.status !== 'idle')?.stepNo

  let y = workflow.position.y
  /** Cards from the open fan, waiting for the trunk card that consumes what they produced. */
  let merging: { card: GraphNode; taken: boolean }[] = []

  /** Place one trunk card on the spine and close any fan hanging above it. */
  const trunk = (card: GraphNode, width = COMPACT_W): void => {
    card.position = { x: TRUNK_CENTER_X - width / 2, y }
    // Anything narrower than a workflow card is drawn at its text's width unless it is told
    // otherwise, and then its centred handle no longer sits on the spine the layout put it on.
    if (width !== COMPACT_W) card.style = { width }
    nodes.push(card)
    for (const { card: branch, taken } of merging) {
      // The merge says where a branch rejoins the workflow. A branch the note did not raise
      // still draws one, dashed: "had this note raised sepsis, here is where it would have
      // come back" is the entire reason an unchosen route stays on the canvas at all.
      edges.push(flowEdge(branch, card, taken ? 'branch' : 'ghost'))
    }
    merging = []
    y += layoutHeightOf(card) + ROW_GAP
  }

  segments.forEach((segment, index) => {
    const isLast = index === segments.length - 1 && !segment.fan
    const ownsLastRun = lastRun == null
      ? index === 0
      : segment.steps.some((step) => step.stepNo === lastRun)
    const status = segmentStatus(segment.steps, workflowStatus, ownsLastRun)

    if (index === 0) {
      workflow.data.steps = segment.steps
      workflow.data.allSteps = all
      workflow.data.showOutput = isLast
      workflow.data.status = status
      trunk(workflow)
    } else {
      trunk(node(`${workflow.id}-cont-${index}`, 'compact-workflow', String(workflow.data.label), status, {
        profile: workflow.data.profile,
        runId: workflow.data.runId,
        steps: segment.steps,
        allSteps: all,
        // The document arrived at the head of the chain and leaves at its tail; a middle
        // segment draws neither mouth, or the same note reads as arriving twice.
        showInput: false,
        showOutput: isLast,
        continued: true,
        wallMs: isLast ? workflow.data.wallMs : undefined,
        muted: workflow.data.muted,
        operation: 'orchestrator',
      }))
    }

    const step = segment.fan
    if (!step) return

    // The front door is trunk, not fan: it runs BEFORE the decision, in sequence with the
    // step that made it, so drawing it as a peer of the syndromes would claim the profile
    // chose between reading the vital signs and classifying shock.
    const front = buildPreDecisionNode(workflow.id, step, declaredPreDecisionStages(state, step.profile), disclosure)
    if (front) {
      const from = nodes[nodes.length - 1]!
      trunk(front)
      edges.push(flowEdge(from, front, front.data.muted ? 'ghost' : 'branch'))
    }

    const source = nodes[nodes.length - 1]!
    const cards = buildRouteGroupNodes(workflow.id, step, declaredRouteGroups(state, step.profile), disclosure)
    const bottom = placeRouteRow(cards, y)
    for (const card of cards) {
      const taken = !card.data.muted && step.tasks !== undefined
      nodes.push(card)
      // Solid where the note actually went, dashed where it could have gone.
      edges.push(flowEdge(source, card, taken ? 'branch' : 'ghost'))
      merging.push({ card, taken })
    }
    y = bottom + ROW_GAP
  })

  // A workflow whose last step is the branching one has no segment left to converge into,
  // so the merge lands on the run's output instead of dangling in the air.
  if (merging.length > 0) {
    const output = node(`${workflow.id}-output`, 'output', `${String(workflow.data.profile ?? 'workflow')} output`, workflowStatus, {
      wallMs: workflow.data.wallMs,
      runId: workflow.data.runId,
      muted: workflow.data.muted,
      operation: 'orchestrator',
    })
    trunk(output, layoutWidthOf(output))
  }

  return { nodes, edges, bottom: y - ROW_GAP }
}

/* ------------------------------------------------------------------ compact graph builder */

export const buildCompactGraph = (
  state: ProjectState,
  runId: string | undefined,
  expanded: Set<string>,
  collapsed: Set<string> = new Set(),
): ExpandedGraphBuild => {
  const selected = runId ? state.runs.get(runId) : undefined
  const gateway = state.topology.pipeline
  const disclosure: Disclosure = { expanded, collapsed }

  // Nothing to show: no product gateway, no configured workflows, and no running pipeline.
  if (!gateway && state.topology.workflows.length === 0 && !selected) {
    return { nodes: [], edges: [], title: '', expanded: new Set(), collapsed: new Set(), disclosures: new Set() }
  }

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  let yOffset = MAIN_Y

  const tree = selected ? stageTreeForRun(state.stages, selected.runId) : []
  const route = selected ? routeForRun(state, selected.runId, tree) : {}
  const chosenWorkflowName = route.profile ?? selected?.profile

  if (gateway) {
    // --- Gateway node: the product pipeline front door. It owns the routing decision,
    // so the run-scoped route lives here, never on a downstream step. ---
    const gatewayNode = node('gateway', 'gateway', `Product pipeline`, route.profile ? 'done' : 'idle', {
      entryPoint: true,
      chosenProfile: chosenWorkflowName,
      confidence: route.confidence,
      ruleVsModel: route.ruleVsModel,
      reason: route.reason,
      detailText: `${gateway.workflows.length} workflow${gateway.workflows.length === 1 ? '' : 's'}${gateway.defaultWorkflow ? ` · default: ${gateway.defaultWorkflow}` : ''}`,
      operation: 'decision',
    })
    // On the spine, at the column's width. A node with no width of its own is drawn as wide
    // as its text, so the gateway's centred handle sat wherever its label happened to end —
    // some 40px left of the card below it, and an orthogonal edge answers that with a
    // dogleg. Telling the DOM the width the layout already reserved makes the edge a
    // straight line, which is what a front door with one destination actually is.
    gatewayNode.position = { x: TRUNK_CENTER_X - layoutWidthOf(gatewayNode) / 2, y: MAIN_Y }
    gatewayNode.style = { width: layoutWidthOf(gatewayNode) }
    nodes.push(gatewayNode)
    yOffset = MAIN_Y + layoutHeightOf(gatewayNode) + ROW_GAP

    // --- One compact card per catalogued workflow; a missing definition fails loud. ---
    const configuredNames = new Set(state.topology.workflows.map((p) => p.name))
    for (const wfName of gateway.workflows) {
      const def = state.topology.workflows.find((p) => p.name === wfName)
      const isActiveRun = chosenWorkflowName === wfName && selected
      const compactNode = isActiveRun && def
        ? buildCompactWorkflowNode(state, selected, tree, disclosure)
        : def
          ? buildIdleCompactWorkflow(def)
          : buildMissingWorkflowNode(wfName)
      compactNode.position = { x: MAIN_X, y: yOffset }

      const isChosen = chosenWorkflowName === wfName
      // With a run in the books, every unchosen catalogue workflow stays visible but
      // clearly de-emphasised next to the executed one.
      if (selected && !isChosen) compactNode.data.muted = true
      // The catalogue stays complete — every workflow keeps its row — but a row is all an
      // untouched workflow gets. The board's height belongs to what ran.
      //
      // The run in play opens because it is the run in play, not because its rolled-up
      // status happens to read as started: a workflow one step into a four-step definition
      // still derives as idle, and that is the exact moment an operator is watching it.
      asDisclosure(compactNode, disclosure, Boolean(isActiveRun) || opensOnUse(compactNode.data.status))

      // A card collapsed to one line has no internals to draw, and a fan hanging off a
      // header would be a branch out of a workflow nobody can see the steps of.
      const opensRoutes = compactNode.data.collapsed !== true
      // Exploding rewrites the card it starts from, so it has to happen before anything
      // measures that card or reads its status.
      const chain = opensRoutes ? explodeWorkflow(state, compactNode, disclosure) : undefined

      // Edge from gateway to this workflow: solid success branch for the chosen
      // workflow, dashed ghost for every possible alternative. Never a data edge —
      // workflows are independent, so no edge may imply one feeds another.
      edges.push(flowEdge(gatewayNode, compactNode, isChosen ? 'branch' : 'ghost', isChosen ? 'selected' : undefined))

      if (chain) {
        nodes.push(...chain.nodes)
        edges.push(...chain.edges)
        yOffset = chain.bottom + ROW_GAP
      } else {
        nodes.push(compactNode)
        yOffset += layoutHeightOf(compactNode) + ROW_GAP
      }
    }

    // --- Unconfigured direct run: executed but absent from the catalogue ---
    if (selected && !gateway.workflows.includes(selected.profile) && !configuredNames.has(selected.profile)) {
      const compactNode = buildCompactWorkflowNode(state, selected, tree, disclosure)
      compactNode.position = { x: MAIN_X, y: yOffset }
      asDisclosure(compactNode, disclosure, true)
      // A run that no catalogue knows about still branches the way its profiles branch.
      const chain = compactNode.data.collapsed !== true ? explodeWorkflow(state, compactNode, disclosure) : undefined
      // Connects as a ghost branch: a direct run, not a declared route.
      edges.push(flowEdge(gatewayNode, compactNode, 'ghost', 'direct run'))
      if (chain) {
        nodes.push(...chain.nodes)
        edges.push(...chain.edges)
        yOffset = chain.bottom + ROW_GAP
      } else {
        nodes.push(compactNode)
        yOffset += layoutHeightOf(compactNode) + ROW_GAP
      }
    }

    // --- Standalone configured workflows not referenced by the catalogue ---
    for (const def of state.topology.workflows) {
      if (gateway.workflows.includes(def.name)) continue
      if (selected?.profile === def.name) continue
      const idleNode = buildIdleCompactWorkflow(def)
      idleNode.data.detailText = 'standalone configured workflow'
      idleNode.position = { x: MAIN_X, y: yOffset }
      asDisclosure(idleNode, disclosure)
      nodes.push(idleNode)
      yOffset += layoutHeightOf(idleNode) + ROW_GAP
    }
  } else {
    // --- No product gateway: standalone configured workflows render on their own,
    // and a selected direct run wins the top card ---
    if (selected) {
      const compactNode = buildCompactWorkflowNode(state, selected, tree, disclosure)
      compactNode.position = { x: MAIN_X, y: MAIN_Y }
      asDisclosure(compactNode, disclosure, true)
      const chain = compactNode.data.collapsed !== true ? explodeWorkflow(state, compactNode, disclosure) : undefined
      if (chain) {
        nodes.push(...chain.nodes)
        edges.push(...chain.edges)
        yOffset = chain.bottom + ROW_GAP
      } else {
        nodes.push(compactNode)
        yOffset = MAIN_Y + layoutHeightOf(compactNode) + ROW_GAP
      }
    }
    for (const def of state.topology.workflows) {
      const idleNode = buildIdleCompactWorkflow(def)
      idleNode.data.detailText = 'standalone configured workflow'
      idleNode.position = { x: MAIN_X, y: yOffset }
      asDisclosure(idleNode, disclosure)
      nodes.push(idleNode)
      yOffset += layoutHeightOf(idleNode) + ROW_GAP
    }
  }

  // What the board actually drew, so the view can drop intent it can no longer honour: a key
  // whose card is no longer on the canvas (switched run, collapsed catalogue entry) would
  // otherwise sit in a set forever, waiting to reopen something that no longer exists.
  const renderedExpanded = new Set<string>()
  const renderedCollapsed = new Set<string>()
  for (const n of nodes) {
    if (n.data.collapsible === true && n.data.expandKey) {
      ;(n.data.collapsed === true ? renderedCollapsed : renderedExpanded).add(n.data.expandKey)
    }
    // A collapsed card withholds its steps, so none of their keys are rendered either.
    if (n.data.collapsed === true) continue
    for (const step of (n.data.steps as CompactStepData[] | undefined) ?? []) {
      if (!step.expandKey || step.stages.length === 0) continue
      ;(step.expanded ? renderedExpanded : renderedCollapsed).add(step.expandKey)
    }
  }

  const title = gateway
    ? `1 product pipeline · ${gateway.workflows.length} workflow${gateway.workflows.length === 1 ? '' : 's'} · compact view${selected ? ` · run ${selected.profile} ${shortDigest(selected.runId)}` : ''}`
    : state.topology.workflows.length > 0
      ? `${state.topology.workflows.length} standalone workflow${state.topology.workflows.length === 1 ? '' : 's'} · compact`
      : selected
        ? `run ${selected.profile} · compact`
        : ''

  return {
    nodes,
    edges,
    title,
    expanded: renderedExpanded,
    collapsed: renderedCollapsed,
    disclosures: new Set([...renderedExpanded, ...renderedCollapsed]),
  }
}

/** Render a workflow that the gateway names but no definition exists for. */
const buildMissingWorkflowNode = (name: string): GraphNode =>
  node(`compact-missing-${name}`, 'compact-workflow', `${name}`, 'failed', {
    profile: name,
    detailText: 'not configured',
    reason: 'Gateway names this workflow but no definition exists',
    steps: [],
    operation: 'orchestrator',
  })
