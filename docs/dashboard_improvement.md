# Dashboard shell improvement plan

## Objective

Make the browser dashboard feel like a compact, deliberate instrument console while preserving its calm clinical visual language. The graph remains the primary workspace; the surrounding controls should help the operator start a run, confirm system state, and open detail without competing with it.

The primary task path is:

1. Confirm the server and model are available.
2. Choose a pipeline and submit input.
3. Follow execution in the graph.
4. Open activity, inspection, or event history only when needed.

## Scope boundary

This pass changes the dashboard shell only:

- Header and connection controls
- Workspace metrics strip
- Run-pipeline panel
- Activity/inspector drawer behavior and chrome
- Collapsed and expanded event log shell
- Responsive coordination between those regions
- Shared shell spacing, sizing, focus, and viewport behavior

This pass must not change:

- `PipelineGraph.tsx`
- Anything under `web/src/components/graph/`
- Graph topology, layout, nodes, edges, canvas, controls, toolbar, run chips, legend, colors, or interaction behavior
- Graph-related rules in `web/src/styles.css`, except a shell-level width reservation if required to prevent a surrounding panel from covering the graph
- Data contracts, event semantics, pipeline behavior, or backend code

## Current problems

- The header and telemetry consume about 92px before the workspace begins: a 56px header plus a 36px status strip.
- Connection state is fragmented across brand host, health badge, model name, URL input, and Connect button.
- The 328px run panel is visually as prominent as the graph even when it contains only presets and an empty state.
- At intermediate widths, the open 328px run panel and fixed 372px drawer reservation leave too little room for the primary workspace. The drawer starts reserving space at 981px, which is too early.
- On narrow screens, the run panel and drawer can both be open; the higher-z-index run panel can hide the drawer.
- The mobile header expands into three persistent rows instead of becoming more selective.
- The event log has overlapping legacy and current CSS rules, producing inconsistent inset and height ownership.
- The run textarea can be resized without a cap and consume the transcript area.
- `height: 100%` is vulnerable to mobile browser chrome; the shell should use dynamic viewport sizing.
- Shell spacing uses many unrelated values, weakening rhythm and making later refinement brittle.

The layout detector currently reports no mechanical violations. These issues are based on rendered hierarchy, space allocation, and breakpoint behavior.

## Design direction

Use an **instrument console** composition within the existing light clinical palette:

- Dense, quiet chrome around a large uninterrupted workspace
- Strong grouping by proximity rather than more cards and dividers
- A 4px base rhythm, with 4/8/12/16px as the normal spacing scale
- Compact controls with clear icons and labels; icon-only controls require accessible names and tooltips
- One restrained elevation treatment for active overlays only
- Clinical Sky reserved for live state, focus, and primary actions
- Monospace limited to URLs, model identifiers, counts, timings, and event data
- No new decorative gradients, glass effects, or dark terminal theme

Target shell dimensions:

| Region | Current | Target |
| --- | ---: | ---: |
| Header | 56px minimum | 44–48px |
| Telemetry rail | 36px minimum | 26–28px |
| Run panel | 328px | 280–300px |
| Run/drawer heading | 56px minimum | 40–44px |
| Drawer | 372px | 320–336px |
| Closed event dock | 32px plus inset | 26–28px |

## Implementation plan

### 1. Consolidate the top command bar

Files: `web/src/components/Header.tsx`, `web/src/styles.css`

- Treat brand, endpoint identity, server health, and model availability as one connection cluster.
- Keep `alkor` visually dominant; render host/model as compact machine metadata rather than separate islands.
- Preserve the editable URL and Connect action, but reduce their desktop footprint and visual weight when connected.
- Keep Pause and Clear as a distinct utility group on the right.
- Reduce the desktop header to 44–48px without reducing keyboard focus visibility or usable hit targets.
- Ensure long model names and refusal reasons truncate predictably and expose the full value through `title` text where useful.
- At intermediate widths, move to at most two rows before content begins clipping.
- On narrow screens, keep one primary row and make the endpoint editor the secondary row or an on-demand control; do not retain three permanent rows.

Acceptance checks:

- Connection identity scans as one group.
- Connect remains the only primary action in the header.
- Pause/Resume state remains explicit without relying on icon or color alone.
- A long URL, long model identifier, and refusal message do not overlap actions.

### 2. Turn metrics into a telemetry rail

Files: `web/src/components/StatusStrip.tsx`, `web/src/styles.css`

- Keep the current metrics and conditional logic unchanged.
- Replace fixed 116px cells and full-height dividers with compact icon/value/label clusters.
- Use subtle separators only between semantic groups; avoid painting an empty segmented bar across the viewport.
- Preserve tabular numerals and the existing live/error semantic states.
- Allow horizontal scrolling as a last resort, but prioritize fitting the usual idle and active states in one 26–28px row.

Acceptance checks:

- Idle state fits without wasted full-width segmentation.
- Failure and cache metrics appearing conditionally do not shift or wrap the header.
- Every metric remains understandable without color.

### 3. Rework the run panel as a compact command console

Files: `web/src/components/ChatPanel.tsx`, `web/src/App.tsx`, `web/src/styles.css`

