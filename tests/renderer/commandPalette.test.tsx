import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { CommandPalette } from "../../src/renderer/components/shell/CommandPalette";
import { UiCatalog } from "../../src/renderer/components/ui/UiCatalog";
import { useCommandPaletteCommands } from "../../src/renderer/hooks/useCommandPaletteCommands";
import { useGlobalShortcuts } from "../../src/renderer/hooks/useGlobalShortcuts";
import { I18nProvider, useI18n } from "../../src/renderer/i18n";
import type { JasmineRoute } from "../../src/renderer/navigation/routes";

function CommandHarness(props: {
  navigate: (route: JasmineRoute) => void;
  openSearch: () => void;
  openMemory: () => void;
  openActivity: () => void;
  openUiCatalog: () => void;
  toggleSidebar: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const commands = useCommandPaletteCommands({
    sidebarCollapsed: false,
    navigate: props.navigate,
    closeFloatingSurfaces: () => setOpen(false),
    openSearch: props.openSearch,
    openMemory: props.openMemory,
    openActivity: props.openActivity,
    openUiCatalog: props.openUiCatalog,
    toggleSidebar: props.toggleSidebar,
    t
  });
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open commands</button>
      <CommandPalette open={open} commands={commands} onClose={() => setOpen(false)} />
    </>
  );
}

function chooseCommand(query: string) {
  const input = screen.getByRole("combobox", { name: "Command palette" });
  fireEvent.change(input, { target: { value: query } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("command surfaces", () => {
  test("command palette maps filtered selections to settings, panels, and tools", () => {
    const callbacks = {
      navigate: vi.fn(),
      openSearch: vi.fn(),
      openMemory: vi.fn(),
      openActivity: vi.fn(),
      openUiCatalog: vi.fn(),
      toggleSidebar: vi.fn()
    };
    render(<I18nProvider language="en"><CommandHarness {...callbacks} /></I18nProvider>);

    chooseCommand("activity");
    expect(callbacks.openActivity).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Open commands" }));
    chooseCommand("memory");
    expect(callbacks.openMemory).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Open commands" }));
    chooseCommand("package");
    expect(callbacks.navigate).toHaveBeenLastCalledWith({ name: "settings", section: "plugins" });
    fireEvent.click(screen.getByRole("button", { name: "Open commands" }));
    chooseCommand("search");
    expect(callbacks.openSearch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Open commands" }));
    chooseCommand("toggle");
    expect(callbacks.toggleSidebar).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Open commands" }));
    chooseCommand("catalog");
    expect(callbacks.openUiCatalog).toHaveBeenCalledTimes(1);
  });

  test("global shortcuts route command, search, and new-chat actions", () => {
    const callbacks = {
      closeFloatingSurfaces: vi.fn(),
      openCommandPalette: vi.fn(),
      openSearch: vi.fn(),
      startNewChat: vi.fn()
    };
    function ShortcutHarness() {
      useGlobalShortcuts(callbacks);
      return null;
    }
    render(<ShortcutHarness />);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    expect(callbacks.closeFloatingSurfaces).toHaveBeenCalledTimes(2);
    expect(callbacks.openCommandPalette).toHaveBeenCalledTimes(1);
    expect(callbacks.openSearch).toHaveBeenCalledTimes(1);
    expect(callbacks.startNewChat).toHaveBeenCalledTimes(1);
  });

  test("UI catalog keeps primitive samples interactive", async () => {
    const close = vi.fn();
    render(<UiCatalog onClose={close} />);

    expect(screen.getByRole("heading", { name: "Buttons" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Settings rows" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Code and logs" })).toBeDefined();
    const disabled = screen.getByRole("switch", { name: "Disabled switch" });
    expect(disabled.getAttribute("aria-checked")).toBe("false");
    disabled.focus();
    fireEvent.keyDown(disabled, { key: " " });
    expect(disabled.getAttribute("aria-checked")).toBe("false");

    vi.useFakeTimers();
    try {
      fireEvent.pointerMove(screen.getByRole("button", { name: "Hover target" }), { pointerType: "mouse" });
      await act(async () => vi.advanceTimersByTimeAsync(400));
      expect(document.querySelector(".ui-tooltip")?.textContent).toContain("Tooltip sample");
    } finally {
      vi.useRealTimers();
    }

    const trigger = screen.getByRole("button", { name: "Open dialog sample" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Dialog sample" })).toBeDefined();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Dialog sample" })).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(close).toHaveBeenCalledTimes(1);
  });
});
