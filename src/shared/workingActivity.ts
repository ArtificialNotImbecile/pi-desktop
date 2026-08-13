// Every activity line Jasmine writes for itself. Main persists these on the
// Working task; the renderer translates them for display. They live here so the
// two sides cannot drift: a label added on one side without a translation on
// the other fails tests/unit/working-activity-i18n.mjs.
//
// Text that comes from a model or a tool -- an error message, a file path -- is
// not listed here and is shown as written, because it is not ours to translate.
export const WORKING_ACTIVITY = {
  preparing: "Preparing response",
  preparingRetry: "Preparing retry",
  preparingEdit: "Preparing edited response",
  resuming: "Resuming response",
  generating: "Generating response",
  thinking: "Thinking",
  usingTool: "Using a tool",
  processingToolResult: "Processing tool result",
  toolError: "Tool reported an error",
  writing: "Writing response",
  waiting: "Waiting for your answer",
  stopping: "Stopping",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted when Jasmine exited"
} as const;

export type WorkingActivityName = keyof typeof WORKING_ACTIVITY;

// The one activity with an operand. The tool name is sanitized by the caller
// and passed through untranslated.
export function usingToolActivity(toolName: string): string {
  return `Using ${toolName}`;
}

export function toolNameFromActivity(activity: string): string | null {
  if (activity === WORKING_ACTIVITY.usingTool) return null;
  const match = /^Using (.+)$/.exec(activity);
  return match ? match[1] : null;
}
