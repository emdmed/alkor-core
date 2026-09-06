/**
 * The medication pass: the same transcript again, asked for one section.
 *
 * A SECOND CALL PER DICTATION, and it is not a correction. The repair pass exists because a
 * citation failed; this one exists because a section asked for on its own comes back better
 * than the same section decoded beside three others. MEASURED, nine dictations in two
 * languages, same weights and flags: inside the four-section reading the model returned 23/25
 * drugs and 22/25 doses; asked for medication alone, 25/25 and 25/25. The three recoveries are
 * an amlodipine whose dose was corrected mid-dictation, a donepezilo, and an amoxicillin whose
 * dose came back as "to complete the course".
 *
 * DICTATIONS ONLY, and the boundary is the pack's — `[clinical.medicationPass].shapes`, read
 * through `takesMedicationPass`. Over the three two-speaker consultations the same pass emitted
 * six items for three drugs, kept a superseded cross-speaker dose beside the corrected one, and
 * dropped derivation to 5/12. A dialogue is a different input and the dialogue prompt exists
 * because of it; this pass does not have that prompt and must not be pointed at that shape.
 *
 * WHAT IT MAY AND MAY NOT DO. It replaces `current_medication` wholesale, and it does NOT
 * filter what it replaces it with. That is deliberate and it is the same argument the repair
 * pass makes from the other side: dropping the items that fail verification would raise every
 * provenance number by discarding the evidence of the failure, so the section a clinician sees
 * and the section the eval scores stay the same list, failures included. What the pass may do
 * is be ignored — a reply that does not parse leaves the first reading exactly as it was.
 */
import type { Pack } from '../../core/pack.ts'
import type { Trace } from '../../core/trace.ts'
import type { Timings } from '../../core/bench.ts'
import { extract } from '../../modes/extract.ts'
import { hasMedicationContract, medicationRequest, takesMedicationPass } from './contracts.ts'
import { parseMedicationOnly } from './extraction.ts'
import type { MedicationItem, NoteFormat } from './extraction.ts'

export interface MedicationOutcome {
  /** False when the pack has no contract, the shape does not take the pass, or it failed. */
  ran: boolean
  /** Why it did not run, or why its reply was not used. Absent when it ran and was used. */
  why?: string
  /**
   * The section the pass produced, or null when the first reading's own section stands. Null is
   * the answer for every failure path: this pass can improve a reading and can never lose one.
   */
  items: MedicationItem[] | null
  /** What the call cost, in `extract`'s shape, so the caller can price a two-call run. */
  cost: { timings?: Timings; wallMs: number }[]
  attempts: number
  lostMs: number
  /** The model's reply, unaltered, for the trace. Absent when the pass did not reach a server. */
  completion?: string
  error?: string
  /** How many items the first reading had, and how many the pass returned. Both, always. */
  before: number
  after: number
}

const NOCOST = { cost: [], attempts: 0, lostMs: 0 }

export interface MedicationOptions {
  pack: Pack
  document: string
  /** The first pass's reading. Read for `before`, and returned untouched on every failure. */
  reading: NoteFormat
  constrain: boolean
  baseUrl?: string
  trace?: Trace
  cachePrompt?: boolean
}

/**
 * Run the pass, or explain why it did not run.
 *
 * Never throws. A second call that could fail a run would be a new way to lose a reading a
 * clinician could otherwise have checked by hand, which is a bad trade at any accuracy.
 */
export const medicationReading = async (o: MedicationOptions): Promise<MedicationOutcome> => {
  const before = o.reading.current_medication.length
  const no = (why: string): MedicationOutcome => ({ ran: false, why, items: null, ...NOCOST, before, after: before })

  if (!hasMedicationContract(o.pack)) return no('this pack declares no medication contract')
  if (!takesMedicationPass(o.pack, o.document)) {
    // Named as the SHAPE rather than as "skipped", because this is the measured boundary and a
    // reader of a dialogue run should see the reason rather than an absence.
    return no('this transcript is a dialogue, and [clinical.medicationPass] does not name that shape')
  }

  const req = medicationRequest(o.pack, o.constrain, o.document)
  const outcome = await extract({
    systemPrompt: req.prompt,
    // The transcript verbatim, exactly as the first pass sent it: same user message, different
    // system prompt, so llama-server's `cache_prompt` has nothing to re-evaluate but the
    // instructions. A pass that reformatted its input would pay the prefill twice.
    document: o.document,
    parse: parseMedicationOnly,
    schema: req.schema,
    schemaName: req.schemaName,
    maxTokens: req.sampling.max_tokens,
    temperature: req.sampling.temperature,
    timeoutMs: req.sampling.timeout_secs * 1000,
    baseUrl: o.baseUrl,
    cachePrompt: o.cachePrompt,
    label: 'medication',
  })

  const cost = { cost: outcome.cost, attempts: outcome.attempts, lostMs: outcome.lostMs, completion: outcome.raw }
  if (!outcome.parsed) {
    return {
      ran: false,
      why: 'the medication pass did not return a usable reply, so the first reading stands',
      items: null,
      ...cost,
      error: outcome.error,
      before,
      after: before,
    }
  }

  return { ran: true, items: outcome.parsed.current_medication, ...cost, before, after: outcome.parsed.current_medication.length }
}

/**
 * The reading with its medication section replaced, or the reading unchanged.
 *
 * Its own function, and pure, because two callers apply the same result — the eval scores it
 * and `extract` prints it — and a substitution written twice is a substitution that can differ
 * in one of them.
 */
export const applyMedication = (reading: NoteFormat, o: MedicationOutcome): NoteFormat =>
  o.items === null ? reading : { ...reading, current_medication: o.items }
