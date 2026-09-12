/**
 * CorpusPicker — choose a pack document to drive a run with.
 *
 * The packs ship the notes, transcripts and exam payloads the evals grade against. Testing
 * the harness by hand means running the same bytes, so this puts all of them one keystroke
 * away from the run box instead of leaving the operator to find a path under `packs/` and
 * paste it in from an editor.
 *
 * It overlays the rail rather than sitting inside it: the rail is narrow by design, and a
 * list of a hundred documents with descriptions is worth the whole panel for the seconds it
 * takes to pick one.
 *
 * GROUPED, because a hundred documents in one column is a pile rather than a corpus. The
 * sections are what grades them — vital signs, patient summary, shock, sepsis, transcript
 * repair — so the first thing an operator reads is the question a document belongs to. They
 * start closed: six headings with counts is the map of the pack, and typing is faster than
 * scrolling anyway, so a query opens whatever it matches.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, FileText, Loader2, Search, X } from 'lucide-react'
import {
  fetchCorpus,
  fetchCorpusDocument,
  groupDocuments,
  kindLabel,
  matchesQuery,
  type CorpusDocument,
  type CorpusGroup,
} from '../lib/corpus.ts'

interface CorpusPickerProps {
  /** The server the runs go to — the corpus is read from the same one. */
  serverUrl: string
  onPick: (text: string, doc: CorpusDocument) => void
  onClose: () => void
}

/** A rendered line. Group headers and documents take the cursor; case labels do not. */
type Row =
  | { type: 'group'; key: string; group: CorpusGroup }
  | { type: 'case'; key: string; caseName: string; count: number; note?: string; class?: string; difficulty?: number }
  | { type: 'doc'; key: string; doc: CorpusDocument; inRun: boolean }

