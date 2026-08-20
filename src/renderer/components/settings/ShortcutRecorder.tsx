import { useState, type KeyboardEvent } from "react";
import { Button, TextInput } from "../ui";
import { KeyboardIcon, RefreshIcon } from "../icons/Icons";
import { useI18n } from "../../i18n";

const MODIFIER_KEYS = new Set(["Alt", "AltGraph", "Control", "Meta", "Shift"]);
const NAMED_KEYS: Record<string, string> = {
  " ": "Space",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  Backspace: "Backspace",
  Delete: "Delete",
  End: "End",
  Enter: "Enter",
  Home: "Home",
  Insert: "Insert",
  PageDown: "PageDown",
  PageUp: "PageUp",
  Tab: "Tab"
};

type ShortcutKeyEvent = Pick<
  KeyboardEvent<HTMLInputElement>,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>;

export function shortcutFromKeyEvent(event: ShortcutKeyEvent, platform: NodeJS.Platform): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const key = normalizeKey(event.key);
  if (!key) return null;
  const modifiers: string[] = [];
  if (platform === "darwin" && event.metaKey) modifiers.push("Command");
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (platform !== "darwin" && event.metaKey) modifiers.push("Super");
  if (!modifiers.some((modifier) => modifier !== "Shift")) return null;
  return [...modifiers, key].join("+");
}

export function formatShortcut(accelerator: string, platform: NodeJS.Platform): string {
  const labels = accelerator.split("+").map((token) => {
    if (platform === "darwin") {
      if (token === "Command") return "⌘";
      if (token === "Control") return "⌃";
      if (token === "Alt") return "⌥";
      if (token === "Shift") return "⇧";
      if (token === "Super") return "⌘";
    }
    if (token === "Control") return "Ctrl";
    if (token === "Command") return "Cmd";
    return token;
  });
  return platform === "darwin" ? labels.join(" ") : labels.join(" + ");
}

export function ShortcutRecorder(props: {
  defaultValue: string;
  disabled?: boolean;
  onChange(value: string): void;
  platform: NodeJS.Platform;
  value: string;
}) {
  const { t } = useI18n();
  const [recording, setRecording] = useState(false);
  const [invalid, setInvalid] = useState(false);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecording(false);
      setInvalid(false);
      event.currentTarget.blur();
      return;
    }
    const shortcut = shortcutFromKeyEvent(event, props.platform);
    if (!shortcut) {
      setInvalid(true);
      return;
    }
    props.onChange(shortcut);
    setInvalid(false);
    setRecording(false);
    event.currentTarget.blur();
  }

  return (
    <div className="shortcut-recorder">
      <TextInput
        aria-label={t("settings.general.spotlightShortcutAria")}
        disabled={props.disabled}
        readOnly
        value={recording ? t("settings.general.spotlightShortcutPress") : formatShortcut(props.value, props.platform)}
        leftIcon={<KeyboardIcon />}
        error={invalid ? t("settings.general.spotlightShortcutInvalid") : false}
        onFocus={() => {
          setRecording(true);
          setInvalid(false);
        }}
        onBlur={() => setRecording(false)}
        onKeyDown={handleKeyDown}
        rightAction={
          <Button
            aria-label={t("settings.general.spotlightShortcutReset")}
            title={t("settings.general.spotlightShortcutReset")}
            size="sm"
            variant="ghost"
            disabled={props.disabled || props.value === props.defaultValue}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setInvalid(false);
              props.onChange(props.defaultValue);
            }}
          >
            <RefreshIcon />
          </Button>
        }
      />
      <small>{recording ? t("settings.general.spotlightShortcutRecordingHint") : t("settings.general.spotlightShortcutHint")}</small>
    </div>
  );
}

function normalizeKey(key: string): string | null {
  if (NAMED_KEYS[key]) return NAMED_KEYS[key];
  if (/^F(?:[1-9]|1\d|2[0-4])$/.test(key)) return key;
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase();
  return null;
}
