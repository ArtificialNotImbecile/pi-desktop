import type { AppLanguage, AppSettings, AppSettingsUpdateRequest, ReasoningEffort } from "../../../shared/ipc.js";
import type { PermissionMode } from "../../../shared/permissions.js";
import { DEFAULT_BRAND_SETTINGS, isSupportedBrandLogoDataUrl } from "../../../shared/brand.js";
import { DEFAULT_APPEARANCE } from "../../../shared/theme.js";
import { isWindowsBashLauncherPath } from "../../utils/shellPaths.js";
import type { SqlDatabase } from "./types.js";

type AppSettingsRow = {
  id: string;
  tool_provider_id: string;
  tool_model_id: string;
  tool_reasoning_effort: ReasoningEffort;
  appearance_accent: string;
  appearance_surface: string;
  appearance_ink: string;
  appearance_success: string;
  appearance_danger: string;
  brand_logo_data_url?: string | null;
  brand_main_title?: string | null;
  brand_subtitle?: string | null;
  language: AppLanguage;
  working_notification_mode?: string | null;
  working_notification_include_details?: number | null;
  permission_mode?: string | null;
  file_change_tracking_mode?: string | null;
  skill_editor_path?: string | null;
  terminal_shell_path?: string | null;
  updated_at: string;
};

export function ensureAppSettings(db: SqlDatabase, timestamp: string): void {
  const existing = db.prepare("SELECT 1 AS exists_flag FROM app_settings WHERE id = 'default'").get() as { exists_flag?: number };
  if (existing?.exists_flag === 1) return;
  db.prepare(
    `INSERT INTO app_settings (
      id,
      tool_provider_id,
      tool_model_id,
      tool_reasoning_effort,
      appearance_accent,
      appearance_surface,
      appearance_ink,
      appearance_success,
      appearance_danger,
      brand_logo_data_url,
      brand_main_title,
      brand_subtitle,
      language,
      working_notification_mode,
      working_notification_include_details,
      permission_mode,
      file_change_tracking_mode,
      skill_editor_path,
      terminal_shell_path,
      updated_at
    ) VALUES ('default', 'deepseek', 'deepseek-v4-flash', 'off', ?, ?, ?, ?, ?, NULL, ?, ?, 'en', 'background', 1, 'ask', 'managed-tools-only', NULL, NULL, ?)`
  ).run(
    DEFAULT_APPEARANCE.accent,
    DEFAULT_APPEARANCE.surface,
    DEFAULT_APPEARANCE.ink,
    DEFAULT_APPEARANCE.success,
    DEFAULT_APPEARANCE.danger,
    DEFAULT_BRAND_SETTINGS.mainTitle,
    DEFAULT_BRAND_SETTINGS.subtitle,
    timestamp
  );
}

export function getAppSettings(db: SqlDatabase): AppSettings | null {
  const row = db
    .prepare(
      `SELECT
        id,
        tool_provider_id,
        tool_model_id,
        tool_reasoning_effort,
        appearance_accent,
        appearance_surface,
        appearance_ink,
        appearance_success,
        appearance_danger,
        brand_logo_data_url,
        brand_main_title,
        brand_subtitle,
        language,
        working_notification_mode,
        working_notification_include_details,
        permission_mode,
        file_change_tracking_mode,
        skill_editor_path,
        terminal_shell_path,
        updated_at
      FROM app_settings
      WHERE id = 'default'`
    )
    .get() as AppSettingsRow | undefined;
  return row ? mapAppSettings(row) : null;
}

export function updateAppSettings(
  db: SqlDatabase,
  current: AppSettings,
  input: AppSettingsUpdateRequest,
  timestamp: string
): void {
  const toolModel = input.toolModel ?? {};
  const next = {
    providerId: toolModel.providerId?.trim() || current.toolModel.providerId,
    modelId: toolModel.modelId?.trim() || current.toolModel.modelId,
    reasoningEffort: toolModel.reasoningEffort ?? current.toolModel.reasoningEffort,
    accent: normalizeColor(input.appearance?.accent, current.appearance.accent),
    surface: normalizeColor(input.appearance?.surface, current.appearance.surface),
    ink: normalizeColor(input.appearance?.ink, current.appearance.ink),
    success: normalizeColor(input.appearance?.success, current.appearance.success),
    danger: normalizeColor(input.appearance?.danger, current.appearance.danger),
    logoDataUrl: normalizeLogoDataUrl(input.brand?.logoDataUrl, current.brand.logoDataUrl),
    mainTitle: normalizeRequiredText(input.brand?.mainTitle, current.brand.mainTitle, DEFAULT_BRAND_SETTINGS.mainTitle),
    subtitle: normalizeOptionalText(input.brand?.subtitle, current.brand.subtitle, DEFAULT_BRAND_SETTINGS.subtitle),
    language: normalizeLanguage(input.language, current.language),
    workingNotificationMode: normalizeWorkingNotificationMode(input.workingNotifications?.mode, current.workingNotifications.mode),
    workingNotificationIncludeDetails: input.workingNotifications?.includeDetails ?? current.workingNotifications.includeDetails,
    permissionMode: normalizePermissionMode(input.permissionMode, current.permissionMode),
    fileChangeTrackingMode: normalizeFileChangeTrackingMode(input.fileChangeTrackingMode, current.fileChangeTrackingMode),
    skillEditorPath: normalizeOptionalPath(input.skillEditorPath, current.skillEditorPath),
    terminalShellPath: normalizeTerminalShellPath(input.terminalShellPath, current.terminalShellPath)
  };

  db.prepare(
    `UPDATE app_settings
      SET tool_provider_id = ?,
        tool_model_id = ?,
        tool_reasoning_effort = ?,
        appearance_accent = ?,
        appearance_surface = ?,
        appearance_ink = ?,
        appearance_success = ?,
        appearance_danger = ?,
        brand_logo_data_url = ?,
        brand_main_title = ?,
        brand_subtitle = ?,
        language = ?,
        working_notification_mode = ?,
        working_notification_include_details = ?,
        permission_mode = ?,
        file_change_tracking_mode = ?,
        skill_editor_path = ?,
        terminal_shell_path = ?,
        updated_at = ?
      WHERE id = 'default'`
  ).run(
    next.providerId,
    next.modelId,
    next.reasoningEffort,
    next.accent,
    next.surface,
    next.ink,
    next.success,
    next.danger,
    next.logoDataUrl,
    next.mainTitle,
    next.subtitle,
    next.language,
    next.workingNotificationMode,
    next.workingNotificationIncludeDetails ? 1 : 0,
    next.permissionMode,
    next.fileChangeTrackingMode,
    next.skillEditorPath ?? null,
    next.terminalShellPath ?? null,
    timestamp
  );
}

