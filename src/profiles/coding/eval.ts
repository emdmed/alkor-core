/**
 * Tool-selection eval for the coding profile.
 *
 * Single-turn and deliberately shallow: each case sends one task with the six tool specs
 * and grades the FIRST tool call. No loop, no real filesystem — the question is only
 * whether the model can pick the right tool and fill its arguments. If it cannot clear
 * this, nothing built on top of the loop will work, and debugging a multi-step failure
 * would be much harder than debugging this.
 *
 * Three metrics, in increasing strictness:
 *   valid   — a tool call came back at all (vs prose, or an unparseable one)
 *   tool    — it was the right tool
 *   args    — the argument that matters carries the right value
 */
import { toolChat } from '../../core/client.ts'
import { toolSpecs } from '../../core/tools.ts'
import { TOOLS, TOOL_BY_NAME } from './tools.ts'
import { CODING_SYSTEM_PROMPT } from './profile.ts'
import type { Trace } from '../../core/trace.ts'

export interface ToolCase {
  task: string
  expectTool: string
  /**
   * Other tools that are a legitimate FIRST move for this task. Needed because this eval
   * grades one call while the profile's prompt tells the model to read a file before
   * changing it: on an edit task, `read_file` first is the instructed behaviour, and
   * scoring it wrong would penalise the model for following its own rules. Argument
   * checks are skipped when the answer came from this set — they describe `expectTool`.
   */
  acceptAlso?: string[]
  /** Argument name -> predicate on the value the model supplied. Checked only if the tool matched. */
  expectArgs?: Record<string, (v: unknown) => boolean>
}

const is = (want: string) => (v: unknown) => String(v ?? '').trim() === want
const contains = (want: string) => (v: unknown) => String(v ?? '').includes(want)

export const TOOL_CASES: ToolCase[] = [
  // list_files — orientation
  { task: 'What files are in the src directory?', expectTool: 'list_files', expectArgs: { directory: contains('src') } },
  { task: 'Show me everything in the root of this project.', expectTool: 'list_files' },
  { task: 'Are there any files with "config" in the name?', expectTool: 'list_files', expectArgs: { pattern: contains('config') } },

  // search — content
  { task: 'Where is the function parseInvoice defined?', expectTool: 'search', expectArgs: { pattern: contains('parseInvoice') } },
  { task: 'Find every place that mentions DATABASE_URL.', expectTool: 'search', expectArgs: { pattern: contains('DATABASE_URL') } },
  { task: 'Which file contains the string "connection refused"?', expectTool: 'search', expectArgs: { pattern: contains('connection refused') } },

  // read_file
  { task: 'Read the file src/index.js.', expectTool: 'read_file', expectArgs: { path: contains('src/index.js') } },
  { task: 'Show me lines 10 to 20 of README.md.', expectTool: 'read_file', expectArgs: { path: contains('README.md'), start_line: (v) => Number(v) === 10, end_line: (v) => Number(v) === 20 } },
  { task: 'What does package.json contain?', expectTool: 'read_file', expectArgs: { path: contains('package.json') } },

  // write_file
  { task: 'Create a file called notes.txt containing the single word hello.', expectTool: 'write_file', expectArgs: { path: contains('notes.txt'), content: contains('hello') } },
  { task: 'Replace line 5 of app.py with "return None".', expectTool: 'write_file', acceptAlso: ['read_file'], expectArgs: { path: contains('app.py'), start_line: (v) => Number(v) === 5 } },

  // run_command
  { task: 'Run the test suite with npm test.', expectTool: 'run_command', expectArgs: { command: contains('npm test') } },
  { task: 'What is the current git status?', expectTool: 'run_command', expectArgs: { command: contains('git status') } },
  { task: 'How many lines are in main.c? Use a shell command.', expectTool: 'run_command', expectArgs: { command: contains('wc') } },

  // done — the discriminator that matters most for the loop
  { task: 'You have finished the task. The bug was a missing semicolon on line 12, and you fixed it. Report back.', expectTool: 'done' },
  { task: 'Nothing further is needed. Summarise: the config was already correct.', expectTool: 'done', expectArgs: { answer: (v) => String(v).length > 0 } },

  // discrimination — pairs a small model tends to confuse
  { task: 'I want to see the contents of the file utils.py, not search it.', expectTool: 'read_file', expectArgs: { path: contains('utils.py') } },
  { task: 'I do not know which file it is in — locate the text TODO anywhere in the repo.', expectTool: 'search', expectArgs: { pattern: contains('TODO') } },
  { task: 'List the directory tests/, do not read any file.', expectTool: 'list_files', expectArgs: { directory: contains('tests') } },
  { task: 'Execute the command git log.', expectTool: 'run_command', expectArgs: { command: contains('git log') } },
]

