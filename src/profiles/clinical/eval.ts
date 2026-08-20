/**
 * The clinical profile's eval: one constrained pass per note, one gate.
 *
 * Everything domain-specific comes from the pack — the prompt, the schema, the cases, the
 * sampling and the floor. The harness supplied the transport, the mode and the trace. That
 * separation is what makes the same command meaningful against somebody else's contracts.
 *
 * The run is deliberately sequential rather than concurrent. `cache_prompt` reuses the KV
 * cache of the system prompt across notes, which is worth more than parallelism on a
 * single-slot server, and interleaved traces from a parallel run are much harder to read
 * when a case fails.
 */
import type { Pack } from '../../core/pack.ts'
import type { Trace } from '../../core/trace.ts'
import { serverModel } from '../../core/client.ts'
import { extract } from '../../modes/extract.ts'
import {
  gradedExpectations,
  gradedFields,
  loadSampling,
  loadSettings,
  loadVitalCases,
  vitalPrompt,
  vitalSchema,
} from './contracts.ts'
import { parseVitalSigns } from './extraction.ts'
import { absorb, emptyTally, pct, ratio, scoreCase, scoreFailure, type Miss, type VitalTally } from './scorer.ts'

export interface VitalEvalResult {
  tally: VitalTally
  misses: Miss[]
  floor: number
  recall: number
  cases: number
}

export interface VitalEvalOptions {
  pack: Pack
  baseUrl?: string
  trace: Trace
  constrain: boolean
  /** Run each case N times. Above 1 only means something off temperature 0. */
  runs?: number
}

export const runVitalSignsEval = async (o: VitalEvalOptions): Promise<VitalEvalResult> => {
  const fields = gradedFields(o.pack)
  const settings = loadSettings(o.pack)
  const sampling = loadSampling(o.pack, 'vital_signs')
  const { fieldRecallFloor, cases } = loadVitalCases(o.pack, fields)
  const prompt = vitalPrompt(o.pack)
  const schema = o.constrain ? vitalSchema(o.pack) : undefined

  const total = emptyTally()
  const misses: Miss[] = []
  const runs = Math.max(1, o.runs ?? 1)

  // Ask the server what it is serving rather than reporting what the pack declares. The
  // two differ the moment anyone points --url at a second model, and a result that names
  // the wrong weights is worse than one that names none.
  const served = (await serverModel(o.baseUrl)) ?? '(server did not say)'
  const conditions = {
    model: served,
    declared: o.pack.toml<{ generation?: { id?: string } }>('models').generation?.id,
    baseUrl: o.baseUrl,
    constrained: o.constrain,
    sampling,
    pack: { name: o.pack.name, spec: o.pack.spec },
    cases: cases.length,
    gradedSlots: gradedExpectations(cases),
    runs,
  }
  o.trace.write({ event: 'run', ...conditions })

  console.log(`\n=== Vital signs — ${cases.length} notes, ${gradedExpectations(cases)} graded slots ===`)
  console.log(`model '${served}' · pack '${o.pack.name}' spec ${o.pack.spec} · ` +
    `${o.constrain ? 'constrained' : 'unconstrained'} · ` +
    `temp ${sampling.temperature} · max_tokens ${sampling.max_tokens}${runs > 1 ? ` · ${runs} runs` : ''}\n`)

  for (const c of cases) {
    const note = o.pack.document(c.name)
    for (let run = 0; run < runs; run++) {
      const outcome = await extract({
        systemPrompt: prompt,
        document: note,
        parse: (raw) => parseVitalSigns(raw, fields),
        schema,
        schemaName: settings.vitalSignsSchemaName,
        maxTokens: sampling.max_tokens,
        baseUrl: o.baseUrl,
        label: 'vital_signs',
      })

      const scored = outcome.parsed ? scoreCase(c, outcome.parsed, note) : scoreFailure(c)
      absorb(total, scored.tally)
      misses.push(...scored.misses)

      // The completion itself, not only the tally it produced. A harness whose claim is
      // that nothing has to be taken on faith cannot report 46/46 and keep no record of
      // what the model said — checking a suspiciously perfect score should be reading a
      // file, not re-running the model by hand. `redact` below is what makes this safe to
      // leave on for a pack whose notes are real.
      o.trace.write({
        event: 'case',
        case: c.name,
        class: c.class,
        run,
        ok: Boolean(outcome.parsed),
        error: outcome.error,
        tally: scored.tally,
        misses: scored.misses,
        completion: outcome.raw,
      })

      const t = scored.tally
      const flag = outcome.parsed ? '' : `  FAILED: ${outcome.error?.slice(0, 80)}`
      console.log(
        `${c.name.padEnd(28)} ${c.class.padEnd(17)} ` +
          `detected ${pct(t.detected, t.gradedTotal)} value ${pct(t.valueExact, t.detected)} ` +
          `unit ${pct(t.unitExact, t.detected)} quote ${pct(t.quoteVerified, t.detected)} ` +
          `halluc ${t.hallucinations}${flag}`,
      )
    }
  }

  const recall = ratio(total.detected, total.gradedTotal)

  console.log(`\n${'—'.repeat(78)}`)
  console.log(`detection   ${pct(total.detected, total.gradedTotal)}  <- the gate, floor ${(fieldRecallFloor * 100).toFixed(0)}%`)
  console.log(`value       ${pct(total.valueExact, total.detected)}  of what was detected`)
  console.log(`unit        ${pct(total.unitExact, total.detected)}  of what was detected`)
  console.log(`provenance  ${pct(total.quoteVerified, total.detected)}  raw_text found in the note`)
  console.log(`hallucinations ${total.hallucinations}   failed runs ${total.failedRuns}`)

  if (misses.length) {
    console.log(`\nwhat went wrong (${misses.length}):`)
    for (const m of misses) console.log(`  ${m.reason.padEnd(14)} ${m.case} · ${m.field} — ${m.detail}`)
  }

  return { tally: total, misses, floor: fieldRecallFloor, recall, cases: cases.length }
}
