// Every review round on the Working redesign found the same class of defect:
// text Jasmine owns reaching a Chinese UI in English. Each round it wore a
// different hat, so this guard covers every hat found so far rather than
// waiting for the next one to be reported.
//
//   1. a key added to one dictionary and not the other
//   2. a translation that drops an operand, including the selector of an ICU
//      plural form
//   3. an activity label main persists that the renderer never translates
//   4. user-visible copy built in main from string literals, where the
//      dictionary used to be out of reach
//   5. a clock or count formatted with the machine's locale instead of the app's
//   6. renderer-owned accessibility copy written as a JSX literal
//
// A seventh -- a call site persisting an activity string that is not in the
// shared list -- is a compile error rather than a check here: the persistence
// API takes WorkingActivity, not string.
//
// It reads the sources rather than rendering anything, so it fails on the drift
// itself instead of needing a run to reach that state.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { dictionaries, localeTag, translate } from "../../dist/main/shared/i18n.js";
import { WORKING_ACTIVITY } from "../../dist/main/shared/workingActivity.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// 1. Both languages carry the same keys.
const en = Object.keys(dictionaries.en);
const zh = Object.keys(dictionaries.zh);
assert.ok(en.length > 500, `Expected a populated dictionary, found ${en.length} keys`);
const missingZh = en.filter((key) => !(key in dictionaries.zh));
const missingEn = zh.filter((key) => !(key in dictionaries.en));
assert.deepEqual(missingZh, [], "Keys missing from the zh dictionary");
assert.deepEqual(missingEn, [], "Keys missing from the en dictionary");

// The branch words inside an ICU plural form -- {count, plural, one {message}
// other {messages}} -- are English text the translator replaces, not operands
// the other language has to keep. The selector in front of them is an operand
// though: a translation that drops every {count} renders a count with no
// number. So the form collapses to its selector rather than disappearing.
function operandsOf(template) {
  const selectorOnly = template.replace(/\{(\w+), plural,[^}]*\{[^{}]*\}[^}]*\{[^{}]*\}\}/g, "{$1}");
  return [...selectorOnly.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
}

// Every value is a non-empty string, and a template's operands survive
// translation -- a dropped {name} silently prints an empty span.
for (const [language, dictionary] of Object.entries(dictionaries)) {
  for (const [key, value] of Object.entries(dictionary)) {
    assert.equal(typeof value, "string", `${language}.${key} is not a string`);
    assert.ok(value.length > 0, `${language}.${key} is empty`);
    if (language === "en") continue;
    for (const operand of operandsOf(String(dictionaries.en[key]))) {
      assert.ok(value.includes(`{${operand}}`), `${language}.${key} dropped the {${operand}} operand`);
    }
  }
}

// 2. Every activity label main persists is translated by the Working page.
const page = await readFile(path.join(rootDir, "src/renderer/components/working/WorkingPage.tsx"), "utf8");
const mapped = new Map(
  [...page.matchAll(/\[WORKING_ACTIVITY\.(\w+)\]:\s*"([\w.]+)"/g)].map((match) => [match[1], match[2]])
);
assert.ok(mapped.size > 0, "Parsed no activity translations from WorkingPage.tsx");
// Terminal lines are deliberately replaced by the run's duration.
const shownAsDuration = new Set(["completed", "failed", "cancelled"]);
for (const name of Object.keys(WORKING_ACTIVITY)) {
  if (shownAsDuration.has(name)) {
    assert.ok(!mapped.has(name), `WORKING_ACTIVITY.${name} is shown as a duration and should not be translated`);
    continue;
  }
  assert.ok(mapped.has(name), `WORKING_ACTIVITY.${name} has no translation in WorkingPage.tsx`);
}
for (const key of [...mapped.values(), "working.activity.usingNamedTool"]) {
  assert.ok(key in dictionaries.en, `Unknown i18n key ${key}`);
}

