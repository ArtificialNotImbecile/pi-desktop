import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { AppUpdateState } from "../../src/shared/ipc";
import { I18nProvider } from "../../src/renderer/i18n";

const useAppUpdaterMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/renderer/hooks/useAppUpdater", () => ({
  useAppUpdater: useAppUpdaterMock
}));

import { AboutSettingsPage } from "../../src/renderer/components/settings/AboutSettingsPage";

const BASE_STATE: AppUpdateState = {
  phase: "idle",
  supported: true,
  installMode: "automatic",
  currentVersion: "0.3.4",
  availableVersion: null,
  progressPercent: null,
  bytesPerSecond: null,
  transferredBytes: null,
  totalBytes: null,
  lastCheckedAt: null,
  error: null
};

function updaterResult(state: AppUpdateState) {
  return {
    state,
    loading: false,
    check: vi.fn(),
    download: vi.fn(),
    install: vi.fn(),
    openDownloadPage: vi.fn()
  };
}

function renderAbout() {
  return render(
    <I18nProvider language="en">
      <AboutSettingsPage />
    </I18nProvider>
  );
}

describe("About update settings", () => {
  test("offers the release page for manual installations and surfaces hand-off failures", () => {
    const available = updaterResult({
      ...BASE_STATE,
      phase: "available",
      installMode: "manual",
      availableVersion: "9.9.9"
    });
    useAppUpdaterMock.mockReturnValue(available);
    const view = renderAbout();

    expect(screen.getByText("Version 9.9.9 is available on GitHub Releases.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Download update" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open download page" }));
    expect(available.openDownloadPage).toHaveBeenCalledTimes(1);

    useAppUpdaterMock.mockReturnValue(updaterResult({
      ...BASE_STATE,
      phase: "error",
      installMode: "manual",
      error: "Could not open https://github.com/ArtificialNotImbecile/pi-desktop/releases/latest: no usable browser handler"
    }));
    view.rerender(
      <I18nProvider language="en">
        <AboutSettingsPage />
      </I18nProvider>
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("https://github.com/ArtificialNotImbecile/pi-desktop/releases/latest");
    expect(alert.textContent).toContain("no usable browser handler");
  });

  test("reports an up-to-date build and keeps update checks available", () => {
    const updater = updaterResult({ ...BASE_STATE, phase: "up-to-date" });
    useAppUpdaterMock.mockReturnValue(updater);
    renderAbout();

    expect(screen.getByText("Jasmine is up to date.")).toBeDefined();
    const check = screen.getByRole("button", { name: "Check for updates" }) as HTMLButtonElement;
    expect(check.disabled).toBe(false);
    fireEvent.click(check);
    expect(updater.check).toHaveBeenCalledTimes(1);
  });
});
