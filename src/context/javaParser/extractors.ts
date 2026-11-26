import { Node } from 'web-tree-sitter';
import {
  ConstructMetrics,
  EnumMetrics,
  NestedDeclaration,
  NESTED_TYPE_MAP,
} from './types';
import {
  getModifiers,
  getTypeNode,
  nodeAnnotations,
  fieldNodes,
  resolveInterfaceNames,
} from './helpers';

/** Extracts superclass, implemented interfaces, fields, constructors, method count, and nested declarations from a class declaration node. */
export function extractClassMetrics(
  decl: Node,
  importLines: string[],
): ConstructMetrics['classMetrics'] {
  const body = decl.childForFieldName('body');
  const superclass =
    decl
      .childForFieldName('superclass')
      ?.namedChildren.find((c) => c.type === 'type_identifier')?.text ?? null;
  const implementedInterfaces = resolveInterfaceNames(decl, importLines);

  // Key order is part of the prompt (JSON.stringify keeps it), so it stays as it always was.
  return { superclass, implementedInterfaces, ...memberMetrics(body) };
}

type MemberMetrics = Pick<
  EnumMetrics,
  | 'fields'
  | 'finalFieldTypes'
  | 'constructors'
  | 'methodCount'
  | 'nestedDeclarations'
>;

/**
 * Fields, constructors, method count and nested declarations of a class body, or of an enum's
 * `enum_body_declarations` (card 12). `null` (no body) gives empty members.
 */
function memberMetrics(body: Node | null): MemberMetrics {
  if (!body) {
    return {
      fields: [],
      finalFieldTypes: [],
      constructors: [],
      methodCount: 0,
      nestedDeclarations: [],
    };
  }

  const fields = fieldNodes(body).map((f) => {
    const mods = getModifiers(f);
    const isFinal = mods?.children.some((m) => m.text === 'final') ?? false;
    const declarator = f.namedChildren.find(
      (c) => c.type === 'variable_declarator',
    );
    return {
      name: declarator?.childForFieldName('name')?.text ?? '',
      type: getTypeNode(f)?.text ?? '',
      isFinal,
      annotations: nodeAnnotations(f),
    };
  });

  const constructors = body.namedChildren
    .filter((c) => c.type === 'constructor_declaration')
    .map((ctor) => {
      const params = ctor.childForFieldName('parameters');
      const paramNodes =
        params?.namedChildren.filter(
          (p) => p.type === 'formal_parameter' || p.type === 'spread_parameter',
        ) ?? [];
      const hasAutowired = nodeAnnotations(ctor).includes('Autowired');
      return {
        paramCount: paramNodes.length,
        paramTypes: paramNodes.map((p) => getTypeNode(p)?.text ?? ''),
        hasAutowired,
      };
    });

  const methodCount = body.namedChildren.filter(
    (c) => c.type === 'method_declaration',
  ).length;
  const finalFieldTypes = fields.filter((f) => f.isFinal).map((f) => f.type);
  const nestedDeclarations: NestedDeclaration[] = body.namedChildren
    .filter((c) => c.type in NESTED_TYPE_MAP)
    .map((c) => ({
      type: NESTED_TYPE_MAP[c.type],
      name: c.childForFieldName('name')?.text ?? '',
      implementedInterfaces: resolveInterfaceNames(c, []).map((i) => i.name),
      annotations: nodeAnnotations(c),
    }));

  return {
    fields,
    finalFieldTypes,
    constructors,
    methodCount,
    nestedDeclarations,
  };
}

/**
 * The enum counterpart of `extractClassMetrics`, for construct enumeration only (card 12).
 * Interfaces go through the same `resolveInterfaceNames` as classes, so the two kinds agree.
 */
export function extractEnumMetrics(
  decl: Node,
  importLines: string[],
): EnumMetrics {
  const body = decl.childForFieldName('body');
  const constants =
    body?.namedChildren
      .filter((c) => c.type === 'enum_constant')
      .map((c) => c.childForFieldName('name')?.text ?? '') ?? [];
  const declarations =
    body?.namedChildren.find((c) => c.type === 'enum_body_declarations') ??
    null;
  return {
    constants,
    implementedInterfaces: resolveInterfaceNames(decl, importLines),
    ...memberMetrics(declarations),
  };
}

/** Extracts field count, method count, and extended interfaces from an interface declaration node. */
export function extractInterfaceMetrics(
  decl: Node,
): ConstructMetrics['interfaceMetrics'] {
  const body = decl.childForFieldName('body');
  const extendsNode =
    decl.childForFieldName('interfaces') ??
    decl.namedChildren.find((c) => c.type === 'extends_interfaces');
  const extendedInterfaces = (extendsNode?.namedChildren ?? []).flatMap((c) =>
    c.type === 'interface_type_list'
      ? c.namedChildren
          .filter((n) => n.type === 'type_identifier')
          .map((n) => n.text)
      : c.type === 'type_identifier'
        ? [c.text]
        : [],
  );

  return {
    fieldCount: body ? fieldNodes(body).length : 0,
    methodCount: body
      ? body.namedChildren.filter((c) => c.type === 'method_declaration').length
      : 0,
    extendedInterfaces,
  };
}
