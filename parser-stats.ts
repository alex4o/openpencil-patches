#!/usr/bin/env bun
// Dump parser stats from open-pencil's IORegistry.
// Usage: bun parser-stats.ts <canvas.fig>  →  JSON on stdout
import { BUILTIN_IO_FORMATS, IORegistry } from '@open-pencil/core'

const figPath = process.argv[2]
if (!figPath) {
  console.error('Usage: parser-stats.ts <canvas.fig>')
  process.exit(1)
}

const bytes = new Uint8Array(await Bun.file(figPath).arrayBuffer())

const t0 = performance.now()
const io = new IORegistry(BUILTIN_IO_FORMATS)
const { graph } = await io.readDocument({ name: figPath, data: bytes })
const parseMs = performance.now() - t0

const typeHist: Record<string, number> = {}
const byName: Record<string, any[]> = {}
let totalText = 0
let nodeCount = 0

// SceneGraph exposes nodes via iteration; check for forEachNode / nodes
// Fall back to traversal from roots
const visit = (node: any) => {
  nodeCount++
  typeHist[node.type] = (typeHist[node.type] ?? 0) + 1
  if (node.name) {
    ;(byName[node.name] ??= []).push({
      id: node.id,
      type: node.type,
      w: node.width ?? null,
      h: node.height ?? null,
      x: node.x ?? null,
      y: node.y ?? null,
    })
  }
  if (node.type === 'TEXT' && typeof node.characters === 'string') {
    totalText += node.characters.length
  }
  const kids = node.children ?? []
  for (const c of kids) visit(c)
}

// Find root — SceneGraph has a root node
const root: any = (graph as any).root ?? (graph as any).getNode?.('0:0')
if (root) visit(root)

// Also dig through pages if structure differs
if ((graph as any).pages) {
  for (const page of (graph as any).pages) visit(page)
}

console.log(JSON.stringify({
  tool: 'openpencil',
  file: figPath,
  parseMs: Math.round(parseMs),
  totalNodes: nodeCount,
  typeHistogram: typeHist,
  byName,
  totalTextChars: totalText,
  figKiwiVersion: (graph as any).figKiwiVersion ?? null,
}))
