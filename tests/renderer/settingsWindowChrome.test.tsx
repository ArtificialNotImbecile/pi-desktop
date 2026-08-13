import { describe, expect, test } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../src/renderer/i18n";
import { ProviderSettingsPanel } from "../../src/renderer/components/settings/ProviderSettingsPanel";
import { installFakeBridge } from "./fakeBridge";
import { settingsPanelProps } from "./settingsPanelProps";

/**
 * The settings "window" is a div, not an OS window: minimize, maximize, and the
 * title-bar drag are React state and clientX/clientY arithmetic
 * (ProviderSettingsPanel.tsx). None of it needs a desktop session, so it moved
 * here from the @desktop-session E2E case in tests/e2e/settings.spec.ts.
 */
function renderPanel() {
  installFakeBridge();
  const view = render(
    <I18nProvider language="en">
      <ProviderSettingsPanel {...settingsPanelProps()} />
    </I18nProvider>
  );
  const panel = view.container.querySelector(".settings-panel");
  if (!panel) throw new Error("Settings panel did not render.");
  return { ...view, panel: panel as HTMLElement };
}

function dragTitleBar(from: { x: number; y: number }, to: { x: number; y: number }) {
  const bar = document.querySelector(".settings-window-bar");
  if (!bar) throw new Error("Settings window bar did not render.");
  fireEvent.pointerDown(bar, { clientX: from.x, clientY: from.y });
  fireEvent(window, new window.PointerEvent("pointermove", { clientX: to.x, clientY: to.y }));
  fireEvent(window, new window.PointerEvent("pointerup", { clientX: to.x, clientY: to.y }));
}

describe("settings window chrome", () => {
  test("the title bar drags the panel to a new position", () => {
    const { panel } = renderPanel();
    const before = { left: panel.style.left, top: panel.style.top };

    dragTitleBar({ x: 80, y: 12 }, { x: 160, y: 58 });

    expect(Math.abs(parseInt(panel.style.left, 10) - parseInt(before.left, 10))).toBeGreaterThan(24);
    expect(Math.abs(parseInt(panel.style.top, 10) - parseInt(before.top, 10))).toBeGreaterThan(24);
  });

  test("a drag while maximized does not displace the restored panel", () => {
    const { panel } = renderPanel();
    const before = { left: panel.style.left, top: panel.style.top };

    fireEvent.click(screen.getByRole("button", { name: "Maximize settings" }));
    expect(panel.className).toMatch(/maximized/);
    dragTitleBar({ x: 80, y: 12 }, { x: 400, y: 300 });
    fireEvent.click(screen.getByRole("button", { name: "Restore settings size" }));

    // A maximized panel carries no inline position, so the dropped drag is only
    // observable once it is restored -- which is where a user would see it jump.
    expect(panel.className).not.toMatch(/maximized/);
    expect(panel.style.left).toBe(before.left);
    expect(panel.style.top).toBe(before.top);
  });

  test("a drag started on a window control does not move the panel", () => {
    const { panel } = renderPanel();
    const before = { left: panel.style.left, top: panel.style.top };

    const minimize = screen.getByRole("button", { name: "Minimize settings" });
    fireEvent.pointerDown(minimize, { clientX: 80, clientY: 12 });
    fireEvent(window, new window.PointerEvent("pointermove", { clientX: 400, clientY: 300 }));
    fireEvent(window, new window.PointerEvent("pointerup", { clientX: 400, clientY: 300 }));

    expect(panel.style.left).toBe(before.left);
    expect(panel.style.top).toBe(before.top);
  });

  test("minimize hides the detail pane and restores it", () => {
    const { panel, container } = renderPanel();
    expect(container.querySelector(".settings-detail")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Minimize settings" }));
    expect(panel.className).toMatch(/minimized/);
    expect(container.querySelector(".settings-detail")).toBeNull();
    expect(container.querySelector(".settings-nav")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Restore settings" }));
    expect(panel.className).not.toMatch(/minimized/);
    expect(container.querySelector(".settings-detail")).not.toBeNull();
  });

  test("maximize and restore-size toggle the panel and its control label", () => {
    const { panel } = renderPanel();
    expect(panel.className).not.toMatch(/maximized/);

    fireEvent.click(screen.getByRole("button", { name: "Maximize settings" }));
    expect(panel.className).toMatch(/maximized/);

    const restore = screen.getByRole("button", { name: "Restore settings size" });
    fireEvent.click(restore);
    expect(panel.className).not.toMatch(/maximized/);
    expect(screen.getByRole("button", { name: "Maximize settings" })).toBeDefined();
  });

  test("maximizing a minimized panel clears the minimized state", () => {
    const { panel, container } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Minimize settings" }));
    expect(panel.className).toMatch(/minimized/);

    fireEvent.click(screen.getByRole("button", { name: "Maximize settings" }));
    expect(panel.className).toMatch(/maximized/);
    expect(panel.className).not.toMatch(/minimized/);
    expect(container.querySelector(".settings-detail")).not.toBeNull();
  });
});
