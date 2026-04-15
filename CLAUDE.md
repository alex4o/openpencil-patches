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

## Patches (`patches/@open-pencil%2Fcore@0.11.2.patch`)

Applied automatically by `bun install`. Contains four fixes:

### 1. package.json exports
Exposes internal modules (kiwi, scene-graph-instances, etc.) so our scripts can import them.

### 2. layout.ts — Stored dimensions fix
**The big one.** Without CanvasKit, OpenPencil falls back to `estimateTextSize()` which uses
`fontSize * 0.6 * text.length` — absolute garbage for anything but monospace ASCII.
Our patch makes it use the stored .fig dimensions (Figma's own computed values) instead,
only falling back to the estimate for newly-created nodes that still have the 100×100 default.

This alone reduced layout mismatches by 55.6% (26,247 → 11,669 on material3.fig).

### 3. fonts.ts — Headless font caching
`registerAndCache()` was gated on `registerFontInCanvasKit()` returning true. In headless
mode (no CanvasKit), this meant fonts were never cached — every font load was a no-op.
Patched to always cache regardless of CanvasKit availability.

## Patches (`patches/@open-pencil%2Fcli@0.11.2.patch`)

### headless.ts — Kill computeAllLayouts
Comments out the `computeAllLayouts(graph)` call in `loadDocument()`. This is the
nuclear option — every CLI command (`export`, `convert`, `find`, `tree`, etc.) now
uses Figma's stored positions instead of Yoga's recomputed garbage. If you're only
working with .fig imports (not creating nodes programmatically), this is what you want.

---

### 4. jsx/export.ts — Instance handling
Figma component instances now export as PascalCase component tags with variant props
parsed from the instance name, instead of generic `<div>` tags.

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

## Upstream Issue

Layout mismatch analysis and patches posted to:
https://github.com/open-pencil/open-pencil/issues/212

## Dependencies

- `@open-pencil/cli@^0.11.2` — CLI and core library
- `@napi-rs/canvas@^0.1.97` — optional, for canvas text measurement experiments
- `@ast-grep/napi` — AST transforms in fig-to-components.ts (peer dep)
