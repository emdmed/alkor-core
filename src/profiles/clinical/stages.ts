/**
 * What each clinical task DOES, declared once.
 *
 * This table is the only statement of a task's execution shape. Two things read it and they
 * cannot disagree, because one of them enforces the other: `profile.ts` publishes it as the
 * profile's topology so a dashboard can draw the shape before a run starts, and the review
 * modules emit their stages through the helper below, which refuses a name this table does
 * not declare. A stage that is drawn is therefore a stage that runs, and a stage that runs is
 * a stage that was drawn.
 *
 * It replaces a hand-written `topology` literal that had drifted in both directions — the
 * dashboard drew a `medication-pass` node that nothing ever lit, and the `gateway` stage both
 * extraction arms really emit was drawn nowhere at all. Neither was a bug anyone could see
 * from the code: the list and the emitters were in different files with nothing relating them.
 *
 * **The extract triple is not restated here.** `prompt-assembly → llm-call → parse` is what
 * one `extract()` call emits, and it is published from `EXTRACT_STAGES` in the mode that
 * emits it. This table says only which passes a task makes and what it wraps around them.
 */
import type { Activity } from '../../core/activity.ts'
import { LLM_CALL_STAGE, nextStageId } from '../../core/activity.ts'
import { EXTRACT_STAGES } from '../../modes/extract.ts'
import type { ProfileTopologyStage } from '../../core/topology.ts'
import type { StageOperation } from '../../core/activity-types.ts'
import type { Task } from './contracts.ts'

/**
 * The profile's own decision stage: which task (or tasks) this document needs.
 *
 * Not a task's stage but the one that CHOOSES among them, so it is named here beside them
 * rather than inside `TASK_PASSES`. Both the topology and the two emit sites in `profile.ts`
 * read it.
 */
export const ROUTE_STAGE = 'route'

/**
 * The front door: the vital-signs contract, run BEFORE the route decision.
 *
 * Named beside `ROUTE_STAGE` and not inside `TASK_PASSES` for the same reason the route is —
 * it is not a task's stage, it is work the profile does around the choice between tasks. The
 * task it runs IS `vital-signs`, whose own passes are declared below and emitted by
 * `reviewVitalSigns`; this stage is the marker that says the pass happened at the front door
 * rather than on a route. See `vitals-first.ts`.
 */
export const VITALS_FIRST_STAGE = 'vitals-first'

/** The medprotocol pass over what the front door read: categories, MAP, shock index. */
export const CALCULATIONS_STAGE = 'calculations'

/**
 * One pass a task makes.
 *
 * A `model` pass is an `extract()` call. When it names a `bracket`, the profile emits that
 * stage around the call and the bracket stands for the assembly and parse it contains — which
 * is why a bracketed pass publishes its own name plus the model boundary, rather than the
 * whole triple. An unbracketed pass publishes the triple as `extract` emits it.
 *
 * A `code` pass is deterministic work this profile emits itself: a verification sweep, a rule
 * gateway. It makes no model call and publishes exactly its own name.
 */
export type ClinicalPass =
  | { kind: 'model'; bracket?: string; optional?: boolean }
  | { kind: 'code'; name: string; optional?: boolean }

/**
 * Every routed task's passes, in execution order.
 *
 * Only the routed tasks appear. `summary` is graded but cannot be run over one document, and
 * `shock-pipeline` is two of these tasks chained under one `--task` flag rather than a shape
 * of its own — neither is a route, so neither has a shape to declare here.
 */
export const TASK_PASSES: Partial<Record<Task, ClinicalPass[]>> = {
  'vital-signs': [{ kind: 'model' }, { kind: 'code', name: 'verify' }],
  'note-format': [{ kind: 'model' }, { kind: 'code', name: 'verify' }],
  transcript: [
    { kind: 'model' },
    // Replaces a section rather than correcting items, so it runs BEFORE verification —
    // verifying first would produce verdicts about items about to be discarded.
    { kind: 'model', bracket: 'medication-pass', optional: true },
    { kind: 'code', name: 'verify' },
    // The second turn over the items the first pass failed to cite. Off unless asked.
    { kind: 'model', bracket: 'transcript-repair', optional: true },
  ],
  'shock-extraction': [
    { kind: 'model', bracket: 'shock-extraction' },
    // The deterministic rule check over the extracted payload, via the medprotocol CLI.
    { kind: 'code', name: 'gateway' },
  ],
  shock: [{ kind: 'model', bracket: 'shock-classification' }, { kind: 'code', name: 'verify' }],
  'sepsis-extraction': [
    { kind: 'model', bracket: 'sepsis-extraction' },
    { kind: 'code', name: 'gateway' },
  ],
  sepsis: [{ kind: 'model', bracket: 'sepsis-screening' }, { kind: 'code', name: 'verify' }],
}

