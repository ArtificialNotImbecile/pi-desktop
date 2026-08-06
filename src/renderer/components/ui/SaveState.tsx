import { classNames } from "./classNames";

export type SaveStateValue = "idle" | "clean" | "saving" | "saved" | "failed";

export function SaveState(props: {
  className?: string;
  failedLabel?: string;
  savedLabel?: string;
  savingLabel?: string;
  state: SaveStateValue;
}) {
  const label =
    props.state === "saving"
      ? props.savingLabel || "Saving..."
      : props.state === "saved"
        ? props.savedLabel || "Saved"
        : props.state === "failed"
          ? props.failedLabel || "Save failed"
          : "";
  return <span className={classNames("ui-save-state", "save-state", `ui-save-state-${props.state}`, props.state, props.className)}>{label}</span>;
}
