/**
 * One note in, one structured reading out — the thing the eval spends twelve cases proving
 * works.
 *
 * This is the same single constrained pass `runVitalSignsEval` grades, assembled from the
 * same `vitalRequest`, against the same pack. The only differences are where the document
 * comes from and that nothing here is scored: there is no answer key for a note somebody
 * brought, so the run reports what the model read and how far it can be trusted, rather
 * than a percentage.
 *
 * What it can still say without an answer key is **provenance**, and that is most of the
 * value. The prompt's central rule is evidence-or-null, so every reading carries a quote;
 * checking that quote against the note it claims to come from is the one verification that
 * needs no expectation to compare against, and it is the check no grammar can perform — no
 * JSON Schema keyword says "substring of the prompt", and GBNF has no back-reference to the
 * context. A number attached to a sentence that is not in the note is the failure this
 * catches, and on Qwen3-1.7B it is a failure that happens.
 */
import type { Pack } from '../../core/pack.ts'
import type { ReviewResult } from '../../core/profile.ts'
import type { Trace } from '../../core/trace.ts'
import type { Provider } from '../../core/client.ts'
import { serverModel } from '../../core/client.ts'
import { HARNESS_VERSION } from '../../core/version.ts'
import { extract } from '../../modes/extract.ts'
import { loadSettings } from './settings.ts'
import { loadVitalCases } from './cases.ts'
import { gradedFields, vitalRequest, type GradedField } from './contracts.ts'
import { isBloodPressure, parseVitalSigns, type Reading, type VitalSigns } from './extraction.ts'
import { verifyQuote, type QuoteRule } from '../../core/verify.ts'
import { calculateDerived, renderDerived } from './calculations.ts'

export interface VitalReviewOptions {
  pack: Pack
  baseUrl?: string
  trace: Trace
  constrain: boolean
  /** A named case from the pack, or a document the caller supplied. */
  input: { kind: 'case'; name: string } | { kind: 'text'; text: string; label?: string }
  /** When true, compute derived values (BMI, PaO2/FiO2, categories) from the extracted readings. */
  calculate?: boolean
  /** A custom LLM provider; defaults to the built-in HTTP client. */
  provider?: Provider
}

/** Case names this pack can be asked for by name, in the order the answer key lists them. */
export const vitalDocumentNames = (pack: Pack): string[] =>
  loadVitalCases(pack, gradedFields(pack)).cases.map((c) => c.name)

export const reviewVitalSigns = async (o: VitalReviewOptions): Promise<ReviewResult> => {
  const req = vitalRequest(o.pack, o.constrain)
  const document = o.input.kind === 'case' ? o.pack.document(o.input.name) : o.input.text
  const label = o.input.kind === 'case' ? o.input.name : (o.input.label ?? 'supplied document')

  // Ask the server what it is serving rather than reporting what the pack declares — the
  // two differ the moment --url points somewhere else, and a reading that names the wrong
  // weights is worse than one that names none.
  const served = (await serverModel(o.baseUrl)) ?? '(server did not say)'
  o.trace.write({
    event: 'run',
    kind: 'review',
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
    parse: (raw) => parseVitalSigns(raw, req.fields),
    schema: req.schema,
    schemaName: req.schemaName,
    // The pack's declaration, exactly as the eval sends it. A reading produced under a
    // different sampler from the one that was graded is not the pass the number describes.
    maxTokens: req.sampling.max_tokens,
    temperature: req.sampling.temperature,
    timeoutMs: req.sampling.timeout_secs * 1000,
    baseUrl: o.baseUrl,
    label: 'vital_signs',
    provider: o.provider,
  })

  const header =
    `\n=== vital signs · ${label} ===\n` +
    `model '${served}' · pack '${o.pack.name}' spec ${o.pack.spec} · ` +
    `${o.constrain ? 'constrained' : 'unconstrained'} · ` +
    `temp ${req.sampling.temperature} · max_tokens ${req.sampling.max_tokens}\n`

  const readingText = outcome.parsed
    ? renderReading(req.fields, outcome.parsed, document, loadSettings(o.pack).quoteVerification)
    : `no reading: ${outcome.error}`

  const derivedText =
    outcome.parsed && o.calculate
      ? '\n--- derived calculations ---\n' + renderDerived(calculateDerived(outcome.parsed)).join('\n')
      : ''

  const text = `${header}\n${readingText}${derivedText}`

  o.trace.write({
    event: 'review',
    document: label,
    ok: Boolean(outcome.parsed),
    error: outcome.error,
    completion: outcome.raw,
  })
  // The same record the eval closes with: which bytes this run actually read. A reading
  // produced from a prompt nobody can identify afterwards is not reproducible either.
  o.trace.write({
    event: 'record',
    harness: HARNESS_VERSION,
    model: served,
    constrained: o.constrain,
    contracts: o.pack.digest(),
  })

  return { text, ok: Boolean(outcome.parsed), raw: outcome.raw, document, label }
}

