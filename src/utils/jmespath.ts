// Pure TypeScript port of Python's jmespath library (lexer, Pratt parser, tree
// interpreter, standard functions, and exception hierarchy). Matches Python jmespath's
// error classes, messages, column markers, and evaluation semantics verbatim.

// --- Python-style formatting helpers ---------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  !(v instanceof ExpressionRef);

function pyReprString(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return out + quote;
}

function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return pyReprString(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (v instanceof ExpressionRef)
    return "<jmespath.visitor._Expression object>";
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).map(
      ([k, val]) => `${pyReprString(k)}: ${pyRepr(val)}`,
    );
    return `{${entries.join(", ")}}`;
  }
  return String(v);
}

function pyStr(v: unknown): string {
  if (typeof v === "string") return v;
  return pyRepr(v);
}

// --- Exceptions ------------------------------------------------------------------------

export class JMESPathError extends Error {
  readonly pythonName: string = "JMESPathError";

  constructor(message = "") {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ParseError extends JMESPathError {
  override readonly pythonName: string = "ParseError";
  lexPosition: number;
  tokenValue: unknown;
  tokenType: string | null;
  msg: string;
  expression: string | null = null;

  constructor(
    lexPosition: number,
    tokenValue: unknown,
    tokenType: string | null,
    msg = "Invalid jmespath expression",
  ) {
    super("");
    this.lexPosition = lexPosition;
    this.tokenValue = tokenValue;
    this.tokenType = tokenType !== null ? tokenType.toUpperCase() : null;
    this.msg = msg;
    this.updateMessage();
  }

  setExpression(expression: string): void {
    this.expression = expression;
    this.updateMessage();
  }

  protected formatMessage(): string {
    const underline = `${" ".repeat(this.lexPosition + 1)}^`;
    return `${this.msg}: Parse error at column ${this.lexPosition}, token "${pyStr(this.tokenValue)}" (${this.tokenType}), for expression:\n"${this.expression}"\n${underline}`;
  }

  protected updateMessage(): void {
    this.message = this.formatMessage();
  }
}

export class IncompleteExpressionError extends ParseError {
  override readonly pythonName = "IncompleteExpressionError";

  override setExpression(expression: string): void {
    this.expression = expression;
    this.lexPosition = [...expression].length;
    this.tokenType = null;
    this.tokenValue = null;
    this.updateMessage();
  }

  protected override formatMessage(): string {
    const underline = `${" ".repeat(this.lexPosition + 1)}^`;
    return `Invalid jmespath expression: Incomplete expression:\n"${this.expression}"\n${underline}`;
  }
}

export class LexerError extends ParseError {
  override readonly pythonName = "LexerError";
  readonly lexerPosition: number;
  readonly lexerValue: string;
  readonly lexerMessage: string;

  constructor(
    lexerPosition: number,
    lexerValue: string,
    lexerMessage: string,
    expression: string | null = null,
  ) {
    super(lexerPosition, lexerValue, lexerMessage);
    this.lexerPosition = lexerPosition;
    this.lexerValue = lexerValue;
    this.lexerMessage = lexerMessage;
    this.expression = expression;
    this.updateMessage();
  }

  protected override formatMessage(): string {
    const underline = `${" ".repeat(this.lexerPosition)}^`;
    return `Bad jmespath expression: ${this.lexerMessage}:\n${this.expression}\n${underline}`;
  }
}

export class ArityError extends ParseError {
  override readonly pythonName: string = "ArityError";
  readonly expectedArity: number;
  readonly actualArity: number;
  readonly functionName: string;

  constructor(expected: number, actual: number, name: string) {
    super(0, "", "");
    this.expectedArity = expected;
    this.actualArity = actual;
    this.functionName = name;
    this.expression = null;
    this.updateMessage();
  }

  protected pluralize(word: string, count: number): string {
    return count === 1 ? word : `${word}s`;
  }

  protected override formatMessage(): string {
    return `Expected ${this.expectedArity} ${this.pluralize("argument", this.expectedArity)} for function ${this.functionName}(), received ${this.actualArity}`;
  }
}

export class VariadictArityError extends ArityError {
  override readonly pythonName = "VariadictArityError";

  protected override formatMessage(): string {
    return `Expected at least ${this.expectedArity} ${this.pluralize("argument", this.expectedArity)} for function ${this.functionName}(), received ${this.actualArity}`;
  }
}

export class JMESPathTypeError extends JMESPathError {
  override readonly pythonName = "JMESPathTypeError";
  readonly functionName: string;
  readonly currentValue: unknown;
  readonly actualType: string;
  readonly expectedTypes: readonly string[];

  constructor(
    functionName: string,
    currentValue: unknown,
    actualType: string,
    expectedTypes: readonly string[],
  ) {
    const expected = `[${expectedTypes.map((t) => `'${t}'`).join(", ")}]`;
    super(
      `In function ${functionName}(), invalid type for value: ${pyStr(currentValue)}, expected one of: ${expected}, received: "${actualType}"`,
    );
    this.functionName = functionName;
    this.currentValue = currentValue;
    this.actualType = actualType;
    this.expectedTypes = expectedTypes;
  }
}

export class EmptyExpressionError extends JMESPathError {
  override readonly pythonName = "EmptyExpressionError";

  constructor() {
    super("Invalid JMESPath expression: cannot be empty.");
  }
}

export class UnknownFunctionError extends JMESPathError {
  override readonly pythonName = "UnknownFunctionError";

  constructor(message: string) {
    super(message);
  }
}

class JMESPathValueError extends JMESPathError {
  override readonly pythonName = "ValueError";
}

// --- Lexer -----------------------------------------------------------------------------

type Token = {
  type: string;
  value: unknown;
  start: number;
  end: number;
};

const SIMPLE_TOKENS: Record<string, string> = {
  ".": "dot",
  "*": "star",
  "]": "rbracket",
  ",": "comma",
  ":": "colon",
  "@": "current",
  "(": "lparen",
  ")": "rparen",
  "{": "lbrace",
  "}": "rbrace",
};

const isStartIdentifier = (ch: string | null): boolean =>
  ch !== null &&
  ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_");

const isValidIdentifier = (ch: string | null): boolean =>
  isStartIdentifier(ch) || (ch !== null && ch >= "0" && ch <= "9");

const isDigit = (ch: string | null): boolean =>
  ch !== null && ch >= "0" && ch <= "9";

const isWhitespace = (ch: string | null): boolean =>
  ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

class Lexer {
  private position = 0;
  private expression = "";
  private chars: string[] = [];
  private current: string | null = null;
  private length = 0;

  tokenize(expression: string): Token[] {
    if (!expression) throw new EmptyExpressionError();
    this.position = 0;
    this.expression = expression;
    this.chars = [...expression];
    this.length = this.chars.length;
    this.current = this.chars[0] ?? null;

    const tokens: Token[] = [];
    while (this.current !== null) {
      const ch = this.current;
      const simple = SIMPLE_TOKENS[ch];
      if (simple !== undefined) {
        tokens.push({
          type: simple,
          value: ch,
          start: this.position,
          end: this.position + 1,
        });
        this.next();
      } else if (isStartIdentifier(ch)) {
        const start = this.position;
        let buff = ch;
        while (isValidIdentifier(this.next())) buff += this.current!;
        tokens.push({
          type: "unquoted_identifier",
          value: buff,
          start,
          end: start + buff.length,
        });
      } else if (isWhitespace(ch)) {
        this.next();
      } else if (ch === "[") {
        const start = this.position;
        const nextChar = this.next();
        if (nextChar === "]") {
          this.next();
          tokens.push({ type: "flatten", value: "[]", start, end: start + 2 });
        } else if (nextChar === "?") {
          this.next();
          tokens.push({ type: "filter", value: "[?", start, end: start + 2 });
        } else {
          tokens.push({ type: "lbracket", value: "[", start, end: start + 1 });
        }
      } else if (ch === "'") {
        tokens.push(this.consumeRawStringLiteral());
      } else if (ch === "|") {
        tokens.push(this.matchOrElse("|", "or", "pipe"));
      } else if (ch === "&") {
        tokens.push(this.matchOrElse("&", "and", "expref"));
      } else if (ch === "`") {
        tokens.push(this.consumeLiteral());
      } else if (isDigit(ch)) {
        const start = this.position;
        const buff = this.consumeNumber();
        tokens.push({
          type: "number",
          value: Number.parseInt(buff, 10),
          start,
          end: start + buff.length,
        });
      } else if (ch === "-") {
        const start = this.position;
        const buff = this.consumeNumber();
        if (buff.length > 1) {
          tokens.push({
            type: "number",
            value: Number.parseInt(buff, 10),
            start,
            end: start + buff.length,
          });
        } else {
          throw new LexerError(start, buff, `Unknown token '${buff}'`);
        }
      } else if (ch === '"') {
        tokens.push(this.consumeQuotedIdentifier());
      } else if (ch === "<") {
        tokens.push(this.matchOrElse("=", "lte", "lt"));
      } else if (ch === ">") {
        tokens.push(this.matchOrElse("=", "gte", "gt"));
      } else if (ch === "!") {
        tokens.push(this.matchOrElse("=", "ne", "not"));
      } else if (ch === "=") {
        if (this.next() === "=") {
          tokens.push({
            type: "eq",
            value: "==",
            start: this.position - 1,
            end: this.position,
          });
          this.next();
        } else {
          const pos = this.current === null ? this.position : this.position - 1;
          throw new LexerError(pos, "=", "Unknown token '='");
        }
      } else {
        throw new LexerError(this.position, ch, `Unknown token ${ch}`);
      }
    }
    tokens.push({
      type: "eof",
      value: "",
      start: this.length,
      end: this.length,
    });
    return tokens;
  }

  private next(): string | null {
    if (this.position === this.length - 1) {
      this.current = null;
    } else {
      this.position += 1;
      this.current = this.chars[this.position] ?? null;
    }
    return this.current;
  }

  private consumeNumber(): string {
    let buff = this.current!;
    while (isDigit(this.next())) buff += this.current!;
    return buff;
  }

  private consumeUntil(delimiter: string): string {
    const start = this.position;
    let buff = "";
    this.next();
    while (this.current !== delimiter) {
      if (this.current === "\\") {
        buff += "\\";
        this.next();
      }
      if (this.current === null) {
        throw new LexerError(
          start,
          this.chars.slice(start).join(""),
          `Unclosed ${delimiter} delimiter`,
        );
      }
      buff += this.current;
      this.next();
    }
    this.next();
    return buff;
  }

  private consumeLiteral(): Token {
    const start = this.position;
    const lexeme = this.consumeUntil("`").replaceAll("\\`", "`");
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(lexeme);
    } catch {
      try {
        parsedJson = JSON.parse(`"${lexeme.trimStart()}"`);
      } catch {
        throw new LexerError(
          start,
          this.chars.slice(start).join(""),
          `Bad token ${lexeme}`,
        );
      }
    }
    return {
      type: "literal",
      value: parsedJson,
      start,
      end: this.position - start,
    };
  }

  private consumeQuotedIdentifier(): Token {
    const start = this.position;
    const lexeme = `"${this.consumeUntil('"')}"`;
    try {
      return {
        type: "quoted_identifier",
        value: JSON.parse(lexeme),
        start,
        end: this.position - start,
      };
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).split(":")[0]!;
      throw new LexerError(start, lexeme, msg);
    }
  }