export const CorpusPicker = ({ serverUrl, onPick, onClose }: CorpusPickerProps) => {
  const [documents, setDocuments] = useState<CorpusDocument[] | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const [cursor, setCursor] = useState(0)
  const [loadingId, setLoadingId] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let live = true
    fetchCorpus(serverUrl)
      .then((listing) => {
        if (!live) return
        setDocuments(listing.documents)
        setNotice(listing.note)
      })
      .catch((e: Error) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [serverUrl])

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  const searching = query.trim().length > 0

  const groups = useMemo(() => {
    const matched = (documents ?? []).filter((doc) => matchesQuery(doc, query))
    return groupDocuments(matched)
  }, [documents, query])

  /**
   * The lines actually on screen, in order.
   *
   * Built as one flat array rather than read back off the DOM so the cursor, the keyboard
   * and the rendering all agree on what "the next thing" is — a tree where Down means
   * something different from what the eye sees is worse than no keyboard support.
   */
  const rows = useMemo((): Row[] => {
    const out: Row[] = []
    for (const group of groups) {
      out.push({ type: 'group', key: `g:${group.key}`, group })
      // A query is a statement about what you are looking for, so every section it matches
      // is open. Without a query the sections are closed until asked for.
      if (!searching && !opened.has(group.key)) continue
      for (const run of group.runs) {
        // Class, difficulty and description are properties of the CASE, so they are stated
        // once on its heading. Printed on each note they were three copies of one sentence
        // and the only thing that actually varied — the length — was lost among them.
        out.push({
          type: 'case',
          key: `c:${group.key}/${run.caseName}`,
          caseName: run.caseName,
          count: run.documents.length,
          note: run.documents[0]?.note,
          class: run.documents[0]?.class,
          difficulty: run.documents[0]?.difficulty,
        })
        for (const doc of run.documents) out.push({ type: 'doc', key: doc.id, doc, inRun: true })
      }
      for (const doc of group.singles) out.push({ type: 'doc', key: doc.id, doc, inRun: false })
    }
    return out
  }, [groups, opened, searching])

  const selectable = useMemo(
    () => rows.map((row, at) => ({ row, at })).filter(({ row }) => row.type !== 'case'),
    [rows],
  )

  // A filter that moves the list under the cursor has to move the cursor with it, or Enter
  // loads whatever happens to be sitting at the old index.
  useEffect(() => {
    setCursor(0)
  }, [query])

  useEffect(() => {
    listRef.current?.querySelector('[data-at-cursor="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor, rows.length])

  const toggle = (key: string) =>
    setOpened((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const choose = async (doc: CorpusDocument) => {
    setLoadingId(doc.id)
    setError('')
    try {
      onPick(await fetchCorpusDocument(serverUrl, doc.id), doc)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoadingId('')
    }
  }

  const activate = (index: number) => {
    const entry = selectable[index]
    if (!entry) return
    if (entry.row.type === 'group') toggle(entry.row.group.key)
    else if (entry.row.type === 'doc') void choose(entry.row.doc)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      // Stop the shell from reading the same Escape as "collapse the rail": closing the
      // picker is the nearer, more obvious thing it should undo.
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setCursor((at) => Math.min(selectable.length - 1, Math.max(0, at + step)))
      return
    }
    // Left and Right work the section the cursor is in, as a tree is expected to.
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const entry = selectable[cursor]
      if (entry?.row.type !== 'group') return
      e.preventDefault()
      const isOpen = searching || opened.has(entry.row.group.key)
      if (e.key === 'ArrowRight' ? !isOpen : isOpen) toggle(entry.row.group.key)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      activate(cursor)
    }
  }

  let selectableAt = -1

  return (
    <div className="corpus" role="dialog" aria-label="Pack corpus" onKeyDown={onKeyDown}>
      <div className="corpus-head">
        <Search className="corpus-search-icon" aria-hidden="true" />
        <input
          ref={searchRef}
          className="corpus-search"
          type="search"
          value={query}
          spellCheck={false}
          placeholder="Filter by name, kind, or what the case tests…"
          aria-label="Filter corpus documents"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" className="corpus-close" onClick={onClose} aria-label="Close corpus">
          <X aria-hidden="true" />
        </button>
      </div>

      {error && <p className="corpus-error" role="alert">{error}</p>}

      <div className="corpus-list" ref={listRef}>
        {documents === null && !error && (
          <p className="corpus-status"><Loader2 className="status-spin" aria-hidden="true" />Reading the corpus…</p>
        )}
        {documents !== null && rows.length === 0 && (
          <p className="corpus-status">
            {documents.length === 0
              ? 'The configured packs declare no source documents.'
              : `Nothing matches “${query.trim()}”.`}
          </p>
        )}

        {rows.map((row) => {
          if (row.type === 'case') {
            return (
              <div key={row.key} className="corpus-case">
                <span className="corpus-case-name">{row.caseName}</span>
                <span className="corpus-case-meta">
                  <span className="corpus-case-count">{row.count} notes, one record</span>
                  {row.class && <> · {row.class}</>}
                  {row.difficulty != null && <> · difficulty {row.difficulty}</>}
                </span>
                {row.note && <span className="corpus-case-note">{row.note}</span>}
              </div>
            )
          }

          selectableAt += 1
          const at = selectableAt
          const atCursor = at === cursor

          if (row.type === 'group') {
            const isOpen = searching || opened.has(row.group.key)
            return (
              <button
                key={row.key}
                type="button"
                className={`corpus-group-btn${atCursor ? ' is-at-cursor' : ''}`}
                data-at-cursor={atCursor}
                aria-expanded={isOpen}
                onMouseMove={() => setCursor(at)}
                onClick={() => toggle(row.group.key)}
              >
                <ChevronRight className={`corpus-caret${isOpen ? ' is-open' : ''}`} aria-hidden="true" />
                <span className="corpus-group-name">{row.group.label}</span>
                <span className="corpus-group-kind">{kindLabel(row.group.kind)}</span>
                <span className="corpus-group-count">{row.group.documents.length}</span>
              </button>
            )
          }

          const { doc, inRun } = row
          return (
            <button
              key={row.key}
              type="button"
              className={`corpus-row${atCursor ? ' is-at-cursor' : ''}${inRun ? ' is-in-run' : ''}`}
              data-at-cursor={atCursor}
              onMouseMove={() => setCursor(at)}
              onClick={() => void choose(doc)}
            >
              <span className="corpus-row-head">
                <span className="corpus-row-name">{doc.case}</span>
                {loadingId === doc.id
                  ? <Loader2 className="status-spin corpus-row-glyph" aria-hidden="true" />
                  : <FileText className="corpus-row-glyph" aria-hidden="true" />}
              </span>
              <span className="corpus-row-meta">
                {!inRun && doc.class && <>{doc.class} · </>}
                {!inRun && doc.difficulty != null && <>difficulty {doc.difficulty} · </>}
                {doc.lines} lines
              </span>
              {/* Inside a run the description belongs to the case above and is already
                  printed once; repeating it on each note is three copies of one sentence. */}
              {!inRun && <span className="corpus-row-note">{doc.note ?? doc.preview}</span>}
            </button>
          )
        })}
      </div>

      {notice && <p className="corpus-foot">{notice}</p>}
    </div>
  )
}