// A clock, date or number formatted without a locale takes the locale of the
// machine, not the language the app is set to. Check the whole component tree
// so fixing one panel cannot leave the same defect in the next one.
assert.equal(localeTag("zh"), "zh-CN");
assert.equal(localeTag("en"), "en-US");
const componentDir = path.join(rootDir, "src/renderer/components");
const componentFiles = await collectFiles(componentDir, (file) => file.endsWith(".tsx"));
const osLocale = [];
const literalAttributes = [];
const literalControlNames = [];
const copyAttributes = new Set(["aria-label", "title", "placeholder"]);
const namedControlElements = new Set(["a", "button", "label", "option", "Button", "MenuItem", "summary"]);
const literalAllowlist = new Set([
  // The catalogue deliberately presents its primitive samples in one fixed
  // language so it can double as a visual/test fixture rather than app copy.
  "src/renderer/components/ui/UiCatalog.tsx"
]);

for (const file of componentFiles) {
  const sourceText = await readFile(file, "utf8");
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const relative = path.relative(rootDir, file).replaceAll("\\", "/");
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && /^toLocale(?:String|DateString|TimeString)$/.test(node.expression.name.text)) {
      const locale = node.arguments[0];
      if (usesImplicitLocale(locale)) {
        osLocale.push(`${relative}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      }
    }
    if (ts.isJsxAttribute(node) && copyAttributes.has(node.name.text) && !literalAllowlist.has(relative)) {
      const initializer = node.initializer;
      const literal = staticAttributeCopy(initializer);
      if (literal && /[A-Za-z]{2}/.test(literal)) {
        literalAttributes.push(`${relative}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${node.name.text}=${JSON.stringify(literal)}`);
      }
    }
    if (ts.isJsxElement(node) && namedControlElements.has(node.openingElement.tagName.getText(source))
      && !literalAllowlist.has(relative)) {
      const copy = [];
      for (const child of node.children) collectControlCopy(child, copy, source, namedControlElements);
      const literal = copy.join(" ").replace(/\s+/g, " ").trim();
      if (/[A-Za-z]{2}/.test(literal)) {
        literalControlNames.push(`${relative}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} control=${JSON.stringify(literal)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

assert.deepEqual(osLocale, [], "Renderer components must format with localeTag(language), not the OS locale");
assert.deepEqual(literalAttributes, [], "Renderer accessibility copy must come from i18n, not JSX literals");
assert.deepEqual(literalControlNames, [], "Renderer control names must come from i18n, not JSX child literals");

// Keep the guard honest even after the current source tree is clean. These are
// the three AST shapes that prior review rounds showed could silently escape.
const guardFixture = ts.createSourceFile(
  "i18n-guard-fixture.tsx",
  "const control = <button aria-label={`Preview ${name}`}>{active ? 'Stop' : 'Start'}</button>; const detail = <details><summary>Raw payload</summary></details>; new Date().toLocaleString(undefined);",
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
const fixtureSignals = { attribute: "", controls: [], locale: false };
const inspectFixture = (node) => {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "toLocaleString") {
    fixtureSignals.locale = usesImplicitLocale(node.arguments[0]);
  }
  if (ts.isJsxAttribute(node) && node.name.text === "aria-label") fixtureSignals.attribute = staticAttributeCopy(node.initializer);
  if (ts.isJsxElement(node) && namedControlElements.has(node.openingElement.tagName.getText(guardFixture))) {
    const copy = [];
    for (const child of node.children) collectControlCopy(child, copy, guardFixture, namedControlElements);
    fixtureSignals.controls.push(copy.join(" ").replace(/\s+/g, " ").trim());
  }
  ts.forEachChild(node, inspectFixture);
};
inspectFixture(guardFixture);
assert.deepEqual(fixtureSignals, { attribute: "Preview {…}", controls: ["Stop Start", "Raw payload"], locale: true });

// 3. The copy main puts in front of the user goes through the dictionary.
const registry = await readFile(path.join(rootDir, "src/main/services/workingRegistry.ts"), "utf8");
const copyStart = registry.indexOf("function notificationCopy(");
assert.notEqual(copyStart, -1, "Could not find notificationCopy in workingRegistry.ts");
const notificationCopy = registry.slice(copyStart, registry.indexOf("\n}", copyStart));
const literals = [...notificationCopy.matchAll(/"([^"]*[a-z]{3}[^"]*)"/g)]
  .map((match) => match[1])
  // Status names are identifiers the function branches on, and dictionary keys
  // are the point; anything else in here is copy that would ship in English.
  .filter((literal) => !literal.startsWith("working.") && !["completed", "failed", "waiting_user"].includes(literal));
assert.deepEqual(literals, [], "Notification copy must come from the dictionary, not string literals");

// And it actually renders in the selected language.
const zhTranslate = translate("zh");
assert.notEqual(
  zhTranslate("working.notification.completed"),
  dictionaries.en["working.notification.completed"],
  "Chinese notification copy still reads as English"
);
assert.ok(zhTranslate("working.notification.title", { state: "X" }).includes("X"), "Notification title dropped its state operand");

console.log(`i18n-parity: ${en.length} keys in en and zh, ${mapped.size} activity labels translated`);

async function collectFiles(directory, accept) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(target, accept);
    return accept(target) ? [target] : [];
  }));
  return nested.flat();
}

