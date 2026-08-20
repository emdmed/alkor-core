import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOOL_BY_NAME, TOOLS, ALLOWED_COMMANDS, FULL_REWRITE_LINE_LIMIT, gutterLines } from '../src/profiles/coding/tools.ts'

const ws = () => {
  const d = mkdtempSync(join(tmpdir(), 'harness-tools-'))
  writeFileSync(join(d, 'a.txt'), 'alpha\nbeta\ngamma\n')
  writeFileSync(join(d, 'big.txt'), Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n'))
  mkdirSync(join(d, 'sub'))
  writeFileSync(join(d, 'sub', 'b.txt'), 'needle here\n')
  return d
}
const run = (name: string, args: Record<string, any>, root: string) =>
  TOOL_BY_NAME.get(name)!.execute(args, root)

test('the toolset stays at six — recall collapses past a handful on a 4B', () => {
  assert.equal(TOOLS.length, 6)
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), ['done', 'list_files', 'read_file', 'run_command', 'search', 'write_file'])
})

test('schemas are flat: no nested objects, no optional params', () => {
  for (const t of TOOLS) {
    const p = t.parameters as any
    const keys = Object.keys(p.properties)
    assert.deepEqual(p.required.sort(), keys.sort(), `${t.name}: every param must be required`)
    for (const [k, v] of Object.entries<any>(p.properties)) {
      assert.ok(['string', 'integer'].includes(v.type), `${t.name}.${k}: only string/integer, got ${v.type}`)
    }
  }
})

test('read_file numbers lines and honours 0/0 as whole-file', () => {
  const d = ws()
  const all = run('read_file', { path: 'a.txt', start_line: 0, end_line: 0 }, d)
  assert.match(all, /^\s+1\talpha/)
  assert.match(all, /\s+3\tgamma/)
  const range = run('read_file', { path: 'a.txt', start_line: 2, end_line: 2 }, d)
  assert.equal(range.trim(), '2\tbeta')
})

test('read_file misses point at the fix rather than throwing', () => {
  const d = ws()
  assert.match(run('read_file', { path: 'nope.txt', start_line: 0, end_line: 0 }, d), /not found.*list_files/)
})

test('write_file refuses a full rewrite of a large file and says what to do instead', () => {
  const d = ws()
  const r = run('write_file', { path: 'big.txt', content: 'x', start_line: 0, end_line: 0 }, d)
  assert.match(r, new RegExp(`over the ${FULL_REWRITE_LINE_LIMIT}-line limit`))
  assert.match(r, /start_line and end_line/)
  // The file must be untouched — a refused write that half-wrote would be worse than none.
  assert.match(run('read_file', { path: 'big.txt', start_line: 1, end_line: 1 }, d), /line 1/)
})

test('write_file creates missing parent directories — there is no mkdir tool', () => {
  const d = ws()
  const r = run('write_file', { path: 'src/components/App.js', content: 'export default 1\n', start_line: 0, end_line: 0 }, d)
  assert.match(r, /wrote 2 lines/)
  assert.match(r, /created 'src\/', 'src\/components\/'/)
  assert.match(run('read_file', { path: 'src/components/App.js', start_line: 0, end_line: 0 }, d), /export default 1/)
})

