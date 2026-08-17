# Design — Thoughts viewer

Recorded from the built surface (public/), 2026-08. The world is the incumbent
dark ambient "second brain", owner-confirmed as the identity to refine, never
replace. The graph is the interface; chrome floats as glass and recedes.

## Ground & glass

| Token | Value | Role |
|---|---|---|
| `--bg` | `#0b0e14` | page ground (night-sky) |
| `--panel` | `rgba(15,19,27,0.82)` + `--glass` blur(14px) sat(1.25) | floating chrome |
| `--inset` | `rgba(9,12,18,0.75)` | fields/wells inside panels |
| `--border` / `--border-lit` | `#222a38` / `#2a3346` | edges (1px, always) |
| `--shadow` | `0 2px 10px rgba(3,5,9,0.5)` | grounding only — the border defines the edge, the shadow never gets diffuse |

## Ink & accent

`--ink #e8ebf2` → `--ink-2 #cdd4e0` → `--ink-3 #8a93a6` → `--ink-4 #7d879a`.
Every step holds ≥4.5:1 on the glass panels (ink-4 measured 5.2:1). Accent
`#4c8bf5` (brand mark, focus, active states) with `--accent-soft` 18% fill.

Status colors `--ok #34d399 / --warn #fbbf24 / --down #f87171 / --unknown` are
CVD-validated and **never carry meaning alone** — always paired with a glyph
(✓ ! ✕ ?) or a text label.

## Type

System stack (`system-ui, -apple-system, "Segoe UI", sans-serif`) — deliberate:
Operate surface, zero external requests allowed, self-contained page. Three
sizes only: `--fs-0 11px` (meta/labels — the floor, nothing smaller),
`--fs-1 14px` (body/controls, the base), `--fs-2 18px` (overlay titles).
Hierarchy below 18px comes from weight (600–650) and the ink ramp, not size.
Numbers in legend rows use `font-variant-numeric: tabular-nums`.

## Space, radius, motion

Spacing scale 4/8/12/16/24 (`--s-1..5`). Radii: 8 (controls), 12 (cards),
16 (drawer/sheets), 999 (pills). One easing, `--ease cubic-bezier(0.22,1,0.36,1)`.

Motion is *arrival and state*, never decoration:
- new ideas tween in ~900ms (`entranceScale` easeOutBack 0.2→1, slight
  overshoot; born bright via `heatColor`, cools to cluster color);
- drawer slides 8px, details rises 6px, live-dot rings once on arrivals;
- ok-status dot pulses (the one ambient signal);
- **rejected**: idle camera drift, continuous halo breathing (battery + vestibular);
- `prefers-reduced-motion`: everything snaps; only the loading spinner keeps
  spinning (progress must read as alive).

## Graph encoding (viz.js — pure, unit-tested)

- Cluster color: golden-angle hue hash, HSL 70/58. Null cluster `#5d6675`.
- Node size: `3 + degree·0.4 + heat·18` (cap 28); entities are pale `#c9d2e3` diamonds.
- Heat: color blends toward white (≤18%); heat ≥0.5 earns a halo (synthetic
  node at 2.1×, pre-blended 78% toward bg — WebGL can't do translucency).
- Edges keep hue identity: similarity blue, typed relation green, mention amber;
  weight → width + alpha; ≥0.8 steps to a brighter tier. Dimmed nodes `#252c3c`.

## Layout

Full-bleed canvas; `stagePadding: 84` keeps the composition clear of the 68px
topbar so the graph reads centered. Chrome is three floating pieces: centered
topbar pill (brand · stats · search · live · status · drawer toggle), right
drawer (collapsed by default, state remembered), details card bottom-left.
≤640px: topbar spans the width, drawer and details become bottom sheets (≤55vh),
details stacks above the drawer (a focused node wins).

## Hard rules

- All DOM from untrusted content via `textContent` (`el()` helper) — never innerHTML.
- Icons are authored inline SVG (1.6–1.8 stroke, round caps); no emoji-as-icon,
  no icon font. Illustrations (empty/error states) are cloneable `<template>` SVGs.
- No build step, no CDN, no external fonts — everything ships from `public/`.
- Browser surfaces themed: selection, caret, thin scrollbars, `:focus-visible`
  accent rings.
- `npx impeccable detect public/` stays clean; justified waivers only, inline.
