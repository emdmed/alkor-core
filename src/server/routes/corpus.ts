/**
 * `GET /corpus` and `GET /corpus/:id` — the notes and transcripts the packs grade against,
 * offered as INPUT rather than as measurement.
 *
 * The dashboard loads one into its run box so an operator drives the harness with the same
 * bytes the eval reads. Reads here never touch a pack's opened-file set, so browsing cannot
 * write itself into a later run's digest.
 */
import { listCorpus, readCorpusDocument, CorpusError } from '../../core/corpus.ts'
import type { RouteContext } from '../deps.ts'

export const corpusList = async ({ reply, done, deps }: RouteContext): Promise<void> => {
  const documents = listCorpus(deps.declaredPacks())
  reply.ok({
    documents,
    // Stated rather than counted by the client: a reader deciding whether to paste
    // one of these into a clinical tool should be told what they are, next to them.
    synthetic: true,
    note: 'Synthetic source documents from the contract packs. No patient data.',
  })
  done(200)
}

export const corpusDocument = async ({ url, reply, done, deps }: RouteContext): Promise<void> => {
  const id = decodeURIComponent(url.pathname.slice('/corpus/'.length))
  try {
    const { document, text } = readCorpusDocument(deps.declaredPacks(), id)
    reply.ok({ ...document, text })
    done(200)
  } catch (e) {
    if (!(e instanceof CorpusError)) throw e
    reply.notFound((e as Error).message)
    done(404)
  }
}
