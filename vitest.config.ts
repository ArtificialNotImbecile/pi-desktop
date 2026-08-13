import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Renderer tests run the real React components and hooks against a fake
// desktop bridge, with no Electron process. They cover the state machines that
// used to be reachable only by launching the app: message reconciliation,
// pagination, run states, and window chrome. Anything that needs real layout,
// a PTY, a clipboard, or a desktop session stays in tests/e2e.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["tests/renderer/**/*.test.tsx", "tests/renderer/**/*.test.ts"],
    environment: "jsdom",
    setupFiles: ["./tests/renderer/setup.ts"],
    restoreMocks: true,
    // jsdom has no layout engine, so a test that reaches for geometry gets
    // zeros rather than a useful failure. Keep those assertions in E2E.
    globals: false
  }
});
