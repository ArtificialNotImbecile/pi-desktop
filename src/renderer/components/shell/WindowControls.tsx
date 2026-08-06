import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";

export function WindowControls() {
  const { t } = useI18n();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void window.jasmine?.getWindowState().then((state) => setMaximized(state.maximized)).catch(() => undefined);
    return window.jasmine?.onWindowStateChanged((state) => setMaximized(state.maximized));
  }, []);

  const action = (name: "minimize" | "maximize" | "close") => {
    void window.jasmine?.windowAction(name);
  };

  return (
    <div className="window-controls" aria-label={t("window.controls")}>
      <button className="window-control minimize" type="button" onClick={() => action("minimize")} aria-label={t("window.minimize")} title={t("window.minimize")}>
        <span aria-hidden="true" />
      </button>
      <button className={`window-control ${maximized ? "restore" : "maximize"}`} type="button" onClick={() => action("maximize")} aria-label={maximized ? t("window.restore") : t("window.maximize")} title={maximized ? t("window.restore") : t("window.maximize")}>
        <span aria-hidden="true" />
      </button>
      <button className="window-control close" type="button" onClick={() => action("close")} aria-label={t("window.close")} title={t("window.close")}>
        <span aria-hidden="true" />
      </button>
    </div>
  );
}
