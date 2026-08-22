/**
 * Provenance: is this span actually in the document, and is this text derived from it?
 *
 * A schema can guarantee the SHAPE of a quote and the truth of it not at all. No JSON
 * Schema keyword expresses "substring of the prompt", and GBNF has no back-reference to the
 * context, so a grammar will happily emit a beautifully-formed citation of a sentence that
 * was never written. That gap is the reason this file exists, and it is why the check runs
 * after decoding rather than during it.
 *
 * This is core rather than a profile's business because nothing here is medical. It is the
 * generic act of asking whether a model's claim about its input survives comparison with
 * that input — the same question a legal-extraction pack or a support-ticket pack asks.
 * What a fabricated quote MEANS is the profile's judgement; whether the string is there is
 * arithmetic.
 *
 * **Neither check is a regex, deliberately.** A pattern built from the model's own output
 * has to escape every `.`, `(`, `/` and `°` the quote contains, and one unescaped character
 * turns a failed verification into a passing one — the single failure mode a verifier must
 * not have. Literal containment after normalisation is the whole check, and it cannot be
 * fooled by punctuation it did not expect.
 */

/** How a quote is compared with the document it claims to come from. */
export interface QuoteRule {
  /**
   * Collapse every run of whitespace to a single space on BOTH sides before comparing.
   * Clinical notes are hard-wrapped, so a quote spanning a line break carries a newline
   * where the model wrote a space; without this the axis measures the wrapping.
   */
  collapseWhitespace: boolean
  /**
   * Compare case STRICTLY. "Copy it character by character" is the instruction, and a model
   * that lowercases a sentence-initial capital is already editing rather than copying. The
   * verdict still names the drift, so a run that fails only on capitalisation stays
   * distinguishable from one that invented a sentence.
   */
  caseSensitive: boolean
  /**
   * Compare accents STRICTLY — `presión` is not `presion`.
   *
   * Stated rather than assumed because the two tasks that verify quotes in the reference pack
   * silently disagreed about it: note formatting compared accents strictly and vital signs
   * stripped them, so one corpus, one pack and one declared rule produced two different
   * provenance measurements printed side by side. Whichever a pack chooses, both of its
   * tasks now do the same thing, and an accent-only failure is reported apart from a
   * fabrication for exactly the reason a case-only one is.
   */
  accentSensitive: boolean
}

/**
 * How a quote differs from the document, when it is not there character for character.
 *
 * `absent` is the accusation that matters: no relaxation of case or accents finds this span,
 * so the model wrote a sentence the note does not contain. The others are edits — the model
 * tidied while claiming to copy — and whether an edit is tolerated is the rule's decision,
 * not this function's.
 */
export type QuoteDrift = 'none' | 'case' | 'accent' | 'case+accent' | 'absent'

export interface QuoteVerdict {
  ok: boolean
  drift: QuoteDrift
}

/** Collapse runs of whitespace to a single space, so a line-wrapped quote still matches. */
export const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** NFD, then drop the combining marks: `presión` and `presion` compare equal. */
const stripAccents = (s: string): string => s.normalize('NFD').replace(/\p{Mn}/gu, '')

/**
 * Verify one quote against the document it claims to come from.
 *
 * The two failure modes are reported apart because they are different accusations. A quote
 * that differs only in a capital is a model being tidy; a quote absent under any casing is
 * a model inventing a sentence and attaching evidence to it. Collapsing both into "failed"
 * would hide which one a prompt change fixed.
 *
 * An empty quote is a failure rather than a vacuous pass: `''` is a substring of every
 * document, so the permissive reading would make an empty citation the safest thing a model
 * could emit.
 */
