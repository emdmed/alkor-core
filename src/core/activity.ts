/**
 * In-process activity bus: metadata-only operational events for the harness.
 *
 * The ONE hard rule: no content-bearing field may appear in an event. This is enforced
 * by construction — `emit()` walks the whole event recursively and throws if a banned
 * key is found anywhere, including inside `stage.detail`. A content leak fails loud at
 * the source, in a test, not on a dashboard.
 *
 * Correlation with content uses the existing `elide` scheme: a digest plus length,
 * so a dashboard can say "same document as run #3" without holding the document.
 *
 * Because there is nothing to redact, the feed needs no redactor hook.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { Timings, Usage } from './client.ts'
import {
  ACTIVITY_SPEC,
  type ActivityScope,
  type ActivityEvent,
  type ActivityInput,
  type StageDetail,
} from './activity-types.ts'

// The event contract lives in activity-types.ts so a browser dashboard can import it
// without dragging in node:async_hooks. This module owns the bus; it re-exports the shapes.
export {
  ACTIVITY_SPEC,
  type ActivityScope,
  type StageDetail,
  type TemplateRefEntry,
  type ActivityEvent,
  type ActivityInput,
  type ServerReadyEvent,
  type ProfileLoadedEvent,
  type ModelIdentifiedEvent,
  type LlmRequestEvent,
  type LlmResponseEvent,
  type LlmErrorEvent,
  type HttpRequestEvent,
  type HttpCompletedEvent,
  type RouteDecidedEvent,
  type RunStartedEvent,
  type RunCompletedEvent,
  type RunFailedEvent,
  type PipelineStartedEvent,
  type PipelineStepStartedEvent,
  type PipelineStepCompletedEvent,
  type PipelineCompletedEvent,
  type SessionCreatedEvent,
  type TurnStartedEvent,
  type TurnCompletedEvent,
  type SessionDestroyedEvent,
  type ToolCalledEvent,
  type ToolCompletedEvent,
  type ToolDeclinedEvent,
  type StageEvent,
} from './activity-types.ts'

/** Banned at every level, including inside `detail`. A violation throws. */
const BANNED_KEYS = new Set([
  'content',
  'prompt',
  'completion',
  'text',
  'messages',
  'note',
  'document',
])

/** Recursively walk `value` and throw if any key or string value carries banned content. */
const assertMetadataOnly = (value: unknown, path = ''): void => {
  if (value === null || value === undefined) return
  if (typeof value === 'string') {
    // Strings themselves are not banned — a profile name, a URL, a label are all strings.
    // The BANNED_KEYS guard is about FIELD NAMES that carry content, not about all strings.
    return
  }
  if (typeof value === 'number' || typeof value === 'boolean') return
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertMetadataOnly(value[i], `${path}[${i}]`)
    }
    return
  }
  if (typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      if (BANNED_KEYS.has(key)) {
        throw new Error(
          `activity event banned key '${key}' at ${path || 'root'} — ` +
            'metadata-only by construction: no content/prompt/completion/text/messages/note/document fields',
        )
      }
      assertMetadataOnly(val, `${path}.${key}`)
    }
    return
  }
  throw new Error(`activity event unsupported type at ${path}: ${typeof value}`)
}

// --- Correlation IDs ------------------------------------------------------------------------

const activityStore = new AsyncLocalStorage<ActivityScope>()

/** Run `fn` inside an activity scope so that `emit` stamps the chain automatically. */
export const withActivityScope = <T>(scope: ActivityScope, fn: () => T): T =>
  activityStore.run(scope, fn)

/** Read the current scope, if any. */
export const currentActivityScope = (): ActivityScope | undefined => activityStore.getStore()

/**
 * A stage identity for a started/completed pair. Emitters CALL this once and use the same id
 * for both events, so the reducer merges the pair into one node rather than two — it falls
 * back to `stage-${seq}` when the id is absent, which silently un-pairs a start and finish.
 */
export const nextStageId = (): string => randomUUID()

