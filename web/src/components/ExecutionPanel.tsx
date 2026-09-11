import { useMemo, useState } from 'react'
import type { ProjectState, StageEntry, LlmRequestEntry } from '../../../src/tui/state.ts'
import { stageTreeForRun } from '../../../src/tui/state.ts'
import { runState, fmtSec, nodeMark, type NodeState } from '../lib/format.ts'
import { Panel } from './Panel.tsx'

const detailOf = (detail: unknown): Record<string, unknown> | undefined =>
  typeof detail === 'object' && detail !== null ? (detail as Record<string, unknown>) : undefined

/** The `{ step, ok }` payload the pipeline stamps on each step stage. */
const stepOf = (stage: StageEntry): number | undefined => {
  const d = detailOf(stage.detail)
  const step = d?.['step']
  return typeof step === 'number' ? step : undefined
}

/** Stage → node colour. A completed stage whose detail said `ok:false` failed; so does a
 *  failed llm request joined through the shared stageId. */
const stageState = (stage: StageEntry, requests: Map<string, LlmRequestEntry>): NodeState => {
  if (stage.status === 'started') return 'active'
  const d = detailOf(stage.detail)
  if (d?.['ok'] === false) return 'failed'
  const req = requests.get(stage.stageId)
  if (req?.status === 'error') return 'failed'
  return 'done'
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

/** The stage's detail as a one-line summary — closed scalar union, so this is always plain. */
const detailText = (detail: unknown): string => {
  if (detail == null) return ''
  if (typeof detail === 'string') return clip(detail, 60)
  if (typeof detail === 'number' || typeof detail === 'boolean') return String(detail)
  if (Array.isArray(detail)) return detail.map((d) => detailText(d)).slice(0, 4).join(' ')
  const e = detailOf(detail)
  if (!e) return ''
  return Object.entries(e)
    .map(([k, v]) => (v == null ? k : `${k} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`))
    .slice(0, 5)
    .join(' · ')
    .slice(0, 90)
}

const Glyph = ({ state }: { state: NodeState }) => (
  <span className={`w-3.5 text-center ${state === 'active' ? 'ok' : state === 'failed' ? 'err' : state === 'done' ? 'info' : 'faint'}`}>
    {nodeMark[state]}
  </span>
)

/** One stage of the tree, recursively: glyph, name, wall time, and the facets only that
 *  stage knows how to say — an llm-call joins its request record, an assembly its size. */
const StageNode = ({ stage, requests, depth }: { stage: StageEntry; requests: Map<string, LlmRequestEntry>; depth: number }) => {
  const req = stage.name === 'llm-call' ? requests.get(stage.stageId) : undefined
  const detail = detailText(stage.detail)
  const summary =
    req && req.status === 'error'
      ? clip(req.errorMessage ?? 'request failed', 70)
      : req
        ? `${req.constrained ? 'constrained' : 'unconstrained'}${req.promptTokens != null ? ` · ${req.promptTokens}→${req.completionTokens ?? '?'} tok` : ''}${req.finishReason ? ` · finish ${req.finishReason}` : ''}`
        : detail && stage.name !== 'workflow' && detail !== '' ? detail : ''

  return (
    <div>
      <div className="dtree-node" style={{ paddingLeft: depth * 14 }}>
        <Glyph state={stageState(stage, requests)} />
        <span className="dtree-name">{stage.name}</span>
        {stage.wallMs != null && <span className="dtree-meta">{fmtSec(stage.wallMs)}</span>}
        {summary && <span className="dtree-detail">{summary}</span>}
      </div>
      {stage.children.length > 0 && (
        <div className="dtree-children">
          {stage.children.map((c) => (
            <StageNode key={c.stageId} stage={c} requests={requests} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

/** One pipeline step: its title row, its own internal stage sub-tree, and the data-flow
 *  edge into the next step. */
const StepBlock = ({
  index,
  name,
  profile,
  status,
  wallMs,
  stage,
  requests,
  nextInput,
}: {
  index: number
  name: string
  profile: string
  status: NodeState
  wallMs?: number
  stage?: StageEntry
  requests: Map<string, LlmRequestEntry>
  nextInput?: string
}) => (
  <div>
    <div className="dtree-node">
      <Glyph state={status} />
      <span className="step-num">{index + 1}</span>
      <span className="dtree-name">{name}</span>
      <span className="dtree-meta">{profile}</span>
      {wallMs != null && <span className="dtree-meta">{fmtSec(wallMs)}</span>}
    </div>
    {stage && stage.children.length > 0 && (
      <div className="dtree-children">
        {stage.children.map((c) => (
          <StageNode key={c.stageId} stage={c} requests={requests} depth={0} />
        ))}
      </div>
    )}
    {nextInput && (
      <div className="dtree-edge">
        <span className="dtree-ref">{nextInput}</span>
      </div>
    )}
  </div>
)

const shortDigest = (d?: string): string => (d ? d.slice(0, 8) : '')

export const ExecutionPanel = ({ state }: { state: ProjectState }) => {
  // Newest last: the reducer appends, so storing from the end is chronological order.
  const runList = useMemo(() => [...state.runs.values()], [state.runs])
  const latest = runList[runList.length - 1]!
  const [selectedId, setSelectedId] = useState<string>()
  // At least `latest` is defined here — runList is non-empty after the early return above.
  const selected = runList.find((r) => r.runId === selectedId) ?? latest!

  const tree = useMemo(() => {
    if (!selected) return []
    return stageTreeForRun(state.stages, selected.runId)
  }, [state.stages, selected])
  const workflowRoot = tree.find((n) => n.name === 'workflow' && n.parentId === undefined)

  const workflowEntry = selected ? state.workflows.get(selected.runId) : undefined
  const isWorkflow = Boolean(workflowEntry || workflowRoot)

  const { workflows } = state.topology
  const independent = state.topology.profiles.filter((profile) => profile.mode !== 'workflow')

  return (
    <Panel title="EXECUTION" subtitle="latest run · activity paints the decision tree">
      {runList.length === 0 ? (
        <div className="text-sm">
          <div>No runs yet</div>
          <div className="text-muted-foreground text-xs">The server will paint each run's input → routing → per-step work → output here.</div>
          <div className="text-muted-foreground/60 text-xs">Listening for live events…</div>
        </div>
      ) : (
        <>
          {runList.length > 1 && (
            <div className="flex gap-1 flex-wrap pb-2">
              {runList.map((run) => (
                <button
                  key={run.runId}
                  onClick={() => setSelectedId(run.runId)}
                  className={`dtree-runchip ${run.runId === selected?.runId ? 'dtree-runchip-on' : ''}`}
                  title={run.runId}
                >
                  <span>{nodeMark[runState(run.status)]}</span>
                  <span>{run.profile}</span>
                  <span className="dtree-meta">#{shortDigest(run.runId)}</span>
                </button>
              ))}
            </div>
          )}

          <div className="dtree">
            <div className="dtree-node">
              <Glyph state={selected.status === 'failed' ? 'idle' : 'done'} />
              <span className="dtree-name">input</span>
              {selected.inputChars != null && <span className="dtree-meta">{selected.inputChars} chars</span>}
              {shortDigest(selected.inputDigest) && <span className="dtree-detail">sha:{shortDigest(selected.inputDigest)}</span>}
            </div>

            {workflowEntry && workflowEntry.steps.length > 0 ? (
              workflowEntry.steps.map((step, i) => {
                const stage = workflowRoot?.children.find((c) => stepOf(c) === step.step)
                const stepStatus: NodeState =
                  step.status === 'started' ? 'active' : step.ok === false ? 'failed' : step.status === 'completed' ? 'done' : 'idle'
                const next = workflowEntry.steps[i + 1]
                const nextRef = next?.input ? `${next.input.ref ?? `step-${i}`}${next.input.field ? `.${next.input.field}` : ''}` : undefined
                return (
                  <StepBlock
                    key={step.step}
                    index={i}
                    name={step.name}
                    profile={step.profile}
                    status={stepStatus}
                    wallMs={step.wallMs}
                    stage={stage}
                    requests={state.llmRequests}
                    nextInput={nextRef}
                  />
                )
              })
            ) : workflowRoot ? (
              <div className="dtree-children">
                {workflowRoot.children.map((c) => {
                  const stepIx = stepOf(c)
                  const stage = workflowEntry?.steps.find((s) => s.step === stepIx)
                  const stepStatus: NodeState =
                    stage?.status === 'started' ? 'active' : stage?.ok === false ? 'failed' : stage?.status === 'completed' ? 'done' : stageState(c, state.llmRequests)
                  return (
                    <div key={c.stageId}>
                      <div className="dtree-node">
                        <Glyph state={stepStatus} />
                        <span className="dtree-name">{c.name}</span>
                        {c.wallMs != null && <span className="dtree-meta">{fmtSec(c.wallMs)}</span>}
                      </div>
                      <div className="dtree-children">
                        {c.children.map((cc) => (
                          <StageNode key={cc.stageId} stage={cc} requests={state.llmRequests} depth={0} />
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              tree.length > 0 && <StageColumn nodes={tree} requests={state.llmRequests} />
            )}

            {!isWorkflow && tree.length === 0 && (
              <div className="dtree-node">
                <span className="dtree-detail">no stage detail for this run</span>
              </div>
            )}

            <div className="dtree-node">
              <Glyph state={runState(selected.status)} />
              <span className="dtree-name">output</span>
              {selected.wallMs != null && <span className="dtree-meta">{fmtSec(selected.wallMs)}</span>}
              {selected.error && <span className="err text-xs">{clip(selected.error, 60)}</span>}
            </div>
          </div>
        </>
      )}

      {workflows.length > 0 && (
        <div className="available">
          <span className="text-muted-foreground text-xs">CONFIGURED TOPOLOGY</span>
          {workflows.map((definition) => (
            <span key={definition.name} className="text-muted-foreground/60 text-xs">
              {definition.name}: {definition.steps.map((s) => `<${s.profile}>`).join(' → ')}
            </span>
          ))}
          {independent.length > 0 && (
            <span className="text-muted-foreground/60 text-xs">· {independent.map((p) => `${p.name} / ${p.mode}`).join('  ')}</span>
          )}
        </div>
      )}
    </Panel>
  )
}

/** Fallback column of stage nodes for a non-pipeline run: the chain the run painted. */
const StageColumn = ({ nodes, requests }: { nodes: StageEntry[]; requests: Map<string, LlmRequestEntry> }) => (
  <div className="dtree-children">
    {nodes.map((n) => (
      <StageNode key={n.stageId} stage={n} requests={requests} depth={0} />
    ))}
  </div>
)