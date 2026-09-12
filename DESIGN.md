---
name: alkor
description: A conventional modern dashboard for watching local extraction runs, executed at Linear/Vercel/Stripe craft.
colors:
  ink: "#16181c"
  ink-dark: "#f0f2f5"
  muted-ink: "#686f7c"
  muted-ink-dark: "#9aa2ad"
  faint-ink: "#70767d"
  faint-ink-dark: "#7c848f"
  canvas-grey: "#f1f3f5"
  app-grey: "#f8f9fa"
  surface-white: "#ffffff"
  surface-raised: "#fcfcfd"
  hairline: "#dee2e6"
  hairline-strong: "#ced4da"
  surface-dark: "#16181d"
  surface-raised-dark: "#191c22"
  app-dark: "#101215"
  canvas-dark: "#0c0e11"
  hairline-dark: "#2e333c"
  hairline-strong-dark: "#3a404a"
  indigo: "#4f46e5"
  indigo-hover: "#4338ca"
  indigo-soft: "#eef2ff"
  indigo-border: "#858cdf"
  indigo-dark: "#7c7ff2"
  indigo-soft-dark: "#21223a"
  indigo-border-dark: "#6266c4"
  state-ok: "#0f7b4f"
  state-ok-soft: "#e7f6ee"
  state-ok-border: "#5c9a76"
  state-ok-dark: "#4ade80"
  state-ok-soft-dark: "#12261c"
  state-ok-border-dark: "#448569"
  state-warn: "#a35a00"
  state-warn-soft: "#fdf3e3"
  state-warn-border: "#b5821f"
  state-warn-dark: "#fbbf24"
  state-warn-soft-dark: "#2a2113"
  state-warn-border-dark: "#9d7830"
  state-danger: "#c02626"
  state-danger-soft: "#fdeced"
  state-danger-border: "#d96a74"
  state-danger-dark: "#f87171"
  state-danger-soft-dark: "#2c1618"
  state-danger-border-dark: "#ab5158"
typography:
  title:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "normal"
  lead:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "normal"
  body:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
    fontFeature: "\"cv05\" 1, \"ss01\" 1"
  data:
    fontFamily: "IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
    fontVariant: "tabular-nums"
  label:
    fontFamily: "Inter Variable, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0.04em"
rounded:
  sm: "5px"
  md: "6px"
  lg: "8px"
  xl: "10px"
  pill: "999px"
spacing:
  s-1: "4px"
  s-2: "6px"
  s-3: "8px"
  s-4: "12px"
  s-5: "16px"
  s-6: "24px"
components:
  button-primary:
    backgroundColor: "{colors.indigo}"
    textColor: "{colors.surface-white}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
    typography: "{typography.data}"
  button-outline:
    backgroundColor: "{colors.app-grey}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.muted-ink}"
    rounded: "{rounded.md}"
    size: "26px"
  run-chip:
    backgroundColor: "{colors.surface-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "28px"
  run-chip-selected:
    backgroundColor: "{colors.indigo-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
  compact-workflow-card:
    backgroundColor: "{colors.surface-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    width: "360px"
  graph-node-card:
    backgroundColor: "{colors.surface-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "6px 12px"
    typography: "{typography.data}"
  graph-branch-chip:
    backgroundColor: "{colors.surface-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
    height: "24px"
  input-text:
    backgroundColor: "{colors.surface-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "28px"
  textarea-note:
    backgroundColor: "{colors.surface-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px"
    typography: "{typography.body}"
  rail-tab:
    backgroundColor: "transparent"
    textColor: "{colors.muted-ink}"
    rounded: "{rounded.md}"
    padding: "0 6px"
    height: "28px"
  rail-tab-active:
    backgroundColor: "{colors.indigo-soft}"
    textColor: "{colors.indigo}"
    rounded: "{rounded.md}"
  popover-surface:
    backgroundColor: "{colors.surface-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "12px"
