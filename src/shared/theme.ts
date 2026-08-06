export const DEFAULT_APPEARANCE = {
  accent: "#0169cc",
  surface: "#ffffff",
  ink: "#0d0d0d",
  success: "#00a240",
  danger: "#e02e2a"
} as const;

export const APPEARANCE_THEMES = {
  codex: {
    ...DEFAULT_APPEARANCE
  },
  jasmine: {
    accent: "#0b74de",
    surface: "#fffdf7",
    ink: "#15191f",
    success: "#008f4c",
    danger: "#d13326"
  }
} as const;
