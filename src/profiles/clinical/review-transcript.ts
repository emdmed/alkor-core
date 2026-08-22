/**
 * One dictated transcript in, one verified four-section reading out.
 *
 * The gap this closes is narrow and it was load-bearing: `extract --profile clinical` ran
 * `reviewVitalSigns` and nothing else, so the harness could GRADE the transcript contract
 * over its own twelve cases and could not RUN it over a transcript somebody supplied. A
 * second runtime reading this pack therefore had nothing to be compared against — the eval's
 * output is a percentage, and a percentage cannot tell you whether another implementation
 * assembled the same request and reached the same reading.
 *
 * So this is assembled from `transcriptRequest` exactly as `runTranscriptEval` assembles it,
 * and parsed by `parseNoteFormat` exactly as that eval parses it. Not "the same as far as it
 * matters": the same function, called with the same pack, so a divergence between what is
 * measured and what is produced would have to be a change to shared code rather than a drift
 * between two copies of one contract.
 *
 * What it cannot do without an answer key is score. What it CAN do is the half of the
 * measurement that needs no expectation — the two provenance checks, run per item under the
 * pack's own rules — which is also the half a second runtime has to reproduce exactly. See
 * `report` below: that object is the fixture, and it holds both the model's completion and
 * every verdict computed from it, because a parity test that compared only completions would
 * pass an implementation that verified nothing.
 */
import type { Pack } from '../../core/pack.ts'
import type { ReviewResult } from '../../core/profile.ts'
import type { Trace } from '../../core/trace.ts'
import { serverModel } from '../../core/client.ts'
import { HARNESS_VERSION } from '../../core/version.ts'
import { extract } from '../../modes/extract.ts'
import { DOCUMENT_KIND, loadSettings, loadTranscriptCases, transcriptRequest } from './contracts.ts'
import { parseNoteFormat, type FormatItem, type MedicationItem, type NoteFormat } from './extraction.ts'
import { verifyDerivation, verifyQuote, type DerivationRule, type DerivationVerdict, type QuoteRule } from '../../core/verify.ts'

export interface TranscriptReviewOptions {
  pack: Pack
  baseUrl?: string
  trace: Trace
  constrain: boolean
  input: { kind: 'case'; name: string } | { kind: 'text'; text: string; label?: string }
}

/**
 * Transcripts this pack can be asked for by name.
 *
 * The case names, because for this task the case IS the document — there is no written note
 * behind a dictation and inventing one would defeat the corpus. That is the same identity the
 * eval relies on, so the two cannot disagree about what `--case tr-en-02-self-correction`
 * means.
 */
export const transcriptDocumentNames = (pack: Pack): string[] =>
  loadTranscriptCases(pack).cases.map((c) => c.name)

/** How one item's two provenance checks came out. */
export interface ItemVerification {
  /** Character-for-character containment under the pack's quote rule. */
  quote: { ok: boolean; drift: string }
  /** `text` as a deletion from `quote`. */
  text: { ok: boolean; reason?: string; token?: string }
  /** Medications only, and only where the model gave a dose. */
  dose?: { ok: boolean; reason?: string; token?: string }
}

export interface ReviewedItem {
  section: string
  quote: string
  text: string
  dose?: string | null
  verification: ItemVerification
}

/**
 * The reference reading, as data.
 *
 * This is what `--json` prints and what a second runtime is compared against. It carries the
 * completion AND the verdicts deliberately: two implementations that produce the same bytes
 * and disagree about which quotes verify are not the same runtime, and the difference is
 * invisible in the completion alone — it lives in whitespace collapsing, in accent handling,
 * and in whether the derivation check is a subsequence or a substring. Every one of those is
 * a decision the pack states and an implementation can get wrong while parsing perfectly.
 *
 * `items` is in DECODE order — the order the grammar makes the model emit, which is the
 * order `parseNoteFormat` reads. Not display order: what a clinician should be shown first is
 * a question for an interface, and a fixture that reordered would make a byte comparison
 * depend on somebody's taste.
 */
export interface TranscriptReport {
  task: 'transcript'
  harness: string
  model: string
  constrained: boolean
  pack: { name: string; spec: number }
  schemaName: string
  sampling: unknown
  document: { label: string; chars: number }
  ok: boolean
  error?: string
  /** The model's reply, unaltered. Present even when it did not parse. */
  completion?: string
  /** Null when the reply never parsed — there is nothing to be verified. */
  reading: NoteFormat | null
  items: ReviewedItem[]
  totals: {
    items: number
    quotesVerified: number
    quotesEditedOnly: number
    quotesAbsent: number
    derivationsChecked: number
    derivationsOk: number
  }
}

