---
name: hooked
description: Local dashboard for Claude Code sessions, read like a cup on the coffee taster's flavour wheel.
colors:
  raw-sage-r0: "#fbfbf8"
  raw-sage-r1: "#f2f3ec"
  raw-sage-ground-r2: "#e9ebdf"
  raw-sage-r3: "#e3e4d7"
  raw-sage-line-r4: "#dadacd"
  raw-sage-line-r5: "#c7c4b7"
  husk-r6: "#aaa497"
  roast-muted-r7: "#6e6056"
  roast-r8: "#4d3f37"
  roast-r9: "#3a2d27"
  roast-r10: "#2f231f"
  espresso-r11: "#261b18"
  espresso-bar-r12: "#1e1512"
  espresso-ink-r13: "#18110e"
  espresso-grounds-r14: "#110a09"
  porcelain: "#ffffff"
  latte: "#e4cdb1"
  latte-hover: "#efdfc8"
  crema-soft: "#f3e5d9"
  roast-link: "#76482d"
  cherry-attention: "#c43d4d"
  cherry-attention-ink: "#a12437"
  cherry-attention-soft: "#f9eaeb"
  caramel-waiting: "#e1901f"
  caramel-waiting-ink: "#8b5500"
  caramel-waiting-soft: "#fbefe0"
  leaf-working: "#418d50"
  leaf-working-ink: "#256b35"
  leaf-working-soft: "#e8f1ea"
  lilac-background: "#9e59b3"
  lilac-background-ink: "#804293"
  papery-idle: "#92a1a9"
  roasted-ended: "#96684f"
  roasted-ended-ink: "#724a34"
  dark-cherry-attention: "#ed737b"
  dark-caramel-waiting: "#f5ad5a"
  dark-leaf-working: "#70c47e"
  dark-lilac-background: "#ca92dc"
  dark-papery-idle: "#6f7d84"
  dark-roasted-ended: "#be947d"
  dark-roast-link: "#d9ad8a"
  lot-olive: "#918112"
  lot-olive-deep: "#524806"
  lot-teal: "#0d8d82"
  lot-teal-deep: "#004e4e"
  lot-blue: "#2b519c"
  lot-raspberry: "#b3487e"
  lot-blue-light: "#4b7bc0"
  lot-raspberry-deep: "#75254e"
  tag-olive: "#665d00"
  tag-teal: "#006f5d"
  tag-cyan: "#006c7b"
  tag-blue: "#005f99"
  tag-indigo: "#41559e"
  tag-raspberry: "#8a3a64"
  code-fg: "#e8e1d6"
  code-dim: "#8f8276"
typography:
  display:
    fontFamily: "Bricolage Grotesque, Schibsted Grotesk, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "40px"
    fontWeight: 750
    lineHeight: 1
    letterSpacing: "-0.03em"
    fontFeature: "tnum"
  stat-figure:
    fontFamily: "Bricolage Grotesque, Schibsted Grotesk, sans-serif"
    fontSize: "27px"
    fontWeight: 750
    lineHeight: 1.1
  headline:
    fontFamily: "Bricolage Grotesque, Schibsted Grotesk, sans-serif"
    fontSize: "25px"
    fontWeight: 750
    lineHeight: 1.2
    letterSpacing: "-0.025em"
    fontVariation: "'opsz' 36"
  title:
    fontFamily: "Bricolage Grotesque, Schibsted Grotesk, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  card-title:
    fontFamily: "Schibsted Grotesk, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "Schibsted Grotesk, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.62
  ui:
    fontFamily: "Schibsted Grotesk, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.5
  meta:
    fontFamily: "Schibsted Grotesk, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Schibsted Grotesk, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.5
    fontFeature: "tnum"
  mono:
    fontFamily: "JetBrains Mono Web, ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  lot: "2px"
  kbd: "4px"
  control: "8px"
  field: "10px"
  bubble-tail: "5px"
  card: "16px"
  pill: "999px"