/** How a quote stood up to the note it claims to come from. */
export type Provenance = 'quoted' | 'edited' | 'unverified' | 'none'

/**
 * Exactly the check the scorer runs, under the same pack rule — deliberately not a regex,
 * because a pattern built from the model's own output has to escape every '.', '(', '/' and
 * '°' the quote contains, and one unescaped character turns a failed verification into a
 * passing one.
 *
 * The rule is a parameter rather than a constant here for the reason this whole profile is
 * arranged the way it is: a reading a clinician is shown must be judged by the rule the eval
 * graded, or the number describes something the product does not do.
 */
export const checkQuote = (reading: NonNullable<Reading>, document: string, rule: QuoteRule): Provenance => {
  if (!reading.raw_text) return 'none'
  const v = verifyQuote(reading.raw_text, document, rule)
  return v.ok ? 'quoted' : v.drift === 'absent' ? 'unverified' : 'edited'
}

const describe = (r: NonNullable<Reading>): string =>
  isBloodPressure(r) ? `${r.systolic}/${r.diastolic} ${r.unit ?? ''}`.trim() : `${r.value} ${r.unit ?? ''}`.trim()

/**
 * The reading, in schema order — which is the order the grammar made the model emit it.
 *
 * Every slot gets a line, including the ones that came back empty. A report that listed
 * only what was found would read as a complete account of the note while quietly being a
 * list of the model's successes, and the slot a clinician needs is the one nobody printed.
 */
export const renderReading = (
  fields: GradedField[],
  vitals: VitalSigns,
  document: string,
  rule: QuoteRule,
): string => {
  const lines: string[] = []
  let read = 0
  let quoted = 0
  let unverified = 0

  for (const field of fields) {
    const reading = vitals[field.name] ?? null
    if (reading === null) {
      lines.push(`${field.name.padEnd(20)} ${'—'.padEnd(20)} not in the note`)
      continue
    }
    read++
    const p = checkQuote(reading, document, rule)
    if (p === 'quoted') quoted++
    else unverified++
    const evidence =
      p === 'quoted'
        ? `quoted ${JSON.stringify(reading.raw_text)}`
        : p === 'edited'
          ? // Named apart from a fabrication because it is a different accusation: the model
            // tidied a capital or an accent while claiming to copy. Still not verified — the
            // pack asked for character-for-character — but it is not an invented sentence.
            `EDITED — in the note, but not as written: ${JSON.stringify(reading.raw_text)}`
          : p === 'unverified'
            ? `UNVERIFIED — not a fragment of this note: ${JSON.stringify(reading.raw_text)}`
            : 'NO QUOTE — the contract asks for evidence and none came back'
    lines.push(`${field.name.padEnd(20)} ${describe(reading).padEnd(20)} ${evidence}`)
  }

  lines.push('')
  lines.push(
    `${read} of ${fields.length} slots read · ${quoted} quote${quoted === 1 ? '' : 's'} found in the document` +
      (unverified ? ` · ${unverified} NOT verified — check ${unverified === 1 ? 'it' : 'them'} against the note` : ''),
  )
  return lines.join('\n')
}
