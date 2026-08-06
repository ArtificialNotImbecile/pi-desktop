import type { JasmineApi } from "../shared/ipc";

declare global {
  interface Window {
    jasmine?: JasmineApi;
  }
}

export function getBridge(): JasmineApi {
  if (!window.jasmine) {
    throw new Error("Jasmine desktop bridge is unavailable. Run this inside Electron, not a plain browser.");
  }
  return window.jasmine;
}
