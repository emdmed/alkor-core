/**
 * What a clinical trace line may contain when the corpus is not synthetic.
 *
 * `core/trace.ts` writes the prompt's neighbourhood to disk on purpose: a harness whose claim
 * is that nothing has to be taken on faith cannot report 88/88 and keep no record of what the
 * model said. For the pack in this repository that is safe, because those notes were written
 * for it. For a pack of real records it is a file of patient data, and the trace's own
 * docstring has always said a profile handling such a pack must supply a redactor.
 *
 * This profile did not supply one. The hook defaulted to identity, and `eval.ts` said in a
 * comment that `redact` "is what makes this safe to leave on for a pack whose notes are real"
 * — a claim about a function nobody had written. This file is that function.
 *
 * The switch is the PACK'S, not an environment variable and not a flag: whether a corpus is
 * synthetic is a fact about the corpus, so it belongs beside it, and it travels with the pack
 * to whoever runs it next. A pack that does not say is treated as real. That default is the
 * whole point — the failure mode is not an untidy trace, it is PHI on disk, and a safety
 * check that has to be switched on is one that was off the first time it mattered.
 */
import { createHash } from 'node:crypto'

/** Fields that carry note-derived text and are elided when the corpus is not synthetic. */
const CONTENT_FIELDS = ['completion', 'error'] as const

/**
 * A digest and a length, rather than a removal.
 *
 * Dropping the field would make two runs indistinguishable from each other and from a run
 * that produced nothing. A hash still answers "did these two runs return the same thing",
 * which is most of what a trace is re-read for, and it answers it without holding the text.
 */
const elide = (s: string): string =>
  `[redacted ${s.length} chars, sha256:${createHash('sha256').update(s).digest('hex').slice(0, 16)}]`

/**
 * Elide every field of a trace event that can hold text from a note.
 *
 * The obvious ones are the completion and the parse error — which quotes a 120-character
 * prefix of that completion. The one that is easy to miss is `misses[].detail`, which by
 * design quotes the model's `raw_text` and the item texts, and is therefore the same data in
 * a field nobody thinks of as content.
 */
export const redactClinical = (event: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...event }
  for (const field of CONTENT_FIELDS) {
    if (typeof out[field] === 'string') out[field] = elide(out[field])
  }
  if (Array.isArray(out.misses)) {
    out.misses = out.misses.map((m) =>
      m && typeof m === 'object' && typeof (m as { detail?: unknown }).detail === 'string'
        ? { ...(m as object), detail: elide((m as { detail: string }).detail) }
        : m,
    )
  }
  // NESTED completions, and this is the part that was missing rather than an extra.
  //
  // A second call's reply is written under a key of its own — `repair.completion`, and now
  // `medication.completion` — which is model output from the same document by a different
  // path, and the top-level loop above never saw it. On a pack of real records that was PHI
  // on disk in a file whose whole purpose is to be safe to keep.
  //
  // One level deep, deliberately: every trace event this profile writes puts a pass's reply
  // exactly there, and a general deep walk would be a redactor whose behaviour on a shape
  // nobody has written is anybody's guess. A THIRD pass nesting deeper must extend this and
  // will be caught by the test that reads every event a run writes.
  for (const [key, value] of Object.entries(out)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const nested = value as Record<string, unknown>
    if (!CONTENT_FIELDS.some((f) => typeof nested[f] === 'string')) continue
    const copy: Record<string, unknown> = { ...nested }
    for (const field of CONTENT_FIELDS) {
      if (typeof copy[field] === 'string') copy[field] = elide(copy[field] as string)
    }
    out[key] = copy
  }
  return out
}

/**
 * The hook the profile hands to the trace.
 *
 * Identity when — and only when — the pack states that its corpus is synthetic. Returning the
 * event untouched is a decision the pack made and can be read in its manifest, rather than a
 * default nobody chose.
 */
export const clinicalRedactor = (corpusSynthetic: boolean | undefined) =>
  corpusSynthetic === true ? (e: Record<string, unknown>) => e : redactClinical
