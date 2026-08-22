/**
 * The clinical profile: mode `extract`, one contract pack, no tools.
 *
 * The mode says how it is EVALUATED — one constrained pass over one document, which is the
 * shape a consuming application runs in production and the only shape worth a number.
 *
 * This profile is the reference implementation as much as it is a working extractor. It
 * names no vital sign anywhere: the slot list comes from the pack's schema, the floor from
 * the pack's cases, the sampling from the pack's model declaration. Point it at a
 * different pack with the same file keys and it grades a different set of readings without
 * a line changing here — which is the property a project should copy when writing its own.
 */
import { ProfileError, type EvalContext, type EvalVerdict, type ProfileModule, type ReviewContext, type ReviewResult } from '../../core/profile.ts'
import { identifyServer } from '../../core/client.ts'
import type { Pack } from '../../core/pack.ts'
import { runVitalSignsEval } from './eval.ts'
import { gatePasses, runNoteFormatEval, runSummaryEval, runTranscriptEval, type TaskResult } from './set-eval.ts'
import { loadSettings, TASKS, type Task } from './contracts.ts'
import { clinicalRedactor } from './redact.ts'
import { rescoreSummaryLine, rescoreTrace } from './rescore.ts'
import { reviewVitalSigns, vitalDocumentNames } from './review.ts'
import { reviewTranscript, transcriptDocumentNames } from './review-transcript.ts'

