#!/usr/bin/env npx tsx
/**
 * fig-to-components.ts
 *
 * Transforms openpencil JSX export into real React components.
 * The enhanced openpencil export embeds data-fig-id and data-component attributes
 * directly in the JSX, so we just parse those — no separate eval step needed.
 *
 * Usage:
 *   npx tsx scripts/fig-to-components.ts <file.fig> --page "Page Name" --node "0:1234" -o output.tsx
 *   npx tsx scripts/fig-to-components.ts <file.fig> --page "Page Name" --node "0:1234" --dry-run
 */

import { parse, Lang } from '@ast-grep/napi';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync } from 'fs';

// ---------------------------------------------------------------------------
// Component mapping: Figma instance name → React component
// ---------------------------------------------------------------------------

interface ComponentMapping {
  component: string;
  from: string;
  propMap?: Record<string, string>;
  stripStyles?: boolean;
  selfClosing?: boolean;
}

const COMPONENT_MAP: Record<string, ComponentMapping> = {
  Button: {
    component: 'Button',
    from: '@kamino-webapp/ui',
    propMap: { Variant: 'variant', Size: 'size' },
    stripStyles: true,
  },
  Tabs: {
    component: 'Tabs',
    from: '@kamino-webapp/ui',
    propMap: { Style: 'variant', Size: 'size' },
    stripStyles: true,
  },
  'Tabs / Trigger': {
    component: 'TabsTrigger',
    from: '@kamino-webapp/ui',
    propMap: { State: 'state' },
    stripStyles: true,
  },
  Card: {
    component: 'Card',
    from: '@kamino-webapp/ui',
    stripStyles: true,
  },
  Command: {
    component: 'Command',
    from: '@kamino-webapp/ui',
    stripStyles: true,
  },
  'Command / Input': {
    component: 'CommandInput',
    from: '@kamino-webapp/ui',
    stripStyles: true,
  },
  DropdownMenu: {
    component: 'DropdownMenu',
    from: '@kamino-webapp/ui',
    stripStyles: true,
  },
  'DropdownMenu / Menu': {
    component: 'DropdownMenuContent',
    from: '@kamino-webapp/ui',
    stripStyles: true,
  },
  'DropdownMenu / Item / Default': {
    component: 'DropdownMenuItem',
    from: '@kamino-webapp/ui',
    stripStyles: true,
  },
  'DropdownMenu / Item / Label': {
    component: 'DropdownMenuLabel',
    from: '@kamino-webapp/ui',
    stripStyles: true,
  },
  'DropdownMenu / Item / Separator': {
    component: 'DropdownMenuSeparator',
    from: '@kamino-webapp/ui',
    selfClosing: true,
    stripStyles: true,
  },
  'Breadcrumb / BreadcrumbItem': {
    component: 'BreadcrumbItem',
    from: '@kamino-webapp/ui',
    stripStyles: true,
  },
  Kbd: {
    component: 'Kbd',
    from: '@kamino-webapp/ui',
    stripStyles: true,
  },
  'Badge Number': {
    component: 'Badge',
    from: '@kamino-webapp/ui',
    propMap: { Variant: 'variant' },
    stripStyles: true,
  },
  'Crypto Icon': {
    component: 'CryptoIcon',
    from: '#shared/uiKitV2/Icons',
    propMap: { Symbol: 'symbol' },
    selfClosing: true,
    stripStyles: true,
  },
};

// ---------------------------------------------------------------------------
// Step 1: Export JSX + collect icon SVGs
// ---------------------------------------------------------------------------

// Cache the loaded graph so we don't re-parse for every export call
let _cachedGraph: any = null;
let _cachedFile: string = '';

async function loadGraphNoLayout(figFile: string) {
  if (_cachedGraph && _cachedFile === figFile) return _cachedGraph;
  const { BUILTIN_IO_FORMATS, IORegistry } = await import('@open-pencil/core');
  const io = new IORegistry(BUILTIN_IO_FORMATS);
  const bytes = new Uint8Array(readFileSync(figFile).buffer);
  const { graph } = await io.readDocument({ name: figFile, data: bytes });
  // Deliberately NOT calling computeAllLayouts() — use Figma's stored positions
  _cachedGraph = graph;
  _cachedFile = figFile;
  return graph;
}

