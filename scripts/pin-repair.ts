#!/usr/bin/env node
/**
 * Pin the repair pass's two halves so a second runtime can be compared against them.
 *
 *   node scripts/pin-repair.ts --pack packs/clinical --out ../medical-extraction-app/fixtures/reference
 *
 * The same argument as `pin-body.ts`, one call later. A repair is a briefing built from a
 * reading and a verdict reached on a reply, and BOTH are places two implementations can agree
 * about the completion and disagree about everything that matters — which item was offered,
 * what the transcript said was wrong with it, and whether the proposal was strictly better.
 * Pinning them makes that comparison a string diff instead of a live run nobody repeats.
 *
 * The case is synthetic and deliberately so: it is chosen to contain one of each fault the pass
 * can be handed — a quote that is absent, a text that introduces a word, and a dose that is real
 * but lives in the next sentence — and one proposal of each verdict the applier can reach:
 * accepted, refused for not verifying, refused for changing the subject, and confessed.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { loadPack } from '../src/core/pack.ts'
import { loadSettings } from '../src/profiles/clinical/settings.ts'
import { readingFromItems, verifyReading, tallyReviewed } from '../src/profiles/clinical/review-transcript.ts'
import { applyRepair, needsRepair, repairBriefing, type Repair } from '../src/profiles/clinical/repair.ts'

const { values } = parseArgs({ options: { pack: { type: 'string', default: 'packs/clinical' }, out: { type: 'string' } } })
if (!values.out) {
  console.error('pin-repair needs --out DIR')
  process.exit(2)
}
const pack = loadPack(values.pack!)
const { quoteVerification: QUOTE, textDerivation: DERIVE } = loadSettings(pack)

const document =
  'Hola, yo tengo un paciente de 28 años con antecedentes de hipertensión, está medicado con ' +
  'enalapril y amblodipina. En alapril 2.5 miligramos cada 8 horas. Viene a control de salud, ' +
  'así que lo cito de vuelta en dos meses.'

/** A first-pass reading carrying one of every fault the repair pass can be handed. */
const reading = {
  presenting_complaint: { quote: 'Viene a control de salud', text: 'control de salud' },
  history: [{ quote: 'tiene antecedentes de hipertensión', text: 'hipertensión' }],
  plan: [{ quote: 'lo cito de vuelta en dos meses', text: 'revisión en dos meses' }],
  current_medication: [
    { quote: 'está medicado con enalapril y amblodipina', text: 'enalapril', dose: '2.5 miligramos cada 8 horas' },
    { quote: 'toma amblodipina', text: 'amblodipina', dose: null },
  ],
}

/** One proposal per verdict the applier can reach. Order matches the numbered briefing. */
const repairs: Repair[] = [
  // 1 · history — accepted: the real span, copied.
  { item: 1, found: true, quote: 'con antecedentes de hipertensión', text: 'hipertensión', dose: null },
  // 2 · plan — accepted: the invented word deleted rather than the span widened.
  { item: 2, found: true, quote: 'lo cito de vuelta en dos meses', text: 'cito de vuelta en dos meses', dose: null },
  // 3 · enalapril — REFUSED: two real fragments stitched with the words between them dropped.
  {
    item: 3,
    found: true,
    quote: 'está medicado con enalapril y amblodipina 2.5 miligramos cada 8 horas',
    text: 'enalapril',
    dose: '2.5 miligramos cada 8 horas',
  },
  // 4 · amblodipina — REFUSED: verifies perfectly, and is a different drug.
  { item: 4, found: true, quote: 'está medicado con enalapril y amblodipina', text: 'enalapril', dose: null },
]

const items = verifyReading(reading, document, QUOTE, DERIVE)
const failed = items.filter(needsRepair)
const briefing = repairBriefing(document, failed)

const after = items.slice()
const tally = { offered: failed.length, accepted: 0, refused: 0, confessed: 0, unanswered: 0 }
failed.forEach((f, n) => {
  const proposal = repairs.find((r) => r.item === n + 1)
  if (!proposal) return void tally.unanswered++
  if (!proposal.found) return void tally.confessed++
  const repaired = applyRepair(f, proposal, document, QUOTE, DERIVE)
  if (repaired) {
    after[items.indexOf(f)] = repaired
    tally.accepted++
  } else {
    tally.refused++
  }
})

const out = values.out!
writeFileSync(join(out, 'repair.case.json'), `${JSON.stringify({ document, reading }, null, 2)}\n`)
writeFileSync(join(out, 'repair.briefing.txt'), briefing)
writeFileSync(join(out, 'repair.reply.json'), `${JSON.stringify({ repairs }, null, 2)}\n`)
writeFileSync(
  join(out, 'repair.applied.json'),
  `${JSON.stringify({ tally, items: after, totals: tallyReviewed(after), reading: readingFromItems(after) }, null, 2)}\n`,
)
console.log(`pinned 4 files into ${out}: ${failed.length} offered, ${tally.accepted} accepted, ${tally.refused} refused`)