---

# Design System: alkor

## Overview

**Creative North Star: "The Instrument Panel"**

This world is the category standard, and that is a decision rather than a default. Shown four
derived visual directions and the conventional modern dashboard, the user chose convention in
plain words and named Linear, Vercel and Stripe as the craft bar. Everything below follows from
that: neutral surfaces, one accent, hairline borders carrying structure, shadows reserved for
things that genuinely float, restrained motion. **"Make it more distinctive" is not an invited
change on this surface.** The work here is executing convention at a high level of finish, not
smuggling a metaphor back in. Four earlier worlds — Care Workspace, The Flowsheet, Theatre/Orbit,
The Drum Chart — were rolled and declined; none of their materials survive.

The surface is dense but not crowded. It is operated at a desk, in daylight, beside the machine
doing the work, for an hour at a stretch, by a curious technical-adjacent person who is *not* an
engineer. So: light is the default theme and the system preference is deliberately not consulted;
the type ramp is small and tight because the screen is a panel of live readings rather than a
document; and the machinery is made legible in English, with monospace reserved strictly for the
things a reader actually compares character by character. Desktop-only by product scope.

Two floors in this system are not preferences and have both bitten before: no measured value ever
renders below 12px, and body/placeholder text holds 4.5:1 while state-bearing borders hold 3:1, in
**both** themes, verified across 42 pairs. A third, newer and just as load-bearing, is the layout
contract between the compact card's CSS heights and the numeric constants the canvas is laid out
from. Each is stated as a named rule below.

**Key Characteristics:**
- Convention as a commitment: neutral greys, one indigo accent, hairline structure
- Dual theme, light default, resolved before first paint
- Dense 4px spacing rhythm on a five-step type ramp topping out at 20px
- State carried by border, tint, glyph and word together — never by colour alone
- Monospace strictly for identifiers, digests, timings and counts

## Colors

A warm-neutral grey field with exactly one accent hue and three reserved state hues; every
coloured thing on the screen is either an action or a run state.

### Primary
- **Indigo** (`{colors.indigo}` light / `{colors.indigo-dark}` dark): owns action, focus and
  selection — primary buttons, the focus ring, the caret, selected run chips, the active rail tab,
  the live stage readout, the pinned log row, traversed edges. Nothing else.
- **Indigo Wash** (`{colors.indigo-soft}` / `{colors.indigo-soft-dark}`): the selected/live fill
  behind chips, tabs, focus banners and the loaded-corpus strip. Always paired with Indigo Edge.
- **Indigo Edge** (`{colors.indigo-border}` / `{colors.indigo-border-dark}`): the 1px border of any
  running or selected surface. Measured at 3.08:1 and 3.57:1 against the card it outlines.

### Secondary
Run state, and nothing decorative. Each hue ships as a triple — text/glyph, soft fill, and a border
that clears 3:1.
- **Run Green** (`{colors.state-ok}` / `{colors.state-ok-dark}`, edge `{colors.state-ok-border}` at
  3.31:1, dark edge `{colors.state-ok-border-dark}` at 4.06:1): completed runs, done steps and
  stages, the filled progress bar.
- **Route Amber** (`{colors.state-warn}` / `{colors.state-warn-dark}`, edge
  `{colors.state-warn-border}` at 3.40:1, dark edge `{colors.state-warn-border-dark}` at 4.37:1):
  routing and decision work, degraded connection.
- **Failure Red** (`{colors.state-danger}` / `{colors.state-danger-dark}`, edge
  `{colors.state-danger-border}` at 3.35:1, dark edge `{colors.state-danger-border-dark}` at
  3.42:1): failed runs and steps, error copy, destructive confirmation.

### Neutral
- **Ink** (`{colors.ink}` / `{colors.ink-dark}`): all primary reading text.
- **Muted Ink** (`{colors.muted-ink}` / `{colors.muted-ink-dark}`): secondary metadata, labels,
  placeholders, inactive icons. The light value is **not** the obvious grey — see the Darkest Ground
  Rule.
