// Hook into WebAssembly.instantiate to intercept the WASM module
const origInstantiate = WebAssembly.instantiate
WebAssembly.instantiate = async function(source: any, imports: any) {
  let bytes: Uint8Array
  if (source instanceof WebAssembly.Module) {
    console.log('Got compiled module, cannot inspect bytes')
    return origInstantiate.call(this, source, imports)
  }
  
  if (source instanceof ArrayBuffer) bytes = new Uint8Array(source)
  else bytes = new Uint8Array(source.buffer || source)
  
  console.log('WASM size:', bytes.length, 'bytes')
  console.log('Magic:', Buffer.from(bytes.slice(0,4)).toString('hex'))
  
  // Parse sections to find memory (section 5)
  let offset = 8
  while (offset < bytes.length) {
    const sectionId = bytes[offset++]
    let size = 0, shift = 0
    while (true) {
      const byte = bytes[offset++]
      size |= (byte & 0x7f) << shift
      if ((byte & 0x80) === 0) break
      shift += 7
    }
    if (sectionId === 5) {
      const sectionData = bytes.slice(offset, offset + size)
      let p = 0
      const count = sectionData[p++]
      for (let i = 0; i < count; i++) {
        const flags = sectionData[p++]
        let initial = 0; shift = 0
        while (true) { const b = sectionData[p++]; initial |= (b & 0x7f) << shift; if ((b & 0x80) === 0) break; shift += 7 }
        let maximum = -1
        if (flags & 1) {
          maximum = 0; shift = 0
          while (true) { const b = sectionData[p++]; maximum |= (b & 0x7f) << shift; if ((b & 0x80) === 0) break; shift += 7 }
        }
        console.log(`Memory: initial=${initial} pages (${initial*64}KB = ${(initial*64/1024).toFixed(1)}MB), max=${maximum >= 0 ? maximum + ' pages (' + (maximum*64/1024).toFixed(1) + 'MB)' : 'NONE (no growth)'}`)
        console.log(`Flags: ${flags} (bit0=${flags&1} = has_max)`)
      }
    }
    offset += size
  }
  
  return origInstantiate.call(this, source, imports)
} as any

// Now load yoga
const Yoga = await import('yoga-layout')
console.log('Yoga loaded')