spacing:
  hair: "4px"
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "22px"
components:
  button-primary:
    backgroundColor: "{colors.espresso-r11}"
    textColor: "{colors.raw-sage-r0}"
    rounded: "{rounded.pill}"
    padding: "6px 14px"
    typography: "{typography.ui}"
  button-primary-hover:
    backgroundColor: "{colors.roast-r9}"
  button-secondary:
    backgroundColor: "{colors.porcelain}"
    textColor: "{colors.espresso-ink-r13}"
    rounded: "{rounded.pill}"
    padding: "6px 14px"
  button-new-session:
    backgroundColor: "{colors.latte}"
    textColor: "{colors.espresso-bar-r12}"
    rounded: "{rounded.pill}"
  button-new-session-hover:
    backgroundColor: "{colors.latte-hover}"
  topbar:
    backgroundColor: "{colors.espresso-bar-r12}"
    textColor: "{colors.raw-sage-r1}"
    height: "48px"
  card:
    backgroundColor: "{colors.porcelain}"
    rounded: "{rounded.card}"
    padding: "12px 16px"
  input:
    backgroundColor: "{colors.raw-sage-r1}"
    textColor: "{colors.espresso-ink-r13}"
    rounded: "{rounded.control}"
    padding: "5px 10px"
  bubble-user:
    backgroundColor: "{colors.espresso-r11}"
    textColor: "{colors.raw-sage-r0}"
    rounded: "{rounded.card}"
    padding: "11px 14px"
  bubble-assistant:
    backgroundColor: "{colors.porcelain}"
    textColor: "{colors.espresso-ink-r13}"
    rounded: "{rounded.card}"
    padding: "11px 14px"
  lot-tab:
    backgroundColor: "{colors.lot-teal}"
    rounded: "{rounded.lot}"
    width: "14px"
    height: "7px"
  state-pill-waiting:
    backgroundColor: "{colors.caramel-waiting-soft}"
    textColor: "{colors.caramel-waiting-ink}"
    rounded: "{rounded.pill}"
    padding: "3px 9px 3px 8px"
    typography: "{typography.label}"
---

# Design System: hooked

## Overview

**Creative North Star: "La Roue des arômes"**

hooked reads its sessions like a cup on the coffee taster's flavour wheel: each live state is one flavour family, one hue with one meaning, laid on a roasted, cool-modern shell. The space is raw green coffee (a sage ground with porcelain-white cards); the ink and the chrome are roasted espresso (text, the top bar, primary actions). The dark theme turns the bean over: espresso grounds, raw-sage ink. Both themes are first-rank and AA-measured; neither is a derivative of the other.

Colour is spent only on meaning: live states, project lots, tags and data series. Everything else is a step of one roast-tinted neutral ladder. Coffee lives in the materials (sage, porcelain, espresso, latte, a fine roast grain) and in one signature, the fleet wheel, never in ornament: no beans, no cream, no serif, no latte art, and the English UI wording is untouched by the world.

Density is that of a working console: a 48px espresso bar, compact 13px controls, a calm 14px reading measure in conversations. Everything is local: fonts are bundled woff2 in `static/fonts/`, the grain is inline SVG noise, nothing is fetched from a CDN.

**Key Characteristics:**
- One neutral family, the roast scale r0…r14; no grey outside it.
- Six state families, each carried by label + shape + hue, never hue alone.
- Interaction is espresso in light, latte in dark, never a state hue.
- Projects wear a fixed lot hue as a 2:1 tab, from hue bands no state owns.
- The fleet wheel is live in three places: Deck, top-bar mark, favicon.
- A roast grain on the sage ground only (the espresso bar stays flat), never under text-dense cards.

## Colors

A raw-to-roasted neutral ladder carrying everything structural, with saturated hue reserved for the six flavour-family states, eight project lots and six tags.

### Primary
- **Espresso** (r11): the interaction colour in light: primary buttons, the user's conversation bubbles, active-tab underlines, checked boxes, single-series bars. Hover deepens to r9.
- **Latte**: the interaction colour in dark, and on the espresso bar in both themes ("+ Session", the gauge fills, the active top-bar tab, the core of the wheel mark). Hover lightens to latte-hover. Text set on it is espresso r12/r13.
- **Crema Soft**: the quiet selected/active wash (selected legend key, follow-up box) in light; `#3a2a1f` in dark.

### Secondary (state families, the flavour wheel)
Each state has a bright hue for dots, rings, arcs and fills, an `-ink` form readable as text (≥4.8:1 on porcelain and on the ground), and a `-soft` tint for washes. In dark the bright hue is already readable, so the ink is the hue itself.
- **Cherry** (fruity) = attention / action required. Diamond mark.
- **Caramel** (sweet) = waiting for you. Disc.
- **Leaf** (vegetal) = working. Disc with pulse.
- **Lilac** (floral) = background job. Thick ring.
- **Papery grey-blue** = idle / paused. Hairline ring.
- **Roasted brown** = ended. Square.

