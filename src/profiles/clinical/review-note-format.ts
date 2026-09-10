/**
 * One clinical note in, one structured four-section reading out.
 *
 * Assembled from `formatRequest` exactly as `runNoteFormatEval` assembles it, and parsed by
 * `parseNoteFormat` exactly as that eval parses it. The difference is that there is no
 * answer key: the review path reports what the model read and how the citations stood up,
 * rather than a percentage.
 */
import type { Pack } from '../../core/pack.ts'
import type { ReviewResult } from '../../core/profile.ts'
import type { Trace } from '../../core/trace.ts'
import { serverModel } from '../../core/client.ts'
import { HARNESS_VERSION } from '../../core/version.ts'
import { extract } from '../../modes/extract.ts'
import { loadSettings } from './settings.ts'
import { formatRequest } from './contracts.ts'
import { clinicalStages } from './stages.ts'
import { parseNoteFormat, type NoteFormat } from './extraction.ts'
import { verifyReading, tallyReviewed, type ReviewedItem } from './review-transcript.ts'
import type { Provider } from '../../core/client.ts'
import type { QuoteRule, DerivationRule } from '../../core/verify.ts'
import type { Activity } from '../../core/activity.ts'

export interface NoteFormatReviewOptions {
  pack: Pack
  baseUrl?: string
  trace: Trace
  constrain: boolean
  input: { kind: 'case'; name: string } | { kind: 'text'; text: string; label?: string }
  provider?: Provider
  /** Activity bus, so the review can paint its verification pass as a stage. */
  activity?: Activity
}

export const reviewNoteFormat = async (o: NoteFormatReviewOptions): Promise<ReviewResult> => {
  const req = formatRequest(o.pack, o.constrain)
  const document = o.input.kind === 'case' ? o.pack.document(o.input.name) : o.input.text
  const label = o.input.kind === 'case' ? o.input.name : (o.input.label ?? 'supplied document')

  const served = (await serverModel(o.baseUrl)) ?? '(server did not say)'
  o.trace.write({
    event: 'run',
    kind: 'review',
    task: 'note-format',
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
    label: 'note_format',
    provider: o.provider,
    activity: o.activity,
  })

  const header =
    `\n=== note formatting · ${label} ===\n` +
    `model '${served}' · pack '${o.pack.name}' spec ${o.pack.spec} · ` +
    `${o.constrain ? 'constrained' : 'unconstrained'} · ` +
    `temp ${req.sampling.temperature} · max_tokens ${req.sampling.max_tokens}\n`

  const settings = loadSettings(o.pack)
  const stages = clinicalStages('note-format', o.activity)
  const verify = stages.begin('verify')
  let text: string
  if (outcome.parsed) {
    const items = verifyReading(outcome.parsed, document, settings.quoteVerification, settings.textDerivation)
    verify.complete({ ok: true, ...tallyReviewed(items) })
    text = `${header}\n${renderNoteFormat(items)}`
  } else {
    verify.complete({ ok: false })
    text = `${header}\nno reading: ${outcome.error}`
  }

  o.trace.write({
    event: 'review',
    task: 'note-format',
    document: label,
    ok: Boolean(outcome.parsed),
    error: outcome.error,
    completion: outcome.raw,
  })
  o.trace.write({
    event: 'record',
    harness: HARNESS_VERSION,
    model: served,
    constrained: o.constrain,
    contracts: o.pack.digest(),
  })

  return { text, ok: Boolean(outcome.parsed), raw: outcome.raw, document, label }
}

const renderNoteFormat = (items: ReviewedItem[]): string => {
  const sections = ['presenting_complaint', 'history', 'plan', 'current_medication'] as const
  const lines: string[] = []

  for (const section of sections) {
    const mine = items.filter((i) => i.section === section)
    lines.push(section)
    if (!mine.length) {
      lines.push('  — none')
      continue
    }
    for (const i of mine) {
      const dose = 'dose' in i && i.dose ? `  [dose ${i.dose}]` : ''
      lines.push(`  • ${i.text}${dose}`)
      const q = i.verification.quote.ok
        ? `quoted ${JSON.stringify(i.quote)}`
        : i.verification.quote.drift === 'absent'
          ? `UNVERIFIED — not a fragment of this note: ${JSON.stringify(i.quote)}`
          : `EDITED — in the note, but not as written: ${JSON.stringify(i.quote)}`
      lines.push(`      ${q}`)
    }
  }

  return lines.join('\n')
}
