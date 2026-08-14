import type { AppLanguage } from "../../../shared/ipc";

export type RunStatus = "success" | "stopped" | "error";

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