- Reduce desktop width to 280–300px and heading height to 40–44px.
- Tighten the pipeline selector and place it directly beneath or alongside the heading according to available width.
- Present example prompts as compact actions; remove the redundant tall empty-state message when examples already explain the next action.
- Make the transcript the flexible region rather than preserving empty vertical space.
- Reduce the composer to a compact two-line field that can grow within a controlled maximum; remove unrestricted vertical resizing.
- Keep Enter-to-run and Shift+Enter behavior unchanged.
- Default the panel open only where the viewport can support it without demoting the graph. Auto-collapse below the wide-desktop threshold and respond to viewport changes.
- Preserve the collapsed run tab as an obvious, keyboard-reachable entry point.

Acceptance checks:

- Empty, running, successful, and failed states all fit without clipping.
- Long pipeline names truncate or wrap without widening the panel.
- The transcript remains scrollable with a long result.
- The composer never consumes the whole panel.

### 4. Coordinate side panels across breakpoints

Files: `web/src/App.tsx`, `web/src/components/Drawer.tsx`, `web/src/styles.css`

- Establish three shell modes:
  - **Wide desktop (about 1360px and above):** run panel may remain open; drawer may reserve 320–336px.
  - **Intermediate (about 760–1359px):** drawer overlays instead of reserving width; run panel defaults collapsed or narrows.
  - **Narrow (below about 760px):** run panel and drawer are coordinated overlays; opening one closes the other.
- Replace the current 981px fixed drawer-reservation breakpoint with a threshold based on enough remaining workspace width.
- Give overlays one shared stacking model so neither can silently conceal the other.
- Reduce drawer heading and body inset while preserving readable activity and inspector detail.
- Add Escape handling and sensible focus return for overlays if it can be done without changing their content contracts.

Acceptance checks:

- No viewport can show two competing overlays.
- The central workspace retains a useful width at 768px, 1024px, 1280px, and 1440px.
- Opening or closing a panel does not reorder DOM focus unexpectedly.

### 5. Simplify the event log dock

Files: `web/src/App.tsx`, `web/src/components/EventLog.tsx`, `web/src/styles.css`

- Make the collapsed state a slim dock attached to the bottom edge rather than a floating full-width card.
- Consolidate duplicate `.eventlog` and `.eventlog-top` rules so one block owns margin, height, and responsive behavior.
- Keep the expanded log compact, using a clamped height that leaves meaningful workspace above it.
- Keep title, kind filter, jump-to-latest action, and count on one row when possible.
- At narrow widths, shorten or hide tertiary count copy before allowing the command row to become tall.
- Preserve event filtering, pinning, autoscroll, and metadata-only content.

Acceptance checks:

- Closed and open states have consistent horizontal alignment.
- The expanded log does not cover the full workspace on short screens.
- Long event rows scroll horizontally or truncate deliberately; controls remain reachable by keyboard.

### 6. Normalize shell CSS and browser behavior

File: `web/src/styles.css`

- Introduce shell sizing and spacing custom properties for the agreed 4/8/12/16px rhythm and target region sizes.
- Remove or isolate unused legacy shell rules such as `.panes` and superseded event-log declarations only after confirming they have no mounted consumers.
- Use `100dvh` with a safe fallback for the app shell.
- Keep selection, caret, scrollbar, hover, focus-visible, disabled, loading, empty, and error states coherent with the existing palette.
- Respect `prefers-reduced-motion` for overlay transitions.
- Do not alter graph selectors during this cleanup.

## Verification

Run one bounded visual inspection after implementation, fix findings in one batch, then perform one confirmation pass.

### Functional checks

- Connect to a reachable server and display model health.
- Pause, resume, and clear the feed.
- Select a pipeline and run a preset and custom prompt.
- Exercise pending, success, and error message states.
- Open activity, inspect a graph node, and close the drawer.
- Open, filter, pin, autoscroll, and close the event log.
- Use only the keyboard for all shell controls.

### Viewports

- 1440×900 wide desktop
- 1280×800 intermediate desktop
- 1024×768 compact desktop/tablet landscape
- 768×1024 tablet portrait
- 390×844 mobile
- 200% browser zoom on desktop

At each viewport, verify reading order, clipping, overflow, overlay coordination, focus order, and remaining workspace area. Use realistic long model names, URLs, pipeline names, event kinds, and error messages.

### Automated checks

```bash
npm run web:typecheck
npm run check
node /home/enrique/.agents/skills/impeccable/scripts/detect.mjs --json \
  web/src/App.tsx \
  web/src/components/Header.tsx \
  web/src/components/StatusStrip.tsx \
  web/src/components/ChatPanel.tsx \
  web/src/components/Drawer.tsx \
  web/src/components/EventLog.tsx \
  web/src/styles.css
```

Any screenshot comparison must confirm that graph rendering and graph interactions are unchanged; only the space made available to the graph may differ.

## Delivery order

1. Header and telemetry rail
2. Run console density
3. Coordinated responsive panel behavior
4. Event log dock and CSS consolidation
5. Full shell verification and accessibility pass

Keeping these steps separate makes regressions easy to isolate and preserves the graph boundary throughout the work.
