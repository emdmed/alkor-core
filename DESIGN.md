---
name: alkor
description: A ledger for watching local model runs — structure drawn in 1px rules and space, one accent, two surfaces, square corners.
colors:
  ground: "#16100d"
  ground-light: "#f7f1e8"
  veil: "#130804"
  veil-light: "#efe4dd"
  rule: "#362721"
  rule-light: "#e8d2c5"
  rule-strong: "#4f362d"
  rule-strong-light: "#d7b6a6"
  rule-accent: "#6b3727"
  rule-accent-light: "#d19983"
  ink: "#efe5d8"
  ink-light: "#201810"
  ink-2: "#b1a395"
  ink-2-light: "#625448"
  ink-3: "#948474"
  ink-3-light: "#706052"
  action: "#e2542a"
  action-hover: "#f0603b"
  action-ink: "#16100d"
  action-ink-light: "#201810"
  action-mute: "#af5136"
  action-mute-light: "#c95a37"
  syn-str: "#c8aa96"
  syn-str-light: "#6f5443"
  syn-num: "#e08b74"
  syn-num-light: "#8e412c"
  mark-counter: "#ffffff"
  mark-counter-light: "#000000"
  state-ok: "#80b66e"
  state-ok-light: "#397421"
  state-warn: "#c1a147"
  state-warn-light: "#805e00"
  state-danger: "#e1859b"
  state-danger-light: "#9d3d59"
typography:
  title:
    fontFamily: "Archivo Variable, Archivo, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.018em"
  lead:
    fontFamily: "Archivo Variable, Archivo, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.55
    letterSpacing: "normal"
  body:
    fontFamily: "Archivo Variable, Archivo, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  data:
    fontFamily: "Spline Sans Mono Variable, Spline Sans Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "0.04em"
    fontVariant: "tabular-nums"
  label:
    fontFamily: "Archivo Variable, Archivo, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0.04em"
    textTransform: "uppercase"
rounded:
  sm: "2px"
  md: "2px"
  lg: "2px"
  xl: "2px"
  pill: "999px"
spacing:
  s-1: "4px"
  s-2: "6px"
  s-3: "8px"
  s-4: "12px"
  s-5: "16px"
  s-6: "24px"
elevation:
  shadow-sm: "none"
  shadow-md: "none"
  shadow-lg: "none"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.action-ink}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
    border: "1px solid transparent"
  button-primary-disabled:
    backgroundColor: "transparent"
    textColor: "{colors.ink-3}"
    border: "1px solid {colors.rule}"
    rounded: "{rounded.md}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    border: "1px solid {colors.rule}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.md}"
    size: "26px"
  pill:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    border: "1px solid {colors.rule}"
    rounded: "{rounded.md}"
    padding: "1px 8px"
    typography: "{typography.data}"
  run-chip:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    border: "1px solid {colors.rule}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "28px"
  run-chip-selected:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    border: "1px solid {colors.action-mute}"
    rounded: "{rounded.md}"
  ledger-row:
    backgroundColor: "transparent"
    borderBottom: "1px solid {colors.rule}"
    padding: "12px 0"
  compact-workflow-card:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    border: "1px solid {colors.rule}"
    rounded: "{rounded.xl}"
    width: "360px"
  graph-node-card:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    border: "1px solid {colors.rule}"
    rounded: "{rounded.lg}"
    padding: "6px 12px"
    typography: "{typography.data}"
  graph-branch-chip:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink-2}"
    border: "1px solid {colors.rule}"
    rounded: "{rounded.sm}"
    padding: "0 8px"
    height: "24px"
  input-text:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    border: "1px solid {colors.rule-strong}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "28px"
  textarea-note:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    border: "1px solid {colors.rule-strong}"
    rounded: "{rounded.md}"
    padding: "8px"
    typography: "{typography.body}"
  code-pane:
    backgroundColor: "{colors.veil}"
    textColor: "{colors.ink}"
    border: "1px solid {colors.rule-strong}"
    rounded: "{rounded.md}"
    typography: "{typography.data}"
  rail-tab:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.md}"
    padding: "0 6px"
    height: "28px"
  rail-tab-active:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    borderBottom: "2px solid {colors.action}"
  popover-surface:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    border: "1px solid {colors.rule-strong}"
    rounded: "{rounded.xl}"
    padding: "12px"
---

# Design System: alkor

## Overview

**Creative North Star: "The Ledger"**

