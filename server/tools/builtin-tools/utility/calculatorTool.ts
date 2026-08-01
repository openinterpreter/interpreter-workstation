import type { BuiltinToolDefinition } from '../../builtinTools';

/**
 * Safe expression evaluator — no eval(), no Function(), no bash.
 * Supports: +, -, *, /, %, ^, parentheses, and common math functions.
 */
function evaluate(expr: string): number {
  const tokens = tokenize(expr);
  const result = parseExpression(tokens, { pos: 0 });
  if (tokens.length > 0) {
    throw new Error(`Unexpected token: ${tokens[0]}`);
  }
  return result;
}

type Token = { type: 'number'; value: number }
  | { type: 'op'; value: string }
  | { type: 'paren'; value: '(' | ')' }
  | { type: 'func'; value: string }
  | { type: 'comma' };

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];

    // Whitespace
    if (/\s/.test(ch)) { i++; continue; }

    // Number (integer or decimal)
    if (/[0-9.]/.test(ch)) {
      let num = '';
      while (i < expr.length && /[0-9.eE]/.test(expr[i])) {
        num += expr[i++];
      }
      tokens.push({ type: 'number', value: parseFloat(num) });
      continue;
    }

    // Operators
    if ('+-*/%^'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }

    // Parentheses
    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch });
      i++;
      continue;
    }

    // Comma (function argument separator)
    if (ch === ',') {
      tokens.push({ type: 'comma' });
      i++;
      continue;
    }

    // Function names or constants
    if (/[a-zA-Z_]/.test(ch)) {
      let name = '';
      while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i])) {
        name += expr[i++];
      }
      const lower = name.toLowerCase();
      // Constants
      if (lower === 'pi') { tokens.push({ type: 'number', value: Math.PI }); continue; }
      if (lower === 'e' && (i >= expr.length || expr[i] !== '(')) {
        tokens.push({ type: 'number', value: Math.E }); continue;
      }
      // Functions
      tokens.push({ type: 'func', value: lower });
      continue;
    }

    throw new Error(`Unexpected character: '${ch}'`);
  }
  return tokens;
}

function parseExpression(tokens: Token[], ctx: { pos: number }): number {
  let left = parseTerm(tokens, ctx);
  while (tokens.length > 0 && tokens[0].type === 'op' && (tokens[0].value === '+' || tokens[0].value === '-')) {
    const opToken = tokens.shift();
    if (!opToken || opToken.type !== 'op') throw new Error('Expected operator');
    const op = opToken.value;
    const right = parseTerm(tokens, ctx);
    left = op === '+' ? left + right : left - right;
  }
  return left;
}

function parseTerm(tokens: Token[], ctx: { pos: number }): number {
  let left = parseUnary(tokens, ctx);
  while (tokens.length > 0 && tokens[0].type === 'op' && ('*/%'.includes(tokens[0].value))) {
    const opToken = tokens.shift();
    if (!opToken || opToken.type !== 'op') throw new Error('Expected operator');
    const op = opToken.value;
    const right = parseUnary(tokens, ctx);
    if (op === '*') left = left * right;
    else if (op === '/') { if (right === 0) throw new Error('Division by zero'); left = left / right; }
    else left = left % right;
  }
  return left;
}

function parseUnary(tokens: Token[], ctx: { pos: number }): number {
  if (tokens.length > 0 && tokens[0].type === 'op' && tokens[0].value === '-') {
    tokens.shift();
    return -parsePower(tokens, ctx);
  }
  if (tokens.length > 0 && tokens[0].type === 'op' && tokens[0].value === '+') {
    tokens.shift();
  }
  return parsePower(tokens, ctx);
}

function parsePower(tokens: Token[], ctx: { pos: number }): number {
  let base = parsePrimary(tokens, ctx);
  while (tokens.length > 0 && tokens[0].type === 'op' && tokens[0].value === '^') {
    tokens.shift();
    const exp = parseUnary(tokens, ctx);
    base = Math.pow(base, exp);
  }
  return base;
}

const MATH_FUNCTIONS: Record<string, (...args: number[]) => number> = {
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  round: Math.round,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  log: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  exp: Math.exp,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
};

