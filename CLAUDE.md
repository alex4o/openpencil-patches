# OpenPencil Layout & Export Toolkit

## What This Is

Scripts and patches for working with OpenPencil (.fig → React components pipeline).
The core problem: OpenPencil's Yoga layout engine disagrees with Figma's stored positions,
corrupting layouts on export. We work around this.

## Architecture

```
.fig file (Figma ground truth positions)
    │
    ├─ io.readDocument()     ← parses .fig, preserves Figma positions
    │
    ├─ computeAllLayouts()   ← Yoga recomputes positions (DESTRUCTIVE — overwrites Figma values)
    │
    └─ sceneNodeToJSX()      ← reads node properties, generates Tailwind JSX
```

**Key insight**: `sceneNodeToJSX()` doesn't need `computeAllLayouts()`. The JSX exporter
reads node properties directly. So we call `io.readDocument()` + `sceneNodeToJSX()` and
skip the Yoga step entirely, preserving Figma's pixel-perfect positions.

## Scripts

### `fig-to-components.ts`
Converts .fig files to React components with Tailwind CSS.

```bash
bun run fig-to-components.ts design.fig --page "Page Name" --node "0:1234" -o output.tsx
bun run fig-to-components.ts design.fig --page "Page Name" --node "0:1234" --dry-run
```

**How it works**:
1. Loads .fig via `IORegistry.readDocument()` — NO layout recomputation
2. Calls `sceneNodeToJSX()` for Tailwind JSX output
3. AST transforms (ast-grep) to replace Figma instances with real React components
4. Extracts SVG icons into separate components
5. Detects repeated siblings → `.map()` calls
6. Outputs clean React component file

The `COMPONENT_MAP` at the top defines Figma instance name → React component mappings.
Edit this for your design system.

### `debug-layout.ts`
Compares Figma's stored positions against Yoga's recomputed positions.

```bash
bun run debug-layout.ts design.fig                    # full scan
bun run debug-layout.ts design.fig --node "1:234"     # subtree only
bun run debug-layout.ts design.fig --threshold 0.5    # tighter threshold (default: 1px)
bun run debug-layout.ts design.fig --json              # machine-readable output
bun run debug-layout.ts design.fig --canvas            # use @napi-rs/canvas text measurer
```

Reports mismatches grouped by severity: CRITICAL (>20px), MODERATE (5-20px), MINOR (1-5px).

## Patches — current status at 0.11.8

Two of the original fixes are now upstream; four are still locally patched.
Applied automatically by `bun install`.

### Upstreamed (no longer in patches/)

**`layout.ts` stored-dimensions fix** — submitted as issue #212, merged in
`open-pencil/open-pencil@226542cfc` (`fix(layout): use stored .fig dimensions for
headless text measurement`). Follow-up `e23b3f0ce` (`feat(layout): use opentype.js
for accurate headless text measurement`) goes further: when no CanvasKit, upstream
now uses opentype.js for real glyph metrics, falling back to our `hasStoredSize`
branch. This alone reduced layout mismatches by 55.6% (26,247 → 11,669) on
material3.fig at 0.11.2; opentype.js measurement should improve it further.

**`core/package.json` 14 missing subpath exports** — added independently in
`open-pencil/open-pencil@d73caafc8` (`Add 14 missing subpath exports to
@open-pencil/core`). Same set: color-management, constants, copy, fig-compress,
io/formats/{pen,svg}, kiwi/{codec,convert,fig-import,fig-parse-core,serialize},
render/tailwind, scene-graph-instances, types.

### Still patched locally (`patches/@open-pencil%2Fcore@0.11.8.patch`)

**`text/fonts.ts` — Headless font caching.** File was moved from `src/fonts.ts` to
`src/text/fonts.ts` by upstream restructure (`07674d191 Restructure
@open-pencil/core into domain modules`). `registerAndCache()` is still gated on
`registerFontInCanvasKit()` returning true, so in headless mode (no CanvasKit)
fonts are never cached — every font load becomes a no-op. Patched to always cache
regardless of CanvasKit availability.

**`canvas/renderer.ts` — Kill computeAllLayouts in prepareForExport.** File was
moved from `src/renderer/renderer.ts` to `src/canvas/renderer.ts`. Function
signature changed: now returns `Promise<() => void>` (a cleanup that restores the
previous text measurer). Our patch keeps the new return contract but comments out
the `computeAllLayouts(graph, pageId)` call before the return. Without this, the
PNG/SVG export path stomps Figma's stored positions right before drawing
(symptom: text truncation, shifted elements).

