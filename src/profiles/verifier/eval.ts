/**
 * Verifier catch-rate eval: 30 synthetic cases with injected hallucinations.
 *
 * 20 clean cases  → measure false-positive rate (gate ≤ 5%)
 * 10 error cases  → measure catch rate (gate ≥ 90%)
 *
 * The cases are short clinical snippets so the 1.7B verifier can run them
 * in a single prompt without context-window pressure.
 */

import type { EvalVerdict } from '../../core/profile.ts'
import type { Provider } from '../../core/client.ts'
import type { Pack } from '../../core/pack.ts'
import { extract, type ExtractOutcome } from '../../modes/extract.ts'

interface VerifierTestCase {
  document: string
  extraction: Record<string, unknown>
  expectVerified: boolean
  label: string
  category: 'clean' | 'injected'
}

const CLEAN_CASES: VerifierTestCase[] = [
  {
    document: 'Patient BP 140/90, HR 80.',
    extraction: { bp: { value: '140/90', quote: 'BP 140/90' }, hr: { value: '80', quote: 'HR 80' } },
    expectVerified: true,
    label: 'clean-simple-vitals',
    category: 'clean',
  },
  {
    document: 'Presión arterial 138/86 mmHg, frecuencia 82 lpm.',
    extraction: { bp: { value: '138/86', quote: 'Presión arterial 138/86 mmHg' }, hr: { value: '82', quote: 'frecuencia 82 lpm' } },
    expectVerified: true,
    label: 'clean-spanish',
    category: 'clean',
  },
  {
    document: 'Started ceftriaxone 2 g every 24 hours; review in 48 hours.',
    extraction: { medication: { value: 'ceftriaxone 2 g every 24 hours', quote: 'Started ceftriaxone 2 g every 24 hours; review in 48 hours' } },
    expectVerified: true,
    label: 'clean-medication',
    category: 'clean',
  },
  {
    document: 'Patient reports no chest pain. BP 120/80.',
    extraction: { bp: { value: '120/80', quote: 'BP 120/80' }, chestPain: { value: 'not found', quote: null } },
    expectVerified: true,
    label: 'clean-null-missing',
    category: 'clean',
  },
  {
    document: 'BP 118/76, HR 72, SpO2 96%, Temp 37.0 C.',
    extraction: {
      bp: { value: '118/76', quote: 'BP 118/76' },
      hr: { value: '72', quote: 'HR 72' },
      spo2: { value: '96', quote: 'SpO2 96%' },
      temp: { value: '37.0', quote: 'Temp 37.0 C' },
    },
    expectVerified: true,
    label: 'clean-multiple-vitals',
    category: 'clean',
  },
  {
    document: 'HR 95.',
    extraction: { hr: { value: '95', quote: 'HR 95' } },
    expectVerified: true,
    label: 'clean-single-vital',
    category: 'clean',
  },
  {
    document: '62-year-old male. History of hypertension. Current meds: lisinopril 10 mg daily, metformin 500 mg BID. Vitals: BP 150/95, HR 78, RR 16, SpO2 97% on room air. Physical exam unremarkable.',
    extraction: {
      bp: { value: '150/95', quote: 'BP 150/95' },
      hr: { value: '78', quote: 'HR 78' },
      rr: { value: '16', quote: 'RR 16' },
      spo2: { value: '97', quote: 'SpO2 97% on room air' },
    },
    expectVerified: true,
    label: 'clean-long-note',
    category: 'clean',
  },
  {
    document: 'BP 140/90 mmHg (seated).',
    extraction: { bp: { value: '140/90', quote: 'BP 140/90 mmHg (seated)' } },
    expectVerified: true,
    label: 'clean-punctuation-tolerant',
    category: 'clean',
  },
  {
    document: 'SpO2 96 % on air.',
    extraction: { spo2: { value: '96 %', quote: 'SpO2 96 % on air' } },
    expectVerified: true,
    label: 'clean-spo2',
    category: 'clean',
  },
  {
    document: 'Temperature 38.2 C.',
    extraction: { temp: { value: '38.2 C', quote: 'Temperature 38.2 C' } },
    expectVerified: true,
    label: 'clean-temp',
    category: 'clean',
  },
  {
    document: 'BP 132/88, HR 84, RR 18, SpO2 98 %, Temp 36.8 C.',
    extraction: {
      bp: { value: '132/88', quote: 'BP 132/88' },
      hr: { value: '84', quote: 'HR 84' },
      rr: { value: '18', quote: 'RR 18' },
      spo2: { value: '98 %', quote: 'SpO2 98 %' },
      temp: { value: '36.8 C', quote: 'Temp 36.8 C' },
    },
    expectVerified: true,
    label: 'clean-all-vitals',
    category: 'clean',
  },
  {
    document: 'Patient is asymptomatic. No fever. No cough.',
    extraction: { bp: { value: 'not found', quote: null }, temp: { value: 'not found', quote: null } },
    expectVerified: true,
    label: 'clean-not-found-missing',
    category: 'clean',
  },
  {
    document: 'Labs: glucose 95, creatinine 1.1, sodium 140.',
    extraction: {
      glucose: { value: '95', quote: 'glucose 95' },
      creatinine: { value: '1.1', quote: 'creatinine 1.1' },
      sodium: { value: '140', quote: 'sodium 140' },
    },
    expectVerified: true,
    label: 'clean-labs',
    category: 'clean',
  },
  {
    document: 'Weight 70 kg, height 175 cm.',
    extraction: { weight: { value: '70', quote: 'Weight 70 kg' }, height: { value: '175', quote: 'height 175 cm' } },
    expectVerified: true,
    label: 'clean-anthro',
    category: 'clean',
  },
  {
    document: 'Meds: aspirin 81 mg, atorvastatin 40 mg, lisinopril 10 mg.',
    extraction: {
      med1: { value: 'aspirin 81 mg', quote: 'aspirin 81 mg' },
      med2: { value: 'atorvastatin 40 mg', quote: 'atorvastatin 40 mg' },
      med3: { value: 'lisinopril 10 mg', quote: 'lisinopril 10 mg' },
    },
    expectVerified: true,
    label: 'clean-multiple-meds',
    category: 'clean',
  },
  {
    document: 'BP 128/82 mmHg.',
    extraction: { bp: { value: '128/82', quote: 'BP 128/82 mmHg' } },
    expectVerified: true,
    label: 'clean-unit-in-quote',
    category: 'clean',
  },
  {
    document: 'RR 20.',
    extraction: { rr: { value: '20', quote: 'RR 20' } },
    expectVerified: true,
    label: 'clean-rr',
    category: 'clean',
  },
  {
    document: 'Patient is feeling well today. No complaints.',
    extraction: {},
    expectVerified: true,
    label: 'clean-empty-extraction',
    category: 'clean',
  },
  {
    document: 'BP 145/92. No other vitals recorded.',
    extraction: { bp: { value: '145/92', quote: 'BP 145/92' }, hr: { value: 'not found', quote: null } },
    expectVerified: true,
    label: 'clean-partial-missing',
    category: 'clean',
  },
  {
    document: 'BP 110/70, HR 60, SpO2 99%, Temp 36.5, RR 12.',
    extraction: {
      bp: { value: '110/70', quote: 'BP 110/70' },
      hr: { value: '60', quote: 'HR 60' },
      spo2: { value: '99', quote: 'SpO2 99%' },
      temp: { value: '36.5', quote: 'Temp 36.5' },
      rr: { value: '12', quote: 'RR 12' },
    },
    expectVerified: true,
    label: 'clean-edge-numbers',
    category: 'clean',
  },
]

