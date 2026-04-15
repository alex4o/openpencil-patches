#!/usr/bin/env bun
/**
 * debug-layout.ts — Figma vs Yoga layout diff tool
 *
 * Loads a .fig file, snapshots Figma's original positions, recomputes with
 * Yoga, and reports every node where they disagree.
 *
 * Usage:
 *   bun run debug-layout.ts <file.fig>
 *   bun run debug-layout.ts <file.fig> --node "1:234"
 *   bun run debug-layout.ts <file.fig> --threshold 0.5
 *   bun run debug-layout.ts <file.fig> --json
 */

import {
  BUILTIN_IO_FORMATS,
  IORegistry,
  computeAllLayouts,
  setTextMeasurer,
} from '@open-pencil/core'
import {
  collectFontKeys,
  loadFont,
} from './node_modules/@open-pencil/core/src/fonts'
import type { SceneGraph, SceneNode } from '@open-pencil/core/scene-graph'
import { detectLayoutIssues } from './open-pencil/packages/core/src/tools/describe-layout-issues'
import { createCanvas, GlobalFonts } from '@napi-rs/canvas'

// ── CLI args ──

const args = process.argv.slice(2)
const filePath = args.find((a) => !a.startsWith('--'))
if (!filePath) {
  console.error('Usage: bun run debug-layout.ts <file.fig> [--node ID] [--threshold N] [--json]')
  process.exit(1)
}

const nodeFilter = args.includes('--node') ? args[args.indexOf('--node') + 1] : null
const threshold = args.includes('--threshold')
  ? parseFloat(args[args.indexOf('--threshold') + 1])
  : 1
const jsonOutput = args.includes('--json')
const useCanvas = args.includes('--canvas')

// ── Types ──

interface Pos {
  x: number
  y: number
  w: number
  h: number
}

interface Mismatch {
  id: string
  name: string
  type: string
  figma: Pos
  yoga: Pos
  delta: { x: number; y: number; w: number; h: number }
  maxDelta: number
  parentContext: ParentContext | null
  childContext: ChildContext
  issues: Array<{ message: string; suggestion: string }>
}

interface ParentContext {
  id: string
  name: string
  type: string
  layoutMode: string
  primaryAxisSizing: string
  counterAxisSizing: string
  primaryAxisAlign: string
  counterAxisAlign: string
  paddingTop: number
  paddingRight: number
  paddingBottom: number
  paddingLeft: number
  itemSpacing: number
  counterAxisSpacing: number
  layoutWrap: string
  clipsContent: boolean
  width: number
  height: number
}

interface ChildContext {
  layoutGrow: number
  layoutAlignSelf: string
  layoutPositioning: string
  layoutMode: string
  primaryAxisSizing: string
  counterAxisSizing: string
  visible: boolean
}

// ── Canvas text measurer ──

function createCanvasTextMeasurer() {
  const canvas = createCanvas(1, 1)
  const ctx = canvas.getContext('2d')

  return (node: SceneNode, maxWidth?: number): { width: number; height: number } | null => {
    const fontSize = node.fontSize || 14
    const fontWeight = node.fontWeight || 400
    const fontFamily = node.fontFamily || 'sans-serif'
    const text = node.text || ''
    if (!text) return { width: 0, height: 0 }

    const lineH =
      (node.lineHeight ?? 0) > 0 ? (node.lineHeight as number) : Math.ceil(fontSize * 1.2)

    ctx.font = `${fontWeight} ${fontSize}px "${fontFamily}", sans-serif`
    const measured = ctx.measureText(text)

    if (!maxWidth || maxWidth <= 0 || measured.width <= maxWidth) {
      return { width: Math.ceil(measured.width), height: lineH }
    }

    // Word-wrap: estimate line count from measured width vs constraint
    const lines = Math.ceil(measured.width / maxWidth)
    return { width: Math.ceil(maxWidth), height: Math.ceil(lines * lineH) }
  }
}

async function loadFontsForGraph(graph: SceneGraph) {
  // Collect all font keys used in the document
  const pages = graph.getPages()
  const pageIds = pages.map((p) => p.id)
  const fontKeys = collectFontKeys(graph, pageIds)

  console.error(`Loading ${fontKeys.length} fonts...`)
  let loaded = 0
  let fromSystem = 0

  for (const [family, style] of fontKeys) {
    // Check if system already has it
    const hasSystem = GlobalFonts.families.some(
      (f: { family: string }) => f.family === family
    )
    if (hasSystem) {
      fromSystem++
      continue
    }

    // Try loading via Google Fonts (uses the patched registerAndCache)
    const buffer = await loadFont(family, style)
    if (buffer) {
      GlobalFonts.register(Buffer.from(buffer), family)
      loaded++
    }
  }

  console.error(
    `Fonts: ${fromSystem} system, ${loaded} downloaded, ${fontKeys.length - fromSystem - loaded} missing`
  )
}

