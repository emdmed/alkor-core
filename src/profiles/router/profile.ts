/**
 * The router profile: mode `router`, no pack, no tools.
 *
 * A router is a classifier that decides which specialist profile should handle a given
 * input. It is the entry point of a multi-model pipeline: the user sends one request,
 * the router names the specialist, and the pipeline delegates.
 *
 * This profile implements both rule-based and model-based routing, and the choice between
 * them is a configuration decision, not a code change. The default is rule-based because it
 * is fast, deterministic, and requires no GPU load. A model-based fallback is available
 * for free-form inputs where rules are insufficient.
 *
 * The router is also a first-class profile: it can be evaluated (`eval`) against a corpus
 * of labelled inputs, and it can be run interactively (`extract --profile router`) to
 * classify a single input. Both paths use the same rules and model, so the eval measures
 * what the interactive path runs.
 */

import type { EvalContext, EvalVerdict, ProfileModule, ReviewContext, ReviewResult } from '../../core/profile.ts'
import { route, type RouteResult, type RouterOptions, type RouteRule } from '../../modes/router.ts'

/** The rules this router uses. Exported so the eval and the interactive path share them. */
export const ROUTER_RULES: RouteRule[] = [
  {
    name: 'vitals-extraction',
    profile: 'clinical',
    keywords: ['bp', 'blood pressure', 'hr', 'heart rate', 'temp', 'temperature', 'spo2', 'oxygen', 'rr', 'respiratory'],
    confidence: 0.9,
  },
  {
    name: 'dictation-transcript',
    profile: 'transcriptor',
    keywords: ['dictation', 'transcribed', 'transcription', 'audio', 'speech', 'spoken'],
    confidence: 0.95,
  },
  // High-confidence marker for explicit documentation requests that override
  // code-context when the task is clearly to record, not to execute.
  {
    name: 'document-request',
    profile: 'transcriptor',
    keywords: ['document this'],
    confidence: 0.96,
  },
  {
    name: 'verification-request',
    profile: 'verifier',
    keywords: ['verify', 'check', 'validate', 'hallucination', 'is this correct', 'provenance'],
    confidence: 0.95,
  },
  {
    name: 'summary-request',
    profile: 'clinical',
    keywords: ['summarise', 'summarize', 'summary', 'overview', 'record', 'history', 'medications'],
    confidence: 0.85,
  },
]

/** Default profile when nothing matches. */
export const ROUTER_DEFAULT = 'clinical'

/** Profiles the model may choose among when the rules are inconclusive. */
const MODEL_PROFILES = ['clinical', 'transcriptor', 'verifier']

/** Build model fallback options from a base URL (from --url or profiles.toml). */
const buildModelFallback = (baseUrl?: string): RouterOptions['model'] | undefined => {
  if (!baseUrl) return undefined
  return {
    baseUrl,
    profiles: MODEL_PROFILES,
    maxTokens: 128,
  }
}

export const PROFILE: ProfileModule = {
  name: 'router',
  mode: 'router',
  needsPack: false,

  async review(ctx: ReviewContext): Promise<ReviewResult> {
    const text = ctx.input.kind === 'text' ? ctx.input.text : `(case ${ctx.input.name})`
    const label = ctx.input.kind === 'text' ? ctx.input.label ?? 'input' : ctx.input.name

    const opts: RouterOptions = {
      input: text,
      rules: ROUTER_RULES,
      defaultProfile: ROUTER_DEFAULT,
    }

    // CLI override takes precedence over profiles.toml.
    if (ctx.options.model) {
      opts.model = ctx.options.model as RouterOptions['model']
    } else {
      const fallback = buildModelFallback(ctx.baseUrl)
      if (fallback) opts.model = fallback
    }

    const result = await route(opts)

    const lines = [
      `=== router · ${label} ===`,
      `route:     ${result.profile}`,
      `confidence: ${(result.confidence * 100).toFixed(0)}%`,
      `reason:    ${result.reason}`,
    ]

    return {
      text: lines.join('\n'),
      ok: result.confidence > 0,
      raw: JSON.stringify(result),
      report: result,
    }
  },

  async runEval(ctx: EvalContext): Promise<EvalVerdict> {
    const { runRouterEvalFromContext } = await import('./eval.ts')
    return runRouterEvalFromContext(ctx)
  },
}