export const PROFILE: ProfileModule = {
  name: 'clinical',
  mode: 'extract',
  needsPack: true,
  /**
   * Which corpus `--case` selects from, decided by `--task` for the same reason `review`
   * below is: this pack holds two corpora that are not interchangeable, and a transcript is
   * not reachable by the name list the note tasks expose.
   */
  documentNames: (pack: Pack, options?: Record<string, unknown>): string[] =>
    reviewTask(options?.task) === 'transcript' ? transcriptDocumentNames(pack) : vitalDocumentNames(pack),
  /**
   * Trace redaction, decided by the PACK rather than by this file.
   *
   * A trace holds the completion, the parse error that quotes it and the misses that quote
   * the model's spans — for a pack of real records, three fields of patient data. Identity
   * only when the pack states its corpus is synthetic; a pack that says nothing is treated as
   * real, because the failure mode here is not a cluttered file.
   */
  redactFor: (pack?: Pack) => clinicalRedactor(pack ? loadSettings(pack).corpusSynthetic : false),
  /**
   * The extractor, pointed at a document rather than at the corpus. Same pack, same prompt,
   * same grammar, same cap as the eval — each task's `*Request` assembles all four for this
   * and for `runEval`, so what was measured is what this runs.
   *
   * `--task` selects which contract, and it defaults to vital signs rather than to the pack's
   * `defaultTask`. That looks like an inconsistency and is deliberate: `eval` without a task
   * grades whatever the pack nominates, but `extract` without one has always meant vital
   * signs, and quietly re-pointing an existing command at a different contract because a pack
   * changed a key is how a caller ends up parsing the wrong schema.
   *
   * Only two of the four tasks are reachable here. Summary reads a whole record assembled
   * from many notes rather than one document, and note formatting reads the same note the
   * vital-signs corpus holds — neither is refused for a shortage of code, and both are named
   * in the error so the refusal is a statement rather than a gap.
   */
  async review(ctx: ReviewContext): Promise<ReviewResult> {
    const shared = {
      pack: ctx.pack!,
      baseUrl: ctx.baseUrl,
      trace: ctx.trace,
      constrain: Boolean(ctx.options.constrain),
      input: ctx.input,
    }
    const task = reviewTask(ctx.options.task)
    return task === 'transcript' ? reviewTranscript(shared) : reviewVitalSigns(shared)
  },
  async runEval(ctx: EvalContext): Promise<EvalVerdict> {
    const pack = ctx.pack!
    // Re-scoring a recorded run, before anything reaches the network — the whole point of the
    // verb is that there is no network. It returns a verdict about AGREEMENT with the trace
    // rather than about a floor: the floors belong to a graded run against a server, and a
    // command that could turn a saved file into a PASS would be a way to pass CI without
    // running anything.
    if (ctx.options.fromTrace) {
      const results = rescoreTrace({
        pack,
        path: String(ctx.options.fromTrace),
        stripFences: Boolean(ctx.options.stripFences),
      })
      for (const r of results) for (const line of r.lines) console.log(line)
      return { pass: true, summary: `re-scored, no gate applied — ${rescoreSummaryLine(results)}` }
    }

    // Asked ONCE, before any task runs, and handed to all three. Three tasks asking the same
    // server the same two questions is three round-trips for one answer and three chances to
    // disagree about what the run was measured against.
    const identity = await identifyServer(ctx.baseUrl)
    // Printed FIRST, above the numbers rather than below them. A run that cannot name what
    // produced it still prints a percentage in the same shape as one that can, and the whole
    // difference between the two is this line.
    if (identity.warning) console.error(`\nwarning: ${identity.warning}`)
    const shared = {
      pack,
      baseUrl: ctx.baseUrl,
      trace: ctx.trace,
      identity,
      constrain: Boolean(ctx.options.constrain),
      runs: Number(ctx.options.runs ?? 1),
      difficulty: ctx.options.difficulty as string | undefined,
      cachePrompt: ctx.options.cachePrompt !== false,
    }
    const tasks = requestedTasks(ctx.options.task, loadSettings(pack).defaultTask)
    const results: TaskResult[] = []

    for (const task of tasks) {
      if (task === 'vital-signs') results.push(await vitalSignsResult(shared))
      else if (task === 'summary') results.push(await runSummaryEval(shared))
      else if (task === 'note-format') results.push(await runNoteFormatEval(shared))
      else results.push(await runTranscriptEval(shared))
    }

    // EVERY task clears its own floor, and every sub-gate within a task clears its own.
    // Averaging them would let a ceiling on one hide a failure in another, which matters
    // here more than it sounds: vital signs is the mature task and the other three are new,
    // so a mean would be carried by the one that was never in doubt.
    //
    // `gatePasses` also refuses a gate whose denominator was zero. A floor cleared by
    // measuring nothing is not a pass, and it used to read as one.
    const pass = results.every((r) => gatePasses(r) && (r.gates ?? []).every(gatePasses))
    return {
      pass,
      summary: results
        .map((r) => {
          const failed = [
            ...(gatePasses(r) ? [] : [r.measured ? 'gate' : 'gate (nothing measured)']),
            ...(r.gates ?? [])
              .filter((g) => !gatePasses(g))
              .map((g) => (g.measured ? g.name : `${g.name} (nothing measured)`)),
          ]
          return `${r.task}: ${r.summary}${failed.length ? ` [FAILED: ${failed.join(', ')}]` : ''}`
        })
        .join('\n       '),
    }
  },
}

/**
 * Which contract `extract` runs.
 *
 * Refused rather than defaulted, exactly as `asTask` refuses an unknown `--task`: a typo that
 * silently read vital signs would hand back a reading against a schema nobody asked for, and
 * it would look identical to a successful run of the task they wanted.
 */
const REVIEW_TASKS = ['vital-signs', 'transcript'] as const

const reviewTask = (requested: unknown): 'vital-signs' | 'transcript' => {
  if (requested === undefined || requested === 'default') return 'vital-signs'
  const s = String(requested)
  if ((REVIEW_TASKS as readonly string[]).includes(s)) return s as 'vital-signs' | 'transcript'
  if ((TASKS as string[]).includes(s)) {
    throw new ProfileError(
      `--task '${s}' is a graded task but not a reviewable one: ` +
        (s === 'summary'
          ? 'its input is a whole record assembled from many notes, not one document — run `eval --task summary` instead'
          : 'it reads the same notes vital signs reads, and `extract --task vital-signs --case NAME` reaches them'),
    )
  }
  throw new ProfileError(`unknown --task '${s}' for extract (expected ${REVIEW_TASKS.join(', ')})`)
}

