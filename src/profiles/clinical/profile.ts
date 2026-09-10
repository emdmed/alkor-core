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
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ProfileError, type EvalContext, type EvalVerdict, type ProfileModule, type ReviewContext, type ReviewResult } from '../../core/profile.ts'
import type { Provider } from '../../core/client.ts'
import type { Activity } from '../../core/activity.ts'
import { identifyServer } from '../../core/client.ts'
import type { Pack } from '../../core/pack.ts'
import { PackError } from '../../core/pack.ts'
import { runVitalSignsEval } from './eval.ts'
import { runShockEval } from './shock-eval.ts'
import { runSepsisEval, sepsisDocumentNames } from './sepsis-eval.ts'
import { gatePasses, runNoteFormatEval, runSummaryEval, runTranscriptEval, type TaskResult } from './set-eval.ts'
import { loadSettings } from './settings.ts'
import { GRADED_TASKS, TASKS, type Task } from './contracts.ts'
import { clinicalRedactor } from './redact.ts'
import { rescoreSummaryLine, rescoreTrace } from './rescore.ts'
import { routeClinicalShape, type ClinicalRouteResult } from './clinical-router.ts'
import { reviewVitalSigns, vitalDocumentNames } from './review.ts'
import { reviewTranscript, transcriptDocumentNames } from './review-transcript.ts'
import { reviewShock } from './review-shock.ts'
import { shockDocumentNames } from './shock-eval.ts'
import type { ShockExam } from './shock.ts'
import { reviewSepsis } from './review-sepsis.ts'
import { reviewSepsisExtraction } from './review-sepsis-extraction.ts'
import { reviewNoteFormat } from './review-note-format.ts'
import { reviewShockExtraction, type ShockExtractionReviewOptions } from './review-shock-extraction.ts'
import { runShockExtractionEval, shockExtractionDocumentNames } from './shock-extraction-eval.ts'
import { runShockPipelineEval, shockPipelineDocumentNames } from './shock-pipeline-eval.ts'

