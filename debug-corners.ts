import { BUILTIN_IO_FORMATS, IORegistry } from '@open-pencil/core'

const io = new IORegistry(BUILTIN_IO_FORMATS)
const file = process.argv[2]
const ids = process.argv.slice(3)

const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
const { graph } = await io.readDocument({ name: file, data: bytes })

for (const id of ids) {
  const node = graph.getNode(id)
  if (!node) {
    console.log(`${id}: NOT FOUND`)
    continue
  }
  console.log(`\n=== ${id} ${node.type} "${node.name}" ${node.width}×${node.height} ===`)
  console.log('  cornerRadius:', node.cornerRadius)
  console.log('  topLeftRadius:', node.topLeftRadius)
  console.log('  topRightRadius:', node.topRightRadius)
  console.log('  bottomLeftRadius:', node.bottomLeftRadius)
  console.log('  bottomRightRadius:', node.bottomRightRadius)
  console.log('  independentCorners:', node.independentCorners)
  console.log('  fills:', node.fills?.map((f: any) => `${f.type}${f.visible ? '' : '(hidden)'}`).join(','))
  console.log('  strokes:', node.strokes?.map((s: any) => `${s.type} ${s.align ?? ''}`).join(','))
}
