export const DEFAULT_APPEARANCE = {
  accent: "#0169cc",
  surface: "#ffffff",
  ink: "#0d0d0d",
  success: "#00a240",
  danger: "#e02e2a"
} as const;

// "Waiting for you" is a state, not a preference, so its amber is not part of
// AppearanceSettings -- but it still has to sit on whatever surface the user
// picked, which is why there are two of them.
export const ATTENTION_ON_LIGHT = "#b25e00";
export const ATTENTION_ON_DARK = "#e9a13b";

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
