import {
  Expr,
  isList,
  Identifier,
  List,
  FnType,
  isIdentifier,
  Type,
} from "../../lib/index.mjs";
import { SyntaxMacro } from "../types.mjs";
import { getInfoFromRawParam } from "./lib/get-info-from-raw-param.mjs";
import { isStruct } from "./lib/is-struct.mjs";
import { typedStructListToStructType } from "./lib/typed-struct-to-struct-type.mjs";

/** Registers any explicitly type annotated values */
export const registerAnnotatedTypes: SyntaxMacro = (list) => {
  scanAnnotatedTypes(list);
  return list;
};

const scanAnnotatedTypes = (expr: Expr) => {
  if (!isList(expr)) return;
  const isFnDef =
    expr.calls("define-function") || expr.calls("define-extern-function");

  if (isFnDef) {
    initFn(expr);
    return;
  }

  if (expr.calls("define-type")) {
    const id = expr.at(1) as Identifier;
    const val = expr.at(2) as Expr;

    // Todo support more than primitives and structs;
    const type = isStruct(val)
      ? typedStructListToStructType(val as List)
      : val.getTypeOf()!;
    const parent = expr.getParent();
    parent?.setType(id, type);
    return;
  }

  expr.value.forEach(scanAnnotatedTypes);
};

const initFn = (expr: List) => {
  const parent = expr.getParent()!;
  const fnIdentifier = expr.at(1) as Identifier;
  const paramsIndex = expr.calls("define-function") ? 2 : 3;
  const params = (expr.at(paramsIndex) as List).value.slice(1).map((p) => {
    // For now assume all params are either structs or labeled expressions
    const { label, identifier, type } = getInfoFromRawParam(p as List);
    if (identifier) {
      identifier.setTypeOf(type);
    }

    return { label: label?.value, name: identifier?.value, type };
  });
  const suppliedReturnType = getSuppliedReturnTypeForFn(expr, paramsIndex + 1);

  const fnType = new FnType({
    from: expr,
    value: { params, returns: suppliedReturnType },
  });

  expr.setTypeOf(fnType);
  fnIdentifier.setTypeOf(fnType);
  parent.setFn(fnIdentifier, fnType);
};

const getSuppliedReturnTypeForFn = (
  list: List,
  defIndex: number
): Type | undefined => {
  const definition = list.at(defIndex);
  if (!isList(definition)) return undefined;
  const identifier = definition.at(1); // Todo: Support inline context data types?
  if (!isIdentifier(identifier)) return undefined;
  return list.getType(identifier);
};
