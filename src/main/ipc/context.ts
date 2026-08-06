import type { JasmineDatabase } from "../db/database.js";

export type IpcContext = {
  getDatabase(): JasmineDatabase;
};
