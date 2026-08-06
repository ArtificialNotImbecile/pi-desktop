import type { HTMLAttributes, ReactNode } from "react";
import { Button, type ButtonVariant, SaveState, type SaveStateValue, Select, StatusPill, TextInput, Toolbar, classNames } from "../ui";
import { EyeIcon, EyeOffIcon, FolderIcon } from "../icons/Icons";

export function SettingsPage(props: {
  children: ReactNode;
  className?: string;
  subtitle?: ReactNode;
  title?: ReactNode;
}) {
  return (
    <div className={classNames("settings-page", "ui-settings-page", props.className)}>
      {props.title || props.subtitle ? (
        <header className="ui-settings-page-header">
          {props.title ? <h2>{props.title}</h2> : null}
          {props.subtitle ? <p>{props.subtitle}</p> : null}
        </header>
      ) : null}
      {props.children}
    </div>
  );
}

export function SettingsSection({ children, className, title, ...props }: HTMLAttributes<HTMLElement> & { children: ReactNode; title?: ReactNode }) {
  return (
    <section {...props} className={classNames("settings-group", "ui-settings-section", className)}>
      {title ? <h3 className="ui-settings-section-title">{title}</h3> : null}
      {children}
    </section>
  );
}

export function SettingsRow(props: {
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  description?: ReactNode;
  label: ReactNode;
}) {
  return (
    <div className={classNames("settings-row", "ui-settings-row", props.className)}>
      <div className="ui-settings-row-copy">
        <strong>{props.label}</strong>
        {props.description ? <small>{props.description}</small> : null}
      </div>
      <div className="settings-row-actions ui-settings-row-control">{props.actions ?? props.children}</div>
    </div>
  );
}

export function SettingsActions(props: {
  children?: ReactNode;
  className?: string;
  dirty?: boolean;
  disabled?: boolean;
  failedLabel?: string;
  onSave?: () => void;
  saveLabel?: string;
  savedLabel?: string;
  savingLabel?: string;
  state?: SaveStateValue;
}) {
  const state = props.state || "idle";
  return (
    <div className={classNames("settings-actions", "inline-actions", "ui-settings-actions", props.className)}>
      <SaveState state={state} savingLabel={props.savingLabel} savedLabel={props.savedLabel} failedLabel={props.failedLabel} />
      {props.children}
      {props.onSave ? (
        <Button
          variant="primary"
          disabled={props.disabled || !props.dirty || state === "saving"}
          loading={state === "saving"}
          style={{ backgroundColor: "var(--accent)", borderColor: "var(--accent)" }}
          onClick={props.onSave}
        >
          {state === "saving" ? props.savingLabel || "Saving..." : props.dirty ? props.saveLabel || "Save" : props.savedLabel || "Saved"}
        </Button>
      ) : null}
    </div>
  );
}

export function SettingsToolbar(props: { children: ReactNode; className?: string }) {
  return <Toolbar className={classNames("settings-toolbar", "ui-settings-toolbar", props.className)}>{props.children}</Toolbar>;
}

export function SettingsList(props: { ariaLabel?: string; children: ReactNode; className?: string }) {
  return (
    <section className={classNames("ui-settings-list", props.className)} aria-label={props.ariaLabel}>
      {props.children}
    </section>
  );
}

export function SettingsListRow(props: {
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  description?: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  status?: ReactNode;
  title: ReactNode;
}) {
  return (
    <article className={classNames("ui-settings-list-row", props.className)}>
      {props.icon ? <span className="ui-settings-list-icon">{props.icon}</span> : null}
      <div className="ui-settings-list-main">
        <strong>{props.title}</strong>
        {props.description ? <small>{props.description}</small> : null}
        {props.meta ? <small>{props.meta}</small> : null}
        {props.children}
      </div>
      {props.status ? <div className="ui-settings-list-status">{props.status}</div> : null}
      {props.actions ? <div className="ui-settings-list-actions">{props.actions}</div> : null}
    </article>
  );
}

export function ExecutablePickerField(props: {
  browseLabel: string;
  disabled?: boolean;
  onBrowse(): void;
  onChange(value: string): void;
  options: Array<{ label: string; value: string }>;
  pathLabel: string;
  pathPlaceholder?: string;
  pathValue: string;
  selectLabel: string;
  value: string;
}) {
  return (
    <div className="ui-executable-picker">
      <div className="ui-executable-picker-controls">
        <Select
          aria-label={props.selectLabel}
          disabled={props.disabled}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
        >
          {props.options.map((option) => (
            <option key={`${option.value || "auto"}:${option.label}`} value={option.value}>{option.label}</option>
          ))}
        </Select>
        <Button variant="default" onClick={props.onBrowse} disabled={props.disabled} leftIcon={<FolderIcon />}>
          {props.browseLabel}
        </Button>
      </div>
      <output className={props.pathValue ? "has-value" : ""} aria-label={props.pathLabel} title={props.pathValue || props.pathPlaceholder}>
        <span>{props.pathValue || props.pathPlaceholder}</span>
      </output>
    </div>
  );
}

export function SecretField(props: {
  disabled?: boolean;
  hidden: boolean;
  id?: string;
  onChange(value: string): void;
  onToggleHidden(): void;
  placeholder?: string;
  revealLabel: string;
  value: string;
}) {
  return (
    <TextInput
      id={props.id}
      type={props.hidden ? "password" : "text"}
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.value)}
      rightAction={
        <Button variant="ghost" size="sm" onClick={props.onToggleHidden} aria-label={props.revealLabel}>
          {props.hidden ? <EyeIcon /> : <EyeOffIcon />}
        </Button>
      }
    />
  );
}

export function StatePill(props: { children: ReactNode; className?: string; tone?: "neutral" | "success" | "danger" | "accent" | "warning" }) {
  return <StatusPill className={props.className} tone={props.tone}>{props.children}</StatusPill>;
}

export function RowButton(props: {
  children: ReactNode;
  disabled?: boolean;
  leftIcon?: ReactNode;
  onClick?: () => void;
  title?: string;
  variant?: ButtonVariant;
}) {
  return (
    <Button size="sm" variant={props.variant || "default"} disabled={props.disabled} onClick={props.onClick} title={props.title} leftIcon={props.leftIcon}>
      {props.children}
    </Button>
  );
}
