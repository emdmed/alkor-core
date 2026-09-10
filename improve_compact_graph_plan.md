# Plan: make the compact graph correct and reach 20/20

## Goal

The compact graph must be a trustworthy projection of one backend source:

- `/health` defines the product pipeline, workflow catalogue, workflow steps, profile topology, and data references.
- `/events` only overlays runtime state belonging to that same backend.
- Independent workflows are never presented as sequential steps.
- Routing decisions appear at the component that actually made them.
- The graph remains readable and operable across desktop, tablet, mobile, keyboard, and reduced-motion environments.
- All behavior is covered without requiring a model, native renderer, or patient data.

Assumption: “20/20” refers to the focused web graph audit across accessibility, performance, responsiveness, theming, and implementation integrity.

## Phase 1 — Make backend connections source-safe

Primary files:

- `web/src/hooks/useMedextract.ts`
- `web/src/App.tsx`
- `web/src/components/Header.tsx`

### 1. Separate edited and active server URLs

Currently, editing the input changes `serverUrl` immediately, causing reconnection attempts for every keystroke.

Change the API to distinguish:

- `draftServerUrl`: what the input displays.
- `activeServerUrl`: the backend currently owning the dashboard state.
- `connect(candidateUrl)`: validates, normalizes, and activates the candidate atomically.

The connection form should only change the active source when submitted.

### 2. Reset state when the backend identity changes

When connecting to a different normalized origin:

- Close the old SSE client.
- Abort its outstanding `/health` request.
- Cancel pending event-flush timers.
- Empty the paused-event buffer.
- Reset `ProjectState`, including `lastSeq`.
- Reset backend model health.
- Set connection state to `connecting`.
- Start `/health` and `/events` for the new source.

This ensures a new backend starting at sequence 1 is not rejected because the previous backend had reached sequence 168.

### 3. Protect against stale asynchronous responses

Assign each connection a monotonically increasing generation ID.

Every callback must capture that generation:

- SSE event callback
- SSE connection callback
- `/health` success
- `/health` failure
- Deferred batch flush

Ignore callbacks whose generation is no longer active. This prevents a slow response from the old backend overwriting the new topology or connection state.

### 4. Define reconnect and clear semantics

Use explicit behavior:

- Connecting to a different URL resets all source-owned state.
- Reconnecting to the same URL preserves state and lets SSE replay/dedup work normally.
- “Clear” removes run/activity history but retains configured topology, profiles, active server identity, connection state, and backend model status.

The graph should remain available after “Clear.”

### Acceptance criteria

- Switching from a server at sequence 168 to one at sequence 1 immediately accepts the new server’s events.
- No old run chips or activity remain after changing origins.
- A delayed old `/health` response cannot replace the current topology.
- Typing into the URL field does not open transient SSE connections.
- Reconnecting to the same server does not duplicate events.
- Clearing history does not erase the workflow catalogue.

## Phase 2 — Model the actual product topology

Primary files:

- `web/src/lib/graph/compact.ts`
- `web/src/lib/graph/types.ts`
- `web/src/lib/graph/core.ts`

### 1. Represent the product pipeline explicitly

Use `state.topology.pipeline` as the source for the front door:

- Router: `workflow-router`
- Workflows: `clinical-verified`, `sepsis-verified`
- Default workflow: `clinical-verified`

The compact graph should contain:

1. One product-pipeline/gateway node.
2. One compact card per workflow.
3. A branch from the gateway to every catalogued workflow.

### 2. Remove false workflow-to-workflow edges

Delete the loop that currently connects adjacent compact nodes:

```text
clinical-verified → sepsis-verified
```

That relation does not exist in backend topology.

Replace it with:

```text
                    ┌→ clinical-verified
workflow-router ────┤
                    └→ sepsis-verified
```

Edge semantics:

- Possible workflow: dashed/ghost branch.
- Selected workflow: solid success branch.
- Unselected workflow: remains visible and muted.
- Never use a data-reference edge between workflow cards.

### 3. Correct graph terminology

The compact title should mirror the backend concepts:

```text
1 product pipeline · 2 workflows · compact view
```

Avoid calling the two workflow definitions “2 pipelines,” even though the compatibility payload field remains named `pipelines`.

### 4. Handle incomplete topology loudly

If `pipeline.workflows` names a missing definition:

- Render the workflow as unconfigured/failed.
- Preserve its name.
- Show a useful inspector explanation.
- Do not silently omit it.

Workflow definitions not referenced by the product catalogue should appear in a separate disconnected section or be explicitly labelled “standalone configured workflow.”

### 5. Preserve step data references

Populate `CompactStepData.inputRef` from both static definitions and observed events.