/**
 * Which tasks a run grades. `--task all` runs the three; no flag runs the pack's default.
 *
 * An unknown name is refused rather than falling back to the default: a typo that silently
 * graded vital signs would report a number for a task nobody asked about, and its output
 * would look exactly like a successful run of the task they wanted.
 */
const requestedTasks = (requested: unknown, fallback: string): Task[] => {
  if (requested === undefined || requested === 'default') return [asTask(fallback)]
  if (requested === 'all') return TASKS
  return [asTask(String(requested))]
}

const asTask = (s: string): Task => {
  if ((TASKS as string[]).includes(s)) return s as Task
  throw new ProfileError(`unknown --task '${s}' (expected ${TASKS.join(', ')}, all, or default)`)
}

/** The vital-signs eval, in the shape the other two already return. */
const vitalSignsResult = async (o: Parameters<typeof runVitalSignsEval>[0]): Promise<TaskResult> => {
  const { recall, floor, valueFloor, valueRate, unitFloor, unitRate, tally, byDifficulty, bench } =
    await runVitalSignsEval(o)
  // The hardest tier that was actually graded, named in the one line a CI log keeps. An
  // aggregate that passes while difficulty 5 collapses is the failure this corpus was
  // extended to make visible, and a summary that omitted it would hide it again.
  const hardest = [...byDifficulty.keys()].sort((a, b) => b - a)[0]
  const hard = byDifficulty.get(hardest!)
  return {
    task: 'vital-signs',
    score: recall,
    floor,
    // Zero graded slots means the filter selected only cases with nothing to extract. The
    // recall over them is 1.0 and it is not a pass; see TaskResult.measured.
    measured: tally.gradedTotal > 0,
    /**
     * Detection is the HEADLINE gate — a missed vital is invisible to the clinician, a
     * spurious one is visible and rejected in a click — and value and unit are sub-gates
     * beside it, for a reason this pack measured rather than assumed. Detection saturated:
     * 87/88 and 88/88 for two models at every tier, including the tier added to end
     * saturation. What separated them was value (82/88 against 86/87) and unit (81/88
     * against 86/87), and neither gated, so CI passed a model that read a fifth of the
     * flowsheet wrong.
     *
     * Not averaged into detection, for the same reason the note-format sub-gates are not
     * averaged into its item recall: one blended number lets a ceiling on one axis pay for a
     * collapse on another, and the whole point of counting value and unit apart is to keep
     * visible which of them a prompt change fixed.
     */
    gates: [
      { name: 'value', score: valueRate, floor: valueFloor, measured: tally.detected > 0 },
      { name: 'unit', score: unitRate, floor: unitFloor, measured: tally.detected > 0 },
    ],
    summary:
      `detection ${(recall * 100).toFixed(0)}% vs floor ${(floor * 100).toFixed(0)}% ` +
      `(value ${tally.valueExact}/${tally.detected} vs ${(valueFloor * 100).toFixed(0)}%, ` +
      `unit ${tally.unitExact}/${tally.detected} vs ${(unitFloor * 100).toFixed(0)}%, ` +
      `provenance ${tally.quoteVerified}/${tally.detected}, halluc ${tally.hallucinations}, ` +
      `failed runs ${tally.failedRuns})` +
      (hard ? ` · hardest tier d${hardest}: detection ${hard.detected}/${hard.gradedTotal}` : '') +
      // Cost last and after the correctness clause, deliberately. It is context for the
      // verdict, never part of it: nothing here gates on a speed.
      (bench ? ` · ${bench.generation.perSecond.toFixed(1)} tok/s, median ${(bench.wall.medianMs / 1000).toFixed(1)}s/note` : ''),
    bench,
  }
}
