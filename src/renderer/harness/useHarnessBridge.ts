import { useEffect } from "react";
import { auditSnapshot, collectSnapshot } from "./harnessAudit";
import type { HarnessBridge, HarnessBridgeInput } from "./harnessTypes";

declare global {
  interface Window {
    __JASMINE_HARNESS_ENABLED__?: boolean;
    __jasmineHarness?: HarnessBridge;
  }
}

export function useHarnessBridge(input: HarnessBridgeInput) {
  useEffect(() => {
    if (!window.__JASMINE_HARNESS_ENABLED__) return;

    const bridge: HarnessBridge = {
      snapshot: () => collectSnapshot(input),
      audit: () => auditSnapshot(collectSnapshot(input)),
      actions: input.actions
    };

    window.__jasmineHarness = bridge;
    return () => {
      if (window.__jasmineHarness === bridge) delete window.__jasmineHarness;
    };
  }, [input]);
}
