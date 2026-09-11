# Fix plan: compact graph disclosures must reflow the graph

## Outcome

Expanding one or more step disclosures in Compact view must grow the owning workflow card to
show every stage row and move every workflow card below it far enough to preserve the normal
inter-card gap. Collapsing a disclosure must reverse that reflow. Cards, labels, controls, and
edges must never paint over another workflow.

This is a layout correction, not a visual redesign. Preserve the current compact card styling,
information density, ordering, and Full-view behavior.

## Confirmed cause

The disclosure state and the graph layout currently have different owners:

- `web/src/components/graph/CompactPipelineNode.tsx` stores expanded step numbers in component-
  local `useState` and renders the extra `.c-stages` rows inside the card.
- `web/src/lib/graph/compact.ts` receives an expansion set but does not use it. It positions each
  workflow by adding `layoutHeightOf(compactNode) + ROW_GAP`.
- `web/src/lib/graph/core.ts` calculates a compact workflow height from the header, terminals,
  base step rows, and router rows only. It does not reserve space for visible stage rows.
- Consequently the DOM node becomes taller while the following nodes retain their collapsed
  `y` coordinates. React Flow can observe the changed element bounds, but that does not run the
  repository's deterministic sibling-layout algorithm.
- `PipelineGraph.tsx` also constructs Compact view with `new Set()` on every build, so Compact
  disclosure cannot currently participate in the view-level geometry or fit-view key.

The Impeccable layout scan reports no mechanical violations in the affected files. This is a
dynamic-state defect that the static scan cannot detect.

## Spatial contract

The primary reading path in Compact view is top to bottom:

```text
product gateway
  -> selected or configured workflow
       -> ordered steps
            -> disclosed stages for that step
  -> next workflow
```

The disclosed stages belong inside their step and workflow. The next workflow is a separate
group and must begin only after the expanded card's full layout height plus `ROW_GAP`. The card
width and existing compact density stay unchanged. Expansion changes vertical geometry only.

## Implementation

### 1. Give Compact disclosure state to the graph view

Primary files:

- `web/src/components/graph/PipelineGraph.tsx`
- `web/src/lib/graph/types.ts`

Add a Compact-specific expansion set in `GraphView`. Do not reuse Full view's node expansion
set: Full view expands graph nodes, while Compact view expands a step embedded within a workflow
card.

Use a stable key that includes the compact workflow node identity and step number, for example:

```text
compact-run-1/step-0
compact-configured-clinical-verified/step-1
```

Define the key construction once in the pure graph module and use it everywhere. Add the
minimum view data needed by `CompactStepData` (`expanded` and a view-injected `onToggle`, or an
equivalent typed contract). The React component should render from those values rather than
maintaining its own `useState`.

When switching selected runs, prune keys that no longer correspond to a rendered compact node
so stale run IDs do not accumulate. Switching between Full and Compact may preserve each mode's
own disclosure state during the session, but neither mode may mutate the other mode's state.

### 2. Make the compact builder consume expansion state

Primary file:

- `web/src/lib/graph/compact.ts`

Pass the Compact expansion set through all active, idle, missing, gateway-catalogued, direct-run,
and standalone workflow construction paths. Replace the unused `_expanded` parameter with an
actively consumed `expanded` parameter.

For every compact step:

- derive its stable disclosure key;
- mark whether that key is expanded;
- count its visible stage rows only when expanded;
- keep the existing pre-order stage sequence and nesting indentation;
- expose a toggle callback from `PipelineGraph.tsx`, following the existing rule that pure graph
  builders do not own React state or touch the DOM.

After building each workflow card, advance `yOffset` using its expanded layout height. This must
apply uniformly to all loops in `buildCompactGraph`; avoid fixing only the gateway's main
workflow loop and leaving standalone or direct-run cards vulnerable.

### 3. Make one pure height calculation describe the rendered card

Primary files:

- `web/src/lib/graph/core.ts`
- `web/src/styles.css`

Extend the compact branch of `layoutHeightOf()` so it includes every visible block:

- header and progress bar;
- input and output terminal rows;
- each base step row;
- each visible router-information row;
- the expanded stage container's padding/margin;
- every visible stage row.

Extract named compact layout constants or a small pure helper instead of adding another opaque
formula. Keep those constants aligned with the corresponding `.c-*` CSS dimensions and document
why they are a geometry contract. Stage depth changes indentation, not height.

Prefer fixed/minimum row metrics plus nowrap/ellipsis for graph metadata, as the current compact
design already does. Do not make a second workflow's position depend on incidental font wrapping.
If a row is intentionally allowed to wrap in the future, its measured height must first become an
explicit input to the layout model.

Keep `.g-compact` intrinsically able to grow; do not solve the overlap with clipping,
`max-height`, internal scrolling, a larger `z-index`, or a large blanket gap. Those approaches
would hide content or leave the graph geometry false.

### 4. Render controlled disclosures and refresh React Flow internals

Primary file:

- `web/src/components/graph/CompactPipelineNode.tsx`

