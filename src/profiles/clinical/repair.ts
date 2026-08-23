/**
 * The repair pass: a reading's failed citations, handed back to the model with the transcript.
 *
 * `src/core/profile.ts` says an extraction stays one-shot, because a follow-up turn that "took
 * the correction into account" would no longer be the thing the eval measures. That objection
 * is correct and this module is built to satisfy it rather than to argue with it. Three
 * properties do the work, and none of them is a promise about the model:
 *
 * 1. NOTHING HERE IS BELIEVED. Every repair is re-run through `verifyQuote` and
 *    `verifyDerivation` — the same functions, the same pack rule, no relaxation — and a repair
 *    that does not verify is DISCARDED. The item then stands exactly as the first pass left
 *    it, with its original failed verdict. The model proposes; the verifier disposes.
 * 2. IT CANNOT CHANGE THE READING. The output is a list of repairs keyed to item positions,
 *    not a reading. Sections, item count and item order come from the first pass and are never
 *    read back from the reply, so this pass cannot add a drug, drop a diagnosis, or move a
 *    finding between sections — the things that would make item recall a measurement of two
 *    passes reported as one.
 * 3. IT IS RECORDED. A repaired item keeps its `before`, so a report that shows a verified
 *    quote can always be asked what it looked like when it failed. A pass that improved the
 *    numbers and left no trace of what it changed would be indistinguishable from a pass that
 *    laundered them.
 *
 * What is genuinely bought: an item whose only defect was a reworded citation becomes an item
 * a clinician can see anchored in the transcript. What is not bought, and cannot be: a
 * hallucinated item becoming a real one. `found: false` is the reply the prompt asks for
 * there, and an item nobody dictated stays flagged.
 */
import type { Pack } from '../../core/pack.ts'
import type { Trace } from '../../core/trace.ts'
import type { Timings } from '../../core/bench.ts'
import { extract } from '../../modes/extract.ts'
import { hasRepairContract, repairRequest } from './contracts.ts'
import type { ItemVerification, ReviewedItem } from './review-transcript.ts'
import { verifyDerivation, verifyQuote, words, type DerivationRule, type QuoteRule } from '../../core/verify.ts'

/** One proposal, as the grammar shapes it. Positional identity: `item` indexes the list sent. */
export interface Repair {
  item: number
  found: boolean
  quote: string
  text: string
  dose: string | null
}

export interface RepairOutcome {
  /** False when the pack declares no repair contract, or no item failed. `why` says which. */
  ran: boolean
  /**
   * What the second call cost, in the shape `extract` reports it.
   *
   * Reported so the caller can add it to the run's bench. A pass that announced itself as "a
   * SECOND call per transcript" beside a token count that only covered the first would be
   * describing half its own cost — and a repair that doubles latency is a repair a reader is
   * entitled to price before deciding it was worth two per cent of derivation.
   */
  cost: { timings?: Timings; wallMs: number }[]
  attempts: number
  lostMs: number
  why?: string
  /** The reading after repair: same length, same order, same sections as the one passed in. */
  items: ReviewedItem[]
  /** The model's reply, unaltered, for the trace. Absent when the pass did not run. */
  completion?: string
  error?: string
  tally: RepairTally
}

/**
 * What the pass did, in the four outcomes that are worth telling apart.
 *
 * `refused` is the number this design lives or dies by, and it is reported rather than folded
 * into `failed`: a repair the model proposed and the verifier threw out is the mechanism
 * working, and a run where it is large is a run where the second pass was mostly wrong and
 * cost nothing. A pass that reported only its successes would be unfalsifiable.
 */
export interface RepairTally {
  /** Items sent for repair — the ones whose quote or derivation failed. */
  offered: number
  /** Repairs the verifier accepted, item now better than it was. */
  accepted: number
  /** Repairs proposed and thrown out because they did not verify, or drifted off-subject. */
  refused: number
  /** Items the model declined to cite: `found: false`. Not a failure — the honest answer. */
  confessed: number
  /** Items the reply said nothing usable about at all. */
  unanswered: number
}

