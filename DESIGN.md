---
name: alkor
description: A calm clinical workspace for observing local extraction runs.
colors:
  clinical-sky: "oklch(54% 0.105 205)"
  mint-wash: "oklch(93.5% 0.026 175)"
  paper: "oklch(97.5% 0.012 180)"
  surface: "oklch(99% 0.007 180)"
  ink: "oklch(28% 0.025 235)"
  quiet-ink: "oklch(48% 0.025 235)"
  divider: "oklch(86% 0.018 210)"
  caution: "#dfbd78"
  success: "#46957e"
  error: "oklch(55% 0.15 25)"
typography:
  body:
    fontFamily: '"Inter Variable", "Adwaita Sans", "Noto Sans", ui-sans-serif, system-ui, sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  data:
    fontFamily: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    fontSize: "12px"
    fontWeight: 400
  label:
    fontFamily: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    fontSize: "10px"
    fontWeight: 600
  display:
    fontFamily: "InterDisplay SemiBold, cv05 + cv11, shipped as outlines"
    fontWeight: 600
rounded:
  control: "8px"
  surface: "14px"
  graph-node: "12px"
spacing:
  compact: "8px"
  standard: "12px"
  spacious: "16px"
components:
  button-primary:
    backgroundColor: "{colors.clinical-sky}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    height: "32px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
---

# Design System: alkor

## Overview

**Creative North Star: "The Care Workspace"**

alkor is a working surface for clinical extraction, not a dark terminal. It uses a warm, near-white paper base and quiet healthcare hues so long-running workflow state can be read without visual fatigue. The graph remains the primary object; chat, activity, and log panels are supporting workspaces.

**Key Characteristics:**

- Soft mint, sky, and amber separate state without turning the dashboard into a rainbow.
- Reading copy is humanist sans; hashes, timings, and machine outputs remain monospaced.
- Surfaces are gently rounded and lightly lifted, with borders doing the structural work.

## Colors

Clinical Sky is the singular action and navigation color; Mint Wash is the quiet supporting state surface. Paper and Surface establish a low-glare clinical environment, while Ink and Quiet Ink preserve readable contrast.

**The Quiet Accent Rule.** Use Clinical Sky for actions, active controls, and key labels only. Pipeline state carries its own restrained semantic hue.

## Typography

**Body Font:** Inter Variable, delivered by the application, with Adwaita Sans and the system sans as fallbacks.
**Label/Data Font:** IBM Plex Mono, delivered, over the platform monospace stack.
**Display:** the wordmark only, and it is not a font — see below.

**Character:** One sans keeps labels and explanations calm; monospace is reserved for inputs, IDs, timings, and the execution graph. Nothing else is added: the three roles are two files.

**Why Inter, and why it is not a default.** This world always committed to Adwaita Sans, and Adwaita Sans *is* Inter — the binary reports `InterVariable-Regular;featfreeze:cv05` under the Inter Project Authors' OFL notice. The mistake was never the choice, it was delivery: no `@font-face` shipped, so the committed face resolved on GNOME desktops and nowhere else. The variable build is one 48 kB latin file carrying the whole 100–900 axis, which is what lets this system ask for 650 and 750 and actually get them.

**Why Plex Mono over Iosevka.** Adwaita's own pairing for Inter is Iosevka, and it is narrower — genuinely better for a column of sha256 digests. Its smallest web build is 366 kB, and `report.html` must embed every face it uses because it makes no network requests. Plex Mono is 14.7 kB and reads as an instrument rather than an IDE, which this world requires.

### Hierarchy

- **Title** (700, 0.8–0.85rem): compact panel and graph headings.
- **Body** (400, 14px, 1.45): workspace controls and explanatory copy.
- **Data** (400, **12px floor**): graph metadata, event log entries, connection details, and every axis label on every chart. The floor is load-bearing rather than tidy: this surface's whole purpose is measured values, and a measurement nobody can read is not a measurement. It retires the old 0.7rem step.
- **Label** (600–700, 10px floor, uppercase, tracked 0.06–0.15em): eyebrows and column headings. These may go below the data floor because they are read once as orientation and never compared — the floor governs *values*, not the words naming them.

**Known violation.** `report.html` renders chart axis ticks at 9px (`.axis-row .tick`), which is a measured value under the floor. It is recorded here rather than silently fixed: raising it risks colliding tick labels, and that cannot be judged without rendering the document in a browser.

### The wordmark