export const reviewTranscript = async (o: TranscriptReviewOptions): Promise<ReviewResult> => {
  const req = transcriptRequest(o.pack, o.constrain)
  const settings = loadSettings(o.pack)
  const document =
    o.input.kind === 'case' ? o.pack.document(o.input.name, DOCUMENT_KIND.transcript) : o.input.text
  const label = o.input.kind === 'case' ? o.input.name : (o.input.label ?? 'supplied transcript')

  // Asked of the server rather than read from the pack, for the reason `reviewVitalSigns`
  // asks: the two differ the moment --url points elsewhere, and a reading that names the
  // wrong weights is worse than one that names none.
  const served = (await serverModel(o.baseUrl)) ?? '(server did not say)'
  o.trace.write({
    event: 'run',
    kind: 'review',
    task: 'transcript',
    harness: HARNESS_VERSION,
    model: served,
    baseUrl: o.baseUrl,
    constrained: o.constrain,
    sampling: req.sampling,
    pack: { name: o.pack.name, spec: o.pack.spec },
    document: label,
  })

  const outcome = await extract({
    systemPrompt: req.prompt,
    document,
    parse: parseNoteFormat,
    schema: req.schema,
    schemaName: req.schemaName,
    maxTokens: req.sampling.max_tokens,
    temperature: req.sampling.temperature,
    timeoutMs: req.sampling.timeout_secs * 1000,
    baseUrl: o.baseUrl,
    // The pack's own label for this task, not the note-format one it shares a schema with:
    // a server log and a pinned request body are read by this string, and two tasks that
    // produce different numbers should not be indistinguishable in the record of what ran.
    label: 'transcript',
  })

  const items = outcome.parsed
    ? verifyReading(outcome.parsed, document, settings.quoteVerification, settings.textDerivation)
    : []

  const report: TranscriptReport = {
    task: 'transcript',
    harness: HARNESS_VERSION,
    model: served,
    constrained: o.constrain,
    pack: { name: o.pack.name, spec: o.pack.spec },
    schemaName: req.schemaName,
    sampling: req.sampling,
    document: { label, chars: document.length },
    ok: Boolean(outcome.parsed),
    error: outcome.error,
    completion: outcome.raw,
    reading: outcome.parsed ?? null,
    items,
    totals: tallyReviewed(items),
  }

  const header =
    `\n=== dictated transcript · ${label} ===\n` +
    `model '${served}' · pack '${o.pack.name}' spec ${o.pack.spec} · ` +
    `${o.constrain ? 'constrained' : 'unconstrained'} · ` +
    `temp ${req.sampling.temperature} · max_tokens ${req.sampling.max_tokens}\n`

  const text = outcome.parsed
    ? `${header}\n${renderTranscriptReading(report)}`
    : `${header}\nno reading: ${outcome.error}`

  o.trace.write({
    event: 'review',
    task: 'transcript',
    document: label,
    ok: Boolean(outcome.parsed),
    error: outcome.error,
    totals: report.totals,
    completion: outcome.raw,
  })
  o.trace.write({
    event: 'record',
    harness: HARNESS_VERSION,
    model: served,
    constrained: o.constrain,
    contracts: o.pack.digest(),
  })

  return { text, ok: Boolean(outcome.parsed), raw: outcome.raw, document, label, report }
}

/**
 * Both provenance checks over every item, in decode order.
 *
 * Deliberately the same two calls `scoreFormatCase` makes, in the same order, with the same
 * independence between them: derivation is checked against the quote the model GAVE even when
 * that quote failed verification. Skipping it would report a derivation rate over only the
 * well-behaved items, and — worse here than in the eval — would hide the compound failure,
 * where a model invents a span and then derives something else from it.
 */