export const verifyQuote = (quote: string, document: string, rule: QuoteRule): QuoteVerdict => {
  const prepare = (s: string) => (rule.collapseWhitespace ? collapse(s) : s)
  const q = prepare(quote)
  const doc = prepare(document)
  if (!q) return { ok: false, drift: 'absent' }

  // Character for character. Everything below this line is the diagnosis of a quote that is
  // NOT that, and each relaxation is applied on its own so the verdict can name which one
  // the model needed — "a dropped accent" and "a lowercased capital" are different habits
  // with different fixes.
  if (doc.includes(q)) return { ok: true, drift: 'none' }

  const found = (a: (s: string) => string): boolean => a(doc).includes(a(q))
  const drift: QuoteDrift = found((s) => s.toLowerCase())
    ? 'case'
    : found(stripAccents)
      ? 'accent'
      : found((s) => stripAccents(s).toLowerCase())
        ? 'case+accent'
        : 'absent'
  if (drift === 'absent') return { ok: false, drift }

  // Tolerated only if the rule relaxed every dimension the quote actually drifted in. A pack
  // that permits a lowercased capital has not thereby permitted a dropped accent.
  const permitted =
    (drift === 'case' && !rule.caseSensitive) ||
    (drift === 'accent' && !rule.accentSensitive) ||
    (drift === 'case+accent' && !rule.caseSensitive && !rule.accentSensitive)
  return { ok: permitted, drift }
}

/** How a derived text may differ from the span it was derived from. */
export interface DerivationRule {
  /**
   * DELETION ONLY: the derived text is the quote with the sentence machinery removed, so
   * every word in it must already be in the quote, in the same order. Lowercasing a leading
   * capital is allowed; introducing a word is not.
   */
  deletionOnly: boolean
}

export type DerivationVerdict =
  | { ok: true }
  /** A word in the text that is not in the quote — the token is reported, not just the fact. */
  | { ok: false; reason: 'introduced'; token: string }
  /** Every word is present but the order is not the quote's: a reordering, not a deletion. */
  | { ok: false; reason: 'reordered'; token: string }

/**
 * Words, for the purpose of comparing an edit with its source.
 *
 * Punctuation is stripped rather than treated as a word: "ceftriaxona," and "ceftriaxona"
 * are the same token, and a rule that called them different would fail every item whose
 * quote ends in a comma. Accents are NOT stripped — in a clinical text they distinguish
 * words, and a verifier that ignored them would accept an edit this check exists to catch.
 */
const words = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}%.,/°-]+/u)
    .map((w) => w.replace(/^[.,-]+|[.,-]+$/g, ''))
    .filter(Boolean)

/**
 * Check that a derived text is a subsequence of its quote, word by word.
 *
 * This is the half of provenance that quote verification alone does not give you, and it
 * was paid for on a sibling pack by a measured run: the model emitted a quote reading
 * "antibiotic cover with ceftriaxona 2 g every 24 hours" — which verifies, character for
 * character — beside the item text "ceptriaxona 2 g every 24 hours". Provenance was perfect
 * and the line a clinician reads still named a drug that does not exist. Under this rule the
 * corrupted token is not in the quote and the item fails mechanically, without anyone having
 * to notice a transposed letter.
 *
 * The cost is real and is worth paying: the model may not add a connective to make a
 * fragment read on its own. An item that reads slightly rougher is a clinician's problem for
 * one second; a drug name that drifted is a problem for as long as the record exists.
 *
 * A SUBSEQUENCE rather than a substring: the point of the field is that machinery in the
 * middle of a sentence can be dropped. Order is still required, so a reordering is caught —
 * "24 hours every" says something the note did not.
 */
export const verifyDerivation = (text: string, quote: string, rule: DerivationRule): DerivationVerdict => {
  if (!rule.deletionOnly) return { ok: true }
  const source = words(quote)
  let at = 0
  for (const w of words(text)) {
    const found = source.indexOf(w, at)
    if (found === -1) {
      // Present, but not after the words already consumed: the edit reordered the quote
      // rather than shortening it. Named apart because it is a different mistake and a
      // different fix.
      return source.includes(w)
        ? { ok: false, reason: 'reordered', token: w }
        : { ok: false, reason: 'introduced', token: w }
    }
    at = found + 1
  }
  return { ok: true }
}
