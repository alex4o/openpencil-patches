# openpencil-patches

Patches and tools for [OpenPencil](https://github.com/open-pencil/open-pencil) that fix layout corruption when importing `.fig` files.

## The Problem

OpenPencil's Yoga layout engine recomputes all node positions on import, overwriting Figma's stored ground-truth values. The text measurement fallback (`fontSize * 0.6 * charCount`) is wildly inaccurate, causing thousands of layout mismatches. On `material3.fig`, **26,247 nodes** had wrong positions out of the box.

## What This Fixes

The patches reduce that to **zero** layout-breaking recomputations by:

1. **Killing `computeAllLayouts()`** in the CLI's `loadDocument()` — imported `.fig` positions are preserved as-is
2. **Using stored `.fig` dimensions** for text nodes instead of the broken `estimateTextSize()` fallback (55.6% mismatch reduction when Yoga does run)
3. **Fixing headless font caching** — `registerAndCache()` was silently dropping fonts when CanvasKit wasn't available
4. **Better JSX export** — Figma component instances export as PascalCase React components with variant props

Upstream issue: [open-pencil/open-pencil#212](https://github.com/open-pencil/open-pencil/issues/212)

## Setup

```bash
git clone https://github.com/alex4o/openpencil-patches.git
cd openpencil-patches
bun install  # patches apply automatically
```

## Usage

### Convert `.fig` to React components

```bash
bun run fig-to-components.ts design.fig --page "Page Name" --node "0:1234" -o output.tsx
bun run fig-to-components.ts design.fig --page "Page Name" --node "0:1234" --dry-run
```

Loads the `.fig` file **without** Yoga recomputation, exports Tailwind JSX, then runs AST transforms to:
- Replace Figma instances with real React components (configurable via `COMPONENT_MAP`)
- Extract SVG icons into separate components
- Detect repeated siblings and convert to `.map()` calls

### Debug layout mismatches

```bash
bun run debug-layout.ts design.fig                     # full scan
bun run debug-layout.ts design.fig --node "1:234"      # subtree only
bun run debug-layout.ts design.fig --threshold 0.5     # tighter threshold (default: 1px)
bun run debug-layout.ts design.fig --json              # machine-readable output
bun run debug-layout.ts design.fig --canvas            # use @napi-rs/canvas measurer
```

Snapshots Figma's stored positions, runs Yoga, and diffs every node. Reports mismatches grouped by severity (CRITICAL >20px, MODERATE 5-20px, MINOR 1-5px).

## Patches

Applied automatically by `bun install` via `patchedDependencies` in `package.json`.

| Patch | Package | What it does |
|-------|---------|-------------|
| `headless.ts` | `@open-pencil/cli` | Comments out `computeAllLayouts()` in `loadDocument()` |
| `layout.ts` | `@open-pencil/core` | Uses stored `.fig` dimensions instead of `estimateTextSize()` |
| `fonts.ts` | `@open-pencil/core` | Removes CanvasKit gate from font caching |
| `jsx/export.ts` | `@open-pencil/core` | Component instances → PascalCase tags with variant props |
| `package.json` | `@open-pencil/core` | Exposes internal modules for direct imports |

## Dependencies

- `@open-pencil/cli@^0.11.2`
- `@napi-rs/canvas@^0.1.97` — optional, for canvas text measurement experiments
- `@ast-grep/napi` — AST transforms in `fig-to-components.ts` (peer dep)
