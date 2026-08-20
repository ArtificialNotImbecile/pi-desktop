import assert from "node:assert/strict";
import { SpotlightShortcutManager } from "../../dist/main/main/services/spotlightShortcut.js";
import { defaultSpotlightShortcut, isGlobalShortcutAccelerator } from "../../dist/main/shared/shortcuts.js";

assert.equal(defaultSpotlightShortcut("win32"), "Control+Shift+Space");
assert.equal(defaultSpotlightShortcut("darwin"), "Command+Shift+Space");
assert.notEqual(defaultSpotlightShortcut("win32"), "Alt+Space");
assert.equal(isGlobalShortcutAccelerator("Control+Shift+J"), true);
assert.equal(isGlobalShortcutAccelerator("Shift+J"), false);
assert.equal(isGlobalShortcutAccelerator("Control++J"), false);

const blocked = new Set();
const callbacks = new Map();
const backend = {
  register(accelerator, callback) {
    if (blocked.has(accelerator) || callbacks.has(accelerator)) return false;
    callbacks.set(accelerator, callback);
    return true;
  },
  unregister(accelerator) {
    callbacks.delete(accelerator);
  },
  isRegistered(accelerator) {
    return callbacks.has(accelerator);
  }
};

let toggleCount = 0;
const manager = new SpotlightShortcutManager(backend, () => {
  toggleCount += 1;
});
const defaultShortcut = defaultSpotlightShortcut("win32");

assert.equal(manager.initialize(defaultShortcut), true);
assert.deepEqual(manager.getStatus(defaultShortcut), {
  accelerator: defaultShortcut,
  defaultAccelerator: defaultShortcut,
  registered: true
});
callbacks.get(defaultShortcut)?.();
assert.equal(toggleCount, 1);

const customShortcut = "Control+Alt+J";
const rollback = manager.replace(customShortcut);
assert.equal(backend.isRegistered(defaultShortcut), false);
assert.equal(backend.isRegistered(customShortcut), true);
assert.equal(manager.getStatus(defaultShortcut).accelerator, customShortcut);

rollback();
assert.equal(backend.isRegistered(defaultShortcut), true);
assert.equal(backend.isRegistered(customShortcut), false);
assert.equal(manager.getStatus(defaultShortcut).accelerator, defaultShortcut);

blocked.add(customShortcut);
assert.throws(() => manager.replace(customShortcut), /already in use/i);
assert.equal(backend.isRegistered(defaultShortcut), true, "a rejected replacement must preserve the active shortcut");
assert.equal(manager.getStatus(defaultShortcut).accelerator, defaultShortcut);

manager.dispose();
assert.equal(backend.isRegistered(defaultShortcut), false);

console.log("spotlight-shortcut: OK");
