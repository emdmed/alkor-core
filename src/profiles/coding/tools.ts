/**
 * The coding profile's six tools.
 *
 * Six is not arbitrary: tool-selection recall on a 4–8B collapses somewhere past a
 * handful, so every addition costs accuracy on all the others. The schemas are
 * deliberately flat — no nested objects, no arrays of objects, no optional parameters.
 * A small model that must decide whether to emit a field gets it wrong; one that must
 * always emit it does not.
 *
 * Everything is confined to a workspace root. These run whatever a 4B model asks for, so
 * confinement is the mechanism, not the prompt.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, join, relative, dirname, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { ToolDef } from '../../core/tools.ts'
import { diffLines, diffStat, formatDiff } from './diff.ts'

/** Reject anything that escapes the workspace, including via symlink or `..`. */
const safePath = (root: string, p: string): string => {
  const abs = resolve(root, p)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || rel.startsWith(sep) || resolve(root) === abs.slice(0, 0)) {
    throw new Error(`path '${p}' is outside the workspace`)
  }
  return abs
}

/**
 * Errors are returned as text the model can act on, never as a stack trace. A small model
 * recovers well from "did you mean X" and terribly from a traceback.
 */
const fail = (msg: string) => `error: ${msg}`

/** Cap on what one tool result may return, so a large file cannot blow the context. */
const MAX_RESULT_CHARS = 8000
const truncate = (s: string, note: string) =>
  s.length <= MAX_RESULT_CHARS ? s : `${s.slice(0, MAX_RESULT_CHARS)}\n... [truncated; ${note}]`

/** write_file above this must use line-range replacement instead — see write_file. */
export const FULL_REWRITE_LINE_LIMIT = 200

/**
 * Allowlisted by leading verb. A local model will eventually emit something destructive
 * out of confusion rather than malice, and that should bounce off a rule rather than off
 * a human's attention at approval time. Shell metacharacters are refused outright so the
 * allowlist cannot be bypassed by chaining.
 */