  private consumeRawStringLiteral(): Token {
    const start = this.position;
    const lexeme = this.consumeUntil("'").replaceAll("\\'", "'");
    return {
      type: "literal",
      value: lexeme,
      start,
      end: this.position - start,
    };
  }

  private matchOrElse(
    expected: string,
    matchType: string,
    elseType: string,
  ): Token {
    const start = this.position;
    const current = this.current!;
    const nextChar = this.next();
    if (nextChar === expected) {
      this.next();
      return {
        type: matchType,
        value: current + nextChar,
        start,
        end: start + 1,
      };
    }
    return { type: elseType, value: current, start, end: start };
  }
}

// --- AST -------------------------------------------------------------------------------

type AstNode =
  | { type: "identity"; children: [] }
  | { type: "current"; children: [] }
  | { type: "field"; value: string; children: [] }
  | { type: "literal"; value: unknown; children: [] }
  | { type: "index"; value: number; children: [] }
  | { type: "slice"; children: [number | null, number | null, number | null] }
  | { type: "subexpression"; children: AstNode[] }
  | { type: "index_expression"; children: AstNode[] }
  | { type: "pipe"; children: [AstNode, AstNode] }
  | { type: "or_expression"; children: [AstNode, AstNode] }
  | { type: "and_expression"; children: [AstNode, AstNode] }
  | { type: "not_expression"; children: [AstNode] }
  | { type: "expref"; children: [AstNode] }
  | { type: "flatten"; children: [AstNode] }
  | { type: "projection"; children: [AstNode, AstNode] }
  | { type: "value_projection"; children: [AstNode, AstNode] }
  | { type: "filter_projection"; children: [AstNode, AstNode, AstNode] }
  | { type: "comparator"; value: string; children: [AstNode, AstNode] }
  | { type: "function_expression"; value: string; children: AstNode[] }
  | { type: "key_val_pair"; value: string; children: [AstNode] }
  | { type: "multi_select_dict"; children: AstNode[] }
  | { type: "multi_select_list"; children: AstNode[] };