function usesImplicitLocale(locale) {
  return !locale
    || (ts.isIdentifier(locale) && locale.text === "undefined")
    || ts.isVoidExpression(locale)
    || (ts.isArrayLiteralExpression(locale) && locale.elements.length === 0);
}

function staticAttributeCopy(initializer) {
  if (initializer && ts.isStringLiteral(initializer)) return initializer.text;
  if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression) return "";
  if (ts.isStringLiteral(initializer.expression) || ts.isNoSubstitutionTemplateLiteral(initializer.expression)) {
    return initializer.expression.text;
  }
  const interpolated = [];
  const collectInterpolatedCopy = (expression) => {
    if (ts.isTemplateExpression(expression)) {
      interpolated.push([expression.head.text, ...expression.templateSpans.map((span) => span.literal.text)].join("{…}"));
    }
    ts.forEachChild(expression, collectInterpolatedCopy);
  };
  collectInterpolatedCopy(initializer.expression);
  return interpolated.join(" ");
}

function collectControlCopy(node, copy, source, namedControlElements) {
  if (ts.isJsxText(node)) {
    copy.push(node.text);
    return;
  }
  if (ts.isJsxElement(node)) {
    if (namedControlElements.has(node.openingElement.tagName.getText(source))) return;
    for (const child of node.children) collectControlCopy(child, copy, source, namedControlElements);
    return;
  }
  if (ts.isJsxFragment(node)) {
    for (const child of node.children) collectControlCopy(child, copy, source, namedControlElements);
    return;
  }
  if (!ts.isJsxExpression(node) || !node.expression) return;
  collectControlExpressionCopy(node.expression, copy, source, namedControlElements);
}

function collectControlExpressionCopy(node, copy, source, namedControlElements) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    copy.push(node.text);
    return;
  }
  if (ts.isTemplateExpression(node)) {
    copy.push(node.head.text, ...node.templateSpans.map((span) => span.literal.text));
    return;
  }
  if (ts.isConditionalExpression(node)) {
    collectControlExpressionCopy(node.whenTrue, copy, source, namedControlElements);
    collectControlExpressionCopy(node.whenFalse, copy, source, namedControlElements);
    return;
  }
  if (ts.isBinaryExpression(node)) {
    collectControlExpressionCopy(node.left, copy, source, namedControlElements);
    collectControlExpressionCopy(node.right, copy, source, namedControlElements);
    return;
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    collectControlExpressionCopy(node.expression, copy, source, namedControlElements);
    return;
  }
  if (ts.isJsxElement(node) || ts.isJsxFragment(node)) collectControlCopy(node, copy, source, namedControlElements);
}