- **Faint Ink** (`{colors.faint-ink}` / `{colors.faint-ink-dark}`): step numbers, timestamps and run
  digests — text that is present for reference but not read in sequence.
- **Surface** (`{colors.surface-white}` / `{colors.surface-dark}`): bars, cards, popovers, the rail.
- **Raised Surface** (`{colors.surface-raised}` / `{colors.surface-raised-dark}`): recessed strips
  inside a card — terminals, drawer items, message bodies, the stage readout.
- **App Grey** (`{colors.app-grey}` / `{colors.app-dark}`): the page behind the shell.
- **Canvas Grey** (`{colors.canvas-grey}` / `{colors.canvas-dark}`): the graph field and the sunken
  wells that code and JSON are printed into.
- **Hairline** (`{colors.hairline}` / `{colors.hairline-dark}`) and **Hairline Strong**
  (`{colors.hairline-strong}` / `{colors.hairline-strong-dark}`): every structural division in the
  product, and the hover border of an interactive one.

### Named Rules

**The One Accent Rule.** Indigo means action, focus or selection. Amber, green and red mean run
state. A colour that means neither is a bug: no decorative tints, no hue-coded categories, no
brand colour applied for warmth.

**The Darkest Ground Rule.** Contrast is measured against the darkest surface a token actually
lands on, not against white. Muted ink sits on the sunken panel and the canvas at
`{colors.canvas-grey}`, where the obvious `#6b7280` reads 4.35 and misses the floor; hence
`{colors.muted-ink}`. Eleven of 42 pairs failed on first measurement. Anyone who "tidies" these
values back to prettier greys or pastel borders re-breaks the floor and must re-measure all 42.

**The Three-Signal State Rule.** A state-coloured surface always ships a glyph and a word beside
the colour. Colour alone never carries run state anywhere in this product.

## Typography

**Interface Font:** Inter Variable (with ui-sans-serif, system-ui, -apple-system, Segoe UI)
**Measured-Value Font:** IBM Plex Mono (with ui-monospace, SFMono-Regular, Menlo, Consolas)

**Character:** Two faces, divided by job rather than by mood. Inter carries everything a person
reads as language — labels, names, explanations, status words — with `cv05` and `ss01` enabled at
the body. IBM Plex Mono, always with `tabular-nums`, carries everything a person *compares*:
identifiers, digests, durations, token counts, byte sizes. The ramp is small and tight, because the
screen is a panel of readings, not a document.

### Hierarchy
- **Title** (600, 20px): reserved for the rare standalone heading; the shell itself has no display
  type at all.
- **Lead** (600, 15px): the inspected object's name, and the empty-canvas message.
- **Body** (400, 13px, 1.5): every label a person reads — card headers (600), step names, control
  text, the note textarea. The interface default.
- **Data** (400, 12px, tabular): all metadata and all measured values. The floor for anything a
  reader might compare.
- **Label** (600, 11px, 0.04em, uppercase): orientation labels only — panel section titles, terminal
  captions, the route caption, badge counts. Read once to find your place, never compared.

### Named Rules

**The 12px Floor Rule.** A measured value never renders below 12px. A measurement nobody can read is
not a measurement. The 11px label step exists solely for uppercase orientation labels that are read
once and never compared; it is never used for a number, a name, a duration or a sentence, and it is
never stacked above a heading as a decorative kicker.

**The Mono-Means-Measured Rule.** Monospace marks identifiers, digests, timings, counts and raw
payloads — things compared character by character. It is **not** a texture meaning "technical". The
router card's explanatory English sentence was set in mono in this build purely for flavour and was
removed as a defect: the audience was defined as wanting to see the machinery *without* reading
JSON, and mono prose works against exactly that.

## Layout