**`io/formats/jsx/export.ts` — Instance handling.** Same path as before. Figma
component instances get exported as PascalCase component tags with variant props
parsed from the instance name, instead of generic `<div>`. Imports
`getMainComponent` directly from `'../../../scene-graph/instances'` (the file was
restructured into `scene-graph/`, but the symbol is unchanged).

### Still patched locally (`patches/@open-pencil%2Fcli@0.11.8.patch`)

**`cli/src/headless.ts` — Kill computeAllLayouts in loadDocument.** Comments out
`computeAllLayouts(graph)` so every CLI command (`export`, `convert`, `find`,
`tree`, etc.) uses Figma's stored positions instead of Yoga's recomputed garbage.
Only safe if you're working with .fig imports — programmatically created nodes
will end up at their default positions.

### Re-patching workflow

If a future upstream version invalidates a patch, regenerate with bun:

```bash
bun patch @open-pencil/core@<version>
# edit files under node_modules/@open-pencil/core/...
bun patch --commit 'node_modules/@open-pencil/core'
```

Bun rewrites `patchedDependencies` in `package.json` and drops the new patch into
`patches/`.

## PNG Export: Use SVG → resvg, not Skia directly

**Don't trust `openpencil export --format png`.** The Skia renderer has a stroke-rendering
bug: for some INSTANCE nodes with `independentCorners=true` and stroke `align=INSIDE`, the
rounded corners get drawn as squares even though the node's corner data is correct. Same
node exports cleanly as SVG — the SVG path generator reads the radii fine, it's the Skia
paint step that screws up.

**Workaround**: export SVG, then rasterize with resvg-wasm.

```bash
# 1. Export SVG from .fig (no Skia in the loop)
openpencil export design.fig --format svg --node "0:45205" -o button.svg

# 2. Rasterize SVG → PNG (uses openfig-cli's resvg-wasm + Inter v3 fonts)
node /Users/alex4o/Projects/openfig-cli/rasterize-svg.mjs button.svg button.png 2   # scale=2
```

`rasterize-svg.mjs` lives in the sibling `openfig-cli/` project. It preprocesses the SVG
to convert open-pencil's `color(display-p3 R G B / A)` CSS Color L4 syntax into `rgb()`/
`rgba()` — resvg doesn't parse display-p3 and silently paints everything black otherwise.

## Known Issues & Learnings

### Text measurement is the #1 source of layout bugs
Without CanvasKit/Skia, there's no way to measure text accurately. The stored .fig
dimensions are the best we have for imported files. For dynamically created text (not
from .fig), you'd need a real text engine.

### Canvas (@napi-rs/canvas) doesn't help
We tried using `@napi-rs/canvas` (also Skia-based) for text measurement.
It made things **worse** — 18,703 mismatches vs 11,669 with stored dims.
Canvas `measureText()` doesn't match Figma's Skia text shaping. Kept as `--canvas`
flag in debug-layout.ts for experimentation only.

### computeAllLayouts() is destructive
It overwrites ALL node positions. There's no way to selectively recompute.
If you call `loadDocument()` (from headless.ts), it calls `computeAllLayouts()` internally.
Use `io.readDocument()` directly to avoid this.

### The 100×100 guard
SceneNode defaults to 100×100. The patch uses `!(width === 100 && height === 100)` to
detect nodes that never got real dimensions. This could theoretically false-positive on
a node that genuinely is 100×100, but in practice that's rare enough to not matter.

### Yoga version
yoga-layout 3.3.0-grid.3+ has `free()`/`freeRecursive()` built in. The old memory leak
patch (yoga-layout@2.x) is no longer needed.

### Skia renderer stroke bug (unfixed)
`renderer/strokes.ts` `drawStrokeWithAlign()` with `align=INSIDE` draws a square stroke
for some INSTANCE nodes that clearly have `topLeftRadius` etc. set. SVG export for the
same node is correct. Not worth chasing upstream — rasterize the SVG instead (see
"PNG Export" above).

## Upstream Issue

Layout mismatch analysis and patches posted to:
https://github.com/open-pencil/open-pencil/issues/212

## Dependencies

- `@open-pencil/cli@^0.11.2` — CLI and core library
- `@napi-rs/canvas@^0.1.97` — optional, for canvas text measurement experiments
- `@ast-grep/napi` — AST transforms in fig-to-components.ts (peer dep)
