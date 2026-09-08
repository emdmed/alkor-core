/**
 * OpenTUI app: the only OpenTUI-aware code, kept thin.
 *
 * Dynamic import of `@opentui/core` is load-bearing: a static import would make
 * even `node src/tui.ts --help` fail on Node 24. The rest of the intelligence is
 * in `state.ts` and `sse.ts`, which are unit-tested without a renderer.
 */
import {
  emptyState, applyEvent, setConnection, setTopology,
  type ProjectState, type TopologySnapshot,
  cacheHitRatio, failureRate, inFlightCount, tokPerSec,
} from './state.ts'
import { createSseClient } from './sse.ts'
import { writeFileSync, appendFileSync } from 'node:fs'

const DBG = '/tmp/medextract-tui-dbg.log'
const log = (msg: string) => appendFileSync(DBG, `${new Date().toISOString()} ${msg}\n`)

/** Start the TUI connected to `url` (e.g. `http://127.0.0.1:3000`). */
export const runApp = async (url: string): Promise<void> => {
  log('runApp entered')
  const opentui = await import('@opentui/core')
  log('opentui imported')
  const renderer = await opentui.createCliRenderer({
    exitOnCtrlC: true,
    useMouse: false,
    useKittyKeyboard: null,
  })
  log(`renderer created ${renderer.width}x${renderer.height}`)
  let frameCount = 0
  renderer.on('frame', () => {
    frameCount++
    if (frameCount <= 5) log(`frame #${frameCount}`)
  })
  renderer.start()
  log('renderer started')

  let state = emptyState()

  // --- Create layout (imperative VNodes, updated by ref) -----------------------

  // These must be imperative renderables, not composition VNodes. VNodes are
  // instantiated when mounted, so retaining a VNode and changing its `content`
  // later updates only its pending mount calls—not the text already on screen.
  const headerText = new opentui.TextRenderable(renderer, { content: '', fg: '#e6edf3' })
  const statusText = new opentui.TextRenderable(renderer, { content: '', fg: '#8b949e' })
  const pathwayText = new opentui.TextRenderable(renderer, { content: '', fg: '#b6c2cf' })
  const activityText = new opentui.TextRenderable(renderer, { content: '', fg: '#b6c2cf' })
  const logScrollBox = new opentui.ScrollBoxRenderable(renderer, {
    scrollY: true, border: true, borderStyle: 'single', title: ' EVENT LOG ', bottomTitle: ' ↑↓ scroll · q quit ', bottomTitleAlignment: 'right', height: '30%',
    borderColor: '#30363d', titleColor: '#79c0ff', backgroundColor: '#0d1117', paddingX: 1,
  })

  // A dark control-room surface keeps the live path dominant; panels only divide
  // distinct jobs (configuration, current work, and history).
  const layout = new opentui.BoxRenderable(renderer, {
    flexDirection: 'column', flexGrow: 1, gap: 0, backgroundColor: '#0d1117',
  })
  const headerBox = new opentui.BoxRenderable(renderer, {
    flexDirection: 'column', height: 3, border: ['bottom'], borderColor: '#30363d', backgroundColor: '#0d1117',
  })
  const main = new opentui.BoxRenderable(renderer, { flexDirection: 'row', flexGrow: 1, gap: 1, backgroundColor: '#0d1117' })
  const pathwayBox = new opentui.BoxRenderable(renderer, {
    border: true, borderStyle: 'single', title: ' EXECUTION ', bottomTitle: ' configured topology · activity paints state ', width: '70%', flexGrow: 1,
    borderColor: '#30363d', titleColor: '#79c0ff', backgroundColor: '#0d1117',
  })
  const activityBox = new opentui.BoxRenderable(renderer, {
    border: true, borderStyle: 'single', title: ' LIVE ACTIVITY ', width: '30%', flexGrow: 1,
    borderColor: '#30363d', titleColor: '#79c0ff', backgroundColor: '#0d1117',
  })

  pathwayBox.add(pathwayText)
  activityBox.add(activityText)
  main.add(pathwayBox)
  main.add(activityBox)
  headerBox.add(headerText)
  headerBox.add(statusText)
  layout.add(headerBox)
  layout.add(main)
  layout.add(logScrollBox)

  renderer.root.add(layout)

  // --- Update renderables from state ------------------------------------------

  const update = () => {
    log('update: headerText')
    headerText.content = formatHeader(state, url, opentui) as any
    log('update: statusText')
    statusText.content = formatStatusLine(state, opentui) as any
    log('update: pathwayText')
    pathwayText.content = formatPathways(state, opentui) as any
    log('update: activityText')
    activityText.content = formatActivity(state, opentui) as any
    log('update: eventLog')
    updateEventLog(state, logScrollBox, opentui)
    log('update: done')
  }

  // Render a truthful status immediately. The connection callback will replace this
  // with "live" only after the SSE endpoint has answered 200.
  log('calling update()')
  update()
  log('update() done')
  // The initial tree is mounted before the renderer's first scheduler tick. Request
  // one explicitly so startup never depends on a capability-response timing race.
  renderer.requestRender()
  log('requestRender called')

  // --- SSE + connection -------------------------------------------------------

  log('creating SSE client')
  const client = createSseClient({
    url: `${url.replace(/\/$/, '')}/events`,
    onEvent: (event) => {
      log(`onEvent: ${event.kind}`)
      state = applyEvent(state, event)
      update()
    },
    onConnection: (status) => {
      log(`onConnection: ${status.kind}`)
      state = setConnection(state, status)
      update()
      log(`onConnection update done`)
    },
  })
  log('SSE client created')

  // --- Seed from health once --------------------------------------------------

  log('fetching health')
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/health`)
    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>
      const topology = data.topology as TopologySnapshot | undefined
      if (topology?.profiles && topology?.pipelines) {
        state = setTopology(state, topology)
        update()
      }
    }
  } catch {
    // Health is best-effort; the SSE stream is the source of truth.
  }
  log('health fetch done')

  // --- Input handling ---------------------------------------------------------

  renderer.addInputHandler((sequence: string) => {
    if (sequence === 'q' || sequence === '\u0003') {
      // q or Ctrl-C
      client.close()
      renderer.destroy()
      process.exit(0)
      return true
    }
    if (sequence === '\u001b[A' || sequence === '\u001b[B') {
      // Arrow up / down scroll the log
      logScrollBox.scrollBy(sequence === '\u001b[A' ? -3 : 3)
      return true
    }
    return false
  })
  log('runApp setup complete')
}

// --- Formatting helpers (no domain knowledge, no clinical concepts) -----------

const formatHeader = (state: ProjectState, url: string, opentui: any): any => {
  const host = url.replace(/^https?:\/\//, '')
  const conn = state.connection.kind
  const connDot = conn === 'live' ? '●' : conn === 'connecting' ? '◌' : conn === 'reconnecting' ? '◐' : '○'
  const connLabel = conn === 'live'
    ? 'connected — receiving activity'
    : conn === 'connecting'
      ? 'connecting to /events…'
      : conn === 'reconnecting'
        ? `reconnecting (attempt ${state.connection.attempt})`
        : 'connection refused'

  // Pick the first identified model, if any.
  let model = ''
  for (const m of state.models.values()) {
    if (m.identified && m.model) {
      const name = m.model.split('/').at(-1)?.replace(/\.gguf$/, '') ?? m.model
      model = name
      break
    }
  }
  const detail = state.connection.kind === 'refused' ? ` — ${state.connection.reason}` : ''
  const chunks = [
    opentui.fg('#f0f6fc')(' medextract'),
    opentui.fg('#484f58')('  /  '),
    opentui.fg('#8b949e')(host),
    opentui.fg(conn === 'live' ? '#3fb950' : conn === 'refused' ? '#f85149' : '#d29922')(`   ${connDot} `),
    opentui.fg(conn === 'live' ? '#3fb950' : conn === 'refused' ? '#f85149' : '#d29922')(conn === 'live' ? 'LIVE' : connLabel.toUpperCase()),
  ]
  if (model) chunks.push(opentui.fg('#484f58')('   │   '), opentui.fg('#a5d6ff')(model))
  if (detail) chunks.push(opentui.fg('#f85149')(detail))
  return new opentui.StyledText(chunks)
}

/** One compact operational readout avoids making people hunt across panels. */
const formatStatusLine = (state: ProjectState, opentui: any): any => {
  const finished = [...state.runs.values()].filter((run) => run.status !== 'started')
  const cache = cacheHitRatio(state.llmRequests)
  const chunks: any[] = []
  const add = (text: string, color = '#8b949e') => chunks.push(opentui.fg(color)(text))
  add('  ')
  add(`${inFlightCount(state.llmRequests)} active request${inFlightCount(state.llmRequests) === 1 ? '' : 's'}`, inFlightCount(state.llmRequests) ? '#3fb950' : '#8b949e')
  add('   ·   ')
  add(`${finished.length} completed run${finished.length === 1 ? '' : 's'}`)
  if (finished.length > 0) {
    add('   ·   ')
    const failures = failureRate(state.runs)
    add(`${Math.round(failures * 100)}% failure`, failures > 0 ? '#f85149' : '#3fb950')
  }
  if (cache != null) {
    add('   ·   ')
    add(`${Math.round(cache * 100)}% prompt cache`, '#a5d6ff')
  }
  return new opentui.StyledText(chunks)
}

type NodeState = 'active' | 'done' | 'failed' | 'idle'

const nodeColor = (status: NodeState): string => ({
  active: '#39d353',
  done: '#58a6ff',
  failed: '#ff7b72',
  idle: '#6e7681',
}[status])

const nodeMark = (status: NodeState): string => ({ active: '●', done: '✓', failed: '×', idle: '○' }[status])

/** Render configured pipelines continuously; activity changes node state, never graph shape. */
const formatPathways = (state: ProjectState, opentui: any): any => {
  const chunks: any[] = []
  const add = (text: string, color = '#8b949e') => chunks.push(opentui.fg(color)(text))
  const newline = () => add('\n')
  const runStatus = (status: string): NodeState => status === 'started' ? 'active' : status === 'failed' ? 'failed' : 'done'
  const pipelines = state.topology.pipelines
  if (pipelines.length === 0) {
    add('No topology yet', '#e6edf3'); newline(); newline()
    add('The server will publish its configured profiles here.\n', '#8b949e')
    add('Listening for the /health snapshot and live events…', '#6e7681')
    return new opentui.StyledText(chunks)
  }

  for (const definition of pipelines) {
    const pipelineRun = [...state.runs.values()].reverse().find((run) => run.profile === definition.name)
    const execution = pipelineRun ? state.pipelines.get(pipelineRun.runId) : undefined
    const pipelineStatus: NodeState = pipelineRun ? runStatus(pipelineRun.status) : 'idle'
    add(`${nodeMark(pipelineStatus)} `, nodeColor(pipelineStatus))
    add(definition.name, '#e6edf3')
    add(`  ${pipelineRun ? pipelineRun.status.toUpperCase() : 'READY'}`, pipelineStatus === 'idle' ? '#8b949e' : nodeColor(pipelineStatus))
    if (pipelineRun?.wallMs != null) add(`  ·  ${(pipelineRun.wallMs / 1000).toFixed(1)}s`, '#8b949e')
    newline()
    add('  input', pipelineRun ? '#79c0ff' : '#6e7681')
    for (let index = 0; index < definition.steps.length; index++) {
      const step = definition.steps[index]!
      const observed = execution?.steps.find((candidate) => candidate.step === index)
      const status: NodeState = observed?.status === 'started' ? 'active'
        : observed?.ok === false ? 'failed'
          : observed?.status === 'completed' ? 'done' : 'idle'
      add('  ──›  ', '#484f58')
      add(`${nodeMark(status)} ${step.name}`, nodeColor(status))
    }
    add('  ──›  ', '#484f58')
    const outputStatus: NodeState = pipelineRun?.status === 'completed' ? 'done' : pipelineRun?.status === 'failed' ? 'failed' : 'idle'
    add(`${nodeMark(outputStatus)} output`, nodeColor(outputStatus)); newline(); newline()

    for (const [index, step] of definition.steps.entries()) {
      const observed = execution?.steps.find((candidate) => candidate.step === index)
      const status: NodeState = observed?.status === 'started' ? 'active' : observed?.ok === false ? 'failed' : observed ? 'done' : 'idle'
      add(`  ${index + 1}`.padEnd(5), '#6e7681')
      add(`${nodeMark(status)} `, nodeColor(status)); add(step.name, '#c9d1d9'); add(`  ${step.profile}`, '#8b949e')
      add(`  ← ${step.input ?? (index === 0 ? 'initial' : `step-${index - 1}`)}${step.field ? `.${step.field}` : ''}`, '#6e7681')
      if (observed?.wallMs != null) add(`  ${(observed.wallMs / 1000).toFixed(1)}s`, '#a5d6ff')
      newline()
    }
    newline()
  }
  const independent = state.topology.profiles.filter((profile) => profile.mode !== 'pipeline')
  if (independent.length > 0) {
    add('AVAILABLE PROFILES  ', '#6e7681')
    add(independent.map((profile) => `${profile.name} / ${profile.mode}`).join('  ·  '), '#6e7681')
  }
  return new opentui.StyledText(chunks)
}

const formatActivity = (state: ProjectState, opentui: any): any => {
  const chunks: any[] = []
  const add = (text: string, color = '#8b949e') => chunks.push(opentui.fg(color)(text))
  const heading = (text: string) => add(`${text}\n`, '#79c0ff')
  const line = (text: string, color = '#8b949e') => add(`${text}\n`, color)
  const divider = () => add('────────────────────────\n', '#30363d')

  const active = inFlightCount(state.llmRequests)
  add(`${active > 0 ? '●' : '○'} `, active > 0 ? '#3fb950' : '#6e7681')
  add(active > 0 ? `${active} model request${active === 1 ? '' : 's'} in flight` : 'Standing by for work', active > 0 ? '#3fb950' : '#8b949e')
  add('\n\n')
  heading('RECENT RUNS')
  if (state.runs.size === 0) {
    line('No runs have arrived yet.', '#8b949e')
    line('Completed work will stay visible here.', '#6e7681')
  }
  for (const run of [...state.runs.values()].slice(-6).reverse()) {
    const status: NodeState = run.status === 'started' ? 'active' : run.status === 'failed' ? 'failed' : 'done'
    line(`${nodeMark(status)}  ${run.profile}`, nodeColor(status))
    line(`   #${run.runId.slice(0, 6)}  ${run.status}${run.wallMs != null ? `  ·  ${(run.wallMs / 1000).toFixed(1)}s` : ''}`, '#8b949e')
  }
  add('\n'); divider()
  heading('MODEL REQUESTS')
  if (state.llmRequests.size === 0) line('No model requests observed.', '#6e7681')
  for (const request of [...state.llmRequests.values()].slice(-6).reverse()) {
    const status: NodeState = request.status === 'in-flight' ? 'active' : request.status === 'error' ? 'failed' : 'done'
    const tps = request.status === 'completed' ? tokPerSec(request) : undefined
    line(`${nodeMark(status)}  ${request.label}`, nodeColor(status))
    line(`   ${request.constrained ? 'constrained' : 'unconstrained'}${tps != null ? `  ·  ${tps.toFixed(0)} tok/s` : ''}${request.wallMs != null ? `  ·  ${(request.wallMs / 1000).toFixed(1)}s` : ''}`, '#8b949e')
  }
  return new opentui.StyledText(chunks)
}