// --- Parser ----------------------------------------------------------------------------

const BINDING_POWER: Record<string, number> = {
  eof: 0,
  unquoted_identifier: 0,
  quoted_identifier: 0,
  literal: 0,
  rbracket: 0,
  rparen: 0,
  comma: 0,
  rbrace: 0,
  number: 0,
  current: 0,
  expref: 0,
  colon: 0,
  pipe: 1,
  or: 2,
  and: 3,
  eq: 5,
  gt: 5,
  lt: 5,
  gte: 5,
  lte: 5,
  ne: 5,
  flatten: 9,
  star: 20,
  filter: 21,
  dot: 40,
  not: 45,
  lbrace: 50,
  lbracket: 55,
  lparen: 60,
};

const PROJECTION_STOP = 10;
const PARSE_CACHE = new Map<string, CompiledExpression>();
const PARSE_CACHE_MAX = 128;

class Parser {
  private tokens: Token[] = [];
  private index = 0;

  parse(expression: string): CompiledExpression {
    const cached = PARSE_CACHE.get(expression);
    if (cached !== undefined) return cached;
    const parsed = this.doParse(expression);
    if (PARSE_CACHE.size >= PARSE_CACHE_MAX) PARSE_CACHE.clear();
    PARSE_CACHE.set(expression, parsed);
    return parsed;
  }

  private doParse(expression: string): CompiledExpression {
    try {
      return this.parseExpression(expression);
    } catch (e) {
      if (e instanceof LexerError) {
        e.setExpression(expression);
        throw e;
      }
      if (e instanceof IncompleteExpressionError) {
        e.setExpression(expression);
        throw e;
      }
      if (e instanceof ParseError) {
        e.setExpression(expression);
        throw e;
      }
      throw e;
    }
  }

  private parseExpression(expression: string): CompiledExpression {
    this.tokens = new Lexer().tokenize(expression);
    this.index = 0;
    const parsed = this.expression(0);
    if (this.currentToken() !== "eof") {
      const t = this.lookaheadToken(0);
      throw new ParseError(
        t.start,
        t.value,
        t.type,
        `Unexpected token: ${pyStr(t.value)}`,
      );
    }
    return new CompiledExpression(expression, parsed);
  }

  private expression(bindingPower = 0): AstNode {
    const leftToken = this.lookaheadToken(0);
    this.advance();
    let left = this.nud(leftToken);
    let curr = this.currentToken();
    while (bindingPower < (BINDING_POWER[curr] ?? 0)) {
      const ledFn = this.getLed(curr);
      if (!ledFn) {
        this.errorLedToken(this.lookaheadToken(0));
      } else {
        this.advance();
        left = ledFn(left);
        curr = this.currentToken();
      }
    }
    return left;
  }