export interface ToolEvalResult {
  total: number
  valid: number
  correctTool: number
  correctArgs: number
  argsChecked: number
  failures: string[]
}

export const runToolSelectionEval = async (o: { baseUrl?: string; trace?: Trace } = {}): Promise<ToolEvalResult> => {
  const r: ToolEvalResult = { total: TOOL_CASES.length, valid: 0, correctTool: 0, correctArgs: 0, argsChecked: 0, failures: [] }
  const tools = toolSpecs(TOOLS)

  console.log(`\n=== Tool-selection eval — ${TOOL_CASES.length} single-turn cases ===`)

  for (const [i, c] of TOOL_CASES.entries()) {
    let reply
    try {
      reply = await toolChat({
        messages: [
          { role: 'system', content: CODING_SYSTEM_PROMPT },
          { role: 'user', content: c.task },
        ],
        tools,
        baseUrl: o.baseUrl,
        label: `tool-case-${i}`,
      })
    } catch (e) {
      r.failures.push(`[${i}] transport: ${(e as Error).message}`)
      continue
    }
    o.trace?.write({ case: i, task: c.task, expect: c.expectTool, content: reply.content, toolCalls: reply.toolCalls })

    const call = reply.toolCalls[0]
    if (!call) {
      r.failures.push(`[${i}] no tool call (expected ${c.expectTool}) — said: ${JSON.stringify(reply.content ?? '').slice(0, 80)}`)
      continue
    }
    if (!TOOL_BY_NAME.has(call.function.name)) {
      r.failures.push(`[${i}] invented tool '${call.function.name}' (expected ${c.expectTool})`)
      continue
    }
    r.valid++

    if (call.function.name !== c.expectTool) {
      if (c.acceptAlso?.includes(call.function.name)) {
        r.correctTool++
        console.log(`  [${i}] ${call.function.name} accepted as a valid first step toward ${c.expectTool}`)
        continue
      }
      r.failures.push(`[${i}] chose ${call.function.name}, expected ${c.expectTool} — "${c.task.slice(0, 50)}"`)
      continue
    }
    r.correctTool++

    if (!c.expectArgs) continue
    let args: Record<string, unknown>
    try {
      args = JSON.parse(call.function.arguments || '{}')
    } catch {
      r.argsChecked++
      r.failures.push(`[${i}] ${c.expectTool}: arguments were not valid JSON`)
      continue
    }
    r.argsChecked++
    const bad = Object.entries(c.expectArgs).filter(([k, pred]) => !pred(args[k]))
    if (bad.length) {
      r.failures.push(`[${i}] ${c.expectTool}: wrong ${bad.map(([k]) => k).join(', ')} — got ${JSON.stringify(args).slice(0, 100)}`)
    } else {
      r.correctArgs++
    }
  }

  const p = (n: number, d: number) => `${d ? Math.round((n / d) * 100) : 0}% (${n}/${d})`
  console.log(`\nvalid call   ${p(r.valid, r.total)}`)
  console.log(`correct tool ${p(r.correctTool, r.total)}`)
  console.log(`correct args ${p(r.correctArgs, r.argsChecked)}`)
  if (r.failures.length) {
    console.log('\nfailures:')
    for (const f of r.failures) console.log(`  ${f}`)
  }
  return r
}
