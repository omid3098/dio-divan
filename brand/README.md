# Dio Divan mark: the seal

Approved by Omid on 2026-10-12 (concept O of six rounds); Divan uses it everywhere (browser tab, sidebar, app icon).
Every file here, `web/public/favicon.svg` and `web/src/components/divan-mark-paths.ts` come from one geometry in
`scripts/brand.mjs`: run `node scripts/brand.mjs` (the PNGs and the `.ico` need Chrome or Edge, as the e2e runs).

**Idea.** Five members, each one half of a yin and yang, turn around the chairman. Their outer edges lie on one
circle, so the mark reads as a round seal; each inner edge swings in an S into a round head. One sentence: *five
voices, one round answer.*

## Files

| File | Use |
|---|---|
| `divan-mark.svg` | The mark, light-mode glow stops. 32 px and up. |
| `divan-mark-dark.svg` | The same on dark surfaces (the dark glow stops). |
| `divan-mark-small.svg` | The small cut for 16 to 24 px: shorter tails, wider gaps, bigger heads and chair. |
| `divan-mark-black.svg`, `divan-mark-white.svg`, `divan-mark-mono.svg`, `divan-mark-small-black.svg` | One colour: black, white (reversed), brand violet `#6366F1`. |
| `app-icon.svg`, `app-icon-512.png`, `app-icon-1024.png` | The mark on Dio's dark tile. |
| `divan-mark-1024.png` | The mark, transparent. |
| `favicon.ico` | 16, 24, 32 and 48 px, from the small cut. |
| `../web/public/favicon.svg` | The browser tab: the small cut, with a colour-scheme switch inside. |
| `../web/src/components/divan-mark.tsx` | The mark in the app (sidebar), in the theme's glow colours. |

## Geometry

`viewBox 0 0 256 256`, centre (128, 128). Pure fills, no strokes, no masks; each comma is one closed outline whose
joins are tangent (rim arc r 108 → head r 28 → smoothstep S curve → tail cap r 7). Heads sit at −72°, 0°, 72°, 144°,
216°; each tail runs 44° behind its head. The chair is a disc of r 32. Small cut: rim 110, head 30, tail 9, tail 36°,
chair 35.

## Colour

The glow gradient of Dio Docs (`glow-start`, `glow-mid`, `glow-end`), `userSpaceOnUse` from (164, 20) to (92, 236):
light `#06B6D4 → #6366F1 → #C026D3`, dark `#67E8F9 → #8B9CFF → #D8A6FF`. One colour where a gradient cannot go.

## Use

- **Clear space:** one head (28 units, 11% of the mark's width) on every side.
- **Minimum size:** 16 px, with the small cut below 32 px.
- **Name:** no wordmark or lockup (Dio Docs MRK-13); where a name goes with the mark, set it as ordinary text.
- **Never:** rotate or mirror it (the turn is clockwise), drop or move a comma, outline it, add shadows or glows, or use
  colours outside the glow stops and the one-colour set.

## Open

- No trademark or look-alike search has been done (tomoe crests, Japanese comma emblems, are the nearest shapes).
