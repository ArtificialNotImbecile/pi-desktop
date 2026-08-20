import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { AiProvider, ProviderModelConfig } from "../../src/shared/ipc";
import { I18nProvider } from "../../src/renderer/i18n";
import { ProviderSettingsPanel } from "../../src/renderer/components/settings/ProviderSettingsPanel";
import { ModelOptionsDialog } from "../../src/renderer/components/settings/ModelOptionsDialog";
import { installFakeBridge } from "./fakeBridge";
import { fakeAppSettings, fakeProvider, settingsPanelProps } from "./settingsPanelProps";

const model: ProviderModelConfig = {
  id: "fake-model",
  enabled: true,
  capabilities: {
    vision: false,
    imageOutput: false,
    toolCalling: true,
    reasoning: true,
    embedding: false
  },
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  providerOptionsJson: "{}"
};

function provider(overrides: Partial<AiProvider> = {}): AiProvider {
  return { ...fakeProvider, models: [model], defaultModel: model.id, ...overrides };
}

function renderPanel(overrides: Parameters<typeof settingsPanelProps>[0] = {}) {
  installFakeBridge();
  const activeProvider = overrides.provider ?? provider();
  return render(
    <I18nProvider language="en">
      <ProviderSettingsPanel {...settingsPanelProps({
        providers: [activeProvider],
        provider: activeProvider,
        selectedProviderId: activeProvider.id,
        ...overrides
      })} />
    </I18nProvider>
  );
}