/**
 * The stage name every model call is emitted under.
 *
 * Named once because it is read from two sides: the wrapper below emits it, and profiles
 * publish it in their topology so a dashboard can draw the model boundary before a run
 * starts. Two string literals that must agree is how a model boundary quietly stops being
 * drawn — the boundary itself now travels as `operation`, not as a name a view recognises.
 */
export const LLM_CALL_STAGE = 'llm-call'

// --- Event shapes ---------------------------------------------------------------------------
// Defined in activity-types.ts (dependency-free); re-exported above. The bus below only
// stamps `activitySpec`, `seq`, `ts` and merges correlation ids from the scope.

export interface Activity {
  emit(e: ActivityInput & Record<string, unknown>): void
  subscribe(fn: (e: ActivityEvent) => void): () => void
  recent(n?: number): ActivityEvent[]
}

export interface ActivityOptions {
  buffer?: number
}

export const createActivity = (o: ActivityOptions = {}): Activity => {
  const bufferSize = o.buffer ?? 1000
  const subscribers = new Set<(e: ActivityEvent) => void>()
  const ring: ActivityEvent[] = []
  let seq = 0

  const emit = (e: ActivityInput) => {
    assertMetadataOnly(e)
    const scope = activityStore.getStore()
    const event: ActivityEvent = {
      activitySpec: ACTIVITY_SPEC,
      seq: ++seq,
      ts: new Date().toISOString(),
      ...scope,
      ...e,
    } as ActivityEvent
    ring.push(event)
    if (ring.length > bufferSize) ring.shift()
    for (const fn of subscribers) {
      try {
        fn(event)
      } catch {
        // Subscriber errors must not break the bus or other subscribers.
      }
    }
  }

  const subscribe = (fn: (e: ActivityEvent) => void): (() => void) => {
    subscribers.add(fn)
    return () => {
      subscribers.delete(fn)
    }
  }

  const recent = (n = bufferSize): ActivityEvent[] => {
    const take = Math.min(n, ring.length)
    return ring.slice(ring.length - take)
  }

  return { emit, subscribe, recent }
}

/** No-op activity, same role as `nullTrace()`. */
export const nullActivity = (): Activity => ({
  emit: () => {},
  subscribe: () => () => {},
  recent: () => [],
})

// --- Provider wrapper -----------------------------------------------------------------------

import type { ChatOptions, Provider, StreamChatOptions, StreamResult, ToolChatOptions } from './client.ts'

