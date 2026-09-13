/**
 * SettingsView — what the connected server is configured to do, and the changing of it.
 *
 * A VIEW rather than a rail panel, and the distinction is the shape of the thing. The rail is
 * read while a run is in flight — glanced at, beside a moving graph, in a column narrow
 * enough that "Apps that may read run contents" wraps to two lines. This is the opposite
 * activity: you come here on purpose, you read a whole section before changing anything, and
 * the graph behind it is not what you are looking at. So it takes the window, the workspace
 * stands down, and the sections get a navigation of their own.
 *
 * The audience decides the whole shape of this screen. It is a curious technical-adjacent
 * person running alkor on their own machine, so every row here is written as the QUESTION
 * they arrived with rather than as the variable that answers it: "which apps may talk to
 * this server" over `ALKOR_CORS`, "stop an unused model after" over `idleMs`. The variable
 * is still named, underneath, because the person who wants it is the person who already
 * knows what it is — but it is never the label.
 *
 * Three structural decisions worth stating, because each had a plausible alternative:
 *
 * 1. **Every row saves itself.** There is no Save button and no dirty state spanning the
 *    panel. A settings screen with one submit implies its fields are one decision, and these
 *    are six unrelated ones; it also means an operator who typed an origin and walked away
 *    loses it silently. Toggles commit on change, text commits on blur or Enter, and the row
 *    that is saving says so where it is, rather than the panel going busy over all of them.
 *
 * 2. **A refusal lands on its field.** The server returns the field it rejected, so a bad
 *    budget marks the budget input and leaves the origin list alone.
 *
 * 3. **Read-only is a mode, not a disabled state.** Writes are on by default, so a server
 *    that refuses them was deliberately locked (ALKOR_CONFIG_WRITE=0) and the person looking
 *    at this screen may not be the person who locked it. It still shows every value and every
 *    host fact — that is most of why the screen exists — and says once, at the top, why
 *    nothing here can be changed. Greying out six rows with no explanation is the version of
 *    this that sends people to the source.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, CircleAlert, LoaderCircle, Lock, Plus, RotateCcw, X } from 'lucide-react'
import { useServerConfig, type ServerConfig, type Settings } from '../hooks/useServerConfig.ts'
import { fmtBytes, fmtDuration } from '../lib/format.ts'
import { Button } from './ui/button'
import { Input } from './ui/input'

interface SettingsViewProps {
  /** The server runs are sent to — the committed URL, not the draft in the header. */
  serverUrl: string
  /** Return to the workspace. Also bound to Escape by the shell that owns the view. */
  onClose: () => void
}