  private nud(token: Token): AstNode {
    switch (token.type) {
      case "literal":
        return { type: "literal", value: token.value, children: [] };
      case "unquoted_identifier":
        return { type: "field", value: token.value as string, children: [] };
      case "quoted_identifier": {
        const field: AstNode = {
          type: "field",
          value: token.value as string,
          children: [],
        };
        if (this.currentToken() === "lparen") {
          const t = this.lookaheadToken(0);
          throw new ParseError(
            0,
            t.value,
            t.type,
            "Quoted identifier not allowed for function names.",
          );
        }
        return field;
      }
      case "star": {
        const left: AstNode = { type: "identity", children: [] };
        const right: AstNode =
          this.currentToken() === "rbracket"
            ? { type: "identity", children: [] }
            : this.parseProjectionRhs(BINDING_POWER.star!);
        return { type: "value_projection", children: [left, right] };
      }
      case "filter":
        return this.ledFilter({ type: "identity", children: [] });
      case "lbrace":
        return this.parseMultiSelectHash();
      case "lparen": {
        const expr = this.expression();
        this.match("rparen");
        return expr;
      }
      case "flatten": {
        const left: AstNode = {
          type: "flatten",
          children: [{ type: "identity", children: [] }],
        };
        const right = this.parseProjectionRhs(BINDING_POWER.flatten!);
        return { type: "projection", children: [left, right] };
      }
      case "not": {
        const expr = this.expression(BINDING_POWER.not!);
        return { type: "not_expression", children: [expr] };
      }
      case "lbracket": {
        const curr = this.currentToken();
        if (curr === "number" || curr === "colon") {
          const right = this.parseIndexExpression();
          return this.projectIfSlice({ type: "identity", children: [] }, right);
        }
        if (curr === "star" && this.lookahead(1) === "rbracket") {
          this.advance();
          this.advance();
          const right = this.parseProjectionRhs(BINDING_POWER.star!);
          return {
            type: "projection",
            children: [{ type: "identity", children: [] }, right],
          };
        }
        return this.parseMultiSelectList();
      }
      case "current":
        return { type: "current", children: [] };
      case "expref": {
        const expr = this.expression(BINDING_POWER.expref!);
        return { type: "expref", children: [expr] };
      }
      default:
        return this.errorNudToken(token);
    }
  }

  private getLed(tokenType: string): ((left: AstNode) => AstNode) | null {
    switch (tokenType) {
      case "dot":
        return (left) => this.ledDot(left);
      case "pipe":
        return (left) => ({
          type: "pipe",
          children: [left, this.expression(BINDING_POWER.pipe!)],
        });
      case "or":
        return (left) => ({
          type: "or_expression",
          children: [left, this.expression(BINDING_POWER.or!)],
        });
      case "and":
        return (left) => ({
          type: "and_expression",
          children: [left, this.expression(BINDING_POWER.and!)],
        });
      case "lparen":
        return (left) => this.ledLparen(left);
      case "filter":
        return (left) => this.ledFilter(left);
      case "eq":
      case "ne":
      case "gt":
      case "gte":
      case "lt":
      case "lte":
        return (left) => ({
          type: "comparator",
          value: tokenType,
          children: [left, this.expression(BINDING_POWER[tokenType]!)],
        });
      case "flatten":
        return (left) => ({
          type: "projection",
          children: [
            { type: "flatten", children: [left] },
            this.parseProjectionRhs(BINDING_POWER.flatten!),
          ],
        });
      case "lbracket":
        return (left) => this.ledLbracket(left);
      default:
        return null;
    }
  }

  private ledDot(left: AstNode): AstNode {
    if (this.currentToken() !== "star") {
      const right = this.parseDotRhs(BINDING_POWER.dot!);
      if (left.type === "subexpression") {
        left.children.push(right);
        return left;
      }
      return { type: "subexpression", children: [left, right] };
    }
    this.advance();
    const right = this.parseProjectionRhs(BINDING_POWER.dot!);
    return { type: "value_projection", children: [left, right] };
  }

  private ledLparen(left: AstNode): AstNode {
    if (left.type !== "field") {
      const prev = this.lookaheadToken(-2);
      throw new ParseError(
        prev.start,
        prev.value,
        prev.type,
        `Invalid function name '${pyStr(prev.value)}'`,
      );
    }
    const name = left.value;
    const args: AstNode[] = [];
    while (this.currentToken() !== "rparen") {
      const expr = this.expression();
      if (this.currentToken() === "comma") this.match("comma");
      args.push(expr);
    }
    this.match("rparen");
    return { type: "function_expression", value: name, children: args };
  }

  private ledFilter(left: AstNode): AstNode {
    const condition = this.expression(0);
    this.match("rbracket");
    const right: AstNode =
      this.currentToken() === "flatten"
        ? { type: "identity", children: [] }
        : this.parseProjectionRhs(BINDING_POWER.filter!);
    return { type: "filter_projection", children: [left, right, condition] };
  }

  private ledLbracket(left: AstNode): AstNode {
    const token = this.lookaheadToken(0);
    if (token.type === "number" || token.type === "colon") {
      const right = this.parseIndexExpression();
      if (left.type === "index_expression") {
        left.children.push(right);
        return left;
      }
      return this.projectIfSlice(left, right);
    }
    this.match("star");
    this.match("rbracket");
    const right = this.parseProjectionRhs(BINDING_POWER.star!);
    return { type: "projection", children: [left, right] };
  }

  private parseIndexExpression(): AstNode {
    if (this.lookahead(0) === "colon" || this.lookahead(1) === "colon") {
      return this.parseSliceExpression();
    }
    const node: AstNode = {
      type: "index",
      value: this.lookaheadToken(0).value as number,
      children: [],
    };
    this.advance();
    this.match("rbracket");
    return node;
  }

  private parseSliceExpression(): AstNode {
    const parts: [number | null, number | null, number | null] = [
      null,
      null,
      null,
    ];
    let idx = 0;
    let curr = this.currentToken();
    while (curr !== "rbracket" && idx < 3) {
      if (curr === "colon") {
        idx += 1;
        if (idx === 3) {
          this.raiseParseErrorForToken(this.lookaheadToken(0), "syntax error");
        }
        this.advance();
      } else if (curr === "number") {
        parts[idx] = this.lookaheadToken(0).value as number;
        this.advance();
      } else {
        this.raiseParseErrorForToken(this.lookaheadToken(0), "syntax error");
      }
      curr = this.currentToken();
    }
    this.match("rbracket");
    return { type: "slice", children: parts };
  }

