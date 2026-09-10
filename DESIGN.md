---
name: medextract
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
    fontFamily: '"Adwaita Sans", "Noto Sans", ui-sans-serif, system-ui, sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  data:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
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

# Design System: medextract

## Overview

**Creative North Star: "The Care Workspace"**

medextract is a working surface for clinical extraction, not a dark terminal. It uses a warm, near-white paper base and quiet healthcare hues so long-running pipeline state can be read without visual fatigue. The graph remains the primary object; chat, activity, and log panels are supporting workspaces.

**Key Characteristics:**

- Soft mint, sky, and amber separate state without turning the dashboard into a rainbow.
- Reading copy is humanist sans; hashes, timings, and machine outputs remain monospaced.
- Surfaces are gently rounded and lightly lifted, with borders doing the structural work.

## Colors

Clinical Sky is the singular action and navigation color; Mint Wash is the quiet supporting state surface. Paper and Surface establish a low-glare clinical environment, while Ink and Quiet Ink preserve readable contrast.

**The Quiet Accent Rule.** Use Clinical Sky for actions, active controls, and key labels only. Pipeline state carries its own restrained semantic hue.

## Typography

**Body Font:** Adwaita Sans with Noto Sans and system sans fallbacks.
**Label/Mono Font:** the platform monospace stack.

**Character:** Humanist sans keeps labels and explanations calm; monospace is reserved for inputs, IDs, timings, and the execution graph.

### Hierarchy

- **Title** (700, 0.8–0.85rem): compact panel and graph headings.
- **Body** (400, 14px, 1.45): workspace controls and explanatory copy.
- **Data** (400, 0.7–0.8rem): graph metadata, event log entries, and connection details.

## Layout

The desktop workspace is a three-part operating view: chat is left-aligned, the expandable execution graph occupies the flexible center, and activity/inspection slides from the right. The event log stays below as a full-width history surface. Use 8px for tight internal relationships, 12px as the normal panel rhythm, and 16px where regions need separation.

At constrained widths, existing grid breakpoints stack supporting panels before compromising the graph's interaction area.

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
