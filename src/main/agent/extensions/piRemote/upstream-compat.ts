import { PROTOCOL_VERSION } from "@earendil-works/pi-protocol";

/**
 * Exact experimental upstream baseline used only for compatibility tests.
 * Production SSH/TUI/RPC paths do not expose these DTOs.
 */
export const UPSTREAM_PI_REMOTE_BASELINE = {
  packageVersion: "0.84.2",
  protocolVersion: PROTOCOL_VERSION,
  supportedCapabilities: ["session-list", "session-create", "session-open", "prompt-text", "steer", "abort", "model", "thinking"],
  missingCapabilities: ["native-tui", "prompt-image", "tree", "fork", "clone", "compact", "extension-ui", "auth", "bootstrap", "client-proxy"]
} as const;