const EMPTY: RepairTally = { offered: 0, accepted: 0, refused: 0, confessed: 0, unanswered: 0 }
/** What a pass that never reached the server cost: nothing, stated rather than left undefined. */
const NOCOST = { cost: [], attempts: 0, lostMs: 0 }

/** Whether an item's provenance failed in any way this pass could address. */
export const needsRepair = (i: ReviewedItem): boolean =>
  !i.verification.quote.ok || !i.verification.text.ok || (i.verification.dose ? !i.verification.dose.ok : false)

export interface RepairOptions {
  pack: Pack
  document: string
  items: ReviewedItem[]
  quoteRule: QuoteRule
  derivationRule: DerivationRule
  constrain: boolean
  baseUrl?: string
  trace?: Trace
  cachePrompt?: boolean
}

/**
 * Run the pass, or explain why it did not run.
 *
 * Never throws on a bad reply. A repair pass that could fail a run would be a second way for
 * the first pass's result to be lost, which trades a reading a clinician could have checked by
 * hand for nothing at all. Every failure path returns the items unchanged and says so in `why`.
 */
export const repairReading = async (o: RepairOptions): Promise<RepairOutcome> => {
  if (!hasRepairContract(o.pack)) {
    return { ran: false, why: 'this pack declares no repair contract', items: o.items, tally: EMPTY, ...NOCOST }
  }
  const failed = o.items.map((item, index) => ({ item, index })).filter((f) => needsRepair(f.item))
  if (!failed.length) {
    return { ran: false, why: 'every item verified', items: o.items, tally: EMPTY, ...NOCOST }
  }

  const req = repairRequest(o.pack, o.constrain, o.document)
  const outcome = await extract({
    systemPrompt: req.prompt,
    document: repairBriefing(o.document, failed.map((f) => f.item)),
    parse: parseRepairs,
    schema: req.schema,
    schemaName: req.schemaName,
    maxTokens: req.sampling.max_tokens,
    temperature: req.sampling.temperature,
    timeoutMs: req.sampling.timeout_secs * 1000,
    baseUrl: o.baseUrl,
    cachePrompt: o.cachePrompt,
    label: 'transcript-repair',
  })

  const tally: RepairTally = { ...EMPTY, offered: failed.length }
  if (!outcome.parsed) {
    o.trace?.write({ event: 'repair', ok: false, error: outcome.error, offered: failed.length })
    return {
      ran: true,
      why: `the repair reply did not parse: ${outcome.error}`,
      items: o.items,
      completion: outcome.raw,
      error: outcome.error,
      tally: { ...tally, unanswered: failed.length },
      cost: outcome.cost,
      attempts: outcome.attempts,
      lostMs: outcome.lostMs,
    }
  }

  // Positional identity, checked rather than trusted. An index outside the list is a reply
  // about an item nobody asked about; an index twice is two proposals for one item and no way
  // to know which was meant. Both are dropped, and the item they name is left alone.
  const seen = new Set<number>()
  const byIndex = new Map<number, Repair>()
  for (const r of outcome.parsed.repairs) {
    if (r.item < 1 || r.item > failed.length || seen.has(r.item)) continue
    seen.add(r.item)
    byIndex.set(r.item, r)
  }

  const items = o.items.slice()
  failed.forEach((f, n) => {
    const proposal = byIndex.get(n + 1)
    if (!proposal) {
      tally.unanswered++
      return
    }
    if (!proposal.found) {
      tally.confessed++
      return
    }
    const repaired = applyRepair(f.item, proposal, o.document, o.quoteRule, o.derivationRule)
    if (repaired) {
      items[f.index] = repaired
      tally.accepted++
    } else {
      tally.refused++
    }
  })

  o.trace?.write({ event: 'repair', ok: true, tally, completion: outcome.raw })
  return {
    ran: true,
    items,
    completion: outcome.raw,
    tally,
    cost: outcome.cost,
    attempts: outcome.attempts,
    lostMs: outcome.lostMs,
  }
}

