/**
 * ChatPanel — send a prompt into the medextract pipeline and watch the
 * response stream back in, the same way the terminal CLI or the TUI does.
 *
 * The panel lives on the left side of the layout so it doesn't fight with
 * the right drawer for attention. When collapsed it reduces to a thin
 * vertical tab; when open it fills the space between the header and the
 * graph.
 *
 * The graph is the primary view; this panel is a command surface that feeds
 * work into it.
 */
import { memo, useEffect, useRef, useState } from 'react'
import { List, Send, Sparkles, X } from 'lucide-react'
import {
  type WorkflowDefinition,
  type ProjectState,
} from '../../../src/tui/state.ts'
import { Button } from './ui/button'
import { CopyButton } from './CopyButton'
import { formatRunLog } from '../lib/runlog.ts'
import { RunFailure } from '../hooks/useMedextract.ts'
import { cn } from '../lib/utils'

export interface ChatMessage {
  id: string
  input: string
  workflow: string
  status: 'pending' | 'done' | 'error'
  result?: unknown
  error?: string
  wallMs?: number
  /** The server's name for this run; the key its events are filtered by. */
  runId?: string
  /** Feed watermark when the run was sent — the lower bound of its slice of the log. */
  fromSeq: number
  startedAt: string
  endedAt?: string
  /** Set when the run bypassed the router. */
  forcedWorkflow?: string
}

interface ChatPanelProps {
  open: boolean
  onToggle: () => void
  state: ProjectState
  run: (input: string, workflow?: string) => Promise<unknown>
  /** Where the run was sent — recorded in the log so a pasted one names its server. */
  serverUrl: string
  /** Narrow-shell coordination: jump straight from the run console to the drawer. */
  onOpenActivity?: () => void
}

const PRESETS = [
  'Vital signs, medication list, and assessment',
  'What changed since admission?',
  'Extract allergies and prior surgeries',
]

