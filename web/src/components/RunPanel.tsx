/**
 * RunPanel — send a prompt into the alkor pipeline and watch the
 * response stream back in, the same way the CLI does.
 *
 * It is the rail's first tab, not a surface of its own: the rail owns the title,
 * the width, and the closing. The graph is the primary view; this is the command
 * surface that feeds work into it.
 */
import { memo, useEffect, useRef, useState } from 'react'
import { ChevronUp, FolderOpen, LoaderCircle, Send } from 'lucide-react'
import {
  type WorkflowDefinition,
  type ProjectState,
} from '../../../src/monitor/state.ts'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from './ui/dropdown-menu'
import { CopyButton } from './CopyButton'
import { CorpusPicker } from './CorpusPicker'
import { formatRunLog } from '../lib/runlog.ts'
import { RunFailure } from '../hooks/useAlkor.ts'
import { cn } from '../lib/utils'
import type { CorpusDocument } from '../lib/corpus.ts'

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

interface RunPanelProps {
  state: ProjectState
  run: (input: string, workflow?: string) => Promise<unknown>
  /** Where the run was sent — recorded in the log so a pasted one names its server. */
  serverUrl: string
}

export const RunPanel = memo(({ state, run, serverUrl }: RunPanelProps) => {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [forcedWorkflow, setForcedWorkflow] = useState('')
  /** Which run logs are expanded. Kept here so a failure can open its own without a click. */
  const [openLogs, setOpenLogs] = useState<ReadonlySet<string>>(new Set())
  const [pickerOpen, setPickerOpen] = useState(false)
  /** The pack document currently in the box, so the composer can say where the text is from. */
  const [loaded, setLoaded] = useState<CorpusDocument | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  /** A run this dashboard is watching but did not send from here. */
  const inFlight = [...state.runs.values()].find((r) => r.status === 'started')

  // The workflow catalogue from the topology snapshot. It appears only in the explicit
  // diagnostic override; the normal path asks the pipeline router to choose.
  const pipelines: WorkflowDefinition[] = state.topology.workflows

  // Auto-scroll the message list whenever the message count or status changes.
  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight)
  }, [messages, messages.length])

  // The rail mounts this tab only while it is showing; focusing on mount puts the caret
  // where the operator was going anyway.
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

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
    setLoaded(null)
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

  const clearMessages = () => {
    setMessages([])
    setOpenLogs(new Set())
  }

  const loadDocument = (text: string, doc: CorpusDocument) => {
    setInput(text)
    setLoaded(doc)
    setPickerOpen(false)
    textareaRef.current?.focus()
    requestAnimationFrame(fitTextarea)
  }

  return (
    <div className="runpanel">
      {/* The empty state is one action and one condition. A real note from the pack is the
          better first test, so browsing the corpus is the only thing standing here; the
          composer beside it is where anything typed goes. */}
      {messages.length === 0 && (
        /* Centred in its own column rather than pinned to the top of an 800px void: an
           empty panel that hugs the ceiling reads as one that failed to load. */
        <div className="chat-empty">
          <div className="chat-presets">
            {/* This panel used to say nothing at all while a run was executing, which made
                the rail's first tab silent about the one thing the whole screen was
                watching. It does not duplicate the canvas — it says where to look, and
                what sending a note would do instead. */}
            {inFlight && (
              <div className="chat-empty-live" role="status" aria-live="polite">
                <LoaderCircle className="status-spin" aria-hidden="true" />
                <span>
                  <b>{inFlight.profile}</b> is running now — follow it on the canvas.
                  Sending a note here starts a second run.
                </span>
              </div>
            )}
            <button className="chat-preset is-corpus" onClick={() => setPickerOpen(true)} type="button">
              <FolderOpen size={12} aria-hidden="true" />Browse the pack corpus
            </button>
            {/* Read once, by the person who needs it: someone meeting this screen cold, with
                sepsis and shock lanes on the canvas, has no other way to learn that none of
                this is clinical evidence. PRODUCT.md requires the caveat to travel with the
                output, and the empty state is the one place it costs the operator nothing. */}
            <p className="chat-presets-note">
              <b>Research and educational use only.</b> Not a medical device, not clinical
              decision support, and not to be used to make medical decisions. The pack corpus
              contains no patients — every case in it is synthetic.
            </p>
          </div>
        </div>
      )}

      {messages.length > 0 && (
        <div className="chat-scroll-actions">
          <Button variant="ghost" size="sm" onClick={clearMessages} type="button">
            Clear transcript
          </Button>
        </div>
      )}

      {/* Transcript.
          `is-idle` collapses this region to nothing while there is no transcript. It and
          the empty state are siblings and both used to claim `flex: 1`, so the column was
          split in half and the "centred" empty block came to rest in the middle of the TOP
          half with a ~560px void beneath it. Centring was never the problem; having two
          things centre inside two half-columns was. */}
      <div className={`chat-scroll${messages.length === 0 ? ' is-idle' : ''}`} ref={scrollRef}>
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

      {/* Composer. The routing override sits with it rather than at the top of the panel:
          it is a property of the run about to be sent, not a setting of the workspace. */}
      <div className="chat-foot">
        {/* What is in the box, when it came from the corpus rather than from the operator.
            Worth saying: two shock notes differ by one word, and a run whose input you
            cannot name is a result you cannot repeat. */}
        {loaded && (
          <p className="chat-loaded">
            <FolderOpen aria-hidden="true" />
            <span className="chat-loaded-name">{loaded.case}</span>
            <span className="chat-loaded-meta">{loaded.kind} · {loaded.lines} lines</span>
          </p>
        )}
        <textarea
          ref={textareaRef}
          className="chat-textarea"
          placeholder="Paste a note, or ask for an extraction…"
          aria-label="Run input"
          rows={2}
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            // Typed-over text is the operator's own, whatever it started as.
            if (loaded) setLoaded(null)
            fitTextarea()
          }}
          onKeyDown={handleKeyDown}
        />
        <div className="chat-foot-actions">
          <button
            type="button"
            className="chat-corpus-btn"
            onClick={() => setPickerOpen(true)}
            title="Load a note, transcript, or exam payload from the contract packs"
          >
            <FolderOpen aria-hidden="true" />Corpus
          </button>
          {/* One menu, inline: a disclosure around a single control only hid the
              setting behind a copy of its own value. It opens upward — the footer
              sits at the bottom of the rail, so there is no room below it. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn('chat-workflow-trigger', forcedWorkflow && 'is-forced')}
                title={forcedWorkflow
                  ? 'Forced workflow — bypasses the router. Diagnostics only.'
                  : 'The router picks the workflow for each run.'}
              >
                {forcedWorkflow || 'Workflow: automatic'}
                <ChevronUp className="text-muted-foreground" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="max-h-80 overflow-y-auto">
              <DropdownMenuCheckboxItem
                checked={!forcedWorkflow}
                onCheckedChange={() => setForcedWorkflow('')}
              >
                Automatic — the router picks
              </DropdownMenuCheckboxItem>
              {pipelines.map((workflow) => (
                <DropdownMenuCheckboxItem
                  key={workflow.name}
                  checked={workflow.name === forcedWorkflow}
                  onCheckedChange={() => setForcedWorkflow(workflow.name)}
                >
                  {workflow.name} ({workflow.steps.map((step) => step.profile).join(' → ')})
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {forcedWorkflow && <span className="chat-workflow-note">bypasses the router</span>}
          <Button
            size="sm"
            onClick={handleSend}
            disabled={pending || !input.trim()}
          >
            <Send size={13} /> Run
          </Button>
        </div>
      </div>

      {pickerOpen && (
        <CorpusPicker serverUrl={serverUrl} onPick={loadDocument} onClose={() => setPickerOpen(false)} />
      )}
    </div>
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
