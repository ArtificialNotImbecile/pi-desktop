const MODIFIER_TOKENS = new Set([
  "alt",
  "command",
  "commandorcontrol",
  "control",
  "ctrl",
  "meta",
  "option",
  "shift",
  "super"
]);

const PRIMARY_MODIFIER_TOKENS = new Set([
  "alt",
  "command",
  "commandorcontrol",
  "control",
  "ctrl",
  "meta",
  "option",
  "super"
]);

export function defaultSpotlightShortcut(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "Command+Shift+Space" : "Control+Shift+Space";
}

export function isGlobalShortcutAccelerator(value: string): boolean {
  const tokens = value.split("+").map((token) => token.trim());
  if (tokens.some((token) => !token)) return false;
  if (tokens.length < 2 || tokens.length > 5) return false;
  const keyTokens = tokens.filter((token) => !MODIFIER_TOKENS.has(token.toLowerCase()));
  if (keyTokens.length !== 1) return false;
  return tokens.some((token) => PRIMARY_MODIFIER_TOKENS.has(token.toLowerCase()));
}

export function normalizeSpotlightShortcut(value: string | null | undefined, platform: NodeJS.Platform): string {
  const candidate = value?.trim();
  return candidate && isGlobalShortcutAccelerator(candidate) ? candidate : defaultSpotlightShortcut(platform);
}
