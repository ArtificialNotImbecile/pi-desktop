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

  // A packaged build with no app-update.yml used to reach electron-updater and
  // fail every check with a raw "ENOENT ... app-update.yml". It now resolves to
  // an unsupported build in manual mode, and the only honest action left is the
  // releases page -- not a disabled "Check for updates" button.
  test("routes a build with no update feed to the release page", () => {
    const updater = updaterResult({
      ...BASE_STATE,
      phase: "unsupported",
      supported: false,
      installMode: "manual"
    });
    useAppUpdaterMock.mockReturnValue(updater);
    renderAbout();

    expect(screen.getByText(
      "This build cannot check for updates. Download the latest Jasmine from GitHub Releases."
    )).toBeDefined();
    expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open download page" }));
    expect(updater.openDownloadPage).toHaveBeenCalledTimes(1);
    expect(updater.check).not.toHaveBeenCalled();
  });

  // A development build has no installer behind it at all, so the download page
  // would be a dead end there; it keeps the disabled check button and its reason.
  test("keeps the disabled check button for an unpackaged development build", () => {
    useAppUpdaterMock.mockReturnValue(updaterResult({
      ...BASE_STATE,
      phase: "unsupported",
      supported: false
    }));
    renderAbout();

    expect(screen.getByText("Update checks are available in the installed app.")).toBeDefined();
    const check = screen.getByRole("button", { name: "Check for updates" }) as HTMLButtonElement;
    expect(check.disabled).toBe(true);
    expect(check.title).toBe("Install Jasmine before checking for updates.");
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
