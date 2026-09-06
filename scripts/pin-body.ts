#!/usr/bin/env node
/**
 * Print the request body this harness would send, without sending it.
 *
 * The body is pinned field for field so a second runtime reading the same pack can be compared
 * against it — see the comment on `chatBody`. A pin whose only witness is a live server is a pin
 * nobody checks: verifying it would cost a model download and a warm machine, so it would be
 * checked once and thereafter assumed. This makes the comparison a string diff.
 *
 *   node scripts/pin-body.ts --pack packs/clinical --case tr-en-02-self-correction
 *   node scripts/pin-body.ts --pack packs/clinical --case tr-en-02-self-correction --medication
 *   node scripts/pin-body.ts --pack packs/clinical --note FILE
 *
 * Output is the exact bytes `JSON.stringify(body)` produces, and nothing else, so it can be
 * written to a fixture and compared byte for byte.
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { chatBody } from '../src/core/client.ts'
import { loadPack } from '../src/core/pack.ts'
import { DOCUMENT_KIND, medicationRequest, takesMedicationPass, transcriptRequest } from '../src/profiles/clinical/contracts.ts'

const { values } = parseArgs({
  options: {
    pack: { type: 'string', default: 'packs/clinical' },
    case: { type: 'string' },
    note: { type: 'string' },
    model: { type: 'string', default: 'local' },
    unconstrained: { type: 'boolean', default: false },
    // The SECOND call a dictation makes, pinned by the same script because it is part of what
    // reading a dictation costs and sends. A runtime that matched the first body byte for byte
    // and sent something else on the second would be a runtime this pin declared identical.
    medication: { type: 'boolean', default: false },
  },
})

if (Boolean(values.case) === Boolean(values.note)) {
  console.error('pin-body needs exactly one of --case NAME and --note FILE')
  process.exit(2)
}

const pack = loadPack(values.pack!)
const document = values.case
  ? pack.document(values.case, DOCUMENT_KIND.transcript)
  : readFileSync(values.note!, 'utf8')
// AFTER the document, because the prompt is chosen by the transcript's language. A pin
// assembled before reading the transcript would pin a body the eval never sends.
if (values.medication && !takesMedicationPass(pack, document)) {
  console.error(
    'this document does not take the medication pass: it is a dialogue, or the pack does not ' +
      'declare the contract. There is no second body to pin, which is itself the thing to check.',
  )
  process.exit(2)
}
const req = values.medication
  ? medicationRequest(pack, !values.unconstrained, document)
  : transcriptRequest(pack, !values.unconstrained, document)

// Exactly the call `extract` makes, with the same fields in the same order. A script that
// assembled its own would be pinning itself.
process.stdout.write(
  JSON.stringify(
    chatBody({
      systemPrompt: req.prompt,
      userPrompt: document,
      schema: req.schema,
      schemaName: req.schemaName,
      maxTokens: req.sampling.max_tokens,
      temperature: req.sampling.temperature,
      timeoutMs: req.sampling.timeout_secs * 1000,
      model: values.model,
      label: values.medication ? 'medication' : 'transcript',
    }),
  ),
)