Examples:

- `initial` → “original input”
- `step-1.output`
- `document ← initial · extraction ← step-0.output`

This is part of the topology and should not disappear in compact mode.

### Acceptance criteria

- Every workflow and step matches `/health`, in order.
- The product gateway points to all and only its declared workflows.
- No edge implies that one workflow feeds another.
- Composed input references remain human-readable.
- Missing and standalone definitions are represented deterministically.

## Phase 3 — Correct runtime overlays

Primary files:

- `web/src/lib/graph/compact.ts`
- `web/src/lib/graph/run.ts`
- `web/src/components/graph/CompactPipelineNode.tsx`

### 1. Put the workflow decision on the gateway

The run-scoped `route.decided` emitted before workflow execution belongs to the product gateway.

Use it to mark:

- Chosen workflow
- Confidence
- Rule/model source
- Reason
- Traversed gateway edge

Do not propagate that decision into arbitrary pipeline steps.

### 2. Derive step routing from the step’s own stage subtree

Remove this inference:

```ts
profileMode(profile) === 'router'
```

A profile being implemented using router mode does not mean it chose the product workflow.

Only display step-level route information when that step’s own stage subtree contains a routing decision with a destination. This prevents `clinical-verifier` from displaying:

```text
Route → clinical-verified
```

A genuine router step with an observed stage decision should still show its own route.

### 3. Match runs to definitions robustly

Match the selected run using:

1. Exact workflow name when available.
2. Observed pipeline step signature.
3. Configured prefix for an in-progress run.
4. An explicit unmatched/direct-run fallback.

Do not assume `selected.profile === definition.name` is always sufficient.

### 4. Make workflow status authoritative

Derive status using both the run and its steps:

- `run.failed` always produces failed workflow status.
- `run.started` with active work produces active.
- Completed steps plus `run.completed` produce done.
- An empty workflow must not pass `every()` and become done accidentally.
- An early-stopped pipeline reflects the failing/stopped state.

### 5. Preserve nested stage information

Traverse step stages recursively in execution order.

Add stable stage data:

- Stage ID
- Nesting depth
- Status
- Operation type
- Timing
- LLM metadata
- Safe detail summary

Replace the dead `detailText` expression that currently returns `undefined` in both branches.

### Acceptance criteria

- Exactly one workflow and one gateway edge are highlighted for a selected run.
- `clinical-verifier` has no false routing annotation.
- Genuine step-local routing still renders correctly.
- Failed and stopped runs cannot appear successful.
- Nested stages expand in chronological hierarchy without duplicate or missing rows.

## Phase 4 — Accessibility and interaction

Primary files:

- `web/src/components/graph/PipelineGraph.tsx`
- `web/src/components/graph/CompactPipelineNode.tsx`
- `web/src/styles.css`

### Changes

- Add `aria-pressed` to Full/Compact, Legend, Activity, and Events controls.
- Give each workflow card an explicit keyboard-reachable “Inspect workflow” action.
- Keep stage disclosure as a real button with the workflow and step name in its accessible label, `aria-expanded`, and a visible focus state.
- Ensure no outer interactive card contains nested buttons.
- Increase mobile touch targets to at least 44×44 CSS pixels.
- Give gateway and edge state text equivalents; color must remain supplemental.
- Ensure active, complete, failed, and queued states are announced meaningfully.
- Verify focus remains predictable when opening and closing the inspector.
- Preserve useful status transitions under `prefers-reduced-motion` while removing spinning or transitional motion.
- Run automated WCAG checks and keyboard-only navigation.

### Accessibility acceptance

- Zero serious or critical automated accessibility findings.
- All graph operations are keyboard reachable.
- Visible focus never disappears behind graph or drawer layers.
- Body and metadata text meet WCAG AA contrast.
- Status and route selection are understandable without color.
- 200% browser zoom remains operable.

## Phase 5 — Responsive layout

### 1. Repair the mobile header

At narrow widths:

- Put brand and service status on their own row.
- Put the connection field and button on a second full-width row.
- Keep Pause and Clear in a non-overlapping action group.
- Hide or truncate the host label only when necessary.
- Preserve accessible names for icon-only controls.

### 2. Make compact cards legible, not merely visible

Reduce the compact node’s required width enough to fit a 390 px viewport at a readable zoom.

Use:

- Controlled truncation for long profile names
- Full names in `title` or accessible descriptions
- Consistent right-aligned timing
- No horizontal text collisions

Update deterministic layout measurements to match rendered card dimensions.

### 3. Validate viewport classes

Required captures:

- 1440×1000 desktop
- 1024×768 compact desktop/tablet
- 759 px breakpoint boundary
- 390×844 mobile
- 320 px minimum supported width
- 200% desktop zoom