A ledger, not a dashboard chrome kit. Structure is drawn by 1px rules and space — there are no
shadows, no tinted panels, no second surface colour and no card radii. The one filled object in
a view is its primary action, and it carries the one accent.

This world is distilled in **`web/src/alkor-ledger.css`**, which is **vendored and must not be
edited in place**; its home is `alkor-web/system/`. That file owns the palette, the two faces,
the type ramp, the seven primitives and the rules. `web/src/styles.css` owns the dashboard
built from them. A new colour, face or rule goes upstream; a new component stays local until a
second use earns it a promotion.

It supersedes the "conventional modern dashboard" world committed to on 2026-09-12 (Linear,
Vercel and Stripe as the craft bar). That reversal was made deliberately on 2026-09-14 and is
recorded in PRODUCT.md rather than deleted, so the next reader can tell a decision from drift.
The craft bar still stands; what changed is the world, not the standard of finish.

**The metaphor is load-bearing, not decorative.** Alkor is the faint companion of Mizar, and
for centuries a test of eyesight — whether you could resolve it told you whether your
instrument was good enough. A surface whose whole job is to let someone watch a small model
work, and see exactly where it went wrong, is doing that job. The palette is warm because the
page is meant to read as ink on stock rather than light on glass.

## Colors

**Nothing here is a neutral.** Every rung is derived from the accent in OKLCH and the hue walks
with the role: text at 66–72°, the ground at 44–46°, structure at 38–42°, the accent itself at
36.5°. Chroma climbs with the rung — 0.012 at the ground, 0.078 at a major rule, 0.185 at the
accent. That is what stops a surface which is 95% text from reading as monochrome, and it is
why a stock grey dropped into this palette is the one colour that will look wrong.

Dark is the file's default; the light twin is warm paper, not white. **Which one ships is the
operating system's call** — the dashboard follows `prefers-color-scheme` until the user touches
the toggle, after which their choice persists.

### Primary

`--color-action` **#e2542a**, one value in both themes. It is *identity and interaction*, and
exactly four things: Mizar in the lockup, the primary button's fill, the focus ring, and the
current-item mark. Nothing else, never decoration.