function parsePrimary(tokens: Token[], ctx: { pos: number }): number {
  if (tokens.length === 0) throw new Error('Unexpected end of expression');

  const token = tokens[0];
  const peekToken = (): Token | undefined => (tokens.length > 0 ? tokens[0] : undefined);

  // Function call
  if (token.type === 'func') {
    const funcName = token.value;
    tokens.shift();
    if (tokens.length === 0 || tokens[0].type !== 'paren' || tokens[0].value !== '(') {
      throw new Error(`Expected '(' after function '${funcName}'`);
    }
    tokens.shift(); // consume '('

    const args: number[] = [];
    const nextToken = peekToken();
    if (nextToken && !(nextToken.type === 'paren' && nextToken.value === ')')) {
      args.push(parseExpression(tokens, ctx));
      while (true) {
        const separator = peekToken();
        if (!separator || separator.type !== 'comma') break;
        tokens.shift(); // consume ','
        args.push(parseExpression(tokens, ctx));
      }
    }

    const closingToken = peekToken();
    if (!closingToken || closingToken.type !== 'paren' || closingToken.value !== ')') {
      throw new Error(`Expected ')' after function arguments`);
    }
    tokens.shift(); // consume ')'

    const fn = MATH_FUNCTIONS[funcName];
    if (!fn) throw new Error(`Unknown function: '${funcName}'`);
    return fn(...args);
  }

  // Number
  if (token.type === 'number') {
    tokens.shift();
    return token.value;
  }

  // Parenthesized expression
  if (token.type === 'paren' && token.value === '(') {
    tokens.shift(); // consume '('
    const result = parseExpression(tokens, ctx);
    if (tokens.length === 0 || tokens[0].type !== 'paren' || tokens[0].value !== ')') {
      throw new Error('Mismatched parentheses');
    }
    tokens.shift(); // consume ')'
    return result;
  }

  throw new Error(`Unexpected token: ${JSON.stringify(token)}`);
}

/**
 * Date math helpers
 */
function dateDiff(date1Str: string, date2Str: string): { years: number; months: number; days: number; totalDays: number } {
  const d1 = new Date(date1Str);
  const d2 = new Date(date2Str);
  if (isNaN(d1.getTime())) throw new Error(`Invalid date: '${date1Str}'`);
  if (isNaN(d2.getTime())) throw new Error(`Invalid date: '${date2Str}'`);

  const [earlier, later] = d1 < d2 ? [d1, d2] : [d2, d1];

  let years = later.getFullYear() - earlier.getFullYear();
  let months = later.getMonth() - earlier.getMonth();
  let days = later.getDate() - earlier.getDate();

  if (days < 0) {
    months--;
    const prevMonth = new Date(later.getFullYear(), later.getMonth(), 0);
    days += prevMonth.getDate();
  }
  if (months < 0) {
    years--;
    months += 12;
  }

  const totalDays = Math.round((later.getTime() - earlier.getTime()) / (1000 * 60 * 60 * 24));

  return { years, months, days, totalDays };
}


export const calculatorTool: BuiltinToolDefinition = {
  name: 'calculate',
  description: `Evaluate a math expression or calculate the difference between two dates.

IMPORTANT: Always use this tool instead of doing math in your head. Use it for:
- ANY arithmetic: addition, subtraction, multiplication, division, percentages
- Date calculations: duration between dates, days/months/years between two dates
- Financial math: salary calculations, tax withholding, per-pay-period amounts
- Unit conversions or any numeric computation

Supports: +, -, *, /, %, ^ (power), parentheses, and functions (abs, ceil, floor, round, sqrt, log, sin, cos, tan, min, max, pow, exp).
For date differences, provide date_from and date_to to get years, months, and days between them.`,
  inputSchema: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'A math expression to evaluate. Examples: "2 + 3 * 4", "sqrt(144)", "365 * 24 * 60", "(2^10) - 1". Constants: pi, e.'
      },
      date_from: {
        type: 'string',
        description: 'Start date for date difference calculation. Accepts formats like "June 2021", "2021-06-01", "March 15, 2023". Used with date_to.'
      },
      date_to: {
        type: 'string',
        description: 'End date for date difference calculation. Use "now" or "today" for the current date. Used with date_from.'
      }
    },
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
  },
  handler: async (args: Record<string, any>) => {
    try {
      // Date difference mode
      if (args.date_from && args.date_to) {
        const toDate = (args.date_to === 'now' || args.date_to === 'today')
          ? new Date().toISOString()
          : args.date_to;
        const diff = dateDiff(args.date_from, toDate);

        // Build a human-readable string
        const parts: string[] = [];
        if (diff.years > 0) parts.push(`${diff.years} year${diff.years !== 1 ? 's' : ''}`);
        if (diff.months > 0) parts.push(`${diff.months} month${diff.months !== 1 ? 's' : ''}`);
        if (diff.days > 0) parts.push(`${diff.days} day${diff.days !== 1 ? 's' : ''}`);
        const humanReadable = parts.length > 0 ? parts.join(', ') : '0 days';

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              from: args.date_from,
              to: args.date_to === 'now' || args.date_to === 'today' ? new Date().toISOString().split('T')[0] : args.date_to,
              difference: {
                years: diff.years,
                months: diff.months,
                days: diff.days,
                totalDays: diff.totalDays,
                humanReadable,
              }
            }, null, 2)
          }],
          isError: false,
        };
      }

      // Expression mode
      if (args.expression) {
        const result = evaluate(args.expression);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              expression: args.expression,
              result,
            }, null, 2)
          }],
          isError: false,
        };
      }

      return {
        content: [{ type: 'text', text: 'Provide either "expression" for math or "date_from"/"date_to" for date difference.' }],
        isError: true,
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
};
