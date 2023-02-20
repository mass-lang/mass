import {
  List,
  isList,
  Identifier,
  isPrimitiveType,
  CDT_ADDRESS_TYPE,
  FnType,
  Int,
} from "../lib/index.mjs";
import { ModuleInfo } from "../lib/module-info.mjs";

export const memoryManagement = (list: List, info: ModuleInfo): List => {
  if (!info.isRoot) return list;
  const fns = getMemFns(list);
  return insertMemInstructions({ list, fns });
};

const insertMemInstructions = (opts: InsertOpts): List =>
  opts.list.reduce((expr) => {
    if (!isList(expr)) return expr;

    if (expr.calls("define-function")) {
      return addMemInstructionsToFunctionDef({ ...opts, list: expr });
    }

    if (expr.calls("typed-block")) {
      return addMemInstructionsToBlock({ ...opts, list: expr });
    }

    return insertMemInstructions({ ...opts, list: expr });
  });

const addMemInstructionsToBlock = (opts: InsertOpts): List => {
  const { list, fns } = opts;
  const { alloc, setReturn, copy } = fns;

  const type = list.at(1)?.getTypeOf();
  if (!type) throw new Error("Block type not found");
  if (isPrimitiveType(type)) return insertMemInstructions(opts);

  const body = insertMemInstructions({
    ...opts,
    list: list.slice(2),
  });

  const returnAddr = Identifier.from("*__block_return_alloc_address");
  returnAddr.setTypeOf(CDT_ADDRESS_TYPE);
  return new List({
    from: list,
    value: [
      "typed-block",
      CDT_ADDRESS_TYPE,
      ["define", returnAddr, [alloc, new Int({ value: type.size })]],
      [setReturn, [copy, body, returnAddr]],
    ],
  });
};

const addMemInstructionsToFunctionDef = (opts: InsertOpts): List => {
  const { list, fns } = opts;
  const { alloc, setReturn, copy } = fns;

  const fnId = list.at(1) as Identifier;
  const fn = fnId.getTypeOf() as FnType;

  if (isPrimitiveType(fn.returns)) return insertMemInstructions(opts);
  const allocationSize = fn.returns!.size;
  const body = list.at(4)!;
  const returnAddr = Identifier.from("*__return_alloc_address");
  returnAddr.setTypeOf(CDT_ADDRESS_TYPE);

  list.set(
    4,
    new List({
      from: list.value[4],
      value: [
        "typed-block",
        CDT_ADDRESS_TYPE,
        ["define", returnAddr, [alloc, new Int({ value: allocationSize })]],
        [setReturn, [copy, body, returnAddr]],
      ],
    })
  );
  return list;
};

const getFnId = (parent: List, name: string): Identifier => {
  const fnIdFn = parent.getFns(name)[0];
  const fnId = Identifier.from(name);
  fnId.setTypeOf(fnIdFn);
  return fnId;
};

const getMemFns = (parent: List): MemFns => {
  const alloc = getFnId(parent, "alloc");
  const setReturn = getFnId(parent, "set-return");
  const copy = getFnId(parent, "copy");
  return { alloc, setReturn, copy };
};

type InsertOpts = {
  fns: MemFns;
  list: List;
};

type MemFns = {
  alloc: Identifier;
  setReturn: Identifier;
  copy: Identifier;
};
