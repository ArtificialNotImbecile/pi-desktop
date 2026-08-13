import { useLayoutEffect } from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { useJasmineNavigation } from "../../src/renderer/navigation/navigationState";
import { parseJasminePath, routeToPath, type JasmineRoute } from "../../src/renderer/navigation/routes";

describe("Jasmine navigation", () => {
  test("round-trips settings, project-thread, and right-panel routes", () => {
    const routes: JasmineRoute[] = [
      { name: "settings", section: "providers", providerId: "moonshot" },
      { name: "thread", threadId: "thread/with spaces", projectId: "project one" },
      { name: "rightPanel", threadId: "alpha", projectId: null, panel: "terminal" },
      { name: "rightPanel", threadId: "beta", projectId: "project two", panel: "context" }
    ];
    for (const route of routes) {
      const path = routeToPath(route);
      expect(parseJasminePath(path)).toEqual(route);
    }
  });

  test("push, replace, back, and forward keep the active path coherent", async () => {
    let navigation!: ReturnType<typeof useJasmineNavigation>;
    function Probe() {
      const current = useJasmineNavigation({ name: "newChat" });
      useLayoutEffect(() => {
        navigation = current;
      });
      return null;
    }
    render(<Probe />);

    await act(async () => navigation.navigate({ name: "settings", section: "providers", providerId: "deepseek" }));
    expect(navigation.path).toBe("/settings/providers/deepseek");
    await act(async () => navigation.replace({ name: "settings", section: "providers", providerId: "moonshot" }));
    expect(navigation.path).toBe("/settings/providers/moonshot");
    await act(async () => navigation.navigate({ name: "thread", threadId: "alpha" }));
    await act(async () => navigation.navigate({ name: "rightPanel", threadId: "alpha", panel: "terminal" }));
    expect(navigation.path).toBe("/chats/alpha/right-panel/terminal");
    await act(async () => navigation.goBack());
    expect(navigation.path).toBe("/chats/alpha");
    await act(async () => navigation.goForward());
    expect(navigation.path).toBe("/chats/alpha/right-panel/terminal");
  });
});
