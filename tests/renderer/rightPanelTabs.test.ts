import { describe, expect, test } from "vitest";
import { nextTerminalTabTitle } from "../../src/renderer/components/chat/rightPanelTabs";
import type { RightPanelTab } from "../../src/renderer/navigation/routes";

function tab(id: string, title: string, mode: RightPanelTab["mode"] = "terminal"): RightPanelTab {
  return { id, title, mode };
}

describe("right-panel terminal display names", () => {
  test("reuses the first closed terminal number without counting other panel modes", () => {
    expect(nextTerminalTabTitle([])).toBe("Terminal");
    expect(nextTerminalTabTitle([tab("one", "Terminal")])).toBe("Terminal 2");
    expect(nextTerminalTabTitle([
      tab("one", "Terminal"),
      tab("three", "Terminal 3"),
      tab("artifacts", "Artifacts", "artifacts")
    ])).toBe("Terminal 2");
    expect(nextTerminalTabTitle([tab("two", "Terminal 2")])).toBe("Terminal");
  });
});