  private projectIfSlice(left: AstNode, right: AstNode): AstNode {
    const indexExpr: AstNode = {
      type: "index_expression",
      children: [left, right],
    };
    if (right.type === "slice") {
      return {
        type: "projection",
        children: [indexExpr, this.parseProjectionRhs(BINDING_POWER.star!)],
      };
    }
    return indexExpr;
  }

  private parseMultiSelectList(): AstNode {
    const expressions: AstNode[] = [];
    while (true) {
      expressions.push(this.expression());
      if (this.currentToken() === "rbracket") break;
      this.match("comma");
    }
    this.match("rbracket");
    return { type: "multi_select_list", children: expressions };
  }

  private parseMultiSelectHash(): AstNode {
    const pairs: AstNode[] = [];
    while (true) {
      const keyToken = this.lookaheadToken(0);
      this.matchMultipleTokens(["quoted_identifier", "unquoted_identifier"]);
      const keyName = keyToken.value as string;
      this.match("colon");
      const value = this.expression(0);
      pairs.push({ type: "key_val_pair", value: keyName, children: [value] });
      if (this.currentToken() === "comma") {
        this.match("comma");
      } else if (this.currentToken() === "rbrace") {
        this.match("rbrace");
        break;
      }
    }
    return { type: "multi_select_dict", children: pairs };
  }

  private parseProjectionRhs(bindingPower: number): AstNode {
    const curr = this.currentToken();
    if ((BINDING_POWER[curr] ?? 0) < PROJECTION_STOP) {
      return { type: "identity", children: [] };
    }
    if (curr === "lbracket" || curr === "filter") {
      return this.expression(bindingPower);
    }
    if (curr === "dot") {
      this.match("dot");
      return this.parseDotRhs(bindingPower);
    }
    this.raiseParseErrorForToken(this.lookaheadToken(0), "syntax error");
  }

  private parseDotRhs(bindingPower: number): AstNode {
    const lookahead = this.currentToken();
    if (
      lookahead === "quoted_identifier" ||
      lookahead === "unquoted_identifier" ||
      lookahead === "star"
    ) {
      return this.expression(bindingPower);
    }
    if (lookahead === "lbracket") {
      this.match("lbracket");
      return this.parseMultiSelectList();
    }
    if (lookahead === "lbrace") {
      this.match("lbrace");
      return this.parseMultiSelectHash();
    }
    const t = this.lookaheadToken(0);
    const allowed =
      "['quoted_identifier', 'unquoted_identifier', 'lbracket', 'lbrace']";
    this.raiseParseErrorForToken(t, `Expecting: ${allowed}, got: ${t.type}`);
  }

  private errorNudToken(token: Token): never {
    if (token.type === "eof") {
      throw new IncompleteExpressionError(token.start, token.value, token.type);
    }
    this.raiseParseErrorForToken(token, "invalid token");
  }

  private errorLedToken(token: Token): never {
    this.raiseParseErrorForToken(token, "invalid token");
  }

  private match(tokenType: string): void {
    if (this.currentToken() === tokenType) {
      this.advance();
    } else {
      this.raiseParseErrorMaybeEof(tokenType, this.lookaheadToken(0));
    }
  }

  private matchMultipleTokens(tokenTypes: readonly string[]): void {
    if (!tokenTypes.includes(this.currentToken())) {
      const formatted = `[${tokenTypes.map((t) => `'${t}'`).join(", ")}]`;
      this.raiseParseErrorMaybeEof(formatted, this.lookaheadToken(0));
    }
    this.advance();
  }

  private advance(): void {
    this.index += 1;
  }

  private currentToken(): string {
    return this.tokens[this.index]!.type;
  }

  private lookahead(offset: number): string {
    return this.tokens[this.index + offset]!.type;
  }

  private lookaheadToken(offset: number): Token {
    return this.tokens[this.index + offset]!;
  }

  private raiseParseErrorForToken(token: Token, reason: string): never {
    throw new ParseError(token.start, token.value, token.type, reason);
  }

  private raiseParseErrorMaybeEof(expectedType: string, token: Token): never {
    if (token.type === "eof") {
      throw new IncompleteExpressionError(token.start, token.value, token.type);
    }
    throw new ParseError(
      token.start,
      token.value,
      token.type,
      `Expecting: ${expectedType}, got: ${token.type}`,
    );
  }
}

// --- Evaluator & Standard Functions ----------------------------------------------------

class ExpressionRef {
  constructor(
    readonly expression: AstNode,
    private readonly interpreter: TreeInterpreter,
  ) {}

  visit(value: unknown): unknown {
    return this.interpreter.visit(this.expression, value);
  }
}

const pyTypeName = (v: unknown): string => {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  if (v instanceof ExpressionRef) return "_Expression";
  return "dict";
};

const TYPES_MAP: Record<string, string> = {
  bool: "boolean",
  list: "array",
  dict: "object",
  NoneType: "null",
  str: "string",
  float: "number",
  int: "number",
  _Expression: "expref",
};

const REVERSE_TYPES_MAP: Record<string, readonly string[]> = {
  boolean: ["bool"],
  array: ["list"],
  object: ["dict"],
  null: ["NoneType"],
  string: ["str"],
  number: ["float", "int"],
  expref: ["_Expression"],
};

const toJmespathType = (pyType: string): string =>
  TYPES_MAP[pyType] ?? "unknown";

function jmesEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) {
    return (a === null || a === undefined) && (b === null || b === undefined);
  }
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false;
    for (let i = 0; i < a.length; i++) {
      if (!jmesEquals(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.hasOwn(b as object, k)) return false;
      if (
        !jmesEquals(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        )
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}

const isJmesFalse = (v: unknown): boolean => {
  if (v === "" || v === false || v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isPlainObject(v)) return Object.keys(v).length === 0;
  return false;
};

const compareValues = (a: number | string, b: number | string): number =>
  a < b ? -1 : a > b ? 1 : 0;

function pythonSlice(
  arr: readonly unknown[],
  start: number | null,
  stop: number | null,
  step: number | null,
): unknown[] {
  const s = step ?? 1;
  if (s === 0) throw new JMESPathValueError("slice step cannot be zero");
  const len = arr.length;
  const out: unknown[] = [];
  if (s > 0) {
    let i =
      start === null
        ? 0
        : start < 0
          ? Math.max(0, len + start)
          : Math.min(len, start);
    const end =
      stop === null
        ? len
        : stop < 0
          ? Math.max(0, len + stop)
          : Math.min(len, stop);
    for (; i < end; i += s) out.push(arr[i]);
  } else {
    let i =
      start === null
        ? len - 1
        : start < 0
          ? Math.max(-1, len + start)
          : Math.min(len - 1, start);
    const end =
      stop === null
        ? -1
        : stop < 0
          ? Math.max(-1, len + stop)
          : Math.min(len - 1, stop);
    for (; i > end; i += s) out.push(arr[i]);
  }
  return out;
}

type ArgSpec = {
  types: readonly string[];
  variadic?: boolean;
};

type FunctionEntry = {
  signature: readonly ArgSpec[];
  fn: (args: unknown[]) => unknown;
};

function validateArguments(
  args: unknown[],
  signature: readonly ArgSpec[],
  functionName: string,
): void {
  const last = signature[signature.length - 1];
  if (last?.variadic) {
    if (args.length < signature.length) {
      throw new VariadictArityError(
        signature.length,
        args.length,
        functionName,
      );
    }
  } else if (args.length !== signature.length) {
    throw new ArityError(signature.length, args.length, functionName);
  }
  for (let i = 0; i < signature.length; i++) {
    const allowed = signature[i]!.types;
    if (allowed.length > 0) {
      typeCheckSingle(args[i], allowed, functionName);
    }
  }
}

function getAllowedPyTypes(types: readonly string[]): {
  allowedTypes: string[];
  allowedSubtypes: (readonly string[])[];
} {
  const allowedTypes: string[] = [];
  const allowedSubtypes: (readonly string[])[] = [];
  for (const t of types) {
    const dash = t.indexOf("-");
    if (dash >= 0) {
      const outer = t.slice(0, dash);
      const sub = t.slice(dash + 1);
      allowedTypes.push(...REVERSE_TYPES_MAP[outer]!);
      allowedSubtypes.push(REVERSE_TYPES_MAP[sub]!);
    } else {
      allowedTypes.push(...REVERSE_TYPES_MAP[t]!);
    }
  }
  return { allowedTypes, allowedSubtypes };
}

function typeCheckSingle(
  current: unknown,
  types: readonly string[],
  functionName: string,
): void {
  const { allowedTypes, allowedSubtypes } = getAllowedPyTypes(types);
  const actualTypename = pyTypeName(current);
  if (!allowedTypes.includes(actualTypename)) {
    throw new JMESPathTypeError(
      functionName,
      current,
      toJmespathType(actualTypename),
      types,
    );
  }
  if (allowedSubtypes.length > 0) {
    subtypeCheck(current as unknown[], allowedSubtypes, types, functionName);
  }
}

function subtypeCheck(
  current: readonly unknown[],
  allowedSubtypes: readonly (readonly string[])[],
  types: readonly string[],
  functionName: string,
): void {
  if (allowedSubtypes.length === 1) {
    const allowed = allowedSubtypes[0]!;
    for (const element of current) {
      const actualTypename = pyTypeName(element);
      if (!allowed.includes(actualTypename)) {
        throw new JMESPathTypeError(
          functionName,
          element,
          actualTypename,
          types,
        );
      }
    }
  } else if (allowedSubtypes.length > 1 && current.length > 0) {
    const first = pyTypeName(current[0]);
    const allowed = allowedSubtypes.find((subs) => subs.includes(first));
    if (!allowed) {
      throw new JMESPathTypeError(functionName, current[0], first, types);
    }
    for (const element of current) {
      const actualTypename = pyTypeName(element);
      if (!allowed.includes(actualTypename)) {
        throw new JMESPathTypeError(
          functionName,
          element,
          actualTypename,
          types,
        );
      }
    }
  }
}

function createKeyFunc(
  expref: ExpressionRef,
  allowedTypes: readonly string[],
  functionName: string,
): (x: unknown) => number | string {
  return (x: unknown) => {
    const result = expref.visit(x);
    const jmesType = toJmespathType(pyTypeName(result));
    if (!allowedTypes.includes(jmesType)) {
      throw new JMESPathTypeError(functionName, result, jmesType, allowedTypes);
    }
    return result as number | string;
  };
}

const FUNCTIONS: Record<string, FunctionEntry> = {
  abs: {
    signature: [{ types: ["number"] }],
    fn: ([arg]) => Math.abs(arg as number),
  },
  avg: {
    signature: [{ types: ["array-number"] }],
    fn: ([arg]) => {
      const arr = arg as number[];
      if (arr.length === 0) return null;
      let total = 0;
      for (const n of arr) total += n;
      return total / arr.length;
    },
  },
  not_null: {
    signature: [{ types: [], variadic: true }],
    fn: (args) => {
      for (const a of args) {
        if (a !== null && a !== undefined) return a;
      }
      return null;
    },
  },
  to_array: {
    signature: [{ types: [] }],
    fn: ([arg]) => (Array.isArray(arg) ? arg : [arg]),
  },
  to_string: {
    signature: [{ types: [] }],
    fn: ([arg]) => (typeof arg === "string" ? arg : JSON.stringify(arg)),
  },
  to_number: {
    signature: [{ types: [] }],
    fn: ([arg]) => {
      if (typeof arg === "number") return arg;
      if (typeof arg !== "string") return null;
      const trimmed = arg.trim();
      if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed))
        return null;
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : null;
    },
  },
  contains: {
    signature: [{ types: ["array", "string"] }, { types: [] }],
    fn: ([subject, search]) => {
      if (typeof subject === "string") {
        return typeof search === "string" && subject.includes(search);
      }
      return (subject as unknown[]).some((item) => jmesEquals(item, search));
    },
  },
  length: {
    signature: [{ types: ["string", "array", "object"] }],
    fn: ([arg]) => {
      if (typeof arg === "string") return [...arg].length;
      if (Array.isArray(arg)) return arg.length;
      return Object.keys(arg as Record<string, unknown>).length;
    },
  },
  ends_with: {
    signature: [{ types: ["string"] }, { types: ["string"] }],
    fn: ([search, suffix]) => (search as string).endsWith(suffix as string),
  },
  starts_with: {
    signature: [{ types: ["string"] }, { types: ["string"] }],
    fn: ([search, prefix]) => (search as string).startsWith(prefix as string),
  },
  reverse: {
    signature: [{ types: ["array", "string"] }],
    fn: ([arg]) =>
      typeof arg === "string"
        ? [...arg].reverse().join("")
        : [...(arg as unknown[])].reverse(),
  },
  ceil: {
    signature: [{ types: ["number"] }],
    fn: ([arg]) => Math.ceil(arg as number),
  },
  floor: {
    signature: [{ types: ["number"] }],
    fn: ([arg]) => Math.floor(arg as number),
  },
  join: {
    signature: [{ types: ["string"] }, { types: ["array-string"] }],
    fn: ([sep, arr]) => (arr as string[]).join(sep as string),
  },
  map: {
    signature: [{ types: ["expref"] }, { types: ["array"] }],
    fn: ([expref, arr]) =>
      (arr as unknown[]).map((el) => (expref as ExpressionRef).visit(el)),
  },
  max: {
    signature: [{ types: ["array-number", "array-string"] }],
    fn: ([arg]) => {
      const arr = arg as (number | string)[];
      if (arr.length === 0) return null;
      let best = arr[0]!;
      for (let i = 1; i < arr.length; i++) {
        if (compareValues(arr[i]!, best) > 0) best = arr[i]!;
      }
      return best;
    },
  },
  merge: {
    signature: [{ types: ["object"], variadic: true }],
    fn: (args) => {
      const merged: Record<string, unknown> = {};
      for (const a of args) {
        Object.assign(merged, a as Record<string, unknown>);
      }
      return merged;
    },
  },
  min: {
    signature: [{ types: ["array-number", "array-string"] }],
    fn: ([arg]) => {
      const arr = arg as (number | string)[];
      if (arr.length === 0) return null;
      let best = arr[0]!;
      for (let i = 1; i < arr.length; i++) {
        if (compareValues(arr[i]!, best) < 0) best = arr[i]!;
      }
      return best;
    },
  },
  sort: {
    signature: [{ types: ["array-string", "array-number"] }],
    fn: ([arg]) => [...(arg as (number | string)[])].sort(compareValues),
  },
  sum: {
    signature: [{ types: ["array-number"] }],
    fn: ([arg]) => {
      let total = 0;
      for (const n of arg as number[]) total += n;
      return total;
    },
  },
  keys: {
    signature: [{ types: ["object"] }],
    fn: ([arg]) => Object.keys(arg as Record<string, unknown>),
  },
  values: {
    signature: [{ types: ["object"] }],
    fn: ([arg]) => Object.values(arg as Record<string, unknown>),
  },
  type: {
    signature: [{ types: [] }],
    fn: ([arg]) => toJmespathType(pyTypeName(arg)),
  },
  sort_by: {
    signature: [{ types: ["array"] }, { types: ["expref"] }],
    fn: ([arrArg, exprefArg]) => {
      const arr = arrArg as unknown[];
      const expref = exprefArg as ExpressionRef;
      if (arr.length === 0) return arr;
      const requiredType = toJmespathType(pyTypeName(expref.visit(arr[0])));
      if (requiredType !== "number" && requiredType !== "string") {
        throw new JMESPathTypeError("sort_by", arr[0], requiredType, [
          "string",
          "number",
        ]);
      }
      const keyFunc = createKeyFunc(expref, [requiredType], "sort_by");
      const decorated = arr.map((item) => ({ key: keyFunc(item), item }));
      decorated.sort((a, b) => compareValues(a.key, b.key));
      return decorated.map((d) => d.item);
    },
  },
  min_by: {
    signature: [{ types: ["array"] }, { types: ["expref"] }],
    fn: ([arrArg, exprefArg]) => {
      const arr = arrArg as unknown[];
      const expref = exprefArg as ExpressionRef;
      const keyFunc = createKeyFunc(expref, ["number", "string"], "min_by");
      if (arr.length === 0) return null;
      let bestItem = arr[0];
      let bestKey = keyFunc(arr[0]);
      for (let i = 1; i < arr.length; i++) {
        const key = keyFunc(arr[i]);
        if (compareValues(key, bestKey) < 0) {
          bestKey = key;
          bestItem = arr[i];
        }
      }
      return bestItem;
    },
  },
  max_by: {
    signature: [{ types: ["array"] }, { types: ["expref"] }],
    fn: ([arrArg, exprefArg]) => {
      const arr = arrArg as unknown[];
      const expref = exprefArg as ExpressionRef;
      const keyFunc = createKeyFunc(expref, ["number", "string"], "max_by");
      if (arr.length === 0) return null;
      let bestItem = arr[0];
      let bestKey = keyFunc(arr[0]);
      for (let i = 1; i < arr.length; i++) {
        const key = keyFunc(arr[i]);
        if (compareValues(key, bestKey) > 0) {
          bestKey = key;
          bestItem = arr[i];
        }
      }
      return bestItem;
    },
  },
};