export const verifyReading = (
  reading: NoteFormat,
  document: string,
  quoteRule: QuoteRule,
  derivationRule: DerivationRule,
): ReviewedItem[] => {
  const out: ReviewedItem[] = []

  const check = (section: string, item: FormatItem | MedicationItem): void => {
    const q = verifyQuote(item.quote, document, quoteRule)
    const dose = 'dose' in item ? item.dose : undefined
    const verification: ItemVerification = {
      quote: { ok: q.ok, drift: q.drift },
      text: asVerdict(verifyDerivation(item.text, item.quote, derivationRule)),
    }
    if (dose !== undefined && dose !== null) {
      verification.dose = asVerdict(verifyDerivation(dose, item.quote, derivationRule))
    }
    out.push({
      section,
      quote: item.quote,
      text: item.text,
      ...(dose !== undefined ? { dose } : {}),
      verification,
    })
  }

  if (reading.presenting_complaint) check('presenting_complaint', reading.presenting_complaint)
  for (const i of reading.history) check('history', i)
  for (const i of reading.plan) check('plan', i)
  for (const m of reading.current_medication) check('current_medication', m)
  return out
}

const asVerdict = (v: DerivationVerdict): { ok: boolean; reason?: string; token?: string } =>
  v.ok ? { ok: true } : { ok: false, reason: v.reason, token: v.token }

export const tallyReviewed = (items: ReviewedItem[]): TranscriptReport['totals'] => {
  const t = {
    items: items.length,
    quotesVerified: 0,
    quotesEditedOnly: 0,
    quotesAbsent: 0,
    derivationsChecked: 0,
    derivationsOk: 0,
  }
  for (const i of items) {
    if (i.verification.quote.ok) t.quotesVerified++
    else if (i.verification.quote.drift === 'absent') t.quotesAbsent++
    // In the note under some relaxation of case or accents: the model tidied a span rather
    // than inventing one. A different accusation, counted apart, exactly as the eval counts it.
    else t.quotesEditedOnly++
    for (const d of [i.verification.text, i.verification.dose]) {
      if (!d) continue
      t.derivationsChecked++
      if (d.ok) t.derivationsOk++
    }
  }
  return t
}

/**
 * The reading, for a person.
 *
 * Sections in DECODE order here too, matching the fixture, and every section printed even
 * when empty — the same rule `renderReading` follows for vital signs, for the same reason. A
 * report that listed only the sections with content would read as a complete account of the
 * consultation while being a list of the model's successes, and the empty section is exactly
 * the one worth seeing: this corpus has three cases whose correct answer IS an empty section.
 */
export const renderTranscriptReading = (report: TranscriptReport): string => {
  const lines: string[] = []
  const sections = ['presenting_complaint', 'history', 'plan', 'current_medication'] as const

  for (const section of sections) {
    const mine = report.items.filter((i) => i.section === section)
    lines.push(`${section}`)
    if (!mine.length) {
      lines.push('  — none')
      continue
    }
    for (const i of mine) {
      const dose = i.dose ? `  [dose ${i.dose}]` : i.dose === null ? '  [no dose]' : ''
      lines.push(`  • ${i.text}${dose}`)
      lines.push(`      ${verdictLine(i)}`)
    }
  }

  const t = report.totals
  lines.push('')
  lines.push(
    `${t.items} item${t.items === 1 ? '' : 's'} · ` +
      `${t.quotesVerified}/${t.items} quote${t.items === 1 ? '' : 's'} found in the transcript · ` +
      `${t.derivationsOk}/${t.derivationsChecked} derived by deletion only` +
      (t.quotesAbsent ? ` · ${t.quotesAbsent} NOT in the transcript at all` : '') +
      (t.quotesEditedOnly ? ` · ${t.quotesEditedOnly} edited while claiming to copy` : ''),
  )
  if (t.quotesAbsent || t.quotesEditedOnly || t.derivationsOk < t.derivationsChecked) {
    lines.push('check the flagged items against the transcript before any of this is used.')
  }
  return lines.join('\n')
}

const verdictLine = (i: ReviewedItem): string => {
  const parts: string[] = []
  parts.push(
    i.verification.quote.ok
      ? `quoted ${JSON.stringify(clip(i.quote))}`
      : i.verification.quote.drift === 'absent'
        ? `UNVERIFIED — not a fragment of this transcript: ${JSON.stringify(clip(i.quote))}`
        : `EDITED — in the transcript, but not as spoken (${i.verification.quote.drift}): ${JSON.stringify(clip(i.quote))}`,
  )
  for (const [what, d] of [
    ['text', i.verification.text],
    ['dose', i.verification.dose],
  ] as const) {
    if (d && !d.ok) {
      parts.push(`NOT DERIVED — ${what} ${d.reason === 'introduced' ? 'introduces' : 'reorders'} '${d.token}'`)
    }
  }
  return parts.join('  ·  ')
}

const clip = (s: string): string => (s.length > 90 ? `${s.slice(0, 87)}...` : s)
