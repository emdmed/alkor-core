/**
 * CompactPipelineNode — renders a pipeline as a single container node with all
 * steps listed inside it, dramatically reducing canvas size while keeping all
 * workflow steps visible at all times.
 *
 * The card reads as three tiers on one canvas: the product pipeline decides, a
 * workflow card owns the document that arrived, and a route card is one branch that
 * workflow could take. Tier shows in fill and weight; state shows in the glyph, the
 * surface, and a word that only appears when something is actually happening. A board
 * where nothing has run yet stays quiet, so the first colour on it means work.
 */
import { memo, useLayoutEffect } from 'react'
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import type { GraphNode, GraphNodeData, CompactStepData, CompactStageData } from '../../lib/graph/index.ts'
import { fmtSec } from '../../lib/format.ts'
import { ArrowRight, Braces, Check, ChevronDown, ChevronRight, Cpu, FileInput, FileOutput, GitBranch, LoaderCircle, Orbit, PanelRight, X } from 'lucide-react'

const statusClass = (status: CompactStepData['status']): string => `is-${status}`

const statusLabel = (status: CompactStepData['status']): string =>
  status === 'active' ? 'Running' : status === 'done' ? 'Complete' : status === 'failed' ? 'Failed' : 'Queued'

const StatusIcon = ({ status }: { status: CompactStepData['status'] }) =>
  status === 'active' ? <LoaderCircle className="status-spin" /> : status === 'done' ? <Check /> : status === 'failed' ? <X /> : null

const OperationIcon = ({ operation }: { operation?: string }) => {
  if (operation === 'model') return <Cpu size={11} />
  if (operation === 'code') return <Braces size={11} />
  if (operation === 'decision') return <GitBranch size={11} />
  if (operation === 'orchestrator') return <Orbit size={11} />
  return null
}

/**
 * What the header says about progress when no status word is showing.
 *
 * At rest every card on the board is queued, so a "Queued" chip on each of them is the
 * same sentence four times over and crowds out the card's name. The count is what an
 * operator cannot already see: how much work this card holds, and how far in it is.
 */
const summaryOf = (steps: CompactStepData[], unit: 'step' | 'pass'): string | undefined => {
  if (steps.length === 0) return undefined
  const plural = unit === 'pass' ? 'passes' : 'steps'
  const active = steps.findIndex((step) => step.status === 'active')
  if (active >= 0) return `${unit} ${active + 1} of ${steps.length}`
  const done = steps.filter((step) => step.status === 'done').length
  if (done > 0 && done < steps.length) return `${done} of ${steps.length} ${plural}`
  return `${steps.length} ${steps.length === 1 ? unit : plural}`
}

const Progress = ({ steps }: { steps: CompactStepData[] }) => {
  if (steps.length === 0) return null
  const done = steps.filter((step) => step.status === 'done').length
  const active = steps.some((step) => step.status === 'active')
  const pct = (done / steps.length) * 100
  return (
    <div className={`c-progress${done === 0 && !active ? ' c-progress-empty' : ''}${active ? ' c-progress-running' : ''}`}>
      <div
        className={`c-progress-fill${active ? ' c-progress-active' : ''}`}
        style={{ transform: `scaleX(${pct / 100})` }}
        role="progressbar"
        aria-label={`${done} of ${steps.length} steps complete`}
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={done}
      />
    </div>
  )
}

const StageRow = ({ stage }: { stage: CompactStageData }) => (
  <div
    className={`c-stage ${statusClass(stage.status)}`}
    aria-label={`${stage.name}: ${statusLabel(stage.status)}`}
    style={stage.depth > 0 ? { paddingLeft: stage.depth * 14, marginLeft: 0 } : undefined}
  >
    <span className="c-stage-glyph" title={statusLabel(stage.status)}>
      <OperationIcon operation={stage.operation} />
    </span>
    <span className="c-stage-name">{stage.name}</span>
    {(stage.wallMs != null || stage.llm) && (
      <span className="c-stage-meta">
        {stage.llm && <span className="c-stage-llm">{stage.llm.constrained ? 'constrained' : 'unconstrained'}{stage.llm.tokens ? ` · ${stage.llm.tokens}` : ''}</span>}
        {stage.wallMs != null && <span className="c-stage-time">{fmtSec(stage.wallMs)}</span>}
      </span>
    )}
  </div>
)