A fixed shell around one elastic stage. The top bar is 48px, the run bar beneath it 44px, and both
are the only fixed vertical dimensions in the product; the canvas and the rail take what is left.
The right rail is resizable with a 280px minimum, collapses to a 48px icon strip, and below the
single 900px breakpoint floats over the canvas instead of taking width from it. Below 1180px the
brand descriptor beside the wordmark is the first thing dropped.

Spacing is one 4px unit on six rungs — 4, 6, 8, 12, 16, 24 — and nothing between them. 16px is the
gutter of a bar or a scrolling panel; 12px is the padding of a card or popover; 8px and 6px are the
gaps inside a control; 4px is the gap between adjacent icon buttons. Controls come in two heights,
28px standard and 32px emphasised, with 26px square icon buttons.

Overflow is resolved by rank, not by uniform shrinking: in the run bar the run strip is what gives
way (it already scrolls, and a clipped chip is recoverable) while the stage readout beside it never
shrinks, because it is the answer to "where has this run got to". A horizontally scrolling strip
fades only the edge that is actually overflowing, so a fade always means "there is more" rather
than washing out a chip that fits.

### Named Rules

**The Layout Contract Rule.** The compact workflow card's box model is duplicated as numeric
constants in `web/src/lib/graph/core.ts` — `COMPACT_HEADER_H` 38, `COMPACT_PROGRESS_H` 3,
`COMPACT_TERMINAL_H` 28, `COMPACT_STEP_H` 36, `COMPACT_ROUTER_H` 27, `COMPACT_STAGE_H` 20,
`COMPACT_STAGES_EXTRAS_H` 12, `COMPACT_ROUTE_NOTE_H` 22, `COMPACT_W` 360 — because the canvas is
laid out from fixed numbers rather than measured from the DOM. **Changing one of these heights in
CSS without changing its constant does not push siblings down; it makes nodes overlap.** This bit
once during this build: a gateway that should have stood 76px tall measured 136 and printed itself
over the workflow card beneath. Every such rule is marked `LAYOUT CONTRACT` in the stylesheet. Edit
both, or edit neither.

**The Labelled Tab Rule.** Every rail tab keeps its text label at every width this surface ships at.
Four labelled tabs fit inside the rail's own 280px minimum, so folding them to bare glyphs buys
nothing and costs the non-engineer the product is for. `aria-label` carries the name only in the
collapsed 48px icon strip, which genuinely has no room for text.

## Elevation & Depth

Structure is carried by 1px hairline borders and by tonal layering between four surface levels
(canvas → app → surface → raised); shadows are reserved for things that genuinely float. Three
steps exist and each has one job. Depth never implies hierarchy on its own: a recessed route card
loses its shadow and moves to the raised surface tone rather than gaining a heavier one.

### Shadow Vocabulary
- **Resting** (`0 1px 2px rgb(16 24 40 / 0.05)`; dark `0 1px 2px rgb(0 0 0 / 0.3)`): graph cards and
  compact workflow cards, so they read as objects sitting on the canvas.
- **Floating** (`0 4px 8px -2px rgb(16 24 40 / 0.08), 0 2px 4px -2px rgb(16 24 40 / 0.05)`; dark
  `0 4px 8px -2px rgb(0 0 0 / 0.4), 0 2px 4px -2px rgb(0 0 0 / 0.3)`): canvas furniture that sits
  over the graph — legend, minimap, zoom controls, the jump-to-latest button — and card hover.
- **Overlay** (`0 12px 20px -4px rgb(16 24 40 / 0.1), 0 4px 8px -4px rgb(16 24 40 / 0.05)`; dark
  `0 12px 20px -4px rgb(0 0 0 / 0.5), 0 4px 8px -4px rgb(0 0 0 / 0.35)`): popovers and the rail when
  it overlays the canvas.

### Named Rules

