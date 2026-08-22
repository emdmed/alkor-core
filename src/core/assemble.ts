/**
 * Building ONE user message out of several documents.
 *
 * A pack whose task reads a whole record rather than a single document has an assembly rule,
 * and that rule is part of the contract rather than an implementation detail. Two runtimes
 * that assemble differently are grading different inputs while appearing to share a prompt —
 * same system message, same schema, same model, and a difference nobody can see in either
 * codebase because it lives in the space between them.
 *
 * So the rule is data: per-document cap, running total, line format, truncation marker. This
 * module applies it and holds no opinion about what the documents are.
 */

export interface AssemblyRule {
  /** Per-document cap, applied on a character boundary. See `truncateOnCharBoundary`. */
  perNoteBytes: number
  /**
   * Running total after which assembly stops. Checked AFTER appending, so the document that
   * crosses the line is included whole and the marker follows it — a rule that stopped
   * before appending would silently drop a document that fits.
   */
  totalChars: number
  /** `{i}`, `{note_type}` and `{content}` are substituted. 1-based index. */
  lineFormat: string
  /** Appended when the total was reached, so the model can see that it is reading a prefix. */
  truncationMarker: string
  /** The label each document is given. Pinned by the pack, not invented per run. */
  noteType: string
}

/**
 * Truncate to at most `maxBytes` UTF-8 bytes, never splitting a character.
 *
 * A byte slice is the obvious implementation and the wrong one. Clinical Spanish is full of
 * á, é, í, ó, ú and ñ — two bytes each — and a cut landing between them yields a lone
 * continuation byte: in JavaScript a replacement character that silently corrupts the input,
 * in the Rust runtime on the other side of a shared pack, a panic. The cap is expressed in
 * bytes because that is what a memory budget is measured in, and honoured in characters
 * because that is what text is made of.
 */
export const truncateOnCharBoundary = (s: string, maxBytes: number): string => {
  const encoder = new TextEncoder()
  if (encoder.encode(s).length <= maxBytes) return s
  let out = ''
  let used = 0
  // Iterating the string yields whole code points, so a surrogate pair is never split.
  for (const ch of s) {
    const size = encoder.encode(ch).length
    if (used + size > maxBytes) break
    out += ch
    used += size
  }
  return out
}

/**
 * Assemble documents into one message under the pack's rule.
 *
 * Returns the message and whether it was truncated — the caller usually wants to record
 * that, because a run whose input silently lost its last three documents produces a
 * perfectly plausible score for a question the model was never asked.
 */
export const assembleDocument = (
  documents: string[],
  rule: AssemblyRule,
): { text: string; used: number; truncated: boolean } => {
  let text = ''
  let used = 0
  for (const doc of documents) {
    const content = truncateOnCharBoundary(doc.trim(), rule.perNoteBytes)
    // Function replacements, NOT strings. `String.replace` reads `$&`, `$'`, '$`' and `$$`
    // in a replacement STRING as patterns, so a note containing any of them assembles into
    // something that is not the note: `"...{content}".replace('{content}', "a $& b")` yields
    // the literal `{content}` back in the middle of the record. A replacer function is
    // handed the text verbatim and interprets nothing — which is the only acceptable
    // behaviour for a rule whose entire purpose is that two runtimes assemble identically.
    text += rule.lineFormat
      .replace('{i}', () => String(used + 1))
      .replace('{note_type}', () => rule.noteType)
      .replace('{content}', () => content)
    used++
    // After appending, deliberately: see `totalChars` above.
    if (text.length >= rule.totalChars) {
      if (used < documents.length) return { text: text + rule.truncationMarker, used, truncated: true }
      break
    }
  }
  return { text, used, truncated: false }
}
