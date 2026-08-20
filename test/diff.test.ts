/**
 * The write preview.
 *
 * The property that matters is not diff quality — it is that the preview and the write are
 * the same plan. A consent prompt that can disagree with what lands teaches the reader that
 * approving is safe when it is not, so the last test here pins preview against execute.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diffLines, diffStat, formatDiff } from '../src/profiles/coding/diff.ts'
import { TOOL_BY_NAME } from '../src/profiles/coding/tools.ts'

const ops = (a: string[], b: string[]) => diffLines(a, b).map((l) => l.op + l.text)

test('an unchanged file produces no additions or removals', () => {
  const d = diffLines(['a', 'b'], ['a', 'b'])
  assert.deepEqual(diffStat(d), { added: 0, removed: 0 })
})

test('a replaced line reads as a removal then an addition', () => {
  assert.deepEqual(ops(['a', 'b', 'c'], ['a', 'B', 'c']), [' a', '-b', '+B', ' c'])
})

test('insertion and deletion keep the surrounding lines as context', () => {
  assert.deepEqual(ops(['a', 'c'], ['a', 'b', 'c']), [' a', '+b', ' c'])
  assert.deepEqual(ops(['a', 'b', 'c'], ['a', 'c']), [' a', '-b', ' c'])
})

test('creating a file is all additions', () => {
  assert.deepEqual(diffStat(diffLines([], ['x', 'y'])), { added: 2, removed: 0 })
})

test('long unchanged runs collapse, so a one-line edit is not buried', () => {
  const before = Array.from({ length: 40 }, (_, i) => `line ${i}`)
  const after = [...before]
  after[20] = 'changed'
  const out = formatDiff(diffLines(before, after))
  assert.ok(out.length < 12, `expected a compact hunk, got ${out.length} lines`)
  assert.ok(out.some((l) => l.includes('unchanged line')))
  assert.ok(out.some((l) => l === '+changed'))
})

test('write_file previews exactly what it goes on to write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diff-'))
  writeFileSync(join(dir, 'calc.py'), 'def add(a, b):\n    return a - b\n')
  const write = TOOL_BY_NAME.get('write_file')!
  const args = { path: 'calc.py', content: '    return a + b', start_line: 2, end_line: 2 }

  const preview = write.preview!(args, dir)
  assert.match(preview, /edit calc\.py {2}\+1 −1/)
  assert.ok(preview.includes('-    return a - b'))
  assert.ok(preview.includes('+    return a + b'))

  write.execute(args, dir)
  const landed = readFileSync(join(dir, 'calc.py'), 'utf8')
  // Every `+` line in the preview is a line in the file, and no `-` line survives.
  for (const l of preview.split('\n')) {
    if (l.startsWith('+')) assert.ok(landed.includes(l.slice(1)), `preview promised '${l}' but it is not in the file`)
    if (l.startsWith('-')) assert.ok(!landed.includes(l.slice(1)), `preview removed '${l}' but it is still in the file`)
  }
})

test('a preview that cannot be planned reports the refusal instead of a diff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'diff-'))
  const write = TOOL_BY_NAME.get('write_file')!
  const preview = write.preview!({ path: 'missing.py', content: 'x', start_line: 3, end_line: 4 }, dir)
  assert.match(preview, /not found/)
})

test('the tools that change things are the ones marked as changing things', () => {
  // A tool that mutates without the flag is a write that never asks. Pinning the whole
  // toolset means adding one cannot silently opt out.
  const mutating = [...TOOL_BY_NAME.values()].filter((t) => t.mutates).map((t) => t.name)
  assert.deepEqual(mutating.sort(), ['run_command', 'write_file'])
})