### Tertiary (lots, tags, series)
- **Project lots** (`--lot-0…7`): olive, deep olive, teal, deep teal, blue, raspberry, light blue, deep raspberry; dark theme lightens each. `lotColor()` hashes the repo's last path segment into one of 8, so the same repo wears the same lot on its sidebar group header, Deck repo header, decision cards, session header and its Stats bar.
- **Tags** (`--tag-0…5`): olive, teal, cyan, blue, indigo, raspberry inks, readable on their own 13% tint (≥5:1). `tagColor()` picks them; dark lightens them.

### Neutral
- **Raw Sage Ground** (r2): the page canvas, light. Dark: r13.
- **Porcelain** (`#ffffff`): cards, panels, headers, assistant bubbles, light. Dark: r11 cards, r12 panels.
- **Raw Sage r1 / r3**: hover and input wash; chips and tracks.
- **Sage Lines** (r4, r5): borders, light. Dark: r9, r8.
- **Roast Muted** (r7): secondary text (6.05:1 on porcelain, 5.02:1 on ground). Dark: husk r6.
- **Espresso Ink** (r13): body text. Dark: r1.
- **Espresso Bar** (r12): the top bar and code surfaces; r14 in dark.
- **Roast Link**: links, `#76482d` light, `#d9ad8a` dark.
- **Code inks**: `--code-fg`, `--code-dim`, `--code-mute`, `--code-soft` on the espresso code surface; a latte selection.

### Named Rules
**The Flavour Wheel Rule.** Colour means something or it is absent. A hue on screen is a state, a lot, a tag or a data series; chrome, decoration and interaction are roast neutrals or espresso/latte.

**The One Ladder Rule.** Every neutral token of both themes aliases a step of r0…r14. A new surface, line or code ink picks a step or becomes a token; no ad-hoc grey.

**The Out-of-Band Rule.** Lots and tags live in hue bands no state owns (olive, teal, cyan, blue, indigo, raspberry). A new lot or tag hue must never land near cherry, caramel, leaf, lilac, roasted brown or the papery grey-blue.

**The Espresso/Latte Rule.** Interaction is espresso in light and latte in dark. No hue, ever, for a button, a selection or a focus ring.

## Typography

**Display Font:** Bricolage Grotesque (falls back to the UI face)
**Body Font:** Schibsted Grotesk (with -apple-system, Segoe UI, Roboto)
**Label/Mono Font:** JetBrains Mono (bundled as "JetBrains Mono Web"), code, paths, repo and branch metadata only

**Character:** a warm, inked workhorse grotesk with real tabular figures for everything you read and act on; Bricolage's display optical sizes only for page titles, the wordmark and big figures.

### Hierarchy
The app's seven size registers are tokens (`--t-micro` 11 · `--t-meta` 12 · `--t-ui` 13 · `--t-body` 14 · `--t-title` 16 · `--t-head` 21 · `--t-display` 27) with paired line-heights (`--lh-body` 1.62, `--lh-title` 1.3, `--lh-head` 1.2, `--lh-display` 1.1).
- **Display** (Bricolage 750, 40px, 1): the decisions count in the fleet wheel centre (32px on phones).
- **Stat figure** (Bricolage, 27px, 1.1): the big numbers of Stats.
- **Headline** (Bricolage 750, 25px, 1.2, -0.025em, opsz 36): Deck column titles ("Your move", "The fleet").
- **Title** (Bricolage 700, 18px, 1.3, -0.02em): the session title in the session header; the 17px wordmark in the bar.
- **Card title** (Schibsted 700, 14–16px): decision card and modal titles.
- **Body** (Schibsted 400, 14px, 1.62): conversation and markdown.
- **UI** (Schibsted 600, 13px): tabs, buttons, cells, fields.
- **Meta** (Schibsted, 12px): ages, captions, counts beside titles.
- **Label** (Schibsted 700, 11px, tabular): counters, gauges, badges, state pills.

### Named Rules
**The Display Is For Figures Rule.** Bricolage sets titles and big numbers only; running text, labels and controls stay in Schibsted Grotesk.

