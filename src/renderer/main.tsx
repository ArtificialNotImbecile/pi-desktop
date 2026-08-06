import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { getBridge } from "./desktopApi";
import { readStartupSettingsCache, writeStartupSettingsCache } from "./hooks/useAppSettings";
import { applyThemeAppearance } from "./hooks/useThemeAppearance";
import "./styles.css";

void bootstrap().catch((error) => {
  const root = document.getElementById("root");
  if (!root) return;
  root.replaceChildren();
  const message = document.createElement("main");
  message.className = "renderer-startup";
  message.setAttribute("role", "alert");
  message.textContent = error instanceof Error ? error.message : "Jasmine could not load local settings.";
  root.append(message);
});

async function bootstrap() {
  const cachedSettings = readStartupSettingsCache();
  const settings = cachedSettings ?? await getBridge().getAppSettings();
  if (!cachedSettings) writeStartupSettingsCache(settings);
  document.documentElement.lang = settings.language === "zh" ? "zh-CN" : "en";
  applyThemeAppearance(settings.appearance);
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App initialAppSettings={settings} />
    </StrictMode>
  );
}
