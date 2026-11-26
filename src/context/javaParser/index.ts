import { Parser, Language, Node } from 'web-tree-sitter';
import * as path from 'path';
import * as fs from 'fs';
import { ConstructMetrics, DECLARATION_TYPES } from './types';
import { nodeAnnotations } from './helpers';
import {
  extractClassMetrics,
  extractEnumMetrics,
  extractInterfaceMetrics,
} from './extractors';

export type { ConstructMetrics } from './types';

let _parserPromise: Promise<Parser> | null = null;

/** Initializes the Java parser from the extension's bundled wasm files; must be called once from `activate()` before any analysis runs. */
export function setExtensionPath(extensionPath: string): void {
  if (_parserPromise) {
    return;
  }
  const wasmDir = path.join(extensionPath, 'dist');
  _parserPromise = initParser(wasmDir);
}

/** Loads and configures the tree-sitter parser with the Java grammar, wiring the wasm instantiation callback manually to support the bundled environment. */
async function initParser(wasmDir: string): Promise<Parser> {
  const treeSitterBytes = fs.readFileSync(
    path.join(wasmDir, 'web-tree-sitter.wasm'),
  );
  const javaBytes = fs.readFileSync(
    path.join(wasmDir, 'tree-sitter-java.wasm'),
  );

  await Parser.init({
    instantiateWasm(
      imports: WebAssembly.Imports,
      receive: (
        instance: WebAssembly.Instance,
        module: WebAssembly.Module,
      ) => void,
    ) {
      WebAssembly.instantiate(treeSitterBytes, imports).then((result) =>
        receive(result.instance, result.module),
      );
      return {};
    },
  });

  const Java = await Language.load(new Uint8Array(javaBytes));
  const parser = new Parser();
  parser.setLanguage(Java);
  return parser;
}

/** Returns the initialized parser promise, throwing if `setExtensionPath` was never called. */
function getParser(): Promise<Parser> {
  if (!_parserPromise) {
    throw new Error(
      'Java parser not initialized — call setExtensionPath first',
    );
  }
  return _parserPromise;
}

const CONSTRUCT_TYPE_MAP: Record<string, ConstructMetrics['constructType']> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  method_declaration: 'method',
  field_declaration: 'field',
};

/** Kinds construct enumeration returns (card 12); records and annotation types are not among them. */
export type ConstructKind = 'class' | 'interface' | 'enum';

/** Zero-based; columns count UTF-16 code units, as the parser does over a JS string. */
export interface Position {
  readonly line: number;
  readonly column: number;
}

/** One top-level declaration from a single parse, with everything copied out of the tree. */
export interface TopLevelNode {
  readonly kind: ConstructKind;
  readonly name: string | null;
  readonly start: Position;
  readonly end: Position;
  readonly nameStart: Position | null;
  readonly source: string;
  /** The declaration contains a syntax error or a missing token. */
  readonly hasError: boolean;
  readonly metrics: ConstructMetrics;
}

export type TopLevelResult =
  | { readonly ok: true; readonly nodes: readonly TopLevelNode[] }
  | { readonly ok: false };

const TOP_LEVEL_KINDS = new Map<string, ConstructKind>([
  ['class_declaration', 'class'],
  ['interface_declaration', 'interface'],
  ['enum_declaration', 'enum'],
]);

function positionOf(point: { row: number; column: number }): Position {
  return { line: point.row, column: point.column };
}

/**
 * Parses the file once and returns every top-level class, interface and enum, in source order,
 * with the same metrics the cursor path builds (card 12). Only direct children of the root
 * count: nested, local and anonymous types stay inside their outer declaration, and top-level
 * `ERROR` nodes are skipped. Never throws; a parser problem gives `{ ok: false }`.
 */
export async function extractTopLevel(
  source: string,
  importLines: string[],
): Promise<TopLevelResult> {
  try {
    const parser = await getParser();
    const tree = parser.parse(source);
    if (!tree) {
      return { ok: false };
    }
    try {
      const nodes = tree.rootNode.namedChildren.flatMap(
        (node): TopLevelNode[] => {
          const kind = TOP_LEVEL_KINDS.get(node.type);
          if (kind === undefined) {
            return [];
          }
          const nameNode = node.childForFieldName('name');
          return [
            {
              kind,
              name: nameNode?.text ?? null,
              start: positionOf(node.startPosition),
              end: positionOf(node.endPosition),
              nameStart: nameNode ? positionOf(nameNode.startPosition) : null,
              source: node.text,
              hasError: node.hasError,
              metrics: topLevelMetrics(node, kind, importLines),
            },
          ];
        },
      );
      return { ok: true, nodes };
    } finally {
      // Everything above is copied into plain values; background analysis enumerates on every
      // edit, so the tree's wasm memory is freed rather than left to the collector.
      tree.delete();
    }
  } catch (e) {
    console.error(
      'construct enumeration failed:',
      e instanceof Error ? e.message : String(e),
    );
    return { ok: false };
  }
}

/**
 * A top-level declaration has no enclosing class, as the cursor walk finds too. Only enums get
 * `enumMetrics`, and only here: the cursor path's metrics never carry the key.
 */
function topLevelMetrics(
  node: Node,
  kind: ConstructKind,
  importLines: string[],
): ConstructMetrics {
  const metrics = metricsFor(node, null, node, importLines);
  return kind === 'enum'
    ? { ...metrics, enumMetrics: extractEnumMetrics(node, importLines) }
    : metrics;
}

/** Parses the Java source, walks the AST from the cursor position to the nearest declaration, and returns structural metrics for that construct and its enclosing class. */
export async function extractMetrics(
  source: string,
  selectionRow: number,
  selectionCol: number,
  importLines: string[],
): Promise<ConstructMetrics | null> {
  try {
    const parser = await getParser();
    const tree = parser.parse(source);
    if (!tree) {
      return null;
    }

    let node: Node | null = tree.rootNode.descendantForPosition({
      row: selectionRow,
      column: selectionCol,
    });
    while (node && !DECLARATION_TYPES.has(node.type)) {
      node = node.parent;
    }

    if (!node) {
      return null;
    }

    let enclosingClass: Node | null = node.parent;
    while (
      enclosingClass &&
      enclosingClass.type !== 'class_declaration' &&
      enclosingClass.type !== 'interface_declaration'
    ) {
      enclosingClass = enclosingClass.parent;
    }

    const isClassOrInterface =
      node.type === 'class_declaration' ||
      node.type === 'interface_declaration';
    const classNode = isClassOrInterface ? node : enclosingClass;

    if (!classNode) {
      return null;
    }

    return metricsFor(node, enclosingClass, classNode, importLines);
  } catch (e) {
    console.error('extractMetrics failed:', e);
    return null;
  }
}

/**
 * Structural metrics for one declaration node. Shared by the cursor path above and by
 * construct enumeration (card 12), so both build exactly the same object.
 */
function metricsFor(
  node: Node,
  enclosingClass: Node | null,
  classNode: Node,
  importLines: string[],
): ConstructMetrics {
  return {
    constructType: CONSTRUCT_TYPE_MAP[node.type] ?? 'unknown',
    name: node.childForFieldName('name')?.text ?? null,
    annotations: nodeAnnotations(node),
    startRow: node.startPosition.row,
    enclosingClassStartRow: enclosingClass?.startPosition.row ?? null,
    classSource: classNode.text,
    classMetrics:
      node.type === 'class_declaration'
        ? extractClassMetrics(node, importLines)
        : null,
    interfaceMetrics:
      node.type === 'interface_declaration'
        ? extractInterfaceMetrics(node)
        : null,
  };
}
