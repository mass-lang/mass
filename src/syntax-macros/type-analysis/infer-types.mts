import {
  List,
  Expr,
  noop,
  isList,
  Identifier,
  isFnType,
  FnType,
  isStructType,
  StructType,
  isIdentifier,
  BaseType,
  Type,
  isInt,
  i32,
  isFloat,
  f32,
  isBool,
  bool,
  dVoid,
  PrimitiveType,
  WasmStackType,
  Id,
} from "../../lib/index.mjs";
import { getIdStr } from "../../lib/syntax/get-id-str.mjs";
import { SyntaxMacro } from "../types.mjs";
import { getInfoFromRawParam } from "./lib/get-info-from-raw-param.mjs";
import { isPrimitiveFn } from "./lib/is-primitive-fn.mjs";
import { isStruct } from "./lib/is-struct.mjs";
import { typedStructListToStructType } from "./lib/typed-struct-to-struct-type.mjs";
import { typesMatch } from "./lib/types-match.mjs";

const modules = new Map<string, List>();

export const inferTypes: SyntaxMacro = (list): List =>
  inferExprTypes(list) as List;

const inferExprTypes = (expr: Expr | undefined): Expr => {
  if (!expr) return noop();
  if (!isList(expr)) return expr;
  return inferFnCallTypes(expr);
};

const inferFnCallTypes = (list: List): List => {
  if (list.calls("define-function")) return inferFnTypes(list);
  if (list.calls("define-type")) return list;
  if (list.calls("define-cdt")) return list;
  if (list.calls("block")) return inferBlockTypes(list);
  if (list.calls("lambda-expr")) return list;
  if (list.calls("export")) return inferExportTypes(list);
  if (list.calls("root")) return inferRootModuleTypes(list);
  if (list.calls("module")) return inferModuleTypes(list);
  if (list.calls("quote")) return list;

  if (list.calls("define-extern-function")) {
    return inferExternFnTypes(list);
  }

  if (list.calls("bnr") || list.calls("binaryen-mod")) {
    return inferBnrCallTypes(list);
  }

  if (
    typeof list.at(0)?.value === "string" &&
    (list.at(0)!.value as string).startsWith("define")
  ) {
    return inferVarTypes(list);
  }

  if (isPrimitiveFn(list.at(0))) {
    return inferPrimitiveFnTypes(list);
  }

  return inferUserFnCallTypes(list);
};

const inferBnrCallTypes = (list: List): List => {
  const body = list.at(2) as List | undefined;
  body?.value.forEach((v) => inferExprTypes(v));
  return list;
};

const inferFnTypes = (list: List): List => {
  list.setAsFn();
  const identifier = list.at(1) as Identifier;
  const rawParameters = list.at(2) as List;
  const fn = list.getTypeOf();

  if (!isFnType(fn)) {
    throw new Error(`Could not find matching function for ${identifier.value}`);
  }

  const parameters = inferFnParams(rawParameters);

  const typedBlock = inferExprTypes(list.at(4));
  if (!isList(typedBlock) || !typedBlock.calls("typed-block")) {
    throw new Error("Expected typed-block");
  }

  // Function types are (((paramIdentifier | false) paramType)* returnType:Expr | false) (at this point)
  const suppliedReturnType = fn.returns;

  const inferredReturnType = assertFunctionReturnType(
    typedBlock,
    suppliedReturnType,
    identifier
  );

  const returnType = suppliedReturnType ?? inferredReturnType;
  if (!returnType) {
    console.error(JSON.stringify(list, undefined, 2));
    throw new Error("Could not determine return type of fn");
  }

  // Note to future self. This is why references can be so nice to have. But we should probably have an &mut syntax
  fn.returns = returnType;
  identifier.setTypeOf(fn);

  return new List({
    value: [
      "define-function",
      identifier,
      parameters,
      ["return-type", returnType!],
      typedBlock,
    ],
    from: list,
  });
};

const inferExternFnTypes = (list: List): List => {
  list.setAsFn();
  const identifier = list.at(1) as Identifier;
  const namespace = list.at(2) as List;
  const rawParameters = list.at(3) as List;
  const fn = list.getTypeOf();

  if (!isFnType(fn)) {
    throw new Error(`Could not find matching function for ${identifier.value}`);
  }

  const parameters = inferFnParams(rawParameters);

  // Function types are (((paramIdentifier | false) paramType)* returnType:Expr | false) (at this point)
  identifier.setTypeOf(fn);

  return new List({
    value: [
      "define-extern-function",
      identifier,
      namespace,
      parameters,
      ["return-type", fn.returns!],
    ],
    from: list,
  });
};