**The Mono Is Data Rule.** JetBrains Mono is for code, paths, repos and branches, never for prose or headings.

**The Tabular Rule.** Every count, age and gauge uses tabular figures so columns don't jitter as numbers change.

## Layout

A full-height app shell: the 48px espresso bar on top, the working area below on the grained sage ground. The Deck is two columns (1.15fr decisions, 0.9fr fleet; 22px gap; 18px/22px padding) collapsing to one under 1080px. Sessions is a sidebar of repo groups beside a session pane with its context dock. Breakpoints observed: 1080px (Deck to one column), 900px (phone shell, touch floor), 640px (fleet wheel 132px, single-column legend).

Spacing rhythm: 4 / 6 / 8 / 12 / 16 / 22px. Card heads 12px × 16px; card feet 12px × 16px with 8px between actions; conversation bubbles 12px apart.

**The Ticket-Wallet Rule.** A row or card never reflows when its state changes; only its mark and its colour change.

**The Thumb Rule.** On phones a decision card's actions sit in one full-width band at the bottom of the card, 44px targets, nothing overflowing the viewport. Coarse pointers under 900px get a 40px floor on the back control.

## Elevation & Depth

A light hybrid: tonal layering does most of the work (porcelain on sage, r11 on r13 in dark), with soft, roast-tinted offset shadows under porcelain cards. Shadows are diffuse and directional, never hard or offset as a graphic device. The espresso bar is flat. Modals sit on a roast-tinted overlay with a 2px backdrop blur.

### Shadow Vocabulary
- **Card** (`0 1px 2px rgba(24,17,14,.06), 0 10px 26px -16px rgba(24,17,14,.32)`): decision cards, modals, the fleet card. Dark: `0 1px 2px rgba(0,0,0,.4), 0 12px 28px -14px rgba(0,0,0,.7)`.
- **Small** (`0 1px 2px rgba(24,17,14,.08)`): conversation bubbles and secondary panels; nested child cards drop shadow entirely.

### Named Rules
**The Grain Rule.** The roast grain (`--grain`, on the page and pane ground only; the espresso bar stays flat) is a material, not a pattern: it never sits under text-dense cards, bubbles or code.

## Shapes

Rounded porcelain: 16px cards, bubbles and modals; 10px fields, child cards and alerts; 8px controls and secondary buttons; full pills for primary/secondary card actions, the "+ Session" button and state pills. Conversation bubbles pinch to a 5px tail corner on their speaker's side. Lots are 14×7px tabs with 2px corners, a 2:1 silhouette that no state uses. State marks are 8px: diamond (attention), disc (waiting, working), thick ring (background), hairline ring (idle), square (ended).

**The Shape-Carries-State Rule.** A state is never told by hue alone: label + shape + hue, and the shapes above are reserved for states. Nothing else may be a diamond-dot, ring-dot or square-dot.

## Components

### Buttons
- **Shape:** full pill (999px) on card actions; 8px on compact header actions.
- **Primary:** espresso fill, r0 text, 6px × 14px, 13px/650 (latte fill, espresso text in dark).
- **Secondary:** porcelain with an r5 border; **Ghost:** transparent with an r4 border and muted text.
- **Hover / Focus:** primary deepens to r9 (latte-hover in dark); secondary takes the hover wash.
- **Archive:** neutral at rest, turns cherry-soft with cherry ink only when aimed at (hover/focus), because it stops the session.

### State pills and dots
- **State pill:** label + mark in a full pill, 11px/750 uppercase, ink of the state on a 14% tint of its hue; the question/plan/permission kinds take the diamond.
- **State dot:** 8px, shape per state; working, waiting, background and attention pulse; the wheel legend never pulses (only the decision column may).

### Cards / Containers
- **Corner Style:** 16px (10px for nested child cards, which drop the shadow).
- **Background:** porcelain (r11 in dark), with a hairline r4 border.
- **Shadow Strategy:** Card shadow (see Elevation).
- **Internal Padding:** 12px × 16px head and foot, 6px × 16px body; repo groups as 14px-radius translucent porcelain.

### Inputs / Fields
- **Style:** r1 wash, r4 border, 8px radius, 5px × 10px, 12px text. On the bar: a translucent sage field (7% r1) with 10px radius and a mono ⌘K keycap.
- **Focus:** border moves toward latte on the bar; checkboxes and radios fill espresso (latte in dark).