Remove `expandedSteps` and `toggleStep` local state. `StepRow` should receive the graph-provided
expanded value and toggle callback. Preserve the real button, `aria-expanded`, specific accessible
label, click propagation guard, and visible focus treatment.

After a disclosure changes, ensure React Flow refreshes the compact node's internals so the
bottom source handle and attached edge use the card's new boundary. With the installed
`@xyflow/react` version, use `useUpdateNodeInternals(nodeId)` from the custom node after the new
content commits (a layout effect keyed by the step-expansion signature is appropriate). This is
for handle and measured-bound updates; sibling placement still comes from the pure graph layout.

Do not animate `height: auto`. An instantaneous reflow is acceptable and avoids transient edge
and overlap errors. If motion is later added, it must keep the edge anchor synchronized and honor
`prefers-reduced-motion`.

### 5. Make viewport geometry react to Compact expansion

Primary file:

- `web/src/components/graph/PipelineGraph.tsx`

Include the modelled compact height or a compact-layout revision in `geometryKey`. Refit only
after the expanded DOM has committed and React Flow has refreshed its node bounds. The expansion
should keep the operated workflow readable without zooming the text below the existing legibility
floor.

Verify these two cases explicitly:

- expanding the first workflow pushes all later workflows down while the gateway remains fixed;
- expanding the final or only workflow grows the graph bounds even though no later node changes
  position.

Compact mode does not render the minimap today, but keep `miniNodeSize()` honest by using the
modelled compact height instead of the current fixed `76px` fallback. Otherwise any future reuse
or bounds calculation will reintroduce a collapsed-only representation.

## Tests

### Pure graph regression tests

Primary file:

- `test/web-graph.test.ts`

Add fixtures with at least two compact workflows and a selected workflow containing multiple
steps and nested stages. Assert that:

1. With no Compact disclosures open, existing card positions and ordering remain stable.
2. Expanding step 0 increases that workflow's `layoutHeightOf()` by the complete stage-container
   and stage-row height.
3. The next workflow's `position.y` equals the expanded workflow's `position.y + expanded height
   + ROW_GAP`.
4. Expanding two steps is additive and collapsing either one removes exactly its contribution.
5. Nested stage depth does not change vertical height or reorder stages.
6. Expansion works in gateway, no-gateway standalone, direct-run, and missing-definition layouts
   without duplicate keys or overlap.
7. The returned `expanded` set and per-step expanded flags agree.

Use inequalities in addition to exact geometry assertions:

```text
upper.position.y + layoutHeightOf(upper) <= lower.position.y - ROW_GAP
```

This makes the user-visible invariant unmistakable if constants change later.

### Component and browser verification

If the project adds a DOM component-test harness, cover the controlled toggle and
`aria-expanded` transition there. Do not add a heavy renderer solely for this fix; the pure
geometry tests remain part of root `npm test` and require no browser or native renderer.

Run the dashboard against synthetic repository data and verify in one bounded browser pass:

- Compact view with the first step expanded;
- every step in one workflow expanded;
- disclosures open in two adjacent workflows;
- collapse after expansion;
- long stage/profile names, nested stages, and an LLM metadata row;
- normal and fullscreen graph shells;
- narrow viewport and 200% browser zoom;
- keyboard-only toggling and focus retention;
- reduced-motion mode.

For each state, inspect both the card boundary and the gap before the next workflow. Confirm that
edges reconnect to the moved card boundaries and that the viewport can pan to the full expanded
content.

## Required verification

Run, in order:

```bash
npm test
npm run typecheck
npm run web:typecheck
npm --prefix web run build
node /home/enrique/.agents/skills/impeccable/scripts/detect.mjs --json --scope layout \
  web/src/components/graph/CompactPipelineNode.tsx \
  web/src/components/graph/PipelineGraph.tsx \
  web/src/lib/graph/compact.ts \
  web/src/lib/graph/core.ts \
  web/src/lib/graph/types.ts \
  web/src/styles.css
```

`npm run check` may replace the first two commands for the final pass, matching the repository's
non-negotiable test-plus-typecheck rule.

## Acceptance criteria

- Every expanded Compact section displays its entire stage list inside its workflow card.
- No workflow card, terminal row, label, control, or stage list overlaps another card.
- All cards below an expanded card move by the exact added height while the gateway and cards
  above it remain stable.
- Multiple simultaneous disclosures compose correctly and collapse cleanly.
- Bottom handles and edges follow the resized and repositioned card boundaries.
- Expansion remains keyboard operable, exposes accurate `aria-expanded`, and retains focus.
- Full view is unchanged.
- The graph model remains pure and deterministic; no clinical/domain knowledge enters core or
  mode code.
- Root tests, root typecheck, web typecheck, web build, and the final layout detector pass.

## Non-goals

- Redesigning Compact view or changing its width, colors, typography, or information hierarchy.
- Adding an internal scrollbar to workflow cards.
- Changing stage collection, status derivation, routing semantics, or inspector content.
- Introducing a general-purpose automatic graph layout engine.
