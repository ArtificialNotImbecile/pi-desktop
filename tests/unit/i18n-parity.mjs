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
//   5. a clock formatted with the machine's locale instead of the app's
//
// A sixth -- a call site persisting an activity string that is not in the
// shared list -- is a compile error rather than a check here: the persistence
// API takes WorkingActivity, not string.
//
// It reads the sources rather than rendering anything, so it fails on the drift
// itself instead of needing a run to reach that state.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

// A clock or date formatted with undefined takes the locale of the machine,
// not the language the app is set to, which is how a Chinese UI ends up
// printing "03:45 PM". The Working page has to pass the tag explicitly.
assert.equal(localeTag("zh"), "zh-CN");
assert.equal(localeTag("en"), "en-US");
const osLocale = [...page.matchAll(/toLocale\w*\(\s*(undefined|\[\])/g)].map((match) => match[0]);
assert.deepEqual(osLocale, [], "WorkingPage must format times with localeTag(language), not the OS locale");

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
