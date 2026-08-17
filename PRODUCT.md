# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One person: the owner. They capture ideas by texting a WhatsApp bot throughout the
day (often on the phone, on the move) and open this viewer — on desktop and phone —
to see what their thinking looks like. No other users; the link is token-gated and
private. (Confirmed 2026-08.)

## Product Purpose

Thoughts is a personal "second brain": ideas captured over WhatsApp are stored,
autonomously connected by semantic similarity, clustered into hot spots, and rendered
as a zoomable WebGL graph. The viewer's job — confirmed by the owner — is twofold and
equal: (1) glanceable hot spots ("where is my thinking concentrating right now?") and
(2) deep exploration ("follow edges, find surprising bridges between ideas").
Success = opening the page and immediately seeing a living map of your own mind.

## Positioning

Unlike note apps, nothing is filed manually: connection, clustering, naming, and heat
are fully autonomous (embeddings + Louvain + Claude labeling). The graph is the
product — there is no folder view to fall back to.

## Operating Context

- Capture happens in WhatsApp (via the sibling reminder-bot); the viewer is read-mostly.
  The one write action in the viewer is deleting a stray idea.
- Ideas arrive continuously in the background; the viewer should reflect that
  (live-updating graph) rather than requiring reloads.
- Viewed ambiently — sometimes left open on a screen — and checked in bursts.
  Dark environment assumption: it's a night-sky-of-ideas artifact, not a daytime form.

## Capabilities and Constraints

- Renderer: Sigma.js v2 (WebGL) + graphology + ForceAtlas2, vendored locally
  (`public/vendor/`), **no build step, no CDN, no external fonts** — everything must be
  served from `public/`. Content-Security-wise nothing may leave the server.
- WebGL constraint: node visuals only via Sigma reducers (no per-node CSS/DOM);
  translucency effects use the synthetic "halo node" technique.
- Data: `GET /api/graph` (nodes/edges/mentions/clusters), `GET /api/status`;
  token gate via `?token=`. Graph recompute is cron/debounced server-side.
- Untrusted content: idea text is user-captured; all DOM building goes through
  `textContent` (never innerHTML). This is a hard constraint.
- Tests: pure visual-mapping functions live in `public/viz.js` and are unit-tested in
  `test/viz.test.js` (classic script contract on `globalThis.ThoughtsViz`).

## Brand Commitments

Owner-confirmed (2026-08): keep and refine the incumbent dark "ambient second brain"
identity — near-black blue ground, cluster-colored glowing nodes, glassy floating
chrome — rather than replacing the visual world. Canvas is the hero; chrome recedes.
The status color system (ok/warn/down + glyphs, CVD-validated) is load-bearing.

## Product Principles

1. **The graph is the interface.** Chrome earns its pixels or gets out of the way.
2. **Alive by default.** New ideas appear on their own; motion communicates arrival
   and heat, never decoration. Respect `prefers-reduced-motion`.
3. **Glance first, depth second.** Hot spots readable in one second; edges, entities,
   and relations revealed on interaction.
4. **Trustworthy at a glance.** Health/status visible but quiet; color never carries
   meaning alone.
5. **Fast and self-contained.** No build step, no external requests, instant load.

## Accessibility & Inclusion

Single known user, but keep: contrast ≥ 3:1 for chrome text on glass panels,
status conveyed by glyph + color, full keyboard operability of chrome controls,
`prefers-reduced-motion` honored for all non-essential motion.