**The Hairline-First Rule.** Division is a 1px border in Hairline, not a shadow, a gap or a tinted
band. A surface earns a shadow only by floating above another surface in z-order. Hard offsets,
glows, stacked shadows and coloured left-edge accent stripes are not part of this world — the
2px coloured stripe on pinned log rows was removed because the wash behind the row already carried
the signal.

## Shapes

Radii are chosen by what the shape *is*, on a four-step scale plus a pill: 5px on small inner
affordances (icon-button hit areas, inline badges, count pills), 6px on controls (buttons, chips,
inputs, tabs, selects), 8px on surfaces (cards, expanded graph nodes, minimap, zoom controls), 10px
on floating overlays (popovers, the legend, the compact workflow card). The pill (999px) is reserved
for shapes that are genuinely round or genuinely capsule: status dots, legend swatches, the
scrollbar thumb, and the branch chip in the graph, where the capsule is what distinguishes a branch
from a card.

Silhouettes are rectangular and flat-topped. Borders are 1px everywhere; a dashed 1px border in
Hairline Strong marks a group container that holds nodes rather than content, and a dashed edge on
the canvas marks a path the run did not take. Focus is a 2px indigo outline at 1px offset, except
on graph nodes where it sits 2px outside the card.

## Components

### Buttons
- **Shape:** control radius (6px); 36px default height, 32px small, 40px large, 32px square icon.
- **Primary:** solid indigo on white text, 12px semibold, resting shadow, 16px horizontal padding
  (12px when it holds an icon).
- **Hover / Focus:** background steps to 90% opacity over 0.12–0.16s; focus is the 2px indigo ring.
- **Secondary / Outline / Ghost:** outline is a hairline border over the app grey; ghost is bare and
  fills with the accent-grey wash on hover; destructive is solid Failure Red. Disabled drops to 50%
  opacity and loses pointer events.
- **Hand-rolled controls:** any control built outside this primitive that puts an icon beside text
  must set its own flex context — see the Preflight Rule.

### Chips
- **Style:** 28px tall, hairline border, control radius, surface background, 12px text, with the run
  identifier in mono Faint Ink beside the name.
- **State:** selected chips move to Indigo Wash with an Indigo Edge and 500 weight; hover lifts the
  border to Hairline Strong and fills with the muted grey.

### Cards / Containers
- **Corner Style:** 8px for graph node cards, 10px for the compact workflow card and popovers.
- **Background:** Surface; a card nested inside another run (a route card) drops to Raised Surface
  and loses its shadow rather than gaining one.
- **Shadow Strategy:** Resting at rest, Floating on hover for compact cards; see Elevation.
- **Border:** 1px Hairline, swapping to Indigo Edge when active and Failure Red edge when failed.
- **Internal Padding:** 12px inline on compact card rows, 6px/12px on graph node cards.

### Inputs / Fields
- **Style:** hairline border in the input tone, control radius, surface background, 28px for inline
  fields and a 78–220px resizable textarea for the note input.
- **Focus:** border goes indigo and a 3px 18%-opacity indigo halo appears; the default outline is
  suppressed only because this replacement is stronger.
- **Placeholder:** Muted Ink, which is inside the 4.5:1 floor — placeholders are held to body
  contrast in this system, not to a weaker one.

### Navigation
The rail tab row is the only navigation. Tabs are 28px, control radius, 12px text in Muted Ink, with
a 14px icon and an optional mono count badge. Active is Indigo Wash and indigo text at 500 weight;
hover is the muted grey. Every destination stays reachable from the collapsed 48px icon strip.

### Compact Workflow Card (signature)
A 360px-wide card that is the canvas's default unit: a 38px header (glyph, name, status word,
elapsed, expand), a 3px progress bar, optional 28px input/output terminal strips, then 36px step
rows with 27px router detail and 20px stage rows indented behind a left hairline. State appears
three ways at once — border colour, glyph colour, and a word in the header badge. A workflow the
run did not take keeps its place at 60% opacity and returns to full on hover. **Every height in it
is under the Layout Contract Rule.**