const INJECTED_CASES: VerifierTestCase[] = [
  {
    document: 'Patient BP 120/80, HR 80.',
    extraction: { bp: { value: '120/80', quote: 'HR 120/80' }, hr: { value: '80', quote: 'HR 80' } },
    expectVerified: false,
    label: 'injected-wrong-quote-text',
    category: 'injected',
  },
  {
    document: 'Patient BP 120/80, HR 80.',
    extraction: { bp: { value: '130/90', quote: 'BP 120/80' }, hr: { value: '80', quote: 'HR 80' } },
    expectVerified: false,
    label: 'injected-value-contradicts-quote',
    category: 'injected',
  },
  {
    document: 'Started ceftriaxone 2 g every 24 hours.',
    extraction: { medication: { value: 'aspirin 81 mg', quote: 'Started ceftriaxone 2 g every 24 hours' } },
    expectVerified: false,
    label: 'injected-completely-wrong-value',
    category: 'injected',
  },
  {
    document: 'Patient BP 140/90.',
    extraction: { bp: { value: '140/90', quote: 'BP 140/90' }, hr: { value: '80', quote: 'HR 80' } },
    expectVerified: false,
    label: 'injected-missing-field-claimed',
    category: 'injected',
  },
  {
    document: 'Patient BP 140/90, HR 80.',
    extraction: { bp: { value: '140/90', quote: 'BP 140/90' }, hr: { value: '82', quote: 'HR 82' } },
    expectVerified: false,
    label: 'injected-modified-quote-value',
    category: 'injected',
  },
  {
    document: 'Patient BP 140/90.',
    extraction: { bp: { value: '120/80', quote: 'BP 140/90' } },
    expectVerified: false,
    label: 'injected-unsupported-value',
    category: 'injected',
  },
  {
    document: 'Patient BP 140/90, HR 80.',
    extraction: { bp: { value: '140/90', quote: 'BP 140/90' }, hr: { value: '80', quote: 'HR 80' }, spo2: { value: '96', quote: 'SpO2 96' } },
    expectVerified: false,
    label: 'injected-hallucinated-field',
    category: 'injected',
  },
  {
    document: 'Labs: glucose 95.',
    extraction: { glucose: { value: '200', quote: 'glucose 95' } },
    expectVerified: false,
    label: 'injected-fabricated-lab-value',
    category: 'injected',
  },
  {
    document: 'Ceftriaxone 2 g IV.',
    extraction: { medication: { value: 'ceftriaxone 10 g', quote: 'Ceftriaxone 2 g IV' } },
    expectVerified: false,
    label: 'injected-wrong-dose',
    category: 'injected',
  },
  {
    document: 'Patient BP 140/90, HR 80.',
    extraction: { bp: { value: '140/90', quote: 'BP 140/90' }, hr: { value: '80', quote: 'HR 80' }, allergies: { value: 'penicillin', quote: 'allergies: penicillin' } },
    expectVerified: false,
    label: 'injected-invented-field',
    category: 'injected',
  },
]