### Navigation
- **Top bar:** flat espresso r12 (r14 in dark), no grain, identical in both themes. Wordmark in Bricolage 16px (--t-title) beside the live wheel mark. Tabs are muted text; the active tab is sage text with a 2px latte underline. Rate gauges are 4px latte bars on a sage hairline track.
- **Sub-tabs:** text + count, active = 2px espresso underline; no pill buttons.
- **Mobile:** the same bar, condensed; sessions open full-screen with a back control on the touch floor.

### Conversation
User turns are espresso bubbles (r9 in dark) with r0 text; assistant turns are porcelain with a hairline border. A queued user message becomes caramel-soft with a dashed caramel border.

### Fleet Wheel (signature)
Inner ring = one arc per state family (9px, 55% opacity); outer ring = one 14px segment per session laid inside its family's arc, clockwise from 12 o'clock in order attention, waiting, working, background, idle, ended. Needs-you segments sit first, hovered segments grow to 19px and name the session in the centre. The centre shows the decisions count in Bricolage. The legend is a two-column filter (one column on phones). A state change sweeps the arc with the world's one authored motion: `.7s cubic-bezier(.16, 1, .3, 1)`, cut by reduced motion. The same model draws the 16px favicon (needs-you families keep at least a quarter of the ring) and the top-bar mark (latte core, espresso hook).

### Project Lot
A 14×7px tab, 2px corners, in the repo's lot hue, before the repo name everywhere the repo appears. Stats bars paint each project with its lot.

### Icons
Stroke icons in currentColor. Decorative icon tints are muted through `--icon-tint`; only icons that carry a meaning (trash, ban, stop, interrupt, warning, check, all-clear) keep a hue.

### Inbox-zero cup
The one good-news empty state: a roasted-brown cup with rising steam, the only place a coffee object is drawn.

## Scheme Architecture

The coffee world is the default and lives on bare `:root` (light), `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` and `:root[data-theme="dark"]` (identical dark values). Every other scheme is selected with `data-scheme` on `<html>`:

- `:root[data-scheme]` is the **base of every other scheme** and is the whole **indigo** scheme (the former default; `indigo` adds nothing). It restores the indigo values and neutralises the coffee-only tokens: `--font-display` → `--font`, `--shell-*` → the panel tokens, `--grain*: none`, `--icon-tint: initial`, `--bubble-user-*` → accent, `--bar-fill` → indigo gradient, `--lot-display: none` and `--lot-*` → `--bar-fill`, plus its own tags and code inks. It must stay above the scheme blocks (equal specificity).
- `legacy`, `gruvbox`, `claude` and `datadog` each override on top of that base, light then dark (`(0,3,0)` dark selectors). `claude` adds component radii; `datadog` adds a full layout layer and draws states as bars instead of shaped dots.
- `data-corners="sharp"` is a third, orthogonal axis that zeroes every radius.

A new coffee-only token must get a neutral value in `:root[data-scheme]`, or every other scheme inherits coffee.

## Do's and Don'ts

### Do:
- **Do** alias every neutral to a roast step r0…r14, in both themes.
- **Do** give every state its label, its shape and its hue; use the `-ink` form for text and the bare hue for marks.
- **Do** use espresso (light) or latte (dark) for every interaction; latte on the espresso bar in both themes.
- **Do** draw a project with `lotColor()` as a 14×7px tab, identical wherever the repo appears.
- **Do** keep both themes AA, measured on porcelain, ground and chip surfaces.
- **Do** bundle every font and texture locally.
- **Do** neutralise any new coffee-only token in `:root[data-scheme]`.

### Don't:
- **Don't** use a hue for chrome, decoration or interaction; colour is reserved for meaning.
- **Don't** pick a lot or tag hue inside a state's band (cherry, caramel, leaf, lilac, roasted brown, papery grey-blue).
- **Don't** reuse the state marks (diamond, ring, square) or the 2:1 lot tab for anything else.
- **Don't** add coffee ornament: no beans, cream, serif, latte art; the cup belongs to inbox zero only.
- **Don't** lay the grain under text-dense cards, bubbles or code.
- **Don't** set running text in Bricolage or prose in JetBrains Mono.
- **Don't** reflow a row or card when its state changes.
- **Don't** fetch fonts or assets from a CDN.
