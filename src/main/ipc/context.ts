import type { JasmineDatabase } from "../db/database.js";
import type { WorkingRegistry } from "../services/workingRegistry.js";
import type { WorkingNavigationTarget } from "../../shared/ipc.js";

export type IpcContext = {
  getDatabase(): JasmineDatabase;
  getWorkingRegistry(): WorkingRegistry;
  consumePendingWorkingNavigation(): WorkingNavigationTarget | null;
  replaceSpotlightShortcut(accelerator: string): () => void;
};