### Expanded Graph Node
Every expanded node renders as a bare positioning wrapper around one card:
`<div class="g-{kind}"><div class="g-card">`. **The wrapper is structure and carries no paint; the
card is the only thing with a border, padding or background.** Styling both gives each node two
borders and two paddings, and because the canvas is laid out from fixed heights, those extra pixels
do not push siblings down — they overlap them. Cards carry `overflow: hidden` so any future overrun
stays inside its own box.

### Event Log Row
A full-mono row: timestamp in Faint Ink, event kind in indigo, subject in Muted Ink, at 12px with a
1.6 line height. Hover fills with the muted grey; the pinned row fills with Indigo Wash, which is
the entire selection signal.

## Do's and Don'ts

### Do:
- **Do** treat convention as the commitment. This world was chosen in plain words over four
  alternatives, with Linear, Vercel and Stripe named as the craft bar; raise the finish, do not
  raise the distinctiveness.
- **Do** hold 4.5:1 for body and placeholder text and 3:1 for state-bearing borders in both themes,
  measured against the darkest surface the token actually sits on.
- **Do** change the constant in `web/src/lib/graph/core.ts` in the same edit as any compact-card
  height in CSS.
- **Do** give every state-coloured surface a glyph and a word alongside the colour.
- **Do** set identifiers, digests, durations and counts in IBM Plex Mono with `tabular-nums`.
- **Do** give any hand-rolled control that holds an icon beside text an explicit
  `display: inline-flex; align-items: center`.
- **Do** keep the canvas control rules over-qualified with `.graph-canvas`. **The Injection Order
  Rule:** @xyflow's stylesheet ships inside the lazy PipelineGraph chunk and is injected *after*
  `styles.css`, so it wins every tie on equal specificity; its hard-coded near-white controls
  produced a white strip with near-white icons on the dark theme. That over-qualification is
  deliberate and must not be "cleaned up".
- **Do** resolve the theme before first paint, from the inline script in `web/index.html` reading
  `localStorage['alkor.theme']`, and let `useTheme.ts` read its initial value from the DOM so there
  is exactly one source of truth.
- **Do** ship the `alkor` wordmark as outlines with the Mizar/Alcor star pair beside it on the
  baseline — two dots, the companion at 0.38 opacity. It is an accompaniment to the mark, the one
  element carried across from the superseded worlds.

### Don't:
- **Don't** render a measured value below 12px, or use the 11px step for anything but an uppercase
  orientation label that is read once and never compared.
- **Don't** set English prose in monospace to make it look technical. The audience is explicitly not
  an engineer.
- **Don't** put paint — border, background, padding — on a graph node's `g-{kind}` wrapper. The
  `.g-card` inside it owns all chrome.
- **Don't** soften the state-border tokens back toward pastel. The tints they replaced measured
  1.5:1 and did no work at all.
- **Don't** use indigo for anything that is not action, focus or selection, or a state hue for
  anything that is not run state.
- **Don't** add hard offset shadows, glows, stacked card shadows, or coloured left-edge stripes; a
  wash plus a hairline already carries selection here.
- **Don't** fold a rail tab's label to a bare glyph at any width this surface ships at.
- **Don't** consult `prefers-color-scheme`. Light is the default by product decision, and the user's
  explicit choice persists.
- **Don't** use the star pair as a bullet, a divider or a section ornament, and don't set the
  wordmark as live text — the web-delivered Inter carries no `cv` features, so the mark would
  silently render wrong.
- **Don't** target `[data-slot="badge"]` with background or colour rules; those would out-specify
  the component's own variant classes and silently grey out every destructive badge.
- **Don't** carry any material from the superseded worlds — Care Workspace's clinical sky, mint wash
  and paper; The Flowsheet's buff stock and binder tabs; Theatre/Orbit's ember glow. They were
  rolled and declined, not shelved.