class TreeInterpreter {
  visit(node: AstNode, value: unknown): unknown {
    switch (node.type) {
      case "subexpression": {
        let result = value;
        for (const child of node.children) result = this.visit(child, result);
        return result;
      }
      case "field": {
        if (!isPlainObject(value) || !Object.hasOwn(value, node.value))
          return null;
        const v = value[node.value];
        return v === undefined ? null : v;
      }
      case "comparator": {
        const left = this.visit(node.children[0], value);
        const right = this.visit(node.children[1], value);
        if (node.value === "eq") return jmesEquals(left, right);
        if (node.value === "ne") return !jmesEquals(left, right);
        const comparable =
          (typeof left === "number" && typeof right === "number") ||
          (typeof left === "string" && typeof right === "string");
        if (!comparable) return null;
        if (node.value === "lt") return left < right;
        if (node.value === "gt") return left > right;
        if (node.value === "lte") return left <= right;
        return left >= right;
      }
      case "current":
      case "identity":
        return value;
      case "expref":
        return new ExpressionRef(node.children[0], this);
      case "function_expression": {
        const resolved = node.children.map((child) => this.visit(child, value));
        const entry = FUNCTIONS[node.value];
        if (!entry) {
          throw new UnknownFunctionError(`Unknown function: ${node.value}()`);
        }
        validateArguments(resolved, entry.signature, node.value);
        return entry.fn(resolved);
      }
      case "filter_projection": {
        const base = this.visit(node.children[0], value);
        if (!Array.isArray(base)) return null;
        const collected: unknown[] = [];
        for (const el of base) {
          if (!isJmesFalse(this.visit(node.children[2], el))) {
            const current = this.visit(node.children[1], el);
            if (current !== null && current !== undefined)
              collected.push(current);
          }
        }
        return collected;
      }
      case "flatten": {
        const base = this.visit(node.children[0], value);
        if (!Array.isArray(base)) return null;
        const merged: unknown[] = [];
        for (const el of base) {
          if (Array.isArray(el)) merged.push(...el);
          else merged.push(el);
        }
        return merged;
      }
      case "index": {
        if (!Array.isArray(value)) return null;
        const idx = node.value < 0 ? value.length + node.value : node.value;
        if (idx < 0 || idx >= value.length) return null;
        const v = value[idx];
        return v === undefined ? null : v;
      }
      case "index_expression": {
        let result = value;
        for (const child of node.children) result = this.visit(child, result);
        return result;
      }
      case "slice": {
        if (!Array.isArray(value)) return null;
        return pythonSlice(
          value,
          node.children[0],
          node.children[1],
          node.children[2],
        );
      }
      case "key_val_pair":
        return this.visit(node.children[0], value);
      case "literal":
        return node.value;
      case "multi_select_dict": {
        if (value === null || value === undefined) return null;
        const collected: Record<string, unknown> = {};
        for (const child of node.children) {
          if (child.type === "key_val_pair") {
            collected[child.value] = this.visit(child, value);
          }
        }
        return collected;
      }
      case "multi_select_list": {
        if (value === null || value === undefined) return null;
        return node.children.map((child) => this.visit(child, value));
      }
      case "or_expression": {
        const matched = this.visit(node.children[0], value);
        return isJmesFalse(matched)
          ? this.visit(node.children[1], value)
          : matched;
      }
      case "and_expression": {
        const matched = this.visit(node.children[0], value);
        return isJmesFalse(matched)
          ? matched
          : this.visit(node.children[1], value);
      }
      case "not_expression": {
        const orig = this.visit(node.children[0], value);
        if (typeof orig === "number" && orig === 0) return false;
        return isJmesFalse(orig);
      }
      case "pipe": {
        let result = value;
        for (const child of node.children) result = this.visit(child, result);
        return result;
      }
      case "projection": {
        const base = this.visit(node.children[0], value);
        if (!Array.isArray(base)) return null;
        const collected: unknown[] = [];
        for (const el of base) {
          const current = this.visit(node.children[1], el);
          if (current !== null && current !== undefined)
            collected.push(current);
        }
        return collected;
      }
      case "value_projection": {
        const base = this.visit(node.children[0], value);
        if (!isPlainObject(base)) return null;
        const collected: unknown[] = [];
        for (const el of Object.values(base)) {
          const current = this.visit(node.children[1], el);
          if (current !== null && current !== undefined)
            collected.push(current);
        }
        return collected;
      }
    }
  }
}

export class CompiledExpression {
  constructor(
    readonly expression: string,
    private readonly ast: AstNode,
  ) {}

  search(value: unknown): unknown {
    return new TreeInterpreter().visit(this.ast, value);
  }
}

export function compile(expression: string): CompiledExpression {
  return new Parser().parse(expression);
}

export function search(expression: string, value: unknown): unknown {
  return compile(expression).search(value);
}