### Responsive acceptance

- No document-level horizontal overflow.
- Header regions never overlap.
- Compact step text remains readable.
- Graph controls remain reachable.
- Inspector, activity panel, and run panel do not cover the only path to close them.

## Phase 6 — Theming and performance

### Theming

- Replace the hard-coded ReactFlow grid color in `PipelineGraph.tsx` with a graph-grid token.
- Replace repeated literal semantic colors in `styles.css` with existing tokens.
- Add dedicated tokens for graph grid, possible route, selected route, queued surface, failed surface, and minimap viewport.
- Validate supported-theme contrast rather than introducing an unrelated visual redesign.
- Declare the intended light color scheme explicitly if dark mode is not a supported product mode.

### Performance

- Lazy-load the ReactFlow graph chunk while rendering a stable, labelled graph-loading surface.
- Keep the graph primary by preloading its chunk immediately after the shell mounts.
- Confirm that code splitting removes the current oversized-entry warning without merely raising the warning threshold.
- Memoize minimap bounds from stable node input.
- Avoid regenerating node callbacks when unrelated panels change.
- Profile 100+ nodes and a burst of SSE frames for long tasks, repeated layout, excessive React renders, and ResizeObserver warnings.
- Maintain event batching and deterministic layout.

### Acceptance

- Production build has no unexplained size warnings.
- Initial shell and graph are separate intentional chunks.
- A 100-node topology remains responsive during SSE bursts.
- No persistent `will-change`, expensive filters, or layout animations.
- All visual colors come through the supported token system.

## Phase 7 — Regression coverage

### Extend graph model tests

Update `test/web-graph.test.ts` to import `buildCompactGraph`.

Add cases for:

1. Exact clean topology and ordered steps.
2. Gateway branching to two independent workflows.
3. No workflow-to-workflow edges.
4. Correct selected and muted gateway branches.
5. Composed input references.
6. No false route on `clinical-verifier`.
7. A genuine router step with its own decision.
8. Active, complete, failed, and stopped workflows.
9. Nested stage expansion and ordering.
10. Missing workflow definition.
11. Standalone pipeline without a product gateway.
12. Direct run without configured topology.
13. Stable unique IDs across multiple workflows.

### Add source-lifecycle tests

Extract the dashboard reducer/source transition into a pure module and add `test/web-state.test.ts`.

Cover:

1. New source resets `lastSeq`.
2. Sequence 1 from a new backend is accepted after sequence 168 from the old one.
3. Old-generation events are ignored.
4. Late old `/health` responses are ignored.
5. Same-source reconnect preserves dedup state.
6. Clear preserves topology but removes runtime history.
7. Paused events cannot cross source boundaries.
8. Typing a draft URL does not alter the active source.

### Browser smoke verification

Use synthetic metadata-only events from a throwaway HTTP/SSE server:

- No model.
- No clinical note.
- No native renderer in `npm test`.
- Distinct topologies and overlapping sequence ranges for two sources.

Verify:

- Clean load
- Live event update
- Backend switch
- Compact/full toggle
- Stage disclosure
- Workflow inspection
- Keyboard navigation
- Desktop/mobile screenshots

Keep browser smoke separate from `npm test` if it requires Chromium, respecting the repository contract.

## Verification sequence

Run in this order:

```bash
npm test
npm run typecheck
npm run web:typecheck
npm run web:build
npm run check
```

Then:

1. Run the focused mechanical detector over every changed web file.
2. Start the real server with model backends dormant.
3. Confirm `/health` topology against `profiles.toml`.
4. Sample `/events` and verify replay plus live delivery.
5. Run the two-source browser smoke.
6. Capture the required responsive viewport matrix.
7. Run accessibility checks.
8. Run the performance trace.
9. Re-run the focused audit and record evidence for every score.

## Definition of 20/20

| Dimension | Required evidence for 4/4 |
|---|---|
| Accessibility | WCAG AA contrast, keyboard-complete graph controls, visible focus, 44 px touch targets, no color-only meaning, no serious automated findings |
| Performance | Intentional graph code splitting, no unexplained build warning, bounded renders during SSE bursts, responsive 100+ node topology |
| Responsive | Clean 320–1440 px layouts, 200% zoom, no overlap or document overflow, readable compact nodes |
| Theming | Graph colors fully tokenized and correct in every supported theme/state |
| Implementation integrity | Exact backend topology, source-isolated SSE state, correct route ownership, comprehensive regression tests, zero verified detector findings |

Recommended implementation order is correctness → tests → accessibility/responsive → theming/performance → final `$impeccable polish` and audit.