/** The sections, in the order they are read and navigated. */
const SECTIONS = [
  { id: 'access', label: 'Access' },
  { id: 'models', label: 'Models' },
  { id: 'recording', label: 'Recording' },
  { id: 'host', label: 'This host' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

export const SettingsView = memo(({ serverUrl, onClose }: SettingsViewProps) => {
  const { config, loading, error, saving, failure, save, reset, reload } = useServerConfig(serverUrl, true)
  const [current, setCurrent] = useState<SectionId>('access')
  const scrollRef = useRef<HTMLDivElement>(null)

  /**
   * Which section the reader is in, from where the column is scrolled to.
   *
   * Read off scroll position rather than an IntersectionObserver, after the observer version
   * got it wrong in a way worth recording. "The topmost section touching a band near the top
   * of the viewport" sounds like the right rule and is not: the last section can never
   * satisfy it. Scrolled fully to the bottom, `This host` sits mid-page with the tail of
   * `Models` still clipping the band above it, so the nav confidently pointed at Models while
   * the reader was looking at the host facts. No amount of tuning the band fixes that — the
   * last heading cannot reach the top of the screen unless the page is padded with several
   * hundred pixels of nothing to let it.
   *
   * The rule that does hold is the ordinary one: the current section is the LAST whose
   * heading has passed the trigger line, and the bottom of the scroll always means the last
   * section, because that is where the reader can see it is.
   */
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    let frame = 0
    const measure = () => {
      frame = 0
      const atBottom = root.scrollTop + root.clientHeight >= root.scrollHeight - 2
      if (atBottom) {
        setCurrent(SECTIONS[SECTIONS.length - 1]!.id)
        return
      }
      const line = root.getBoundingClientRect().top + root.clientHeight * 0.3
      let found: SectionId = SECTIONS[0]!.id
      for (const { id } of SECTIONS) {
        const el = document.getElementById(`settings-section-${id}`)
        if (el && el.getBoundingClientRect().top <= line) found = id
      }
      setCurrent(found)
    }
    const onScroll = () => {
      // One measurement per frame: four `getBoundingClientRect` calls are cheap, and a
      // scroll event can outrun the paint that would show their result.
      if (frame === 0) frame = requestAnimationFrame(measure)
    }
    measure()
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      root.removeEventListener('scroll', onScroll)
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [config])

  const goTo = useCallback((id: SectionId) => {
    document.getElementById(`settings-section-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  if (loading && !config) {
    return (
      <Frame serverUrl={serverUrl} onClose={onClose}>
        <p className="settings-status" role="status">
          <LoaderCircle className="status-spin" aria-hidden="true" />
          Reading settings from {serverUrl}…
        </p>
      </Frame>
    )
  }

  if (error || !config) {
    return (
      <Frame serverUrl={serverUrl} onClose={onClose}>
        <div className="settings-empty">
          <p className="settings-status is-error" role="alert">
            <CircleAlert aria-hidden="true" />
            {error ?? 'No settings to show.'}
          </p>
          <Button variant="outline" size="sm" onClick={reload}>Try again</Button>
        </div>
      </Frame>
    )
  }

  const { settings, writable } = config
  const anyOverride = Object.values(config.sources).includes('file')

  return (
    <main className="settings-view">
      <SettingsBar serverUrl={serverUrl} onClose={onClose} />

      <div className="settings-body">
        {/* The section nav. Four entries is few enough that it could have been left out and
            the column simply scrolled — it earns its place by answering "what else is in
            here" before the reader has scrolled past the first section, which is the
            question a settings screen is most often opened with. */}
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={`settings-nav-item${current === id ? ' is-on' : ''}`}
              aria-current={current === id ? 'true' : undefined}
              onClick={() => goTo(id)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="settings-scroll" ref={scrollRef}>
          <div className="settings-column">
      {!writable && (
        <p className="settings-note" role="note">
          <Lock aria-hidden="true" />
          <span>
            This server was started with <code>ALKOR_CONFIG_WRITE=0</code>, so its settings are
            read-only. Everything below is what it is running.
          </span>
        </p>
      )}

      {/* Only a failure with nowhere else to go — an unreachable server, a 403 — is announced
          up here. One that names a field is already shown against that field, and saying it
          twice moves the explanation away from the input it is about while pushing the whole
          panel down. */}
      {failure && !failure.field && (
        <p className="settings-status is-error" role="alert">
          <CircleAlert aria-hidden="true" />
          {failure.message}
        </p>
      )}

      <Section
        id="access"
        title="Access"
        note="Who may talk to this server from a browser. Requests that are not from a page — curl, a script, another program on this machine — are never affected by either list."
      >
        <OriginField
          field="cors"
          label="Apps that may use this server"
          config={config}
          saving={saving}
          failure={failure}
          onSave={save}
          disabled={!writable}
          emptyMeaning="Only pages served from localhost may use it. Add an origin to let another app send prompts."
        />
        <OriginField
          field="traceCors"
          label="Apps that may read run contents"
          config={config}
          saving={saving}
          failure={failure}
          onSave={save}
          disabled={!writable}
          emptyMeaning="No browser page may read a recorded run's prompts or answers. Run history and timings stay readable."
          caution="A run's contents include what the model was asked — for an extraction, that quotes the document verbatim."
        />
      </Section>

      <Section id="models" title="Models" note="What this host will hold in memory, and for how long.">
        <BudgetField
          config={config}
          saving={saving}
          failure={failure}
          onSave={(spec) => save({ modelBudget: spec })}
          disabled={!writable}
        />
        <DurationField
          label="Stop an unused model after"
          value={settings.idleMs}
          config={config}
          saving={saving}
          failure={failure}
          onSave={(ms) => save({ idleMs: ms })}
          disabled={!writable}
        />
        <ToggleField
          field="manageModels"
          label="Start and stop models automatically"
          value={settings.manageModels}
          config={config}
          saving={saving}
          onSave={save}
          disabled={!writable}
          onMeaning="This server spawns llama-server when a run needs one."
          offMeaning="You start llama-server yourself; runs fail when it is not up."
        />
      </Section>

      <Section id="recording" title="Recording" note="Every run this server executes is written to a file, the same way the CLI writes one.">
        <ToggleField
          field="serverTrace"
          label="Record runs to disk"
          value={settings.serverTrace}
          config={config}
          saving={saving}
          onSave={save}
          disabled={!writable}
          onMeaning={`Traces are written to ${config.runtime.traceDir}.`}
          offMeaning="Runs leave no record; the activity feed is all that remains, and it is a bounded buffer."
        />
      </Section>

      <Section id="host" title="This host" note="Set when the server starts. Changing any of these means restarting it.">
        <Facts
          rows={[
            // One per line: these are addresses a reader compares against what they typed
            // elsewhere, and three of them wrapped into a single mono paragraph is the one
            // place on this panel where the value is harder to read than the fact behind it.
            ['Model backends', config.runtime.backends.join('\n') || 'none configured'],
            ['Profiles', `${config.runtime.profiles.length} loaded`],
            ['llama-server', config.runtime.llamaBin ?? 'found on PATH'],
            ['Spawn flags', config.runtime.llamaArgs],
            ['Profiles file', config.runtime.profilesPath ?? 'profiles.toml'],
            ['Traces', config.runtime.traceDir],
            ['Settings file', config.settingsPath],
          ]}
        />
      </Section>

      {writable && anyOverride && (
        <div className="settings-reset">
          <Button variant="outline" size="sm" onClick={reset}>
            <RotateCcw aria-hidden="true" />
            Clear saved settings
          </Button>
          <p className="settings-hint">
            Deletes the overrides above and returns this server to what its environment says.
          </p>
        </div>
      )}
          </div>
        </div>
      </div>
    </main>
  )
})

/**
 * The view's own bar: what is being configured, and the way back.
 *
 * Separate from the top bar above it, which describes the SESSION — connection, model,
 * counters — and keeps doing so while this view is open. This one describes the page, and
 * carries the return because a view that takes the whole window has to say how to leave it;
 * Escape does the same thing, but a keyboard shortcut nobody is told about is not an exit.
 */
const SettingsBar = ({ serverUrl, onClose }: { serverUrl: string; onClose: () => void }) => (
  <div className="settings-bar">
    <Button variant="ghost" size="sm" onClick={onClose}>
      <ArrowLeft aria-hidden="true" />
      Workspace
    </Button>
    <div className="settings-bar-title">
      <h1 className="settings-title">Server settings</h1>
      {/* Named on every screen state, including the ones with nothing to show: "could not
          reach it" is only actionable if you know which server was not reached. */}
      <span className="settings-host">{serverUrl.replace(/^https?:\/\//, '')}</span>
    </div>
  </div>
)

/** The bar plus a centred well, for the states that have no sections to navigate. */
const Frame = ({
  serverUrl,
  onClose,
  children,
}: {
  serverUrl: string
  onClose: () => void
  children: React.ReactNode
}) => (
  <main className="settings-view">
    <SettingsBar serverUrl={serverUrl} onClose={onClose} />
    <div className="settings-body">
      <div className="settings-scroll">
        <div className="settings-column">{children}</div>
      </div>
    </div>
  </main>
)

const Section = ({
  id,
  title,
  note,
  children,
}: {
  id: string
  title: string
  note: string
  children: React.ReactNode
}) => (
  <section className="settings-section" id={`settings-section-${id}`} aria-labelledby={`settings-heading-${id}`}>
    {/* A real heading rather than the rail's 11px orientation label: at this size the
        sections are the page's structure, and structure is read by heading, not by kicker. */}
    <h2 className="settings-section-title" id={`settings-heading-${id}`}>{title}</h2>
    <p className="settings-section-note">{note}</p>
    {children}
  </section>
)

/**
 * The line under a field that says where its value came from.
 *
 * Only interesting in one case, and that case is the reason the whole source mechanism
 * exists: a value saved here that is currently beating an environment variable set in the
 * shell that launched the server. Without this note that operator has two plausible reads of
 * the same screen and no way to tell which is true.
 */
const SourceNote = ({ field, config }: { field: keyof Settings; config: ServerConfig }) => {
  const source = config.sources[field]
  const name = config.envNames[field]
  if (source !== 'file') {
    return source === 'env' ? <p className="settings-source">Set by <code>{name}</code>.</p> : null
  }
  const envValue = config.env[field]
  if (envValue === undefined) return <p className="settings-source">Saved here.</p>
  const spelled = Array.isArray(envValue) ? envValue.join(', ') || '(empty)' : String(envValue)
  return (
    <p className="settings-source is-override">
      Saved here, overriding <code>{name}={spelled}</code> from the environment.
    </p>
  )
}

/** The saving/saved marker for one row. Absent when nothing is happening to it. */
const RowStatus = ({ field, saving }: { field: keyof Settings; saving?: keyof Settings }) =>
  saving === field ? (
    <span className="settings-saving" role="status">
      <LoaderCircle className="status-spin" aria-hidden="true" />
      Saving
    </span>
  ) : null

interface FieldCommon {
  config: ServerConfig
  saving?: keyof Settings
  failure?: { message: string; field?: keyof Settings }
  disabled: boolean
}

/**
 * An allowlist of origins, edited as a list rather than as a comma-separated string.
 *
 * The string is how the environment variable spells it and it is the wrong control for a
 * person: one typo in the middle of it invalidates an entry three positions away, and
 * nothing on screen says which. As chips, a wrong entry is removed by clicking the wrong
 * entry, and the server's per-origin validation has somewhere to land.
 */
const OriginField = ({
  field,
  label,
  config,
  saving,
  failure,
  onSave,
  disabled,
  emptyMeaning,
  caution,
}: FieldCommon & {
  field: 'cors' | 'traceCors'
  label: string
  onSave: (patch: Partial<Settings>) => Promise<boolean>
  emptyMeaning: string
  caution?: string
}) => {
  const origins = config.settings[field]
  const [draft, setDraft] = useState('')
  const rejected = failure?.field === field

  const add = async () => {
    const value = draft.trim()
    if (!value) return
    // The origin the browser is showing this page from is the one an operator almost always
    // wants, so the field pre-fills with it rather than asking them to type their own address.
    if (await onSave({ [field]: [...origins, value] } as Partial<Settings>)) setDraft('')
  }

  const remove = (origin: string) =>
    void onSave({ [field]: origins.filter((o) => o !== origin) } as Partial<Settings>)

  return (
    <div className="settings-field">
      <div className="settings-field-head">
        <span className="settings-label">{label}</span>
        <RowStatus field={field} saving={saving} />
      </div>

      {origins.length === 0 ? (
        <p className="settings-meaning">{emptyMeaning}</p>
      ) : (
        <ul className="settings-chips">
          {origins.map((origin) => (
            <li key={origin} className={`settings-chip${origin === '*' ? ' is-open' : ''}`}>
              <span className="settings-chip-text">{origin === '*' ? 'Any app, anywhere' : origin}</span>
              {!disabled && (
                <button
                  type="button"
                  className="settings-chip-x"
                  aria-label={`Remove ${origin}`}
                  onClick={() => remove(origin)}
                >
                  <X aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {origins.includes('*') && (
        <p className="settings-meaning is-caution">
          <CircleAlert aria-hidden="true" />
          <span>
            Any website you visit can reach this server while it runs. There is no password on it.
          </span>
        </p>
      )}

      {!disabled && (
        <div className="settings-add">
          <Input
            value={draft}
            aria-label={`Add an origin to ${label}`}
            aria-invalid={rejected || undefined}
            placeholder={typeof window === 'undefined' ? 'https://app.example' : window.location.origin}
            className={rejected ? 'settings-input is-rejected' : 'settings-input'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              void add()
            }}
          />
          <Button variant="outline" size="sm" onClick={add} disabled={!draft.trim()}>
            <Plus aria-hidden="true" />
            Add
          </Button>
        </div>
      )}
      {rejected && <p className="settings-rejected" role="alert">{failure?.message}</p>}
      {caution && <p className="settings-meaning">{caution}</p>}
      <SourceNote field={field} config={config} />
    </div>
  )
}

/**
 * The resident-model budget, as a position on this machine's memory rather than as a string.
 *
 * It was a text field taking `6GiB`, `50%` or a byte count, which is the spelling the server
 * stores and the wrong question to ask a person. Deciding this number means weighing it
 * against the rest of the machine — the browser this panel is open in, the editor, the OS —
 * and a text box makes the operator do that arithmetic from a figure it does not show them.
 * A range does the weighing visually: the filled portion IS the share of the host being
 * committed, and the readout gives both halves of the answer at once.
 *
 * Two things a slider cannot say are kept beside it rather than lost. **No limit** (`0`) is
 * not the far end of this range — it is a different mode, in which the budget stops being
 * consulted at all — so it is a button, and the range disappears while it is in force. And a
 * budget set precisely from the environment (`ALKOR_MODEL_BUDGET=6GiB`) is reported exactly,
 * to the byte, until the slider is actually moved: the position rounds to the nearest step,
 * but nothing rewrites what an operator set deliberately just because a control rendered it.
 */
const STEP = 5
const MIN_PERCENT = 5

const BudgetField = ({
  config,
  saving,
  failure,
  onSave,
  disabled,
}: FieldCommon & { onSave: (spec: string) => Promise<boolean> }) => {
  const { budgetBytes, totalBytes, resources } = config.runtime
  const unbounded = budgetBytes <= 0
  const storedPercent = Math.min(
    100,
    Math.max(MIN_PERCENT, Math.round((budgetBytes / totalBytes) * 100 / STEP) * STEP),
  )
  // `null` means "nothing has been dragged", which is what lets the readout show the stored
  // value to the byte instead of the rounded position standing in for it.
  const [draft, setDraft] = useState<number | null>(null)
  useEffect(() => setDraft(null), [budgetBytes])

  const percent = draft ?? storedPercent
  const shown = draft === null ? budgetBytes : Math.floor((totalBytes * percent) / 100)
  const rejected = failure?.field === 'modelBudget'

  const commit = () => {
    if (draft === null || draft === storedPercent) return
    void onSave(`${draft}%`)
  }

  return (
    <div className="settings-field">
      <div className="settings-field-head">
        {disabled || unbounded
          ? <span className="settings-label">Memory for resident models</span>
          : <label className="settings-label" htmlFor="setting-modelBudget">Memory for resident models</label>}
        <RowStatus field="modelBudget" saving={saving} />
      </div>

      {unbounded ? (
        <p className="settings-value">No limit</p>
      ) : disabled ? (
        <p className="settings-value">{fmtBytes(budgetBytes)} · {storedPercent}% of {fmtBytes(totalBytes)}</p>
      ) : (
        <>
          <div className="settings-readout">
            <span className="settings-readout-value">{fmtBytes(shown)}</span>
            {/* The percentage is not decoration beside the bytes: it is the unit the slider
                stores, so `50%` in the environment and a thumb halfway along are visibly the
                same statement. The filled track is normalized to the settable range and so
                cannot carry the share of the host on its own. */}
            <span className="settings-readout-of">{percent}% of {fmtBytes(totalBytes)} on this machine</span>
          </div>
          <input
            id="setting-modelBudget"
            type="range"
            className="settings-range"
            min={MIN_PERCENT}
            max={100}
            step={STEP}
            value={percent}
            aria-label="Memory for resident models"
            aria-valuetext={`${fmtBytes(shown)}, ${percent} percent of ${fmtBytes(totalBytes)}`}
            aria-invalid={rejected || undefined}
            // The filled portion is painted from this, because the two pseudo-elements that
            // style a range track cannot see the value.
            style={{ '--fill': `${((percent - MIN_PERCENT) / (100 - MIN_PERCENT)) * 100}%` } as React.CSSProperties}
            onChange={(e) => setDraft(Number(e.target.value))}
            // Committed on release rather than on every frame: dragging from 20% to 80%
            // crosses twelve steps, and writing each one would be twelve saves and twelve
            // reconfigures of a live model manager to reach one decision.
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
          />
        </>
      )}

      {rejected && <p className="settings-rejected" role="alert">{failure?.message}</p>}

      <p className="settings-meaning">
        {unbounded
          ? 'Every backend a run needs is started and kept, however many that is. On a host that cannot hold them all at once, this is what swaps.'
          : 'A model that does not fit inside this evicts the least recently used one. The rest of the machine — this browser, your editor, the OS — is not free, which is what the share is weighed against.'}
        {resources.residentBytes > 0 && ` ${fmtBytes(resources.residentBytes)} is resident now.`}
      </p>

      {!disabled && (
        <button
          type="button"
          className="settings-link"
          onClick={() => void onSave(unbounded ? '60%' : '0')}
        >
          {unbounded ? 'Set a limit' : 'Remove the limit'}
        </button>
      )}

      <SourceNote field="modelBudget" config={config} />
    </div>
  )
}

/**
 * The idle window, entered in minutes and stored in milliseconds.
 *
 * The unit conversion lives here rather than in the store because the store's unit is the
 * server's and must stay so — every other caller of `idleMs` is code. What changes is which
 * unit a person is asked to think in, and nobody chooses an idle timeout in milliseconds.
 */
const DurationField = ({
  label,
  value,
  config,
  saving,
  failure,
  onSave,
  disabled,
}: FieldCommon & { label: string; value: number; onSave: (ms: number) => Promise<boolean> }) => {
  const asMinutes = (ms: number) => String(Number((ms / 60_000).toFixed(2)))
  const [draft, setDraft] = useState(() => asMinutes(value))
  useEffect(() => setDraft(asMinutes(value)), [value])
  const rejected = failure?.field === 'idleMs'

  const commit = () => {
    const minutes = Number(draft)
    if (!Number.isFinite(minutes) || minutes <= 0) {
      setDraft(asMinutes(value))
      return
    }
    const ms = Math.round(minutes * 60_000)
    if (ms === value) return
    void onSave(ms)
  }

  return (
    <div className="settings-field">
      <div className="settings-field-head">
        {disabled
          ? <span className="settings-label">{label}</span>
          : <label className="settings-label" htmlFor="setting-idleMs">{label}</label>}
        <RowStatus field="idleMs" saving={saving} />
      </div>
      {disabled ? (
        <p className="settings-value">{fmtDuration(value)}</p>
      ) : (
      <div className="settings-measure">
        <Input
          id="setting-idleMs"
          type="number"
          min={0.1}
          step={0.5}
          value={draft}
          aria-invalid={rejected || undefined}
          aria-describedby="setting-idleMs-unit"
          className={rejected ? 'settings-input is-rejected' : 'settings-input'}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              setDraft(asMinutes(value))
            }
          }}
        />
        <span className="settings-unit" id="setting-idleMs-unit">minutes</span>
      </div>
      )}
      {rejected && <p className="settings-rejected" role="alert">{failure?.message}</p>}
      <p className="settings-meaning">
        Currently {fmtDuration(value)}. A model kept resident answers immediately; one that has
        been stopped is loaded again on the next run that needs it.
      </p>
      <SourceNote field="idleMs" config={config} />
    </div>
  )
}

/**
 * A boolean, as a switch that states what BOTH positions mean.
 *
 * The meaning line changes with the value rather than describing the setting in the
 * abstract, because the question being asked is always "what happens if I leave this
 * alone" — and for two of these three settings the off position is the one with
 * consequences a person would want warned about.
 */
const ToggleField = ({
  field,
  label,
  value,
  config,
  saving,
  onSave,
  disabled,
  onMeaning,
  offMeaning,
}: FieldCommon & {
  field: keyof Settings
  label: string
  value: boolean
  onSave: (patch: Partial<Settings>) => Promise<boolean>
  onMeaning: string
  offMeaning: string
}) => (
  <div className="settings-field">
    <div className="settings-field-head">
      <button
        type="button"
        role="switch"
        aria-checked={value}
        disabled={disabled}
        className={`settings-switch${value ? ' is-on' : ''}`}
        onClick={() => void onSave({ [field]: !value } as Partial<Settings>)}
      >
        <span className="settings-switch-track" aria-hidden="true">
          <span className="settings-switch-thumb">{value && <Check aria-hidden="true" />}</span>
        </span>
        <span className="settings-label">{label}</span>
      </button>
      <RowStatus field={field} saving={saving} />
    </div>
    <p className="settings-meaning">{value ? onMeaning : offMeaning}</p>
    <SourceNote field={field} config={config} />
  </div>
)

/** The read-only half: facts, set at startup, in the mono the rest of the board uses for paths. */
const Facts = ({ rows }: { rows: Array<[string, string]> }) => (
  <dl className="settings-facts">
    {rows.map(([term, value]) => (
      <div key={term} className="settings-fact">
        <dt>{term}</dt>
        <dd>{value}</dd>
      </div>
    ))}
  </dl>
)
