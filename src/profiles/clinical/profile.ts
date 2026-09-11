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
import { GRADED_TASKS, ROUTED_TASKS, TASK_FEEDS, TASKS, UNREVIEWABLE_TASKS, type Task } from './contracts.ts'
import type { ProfileTopology } from '../../core/topology.ts'
import { CALCULATIONS_STAGE, ROUTE_STAGE, VITALS_FIRST_STAGE, topologyStagesFor } from './stages.ts'
import {
  hasVitalSigns,
  measureVitals,
  medprotocolFor,
  renderMeasured,
  routeThresholds,
  seedWithMeasured,
  vitalsDetected,
  type MeasuredVitals,
  type RouteThresholds,
} from './vitals-first.ts'
import type { VitalSigns } from './extraction.ts'
import { clinicalRedactor } from './redact.ts'
import { rescoreSummaryLine, rescoreTrace } from './rescore.ts'
import { routeClinicalShape, skipsFrontDoor, type ClinicalRouteResult } from './clinical-router.ts'
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

/**
 * The profile's execution shape, computed from the same tables the runtime routes by.
 *
 * A route per task the internal router can select, a `feeds` edge wherever one contract
 * consumes another's payload, and `available: false` wherever `extract` will refuse the
 * task by name. None of it is a second statement of anything: the fan comes from the
 * shapes, the edges from `TASK_FEEDS`, the refusals from `UNREVIEWABLE_TASKS`, and each
 * route's stages from the passes the review modules are required to emit through.
 *
 * The fan is therefore CLINICAL QUESTIONS ONLY. Transcription, note formatting and
 * summarisation are tooling a caller asks for by name — see `TOOLING_TASKS` — and drawing
 * them here would show a decision the router does not make.
 */
const clinicalTopology = (): ProfileTopology => ({
  stages: [{
    // The front door, drawn BEFORE the decision because that is when it runs. Optional in the
    // strict sense: a document with no vital sign written in it never lights this node, and
    // routing for those documents costs exactly what it always did.
    name: VITALS_FIRST_STAGE,
    operation: 'model',
    optional: true,
  }, {
    // The CLI pass over whatever the front door read. Deterministic, no model, and drawn
    // separately from the extraction because they fail for different reasons: an empty reading
    // is the model's, a refusal here is medprotocol's.
    name: CALCULATIONS_STAGE,
    operation: 'code',
    optional: true,
  }, {
    name: ROUTE_STAGE,
    kind: 'decision',
    operation: 'decision',
    routes: ROUTED_TASKS.map((task) => {
      const stages = topologyStagesFor(task)
      const feeds = TASK_FEEDS[task]
      return {
        name: task,
        ...(stages ? { stages } : {}),
        ...(feeds ? { feeds } : {}),
        ...(UNREVIEWABLE_TASKS.includes(task) ? { available: false } : {}),
      }
    }),
  }],
})