const ALL_CASES = [...CLEAN_CASES, ...INJECTED_CASES]

export const runVerifierEval = async (opts: {
  pack: Pack
  baseUrl?: string
  provider?: Provider
}): Promise<EvalVerdict> => {
  const { pack, baseUrl } = opts
  const prompt = pack.read('prompt')
  const schema = pack.json('schema') as object
  const schemaName = String(pack.name ?? 'verification')

  let cleanCorrect = 0
  let injectedCorrect = 0
  const results: string[] = []
  const detailLines: string[] = []

  for (const test of ALL_CASES) {
    const outcome: ExtractOutcome<unknown> = await extract({
      systemPrompt: pack.read('system') ?? 'You are a verification assistant.',
      document: `${prompt}\n\n--- ORIGINAL DOCUMENT ---\n${test.document}\n\n--- EXTRACTION TO VERIFY ---\n${JSON.stringify(test.extraction, null, 2)}\n\n--- END ---`,
      parse: (raw: string) => JSON.parse(raw),
      schema,
      schemaName,
      baseUrl,
      maxTokens: 2048,
      temperature: 0,
      chatTemplateKwargs: { enable_thinking: true },
      provider: opts.provider,
    })

    const parsed = outcome.parsed as Record<string, unknown> | undefined
    const verified = Boolean(parsed?.verified)
    const pass = verified === test.expectVerified

    if (test.category === 'clean') {
      if (pass) cleanCorrect++
    } else {
      if (pass) injectedCorrect++
    }

    const flag = pass ? 'PASS' : 'FAIL'
    const line = `  ${flag}  [${test.category}] ${test.label.padEnd(32)} → verified=${verified} (expected ${test.expectVerified})`
    results.push(line)

    if (!pass) {
      const issues = Array.isArray(parsed?.issues) ? (parsed?.issues as unknown[]) : []
      detailLines.push(`  ${line}`)
      for (const issue of issues) {
        const i = issue as Record<string, unknown>
        detailLines.push(`       issue: ${i.field ?? 'unknown'} / ${i.issue ?? 'unknown'} / ${i.severity ?? 'unknown'}`)
      }
      if (outcome.error) {
        detailLines.push(`       parse error: ${outcome.error}`)
      }
    }
  }

  const cleanTotal = CLEAN_CASES.length
  const injectedTotal = INJECTED_CASES.length
  const fpCount = cleanTotal - cleanCorrect
  const fnCount = injectedTotal - injectedCorrect

  const fpRate = cleanTotal > 0 ? fpCount / cleanTotal : 0
  const catchRate = injectedTotal > 0 ? injectedCorrect / injectedTotal : 0

  const fpGate = 0.05 // ≤ 5%
  const catchGate = 0.90 // ≥ 90%

  const fpPass = fpRate <= fpGate
  const catchPass = catchRate >= catchGate

  const summaryLines = [
    `${cleanCorrect}/${cleanTotal} clean cases correct (FP rate ${(fpRate * 100).toFixed(1)}% vs ≤${(fpGate * 100).toFixed(0)}% ${fpPass ? '✓' : '✗'})`,
    `${injectedCorrect}/${injectedTotal} injected errors caught (catch rate ${(catchRate * 100).toFixed(1)}% vs ≥${(catchGate * 100).toFixed(0)}% ${catchPass ? '✓' : '✗'})`,
    ...results,
  ]

  if (detailLines.length > 0) {
    summaryLines.push('')
    summaryLines.push('Failure details:')
    summaryLines.push(...detailLines)
  }

  return {
    pass: fpPass && catchPass,
    summary: summaryLines.join('\n'),
  }
}