/**
 * For now, all params are assumed to be manually typed.
 * Returns the updated list of parameters
 */
const inferFnParams = (params: List): List => {
  if (!params.calls("parameters")) {
    throw new Error("Expected function parameters");
  }

  const fnDef = params.getParent() as List;

  return new List({
    value: [
      "parameters",
      ...params.slice(1).value.flatMap((expr): Expr[] => {
        if (!isList(expr)) {
          throw new Error("All parameters must be typed");
        }

        if (isStruct(expr)) {
          return expr
            .slice(1)
            .value.map((value) => registerStructParamField(value, fnDef));
        }

        const { identifier, type, label } = getInfoFromRawParam(expr);
        identifier!.setTypeOf(type);
        fnDef.setVar(identifier!, { kind: "param", type });
        const value = [identifier!, type];
        if (label) value.push(label);
        return [new List({ value, from: expr })];
      }),
    ],
    from: params,
  });
};

const registerStructParamField = (value: Expr, fnDef: Expr): Expr => {
  if (!isList(value)) {
    throw new Error("All struct parameters must be typed");
  }
  const { identifier, type } = getInfoFromRawParam(value);
  identifier!.setTypeOf(type);
  fnDef.setVar(identifier!, { kind: "param", type });
  return new List({ value: [identifier!, type] });
};

const inferBlockTypes = (list: List): List => {
  const annotatedArgs = list.slice(1).map((expr) => inferExprTypes(expr));

  const type = getExprReturnType(annotatedArgs.at(-1));

  if (!type) {
    console.error(JSON.stringify(list, undefined, 2));
    throw new Error("Could not determine return type of preceding block");
  }

  return new List({
    value: ["typed-block", type, ...annotatedArgs.value],
    from: list,
  });
};

const inferPrimitiveFnTypes = (list: List): List => {
  if (list.calls("=")) {
    return addTypeAnnotationsToAssignment(list);
  }

  return list.mapArgs(inferExprTypes);
};

const addTypeAnnotationsToAssignment = (list: List): List => {
  const assignee = list.at(1);

  if (isList(assignee)) {
    return transformFieldAssignment(assignee, list);
  }

  return list.mapArgs(inferExprTypes);
};

// Convert field assignment expressions into set expressions
// ["=", ["y", "pos"], 10] converts to ["set-y", "pos", 10]
// Positions { pos: { x:i32, y:i32 } }
// ["=", ["y", ["pos", "positions"]], 10] converts to ["set-y", ["pos-pointer" positions], 10]
function transformFieldAssignment(assignee: List, assignmentExpr: List) {
  const updated = assignee.clone().setParent(assignmentExpr.getParent());
  const field = assignee.at(0)?.value as string;
  const setter = Identifier.from(`set-${field}`);
  updated.set(0, setter);
  updated.set(1, fieldParentPointer(assignee.at(1)!));
  updated.push(assignmentExpr.at(2)!);
  return inferUserFnCallTypes(updated);
}

function fieldParentPointer(expr: Expr): Expr {
  if (!isList(expr)) return expr;
  const field = expr.at(0)?.value as string;
  const pointerFn = Identifier.from(`${field}-pointer`);
  const updated = expr.clone();
  updated.set(0, pointerFn);
  updated.set(1, fieldParentPointer(expr.at(1)!));
  return updated;
}

function inferUserFnCallTypes(list: List) {
  const identifier = list.first() as Identifier;
  list.rest().forEach(inferExprTypes);
  const fn = getMatchingFnForCallExpr(list);
  if (!fn) {
    console.error(JSON.stringify(list, undefined, 2));
    throw new Error("Could not find matching fn for above call expression");
  }

  const annotatedArgs = list.slice(1).value.flatMap((expr, index) => {
    const paramType = fn.getParam(index)?.type;
    const paramIsStructType = isStructType(paramType);
    const exprIsStruct = isStruct(expr);
    if (paramIsStructType && exprIsStruct) {
      return applyStructParams(paramType, expr as List);
    }

    return [inferExprTypes(expr)];
  });

  identifier.setTypeOf(fn);
  return new List({ value: [identifier, ...annotatedArgs], from: list });
}