`--color-action-mute` (#af5136 dark / #c95a37 light) is the same accent at mark strength, 3.6:1
and 3.7:1, for 1px borders on interactive containers.

### Secondary

There is no secondary colour. A secondary control is the same ink with no fill and a hairline.
The system's "second emphasis" is a rule, not a hue.

### Neutral

Six rungs, all warm, all derived: `--color-ground` and `--color-veil` for the two surfaces;
`--color-rule`, `--color-rule-strong` and `--color-rule-accent` for structure; `--color-ink`,
`--color-ink-2` and `--color-ink-3` for language. `--color-ink-3` is the dimmest text the
system allows and there is no rung below it, on purpose.

`--color-mark-counter` (pure #ffffff / #000000) is the one pure value in the palette, and it
exists solely for Alcor's crescent in the lockup, which is ~3px deep at topbar size.

### State

`--color-ok` / `--color-warn` / `--color-danger` share one L/C band (L 0.72 / C 0.115 in dark,
L 0.50 / C 0.130 in light) with only the hue telling them apart — 138° / 90° / 5°. They read as
siblings rather than three borrowed colours, and each clears CIELab ΔE 45.6 from the accent.

**Danger is rose, not salmon, and that is load-bearing.** The accent sits at hue 14°, exactly
where an orange-red "failed" would land. Rose at 346° is 28° of hue away, the distance
`--color-warn` already holds. **If you retune the accent, re-measure that ΔE before shipping.**

### Named Rules

- **The accent fills and marks; it is never text.** On the light ground it measures 3.33:1 —
  enough for a fill or a 1px rule, not enough for a word. Where the accent must read as
  language, set the word in `--color-ink` and let a mark beside it carry the colour. The
  marketing page's one exception (a headline figure at display size, where 3:1 is the bar) does
  not transfer: this surface caps at 20px.
- **Four reserved roles, not interchangeable.** The accent is identity and interaction. The
  three state hues mean **run state** — never emphasis, never branding, never UI feedback. A
  "Copied" confirmation is not a run outcome; it signals by changing its word.
- **A run's output is not a run's state.** Syntax has its own rungs, `--color-syn-str` and
  `--color-syn-num`, from the accent family. Borrowing `--ok` for a string and `--warn` for a
  number once printed a clinical verdict in the pass colour and `"unverified": 0` — the good
  outcome — as a warning, on a live page.
- **A taxonomy is not a state either.** Classify with shape — a filled disc, a hollow ring, a
  diamond — which survives colourblindness. The canvas legend's "model / deterministic /
  decision" group is the reference implementation.
- **A comparison is a length, not a colour.** Never tint a low figure with `--color-danger`: a
  smaller number is not a failed run.
- **State is never carried by colour alone.** Every dot ships beside a word.
- **Standing facts are not states.** The header's clinical disclaimer and an open CORS origin
  take `--color-rule-accent` and full-contrast ink, not `--color-warn`. They are not going to
  resolve, and they are equally true before any run starts.

## Typography

Two faces, neither optional, both bundled rather than fetched — this runs beside a local model
on someone's own machine and must work with no network. The closest installed grotesque is a
failure, not a fallback.

**Archivo** carries language. **Spline Sans Mono** carries anything a reader compares character
by character: identifiers, ports, digests, durations, counts, measured values, code.

### Hierarchy

Five steps, each a rung of the ledger's Operate ramp. This surface sits one rung below a
reading column because it is a panel of live readings rather than prose.

| Role | Size | Use |
|---|---|---|
| `--t-title` | 20px | the cap; a view's one heading |
| `--t-lead` | 15px | a section title in the settings reading column |
| `--t-body` | 13px | the dashboard's body |
| `--t-data` | 12px | **the measured floor**; all mono |
| `--t-label` | 11px | uppercase eyebrows only — never a measured value |

`--text-display` does not exist on this surface. Reaching for a landing-page size in an app
view is the one reliable way to make this system look like a marketing page wearing an app's
clothes.

### Named Rules

- **A measured value never renders below 12px.** These numbers are read, compared and quoted;
  size on data is an accessibility concern, not a stylistic one.
- **Mono means measured.** Not "technical-looking headings". Everything mono is `tabular-nums`,
  so columns line up and a number that changes does not shift the ones beside it.
- **11px is for orientation, never comparison.** It is under the floor and earns that only by
  being an eyebrow read once. Nothing at `--t-label` may be a figure, an identifier or a
  duration.
- **Emphasis is a rule under the words, never a highlight behind them.**

## Layout

Dense: 12 / 16 / 24px, against the 96px bands of the marketing surface. One 4px unit, six
rungs, nothing between them. Fixed dimensions exist only for shell regions — a 48px topbar, a
44px stage bar, a 48px rail strip.

### Named Rules

- **Structure is rule and space.** Never a shadow, never a gradient, never a box where a rule
  would do. A panel that needs to feel separate gets a rule and more space, not a fill.
- **There are exactly two surfaces, and the second one sinks.** `--color-ground` is the page.
  `--color-veil` is recessed — code blocks, log panes, JSON readouts — and sits *under* the
  ground at 1.05:1, close enough that the border draws the edge and the sink is only felt. Lift
  it or give it real chroma and it stops reading as a screen and starts reading as a card. **Do
  not invent a third.**
- **Rules carry hierarchy, and there are three weights.** `--color-rule` for minor divisions
  (list rows, ledger columns). `--color-rule-strong` for emphasis inside a block, for inputs,
  and for anything floating over the canvas. `--color-rule-accent` for **major divisions
  only**. Spending the accent rule on every boundary spends the hierarchy.
- **A list is a column of rows on rules, not a stack of cards.** The activity feed, the
  inspector feed and the run transcript are all this shape.
- **The canvas is the page.** A graph *is* the run, so it reads on the same ground as
  everything else and its nodes are rows with a border, not widgets on a tray.

## Elevation & Depth

**There is none.** Structure is rule and space.

### Shadow Vocabulary

`--shadow-sm`, `--shadow-md` and `--shadow-lg` all resolve to `none`. The names survive only so
that a `box-shadow: var(--shadow-md)` left anywhere — including inside a shadcn primitive's own
classes — resolves to nothing rather than to a hard-coded default. **Do not give one a value.**

### Named Rules

- **Things that genuinely float are separated by `--color-rule-strong`, not by elevation.** A
  popover, the canvas legend, the minimap and the zoom controls all sit on the same ground as
  what is under them, so the minor rule is not enough and the strong one is exactly enough.
- **Hover is a rule getting stronger, or a transient wash — never a lift.**
- **The hover wash is the one fill that is not the primary action**, and it earns the exception
  by being transient. It is `color-mix(in oklab, var(--color-ink) 8%, transparent)` so it stays
  inside the temperature gradient.

## Shapes

**Square. 2px everywhere, without exception, pills included.** No 999px lozenges, no 12–16px
card radii. `--r-pill` survives only for things that are genuinely circles: a 5–10px state dot,
a spinner. A chip, a badge, a switch track, a slider thumb and a button are all 2px.

## Components

### Buttons

One filled, one ruled. **There is exactly one filled button in a view** — a second filled block
is how this world stops reading as a ledger. Everything else is ruled, ghost, or a link.

A **disabled** button loses its fill rather than fading it: transparent, `--color-ink-3`, a
hairline. `opacity: 50%` on an accent fill produces a washed-out orange that is in the palette
nowhere, still reads as the loudest object in the view, and drops the label under 4.5:1. Every
variant reserves a 1px transparent border so nothing shifts when a button becomes available.

### Pills

A mono tag, square, never filled. Variants name **run states** — `active` / `done` / `failed` /
`idle` — rather than shadcn's generic tones, because mapping "active" onto "default" is how the
accent ended up meaning "this is running". `active` is `--color-warn`. A pill is never the
accent: a pill is never the current item.

### Cards / Containers

There are none. Use `.alk-ledger` (columns divided by rules) or the ledger row. The compact
workflow card and the graph node are the two exceptions, and both are **bordered rows** rather
than cards: 1px rule, 2px corner, no fill beyond the ground, no shadow.

### Inputs / Fields

Ground fill, `--color-rule-strong` hairline, 2px corner. Inputs take the strong rule rather
than the minor one because they are the one control the reader aims at rather than reads.

### Navigation

The current tab is marked by a 2px accent rule under its label, with the label in ink. The
current settings section is marked by a 2px accent rule down its left edge. Never a tinted
wash, and never an accent word.

### Compact Workflow Card (signature)

360px, bordered, square. **LAYOUT CONTRACT:** every height in it is duplicated as a numeric
constant in `web/src/lib/graph/core.ts` (`COMPACT_HEADER_H` and friends) because the canvas is
laid out from those numbers rather than measured. Changing a height here without changing its
constant there silently mislays every edge on the canvas. Each such rule is marked in
`styles.css`.

### Expanded Graph Node

Same grammar as everything else: 1px rule, 2px corner, mono, state dot. Edges take
`--color-rule-strong` at 1px; a taken route is drawn in `--color-ink-3` because it is what you
read the run off; a possible-but-not-taken route is the minor rule, dashed. **No edge takes the
accent** — the accent marks the current node, not a line across the board.

### Event Log Row

Mono, 12px, tabular. A pinned row takes a 2px inset accent stripe — the current-item mark — and
no fill. The event kind is ink, not the accent: it is an identifier the reader compares down
the column.

### Motion

**One authored moment per view.** A run takes minutes on this hardware, so motion's job is to
say a thing changed, not to entertain during the wait. Exponential ease-out
(`cubic-bezier(0.16, 1, 0.3, 1)`), short, from an already-visible default — never an entrance
that hides content while it plays.

The dashboard's one moment is the step-commit wash: the row whose work just landed takes its
state's colour at 14% and lets it drain over 900ms. It animates `background` and nothing else,
because every height in that card is a LAYOUT CONTRACT and an animation touching geometry would
make the canvas mislay its edges for the length of the transition.

## Do's and Don'ts

### Do:

- Draw structure with a 1px rule and space.
- Spend the accent on a fill, a 1px mark, the focus ring, or the current item — and nowhere else.
- Set every measured value in mono, tabular, at 12px or larger.
- Ship a word beside every state colour.
- Classify with shape; report outcome with hue.
- Theme the browser's own surfaces — selection, caret, scrollbar, focus ring. They are the
  cheapest signal that this was built rather than assembled, and the first thing skipped.
- Put a real datum in a section header's right half. If there is nothing true to put there, you
  want a plain heading.
- Check the star pair's paint order on sight: Alcor first, Mizar over it.

### Don't:

- Don't letter a word in the accent — not a count, not a status, not a link, not the wordmark.
- Don't add a shadow, a gradient, or a third surface.
- Don't use a rounded corner larger than 2px, or a 999px radius on anything that is not a circle.
- Don't put a tint behind text to mark a selection; mark it with a rule.
- Don't spend a state hue on a taxonomy, a ranking, a standing caveat, or UI feedback.
- Don't let a second filled object into a view.
- Don't drop a stock grey into the palette.
- Don't reach for a display size on this surface.
- Don't edit `web/src/alkor-ledger.css` in place — it is vendored.
- Don't change a compact-card height without changing its constant in `lib/graph/core.ts`.
