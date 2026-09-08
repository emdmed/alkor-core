/**
 * Router mode: intent classification that decides which specialist profile should handle
 * a given input.
 *
 * Two implementations are supported, and the choice between them is a profile decision:
 *
 * 1. **Rule-based routing** is fast, deterministic, and requires no model. It matches
 *    keywords, regex patterns, or simple heuristics against the input text. For a clinical
 *    product where the input shapes are well-known — a note, a dictation, a code task —
 *    rules are often sufficient and never hallucinate a route.
 *
 * 2. **Model-based routing** uses a tiny model (0.6-1.8B parameters) with a constrained
 *    schema to classify intent. This is for cases where the boundary between tasks is
 *    fuzzy or where the user input is free-form chat rather than a known document type.
 *
 * The router does not CALL the specialist; it only names it. The pipeline mode composes
 * the router with the specialists it names, and the CLI can run a single routed request
 * by looking up the named profile and running it.
 *
 * A rule-based router is the default because a model that routes wrong is worse than a
 * rule that routes conservatively: a clinical note sent to the coder wastes a GPU load
 * and a timeout, while a rule that defaults to "ask the user" costs nothing.
 */

import { chat, type Provider, type ChatOptions } from '../core/client.ts'

export interface RouteRule {
  /** Human-readable name for the rule, used in diagnostics. */
  name: string
  /** The profile this rule routes to when matched. */
  profile: string
  /** Substrings that, if found in the input, trigger this rule. Case-insensitive. */
  keywords?: string[]
  /** Regular expressions that, if matched, trigger this rule. */
  regex?: RegExp[]
  /** A function that returns true when the input matches this rule. */
  predicate?: (input: string) => boolean
  /**
   * Confidence when this rule matches, 0-1. A rule with confidence 1.0 is definitive;
   * lower values let a second rule overrule it by higher confidence. When no rule matches,
   * the default profile is used with confidence 0.
   */
  confidence?: number
}

export interface RouteResult {
  /** The profile name to dispatch to. */
  profile: string
  /** How certain the router is, 0-1. Rule-based routes are usually 1.0 or 0.0. */
  confidence: number
  /** Why this route was chosen — the rule name, model output, or fallback reason. */
  reason: string
}

export interface RouterOptions {
  /** The input text to classify. */
  input: string
  /** Ordered rules; first match wins unless a later rule has higher confidence. */
  rules?: RouteRule[]
  /** Profile to use when no rule matches and no model is configured. */
  defaultProfile?: string
  /**
   * Model-based routing options. When present, the router falls back to a model call
   * after rules fail to match. The model is asked to classify among the profiles listed
   * in `modelProfiles`, and its answer is constrained by a schema.
   */
  model?: {
    baseUrl?: string
    /** Model name or path, passed through to the llama-server request. */
    model?: string
    /** Profiles the model may choose among. Must be non-empty if model routing is used. */
    profiles: string[]
    systemPrompt?: string
    /** Max tokens for the classification response; 64 is generous for a single choice. */
    maxTokens?: number
  }
  /** A custom LLM provider for model-based fallback; defaults to the built-in HTTP client. */
  provider?: Provider
}

/** Classify input and return the best-matching profile. */
export const route = async (o: RouterOptions): Promise<RouteResult> => {
  const normalized = o.input.trim().toLowerCase()

  // Rule-based pass: evaluate every rule, keep the highest-confidence match.
  let best: RouteResult | undefined
  if (o.rules) {
    for (const rule of o.rules) {
      let matched = false
      if (rule.keywords?.some((k) => normalized.includes(k.toLowerCase()))) matched = true
      if (rule.regex?.some((r) => r.test(o.input))) matched = true
      if (rule.predicate?.(o.input)) matched = true
      if (matched) {
        const confidence = rule.confidence ?? 1.0
        if (!best || confidence > best.confidence) {
          best = { profile: rule.profile, confidence, reason: `rule: ${rule.name}` }
        }
      }
    }
  }

  if (best && best.confidence >= 1.0) return best

  // Model-based fallback ONLY when no rule matched at all.
  // A small model (1.7-1.8B) is unreliable at over-ruling rule-based matches:
  // measured on the router eval, it drops overall accuracy from 98.1% to 77.8%
  // by mis-classifying ambiguous cases that rules handle correctly. The model
  // is only safe as a last-resort for inputs that fall through the rule set.
  if (!best && o.model && o.model.profiles.length > 0) {
    try {
      const modelResult = await modelRoute(o.input, o.model, o.provider)
      if (modelResult.confidence > 0) {
        best = modelResult
      }
    } catch {
      // A model routing failure is not fatal; fall back to the default.
    }
  }

  if (best) return best

  // Nothing matched at all.
  return {
    profile: o.defaultProfile ?? 'unknown',
    confidence: 0,
    reason: o.defaultProfile ? 'default: no rule or model matched' : 'no route: no rules, no model, no default',
  }
}

/** Build a constrained classification request to a small model. */
const modelRoute = async (input: string, model: NonNullable<RouterOptions['model']>, provider?: Provider): Promise<RouteResult> => {
  const profiles = model.profiles
  const system =
    model.systemPrompt ??
    'You are a routing classifier. Given the user input, choose exactly one profile from the list that best describes the task. Respond only with the profile name.'

  const user = `Available profiles: ${profiles.join(', ')}

Input: ${input}

Which profile should handle this input? Respond with ONLY the profile name, nothing else.`

  const schema = {
    type: 'object',
    properties: {
      profile: { type: 'string', enum: profiles },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason: { type: 'string' },
    },
    required: ['profile', 'confidence', 'reason'],
  }

  const raw = await (provider?.chat ?? chat)({
    baseUrl: model.baseUrl,
    systemPrompt: system,
    userPrompt: user,
    label: 'router',
    schema,
    maxTokens: model.maxTokens ?? 128,
    temperature: 0,
  })

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A model that cannot emit valid JSON is not a router; treat as low-confidence fallback.
    const firstMatch = profiles.find((p) => raw.toLowerCase().includes(p.toLowerCase()))
    return {
      profile: firstMatch ?? profiles[0]!,
      confidence: 0.3,
      reason: 'model returned unparseable JSON, best-effort match',
    }
  }

  const r = parsed as Record<string, unknown>
  const profile = typeof r.profile === 'string' && profiles.includes(r.profile) ? r.profile : profiles[0]!
  const confidence = typeof r.confidence === 'number' ? Math.max(0, Math.min(1, r.confidence)) : 0.5
  const reason = typeof r.reason === 'string' ? r.reason : 'model classification'

  return { profile, confidence, reason: `model: ${reason}` }
}


