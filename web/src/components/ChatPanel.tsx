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
import { useEffect, useRef, useState } from 'react'
import { Send, Sparkles, X } from 'lucide-react'
import {
  type PipelineDefinition,
  type ProjectState,
} from '../../../src/tui/state.ts'
import { Button } from './ui/button'
import { cn } from '../lib/utils'

export interface ChatMessage {
  id: string
  input: string
  profile: string
  status: 'pending' | 'done' | 'error'
  result?: unknown
  error?: string
  wallMs?: number
}

interface ChatPanelProps {
  open: boolean
  onToggle: () => void
  state: ProjectState
  run: (profile: string, input: string) => Promise<unknown>
}

const PRESETS = [
  'Vital signs, medication list, and assessment',
  'What changed since admission?',
  'Extract allergies and prior surgeries',
]

export const ChatPanel = ({ open, onToggle, state, run }: ChatPanelProps) => {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [selectedProfile, setSelectedProfile] = useState<string>('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // The list of available pipelines from the topology snapshot. Fall back to
  // profiles with mode === 'pipeline' if the topology is not populated yet.
  const pipelines: PipelineDefinition[] = state.topology.pipelines

  // Auto-select the first pipeline if nothing is selected.
  useEffect(() => {
    if (selectedProfile || pipelines.length === 0) return
    setSelectedProfile(pipelines[0]!.name)
  }, [pipelines, selectedProfile])

  // Auto-scroll the message list whenever the message count or status changes.
  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight)
  }, [messages, messages.length])

  // Focus the textarea whenever the panel opens.
  useEffect(() => {
    if (open) textareaRef.current?.focus()
  }, [open])

  const handleSend = async () => {
    const text = input.trim()
    if (!text || !selectedProfile || pending) return

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const msg: ChatMessage = { id, input: text, profile: selectedProfile, status: 'pending' }
    setMessages((prev) => [...prev, msg])
    setInput('')
    setPending(true)

    try {
      const result = await run(selectedProfile, text)
      const wallMs = typeof result === 'object' && result !== null && 'totalMs' in (result as Record<string, unknown>)
        ? Number((result as Record<string, unknown>)['totalMs'])
        : undefined
      setMessages((prev) =>
        prev.map((m) =>
          m.id === id ? { ...m, status: 'done', result, wallMs } : m,
        ),
      )
    } catch (e) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === id ? { ...m, status: 'error', error: (e as Error).message } : m,
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
  }

  const clearMessages = () => setMessages([])

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
        <Button variant="ghost" size="sm" onClick={onToggle} aria-label="close chat">
          <X size={14} />
        </Button>
      </div>

      {/* Pipeline selector */}
      <div className="chat-target">
        <label className="chat-target-label" htmlFor="chat-profile">pipeline</label>
        <select
          id="chat-profile"
          className="chat-select"
          value={selectedProfile}
          onChange={(e) => setSelectedProfile(e.target.value)}
        >
          {pipelines.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name} ({p.steps.map((s) => s.profile).join(' → ')})
            </option>
          ))}
          {pipelines.length === 0 && <option value="" disabled>no pipelines loaded</option>}
        </select>
      </div>

      {/* Presets */}
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
        {messages.length === 0 && (
          <div className="chat-empty">
            <span className="chat-empty-title">Ready for input</span>
            <span>Choose a starting prompt above or enter your own below.</span>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={cn('chat-msg', msg.status === 'error' && 'chat-msg-err')}>
            <div className="chat-msg-head">
              <span className="chat-msg-profile">{msg.profile}</span>
              <span className={cn('chat-msg-status', msg.status === 'pending' && 'chat-msg-status-wait')}>
                {msg.status === 'pending' ? 'running…' : msg.status === 'error' ? 'error' : 'done'}
                {msg.wallMs != null && msg.status === 'done' && ` · ${(msg.wallMs / 1000).toFixed(1)}s`}
              </span>
            </div>
            <div className="chat-msg-input">{msg.input}</div>
            {msg.status === 'done' && msg.result != null && (
              <pre className="chat-msg-result">
                {formatResult(msg.result)}
              </pre>
            )}
            {msg.status === 'error' && (
              <pre className="chat-msg-error">{msg.error}</pre>
            )}
          </div>
        ))}
        {pending && (
          <div className="chat-msg chat-msg-pending">
            <span className="chat-msg-status chat-msg-status-wait">pipeline working…</span>
          </div>
        )}
      </div>

      {/* Footer: textarea + send */}
      <div className="chat-foot">
        <textarea
          ref={textareaRef}
          className="chat-textarea"
          placeholder="Paste text or enter an extraction request…"
          rows={3}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!selectedProfile}
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
            disabled={pending || !input.trim() || !selectedProfile}
          >
            <Send size={13} /> Run
          </Button>
        </div>
      </div>
    </aside>
  )
}

/* ------------------------------------------------------------------ helpers */

const formatResult = (r: unknown): string => {
  if (r == null) return ''
  if (typeof r === 'string') return r
  if (typeof r === 'number' || typeof r === 'boolean') return String(r)
  if (Array.isArray(r)) return r.map(formatResult).join('\n\n')
  try {
    // Pretty-print the final step if it has one.
    const obj = r as Record<string, unknown>
    const output = obj['output']
    const final = obj['final']
    const stoppedEarly = obj['stoppedEarly']
    const totalMs = obj['totalMs']
    const parts: string[] = []
    if (stoppedEarly) parts.push('[stopped early]')
    if (totalMs != null) parts.push(`total ${(Number(totalMs) / 1000).toFixed(1)}s`)
    const produced = output ?? final
    if (produced != null) {
      parts.push(typeof produced === 'string' ? produced : JSON.stringify(produced, null, 2))
    } else if (Array.isArray(obj['steps'])) {
      const steps = obj['steps'] as Array<Record<string, unknown>>
      for (const step of steps) {
        const name = String(step['name'] ?? step['profile'] ?? '?')
        const ok = step['ok'] !== false
        const t = step['wallMs'] != null ? ` ${((Number(step['wallMs'])) / 1000).toFixed(1)}s` : ''
        const err = ok ? '' : ` — ${String(step['error'] ?? 'step failed')}`
        parts.push(`${ok ? '✓' : '×'} ${name}${t}${err}`)
      }
    }
    return parts.join('\n') || JSON.stringify(r, null, 2)
  } catch {
    return JSON.stringify(r, null, 2)
  }
}