/**
 * Apply one proposal, or refuse it.
 *
 * Returns the repaired item only when the verifier says it is STRICTLY BETTER: every check
 * that passed before still passes, and at least one that failed now passes. Both halves matter.
 * Without the first, a repair could fix a quote and break a dose and be counted a success;
 * without the second, an unchanged item would be recorded as "repaired" and the tally would
 * describe work that did not happen.
 */
export const applyRepair = (
  item: ReviewedItem,
  r: Repair,
  document: string,
  quoteRule: QuoteRule,
  derivationRule: DerivationRule,
): ReviewedItem | null => {
  // A medication's `dose` is the model's to repair; anything else has no dose, and a proposal
  // that supplies one is answering a question that was not asked. Ignored rather than refused
  // — the schema requires the field, so a null-shaped item filling it in is a grammar artefact
  // and not a mistake worth throwing a repair away over.
  const hasDose = 'dose' in item
  const dose = hasDose ? r.dose : undefined
  if (!aboutTheSameThing(item.text, r.text)) return null

  const q = verifyQuote(r.quote, document, quoteRule)
  const after: ItemVerification = {
    quote: { ok: q.ok, drift: q.drift },
    text: asVerdict(verifyDerivation(r.text, r.quote, derivationRule)),
  }
  if (dose !== undefined && dose !== null) {
    after.dose = asVerdict(verifyDerivation(dose, r.quote, derivationRule))
  }
  if (!strictlyBetter(item.verification, after)) return null

  return {
    section: item.section,
    quote: r.quote,
    text: r.text,
    ...(hasDose ? { dose } : {}),
    verification: after,
    repaired: true,
    // The state this item was in when the first pass produced it, carried rather than
    // overwritten. A verified quote that cannot say what it replaced is a claim with its
    // working thrown away.
    before: { quote: item.quote, text: item.text, ...(hasDose ? { dose: item.dose } : {}), verification: item.verification },
  }
}

/**
 * Every check that passed still passes, and at least one that failed now does.
 *
 * `dose` is compared as a third check only where both readings have one. A repair that
 * dropped a dose to null would otherwise look like an improvement — one fewer failing check —
 * when what happened is that a fact left the record.
 */
const strictlyBetter = (before: ItemVerification, after: ItemVerification): boolean => {
  const pairs: [boolean, boolean][] = [
    [before.quote.ok, after.quote.ok],
    [before.text.ok, after.text.ok],
  ]
  if (before.dose || after.dose) pairs.push([before.dose?.ok ?? true, after.dose?.ok ?? false])
  if (pairs.some(([b, a]) => b && !a)) return false
  return pairs.some(([b, a]) => !b && a)
}

/**
 * A cheap guard against a repair that silently becomes a different item.
 *
 * The verifier cannot catch this on its own: "amlodipina" and "enalapril" are both real spans
 * of a transcript that names both, so a proposal swapping one for the other verifies perfectly
 * and changes what the record says a patient takes. Requiring one shared word is a weak test
 * and a cheap one, and it is aimed at exactly that: a repair that keeps the subject keeps a
 * word ("revisión en dos meses" -> "cito de vuelta en dos meses" shares three), and a repair
 * that swaps the drug shares none.
 *
 * Deliberately conservative. A legitimate repair with no word in common with what it replaces
 * is refused, and the item stays flagged for a human — which is where it already was.
 */
const aboutTheSameThing = (before: string, after: string): boolean => {
  const b = new Set(words(before))
  return words(after).some((w) => b.has(w))
}

const asVerdict = (v: ReturnType<typeof verifyDerivation>): { ok: boolean; reason?: string; token?: string } =>
  v.ok ? { ok: true } : { ok: false, reason: v.reason, token: v.token }

