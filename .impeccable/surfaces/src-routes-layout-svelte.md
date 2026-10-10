---
version: 1
slug: "src-routes-layout-svelte"
primary_target: "src/routes/+layout.svelte"
related_targets: ["src/lib/components/Deck.svelte","src/app.css"]
---

# hooked — app shell (whole dashboard)

## Scope

Mode: **Operate**. The whole dashboard: shell (top bar), Deck (home), Sessions (sidebar + session
pane + dock), Stats, Settings, modals. Redesign that replaces the indigo default; the old look
survives as the selectable `indigo` scheme, every other scheme (legacy, datadog, gruvbox, claude)
keeps working on top of it.

Audience and task come from PRODUCT.md (three scenes: peripheral glance, phone, long reading).
User answers for this round: coffee becomes the **new default**; coffee lives in **materials and a
few signature moments**, UI wording unchanged; **everything may move** (layout, density, type).

## Direction contract

THESIS: hooked reads its sessions like a cup on the coffee taster's flavour wheel: each live state
is one flavour family, one hue with one meaning, on a roasted, cool-modern shell. It refuses the
category default (grey canvas, one indigo accent, status pills) and the coffee cliché (cream,
serif, latte art, beans as ornament).

OWN-WORLD: two neutral families from the bean's own transformation: raw green-coffee sage for
space (ground `#e9ebe1`, porcelain-white cards), roasted espresso for ink and chrome (text
`#1b1310`, an espresso top bar in both themes; dark theme = espresso grounds, raw-sage ink).
Colour is reserved for meaning: fruity cherry = attention, caramel = waiting, vegetal green =
working, floral lilac = background, roasted brown = ended, papery grey-blue = idle. Interaction
colour is espresso in light, latte in dark, never a hue. Texture: a fine roast grain (local SVG
noise) on the sage ground only, the espresso bar stays flat, never under text-dense cards. Type: Schibsted Grotesk (UI),
Bricolage Grotesque (titles, big figures), JetBrains Mono (code only). Rounded porcelain cards,
soft offset shadows, state dots that also differ by shape (diamond, disc, ring, square).
Raises, each visible in the build:
- Saville raise — project colour code: every repo gets one fixed lot hue drawn as a 2:1 tab (a
  shape no state uses) from hue bands no state owns (olive, teal, cyan, blue, indigo, raspberry),
  identical on its sidebar group header, its Deck repo header, its decision cards, the session
  header and its Stats bar. Tags take the same out-of-band bands.
- Ticket-wallet raise — state stamps the object in place: a row or card never reflows when its
  state changes; only its mark and colour change.
- Feed raise — thumb discipline: on phones a decision card's actions sit in one full-width,
  reachable band at the bottom of the card, 44px targets, nothing overflowing the viewport.
- Monochrome-canon raise — one roast-tinted neutral scale (r0…r14) that every neutral token of
  both themes aliases; no ad-hoc greys (code-surface inks are tokens too).

STORY: at a glance (second screen, tab in the background) the visitor sees whether red or caramel
is on the wheel, in the favicon, the top-bar mark and the Deck; on the Deck they clear decisions
inline; in a session they read a calm porcelain conversation with espresso user turns.

FIRST VIEWPORT: Deck at 1440×900. Espresso top bar (logo = live fleet wheel mark + "hooked"
wordmark, tabs, search, rate gauges, actions, latte "+ Session"). Left column 1.15fr: "Your move"
(Bricolage 24px) + count, decision cards (state pill with label + shape, title, lot swatch +
repo, branch, age; inline Question/Plan; espresso primary action). Right column: the fleet wheel
card first (≈170px ring: inner ring = state families, outer ring = one segment per session,
needs-you segments pulled out, centre = decisions count; cherry appears only when something blocks Claude), its legend doubling
as state filters,
then repo groups. Signature move: the fleet wheel, live in three places (Deck, top-bar mark,
favicon); hovering a segment names the session in the centre, a state change sweeps the segment
to its new family (one exponential ease-out, reduced-motion safe).

FORM: grounded candidate 3 of 7 (coffee taster's flavour wheel), seed key b70e964e, assigned by
the roll, code-led.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
