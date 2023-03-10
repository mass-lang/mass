import { Expr } from "./expr.mjs";
import { Syntax, SyntaxOpts } from "./syntax.mjs";

export class Float extends Syntax {
  readonly __type = "float";
  value: number;

  constructor(opts: SyntaxOpts & { value: number }) {
    super(opts);
    this.value = opts.value;
  }

  clone(parent?: Expr): Float {
    return new Float({ parent, value: this.value, from: this });
  }
}