`alkor` is set in InterDisplay SemiBold with `cv05` (lowercase l with a tail) and `cv11` (single-story a) — the only two alternates this family offers for the letters *a l k o r*, and `cv05` is the one Adwaita Sans freezes, so the mark carries the glyph the project's own desktop font already chose. Tracking is −0.03em.

**It ships as outlines, never as live text** (`web/src/components/Logotype.tsx`, ~1.5 kB). The reason is mechanical: the web-delivered Inter carries no `cv` features at all, so `font-feature-settings: "cv05" 1` against it silently does nothing, and the only build that would reproduce the mark as text is 352 kB. Paths render identically everywhere and cannot flash unstyled. Size the mark by height and let the viewBox hold the 2.894 aspect; 11px of glyph height is the optical match for 14px text.

Beside it sits the **star pair**: two dots, one full-strength and one at 38% opacity. They are Mizar and Alcor, and resolving the faint one was a test of eyesight for centuries — which is what a corpus of discriminating cases is for. Use it as an accompaniment to the mark, never as a bullet or a section ornament.

## Layout

The desktop workspace is two zones under one band. A single top bar carries session truth — server, connection, model, run counters, and the two controls that act on the feed. Below it the execution graph is the resident surface, and everything that is not the graph lives in one rail beside it: sending a run, watching requests, inspecting a clicked node, and reading the raw feed, as four tabs of the same panel. The rail is drag-resizable and collapses to a strip of icons, so the canvas can take the whole window without any destination becoming unreachable.

Above the canvas sits one bar, and it answers one question: which run am I looking at, and where has it got to. Anything that changes how the canvas is *drawn* — detail level, expansion, legend — folds into a single View menu rather than a row of toggles. Inside the canvas, three corners hold one thing each: legend top-left, zoom bottom-left, overview bottom-right.

Use 8px for tight internal relationships, 12px as the normal panel rhythm, and 16px where regions need separation.

Below 900px the rail floats over the canvas instead of taking width from it, and the top bar wraps rather than truncating what it carries.

## Elevation & Depth

Surfaces are primarily distinguished by a pale border and tonal shift. Only floating or independently operable regions—the chat surface, legend, drawer, and graph nodes—use a soft downward ambient shadow.

**The Ambient Depth Rule.** Shadows are diffuse and low-contrast; never use hard offsets, glows, or stacked card shadows to imply hierarchy.

## Shapes

Primary workspace surfaces use gently rounded 14px corners. Graph nodes use a slightly tighter 12px radius and small route/options use pill shapes only when their compact, selectable nature benefits from it. Borders are one pixel and pale blue-green.

## Components

### Buttons

- **Shape:** compact rounded controls (8px) with a 32px small height.
- **Primary:** Clinical Sky with Paper text for explicit actions such as Connect and Send.
- **Secondary / Ghost:** quiet mint or transparent surfaces for view toggles and reversible actions.
- **Focus:** use the Sky ring; it must remain visible on pale surfaces.

### Chips

- **Style:** pale mint or blue-tinted fills with a slim divider border and compact monospaced metadata.
- **State:** selected runs receive a Sky border and a slightly stronger tint.

### Cards / Containers

- **Corner Style:** 14px for workspace surfaces, 12px for execution nodes.
- **Background:** Surface on Paper; node states use subtle mint, sky, amber, or rose tints.
- **Border:** one pale divider line; state is communicated with color and glyph, not a heavy colored edge.

### Inputs / Fields

- **Style:** a quiet paper field, pale divider, and 8px corners.
- **Focus:** shift the border to the Sky ring without changing layout.

### Execution Graph

The graph uses a pale dotted paper canvas, muted data edges, mint selected-route edges, and pale dashed possible-route edges. Node metadata — identifiers, profiles, timings, token counts — stays monospaced for scanning; a node's own name and its explanatory line are humanist sans, like every other name in the workspace.

Three tiers share one card grammar and are told apart by material rather than by a label: the product pipeline is the front door, a workflow card is the lifted white surface that owns the document, and a route card is recessed into the canvas because it runs inside that workflow. State is carried by glyph, surface tint, and progress; a status word appears only for work in flight or work that failed, so a board where nothing has run yet stays paper and ink and the first colour on it means something happened.

## Do's and Don'ts

- **Do** preserve high contrast between Ink/Quiet Ink and the pale paper surfaces.
- **Do** use semantic mint, sky, amber, and rose to clarify run state, not to decorate every container.
- **Do** keep the graph as the visual center of the operating screen.
- **Don't** return to a dark terminal palette for browser workspace surfaces.
- **Don't** use thick colored side borders, hard shadows, or neon status glows.
- **Don't** use monospace for ordinary explanatory copy or navigation.
