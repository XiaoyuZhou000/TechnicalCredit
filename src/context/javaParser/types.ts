export interface NestedDeclaration {
  type: 'class' | 'interface' | 'enum';
  name: string;
  implementedInterfaces: string[];
  annotations: string[];
}

export interface ConstructMetrics {
  constructType:
    | 'class'
    | 'interface'
    | 'enum'
    | 'method'
    | 'field'
    | 'unknown';
  name: string | null;
  annotations: string[];
  startRow: number;
  enclosingClassStartRow: number | null;
  /** Full source text of the class or interface being analysed. */
  classSource: string;
  classMetrics: {
    superclass: string | null;
    implementedInterfaces: { name: string; resolvedImport: string | null }[];
    fields: {
      name: string;
      type: string;
      isFinal: boolean;
      annotations: string[];
    }[];
    finalFieldTypes: string[];
    constructors: {
      paramCount: number;
      paramTypes: string[];
      hasAutowired: boolean;
    }[];
    methodCount: number;
    nestedDeclarations: NestedDeclaration[];
  } | null;
  interfaceMetrics: {
    fieldCount: number;
    methodCount: number;
    extendedInterfaces: string[];
  } | null;
  /**
   * Card 12: present only on top-level enums from construct enumeration; absent (not null)
   * elsewhere, so the manual path's prompt JSON for classes and interfaces is unchanged.
   */
  enumMetrics?: EnumMetrics;
}

/** The enum counterpart of `classMetrics` (card 12). */
export interface EnumMetrics {
  constants: string[];
  implementedInterfaces: { name: string; resolvedImport: string | null }[];
  fields: {
    name: string;
    type: string;
    isFinal: boolean;
    annotations: string[];
  }[];
  finalFieldTypes: string[];
  constructors: {
    paramCount: number;
    paramTypes: string[];
    hasAutowired: boolean;
  }[];
  methodCount: number;
  nestedDeclarations: NestedDeclaration[];
}

// Node types that mark a meaningful declaration boundary when walking up the AST.
export const DECLARATION_TYPES = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'method_declaration',
  'field_declaration',
]);

export const NESTED_TYPE_MAP: Record<string, NestedDeclaration['type']> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
};