const StepRow = ({ step, ownerProfile, expanded, onToggle }: {
  step: CompactStepData
  ownerProfile?: string
  expanded: boolean
  onToggle: () => void
}) => {
  const hasStages = step.stages.length > 0
  // The card already names the profile it runs; repeating it on every row spends the
  // widest column in the card on a word the reader just read, and truncates the one
  // case that matters — a step that hands off to a DIFFERENT profile.
  const profile = step.profile && step.profile !== ownerProfile ? step.profile : undefined
  return (
    <div className={`c-step ${statusClass(step.status)}${step.router ? ' c-step-router' : ''}`}>
      <div className="c-step-main">
        <span className="c-step-num">{step.stepNo + 1}</span>
        <span className="c-step-status" title={statusLabel(step.status)}>
          <StatusIcon status={step.status} />
          <span className="sr-only">{statusLabel(step.status)}</span>
        </span>
        <span className="c-step-label">{step.name}</span>
        <span className="c-step-meta">
          {profile && <span className="c-step-profile" title={step.profile}>{profile}</span>}
          {step.wallMs != null && <span className="c-step-time">{fmtSec(step.wallMs)}</span>}
        </span>
        {hasStages && (
          <button
            className="c-step-toggle"
            onClick={(event) => { event.stopPropagation(); onToggle() }}
            aria-label={expanded ? `Hide stages for step ${step.name}` : `Show stages for step ${step.name}`}
            aria-expanded={expanded}
          >
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
        )}
      </div>
      {step.router && step.chosenProfile && (
        <div className="c-step-router-info">
          <span className="c-step-route-label">Route</span>
          <ArrowRight aria-hidden="true" />
          <span className="c-step-chosen">{step.chosenProfile}</span>
          {step.confidence != null && <span className="c-step-conf">{(step.confidence * 100).toFixed(0)}% confidence</span>}
          {step.ruleVsModel && <span className="c-step-rule">{step.ruleVsModel}</span>}
        </div>
      )}
      {expanded && hasStages && (
        <div className="c-stages">
          {step.stages.map((stage) => <StageRow key={stage.stageId} stage={stage} />)}
        </div>
      )}
    </div>
  )
}

/** Compact pipeline node: one container card with all steps listed inside. */
export const CompactPipelineNode = memo(({ id, data }: NodeProps<GraphNode>) => {
  const d = data as GraphNodeData
  const steps = (d.steps as CompactStepData[] | undefined) ?? []

  // Stage expansion reflows the card, so the bottom source handle moves and the
  // attached edge must follow the card's new boundary. React Flow re-measures node
  // internals once the expanded content has committed.
  const updateNodeInternals = useUpdateNodeInternals()
  const expansionSignature = steps.map((step) => (step.expanded ? '1' : '0')).join('')
  useLayoutEffect(() => {
    updateNodeInternals(id)
  }, [updateNodeInternals, id, expansionSignature])

  // A route card is one branch of a profile's own decision, drawn inside the workflow that
  // contains it. It carries no Input/Output rows: the document arrived at the workflow.
  const isRoute = d.terminals === false
  // A workflow runs steps; a route runs the passes of one syndrome. Naming them apart is
  // how the two tiers stay distinguishable once both are collapsed to a list of rows.
  const summary = summaryOf(steps, isRoute ? 'pass' : 'step')
  // Only a state an operator can act on earns a word: work in flight, or work that broke.
  const flagged = d.status === 'active' || d.status === 'failed'

  return (
    <div className={`g-compact ${statusClass(d.status)}${d.muted ? ' is-muted' : ''}${isRoute ? ' is-route' : ''}`}>
      <Handle id="t" type="target" position={Position.Top} />
      <Handle id="s" type="source" position={Position.Bottom} />

      <div className="c-header">
        <span className="c-header-glyph"><StatusIcon status={d.status} /></span>
        <span className="c-header-label">{d.label}</span>
        {flagged
          ? <span className="c-header-status">{statusLabel(d.status)}</span>
          : summary && <span className="c-header-summary">{summary}</span>}
        {d.wallMs != null && <span className="c-header-time">{fmtSec(d.wallMs)}</span>}
        {d.onInspect && (
          <button
            className="c-header-inspect"
            type="button"
            title={`Inspect ${d.label}`}
            onClick={(event) => { event.stopPropagation(); d.onInspect?.() }}
          >
            <PanelRight aria-hidden="true" />
            <span className="sr-only">Inspect {d.label}</span>
          </button>
        )}
      </div>

      <Progress steps={steps} />

      {isRoute ? (
        (d.detailText || d.reason) && (
          <div className="c-route-note">{d.detailText ?? d.reason}</div>
        )
      ) : (
        <div className="c-terminal">
          <FileInput size={12} className="c-terminal-icon" />
          <span className="c-terminal-label">Input</span>
          {d.detailText && <span className="c-terminal-meta">{d.detailText}</span>}
        </div>
      )}

      <div className="c-steps">
        {steps.map((step) => (
          <StepRow
            key={step.stepNo}
            step={step}
            ownerProfile={d.profile}
            expanded={Boolean(step.expanded)}
            onToggle={step.onToggle ?? (() => {})}
          />
        ))}
        {steps.length === 0 && d.reason ? (
          <div className="c-empty c-empty-reason">{d.reason}</div>
        ) : steps.length === 0 && (
          <div className="c-empty">No steps yet</div>
        )}
      </div>

      {!isRoute && (
        <div className="c-terminal">
          <FileOutput size={12} className="c-terminal-icon" />
          <span className="c-terminal-label">Output</span>
          {d.wallMs != null && <span className="c-terminal-meta">{fmtSec(d.wallMs)}</span>}
        </div>
      )}
    </div>
  )
})