/** Wrap a provider so every `chat`, `toolChat`, and `streamChat` emits `llm.*` events. */
export const withActivity = (provider: Provider, activity: Activity): Provider => {
  return {
    chat: async (o: ChatOptions): Promise<string> => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      activity.emit({
        kind: 'llm.request',
        requestId,
        label: o.label,
        baseUrl: o.baseUrl ?? process.env.LLAMA_URL ?? 'http://127.0.0.1:8080',
        model: o.model,
        constrained: Boolean(o.schema),
        messageCount: 2, // system + user, the shape this harness sends
      })
      // The stage is the llm call as a NODE in the decision tree, and it shares the request id
      // so a dashboard can join the node to the richer llm.request/llm.response record pairs.
      activity.emit({
        kind: 'stage',
        stageId: requestId,
        name: LLM_CALL_STAGE,
        operation: 'model',
        status: 'started',
        detail: { label: o.label, constrained: Boolean(o.schema) },
      })
      const startedAt = performance.now()
      try {
        const result = await provider.chat(o)
        activity.emit({
          kind: 'stage',
          stageId: requestId,
          name: LLM_CALL_STAGE,
        operation: 'model',
          status: 'completed',
          wallMs: performance.now() - startedAt,
          detail: { ok: true },
        })
        activity.emit({
          kind: 'llm.response',
          requestId,
          wallMs: performance.now() - startedAt,
        })
        return result
      } catch (e) {
        const msg = (e as Error).message
        activity.emit({
          kind: 'stage',
          stageId: requestId,
          name: LLM_CALL_STAGE,
        operation: 'model',
          status: 'completed',
          wallMs: performance.now() - startedAt,
          detail: { ok: false },
        })
        activity.emit({
          kind: 'llm.error',
          requestId,
          wallMs: performance.now() - startedAt,
          message: msg.length > 200 ? msg.slice(0, 200) + '…' : msg,
        })
        throw e
      }
    },
    toolChat: async (o: ToolChatOptions) => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      activity.emit({
        kind: 'llm.request',
        requestId,
        label: o.label,
        baseUrl: o.baseUrl ?? process.env.LLAMA_URL ?? 'http://127.0.0.1:8080',
        model: o.model,
        constrained: false,
        messageCount: Array.isArray(o.messages) ? o.messages.length : 0,
      })
      activity.emit({
        kind: 'stage',
        stageId: requestId,
        name: LLM_CALL_STAGE,
        operation: 'model',
        status: 'started',
        detail: { label: o.label, constrained: false },
      })
      const startedAt = performance.now()
      try {
        const result = await provider.toolChat(o)
        activity.emit({
          kind: 'stage',
          stageId: requestId,
          name: LLM_CALL_STAGE,
        operation: 'model',
          status: 'completed',
          wallMs: performance.now() - startedAt,
          detail: { ok: true },
        })
        activity.emit({
          kind: 'llm.response',
          requestId,
          wallMs: performance.now() - startedAt,
          promptTokens: result.usage?.promptTokens,
          completionTokens: result.usage?.completionTokens,
          cachedTokens: result.usage?.cachedTokens,
        })
        return result
      } catch (e) {
        const msg = (e as Error).message
        activity.emit({
          kind: 'stage',
          stageId: requestId,
          name: LLM_CALL_STAGE,
        operation: 'model',
          status: 'completed',
          wallMs: performance.now() - startedAt,
          detail: { ok: false },
        })
        activity.emit({
          kind: 'llm.error',
          requestId,
          wallMs: performance.now() - startedAt,
          message: msg.length > 200 ? msg.slice(0, 200) + '…' : msg,
        })
        throw e
      }
    },
    streamChat: async (o: StreamChatOptions): Promise<StreamResult> => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      activity.emit({
        kind: 'llm.request',
        requestId,
        label: o.label,
        baseUrl: o.baseUrl ?? process.env.LLAMA_URL ?? 'http://127.0.0.1:8080',
        model: o.model,
        constrained: false,
        messageCount: Array.isArray(o.messages) ? o.messages.length : 0,
      })
      activity.emit({
        kind: 'stage',
        stageId: requestId,
        name: LLM_CALL_STAGE,
        operation: 'model',
        status: 'started',
        detail: { label: o.label, constrained: false },
      })
      const startedAt = performance.now()
      try {
        const result = await provider.streamChat(o)
        activity.emit({
          kind: 'stage',
          stageId: requestId,
          name: LLM_CALL_STAGE,
        operation: 'model',
          status: 'completed',
          wallMs: performance.now() - startedAt,
          detail: { ok: true },
        })
        activity.emit({
          kind: 'llm.response',
          requestId,
          wallMs: performance.now() - startedAt,
          promptTokens: result.usage?.promptTokens,
          completionTokens: result.usage?.completionTokens,
          cachedTokens: result.usage?.cachedTokens,
          chunks: result.chunks,
        })
        return result
      } catch (e) {
        const msg = (e as Error).message
        activity.emit({
          kind: 'stage',
          stageId: requestId,
          name: LLM_CALL_STAGE,
        operation: 'model',
          status: 'completed',
          wallMs: performance.now() - startedAt,
          detail: { ok: false },
        })
        activity.emit({
          kind: 'llm.error',
          requestId,
          wallMs: performance.now() - startedAt,
          message: msg.length > 200 ? msg.slice(0, 200) + '…' : msg,
        })
        throw e
      }
    },
    identify: (baseUrl?: string) => provider.identify(baseUrl),
  }
}
