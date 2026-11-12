/**
 * Static scan of templates.ts (TypeScript compiler API, no regex guessing).
 * Fails when a new piece of copy could put a value into a message without
 * going through the escaping helper:
 *   1. a template literal with ${} that isn't tagged html`` or text``;
 *   2. a read of a template's context field (c.x) outside a tagged template,
 *      other than as a condition, a comparison, size.replace or a button URL;
 *   3. string concatenation with +;
 *   4. an exported template whose context parameter isn't named c (rule 2
 *      relies on the name);
 *   5. a type cast (`as`, `<T>x`, `!`): a value forced to look like SafeHtml
 *      would still be escaped at runtime, but it hides intent from review.
 * fmtDate and money are system formatters (dates and numbers only) and are
 * exempt from rule 1.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const FILE = fileURLToPath(new URL("./templates.ts", import.meta.url));
const EXEMPT_FUNCTIONS = new Set(["fmtDate", "money"]);
const TAGS = new Set(["html", "text"]);

export function scanTemplates(source: string): string[] {
  const sf = ts.createSourceFile("templates.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const problems: string[] = [];
  const where = (n: ts.Node) => `line ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;

  const inExemptFunction = (n: ts.Node) => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isFunctionDeclaration(p) && p.name && EXEMPT_FUNCTIONS.has(p.name.text)) return true;
    }
    return false;
  };
  const isTagged = (n: ts.TaggedTemplateExpression) => ts.isIdentifier(n.tag) && TAGS.has(n.tag.text);
  const insideTag = (n: ts.Node) => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isTaggedTemplateExpression(p) && isTagged(p)) return true;
      if (ts.isFunctionLike(p)) return false;
    }
    return false;
  };

  function allowedFieldRead(n: ts.PropertyAccessExpression): boolean {
    if (insideTag(n)) return true;
    const p = n.parent;
    // c.paid ? … : …   /  if (c.x)
    if (ts.isConditionalExpression(p) && p.condition === n) return true;
    if (ts.isIfStatement(p) && p.expression === n) return true;
    // c.reason === "…"
    if (
      ts.isBinaryExpression(p) &&
      [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(p.operatorToken.kind)
    )
      return true;
    // c.size.replace("yd", " yd") — the size enum
    if (n.name.text === "size" && ts.isPropertyAccessExpression(p) && p.name.text === "replace") return true;
    // button(c.url, …) — href() validates and escapes it
    if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === "button" && p.arguments[0] === n)
      return true;
    return false;
  }

  function visit(n: ts.Node) {
    if (ts.isTemplateExpression(n)) {
      const tagged = ts.isTaggedTemplateExpression(n.parent) && isTagged(n.parent);
      if (!tagged && !inExemptFunction(n)) problems.push(`${where(n)}: untagged interpolation \`${n.getText(sf).slice(0, 60)}\``);
    }
    if (ts.isTaggedTemplateExpression(n) && !isTagged(n)) problems.push(`${where(n)}: unknown tag ${n.tag.getText(sf)}`);
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "c" && !allowedFieldRead(n)) {
      problems.push(`${where(n)}: c.${n.name.text} used outside html/text`);
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) problems.push(`${where(n)}: + concatenation`);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) problems.push(`${where(n)}: += concatenation`);
    if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isNonNullExpression(n)) {
      problems.push(`${where(n)}: type cast \`${n.getText(sf).slice(0, 60)}\``);
    }
    if (
      ts.isFunctionDeclaration(n) &&
      n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      n.parameters.length > 0 &&
      n.parameters[0].name.getText(sf) !== "c"
    ) {
      problems.push(`${where(n)}: exported template's parameter must be named c`);
    }
    ts.forEachChild(n, visit);
  }
  visit(sf);
  return problems;
}

describe("templates.ts: every interpolation goes through the escaping helper", () => {
  it("the real file has no problems", () => {
    expect(scanTemplates(readFileSync(FILE, "utf8"))).toEqual([]);
  });

  it("the scan itself catches each kind of slip", () => {
    const cases: Array<[string, string]> = [
      ["untagged", "export function a(c: {x: string}) { return `Hi ${c.x}`; }"],
      ["unknown tag", "export function a(c: {x: string}) { return raw`Hi ${c.x}`; }"],
      ["bare field in an array", 'export function a(c: {url: string}) { return [text`a`, c.url].join("\\n"); }'],
      ["field passed to a helper", "export function a(c: {x: string}) { return renderEmail(html`h`, [c.x]); }"],
      ["concatenation", 'export function a(c: {x: string}) { return text`a` + "b"; }'],
      ["parameter renamed", "export function a(ctx: {x: string}) { return `Hi ${ctx.x}`; }"],
      ["template inside a nested untagged literal", "export function a(c: {x: string}) { return text`${`${c.x}`}`; }"],
      ["cast to SafeHtml", "export function a(c: {x: string}) { return html`${c.x as never as SafeHtml}`; }"],
      ["non-null assertion", "export function a(c: {x: string | null}) { return text`${c.x!}`; }"],
    ];
    for (const [name, src] of cases) expect([name, scanTemplates(src).length > 0]).toEqual([name, true]);
  });

  it("allowed shapes pass", () => {
    const ok = [
      "export function a(c: {x: string; p: boolean}) { return c.p ? text`a ${c.x}` : html`b ${c.x}`; }",
      'export function a(c: {size: string}) { const s = c.size.replace("yd", " yd"); return text`${s}`; }',
      'export function a(c: {url: string}) { return button(c.url, html`Pay`); }',
      'export function a(c: {r: string}) { return c.r === "x" ? "y" : "z"; }',
      "function fmtDate(ymd: string) { return `${ymd}T00:00:00Z`; }",
    ];
    for (const src of ok) expect([src, scanTemplates(src)]).toEqual([src, []]);
  });
});
