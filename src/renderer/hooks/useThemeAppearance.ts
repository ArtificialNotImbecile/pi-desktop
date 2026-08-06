import { useEffect } from "react";
import type { AppearanceSettings } from "../../shared/ipc";
import { DEFAULT_APPEARANCE } from "../../shared/theme";

export const defaultAppearance: AppearanceSettings = {
  ...DEFAULT_APPEARANCE,
  updatedAt: ""
};

export function useThemeAppearance(appearance: AppearanceSettings): void {
  useEffect(() => {
    applyThemeAppearance(appearance);
  }, [appearance.accent, appearance.surface, appearance.ink, appearance.success, appearance.danger]);
}

export function applyThemeAppearance(appearance: AppearanceSettings): void {
  const theme = buildThemeVariables(appearance);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme)) {
    root.style.setProperty(name, value);
  }
}

export function buildThemeVariables(appearance: AppearanceSettings): Record<string, string> {
  const accent = parseHex(appearance.accent, defaultAppearance.accent);
  const surface = parseHex(appearance.surface, defaultAppearance.surface);
  const ink = parseHex(appearance.ink, defaultAppearance.ink);
  const success = parseHex(appearance.success, defaultAppearance.success);
  const danger = parseHex(appearance.danger, defaultAppearance.danger);
  const defaultTheme = isDefaultAppearance(appearance);

  return {
    "--accent": toHex(accent),
    "--accent-rgb": toRgbTriplet(accent),
    "--surface": toHex(surface),
    "--surface-rgb": toRgbTriplet(surface),
    "--ink": toHex(ink),
    "--ink-rgb": toRgbTriplet(ink),
    "--success": toHex(success),
    "--success-rgb": toRgbTriplet(success),
    "--danger": toHex(danger),
    "--danger-rgb": toRgbTriplet(danger),
    "--muted": defaultTheme ? "#4f4f4f" : toHex(mix(surface, ink, 0.68)),
    "--faint": defaultTheme ? "#8a8a8a" : toHex(mix(surface, ink, 0.45)),
    "--line": defaultTheme ? "#e5e5e5" : toHex(mix(surface, ink, 0.1)),
    "--line-subtle": defaultTheme ? "#eeeeee" : toHex(mix(surface, ink, 0.07)),
    "--line-strong": defaultTheme ? "#d8d8d8" : toHex(mix(surface, ink, 0.16)),
    "--soft": defaultTheme ? "#f7f7f7" : toHex(mix(surface, ink, 0.03)),
    "--soft-strong": defaultTheme ? "#f1f1f1" : toHex(mix(surface, ink, 0.06)),
    "--control": defaultTheme ? "#f3f3f3" : toHex(mix(surface, ink, 0.05)),
    "--accent-soft": defaultTheme ? "#eef6ff" : toHex(mix(surface, accent, 0.08)),
    "--accent-line": defaultTheme ? "#b9dcff" : toHex(mix(surface, accent, 0.32)),
    "--success-soft": defaultTheme ? "#effaf3" : toHex(mix(surface, success, 0.08)),
    "--danger-soft": defaultTheme ? "#fff4f4" : toHex(mix(surface, danger, 0.07)),
    "--on-accent": luminance(accent) < 0.55 ? "#ffffff" : "#0d0d0d",
    "--on-ink": luminance(ink) < 0.55 ? "#ffffff" : "#0d0d0d",
    "--on-danger": luminance(danger) < 0.55 ? "#ffffff" : "#0d0d0d",
    "--danger-ink": defaultTheme ? "#7f1d1a" : toHex(mix(danger, ink, 0.45)),
    "--danger-hover": defaultTheme ? "#c92723" : toHex(mix(danger, ink, 0.16)),
    "--scrollbar": defaultTheme ? "#e4e4e5" : toHex(mix(surface, ink, 0.1)),
    "--scrollbar-hover": defaultTheme ? "#585a5b" : toHex(mix(surface, ink, 0.64))
  };
}

type Rgb = { r: number; g: number; b: number };

function parseHex(value: string, fallback: string): Rgb {
  const normalized = /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16)
  };
}

function mix(base: Rgb, overlay: Rgb, overlayAmount: number): Rgb {
  const amount = Math.max(0, Math.min(1, overlayAmount));
  return {
    r: Math.round(base.r * (1 - amount) + overlay.r * amount),
    g: Math.round(base.g * (1 - amount) + overlay.g * amount),
    b: Math.round(base.b * (1 - amount) + overlay.b * amount)
  };
}

function luminance(color: Rgb): number {
  const [r, g, b] = [color.r, color.g, color.b].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function toHex(color: Rgb): string {
  return `#${toHexChannel(color.r)}${toHexChannel(color.g)}${toHexChannel(color.b)}`;
}

function toHexChannel(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
}

function toRgbTriplet(color: Rgb): string {
  return `${color.r}, ${color.g}, ${color.b}`;
}

function isDefaultAppearance(appearance: AppearanceSettings): boolean {
  return appearance.accent.toLowerCase() === DEFAULT_APPEARANCE.accent &&
    appearance.surface.toLowerCase() === DEFAULT_APPEARANCE.surface &&
    appearance.ink.toLowerCase() === DEFAULT_APPEARANCE.ink &&
    appearance.success.toLowerCase() === DEFAULT_APPEARANCE.success &&
    appearance.danger.toLowerCase() === DEFAULT_APPEARANCE.danger;
}