test('write_file preview announces the directories the write will create', () => {
  const d = ws()
  const p = TOOL_BY_NAME.get('write_file')!.preview!({ path: 'src/App.js', content: 'x', start_line: 0, end_line: 0 }, d)
  assert.match(p, /create src\/App\.js/)
  assert.match(p, /new src\//)
  // Preview must not touch the disk.
  assert.match(run('read_file', { path: 'src/App.js', start_line: 0, end_line: 0 }, d), /not found/)
})

test('directory creation cannot escape the workspace', () => {
  const d = ws()
  assert.match(run('write_file', { path: '../out/x.txt', content: 'x', start_line: 0, end_line: 0 }, d), /outside the workspace/)
})

test('write_file replaces a line range in place', () => {
  const d = ws()
  assert.match(run('write_file', { path: 'a.txt', content: 'BETA', start_line: 2, end_line: 2 }, d), /replaced lines 2-2/)
  const after = run('read_file', { path: 'a.txt', start_line: 0, end_line: 0 }, d)
  assert.match(after, /1\talpha/)
  assert.match(after, /2\tBETA/)
  assert.match(after, /3\tgamma/)
})

test('workspace confinement blocks traversal', () => {
  const d = ws()
  for (const p of ['../../../etc/passwd', '/etc/passwd']) {
    assert.match(run('read_file', { path: p, start_line: 0, end_line: 0 }, d), /outside the workspace|not found/)
  }
  assert.match(run('write_file', { path: '../escaped.txt', content: 'x', start_line: 0, end_line: 0 }, d), /outside the workspace/)
})

test('run_command allowlists the verb and refuses chaining', () => {
  const d = ws()
  assert.match(run('run_command', { command: 'rm -rf /' }, d), /'rm' is not an allowed program/)
  assert.match(run('run_command', { command: 'ls; rm -rf /' }, d), /chained commands are not allowed/)
  assert.match(run('run_command', { command: 'ls && rm x' }, d), /chained commands are not allowed/)
  assert.match(run('run_command', { command: 'cat a.txt | wc -l' }, d), /chained commands are not allowed/)
  assert.match(run('run_command', { command: 'echo `whoami`' }, d), /chained commands are not allowed/)
  assert.ok(ALLOWED_COMMANDS.has('git') && !ALLOWED_COMMANDS.has('rm'))
})

test('run_command runs an allowed program in the workspace', () => {
  const d = ws()
  assert.match(run('run_command', { command: 'ls' }, d), /a\.txt/)
})

test('search finds matches and reports no-match plainly', () => {
  const d = ws()
  assert.match(run('search', { pattern: 'needle', directory: '.' }, d), /sub\/b\.txt:1:needle here/)
  assert.match(run('search', { pattern: 'zzzz', directory: '.' }, d), /\(no matches for 'zzzz'/)
})

test('list_files marks directories and filters by pattern', () => {
  const d = ws()
  const all = run('list_files', { directory: '.', pattern: '' }, d)
  assert.match(all, /sub\//)
  assert.equal(run('list_files', { directory: '.', pattern: 'a.txt' }, d).trim(), 'a.txt')
})

/**
 * The glob prior.
 *
 * Measured failure: asked to find the source files, the model called this four times with
 * `src/*`, `invoice*`, `test/*`, `invoice*`, got "(no files matching)" each time, decided
 * the project had no source, and gave up in prose — with the directory sitting right there.
 * The parameter was a substring and the model's prior is a glob, so the tool meets it.
 */
test('list_files accepts a glob, not only a substring', () => {
  const d = ws()
  assert.match(run('list_files', { directory: '.', pattern: '*.txt' }, d), /a\.txt/)
  assert.doesNotMatch(run('list_files', { directory: '.', pattern: '*.txt' }, d), /sub\//)
  // A plain substring must keep working — `config` still has to find `tsconfig.json`.
  assert.equal(run('list_files', { directory: '.', pattern: 'a.txt' }, d).trim(), 'a.txt')
})

test('a pattern carrying a path descends into that directory', () => {
  const d = ws()
  // `sub/*` means "what is in sub", which is what the model meant by it.
  assert.match(run('list_files', { directory: '.', pattern: 'sub/*' }, d), /b\.txt/)
})

test('an empty result says what IS there, so it cannot read as an empty repo', () => {
  const d = ws()
  const r = run('list_files', { directory: '.', pattern: 'zzz' }, d)
  assert.match(r, /nothing in '\.' matches 'zzz'/)
  // The listing is the whole point: absence alone is what ended a run in prose.
  assert.match(r, /it holds 3: a\.txt, big\.txt, sub/)
})

/**
 * The line-number gutter guard.
 *
 * These are regression tests for a failure caught in a live run rather than an imagined
 * one: the model read a file, worked out the correct fix, and wrote the whole NUMBERED
 * rendering back — right edit, destroyed file. It survived all the way to `SyntaxError`
 * because nothing between the tool and the test run looks at what was written.
 */
const numbered = (lines: string[], sep = '\t') => lines.map((l, i) => `${String(i + 1).padStart(5)}${sep}${l}`).join('\n')

test('write_file strips read_file line numbers instead of refusing them', () => {
  const d = ws()
  const r = run('write_file', { path: 'a.txt', content: numbered(['alpha', 'beta', 'gamma']), start_line: 0, end_line: 0 }, d)
  // Refusing was tried first and the model could not comply — it reissued the identical
  // call, then narrated the gutter back a third time. So the tool strips, and says so.
  assert.match(r, /stripped read_file's line numbers from 3 lines/)
  assert.equal(readFileSync(join(d, 'a.txt'), 'utf8'), 'alpha\nbeta\ngamma')
})

test('the gutter is caught when the model reproduces it with spaces instead of tabs', () => {
  // What was actually observed on disk: an em-space, because the model regenerates the
  // whitespace rather than copying the bytes it read.
  const d = ws()
  const r = run('write_file', { path: 'a.txt', content: numbered(['alpha', 'beta', 'gamma'], ' '), start_line: 0, end_line: 0 }, d)
  assert.match(r, /stripped read_file's line numbers from 3 lines/)
  assert.equal(readFileSync(join(d, 'a.txt'), 'utf8'), 'alpha\nbeta\ngamma')
})

test('the guard covers a line-range write, not only a full rewrite', () => {
  const d = ws()
  const r = run('write_file', { path: 'a.txt', content: numbered(['one', 'two', 'three']), start_line: 1, end_line: 2 }, d)
  assert.match(r, /stripped read_file's line numbers/)
  assert.equal(readFileSync(join(d, 'a.txt'), 'utf8'), 'one\ntwo\nthree\ngamma\n')
})

test('a numbered markdown list is not a gutter', () => {
  const d = ws()
  const r = run('write_file', { path: 'a.txt', content: '1. first\n2. second\n3. third\n', start_line: 0, end_line: 0 }, d)
  assert.match(r, /wrote/)
})

test('data whose lines begin with unrelated integers is not a gutter', () => {
  // Present but NOT ascending, which is the whole difference.
  const d = ws()
  const r = run('write_file', { path: 'a.txt', content: '42 alpha\n7 beta\n19 gamma\n', start_line: 0, end_line: 0 }, d)
  assert.match(r, /wrote/)
})

test('ordinary source code is never mistaken for a gutter', () => {
  const d = ws()
  const code = "export const money = (amount) => `$${amount.toFixed(2)}`\nconst x = 1\nexport default x\n"
  assert.match(run('write_file', { path: 'a.txt', content: code, start_line: 0, end_line: 0 }, d), /wrote/)
})

test('a PARTIALLY mangled file is caught by the count-up, not by density', () => {
  // The shape actually observed: a gutter run survives in the middle of a file the model
  // otherwise rewrote, so fewer than half the lines carry numbers. Density alone let this
  // through by one line.
  const d = ws()
  const content = [
    'const parseItems = (raw) => {',
    '    // Your implementation here',
    '};',
    'more unnumbered code',
    'and more',
    'and yet more',
    'const x = 1',
    'const y = 2',
    'export default { x, y }',
    'function helper() { return null }',
    'const z = helper()',
    numbered(['a', 'b', 'c', 'd', 'e', 'f']),
  ].join('\n')
  const g = gutterLines(content)
  assert.ok(g.hit < Math.ceil(g.total * 0.5), 'this test is pointless unless density is under the bar')
  const r = run('write_file', { path: 'a.txt', content, start_line: 0, end_line: 0 }, d)
  assert.match(r, /stripped read_file's line numbers from 6 lines/)
  // The unnumbered lines must survive untouched — a half-eaten file is worse than a refusal.
  assert.match(readFileSync(join(d, 'a.txt'), 'utf8'), /const parseItems = \(raw\) => \{/)
})