// ── Main ──

async function main() {
  const io = new IORegistry(BUILTIN_IO_FORMATS)
  const bytes = new Uint8Array(await Bun.file(filePath!).arrayBuffer())
  const { graph } = await io.readDocument({ name: filePath!, data: bytes })

  // Font loading + optional canvas text measurer.
  // --canvas: use @napi-rs/canvas measureText() as the active measurer.
  //           This bypasses stored .fig dimensions and measures dynamically.
  //           Less accurate for .fig imports (canvas != Figma's Skia), but
  //           useful for dynamically created text.
  // Default:  rely on stored .fig dims from the layout.ts patch — more accurate
  //           for import comparisons since they're Figma's own computed values.
  await loadFontsForGraph(graph)
  if (useCanvas) {
    setTextMeasurer(createCanvasTextMeasurer())
    console.error('Using canvas text measurer (--canvas)')
  } else {
    console.error('Using stored .fig dimensions (default, use --canvas to override)')
  }

  // Step 1: Snapshot Figma's original positions
  const figmaPositions = new Map<string, Pos>()
  let totalNodes = 0
  let autoLayoutFrames = 0

  for (const node of graph.getAllNodes()) {
    totalNodes++
    figmaPositions.set(node.id, {
      x: node.x,
      y: node.y,
      w: node.width,
      h: node.height,
    })
    if (node.layoutMode !== 'NONE') autoLayoutFrames++
  }

  // Step 2: Recompute with Yoga
  computeAllLayouts(graph)

  // Step 3: Diff
  const mismatches: Mismatch[] = []

  for (const node of graph.getAllNodes()) {
    // If filtering to a subtree, skip nodes outside it
    if (nodeFilter && !isInSubtree(graph, node.id, nodeFilter)) continue

    const orig = figmaPositions.get(node.id)
    if (!orig) continue

    // Only diff nodes that are inside an auto-layout parent
    const parent = node.parentId ? graph.getNode(node.parentId) : null
    if (!parent || parent.layoutMode === 'NONE') continue
    // Skip absolute-positioned nodes (Yoga doesn't recompute them meaningfully)
    if (node.layoutPositioning === 'ABSOLUTE') continue

    const dx = Math.abs(node.x - orig.x)
    const dy = Math.abs(node.y - orig.y)
    const dw = Math.abs(node.width - orig.w)
    const dh = Math.abs(node.height - orig.h)
    const maxDelta = Math.max(dx, dy, dw, dh)

    if (maxDelta < threshold) continue

    // Gather context
    const issues: Array<{ message: string; suggestion: string }> = []
    detectLayoutIssues(parent, graph, issues)

    mismatches.push({
      id: node.id,
      name: node.name,
      type: node.type,
      figma: orig,
      yoga: { x: node.x, y: node.y, w: node.width, h: node.height },
      delta: {
        x: round(node.x - orig.x),
        y: round(node.y - orig.y),
        w: round(node.width - orig.w),
        h: round(node.height - orig.h),
      },
      maxDelta: round(maxDelta),
      parentContext: parent
        ? {
            id: parent.id,
            name: parent.name,
            type: parent.type,
            layoutMode: parent.layoutMode,
            primaryAxisSizing: parent.primaryAxisSizing,
            counterAxisSizing: parent.counterAxisSizing,
            primaryAxisAlign: parent.primaryAxisAlign,
            counterAxisAlign: parent.counterAxisAlign,
            paddingTop: parent.paddingTop,
            paddingRight: parent.paddingRight,
            paddingBottom: parent.paddingBottom,
            paddingLeft: parent.paddingLeft,
            itemSpacing: parent.itemSpacing,
            counterAxisSpacing: parent.counterAxisSpacing,
            layoutWrap: parent.layoutWrap,
            clipsContent: parent.clipsContent,
            width: parent.width,
            height: parent.height,
          }
        : null,
      childContext: {
        layoutGrow: node.layoutGrow,
        layoutAlignSelf: node.layoutAlignSelf,
        layoutPositioning: node.layoutPositioning,
        layoutMode: node.layoutMode,
        primaryAxisSizing: node.primaryAxisSizing,
        counterAxisSizing: node.counterAxisSizing,
        visible: node.visible,
      },
      issues,
    })
  }

  // Sort by severity (biggest delta first)
  mismatches.sort((a, b) => b.maxDelta - a.maxDelta)

  // ── Output ──

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          file: filePath,
          totalNodes,
          autoLayoutFrames,
          threshold,
          nodeFilter,
          mismatches,
        },
        null,
        2
      )
    )
    return
  }

  // Text output
  const critical = mismatches.filter((m) => m.maxDelta > 20)
  const moderate = mismatches.filter((m) => m.maxDelta > 5 && m.maxDelta <= 20)
  const minor = mismatches.filter((m) => m.maxDelta <= 5)

  console.log('')
  console.log(`Layout Debug Report: ${filePath}`)
  console.log('='.repeat(60))
  console.log(
    `Total nodes: ${totalNodes} | Auto-layout frames: ${autoLayoutFrames}`
  )
  console.log(
    `Mismatches: ${mismatches.length} nodes differ from Figma (threshold: ${threshold}px)`
  )
  if (nodeFilter) console.log(`Filtered to subtree: ${nodeFilter}`)
  console.log('')

  if (mismatches.length === 0) {
    console.log('All layouts match Figma. Nothing to report.')
    return
  }

  if (critical.length > 0) {
    console.log(`CRITICAL (>${20}px off): ${critical.length} nodes`)
    console.log('-'.repeat(60))
    for (const m of critical) printMismatch(m)
    console.log('')
  }

  if (moderate.length > 0) {
    console.log(`MODERATE (5-20px off): ${moderate.length} nodes`)
    console.log('-'.repeat(60))
    for (const m of moderate) printMismatch(m)
    console.log('')
  }

  if (minor.length > 0) {
    console.log(`MINOR (1-5px off): ${minor.length} nodes`)
    console.log('-'.repeat(60))
    for (const m of minor.slice(0, 20)) printMismatch(m)
    if (minor.length > 20)
      console.log(`  ... and ${minor.length - 20} more minor mismatches`)
    console.log('')
  }
}

