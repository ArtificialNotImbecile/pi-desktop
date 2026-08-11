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

// Title-bar chrome differs per platform: macOS draws native traffic lights on
// the left, Windows/Linux get self-drawn controls on the right, and macOS
// fullscreen hides its lights entirely. Publish both as root classes so the
// inset tokens in styles.css can reserve the right side for the right platform.
function applyPlatformChrome() {
  const bridge = window.jasmine;
  if (!bridge) return;
  document.documentElement.classList.add(`platform-${bridge.platform}`);
  const sync = (state: { fullScreen: boolean }) => {
    document.documentElement.classList.toggle("is-fullscreen", state.fullScreen);
  };
  void bridge.getWindowState().then(sync).catch(() => undefined);
  bridge.onWindowStateChanged(sync);
}

async function bootstrap() {
  const cachedSettings = readStartupSettingsCache();
  const settings = cachedSettings ?? await getBridge().getAppSettings();
  if (!cachedSettings) writeStartupSettingsCache(settings);
  document.documentElement.lang = settings.language === "zh" ? "zh-CN" : "en";
  applyThemeAppearance(settings.appearance);
  applyPlatformChrome();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App initialAppSettings={settings} />
    </StrictMode>
  );
}
