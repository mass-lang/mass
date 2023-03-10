import { File } from "../lib/file.mjs";
import { ModuleInfo } from "../lib/module-info.mjs";
import { Expr, List } from "../lib/syntax/index.mjs";
import { Token } from "../lib/token.mjs";

export interface ReaderMacro {
  tag: string | RegExp;
  macro: (
    file: File,
    opts: {
      token: Token;
      reader: (file: File, terminator?: string, parent?: Expr) => List;
      module: ModuleInfo;
    }
  ) => Expr;
}