function printMismatch(m: Mismatch) {
  const p = m.parentContext
  console.log(`  "${m.name}" [${m.id}] ${m.type}`)
  if (p) {
    const pad = `pad=${p.paddingTop}/${p.paddingRight}/${p.paddingBottom}/${p.paddingLeft}`
    console.log(
      `    Parent: "${p.name}" [${p.id}] ${p.layoutMode} gap=${p.itemSpacing} ${pad}`
    )
    console.log(
      `    Parent sizing: primary=${p.primaryAxisSizing} counter=${p.counterAxisSizing}`
    )
    console.log(
      `    Parent align: justify=${p.primaryAxisAlign} items=${p.counterAxisAlign}`
    )
  }
  console.log(
    `    Figma:  x=${round(m.figma.x)}  y=${round(m.figma.y)}  w=${round(m.figma.w)}  h=${round(m.figma.h)}`
  )
  console.log(
    `    Yoga:   x=${round(m.yoga.x)}  y=${round(m.yoga.y)}  w=${round(m.yoga.w)}  h=${round(m.yoga.h)}`
  )

  const deltas: string[] = []
  if (m.delta.x !== 0) deltas.push(`Δx=${m.delta.x}`)
  if (m.delta.y !== 0) deltas.push(`Δy=${m.delta.y}`)
  if (m.delta.w !== 0) deltas.push(`Δw=${m.delta.w}`)
  if (m.delta.h !== 0) deltas.push(`Δh=${m.delta.h}`)
  console.log(`    Delta: ${deltas.join('  ')}`)

  const c = m.childContext
  console.log(
    `    Child: grow=${c.layoutGrow} alignSelf=${c.layoutAlignSelf} pos=${c.layoutPositioning}`
  )
  if (c.layoutMode !== 'NONE') {
    console.log(
      `    Child layout: ${c.layoutMode} primary=${c.primaryAxisSizing} counter=${c.counterAxisSizing}`
    )
  }

  if (m.issues.length > 0) {
    for (const issue of m.issues) {
      console.log(`    Issue: ${issue.message}`)
    }
  }
  console.log('')
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

function isInSubtree(graph: SceneGraph, nodeId: string, rootId: string): boolean {
  if (nodeId === rootId) return true
  const node = graph.getNode(nodeId)
  if (!node || !node.parentId) return false
  return isInSubtree(graph, node.parentId, rootId)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
