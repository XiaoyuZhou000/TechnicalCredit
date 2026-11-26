import {
  assembleContext,
  extractImports,
  type TcContext,
} from '@/context/buildContext';
import {
  extractTopLevel,
  type ConstructKind,
  type Position,
  type TopLevelNode,
} from '@/context/javaParser';

export type { ConstructKind, Position };

/** One top-level type in a file, with the context the manual path would build for it. */
export interface ConstructDescriptor {
  readonly kind: ConstructKind;
  readonly name: string | null;
  /** The declaration's start, including leading annotations and modifiers. */
  readonly line: number;
  readonly column: number;
  readonly nameLine: number | null;
  readonly nameColumn: number | null;
  readonly span: { readonly start: Position; readonly end: Position };
  readonly source: string;
  /** The declaration has a syntax error; whether to analyse it is the caller's decision. */
  readonly incomplete: boolean;
  readonly context: TcContext;
}

export type EnumerationResult =
  | {
      readonly ok: true;
      readonly constructs: readonly ConstructDescriptor[];
      /**
       * The file has a syntax error somewhere. A half-typed declaration can then be scattered
       * over top-level fragments or swallowed by its neighbour, so `constructs` may miss or
       * misplace some: a construct absent from this list must not be treated as deleted.
       */
      readonly hasSyntaxErrors: boolean;
    }
  | { readonly ok: false; readonly reason: 'unavailable' };

const NOTHING: EnumerationResult = Object.freeze({
  ok: true,
  constructs: Object.freeze([]),
  hasSyntaxErrors: false,
});

const UNAVAILABLE: EnumerationResult = Object.freeze({
  ok: false,
  reason: 'unavailable',
});

/**
 * Card 12: every top-level class, interface and enum in one Java file, from a single parse, in
 * source order, positioned in the original text. Single-file only: it never reads imported
 * files, calls a detector or touches `vscode`. Never throws; an unusable parser gives
 * `unavailable`, which is distinct from a file with no constructs.
 */
export async function enumerateConstructs(
  source: string,
  fileName: string,
  languageId: string,
): Promise<EnumerationResult> {
  if (languageId !== 'java') {
    return NOTHING;
  }
  try {
    const importLines = extractImports(source);
    const result = await extractTopLevel(source, importLines);
    if (!result.ok) {
      return UNAVAILABLE;
    }
    return Object.freeze({
      ok: true,
      constructs: Object.freeze(
        result.nodes.map((node) =>
          describe(node, source, importLines, fileName),
        ),
      ),
      hasSyntaxErrors: result.hasSyntaxErrors,
    });
  } catch (e) {
    console.error(
      'construct enumeration failed:',
      e instanceof Error ? e.message : String(e),
    );
    return UNAVAILABLE;
  }
}

function describe(
  node: TopLevelNode,
  source: string,
  importLines: readonly string[],
  fileName: string,
): ConstructDescriptor {
  return Object.freeze({
    kind: node.kind,
    name: node.name,
    line: node.start.line,
    column: node.start.column,
    nameLine: node.nameStart?.line ?? null,
    nameColumn: node.nameStart?.column ?? null,
    span: Object.freeze({
      start: Object.freeze({ ...node.start }),
      end: Object.freeze({ ...node.end }),
    }),
    source: node.source,
    incomplete: node.hasError,
    // A copy each, so one consumer changing its import list can't affect another descriptor.
    context: assembleContext(
      source,
      [...importLines],
      node.metrics,
      node.start.line,
      'java',
      fileName,
    ),
  });
}