export const ChatPanel = memo(({ open, onToggle, state, run, serverUrl, onOpenActivity }: ChatPanelProps) => {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [forcedWorkflow, setForcedWorkflow] = useState('')
  /** Which run logs are expanded. Kept here so a failure can open its own without a click. */
  const [openLogs, setOpenLogs] = useState<ReadonlySet<string>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // The workflow catalogue from the topology snapshot. It appears only in the explicit
  // diagnostic override; the normal path asks the pipeline router to choose.
  const pipelines: WorkflowDefinition[] = state.topology.workflows

  // Auto-scroll the message list whenever the message count or status changes.
  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight)
  }, [messages, messages.length])

  // Focus the textarea whenever the panel opens.
  useEffect(() => {
    if (open) textareaRef.current?.focus()
  }, [open])

  // The composer grows to a controlled maximum instead of resizing by hand.
  const fitTextarea = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }

  const setLogOpen = (id: string, open: boolean) =>
    setOpenLogs((prev) => {
      if (prev.has(id) === open) return prev
      const next = new Set(prev)
      if (open) next.add(id)
      else next.delete(id)
      return next
    })

  const handleSend = async () => {
    const text = input.trim()
    if (!text || pending) return

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // The watermark is taken BEFORE the request goes out, so the first event the run
    // produces is already above it. Taking it after would race the feed on a fast run.
    const msg: ChatMessage = {
      id,
      input: text,
      workflow: forcedWorkflow || 'routing…',
      status: 'pending',
      fromSeq: state.lastSeq,
      startedAt: new Date().toISOString(),
      forcedWorkflow: forcedWorkflow || undefined,
    }
    setMessages((prev) => [...prev, msg])
    setInput('')
    setPending(true)
    requestAnimationFrame(fitTextarea)

    try {
      const result = await run(text, forcedWorkflow || undefined)
      const workflow = typeof result === 'object' && result !== null && typeof (result as Record<string, unknown>)['workflow'] === 'string'
        ? String((result as Record<string, unknown>)['workflow'])
        : forcedWorkflow || 'selected workflow'
      const wallMs = typeof result === 'object' && result !== null && 'totalMs' in (result as Record<string, unknown>)
        ? Number((result as Record<string, unknown>)['totalMs'])
        : undefined
      const runId = typeof result === 'object' && result !== null && typeof (result as Record<string, unknown>)['runId'] === 'string'
        ? String((result as Record<string, unknown>)['runId'])
        : undefined
      setMessages((prev) =>
        prev.map((m) =>
          m.id === id ? { ...m, workflow, status: 'done', result, wallMs, runId, endedAt: new Date().toISOString() } : m,
        ),
      )
    } catch (e) {
      // A refusal names its run when the server got far enough to mint one; that id is what
      // makes the log below show the steps that led to the failure rather than the message alone.
      const runId = e instanceof RunFailure ? e.runId : undefined
      setLogOpen(id, true)
      setMessages((prev) =>
        prev.map((m) =>
          m.id === id ? { ...m, status: 'error', error: (e as Error).message, runId, endedAt: new Date().toISOString() } : m,
        ),
      )
    } finally {
      setPending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  const pickPreset = (text: string) => {
    setInput(text)
    textareaRef.current?.focus()
    requestAnimationFrame(fitTextarea)
  }

  const clearMessages = () => {
    setMessages([])
    setOpenLogs(new Set())
  }

  if (!open) {
    return (
      <button className="chat-tab" onClick={onToggle} aria-label="open chat">
        RUN
      </button>
    )
  }

  return (
    <aside className="chat-panel">
      <div className="chat-head">
        <div>
          <span className="chat-title">Run pipeline</span>
          <span className="chat-head-note">Send input and follow its execution</span>
        </div>
        <div className="chat-head-actions">
          {onOpenActivity && (
            <Button variant="ghost" size="sm" onClick={onOpenActivity} aria-label="open activity" className="chat-head-activity">
              <List size={14} aria-hidden="true" />Activity
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onToggle} aria-label="close chat">
            <X size={14} />
          </Button>
        </div>
      </div>

      <details className="chat-options">
        <summary>Run options</summary>
        <div className="chat-target">
          <label className="chat-target-label" htmlFor="chat-workflow">Force workflow</label>
          <select
            id="chat-workflow"
            className="chat-select"
            value={forcedWorkflow}
            onChange={(e) => setForcedWorkflow(e.target.value)}
          >
            <option value="">Automatic routing</option>
            {pipelines.map((workflow) => (
              <option key={workflow.name} value={workflow.name}>
                {workflow.name} ({workflow.steps.map((step) => step.profile).join(' → ')})
              </option>
            ))}
          </select>
        </div>
        <p>For diagnostics only. Forcing a workflow bypasses the router.</p>
      </details>

      {/* Presets — compact actions that say what to do next on their own. */}
      {messages.length === 0 && (
        <div className="chat-presets">
          {PRESETS.map((p) => (
            <button key={p} className="chat-preset" onClick={() => pickPreset(p)} type="button">
              <Sparkles size={12} aria-hidden="true" />{p}
            </button>
          ))}
        </div>
      )}

      {/* Transcript */}
      <div className="chat-scroll" ref={scrollRef}>
        {messages.map((msg, index) => (
          <div key={msg.id} className={cn('chat-msg', msg.status === 'error' && 'chat-msg-err')}>
            <div className="chat-msg-head">
              <span className="chat-msg-profile">{msg.workflow}</span>
              <span className={cn('chat-msg-status', msg.status === 'pending' && 'chat-msg-status-wait')}>
                {msg.status === 'pending' ? 'running…' : msg.status === 'error' ? 'error' : 'done'}
                {msg.wallMs != null && msg.status === 'done' && ` · ${(msg.wallMs / 1000).toFixed(1)}s`}
              </span>
            </div>
            <div className="chat-msg-input">{msg.input}</div>
            {msg.status === 'done' && msg.result != null && (
              // The ending is the reply; the step dump is the working. A run that put both at
              // the same level made the reader scroll three JSON objects to find the sentence
              // the run was for.
              endingOf(msg.result) ? (
                <>
                  <pre className="chat-msg-ending">{endingOf(msg.result)}</pre>
                  <details className="chat-msg-steps">
                    <summary>run detail</summary>
                    <pre className="chat-msg-result">{formatResult(msg.result)}</pre>
                  </details>
                </>
              ) : (
                <pre className="chat-msg-result">{formatResult(msg.result)}</pre>
              )
            )}
            {msg.status === 'error' && (
              <pre className="chat-msg-error">{msg.error}</pre>
            )}

            {/* The run log. Opened for you on a failure — that is the moment it exists for —
                and one click away otherwise. The next run's watermark closes this one's window,
                so a run that is still working keeps filling its log in while you watch it.

                Formatted only while open: the feed re-renders this panel on every batch of
                events, and re-rendering a thousand of them into text for a transcript nobody
                has opened is work the busiest moment of a run cannot spare. */}
            <details
              className="chat-msg-log"
              open={openLogs.has(msg.id)}
              onToggle={(e) => setLogOpen(msg.id, e.currentTarget.open)}
            >
              <summary>run log</summary>
              {openLogs.has(msg.id) && (
                <div className="chat-msg-log-body">
                  <div className="chat-msg-log-actions">
                    <CopyButton
                      label="Copy log"
                      title="Copy this run's full log to the clipboard"
                      text={() => buildLog(msg, messages[index + 1]?.fromSeq, state, serverUrl)}
                    />
                  </div>
                  <pre className="chat-msg-log-text">{buildLog(msg, messages[index + 1]?.fromSeq, state, serverUrl)}</pre>
                </div>
              )}
            </details>
          </div>
        ))}
        {pending && (
          <div className="chat-msg chat-msg-pending">
            <span className="chat-msg-status chat-msg-status-wait">pipeline working…</span>
          </div>
        )}
      </div>

      {/* Footer: composer + send */}
      <div className="chat-foot">
        <textarea
          ref={textareaRef}
          className="chat-textarea"
          placeholder="Paste text or enter an extraction request…"
          rows={2}
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            fitTextarea()
          }}
          onKeyDown={handleKeyDown}
        />
        <div className="chat-foot-actions">
          {messages.length > 0 && (
            <Button variant="ghost" size="sm" onClick={clearMessages} type="button">
              clear
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleSend}
            disabled={pending || !input.trim()}
          >
            <Send size={13} /> Run
          </Button>
        </div>
      </div>
    </aside>
  )
})

