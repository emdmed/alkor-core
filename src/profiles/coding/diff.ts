/**
 * A line diff, for showing what a write is about to do before it does it.
 *
 * Profile-local rather than in `src/core/`: core defines no tools, so it has no business
 * shipping the renderer for one. Another profile's mutating tool would preview itself
 * however its own domain reads best.
 *
 * Plain LCS. The inputs are a file a 4B model is rewriting — bounded at 200 lines by
 * write_file's own full-rewrite limit, or a line range — so the quadratic table is a few
 * thousand cells and an optimised diff would be complexity spent on nothing.
 */

export type DiffOp = ' ' | '-' | '+'
export interface DiffLine {
  op: DiffOp
  text: string
}

export const diffLines = (before: string[], after: string[]): DiffLine[] => {
  const n = before.length
  const m = after.length

  // lcs[i][j] = length of the longest common subsequence of before[i..] and after[j..].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ op: ' ', text: before[i]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      // Deletions before insertions on a tie, so a replaced line reads as `-` then `+`
      // rather than the other way round.
      out.push({ op: '-', text: before[i++]! })
    } else {
      out.push({ op: '+', text: after[j++]! })
    }
  }
  while (i < n) out.push({ op: '-', text: before[i++]! })
  while (j < m) out.push({ op: '+', text: after[j++]! })
  return out
}

export const diffStat = (d: DiffLine[]) => ({
  added: d.filter((l) => l.op === '+').length,
  removed: d.filter((l) => l.op === '-').length,
})

/**
 * Unchanged runs longer than `context` collapse to a `…` marker. A consent prompt competes
 * with the terminal's scrollback for attention, and a 200-line dump of context to show a
 * one-line edit is how a user learns to approve without reading.
 */
export const formatDiff = (d: DiffLine[], context = 2): string[] => {
  const keep = new Array(d.length).fill(false)
  d.forEach((l, i) => {
    if (l.op === ' ') return
    for (let k = Math.max(0, i - context); k <= Math.min(d.length - 1, i + context); k++) keep[k] = true
  })

  const out: string[] = []
  let skipped = 0
  d.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) {
        out.push(`   … ${skipped} unchanged line${skipped === 1 ? '' : 's'}`)
        skipped = 0
      }
      // No separator after the op, as in a unified diff: the rest of the line is then the
      // file's line exactly, which is what makes copying one out of the terminal work.
      out.push(`${l.op}${l.text}`)
    } else {
      skipped++
    }
  })
  if (skipped) out.push(`   … ${skipped} unchanged line${skipped === 1 ? '' : 's'}`)
  return out
}