/**
 * The stages a task's passes produce, in order, including the ones `extract` owns.
 *
 * A bracket is reported as `model`: it stands for a pass whose point is the model call
 * inside it, and a reader looking for where this profile talks to a model wants the named
 * bracket, not the anonymous `llm-call` under it.
 */
const stagesFor = (passes: ClinicalPass[]): { name: string; operation: StageOperation; optional?: boolean }[] =>
  passes.flatMap((pass) =>
    pass.kind === 'code'
      ? [{ name: pass.name, operation: 'code' as const, optional: pass.optional }]
      : pass.bracket
        ? [
            { name: pass.bracket, operation: 'model' as const, optional: pass.optional },
            { name: LLM_CALL_STAGE, operation: 'model' as const, optional: pass.optional },
          ]
        : EXTRACT_STAGES.map((stage) => ({ ...stage, optional: pass.optional })),
  )

/** A task's execution shape in the form the topology publishes. */
export const topologyStagesFor = (task: Task): ProfileTopologyStage[] | undefined => {
  const passes = TASK_PASSES[task]
  if (!passes) return undefined
  return stagesFor(passes).map(({ name, operation, optional }) =>
    optional ? { name, operation, optional } : { name, operation },
  )
}

/**
 * The stages this profile emits ITSELF for a task — brackets and code passes — with what
 * performs each. The emitter below reads it, so an emitted stage carries the same operation
 * the topology published for it.
 */
export const emittedStagesFor = (task: Task): { name: string; operation: StageOperation }[] => {
  const passes = TASK_PASSES[task] ?? []
  const emitted: { name: string; operation: StageOperation }[] = []
  for (const pass of passes) {
    if (pass.kind === 'code') emitted.push({ name: pass.name, operation: 'code' })
    else if (pass.bracket) emitted.push({ name: pass.bracket, operation: 'model' })
  }
  return emitted
}

/** A stage in progress, so a caller can complete it after the work it brackets. */
export interface OpenStage {
  complete: (detail?: unknown) => void
}

/**
 * The emitter a review module stages through.
 *
 * It refuses an undeclared name, and that refusal is the whole mechanism: it is what makes
 * the table above a description of the runtime rather than a second opinion about it. A
 * review module that starts emitting a new stage fails immediately and loudly, at the one
 * place that also has to publish it.
 */
export const clinicalStages = (task: Task, activity?: Activity) => {
  const declared = emittedStagesFor(task)
  /** Returns what performs the stage, and refuses a name the table does not declare. */
  const operationOf = (name: string): StageOperation => {
    const found = declared.find((stage) => stage.name === name)
    if (!found) {
      throw new Error(
        `clinical task '${task}' emitted an undeclared stage '${name}' — ` +
          `declare it in TASK_PASSES (declared: ${declared.map((s) => s.name).join(', ') || 'none'}) ` +
          'so the topology draws what the run actually does',
      )
    }
    return found.operation
  }

  return {
    /** Open a stage now and complete it later, as one node with a measured duration. */
    begin(name: string): OpenStage {
      const operation = operationOf(name)
      const stageId = activity ? nextStageId() : undefined
      const startedAt = performance.now()
      activity?.emit({ kind: 'stage', stageId, name, operation, status: 'started' })
      return {
        complete(detail?: unknown) {
          activity?.emit({
            kind: 'stage',
            stageId,
            name,
            operation,
            status: 'completed',
            wallMs: performance.now() - startedAt,
            ...(detail === undefined ? {} : { detail }),
          })
        },
      }
    },

    /** Emit a stage that has already happened — work with no duration worth a start event. */
    done(name: string, detail?: unknown) {
      const operation = operationOf(name)
      activity?.emit({
        kind: 'stage',
        stageId: nextStageId(),
        name,
        operation,
        status: 'completed',
        ...(detail === undefined ? {} : { detail }),
      })
    },

    /** Bracket an awaited pass: started before, completed after, whatever it returns. */
    async around<T>(name: string, work: () => Promise<T>): Promise<T> {
      const open = this.begin(name)
      try {
        return await work()
      } finally {
        open.complete()
      }
    },
  }
}
