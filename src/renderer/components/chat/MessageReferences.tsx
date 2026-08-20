import { createContext, useContext, useState, type ReactNode } from "react";
import { getBridge } from "../../desktopApi";
import { useI18n } from "../../i18n";
import { ImageLightbox } from "./ImageLightbox";
import { useLocalFileDescription } from "./localFileStore";
import { fileBadge, fileCategory, fileDirectory, fileLineLabel, fileName, localFileSrc } from "./messageLinks";

/**
 * Whether references in this Markdown root may resolve themselves yet. The
 * active chunk of a streaming answer holds a half-written path, so asking the
 * main process about it would be one wasted lookup per token and would briefly
 * render a real-looking "file not found" for a path still being typed.
 */
const ReferenceResolutionContext = createContext(true);

export function ReferenceResolution(props: { settled: boolean; children: ReactNode }) {
  return (
    <ReferenceResolutionContext.Provider value={props.settled}>
      {props.children}
    </ReferenceResolutionContext.Provider>
  );
}

export function MessageExternalLink(props: { href: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <a
      className="message-link"
      href={props.href}
      title={props.href}
      aria-label={t("message.openLink")}
      onClick={(event) => {
        // The href stays on the anchor for hover, copy-link, and accessibility,
        // but the OS browser owns the navigation -- never a window in this app.
        event.preventDefault();
        void getBridge().openExternalUrl(props.href).catch(() => undefined);
      }}
    >
      {props.children}
      <span className="message-link-mark" aria-hidden="true">↗</span>
    </a>
  );
}

/**
 * A local path an answer referenced. Renders as one chip whose leading badge is
 * the file's extension, tinted by broad file family -- enough to tell a
 * spreadsheet from source at a glance without shipping an icon per format.
 *
 * Standalone chips (a paragraph holding nothing else) are widened by CSS into a
 * card that also shows the directory; inline ones stay inside the line.
 */
export function MessageFileReference(props: { path: string; line?: number; label?: ReactNode }) {
  const { t } = useI18n();
  const settled = useContext(ReferenceResolutionContext);
  const description = useLocalFileDescription(props.path, settled);
  const resolvedPath = description?.path ?? props.path;
  const missing = description ? !description.exists : false;
  const isDirectory = description?.kind === "directory";
  const name = description?.name || fileName(props.path) || props.path;
  const directory = fileDirectory(resolvedPath);
  const badge = fileBadge(props.path, isDirectory);
  const lineLabel = fileLineLabel(props.line);

  return (
    <button
      type="button"
      className="file-reference"
      data-category={isDirectory ? "folder" : fileCategory(props.path)}
      data-missing={missing ? "true" : undefined}
      title={props.line ? `${resolvedPath}:${props.line}` : resolvedPath}
      aria-label={isDirectory ? t("message.openFolder") : t("message.openFile")}
      disabled={missing}
      onClick={() => {
        void getBridge().openLocalPath(resolvedPath).catch(() => undefined);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (missing) return;
        void getBridge().revealLocalPath(resolvedPath).catch(() => undefined);
      }}
    >
      <span className="file-reference-badge" aria-hidden="true">{badge}</span>
      <span className="file-reference-body">
        <span className="file-reference-name">{props.label ?? name}</span>
        {directory && <span className="file-reference-path">{directory}</span>}
      </span>
      {lineLabel && <span className="file-reference-line" aria-hidden="true">{lineLabel}</span>}
      {missing && <span className="file-reference-state">{t("message.fileMissing")}</span>}
    </button>
  );
}

/**
 * A local image an answer referenced, shown inline. Anything that cannot
 * actually paint -- a path that does not exist, a format Chromium will not
 * decode, an image too large to be worth decoding, a read that fails -- falls
 * back to the chip rather than leaving a broken image in the transcript.
 */
export function MessageImage(props: { path: string; alt: string }) {
  const { t } = useI18n();
  const settled = useContext(ReferenceResolutionContext);
  const description = useLocalFileDescription(props.path, settled);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState(false);

  if (!description) {
    return <span className="message-image-placeholder" aria-hidden="true" />;
  }
  if (failed || !description.exists || !description.isImage) {
    return <MessageFileReference path={props.path} label={props.alt || fileName(props.path)} />;
  }

  const source = localFileSrc(description.path);
  return (
    <>
      <button
        type="button"
        className="message-image"
        aria-label={t("message.openImage")}
        onClick={() => setPreview(true)}
      >
        <img src={source} alt={props.alt} onError={() => setFailed(true)} />
      </button>
      {props.alt && <span className="message-image-caption">{props.alt}</span>}
      {preview && (
        <ImageLightbox src={source} name={description.name} onClose={() => setPreview(false)} />
      )}
    </>
  );
}