export const PROFILE: ProfileModule = {
  name: 'clinical',
  mode: 'extract',
  needsPack: true,
  topology: {
    stages: [{
      name: 'route',
      kind: 'decision',
      routes: [
        { name: 'vital-signs', stages: [{ name: 'prompt-assembly' }, { name: 'llm-call' }, { name: 'parse' }, { name: 'verify' }] },
        { name: 'note-format', stages: [{ name: 'prompt-assembly' }, { name: 'llm-call' }, { name: 'parse' }, { name: 'verify' }] },
        {
          name: 'transcript',
          stages: [
            { name: 'prompt-assembly' },
            { name: 'llm-call' },
            { name: 'parse' },
            { name: 'medication-pass', optional: true },
            { name: 'verify' },
            { name: 'transcript-repair', optional: true },
          ],
        },
        {
          name: 'shock-extraction',
          stages: [{ name: 'shock-extraction' }, { name: 'llm-call' }, { name: 'parse' }],
          // Prose takes the long path; an already-structured exam may enter `shock` directly.
          feeds: 'shock',
        },
        { name: 'shock', stages: [{ name: 'shock-classification' }, { name: 'llm-call' }, { name: 'verify' }] },
        {
          name: 'sepsis-extraction',
          stages: [{ name: 'sepsis-extraction' }, { name: 'llm-call' }, { name: 'parse' }],
          // The shock arm's opposite number: prose takes the long path, while an already
          // structured qSOFA payload may enter `sepsis` directly. A septic-shock note takes
          // BOTH long paths, which is why these two feeds are drawn separately.
          feeds: 'sepsis',
        },
        { name: 'sepsis', stages: [{ name: 'sepsis-screening' }, { name: 'llm-call' }, { name: 'verify' }] },
        { name: 'summary', available: false },
      ],
    }],
  },
  /**
   * Which corpus `--case` selects from, decided by `--task` for the same reason `review`
   * below is: this pack holds two corpora that are not interchangeable, and a transcript is
   * not reachable by the name list the note tasks expose.
   */
  documentNames: (pack: Pack, options?: Record<string, unknown>): string[] => {
    const task = reviewTask(options?.task)
    if (task === 'transcript') return transcriptDocumentNames(pack)
    if (task === 'shock') return shockDocumentNames(pack)
    if (task === 'shock-extraction') return shockExtractionDocumentNames(pack)
    if (task === 'shock-pipeline') return shockPipelineDocumentNames(pack)
    if (task === 'sepsis') return sepsisDocumentNames(pack)
    return vitalDocumentNames(pack)
  },
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
   * Only some tasks are reachable here. Summary reads a whole record assembled from many notes
   * rather than one document, and note formatting reads the same note the vital-signs corpus
   * holds — neither is refused for a shortage of code, and both are named in the error so the
   * refusal is a statement rather than a gap.
   */
  async review(ctx: ReviewContext): Promise<ReviewResult> {
    const contextDir = (ctx.options['context-dir'] ?? ctx.options.contextDir) as string | undefined

    if (contextDir) {
      return reviewWithCheckpoint(ctx, contextDir)
    }

    return reviewSingleStep(ctx)
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

    // Asked ONCE, before any task runs, and handed to all of them. Seven tasks asking the same
    // server the same two questions is seven round-trips for one answer and seven chances to
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
      // Reaches the transcript eval and is ignored by the others — the extract- and reason-shaped
      // tasks have no citation to repair. Refused rather than ignored when the run asks for ONLY
      // those tasks: a flag that quietly dropped a flag would report a number under.
      repair: Boolean(ctx.options.repair),
      // ON unless turned off, which is the opposite of `repair` and deliberately so: the
      // medication pass is part of what this pack says reading a dictation means, so an eval
      // that ran it only on request would measure a reading the application does not ship.
      // Measured over the seventeen dictations: recall 94% -> 96%, dose errors 3 -> 1,
      // hallucinations 4 -> 3, every gate clear.
      medicationPass: ctx.options.medicationPass !== false,
      provider: ctx.provider,
    }
    const tasks = requestedTasks(ctx.options.task, loadSettings(pack).defaultTask)
    if (shared.repair && !tasks.includes('transcript')) {
      throw new ProfileError(
        `--repair applies to the transcript task, which this run does not include (${tasks.join(', ')})`,
      )
    }
    const results: TaskResult[] = []

    for (const task of tasks) {
      if (task === 'vital-signs') results.push(await vitalSignsResult(shared))
      else if (task === 'summary') results.push(await runSummaryEval(shared))
      else if (task === 'note-format') results.push(await runNoteFormatEval(shared))
      // Handed the same `shared` as the rest, minus nothing: it honours --constrain, --runs,
      // --difficulty and --no-cache-prompt exactly as the extraction tasks do, and ignores
      // --repair and --medication-pass because it has no second call to make. A task that
      // quietly dropped a flag would report a number under conditions the header names and
      // the run did not use.
      else if (task === 'shock') results.push(await runShockEval(shared))
      else if (task === 'sepsis') results.push(await runSepsisEval(shared))
      else if (task === 'shock-extraction') results.push(await runShockExtractionEval(shared))
      else if (task === 'shock-pipeline') results.push(await runShockPipelineEval(shared))
      else if (task === 'transcript') results.push(await runTranscriptEval(shared))
      // NAMED rather than reached by falling off the end of the chain. This was an unguarded
      // `else` that ran the transcript eval for anything it did not recognise, so the day a
      // task joined TASKS without an eval mode — which is the day `sepsis-extraction` did —
      // `--task all` would have graded transcripts and filed the number under the new task's
      // name. A task with no eval corpus has to say so.
      else {
        throw new ProfileError(
          `--task '${task}' has no eval mode in this profile: it is reviewable (\`extract\`) but ` +
            'not yet graded, because the pack declares no answer key for it — add its cases to ' +
            'the pack and its eval to this chain in the same commit',
        )
      }
    }

    // EVERY task clears its own floor, and every sub-gate within a task clears its own.
    // Averaging them would let a ceiling on one hide a failure in another, which matters
    // here more than it sounds: vital signs is the mature task and the others are new,
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
const reviewTask = (requested: unknown): Task => {
  if (requested === undefined || requested === 'default') return 'vital-signs'
  const s = String(requested)
  if ((TASKS as string[]).includes(s)) return s as Task
  throw new ProfileError(`unknown --task '${s}' for extract (expected ${TASKS.join(', ')})`)
}

/**
 * Load a case document for routing, trying the default kind first, then transcript, then exam.
 */
const resolveCaseDocument = (pack: Pack, caseName: string): string => {
  try {
    return pack.document(caseName)
  } catch (e) {
    if (!(e instanceof PackError)) throw e
  }
  try {
    return pack.document(caseName, 'transcript')
  } catch (e) {
    if (!(e instanceof PackError)) throw e
  }
  try {
    return pack.document(caseName, 'exam')
  } catch (e) {
    if (!(e instanceof PackError)) throw e
  }
  throw new ProfileError(`pack '${pack.name}' has no document for case '${caseName}'`)
}

/**
 * Which tasks a run grades. `--task all` runs all of them; no flag runs the pack's default.
 *
 * An unknown name is refused rather than falling back to the default: a typo that silently
 * graded vital signs would report a number for a task nobody asked about, and its output
 * would look exactly like a successful run of the task they wanted.
 */
const requestedTasks = (requested: unknown, fallback: string): Task[] => {
  if (requested === undefined || requested === 'default') return [asTask(fallback)]
  // `all` is every task that can report a number, which is no longer every task: a reviewable
  // but ungraded contract in this list would stop the run at the first task with no answer key.
  if (requested === 'all') return GRADED_TASKS
  return [asTask(String(requested))]
}

const asTask = (s: string): Task => {
  if ((TASKS as string[]).includes(s)) return s as Task
  throw new ProfileError(`unknown --task '${s}' (expected ${TASKS.join(', ')}, all, or default)`)
}

// --- Review helpers ------------------------------------------------------------------------

const resolveInputText = (ctx: ReviewContext): string => {
  if (ctx.input.kind === 'text') return ctx.input.text
  return resolveCaseDocument(ctx.pack!, ctx.input.name)
}

const executeClinicalTask = async (ctx: ReviewContext, shared: { pack: Pack; baseUrl?: string; trace: ReviewContext['trace']; constrain: boolean; input: ReviewContext['input']; calculate: boolean; provider?: Provider; activity?: Activity }, task: Task): Promise<ReviewResult> => {
  if (task !== 'transcript' && ctx.options.repair) {
    throw new ProfileError(`--repair applies to --task transcript; ${task} has no citation to repair`)
  }

  if (task === 'vital-signs') return reviewVitalSigns(shared)
  if (task === 'transcript') return reviewTranscript({ ...shared, repair: Boolean(ctx.options.repair) })
  if (task === 'shock') return reviewShock({ pack: ctx.pack!, baseUrl: ctx.baseUrl, trace: ctx.trace, constrain: Boolean(ctx.options.constrain), input: shared.input, provider: shared.provider, activity: ctx.activity })
  if (task === 'sepsis') return reviewSepsis({ pack: ctx.pack!, baseUrl: ctx.baseUrl, trace: ctx.trace, constrain: Boolean(ctx.options.constrain), input: shared.input, provider: shared.provider, activity: ctx.activity })
  if (task === 'shock-extraction') return reviewShockExtraction({ pack: ctx.pack!, baseUrl: ctx.baseUrl, trace: ctx.trace, constrain: Boolean(ctx.options.constrain), input: shared.input, provider: shared.provider, activity: ctx.activity })
  if (task === 'sepsis-extraction') return reviewSepsisExtraction({ pack: ctx.pack!, baseUrl: ctx.baseUrl, trace: ctx.trace, constrain: Boolean(ctx.options.constrain), input: shared.input, provider: shared.provider, activity: ctx.activity })
  if (task === 'shock-pipeline') {
    // Chain extraction → classification. The extraction step reads prose; the classification
    // step reads the extracted exam as JSON text, exactly as the standalone shock review does.
    const extractionResult = await reviewShockExtraction({ pack: ctx.pack!, baseUrl: ctx.baseUrl, trace: ctx.trace, constrain: Boolean(ctx.options.constrain), input: shared.input, provider: shared.provider, activity: ctx.activity })
    if (!extractionResult.ok || !extractionResult.report) {
      return { ...extractionResult, text: `shock-pipeline: extraction failed — ${extractionResult.text}` }
    }
    const exam = (extractionResult.report as { exam?: ShockExam }).exam
    if (!exam) {
      return { ...extractionResult, text: `shock-pipeline: extraction produced no exam payload — ${extractionResult.text}` }
    }
    const classificationResult = await reviewShock({ pack: ctx.pack!, baseUrl: ctx.baseUrl, trace: ctx.trace, constrain: Boolean(ctx.options.constrain), input: { kind: 'text', text: JSON.stringify(exam), label: extractionResult.label }, provider: shared.provider, activity: ctx.activity })
    return {
      text: `${extractionResult.text}\n${classificationResult.text}`,
      ok: extractionResult.ok && classificationResult.ok,
      raw: classificationResult.raw,
      document: extractionResult.document,
      label: extractionResult.label,
      report: { extraction: extractionResult.report, classification: classificationResult.ok },
    }
  }
  if (task === 'note-format') return reviewNoteFormat({ pack: ctx.pack!, baseUrl: ctx.baseUrl, trace: ctx.trace, constrain: Boolean(ctx.options.constrain), input: shared.input, provider: shared.provider, activity: ctx.activity })

  throw new ProfileError(
    `--task '${task}' is a graded task but not a reviewable one: ` +
      'its input is a whole record assembled from many notes, not one document — ' +
      'run `eval --task summary` instead',
  )
}

const executeClinicalRoute = async (
  ctx: ReviewContext,
  shared: { pack: Pack; baseUrl?: string; trace: ReviewContext['trace']; constrain: boolean; input: ReviewContext['input']; calculate: boolean; provider?: Provider; activity?: Activity },
  tasks: Task[],
): Promise<ReviewResult> => {
  if (tasks.length === 1) return executeClinicalTask(ctx, shared, tasks[0]!)

  /**
   * Which task feeds which, for the two arms that are a pipeline rather than a single pass.
   *
   * Both arms have the same shape — prose in, a closed payload out, that payload into the
   * contract that reasons over it — so the handoff is one table rather than one branch per
   * arm. That matters now that a plan can contain BOTH: a septic-shock note runs four tasks,
   * and each downstream task must read its own upstream payload and not the other's.
   */
  const FEEDS: Partial<Record<Task, Task>> = { shock: 'shock-extraction', sepsis: 'sepsis-extraction' }

  const results: Array<{ task: Task; result: ReviewResult }> = []
  /** Payload produced by each extraction that ran, keyed by the extraction task. */
  const extracted = new Map<Task, ReviewContext['input']>()
  const attempted = new Set<Task>()
  for (const task of tasks) {
    const upstream = FEEDS[task]
    // An upstream that RAN and produced nothing usable stops its downstream rather than letting
    // it read the original prose. The alternative is worse than a skip: the reasoning contracts
    // parse their input as a closed payload, so a note arriving there fails as a parse error and
    // reports as though the model could not answer, when what actually happened is that the
    // extraction it depended on came back empty.
    if (upstream && attempted.has(upstream) && !extracted.has(upstream)) {
      results.push({
        task,
        result: { text: `${task} skipped: ${upstream} produced no usable payload`, ok: false },
      })
      continue
    }
    const feed = upstream ? extracted.get(upstream) : undefined
    const result = await executeClinicalTask(ctx, feed ? { ...shared, input: feed } : shared, task)
    results.push({ task, result })

    if (task === 'shock-extraction' || task === 'sepsis-extraction') {
      attempted.add(task)
      const exam = (result.report as { exam?: unknown } | undefined)?.exam
      if (result.ok && exam) extracted.set(task, { kind: 'text', text: JSON.stringify(exam), label: result.label })
    }
  }

  const output = Object.fromEntries(results.map(({ task, result }) => {
    let value = result.report
    if (value === undefined && result.raw !== undefined) {
      try {
        value = JSON.parse(result.raw)
      } catch {
        value = result.raw
      }
    }
    return [task, { ok: result.ok, output: value ?? result.text }]
  }))

  return {
    text: results.map(({ result }) => result.text).join('\n'),
    ok: results.every(({ result }) => result.ok),
    document: shared.input.kind === 'text' ? shared.input.text : undefined,
    label: shared.input.kind === 'text' ? shared.input.label : shared.input.name,
    report: { routes: tasks, results: output },
  }
}

const reviewSingleStep = async (ctx: ReviewContext): Promise<ReviewResult> => {
  const shared = {
    pack: ctx.pack!,
    baseUrl: ctx.baseUrl,
    trace: ctx.trace,
    constrain: Boolean(ctx.options.constrain),
    input: ctx.input,
    calculate: Boolean(ctx.options.calculate),
    provider: ctx.provider,
    activity: ctx.activity,
  }

  let tasks: Task[]
  if (ctx.options.task === undefined || ctx.options.task === 'default') {
    const text = resolveInputText(ctx)
    const route = routeClinicalShape(text, loadSettings(ctx.pack!).defaultTask)
    ctx.activity?.emit({
      kind: 'stage',
      name: 'route',
      status: 'completed',
      detail: { shape: route.shape, confidence: route.confidence, task: route.task, tasks: route.tasks },
    })
    ctx.trace.write({
      event: 'route',
      kind: 'clinical',
      shape: route.shape,
      task: route.task,
      tasks: route.tasks,
      confidence: route.confidence,
      reason: route.reason,
    })
    tasks = route.tasks
  } else {
    tasks = [reviewTask(ctx.options.task)]
  }

  return executeClinicalRoute(ctx, shared, tasks)
}

/**
 * Checkpointed review: the clinical profile splits into two logical steps —
 * route (step 0) and execute (step 1) — both persisted to `contextDir/clinical/`.
 *
 * This lets local models speak to each other by leaving state on disk: the router
 * writes `route.json`, then the executor (possibly on a different model load) reads
 * it and writes `result.json`. A caller can resume after a crash, swap a model, or
 * inspect the intermediate decision.
 */
const reviewWithCheckpoint = async (ctx: ReviewContext, contextDir: string): Promise<ReviewResult> => {
  const clinicalDir = join(contextDir, 'clinical')
  mkdirSync(clinicalDir, { recursive: true })

  const routeFile = join(clinicalDir, 'route.json')
  const resultFile = join(clinicalDir, 'result.json')

  // Resume from a fully cached run.
  if (existsSync(resultFile)) {
    return JSON.parse(readFileSync(resultFile, 'utf8')) as ReviewResult
  }

  // Caller explicitly named a task — skip the router and use it directly.
  let tasks: Task[]
  let text: string
  if (ctx.options.task !== undefined && ctx.options.task !== 'default') {
    tasks = [reviewTask(ctx.options.task)]
    text = resolveInputText(ctx)
  } else {
    // Resolve or resume the route.
    let route: ClinicalRouteResult
    if (existsSync(routeFile)) {
      const cached = JSON.parse(readFileSync(routeFile, 'utf8')) as { route: ClinicalRouteResult; text: string }
      route = cached.route
      text = cached.text
    } else {
      text = resolveInputText(ctx)
      route = routeClinicalShape(text, loadSettings(ctx.pack!).defaultTask)
      ctx.activity?.emit({
        kind: 'stage',
        name: 'route',
        status: 'completed',
        detail: { shape: route.shape, confidence: route.confidence, task: route.task, tasks: route.tasks },
      })
      ctx.trace.write({
        event: 'route',
        kind: 'clinical',
        shape: route.shape,
        task: route.task,
        tasks: route.tasks,
        confidence: route.confidence,
        reason: route.reason,
      })
      writeFileSync(routeFile, JSON.stringify({ route, text }, null, 2))
    }
    tasks = route.tasks ?? [route.task]
  }

  const shared = {
    pack: ctx.pack!,
    baseUrl: ctx.baseUrl,
    trace: ctx.trace,
    constrain: Boolean(ctx.options.constrain),
    input: ctx.input.kind === 'text' ? ctx.input : ({ kind: 'text', text, label: ctx.input.name } as ReviewContext['input']),
    calculate: Boolean(ctx.options.calculate),
    provider: ctx.provider,
    activity: ctx.activity,
  }

  const result = await executeClinicalRoute(ctx, shared, tasks)
  // Only cache successful results so a transient failure (network, model not loaded)
  // can be retried on the next run without re-routing.
  if (result.ok) writeFileSync(resultFile, JSON.stringify(result, null, 2))
  return result
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