const updateEventLog = (state: ProjectState, scrollBox: any, opentui: any) => {
  // Keep the last 40 events as Text lines in the ScrollBox.
  const recent = state.eventLog.slice(-40)
  if (recent.length === 0) {
    // getChildren() returns a snapshot, so re-fetch each iteration.
    while (scrollBox.getChildren().length > 0) scrollBox.remove(scrollBox.getChildren()[0]!)
    scrollBox.add(new opentui.TextRenderable(scrollBox.ctx, {
      content: new opentui.StyledText([opentui.fg('#6e7681')('Listening for metadata-only activity events…')]),
    }))
    return
  }
  const needed = recent.length

  // Remove excess lines (re-fetch snapshot each iteration).
  while (scrollBox.getChildren().length > needed) {
    scrollBox.remove(scrollBox.getChildren()[0])
  }

  // Add missing lines.
  const before = scrollBox.getChildren().length
  for (let i = before; i < needed; i++) {
    const event = recent[i]!
    const color = eventColor(event.kind)
    const line = `${event.ts.slice(11, 19)}  ${event.kind}`
    if (color) {
      scrollBox.add(new opentui.TextRenderable(scrollBox.ctx, {
        content: new opentui.StyledText([opentui.fg(color)(line)]),
      }))
    } else {
      scrollBox.add(new opentui.TextRenderable(scrollBox.ctx, { content: line }))
    }
  }

  // Update existing lines in place.
  const children = scrollBox.getChildren()
  for (let i = 0; i < needed; i++) {
    const event = recent[i]!
    const line = `${event.ts.slice(11, 19)}  ${event.kind}`
    const color = eventColor(event.kind)
    const child = children[i]
    if (child) {
      // The ProxiedVNode proxies content to the underlying TextRenderable.
      ;(child as any).content = color ? new opentui.StyledText([opentui.fg(color)(line)]) : line
    }
  }
}

const eventColor = (kind: string): string | undefined => {
  if (kind.startsWith('llm.')) return '#a0c0ff'
  if (kind.startsWith('run.')) return '#a0ffa0'
  if (kind.startsWith('http.')) return '#c0c0c0'
  if (kind.startsWith('pipeline.')) return '#ffffa0'
  if (kind.startsWith('session.')) return '#ffa0a0'
  if (kind.startsWith('turn.')) return '#ffa0a0'
  if (kind === 'stage') return '#a0ffff'
  return undefined
}
