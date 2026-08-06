import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SpotlightApp } from "./components/spotlight/SpotlightApp";
import { getBridge } from "./desktopApi";
import { readStartupSettingsCache } from "./hooks/useAppSettings";
import { applyThemeAppearance } from "./hooks/useThemeAppearance";
import { I18nProvider } from "./i18n";
import "./styles.css";
import "./components/spotlight/spotlight.css";

void bootstrap().catch((error) => {
  const root = document.getElementById("root");
  if (!root) return;
  root.replaceChildren();
  const message = document.createElement("main");
  message.className = "spotlight-card";
  message.setAttribute("role", "alert");
  message.textContent = error instanceof Error ? error.message : "Jasmine Spotlight could not load.";
  root.append(message);
});

async function bootstrap() {
  const settings = readStartupSettingsCache() ?? (await getBridge().getAppSettings());
  document.documentElement.lang = settings.language === "zh" ? "zh-CN" : "en";
  applyThemeAppearance(settings.appearance);
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <I18nProvider language={settings.language}>
        <SpotlightApp />
      </I18nProvider>
    </StrictMode>
  );
}