/** Re-orders the supplied struct and returns it as a normal list of expressions to be passed as args */
const applyStructParams = (
  expectedStruct: StructType,
  suppliedStruct: List
): Expr[] =>
  expectedStruct.value.map(({ name }) => {
    const arg = suppliedStruct
      .slice(1)
      .value.find((expr) => (expr as List).at(1)?.is(name)) as List;
    if (!arg) throw new Error(`Could not find arg for field ${name}`);
    return arg.at(2)!;
  });

const inferRootModuleTypes = (list: List): List =>
  list.map((expr) => inferExprTypes(expr));

const inferModuleTypes = (list: List): List => {
  modules.set((list.at(1) as Identifier)!.value, list);
  const imports = list.at(2) as List;
  const exports = list.at(3) as List;
  const body = list.at(4) as List;
  resolveImports(imports, exports);
  list.value[4] = body.map((expr) => inferExprTypes(expr));
  resolveExports({ exports, body: list.at(4) as List });
  return list;
};

// This is probably super problematic
const resolveImports = (imports: List, exports: List): void => {
  const parent = imports.getParent()!;
  for (const imp of imports.value) {
    if (!isList(imp)) continue;
    const module = modules.get(imp.at(0)!.value as string);
    const isReExported = imp.at(2)?.is("re-exported");
    if (!module) continue;
    // TODO support import patterns other than ***
    for (const exp of module.at(3)?.value as Expr[]) {
      if (!isIdentifier(exp) || exp.is("exports")) continue;
      const type = exp.getTypeOf();

      if (type instanceof FnType) {
        parent.setFn(exp, type);
        if (isReExported) exports.push(exp);
        continue;
      }

      if (exp.def && exp.def.kind === "global") {
        parent.setVar(exp, exp.def);
        if (isReExported) exports.push(exp);
        continue;
      }

      if (type instanceof BaseType) {
        parent.setType(exp, type);
        if (isReExported) exports.push(exp);
        continue;
      }
    }
  }
};

const resolveExports = ({
  exports,
  body,
}: {
  exports: List;
  body: List;
}): void => {
  body.value.forEach((expr) => {
    if (!isList(expr)) return;
    if (expr.calls("export")) {
      exports.push(expr.at(1) as Identifier);
      return;
    }
    return resolveExports({ exports, body: expr });
  });
};

const inferVarTypes = (list: List): List => {
  const varFnId = list.at(0) as Identifier;
  const mut = varFnId.value.includes("define-mut");
  const global = varFnId.value.includes("global");
  const initializer = list.at(2);
  const annotatedInitializer = inferExprTypes(initializer?.clone());
  const inferredType = getExprReturnType(annotatedInitializer);
  // Get identifier from a potentially untyped definition
  const def = list.at(1)!;
  const identifier = isList(def)
    ? (def.at(1) as Identifier) // Typed case
    : (def as Identifier); // Untyped case
  const suppliedType = isList(def)
    ? isStruct(def)
      ? typedStructListToStructType(def)
      : getTypeFromLabeledExpr(def)
    : undefined;

  if (suppliedType && !typesMatch(suppliedType, inferredType)) {
    throw new Error(
      `${identifier} of type ${suppliedType} is not assignable to ${inferredType}`
    );
  }

  const type = suppliedType ?? inferredType;
  if (!type) {
    throw new Error(
      `Could not determine type for identifier ${identifier.value}`
    );
  }

  identifier.setTypeOf(type);
  list
    .getParent()
    ?.setVar(identifier, { kind: global ? "global" : "var", mut, type });

  return new List({
    value: [varFnId, identifier, annotatedInitializer],
    from: list,
  });
};

const getTypeFromLabeledExpr = (def: List): Type | undefined => {
  if (!def.calls("labeled-expr")) {
    throw new Error("Expected labeled expression");
  }
  const typeId = def.at(2);
  if (!isIdentifier(typeId)) {
    throw new Error("Param type annotations must be identifiers (for now)");
  }

  return def.getType(typeId);
};

