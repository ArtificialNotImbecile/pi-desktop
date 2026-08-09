import { useId, useState, type ReactNode } from "react";
import type { AppLanguage } from "../../../shared/ipc";
import { useI18n } from "../../i18n";
import { ChevronDownIcon } from "../icons/Icons";

export type RunRecapStatus = "success" | "stopped" | "error";

export function RunRecap(props: {
  status: RunRecapStatus;
  elapsedMs?: number;
  defaultExpanded: boolean;
  children: ReactNode;
}) {
  const { language, t } = useI18n();
  const [expanded, setExpanded] = useState(props.defaultExpanded);
  const detailsId = useId();
  const duration = formatElapsedDuration(props.elapsedMs, language);
  const label = recapLabel(props.status, duration, t);

  return (
    <section className={`run-recap ${props.status}`}>
      <button
        type="button"
        className="run-recap-toggle"
        aria-expanded={expanded}
        aria-controls={detailsId}
        aria-label={expanded ? t("message.hideWorkDetails") : t("message.showWorkDetails")}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="run-recap-label">{label}</span>
        <ChevronDownIcon />
      </button>
      <div id={detailsId} className="run-recap-details" hidden={!expanded}>
        {props.children}
      </div>
    </section>
  );
}

export function formatElapsedDuration(elapsedMs: number | undefined, language: AppLanguage): string | null {
  if (elapsedMs === undefined || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  const totalSeconds = Math.max(1, Math.round(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (language === "zh") {
    return [
      hours > 0 ? `${hours} 小时` : "",
      minutes > 0 ? `${minutes} 分` : "",
      seconds > 0 || (hours === 0 && minutes === 0) ? `${seconds} 秒` : ""
    ].filter(Boolean).join(" ");
  }

  return [
    hours > 0 ? `${hours}h` : "",
    minutes > 0 ? `${minutes}m` : "",
    seconds > 0 || (hours === 0 && minutes === 0) ? `${seconds}s` : ""
  ].filter(Boolean).join(" ");
}

function recapLabel(
  status: RunRecapStatus,
  duration: string | null,
  t: ReturnType<typeof useI18n>["t"]
): string {
  if (status === "stopped") return duration ? t("message.stoppedAfter", { duration }) : t("message.stoppedWorkDetails");
  if (status === "error") return duration ? t("message.failedAfter", { duration }) : t("message.failedWorkDetails");
  return duration ? t("message.workedFor", { duration }) : t("message.workDetails");
}