function mapAppSettings(row: AppSettingsRow): AppSettings {
  return {
    toolModel: {
      providerId: row.tool_provider_id || "deepseek",
      modelId: row.tool_model_id || "deepseek-v4-flash",
      reasoningEffort: row.tool_reasoning_effort || "off",
      updatedAt: row.updated_at
    },
    appearance: {
      accent: normalizeColor(row.appearance_accent, DEFAULT_APPEARANCE.accent),
      surface: normalizeColor(row.appearance_surface, DEFAULT_APPEARANCE.surface),
      ink: normalizeColor(row.appearance_ink, DEFAULT_APPEARANCE.ink),
      success: normalizeColor(row.appearance_success, DEFAULT_APPEARANCE.success),
      danger: normalizeColor(row.appearance_danger, DEFAULT_APPEARANCE.danger),
      updatedAt: row.updated_at
    },
    brand: {
      logoDataUrl: normalizeLogoDataUrl(row.brand_logo_data_url, DEFAULT_BRAND_SETTINGS.logoDataUrl),
      mainTitle: normalizeRequiredText(row.brand_main_title, DEFAULT_BRAND_SETTINGS.mainTitle, DEFAULT_BRAND_SETTINGS.mainTitle),
      subtitle: normalizeOptionalText(row.brand_subtitle, DEFAULT_BRAND_SETTINGS.subtitle, DEFAULT_BRAND_SETTINGS.subtitle),
      updatedAt: row.updated_at
    },
    language: normalizeLanguage(row.language, "en"),
    workingNotifications: {
      mode: normalizeWorkingNotificationMode(row.working_notification_mode, "background"),
      includeDetails: row.working_notification_include_details !== 0
    },
    permissionMode: normalizePermissionMode(row.permission_mode, "ask"),
    fileChangeTrackingMode: normalizeFileChangeTrackingMode(row.file_change_tracking_mode, "managed-tools-only"),
    skillEditorPath: normalizeOptionalPath(row.skill_editor_path, undefined),
    terminalShellPath: normalizeTerminalShellPath(row.terminal_shell_path, undefined)
  };
}

function normalizeColor(value: string | undefined, fallback: string): string {
  const candidate = value?.trim();
  return candidate && /^#[0-9a-fA-F]{6}$/.test(candidate) ? candidate.toLowerCase() : fallback;
}

function normalizeLanguage(value: string | undefined, fallback: AppLanguage): AppLanguage {
  return value === "zh" || value === "en" ? value : fallback;
}

function normalizeLogoDataUrl(value: string | null | undefined, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  const candidate = value.trim();
  return candidate && isSupportedBrandLogoDataUrl(candidate) ? candidate : fallback;
}

function normalizeRequiredText(value: string | null | undefined, fallback: string, defaultValue: string): string {
  if (value === undefined) return fallback;
  const candidate = value?.trim() ?? "";
  return candidate || defaultValue;
}

function normalizeOptionalText(value: string | null | undefined, fallback: string, defaultValue: string): string {
  if (value === undefined) return fallback;
  const candidate = value?.trim();
  return candidate ?? defaultValue;
}

function normalizeOptionalPath(value: string | null | undefined, fallback: string | undefined): string | undefined {
  if (value === undefined) return fallback;
  const candidate = value?.trim();
  return candidate || undefined;
}

function normalizeWorkingNotificationMode(
  value: string | null | undefined,
  fallback: "background" | "always" | "never"
): "background" | "always" | "never" {
  return value === "background" || value === "always" || value === "never" ? value : fallback;
}

function normalizePermissionMode(value: string | null | undefined, fallback: PermissionMode): PermissionMode {
  return value === "ask" || value === "full-access" ? value : fallback;
}

function normalizeFileChangeTrackingMode(
  value: string | null | undefined,
  fallback: AppSettings["fileChangeTrackingMode"]
): AppSettings["fileChangeTrackingMode"] {
  return value === "managed-tools-only" || value === "watcher" ? value : fallback;
}

function normalizeTerminalShellPath(value: string | null | undefined, fallback: string | undefined): string | undefined {
  const candidate = normalizeOptionalPath(value, fallback);
  if (!candidate || isWindowsBashLauncherPath(candidate)) return undefined;
  return candidate;
}