export const ALLOWED_COMMANDS = new Set([
  'git', 'ls', 'cat', 'python', 'python3', 'node', 'npm', 'pytest', 'rg', 'wc', 'head', 'tail',
])
const SHELL_METACHARACTERS = /[;&|`$(){}<>]|\|\||&&/

interface WriteArgs {
  path: string
  content: string
  start_line: number
  end_line: number
}

type WritePlan =
  | { error: string }
  | { abs: string; exists: boolean; before: string[]; after: string[]; summary: string; newDirs: string[] }

/**
 * Parent directories the write would have to create, outermost first. A model asked for
 * `src/App.js` in an empty workspace should not have to discover that mkdir is not one of
 * the six tools; the write creates the path it was given. Still confined by safePath, so
 * this cannot make a directory outside the workspace.
 */
const missingDirs = (root: string, abs: string): string[] => {
  const dirs: string[] = []
  for (let d = dirname(abs); !existsSync(d) && relative(root, d) && !relative(root, d).startsWith('..'); d = dirname(d)) {
    dirs.unshift(relative(root, d))
  }
  return dirs
}

/**
 * Three ways `read_file`'s line-number gutter arrives, because the model does not
 * reproduce it faithfully:
 *
 *   1. a non-space separator — TAB is what `read_file` emits; em-space (U+2003) and nbsp
 *      are what actually came back on disk when the model regenerated it;
 *   2. two or more spaces;
 *   3. INDENTED digits then a single space — `read_file` pads the number to width 5, so a
 *      gutter line always begins with whitespace. That indent is what keeps `1 foo` (a
 *      legitimate data line) out while catching `    1 foo` (padded, so a gutter).
 */
const GUTTER_LINE = /^[ \t]*(\d+)[\t  ]|^[ \t]*(\d+) {2,}|^[ \t]+(\d+) /

/**
 * Does this content still carry the gutter?
 *
 * The failure this exists to stop, observed end-to-end: the model reads a file, gets
 * `    1\t/**` and so on, works out the correct one-line fix, and then writes the WHOLE
 * numbered rendering back to disk. The fix is right and the file is destroyed —
 * `SyntaxError: Unexpected token 'const'` — and nothing downstream notices until the tests
 * fail to load. In one measured run it took out two of the three arms that used a
 * line-range write, and both had produced the correct edit.
 *
 * Detection has to be narrow, because a false positive now MANGLES a legitimate write
 * rather than merely blocking one — `stripGutter` acts on this verdict. Two guards do that
 * work: the numbers must ASCEND, which separates a gutter from a data file whose lines
 * happen to start with integers, and a numbered markdown list (`1. item`) never matches,
 * because a period is not one of the separators above.
 */
export const gutterLines = (content: string): { hit: number; total: number; run: number; sample?: string } => {
  const lines = content.split('\n').filter((l) => l.trim())
  const numbers: number[] = []
  let sample: string | undefined
  for (const l of lines) {
    const m = GUTTER_LINE.exec(l)
    if (!m) continue
    numbers.push(Number(m[1] ?? m[2] ?? m[3]))
    sample ??= l
  }
  // Ascending, not merely present: a file of unrelated integers is not a gutter.
  const ascending = numbers.every((n, i) => i === 0 || n > numbers[i - 1])
  // The longest run counting up by exactly one — `1,2,3,4,5`. This is the true signature,
  // and it is what makes the guard hold on a PARTIALLY mangled file. The real observed
  // corruption ran 14 gutter lines out of 23, which density alone catches only barely;
  // the run through it is unmistakable.
  let run = 0
  let best = 0
  for (const [i, n] of numbers.entries()) {
    run = i > 0 && n === numbers[i - 1] + 1 ? run + 1 : 1
    best = Math.max(best, run)
  }
  return { hit: ascending ? numbers.length : 0, total: lines.length, run: ascending ? best : 0, sample }
}

/** Density OR an unbroken count-up. Either is enough; neither alone catches both shapes. */
export const looksNumbered = (g: { hit: number; total: number; run: number }): boolean =>
  g.total >= 3 && (g.hit >= Math.ceil(g.total * 0.5) || g.run >= 5)

/**
 * Take the gutter off, rather than asking the model to.
 *
 * Refusing was the first attempt and it is not enough. Told `the content still has
 * read_file's line-number gutter … send the file text ONLY`, Qwen3-4B reissued the
 * byte-identical call, was refused again, then replied in prose — "I'll send the file text
 * without the line-number gutter. Here is the content:" — followed by the gutter a third
 * time. It cannot do it. That is the same finding as everywhere else in this toolset: a
 * small model asked to make a judgement it gets wrong should not be asked.
 *
 * So the tool does it, and SAYS it did, so neither the model nor the human is left
 * guessing about bytes that changed on the way to disk. Only lines that actually carry the
 * gutter are touched; the rest pass through, which keeps a partially-mangled file
 * recoverable instead of half-eaten.
 */
export const stripGutter = (content: string): { text: string; stripped: number } => {
  let stripped = 0
  const text = content
    .split('\n')
    .map((l) => {
      const m = GUTTER_LINE.exec(l)
      if (!m) return l
      stripped += 1
      return l.slice(m[0].length)
    })
    .join('\n')
  return { text, stripped }
}

/**
 * What write_file WOULD do, without doing it. Both `preview` and `execute` go through
 * here, so the diff a user approves and the bytes that land cannot drift apart.
 */
const planWrite = ({ path, content, start_line, end_line }: WriteArgs, root: string): WritePlan => {
  let abs: string
  try {
    abs = safePath(root, path)
  } catch (e) {
    return { error: fail((e as Error).message) }
  }

  let existing: string[] | undefined
  try {
    existing = readFileSync(abs, 'utf8').split('\n')
  } catch {
    existing = undefined
  }
  const from = Number(start_line) || 0
  const to = Number(end_line) || 0
  let body = String(content ?? '')

  // Before either write mode and before the file is touched: a gutter-carrying write is
  // never what was meant, in a range or a full rewrite.
  let gutterNote = ''
  if (looksNumbered(gutterLines(body))) {
    const { text, stripped } = stripGutter(body)
    body = text
    gutterNote = ` (stripped read_file's line numbers from ${stripped} line${stripped === 1 ? '' : 's'})`
  }

  if (from === 0 && to === 0) {
    // Full rewrite is the reliable mode for a small model — exact-string editing fails on
    // reproduced whitespace — but it does not scale, and a truncated rewrite silently
    // destroys the tail. So it is refused above the limit.
    if (existing && existing.length > FULL_REWRITE_LINE_LIMIT) {
      return {
        error: fail(
          `'${path}' has ${existing.length} lines, over the ${FULL_REWRITE_LINE_LIMIT}-line limit for a full rewrite. ` +
            'Read the part you want to change and call write_file again with a start_line and end_line.',
        ),
      }
    }
    const after = body.split('\n')
    const newDirs = existing ? [] : missingDirs(root, abs)
    const made = newDirs.length ? ` (created ${newDirs.map((d) => `'${d}/'`).join(', ')})` : ''
    return {
      abs,
      exists: !!existing,
      before: existing ?? [],
      after,
      summary: `wrote ${after.length} lines to '${path}'${made}${gutterNote}`,
      newDirs,
    }
  }

  if (!existing) {
    return {
      error: fail(`file '${path}' not found, so a line range cannot be replaced. Use start_line 0 and end_line 0 to create it.`),
    }
  }
  if (from < 1 || from > existing.length) {
    return { error: fail(`start_line ${from} is outside '${path}' (${existing.length} lines)`) }
  }
  if (to < from) return { error: fail(`end_line ${to} is before start_line ${from}`) }

  const after = [...existing.slice(0, from - 1), ...body.split('\n'), ...existing.slice(Math.min(to, existing.length))]
  return { abs, exists: true, before: existing, after, summary: `replaced lines ${from}-${to} of '${path}'${gutterNote}`, newDirs: [] }
}

export const TOOLS: ToolDef[] = [
  {
    name: 'list_files',
    description:
      'List files in a directory. Use this first to orient yourself in an unfamiliar directory.',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Directory relative to the workspace root. Use "." for the root.' },
        pattern: { type: 'string', description: 'Filename substring or glob such as "*.js". Use "" for all files.' },
      },
      required: ['directory', 'pattern'],
    },
    execute({ directory, pattern }, root) {
      try {
        // The model's prior is a GLOB, and the parameter was a substring. Measured: asked
        // to find the source files, Qwen3-4B called this four times with `src/*`,
        // `invoice*`, `test/*`, `invoice*`, got "(no files matching)" every time, concluded
        // the project had no source files, and gave up in prose — with `src/` sitting right
        // there. Meeting the prior is cheaper than fighting it.
        let target = directory || '.'
        let pat = String(pattern ?? '')
        // A separator means the model was pointing at a SUBDIRECTORY, not naming a file.
        if (pat.includes('/')) {
          const cut = pat.lastIndexOf('/')
          target = join(target, pat.slice(0, cut))
          pat = pat.slice(cut + 1)
        }
        const dir = safePath(root, target)
        // `*` is a wildcard; anything else stays the substring match it always was, so a
        // plain `config` still finds `tsconfig.json`.
        const matches = (f: string) => {
          if (!pat || pat === '*') return true
          if (!pat.includes('*')) return f.includes(pat)
          const rx = new RegExp(`^${pat.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
          return rx.test(f)
        }
        const all = readdirSync(dir)
        const entries = all.filter(matches).map((f) => (statSync(join(dir, f)).isDirectory() ? `${f}/` : f))
        if (entries.length) return entries.sort().join('\n')
        // Never report only the absence. An empty result read as an empty repository is
        // what ended the run above, so say what IS there — that is the fix the model needs.
        const shown = all.sort().slice(0, 20)
        return all.length
          ? `(nothing in '${target}' matches '${pattern}'; it holds ${all.length}: ${shown.join(', ')}${all.length > shown.length ? ', …' : ''})`
          : `(the directory '${target}' is empty)`
      } catch (e) {
        return fail((e as Error).message)
      }
    },
  },
  {
    name: 'search',
    description: 'Search file contents for a text pattern, recursively. Returns matching lines with their file and line number.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Literal text to search for.' },
        directory: { type: 'string', description: 'Directory relative to the workspace root. Use "." for the root.' },
      },
      required: ['pattern', 'directory'],
    },
    execute({ pattern, directory }, root) {
      try {
        const dir = safePath(root, directory || '.')
        // --fixed-strings: the model supplies literal text, not a regex it half-remembers.
        const out = execFileSync('rg', ['--fixed-strings', '--line-number', '--no-heading', '--color=never', pattern, dir], {
          encoding: 'utf8',
          maxBuffer: 4 << 20,
        })
        const lines = out.split('\n').filter(Boolean).map((l) => l.replace(`${dir}/`, ''))
        // Report the cap rather than silently returning a prefix.
        return lines.length > 50
          ? `${lines.slice(0, 50).join('\n')}\n... [${lines.length - 50} more matches not shown; narrow the pattern]`
          : lines.join('\n')
      } catch (e: any) {
        if (e.status === 1) return `(no matches for '${pattern}' in '${directory}')`
        return fail((e as Error).message)
      }
    },
  },
  {
    name: 'read_file',
    description:
      'Read a file, with line numbers. Pass start_line 0 and end_line 0 to read the whole file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        start_line: { type: 'integer', description: 'First line to read (1-based). Use 0 for the start of the file.' },
        end_line: { type: 'integer', description: 'Last line to read. Use 0 for the end of the file.' },
      },
      required: ['path', 'start_line', 'end_line'],
    },
    execute({ path, start_line, end_line }, root) {
      try {
        const lines = readFileSync(safePath(root, path), 'utf8').split('\n')
        const from = Math.max(1, Number(start_line) || 1)
        const to = Number(end_line) > 0 ? Math.min(lines.length, Number(end_line)) : lines.length
        if (from > lines.length) return fail(`start_line ${from} is past the end of '${path}' (${lines.length} lines)`)
        // Numbered, because line numbers are what write_file's range mode consumes — and
        // a number the model just read is something it can reliably reproduce.
        const body = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}\t${l}`).join('\n')
        return truncate(body, `file has ${lines.length} lines; read a narrower range`)
      } catch (e: any) {
        if (e.code === 'ENOENT') return fail(`file '${path}' not found. Use list_files to see what exists.`)
        return fail((e as Error).message)
      }
    },
  },
  {
    name: 'write_file',
    description:
      `Write a file. Pass start_line 0 and end_line 0 to replace the whole file (only for files under ${FULL_REWRITE_LINE_LIMIT} lines). ` +
      'Otherwise pass a line range to replace just those lines. ' +
      'Missing parent directories are created for you, so write straight to a path like "src/App.js".',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        content: { type: 'string', description: 'The new content.' },
        start_line: { type: 'integer', description: 'First line to replace (1-based). Use 0 to replace the whole file.' },
        end_line: { type: 'integer', description: 'Last line to replace. Use 0 to replace the whole file.' },
      },
      required: ['path', 'content', 'start_line', 'end_line'],
    },
    mutates: true,
    preview({ path, content, start_line, end_line }, root) {
      // Built from the SAME plan the write executes, never a re-derivation. A preview that
      // can disagree with what happens is worse than no preview: it teaches the reader that
      // approving is safe when it is not.
      const plan = planWrite({ path, content, start_line, end_line }, root)
      if ('error' in plan) return plan.error
      const d = diffLines(plan.before, plan.after)
      const { added, removed } = diffStat(d)
      const dirs = plan.newDirs.length ? `  (new ${plan.newDirs.map((x) => `${x}/`).join(', ')})` : ''
      const head = `${plan.exists ? 'edit' : 'create'} ${path}  +${added} −${removed}${dirs}`
      return [head, ...formatDiff(d)].join('\n')
    },
    execute(args, root) {
      const plan = planWrite(args as WriteArgs, root)
      if ('error' in plan) return plan.error
      try {
        if (plan.newDirs.length) mkdirSync(dirname(plan.abs), { recursive: true })
        writeFileSync(plan.abs, plan.after.join('\n'))
      } catch (e) {
        return fail((e as Error).message)
      }
      return plan.summary
    },
  },
  {
    name: 'run_command',
    description:
      `Run a shell command. Only these programs are allowed: ${[...ALLOWED_COMMANDS].join(', ')}. ` +
      'Pipes, redirects and chained commands are not allowed.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The command, e.g. "git status" or "npm test".' } },
      required: ['command'],
    },
    // The allowlist is not consent. It stops a catastrophe, but `npm test`, `python x.py`
    // and every `git` subcommand still change state, so an interactive host asks first.
    mutates: true,
    preview({ command }, root) {
      return `run  ${String(command ?? '').trim()}\n     in ${root}`
    },
    execute({ command }, root) {
      const cmd = String(command ?? '').trim()
      if (!cmd) return fail('empty command')
      if (SHELL_METACHARACTERS.test(cmd)) {
        return fail('pipes, redirects and chained commands are not allowed. Run one program at a time.')
      }
      const [verb, ...args] = cmd.split(/\s+/)
      if (!ALLOWED_COMMANDS.has(verb)) {
        return fail(`'${verb}' is not an allowed program. Allowed: ${[...ALLOWED_COMMANDS].join(', ')}`)
      }
      try {
        // execFileSync, not exec: no shell is spawned, so there is no second parser to
        // disagree with the check above about what this string means.
        const out = execFileSync(verb, args, { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 << 20 })
        return truncate(out.trim() || '(no output)', 'output truncated')
      } catch (e: any) {
        const out = [e.stdout, e.stderr].filter(Boolean).join('\n').trim()
        return fail(`'${cmd}' exited ${e.status ?? '?'}${out ? `:\n${truncate(out, 'output truncated')}` : ''}`)
      }
    },
  },
  {
    name: 'done',
    description: 'Call this when the task is complete, with your answer. Always finish by calling done.',
    parameters: {
      type: 'object',
      properties: { answer: { type: 'string', description: 'Your final answer or a summary of what you changed.' } },
      required: ['answer'],
    },
    // The loop intercepts this and never calls execute; the flag is how it knows.
    terminal: true,
    execute({ answer }) {
      return String(answer ?? '')
    },
  },
]

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))