describe("provider settings", () => {
  test("shows the configured provider and keeps unreleased settings out of navigation", () => {
    const view = renderPanel();
    expect(within(view.container).getByRole("heading", { name: "Fake Provider" })).toBeDefined();
    expect(view.container.querySelector(".settings-panel")?.className).toContain("has-subnav");
    expect(view.container.querySelectorAll(".settings-nav button")).toHaveLength(9);
    expect(view.container.textContent).not.toContain("Chrome control");
    expect(view.container.querySelector(".settings-detail .settings-header")).toBeNull();
  });

  test("settings navigation reaches memory, activity, packages, and about content", () => {
    const view = renderPanel();
    const nav = view.container.querySelector<HTMLElement>(".settings-nav");
    if (!nav) throw new Error("Settings navigation did not render.");

    fireEvent.click(within(nav).getByRole("button", { name: "Memory" }));
    expect(view.container.textContent).toContain("Saved memories");
    expect(screen.getByRole("button", { name: "Open Memory" })).toBeDefined();

    fireEvent.click(within(nav).getByRole("button", { name: "Activity" }));
    expect(view.container.textContent).toContain("Recorder controls");
    expect(screen.getByRole("button", { name: "Open Activity" })).toBeDefined();

    fireEvent.click(within(nav).getByRole("button", { name: "Packages" }));
    expect(view.container.textContent).toContain("No packages installed.");

    fireEvent.click(within(nav).getByRole("button", { name: "About" }));
    expect(view.container.textContent).toContain("independent, open-source desktop GUI for the Pi coding agent");
    expect(view.container.textContent).toContain("not affiliated with or endorsed by Pi");
    expect(view.container.textContent).toContain("Data location");
  });

  test("general settings submit tool-model and brand drafts as one settings update", async () => {
    const onUpdate = vi.fn(async (_request: unknown) => fakeAppSettings);
    const kimi = provider({
      id: "moonshot",
      name: "Moonshot Kimi",
      defaultModel: "kimi-k2.6",
      models: [{ ...model, id: "kimi-k2.6" }]
    });
    renderPanel({
      initialSection: "general",
      providers: [provider(), kimi],
      onUpdateAppSettings: onUpdate
    });

    fireEvent.change(screen.getByRole("combobox", { name: "Tool model provider" }), {
      target: { value: "moonshot" }
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Tool model reasoning" }), {
      target: { value: "minimal" }
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Entry main title" }), {
      target: { value: "Custom helper" }
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Entry subtitle" }), {
      target: { value: "Custom subtitle for this workspace." }
    });
    const shortcut = screen.getByRole("textbox", { name: "Quick launcher keyboard shortcut" });
    fireEvent.focus(shortcut);
    fireEvent.keyDown(shortcut, { key: "j", code: "KeyJ", ctrlKey: true, shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({
      toolModel: {
        providerId: "moonshot",
        modelId: "kimi-k2.6",
        reasoningEffort: "minimal"
      },
      brand: {
        mainTitle: "Custom helper",
        subtitle: "Custom subtitle for this workspace."
      },
      spotlightShortcut: "Control+Shift+J"
    });
  });

  test("appearance presets update every color and submit the selected theme", async () => {
    const onUpdate = vi.fn(async (_request: unknown) => fakeAppSettings);
    renderPanel({ initialSection: "appearance", onUpdateAppSettings: onUpdate });

    fireEvent.click(screen.getByRole("button", { name: /Jasmine/ }));
    expect((screen.getByRole("textbox", { name: "Accent hex color" }) as HTMLInputElement).value).toBe("#0b74de");
    expect((screen.getByRole("textbox", { name: "Surface hex color" }) as HTMLInputElement).value).toBe("#fffdf7");
    expect((screen.getByRole("textbox", { name: "Ink hex color" }) as HTMLInputElement).value).toBe("#15191f");
    expect((screen.getByRole("textbox", { name: "Success hex color" }) as HTMLInputElement).value).toBe("#008f4c");
    expect((screen.getByRole("textbox", { name: "Danger hex color" }) as HTMLInputElement).value).toBe("#d13326");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({
      appearance: {
        accent: "#0b74de",
        surface: "#fffdf7",
        ink: "#15191f",
        success: "#008f4c",
        danger: "#d13326"
      }
    });
  });

  test("provider enabled is an accessible keyboard button and pointer changes its state", () => {
    renderPanel();
    const toggle = screen.getByRole("switch", { name: "Provider enabled" });
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.querySelector(".ui-switch-label")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  test("env-var credentials submit the provider update without exposing a secret", async () => {
    const configured = provider({ apiKeyRef: "OLD_PROVIDER_KEY" });
    const onSave = vi.fn(async (request) => ({ ...configured, ...request }));
    const view = renderPanel({ provider: configured, providers: [configured], onSave });

    fireEvent.change(view.container.querySelector("#provider-base-url") as HTMLInputElement, {
      target: { value: "https://api.deepseek.com/v1" }
    });
    fireEvent.change(view.container.querySelector("#provider-api-key-ref") as HTMLInputElement, {
      target: { value: "DEEPSEEK_API_KEY" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      id: configured.id,
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyRef: "env:DEEPSEEK_API_KEY",
      defaultModel: configured.defaultModel,
      enabled: true
    });
  });

  test("fetching models refreshes the model list and default-model choices", async () => {
    installFakeBridge();
    const fetchedModel = { ...model, id: "fake-model-pro" };

    function Harness() {
      const [activeProvider, setActiveProvider] = useState(provider({ models: [], defaultModel: "" }));
      return (
        <I18nProvider language="en">
          <ProviderSettingsPanel {...settingsPanelProps({
            providers: [activeProvider],
            provider: activeProvider,
            selectedProviderId: activeProvider.id,
            onFetchModels: async (providerId) => {
              expect(providerId).toBe(activeProvider.id);
              setActiveProvider((current) => ({
                ...current,
                models: [model, fetchedModel],
                defaultModel: fetchedModel.id
              }));
              return null;
            }
          })} />
        </I18nProvider>
      );
    }

    const view = render(<Harness />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    });
    expect(view.container.querySelectorAll(".model-row")).toHaveLength(2);
    expect(screen.getByRole("combobox").textContent).toContain("fake-model-pro");
    expect(screen.getByPlaceholderText("Search models...")).toBeDefined();
  });

  test("model options reject invalid provider JSON without closing", () => {
    const onSave = vi.fn(async () => undefined);

    function Harness() {
      const [draft, setDraft] = useState(model);
      return (
        <I18nProvider language="en">
          <ModelOptionsDialog
            model={draft}
            originalModel={model}
            onChange={setDraft}
            onCancel={() => undefined}
            onSave={onSave}
          />
        </I18nProvider>
      );
    }

    render(<Harness />);
    const dialog = screen.getByRole("dialog", { name: "Model Options" });
    const json = within(dialog).getByRole("textbox");
    fireEvent.change(json, { target: { value: "{ invalid" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(screen.getByText("Provider options must be valid JSON.")).toBeDefined();
    expect(json.getAttribute("aria-invalid")).toBe("true");
    expect(dialog.isConnected).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });
});