/* ------------------------------------------------------------------ helpers */

/**
 * One message's log, joined from what the POST returned and what the feed carried.
 *
 * `toSeq` is the NEXT run's watermark: it bounds this run's window so a later run's events
 * cannot be read as part of this one. The newest run has no upper bound, which is what
 * lets a pending run's log fill in live while it is still working.
 */
const buildLog = (msg: ChatMessage, toSeq: number | undefined, state: ProjectState, serverUrl: string): string =>
  formatRunLog(
    {
      input: msg.input,
      workflow: msg.workflow,
      forcedWorkflow: msg.forcedWorkflow,
      runId: msg.runId,
      startedAt: msg.startedAt,
      endedAt: msg.endedAt,
      status: msg.status,
      result: msg.result,
      error: msg.error,
      serverUrl,
      fromSeq: msg.fromSeq,
      toSeq,
    },
    state.eventLog,
  )

/**
 * The run's ending, when the workflow declared a terminal step that produced one.
 *
 * Read from the `ending` field the server sets rather than recognised by shape: a client that
 * shape-matched a report would start rendering any step that happened to look similar, and
 * would stop rendering this one the day a field is added to it.
 */
const endingOf = (r: unknown): string | undefined => {
  if (r == null || typeof r !== 'object' || Array.isArray(r)) return undefined
  const ending = (r as Record<string, unknown>)['ending']
  return typeof ending === 'string' && ending.trim().length > 0 ? ending : undefined
}

const formatResult = (r: unknown): string => {
  if (r == null) return ''
  if (typeof r === 'string') return r
  if (typeof r === 'number' || typeof r === 'boolean') return String(r)
  if (Array.isArray(r)) return r.map(formatResult).join('\n\n')
  try {
    const obj = r as Record<string, unknown>
    const stoppedEarly = obj['stoppedEarly']
    const totalMs = obj['totalMs']
    const parts: string[] = []
    if (stoppedEarly) parts.push('[stopped early]')
    if (totalMs != null) parts.push(`total ${(Number(totalMs) / 1000).toFixed(1)}s`)

    // Pipeline result: show each step and its output.
    if (Array.isArray(obj['steps'])) {
      const steps = obj['steps'] as Array<Record<string, unknown>>
      for (const step of steps) {
        const name = String(step['name'] ?? step['profile'] ?? '?')
        const profile = String(step['profile'] ?? '?')
        const ok = step['ok'] !== false
        const t = step['wallMs'] != null ? ` ${(Number(step['wallMs']) / 1000).toFixed(1)}s` : ''
        const err = ok ? '' : ` — ${String(step['error'] ?? 'step failed')}`
        parts.push(`--- ${name} (${profile})${t}${err} ---`)
        const stepOutput = step['output']
        if (stepOutput != null) {
          parts.push(typeof stepOutput === 'string' ? stepOutput : JSON.stringify(stepOutput, null, 2))
        }
      }
      return parts.join('\n') || JSON.stringify(r, null, 2)
    }

    // Single-profile result: show output directly.
    const output = obj['output'] ?? obj['final']
    if (output != null) {
      parts.push(typeof output === 'string' ? output : JSON.stringify(output, null, 2))
    }
    return parts.join('\n') || JSON.stringify(r, null, 2)
  } catch {
    return JSON.stringify(r, null, 2)
  }
}