function exportJsx(figFile: string, page: string, nodeId: string): string {
  const tmpFile = `/tmp/fig-export-${Date.now()}.jsx`;
  const cmd = `openpencil export "${figFile}" -f jsx --style tailwind --page "${page}" --node "${nodeId}" -o "${tmpFile}"`;
  console.error(`[1/2] Exporting JSX...`);
  execSync(cmd, { stdio: ['pipe', 'pipe', 'inherit'] });
  return readFileSync(tmpFile, 'utf-8');
}

async function exportJsxDirect(figFile: string, _page: string, nodeId: string): Promise<string> {
  const { sceneNodeToJSX } = await import('@open-pencil/core');
  const graph = await loadGraphNoLayout(figFile);
  console.error(`[1/2] Exporting JSX (no layout recomputation)...`);
  return sceneNodeToJSX(nodeId, graph, 'tailwind');
}

function exportIconSvg(figFile: string, page: string, nodeId: string): string | null {
  const tmpFile = `/tmp/fig-icon-${nodeId.replace(':', '-')}.svg`;
  try {
    execSync(`openpencil export "${figFile}" -f svg --page "${page}" --node "${nodeId}" -o "${tmpFile}"`, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return readFileSync(tmpFile, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Convert an SVG string to a JSX-compatible inline SVG.
 * Strips the XML declaration, converts attributes to camelCase.
 */
function svgToJsx(svg: string): string {
  return svg
    .replace(/<\?xml[^?]*\?>\n?/, '')
    .replace(/xmlns:xlink="[^"]*"/g, '')
    .replace(/xmlns="[^"]*"/g, '')
    .replace(/xlink:href/g, 'xlinkHref')
    .replace(/clip-path/g, 'clipPath')
    .replace(/clip-rule/g, 'clipRule')
    .replace(/fill-rule/g, 'fillRule')
    .replace(/fill-opacity/g, 'fillOpacity')
    .replace(/stroke-width/g, 'strokeWidth')
    .replace(/stroke-linecap/g, 'strokeLinecap')
    .replace(/stroke-linejoin/g, 'strokeLinejoin')
    .replace(/stroke-dasharray/g, 'strokeDasharray')
    .replace(/stroke-opacity/g, 'strokeOpacity')
    .replace(/font-family/g, 'fontFamily')
    .replace(/font-size/g, 'fontSize')
    .trim();
}

// ---------------------------------------------------------------------------
// Step 2: AST transform
// ---------------------------------------------------------------------------

function parseVariantString(variantStr: string): Record<string, string> {
  const props: Record<string, string> = {};
  if (!variantStr) return props;
  for (const part of variantStr.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    props[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return props;
}

function buildPropsString(mapping: ComponentMapping, figmaProps: Record<string, string>): string {
  if (!mapping.propMap) return '';
  const parts: string[] = [];
  for (const [figmaKey, reactProp] of Object.entries(mapping.propMap)) {
    const value = figmaProps[figmaKey];
    if (value && value.toLowerCase() !== 'default') {
      parts.push(`${reactProp}="${value.toLowerCase()}"`);
    }
  }
  return parts.join(' ');
}

function extractAttr(text: string, attr: string): string {
  const match = text.match(new RegExp(`${attr}="([^"]*)"`));
  return match?.[1] ?? '';
}

// ---------------------------------------------------------------------------
// Pass 5: Repeated sibling detection → .map()
// ---------------------------------------------------------------------------

/** Minimum number of consecutive same-name siblings to trigger .map() */
const MIN_REPEAT_COUNT = 2;

/** data-names to skip — generic layout containers, not meaningful components */
const SKIP_NAMES = new Set(['Frame', 'vector', 'Vector', 'Group', 'GROUP', 'Line', '']);

/**
 * Extract text content from all >...< positions in the JSX.
 * Returns a sparse array indexed by the regex match position —
 * this must count identically to the template replacement pass
 * so that varying slot indices align correctly.
 *
 * Non-empty text slots get their trimmed value; empty/whitespace-only slots
 * get empty string. ALL matches are counted so indices stay in sync.
 */
function extractTextSlots(text: string): string[] {
  const slots: string[] = [];
  const re = />([^<{]+)</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    slots.push(m[1].trim());
  }
  return slots;
}

function camelCase(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
}

interface ElemRef {
  lineStart: number;
  lineEnd: number;
  indent: number;
  dataName: string;
}

/**
 * Find the end line of a JSX element starting at `startLine`.
 * Uses open/close tag counting — handles nested same-tag elements correctly.
 */
function findElementEnd(lines: string[], startLine: number): number {
  if (lines[startLine].includes('/>')) return startLine;

  let depth = 0;
  for (let j = startLine; j < lines.length; j++) {
    const line = lines[j];
    // Count ALL opens (not self-closing) and closes on this line
    const opens = (line.match(/<(div|p|span|svg|[A-Z]\w+)[\s>]/g) || []).length;
    const selfCloses = (line.match(/\/>/g) || []).length;
    const closes = (line.match(/<\/(div|p|span|svg|[A-Z]\w+)>/g) || []).length;
    depth += opens - selfCloses - closes;
    if (depth === 0) return j;
  }
  return startLine;
}

/**
 * Find runs of consecutive sibling elements with the same data-name
 * and replace them with a .map() call over a data array.
 *
 * Works on the string level (indentation-based) because ast-grep doesn't
 * expose sibling iteration.
 *
 * Algorithm:
 * 1. Parse all elements with their start/end line boundaries
 * 2. Group consecutive siblings (same indent, same parent scope, same data-name)
 * 3. Extract text slots from each sibling
 * 4. Build a template from the first element, parameterizing varying text
 * 5. Replace the entire run with {DATA.map((item, i) => <template />)}
 */
function detectRepeatedSiblings(source: string): string {
  const lines = source.split('\n');

  // Step 1: Parse all elements with boundaries
  const allElements: ElemRef[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)<(div|p|[A-Z]\w+)[\s>]/);
    if (!m) continue;

    const indent = m[1].length;
    const dataName = extractAttr(lines[i], 'data-name');
    const endLine = findElementEnd(lines, i);

    allElements.push({ lineStart: i, lineEnd: endLine, indent, dataName });
  }

  // Step 2: Find consecutive sibling runs with same data-name
  // Two elements are siblings if they are at the same indent and the second
  // starts after the first ends, with no element at a shallower indent between them.
  const replacements: { startLine: number; endLine: number; replacement: string }[] = [];
  const processed = new Set<number>(); // track which elements are already in a run

  for (let i = 0; i < allElements.length; i++) {
    if (processed.has(i)) continue;
    const elem = allElements[i];
    if (SKIP_NAMES.has(elem.dataName)) continue;

    const run = [elem];
    processed.add(i);

    // Look for the next sibling: must start after elem.lineEnd, at the same indent
    for (let j = i + 1; j < allElements.length; j++) {
      const next = allElements[j];
      if (next.lineStart <= run[run.length - 1].lineEnd) continue; // inside current element (child)
      if (next.indent < elem.indent) break; // left the parent scope
      if (next.indent > elem.indent) continue; // deeper child of something else
      // Same indent — is it the same data-name?
      if (next.dataName === elem.dataName) {
        run.push(next);
        processed.add(j);
      } else {
        break; // different sibling, stop the run
      }
    }

    if (run.length < MIN_REPEAT_COUNT) continue;

    // Step 3: Extract text slots from each sibling
    const allSlots = run.map((r) => extractTextSlots(lines.slice(r.lineStart, r.lineEnd + 1).join('\n')));

    // Use the maximum slot count (some siblings may have optional content)
    const maxSlots = Math.max(...allSlots.map((s) => s.length));
    if (maxSlots === 0) continue; // nothing textual to parameterize

    // Pad shorter slot arrays with empty strings
    for (const slots of allSlots) {
      while (slots.length < maxSlots) slots.push('');
    }

    // Figure out which slots vary across siblings (only consider non-empty text positions)
    const varyingIndices: number[] = [];
    for (let si = 0; si < maxSlots; si++) {
      const values = allSlots.map((s) => s[si]);
      const hasNonEmpty = values.some((v) => v !== '');
      if (hasNonEmpty && new Set(values).size > 1) {
        varyingIndices.push(si);
      }
    }

    if (varyingIndices.length === 0) continue;

    // Step 4: Build data array and template
    // Try to give slots meaningful names based on data-name of their parent <p>
    const firstText = lines.slice(run[0].lineStart, run[0].lineEnd + 1).join('\n');
    const slotNames = inferSlotNames(firstText, maxSlots);

    const dataEntries = allSlots.map((slots) => {
      const obj: Record<string, string> = {};
      for (const si of varyingIndices) {
        const name = slotNames[si] || `slot${si}`;
        obj[name] = slots[si];
      }
      return obj;
    });

    // Build template from first element, replacing varying text with {item.name}
    let template = lines.slice(run[0].lineStart, run[0].lineEnd + 1).join('\n');
    let currentSlot = 0;
    template = template.replace(/>([^<{]+)</g, (fullMatch, textContent) => {
      const trimmed = textContent.trim();
      if (!trimmed) {
        currentSlot++;
        return fullMatch;
      }
      const si = currentSlot;
      currentSlot++;
      if (varyingIndices.includes(si)) {
        const name = slotNames[si] || `slot${si}`;
        // Preserve whitespace around the text
        const leadingWs = textContent.match(/^\s*/)?.[0] ?? '';
        const trailingWs = textContent.match(/\s*$/)?.[0] ?? '';
        return `>${leadingWs}{item.${name}}${trailingWs}<`;
      }
      return fullMatch;
    });

    // Strip data-fig-id from template (unique per instance, meaningless in .map)
    template = template.replace(/ data-fig-id="[^"]*"/g, '');

    const baseIndent = ' '.repeat(elem.indent);
    const dataArrayStr = JSON.stringify(dataEntries, null, 2)
      .split('\n')
      .map((l, li) => (li === 0 ? l : `${baseIndent}${l}`))
      .join('\n');

    const mapBlock = [
      `{/* TODO: replace with real data */}`,
      `{${dataArrayStr}.map((item, i) => (`,
      template,
      `))}`,
    ]
      .map((l) => `${baseIndent}${l}`)
      .join('\n');

    replacements.push({
      startLine: run[0].lineStart,
      endLine: run[run.length - 1].lineEnd,
      replacement: mapBlock,
    });

    console.error(`  Detected ${run.length}x repeated "${elem.dataName}" → .map() with ${varyingIndices.length} varying slot(s)`);
  }

  if (replacements.length === 0) return source;

  // Apply in reverse line order to preserve line numbers
  replacements.sort((a, b) => b.startLine - a.startLine);
  for (const { startLine, endLine, replacement } of replacements) {
    lines.splice(startLine, endLine - startLine + 1, replacement);
  }

  return lines.join('\n');
}

/**
 * Try to infer meaningful names for text slots based on the data-name
 * of the <p> elements that contain them.
 */
function inferSlotNames(elementText: string, slotCount: number): string[] {
  const names: string[] = [];
  const lines = elementText.split('\n');
  let slotIdx = 0;

  for (const line of lines) {
    const textMatches = line.match(/>([^<{]+)</g);
    if (!textMatches) continue;

    for (const tm of textMatches) {
      const text = tm.slice(1, -1).trim();
      if (!text) { slotIdx++; continue; }

      const dn = extractAttr(line, 'data-name');
      // Use data-name only if it's a meaningful identifier (not numeric, not generic)
      if (dn && !dn.startsWith('Frame') && dn !== 'Text container' && !/^[\d,.$%+ -]+$/.test(dn)) {
        const name = camelCase(dn);
        // Ensure uniqueness
        if (!names.includes(name)) {
          names[slotIdx] = name;
        } else {
          names[slotIdx] = `${name}${slotIdx}`;
        }
      } else {
        names[slotIdx] = `text${slotIdx}`;
      }
      slotIdx++;
    }
  }

  for (let i = 0; i < slotCount; i++) {
    if (!names[i]) names[i] = `text${i}`;
  }

  return names;
}

function transformJsx(
  jsxSource: string,
  figFile: string,
  page: string,
): { code: string; imports: Map<string, Set<string>>; extractedComponents: { name: string; jsx: string; props?: string }[] } {
  const imports = new Map<string, Set<string>>();

  function addImport(from: string, component: string) {
    if (!imports.has(from)) imports.set(from, new Set());
    imports.get(from)!.add(component);
  }

  const wrapped = `function __FigExport() { return (\n${jsxSource}\n); }`;
  let currentSource = wrapped;

  // --- Pass 1: Replace icon instances (ic / *) with inline SVGs ---
  // ast-grep can't match on attribute value substrings, so we match all divs
  // and filter by checking data-name in the source text
  {
    const ast = parse(Lang.Tsx, currentSource);
    const root = ast.root();

    const allDivs = root.findAll('<div $$$ATTRS>$$$CHILDREN</div>');
    const iconEdits = [];

    for (const match of allDivs) {
      const text = match.text();
      const name = extractAttr(text, 'data-name');
      if (!name.startsWith('ic / ')) continue;

      const figId = extractAttr(text, 'data-fig-id');
      if (!figId) continue;

      const svg = exportIconSvg(figFile, page, figId);
      if (!svg) continue;

      // Tag the SVG with the icon name so we can extract it later
      const iconName = name.replace('ic / ', '').trim();
      const jsxSvg = svgToJsx(svg).replace('<svg', `<svg data-icon-name="${iconName}"`);
      iconEdits.push(match.replace(jsxSvg));
    }

    if (iconEdits.length > 0) {
      currentSource = root.commitEdits(iconEdits);
      console.error(`  Replaced ${iconEdits.length}x icon nodes with inline SVG`);
    }
  }

  // --- Pass 2: Replace known components from COMPONENT_MAP ---
  for (const [dataName, mapping] of Object.entries(COMPONENT_MAP)) {
    const ast = parse(Lang.Tsx, currentSource);
    const root = ast.root();

    const pattern = `<div data-name="${dataName}" $$$ATTRS>$$$CHILDREN</div>`;
    const matches = root.findAll(pattern);
    if (matches.length === 0) continue;

    const edits = [];

    for (const match of matches) {
      const children = match.getMultipleMatches('CHILDREN');
      const childrenText = children.map((c) => c.text()).join('');

      const componentStr = extractAttr(match.text(), 'data-component');
      const figmaProps = parseVariantString(componentStr);
      const propsStr = buildPropsString(mapping, figmaProps);
      const propsWithSpace = propsStr ? ` ${propsStr}` : '';

      let replacement: string;
      if (mapping.selfClosing) {
        replacement = `<${mapping.component}${propsWithSpace} />`;
      } else if (childrenText.trim()) {
        replacement = `<${mapping.component}${propsWithSpace}>${childrenText}</${mapping.component}>`;
      } else {
        replacement = `<${mapping.component}${propsWithSpace} />`;
      }

      edits.push(match.replace(replacement));
      addImport(mapping.from, mapping.component);
    }

    if (edits.length > 0) {
      currentSource = root.commitEdits(edits);
      console.error(`  Replaced ${edits.length}x <div data-name="${dataName}"> → <${mapping.component}>`);
    }
  }

  // --- Pass 2.5: Extract remaining Figma component instances as React components ---
  const extractedComponents: { name: string; jsx: string; props?: string }[] = [];
  {
    // Keep extracting until no more data-component divs remain.
    // Process deepest-nested first so inner components are extracted before their parents.
    let changed = true;
    const handledNames = new Set(Object.keys(COMPONENT_MAP));
    // Also skip icons (already inlined) and text-only nodes
    const skipPrefixes = ['ic / ', 'Icon / '];

    while (changed) {
      changed = false;
      const ast = parse(Lang.Tsx, currentSource);
      const root = ast.root();

      // Find all divs that still have data-component
      const allInstances = root.findAll('<div $$$ATTRS>$$$CHILDREN</div>');
      // Group by data-name, tracking nesting depth
      const groups = new Map<string, { matches: typeof allInstances; maxDepth: number }>();

      for (const match of allInstances) {
        const text = match.text();
        if (!text.includes('data-component=')) continue;
        const dataName = extractAttr(text, 'data-name');
        if (!dataName || handledNames.has(dataName)) continue;
        if (skipPrefixes.some((p) => dataName.startsWith(p))) continue;

        // Nesting depth: count how many data-component ancestors this element has
        // Approximation: count occurrences of data-component=" in the full source
        // before this match. Instead, just use the indent level from the source.
        const matchStart = text.slice(0, 50);
        const lineInSource = currentSource.indexOf(matchStart);
        const indent = lineInSource >= 0
          ? (currentSource.slice(Math.max(0, currentSource.lastIndexOf('\n', lineInSource)), lineInSource).length - 1)
          : 0;

        if (!groups.has(dataName)) {
          groups.set(dataName, { matches: [], maxDepth: indent });
        }
        const group = groups.get(dataName)!;
        group.matches.push(match);
        group.maxDepth = Math.max(group.maxDepth, indent);
      }

      if (groups.size === 0) break;

      // Sort by depth descending — extract deepest (leaf) components first
      const sorted = [...groups.entries()].sort((a, b) => b[1].maxDepth - a[1].maxDepth);

      // Process the deepest group
      const [dataName, { matches }] = sorted[0];
      // Strip redundant prefix: "Sidebar / SidebarMenuButton" → "SidebarMenuButton"
      const parts = dataName.split(/\s*\/\s*/);
      const dedupedName = parts.length > 1 && pascalCase(parts.at(-1)!).startsWith(pascalCase(parts[0]))
        ? parts.at(-1)!
        : dataName;
      const compName = pascalCase(dedupedName);

      // Collect unique variant props across all instances
      const allVariantKeys = new Set<string>();
      for (const match of matches) {
        const componentStr = extractAttr(match.text(), 'data-component');
        const props = parseVariantString(componentStr);
        for (const key of Object.keys(props)) allVariantKeys.add(key);
      }

      // Use the first instance as the component template
      const firstMatch = matches[0];
      const children = firstMatch.getMultipleMatches('CHILDREN');
      const childrenText = children.map((c) => c.text()).join('');
      const outerText = firstMatch.text();
      const outerClass = extractAttr(outerText, 'className');

      // --- Text slot diffing across all instances ---
      // Same algorithm as .map() detection but for component instances
      const allSlots = matches.map((m) => extractTextSlots(m.text()));
      const slotCounts = allSlots.map((s) => s.length);
      const structurallyUniform = slotCounts.every((c) => c === slotCounts[0]);

      let varyingIndices: number[] = [];
      let slotNames: string[] = [];
      let useChildrenPassthrough = false;

      if (structurallyUniform && slotCounts[0] > 0 && matches.length > 1) {
        const maxSlots = slotCounts[0];
        slotNames = inferSlotNames(outerText, maxSlots);

        for (let si = 0; si < maxSlots; si++) {
          const values = allSlots.map((s) => s[si]);
          const hasNonEmpty = values.some((v) => v !== '');
          if (hasNonEmpty && new Set(values).size > 1) {
            varyingIndices.push(si);
          }
        }
      } else if (!structurallyUniform && matches.length > 1) {
        // DOM structure differs — can't do text-slot diffing, use {children}
        useChildrenPassthrough = true;
      }

      // Build the extracted component template with parameterized text slots
      let innerJsx = outerClass
        ? `<div className="${outerClass}">${childrenText}</div>`
        : `<div>${childrenText}</div>`;

      if (varyingIndices.length > 0) {
        // Replace varying text slots with {propName} in template
        let currentSlot = 0;
        innerJsx = innerJsx.replace(/>([^<{]+)</g, (fullMatch, textContent) => {
          const trimmed = (textContent as string).trim();
          if (!trimmed) { currentSlot++; return fullMatch; }
          const si = currentSlot;
          currentSlot++;
          if (varyingIndices.includes(si)) {
            const name = slotNames[si] || `text${si}`;
            const leadingWs = (textContent as string).match(/^\s*/)?.[0] ?? '';
            const trailingWs = (textContent as string).match(/\s*$/)?.[0] ?? '';
            return `>${leadingWs}{${name}}${trailingWs}<`;
          }
          return fullMatch;
        });
      }

      if (useChildrenPassthrough) {
        // Wrap template body to accept children — use first instance as default
        innerJsx = innerJsx.replace(childrenText, '{children}');
      }

      // Build prop type annotation
      const propNames: string[] = [];
      for (const key of allVariantKeys) propNames.push(camelCase(key));
      for (const si of varyingIndices) propNames.push(slotNames[si] || `text${si}`);
      if (useChildrenPassthrough) propNames.push('children');

      const propsParam = propNames.length > 0
        ? `{ ${propNames.join(', ')} }: { ${propNames.map((n) => `${n}?: ${n === 'children' ? 'React.ReactNode' : 'string'}`).join('; ')} }`
        : '';

      extractedComponents.push({ name: compName, jsx: innerJsx, props: propsParam });

      // Replace all instances with <CompName ...props>...children...</CompName>
      const edits = [];
      for (const match of matches) {
        const componentStr = extractAttr(match.text(), 'data-component');
        const figmaProps = parseVariantString(componentStr);

        const propParts: string[] = [];
        // Variant props from data-component
        for (const key of allVariantKeys) {
          const val = figmaProps[key];
          if (val && val.toLowerCase() !== 'default') {
            propParts.push(`${camelCase(key)}="${val.toLowerCase()}"`);
          }
        }

        // Text slot props — extract this instance's varying text
        if (varyingIndices.length > 0) {
          const thisSlots = extractTextSlots(match.text());
          for (const si of varyingIndices) {
            const name = slotNames[si] || `text${si}`;
            const val = thisSlots[si] ?? '';
            if (val) propParts.push(`${name}="${val}"`);
          }
        }

        const propsStr = propParts.length > 0 ? ` ${propParts.join(' ')}` : '';

        let replacement: string;
        if (useChildrenPassthrough) {
          // Always pass children for structurally divergent components
          const thisChildren = match.getMultipleMatches('CHILDREN');
          const thisChildrenText = thisChildren.map((c) => c.text()).join('');
          replacement = `<${compName}${propsStr}>${thisChildrenText}</${compName}>`;
        } else {
          // Self-closing — all variation captured in props
          replacement = `<${compName}${propsStr} />`;
        }

        edits.push(match.replace(replacement));
      }

      if (edits.length > 0) {
        currentSource = root.commitEdits(edits);
        handledNames.add(dataName);
        changed = true;
        console.error(`  Extracted ${edits.length}x "${dataName}" → <${compName}>`);
      }
    }
  }

  // --- Pass 3: Unwrap "Text container" divs — hoist children up ---
  {
    const ast = parse(Lang.Tsx, currentSource);
    const root = ast.root();
    const textContainers = root.findAll('<div data-name="Text container" $$$ATTRS>$$$CHILDREN</div>');

    if (textContainers.length > 0) {
      const edits = textContainers.map((match) => {
        const children = match.getMultipleMatches('CHILDREN');
        return match.replace(children.map((c) => c.text()).join(''));
      });
      currentSource = root.commitEdits(edits);
      console.error(`  Unwrapped ${textContainers.length}x "Text container" wrappers`);
    }
  }

  // --- Pass 4: Unwrap nested text <p> inside components where it's the only child ---
  // e.g. <Button><p className="...">Submit</p></Button> → <Button>Submit</Button>
  {
    const ast = parse(Lang.Tsx, currentSource);
    const root = ast.root();

    // Find components that contain a single <p> child with just text
    for (const mapping of Object.values(COMPONENT_MAP)) {
      if (mapping.selfClosing) continue;
      const C = mapping.component;

      // Match <Component ...><p ...>TEXT</p></Component> where <p> is the only child
      const pattern = `<${C} $$$PROPS><p $$$PATTRS>$TEXT</p></${C}>`;
      const matches = root.findAll(pattern);

      if (matches.length > 0) {
        const edits = [];
        for (const match of matches) {
          const text = match.getMatch('TEXT')?.text() ?? '';
          const propsNodes = match.getMultipleMatches('PROPS');
          const propsText = propsNodes.map((p) => p.text()).join(' ');
          const propsWithSpace = propsText.trim() ? ` ${propsText.trim()}` : '';
          edits.push(match.replace(`<${C}${propsWithSpace}>${text}</${C}>`));
        }
        if (edits.length > 0) {
          currentSource = root.commitEdits(edits);
          // re-parse for next component
          const ast2 = parse(Lang.Tsx, currentSource);
          // just update ref for next iteration
        }
      }
    }
  }

  // --- Pass 5: Detect repeated siblings → .map() ---
  currentSource = detectRepeatedSiblings(currentSource);

  // --- Cleanup: strip metadata attributes, unwrap function ---
  let final = currentSource
    .replace(/^function __FigExport\(\) \{ return \(\n/, '')
    .replace(/\n\); \}$/, '')
    .replace(/ data-name="[^"]*"/g, '')
    .replace(/ data-fig-id="[^"]*"/g, '')
    .replace(/ data-component="[^"]*"/g, '');

  return { code: final, imports, extractedComponents };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function generateImports(imports: Map<string, Set<string>>): string {
  const lines: string[] = [];
  for (const [from, components] of imports) {
    lines.push(`import { ${[...components].sort().join(', ')} } from '${from}';`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// SVG extraction: inline SVGs → named components
// ---------------------------------------------------------------------------

interface SvgComponent {
  name: string;
  svg: string;
}

function pascalCase(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/**
 * Extract all inline <svg> blocks into separate components.
 * Deduplicates identical SVGs (same icon used multiple times).
 * Returns the modified JSX and an array of extracted SVG components.
 */
function extractSvgComponents(code: string): { code: string; svgComponents: SvgComponent[] } {
  // Match <svg ...>...</svg> blocks — they don't nest, so a greedy match works
  const svgRegex = /<svg\s[^>]*>[\s\S]*?<\/svg>/g;
  const seen = new Map<string, string>(); // normalized SVG → component name
  const components: SvgComponent[] = [];
  const nameCounts = new Map<string, number>(); // handle duplicate icon names

  const result = code.replace(svgRegex, (fullMatch) => {
    // Extract the icon name tag we added in Pass 1
    const nameMatch = fullMatch.match(/data-icon-name="([^"]*)"/);
    const rawName = nameMatch?.[1] ?? 'unknown';

    // Strip the data-icon-name attr from the SVG (it's not a real SVG attribute)
    const cleanSvg = fullMatch.replace(/\s*data-icon-name="[^"]*"/, '');

    // Normalize for dedup: strip whitespace differences
    const normalized = cleanSvg.replace(/\s+/g, ' ').trim();

    if (seen.has(normalized)) {
      return `<${seen.get(normalized)!} />`;
    }

    // Generate a unique PascalCase component name
    let baseName = `Icon${pascalCase(rawName)}`;
    const count = nameCounts.get(baseName) ?? 0;
    nameCounts.set(baseName, count + 1);
    const compName = count > 0 ? `${baseName}${count + 1}` : baseName;

    seen.set(normalized, compName);
    components.push({ name: compName, svg: cleanSvg });

    return `<${compName} />`;
  });

  console.error(`  Extracted ${components.length} unique SVG components (${seen.size} deduped from ${code.match(svgRegex)?.length ?? 0} total)`);

  return { code: result, svgComponents: components };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.error(`
Usage: npx tsx scripts/fig-to-components.ts <file.fig> --page <page> --node <nodeId> [-o output.tsx] [--dry-run]

Options:
  --page      Figma page name (e.g., "✅ Lend")
  --node      Node ID to export (e.g., "0:9607")
  -o          Output file path (default: stdout)
  --dry-run   Print the result without writing to file
`);
    process.exit(0);
  }

  const figFile = args[0];
  let page = '';
  let nodeId = '';
  let output = '';
  let dryRun = false;

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--page': page = args[++i]; break;
      case '--node': nodeId = args[++i]; break;
      case '-o': output = args[++i]; break;
      case '--dry-run': dryRun = true; break;
    }
  }

  if (!page || !nodeId) {
    console.error('Error: --page and --node are required');
    process.exit(1);
  }

  const rawJsx = await exportJsxDirect(figFile, page, nodeId);
  console.error(`  Exported ${rawJsx.length} bytes of JSX`);

  console.error('[2/2] Transforming JSX with ast-grep...');
  const { code, imports, extractedComponents } = transformJsx(rawJsx, figFile, page);

  const { code: codeWithoutSvgs, svgComponents } = extractSvgComponents(code);

  // Also clean metadata from extracted component JSX and extract their SVGs
  const cleanedExtracted = extractedComponents.map((c) => {
    let jsx = c.jsx
      .replace(/ data-name="[^"]*"/g, '')
      .replace(/ data-fig-id="[^"]*"/g, '')
      .replace(/ data-component="[^"]*"/g, '');
    const { code: cleanJsx, svgComponents: innerSvgs } = extractSvgComponents(jsx);
    svgComponents.push(...innerSvgs);
    return { name: c.name, jsx: cleanJsx, props: c.props };
  });

  const importBlock = generateImports(imports);
  const svgBlock = svgComponents
    .map((c) => `function ${c.name}() {\n  return (\n${c.svg}\n  );\n}`)
    .join('\n\n');
  const extractedBlock = cleanedExtracted
    .map((c) => {
      const params = c.props ? `(${c.props})` : '()';
      return `function ${c.name}${params} {\n  return (\n${c.jsx}\n  );\n}`;
    })
    .join('\n\n');
  const componentName = nodeId.replace(':', '_');

  const sections = [
    importBlock,
    svgBlock,
    extractedBlock,
    `export function FigmaNode_${componentName}() {\n  return (\n${codeWithoutSvgs}\n  );\n}`,
  ].filter(Boolean);
  const final = sections.join('\n\n') + '\n';

  if (dryRun || !output) {
    process.stdout.write(final);
  } else {
    writeFileSync(output, final, 'utf-8');
    console.error(`\nWritten to ${output}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
