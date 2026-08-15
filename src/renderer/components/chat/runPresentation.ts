import type { AppLanguage } from "../../../shared/ipc";

export type RunStatus = "success" | "stopped" | "error";

// A turn that produced no activity and finished immediately gets no run header
// at all: "Worked for 1s" under a one-line answer is noise, not provenance.
export const TRIVIAL_RUN_MS = 3000;

// The live clock counts in m:ss so a running turn reads as elapsed time rather
// than a settled duration phrase. Tabular figures keep it from shifting width.
export function formatRunClock(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
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
