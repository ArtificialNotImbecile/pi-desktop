import type { WebSearchSettings, WebSearchSettingsUpdateRequest } from "../../shared/ipc.js";
import { webSearchSettingsUpdateSchema } from "../../shared/schemas.js";
import type { JasmineDatabase } from "../db/database.js";

// Jasmine does not search the web itself. Turning this on enables the
// pi-web-access package, and pi decides when to call its tools; see
// syncPiWebAccessPluginWithWebSearch in services/plugins.ts.
export function getWebSearchSettings(db: JasmineDatabase): WebSearchSettings {
  return db.getWebSearchSettings();
}

export function updateWebSearchSettings(db: JasmineDatabase, request: WebSearchSettingsUpdateRequest): WebSearchSettings {
  return db.updateWebSearchSettings(webSearchSettingsUpdateSchema.parse(request));
}