export const PROFILE: ProfileModule = {
  name: 'clinical',
  mode: 'extract',
  needsPack: true,
  topology: clinicalTopology(),
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

// --- The front door ---------------------------------------------------------------------------

/** What the vital-signs pass produced before the route was decided. */
interface FrontDoor {
  /** The reading itself, reported as a result of the run rather than thrown away. */
  result: ReviewResult
  /** The numbers, after medprotocol. Absent when the extraction came back empty. */
  measured?: MeasuredVitals
  thresholds: RouteThresholds
}

/**
 * The thresholds, or `undefined` for a pack that has no syndrome arms to route to.
 *
 * A pack declaring neither `[clinical.shockExam]` nor `[clinical.sepsisScreen]` has no shock
 * contract and no qSOFA screen, so there is nothing a measured systolic could route it to, and
 * spending a pass to find that out would be spending it for nothing. Refused by ABSENCE rather
 * than by a default: a pack that declares the tables partially still fails loudly inside
 * `loadShockRule`, which is where an incomplete cut-point table should fail.
 */
const syndromeThresholds = (pack: Pack): RouteThresholds | undefined => {
  const manifest = pack.manifest as { clinical?: { shockExam?: unknown; sepsisScreen?: unknown } }
  if (!manifest.clinical?.shockExam || !manifest.clinical?.sepsisScreen) return undefined
  return routeThresholds(pack)
}

/**
 * Read the vital signs, calculate everything the CLI can, and hand the numbers to the router.
 *
 * Returns `undefined` when the front door does not apply, and the three reasons it does not are
 * all cheap to establish: the document carries no vital sign, the pack has no syndrome arm, or
 * the pack declares no medprotocol CLI. None of them costs a model call.
 *
 * A FAILED EXTRACTION IS NOT A FAILED RUN. The reading is reported either way and the route is
 * decided on the words alone, exactly as it was before this step existed — a model that came
 * back empty should cost the run its numbers, not its routing.
 */
const runFrontDoor = async (
  ctx: ReviewContext,
  shared: { pack: Pack; baseUrl?: string; trace: ReviewContext['trace']; constrain: boolean; input: ReviewContext['input']; provider?: Provider; activity?: Activity },
  text: string,
): Promise<FrontDoor | undefined> => {
  if (skipsFrontDoor(text) || !hasVitalSigns(text)) return undefined
  const thresholds = syndromeThresholds(shared.pack)
  if (!thresholds) return undefined

  ctx.activity?.emit({
    kind: 'stage',
    name: VITALS_FIRST_STAGE,
    operation: 'model',
    status: 'started',
    detail: { readings: vitalsDetected(text) },
  })
  // `calculate: true` regardless of --calculate: the derived values are not a display option
  // here, they are the evidence the next decision is made on.
  const result = await reviewVitalSigns({ ...shared, calculate: true })
  const vitals = (result.report as { vitals?: VitalSigns } | undefined)?.vitals
  ctx.activity?.emit({
    kind: 'stage',
    name: VITALS_FIRST_STAGE,
    operation: 'model',
    status: 'completed',
    detail: { ok: result.ok, readings: vitalsDetected(text) },
  })

  if (!result.ok || !vitals) {
    ctx.trace.write({ event: 'vitals-first', ok: false, reason: 'the vital-signs pass produced no reading' })
    return { result, thresholds }
  }

  const measured = measureVitals(vitals, medprotocolFor(shared.pack))
  ctx.activity?.emit({
    kind: 'stage',
    name: CALCULATIONS_STAGE,
    operation: 'code',
    status: 'completed',
    detail: {
      via: 'medprotocol vitals',
      ran: measured.cliRan,
      ...(measured.cliRan
        ? {
            bloodPressureCategory: measured.bloodPressureCategory,
            heartRateCategory: measured.heartRateCategory,
            meanArterialPressure: measured.meanArterialPressure,
            shockIndex: Number(measured.shockIndex!.toFixed(2)),
          }
        : { skipped: measured.cliSkipped }),
    },
  })
  ctx.trace.write({ event: 'vitals-first', ok: true, measured })

  return {
    result: { ...result, text: `${result.text}\n--- measured ---\n${renderMeasured(measured).join('\n')}` },
    measured,
    thresholds,
  }
}

// --- Review helpers ------------------------------------------------------------------------

const resolveInputText = (ctx: ReviewContext): string => {
  if (ctx.input.kind === 'text') return ctx.input.text
  return resolveCaseDocument(ctx.pack!, ctx.input.name)
}

const executeClinicalTask = async (ctx: ReviewContext, shared: { pack: Pack; baseUrl?: string; trace: ReviewContext['trace']; constrain: boolean; input: ReviewContext['input']; calculate: boolean; provider?: Provider; activity?: Activity }, task: Task, front?: FrontDoor): Promise<ReviewResult> => {
  if (task !== 'transcript' && ctx.options.repair) {
    throw new ProfileError(`--repair applies to --task transcript; ${task} has no citation to repair`)
  }

  // The front door already ran this contract over this document. Running it again would be the
  // same prompt, the same schema and the same note, for a second answer that may differ from
  // the one the route was decided on — and a report that disagrees with its own routing reason
  // is worse than a slower one.
  if (task === 'vital-signs' && front) return front.result
  if (task === 'vital-signs') return reviewVitalSigns(shared)
  if (task === 'transcript') return reviewTranscript({ ...shared, repair: Boolean(ctx.options.repair) })
  if (task === 'shock') return reviewShock({ pack: ctx.pack!, baseUrl: ctx.baseUrl, trace: ctx.trace, constrain: Boolean(ctx.options.constrain), input: shared.input, provider: shared.provider, activity: ctx.activity })
  if (task === 'sepsis') return reviewSepsis({ pack: ctx.pack!, baseUrl: ctx.baseUrl, trace: ctx.trace, constrain: Boolean(ctx.options.constrain), input: shared.input, provider: shared.provider, activity: ctx.activity })
  // Both extraction arms read the ORIGINAL prose with the measured numbers appended as facts.
  // They still run — the payloads they build need findings the vital-signs contract has no slot
  // for, a jugular venous pressure and a lung exam and a GCS — but nothing is served by asking
  // a second model pass to read a blood pressure the CLI has already parsed.
  if (task === 'shock-extraction') return reviewShockExtraction({ pack: ctx.pack!, baseUrl: ctx.baseUrl, trace: ctx.trace, constrain: Boolean(ctx.options.constrain), input: seededInput(shared.input, front), provider: shared.provider, activity: ctx.activity })
  if (task === 'sepsis-extraction') return reviewSepsisExtraction({ pack: ctx.pack!, baseUrl: ctx.baseUrl, trace: ctx.trace, constrain: Boolean(ctx.options.constrain), input: seededInput(shared.input, front), provider: shared.provider, activity: ctx.activity })
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

  // Reached only by a task this profile grades but cannot run over one document — the same
  // fact the topology publishes as `available: false`, so a route is never drawn as runnable
  // and then refused on arrival.
  throw new ProfileError(
    `--task '${task}' is a graded task but not a reviewable one: ` +
      'its input is a whole record assembled from many notes, not one document — ' +
      'run `eval --task summary` instead',
  )
}

/**
 * A prose document with the measured vitals appended, or the input untouched.
 *
 * A CASE input is resolved to its text first, because appending to a case NAME is nonsense and
 * the alternative — leaving named cases unseeded — would make the eval corpus and a supplied
 * note take measurably different paths through the same contract.
 */
const seededInput = (input: ReviewContext['input'], front?: FrontDoor): ReviewContext['input'] => {
  if (!front?.measured) return input
  if (input.kind === 'text') {
    return { kind: 'text', text: seedWithMeasured(input.text, front.measured), label: input.label }
  }
  return input
}

const executeClinicalRoute = async (
  ctx: ReviewContext,
  shared: { pack: Pack; baseUrl?: string; trace: ReviewContext['trace']; constrain: boolean; input: ReviewContext['input']; calculate: boolean; provider?: Provider; activity?: Activity },
  tasks: Task[],
  front?: FrontDoor,
): Promise<ReviewResult> => {
  if (tasks.length === 1) {
    const only = await executeClinicalTask(ctx, shared, tasks[0]!, front)
    return front && !front.result.ok ? { ...only, text: `${front.result.text}\n${only.text}` } : only
  }

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
    const result = await executeClinicalTask(ctx, feed ? { ...shared, input: feed } : shared, task, front)
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

  // A front-door reading that failed is not in `results` — `planWith` left it out so it cannot
  // fail the run — but it is still the first thing that happened, and a report that omitted it
  // would describe a route decided on evidence the reader never sees.
  const preamble = front && !front.result.ok ? [front.result.text] : []

  return {
    text: [...preamble, ...results.map(({ result }) => result.text)].join('\n'),
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
  let front: FrontDoor | undefined
  if (ctx.options.task === undefined || ctx.options.task === 'default') {
    const text = resolveInputText(ctx)
    front = await runFrontDoor(ctx, shared, text)
    const route = routeClinicalShape(text, loadSettings(ctx.pack!).defaultTask, evidenceOf(front))
    ctx.activity?.emit({
      kind: 'stage',
      name: ROUTE_STAGE,
      operation: 'decision',
      status: 'completed',
      detail: { shape: route.shape, confidence: route.confidence, task: route.task, tasks: planWith(front, route.tasks), reason: route.reason },
    })
    ctx.trace.write({
      event: 'route',
      kind: 'clinical',
      shape: route.shape,
      task: route.task,
      tasks: planWith(front, route.tasks),
      confidence: route.confidence,
      reason: route.reason,
    })
    tasks = planWith(front, route.tasks)
  } else {
    tasks = [reviewTask(ctx.options.task)]
  }

  return executeClinicalRoute(ctx, shared, tasks, front)
}

/** What the router is told, or nothing when the front door did not run. */
const evidenceOf = (front?: FrontDoor) =>
  front ? { measured: front.measured, thresholds: front.thresholds } : undefined

/**
 * The plan, with the pass the front door already made at the head of it.
 *
 * `vital-signs` goes in the plan whether or not a rule selected it, because it RAN: a plan that
 * omitted it would be a report of four passes for a run that made five, and the reading a
 * clinician is looking at would appear in the output under no task at all.
 *
 * A FAILED reading is the exception, and it is the same principle read the other way. The plan
 * is what the run is judged on — every task in it has to succeed for the result to be `ok` —
 * and a front-door pass that came back empty must not condemn a shock classification that went
 * on to work perfectly well without it. Its output is still reported; see `executeClinicalRoute`.
 */
const planWith = (front: FrontDoor | undefined, tasks: Task[]): Task[] =>
  front?.result.ok ? [...new Set<Task>(['vital-signs', ...tasks])] : tasks

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
  let front: FrontDoor | undefined
  if (ctx.options.task !== undefined && ctx.options.task !== 'default') {
    tasks = [reviewTask(ctx.options.task)]
    text = resolveInputText(ctx)
  } else {
    // Resolve or resume the route.
    let route: ClinicalRouteResult
    if (existsSync(routeFile)) {
      // The front door's reading is part of the checkpoint, not a pass to make again. That is
      // the whole point of the file: a resumed run must take the route the first run took, and
      // a second extraction is a second chance to read the blood pressure differently.
      const cached = JSON.parse(readFileSync(routeFile, 'utf8')) as {
        route: ClinicalRouteResult
        text: string
        front?: FrontDoor
      }
      route = cached.route
      text = cached.text
      front = cached.front
    } else {
      text = resolveInputText(ctx)
      front = await runFrontDoor(ctx, { ...ctx, pack: ctx.pack!, constrain: Boolean(ctx.options.constrain), input: ctx.input, activity: ctx.activity }, text)
      route = routeClinicalShape(text, loadSettings(ctx.pack!).defaultTask, evidenceOf(front))
      ctx.activity?.emit({
        kind: 'stage',
        name: ROUTE_STAGE,
        operation: 'decision',
        status: 'completed',
        detail: { shape: route.shape, confidence: route.confidence, task: route.task, tasks: planWith(front, route.tasks), reason: route.reason },
      })
      ctx.trace.write({
        event: 'route',
        kind: 'clinical',
        shape: route.shape,
        task: route.task,
        tasks: planWith(front, route.tasks),
        confidence: route.confidence,
        reason: route.reason,
      })
      writeFileSync(routeFile, JSON.stringify({ route, text, front }, null, 2))
    }
    tasks = planWith(front, route.tasks ?? [route.task])
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

  const result = await executeClinicalRoute(ctx, shared, tasks, front)
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