/**
 * The user message: the transcript, then the failed items, numbered.
 *
 * The whole transcript again rather than the neighbourhood of each failed quote. The pass has
 * to be able to say "this span is nowhere in the recording", and a window around where the
 * model already looked cannot support that answer — it would make `found: false` mean "not
 * near where you last guessed", which is not the question and would turn every distant but
 * real span into a confession.
 *
 * The failure is NAMED per item, not left to be re-derived. The verifier already knows whether
 * the quote is absent or the text introduced a word, and those two faults have different
 * repairs — widen the span, or delete the invented word. A prompt that made the model diagnose
 * what a deterministic check had already diagnosed would be spending the model's attention on
 * the one part of this that is not in doubt.
 */
export const repairBriefing = (document: string, failed: ReviewedItem[]): string => {
  const lines: string[] = ['TRANSCRIPT', '---', document.trim(), '---', '']
  lines.push(`FAILED ITEMS (${failed.length})`, '')
  failed.forEach((i, n) => {
    lines.push(`${n + 1}. section: ${i.section}`)
    lines.push(`   quote: ${JSON.stringify(i.quote)}`)
    lines.push(`   text: ${JSON.stringify(i.text)}`)
    if (i.dose !== undefined) lines.push(`   dose: ${i.dose === null ? 'null' : JSON.stringify(i.dose)}`)
    for (const p of problems(i)) lines.push(`   PROBLEM: ${p}`)
    lines.push('')
  })
  return lines.join('\n')
}

const problems = (i: ReviewedItem): string[] => {
  const out: string[] = []
  const v = i.verification
  if (!v.quote.ok) {
    out.push(
      v.quote.drift === 'absent'
        ? 'NOT IN THE TRANSCRIPT — this quote cannot be found in the transcript above.'
        : `NOT IN THE TRANSCRIPT — this quote is there, but not as written (${v.quote.drift}). Copy it as the transcript spells it.`,
    )
  }
  for (const [what, d] of [
    ['TEXT', v.text],
    ['DOSE', v.dose],
  ] as const) {
    if (d && !d.ok) {
      out.push(
        `${what} NOT DERIVED — ${what.toLowerCase()} ${d.reason === 'introduced' ? 'uses' : 'reorders'} '${d.token}', ` +
          'which its quote does not contain. Either widen the quote until that word is inside it, or delete the word.',
      )
    }
  }
  return out
}

/**
 * Parse the reply into repairs, or throw with a diagnosis.
 *
 * Shape only. Whether a repair is any GOOD is not a parsing question and is not asked here —
 * it is asked by the verifier, which is the only thing in this module qualified to answer it.
 */
export const parseRepairs = (raw: string): { repairs: Repair[] } => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`repair reply is not JSON: ${(e as Error).message}`)
  }
  const obj = parsed as { repairs?: unknown }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.repairs)) {
    throw new Error("repair reply has no 'repairs' array")
  }
  const repairs: Repair[] = []
  for (const [n, entry] of obj.repairs.entries()) {
    const r = entry as Partial<Repair>
    if (!r || typeof r !== 'object') throw new Error(`repair ${n} is not an object`)
    if (typeof r.item !== 'number' || !Number.isInteger(r.item)) throw new Error(`repair ${n} has no integer 'item'`)
    if (typeof r.found !== 'boolean') throw new Error(`repair ${n} has no boolean 'found'`)
    // quote and text are only required to be strings when the model claims to have found one:
    // a `found: false` entry has nothing to say and the grammar still makes it say something.
    if (r.found && (typeof r.quote !== 'string' || typeof r.text !== 'string')) {
      throw new Error(`repair ${n} claims found but has no string quote/text`)
    }
    repairs.push({
      item: r.item,
      found: r.found,
      quote: typeof r.quote === 'string' ? r.quote : '',
      text: typeof r.text === 'string' ? r.text : '',
      dose: typeof r.dose === 'string' ? r.dose : null,
    })
  }
  return { repairs }
}