const getExprReturnType = (expr?: Expr): Type | undefined => {
  if (!expr) return;
  if (isInt(expr)) return i32;
  if (isFloat(expr)) return f32;
  if (isBool(expr)) return bool;
  if (expr.is("void")) return dVoid;
  if (isIdentifier(expr)) return expr.getTypeOf();
  if (!isList(expr)) throw new Error(`Invalid expression ${expr}`);

  if (expr.calls("labeled-expr")) return getExprReturnType(expr.at(2));
  if (expr.calls("block")) return getExprReturnType(expr.at(-1));
  if (expr.calls("struct")) return getStructLiteralType(expr);
  if (expr.calls("bnr") || expr.calls("binaryen-mod")) {
    return getBnrReturnType(expr);
  }
  if (expr.calls("if")) return getIfReturnType(expr);

  const fn = getMatchingFnForCallExpr(expr);
  return fn?.returns;
};

/** Takes the expression form of a struct and converts it into type form */
const getStructLiteralType = (ast: List): StructType =>
  new StructType({
    value: ast.slice(1).value.map((labeledExpr) => {
      const list = labeledExpr as List;
      const identifier = list.at(1) as Identifier;
      const type = getExprReturnType(list.at(2));
      if (!type) {
        throw new Error("Could not determine type for struct literal");
      }
      return { name: identifier.value, type };
    }),
    parent: ast,
  });

// TODO type check this mofo
const getIfReturnType = (list: List): Type | undefined =>
  getExprReturnType(list.at(2));

const getBnrReturnType = (call: List): Type | undefined => {
  const info = call.at(1) as List | undefined;
  const id = info?.at(2) as Identifier;
  return new PrimitiveType({ from: id, value: id.value as WasmStackType });
};

const getMatchingFnForCallExpr = (call: List): FnType | undefined => {
  const identifier = call.first() as Identifier;
  const args = call.slice(1);
  const fn = getMatchingFn({ identifier, args });
  if (fn) identifier.setTypeOf(fn);
  return fn;
};

const getMatchingFn = ({
  identifier,
  args,
}: {
  identifier: Identifier;
  args: List;
}): FnType | undefined => {
  const candidates = identifier.getFns(identifier);
  if (!candidates) return undefined;
  return candidates.find((candidate) => {
    const params = candidate.value.params;
    return params.every((p, index) => {
      const arg = args.at(index);
      if (!arg) return false;
      const argType = getExprReturnType(arg);
      const argLabel = getExprLabel(arg);
      const labelsMatch = p.label === argLabel;
      return typesMatch(p.type, argType) && labelsMatch;
    });
  });
};

const getExprLabel = (expr?: Expr): string | undefined => {
  if (!isList(expr)) return;
  if (!expr.first()?.is("labeled-expr")) return;
  return expr.at(1)!.value as string;
};

const inferExportTypes = (exp: List) => {
  const exportId = exp.at(1);
  if (!isIdentifier(exportId)) {
    throw new Error("Missing identifier in export");
  }

  const params = exp.at(2);
  if (isList(params) && params.calls("parameters")) {
    inferFnExportTypes(exportId, params);
    return exp;
  }

  return exp;
};

const inferFnExportTypes = (fnId: Identifier, params: List) => {
  const candidates = fnId.getFns(fnId);
  const fn = candidates.find((candidate) =>
    candidate.value.params.every((param, index) => {
      const p = params.at(index + 1);
      if (!isList(p)) return false;
      const { label, identifier, type } = getInfoFromRawParam(p as List);
      const identifiersMatch = identifier ? identifier.is(param.name) : true;
      const labelsMatch = label ? label.is(param.label) : true;
      const typesDoMatch = typesMatch(param.type, type);
      return typesDoMatch && identifiersMatch && labelsMatch;
    })
  );

  if (!fn) {
    console.error(JSON.stringify([fnId, params], null, 2));
    throw new Error(`Fn ${fnId} not found for the above export expression`);
  }

  fnId.setTypeOf(fn);
};

function assertFunctionReturnType(
  typedBlock: List,
  suppliedReturnType: Type | undefined,
  id: Id
): Type {
  const inferredReturnType = typedBlock.at(1) as Type;
  const shouldCheckInferredType =
    suppliedReturnType && !suppliedReturnType?.is("void");
  const typeMismatch =
    shouldCheckInferredType &&
    !typesMatch(suppliedReturnType, inferredReturnType);

  if (typeMismatch) {
    const name = getIdStr(id);
    throw new Error(
      `Expected fn ${name} to return ${suppliedReturnType}, got ${inferredReturnType}`
    );
  }
  return inferredReturnType;
}
