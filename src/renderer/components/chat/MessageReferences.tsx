import { createContext, useContext, useState, type ReactNode } from "react";
import { getBridge } from "../../desktopApi";
import { useI18n } from "../../i18n";
import { ImageLightbox } from "./ImageLightbox";
import { useLocalFileDescription } from "./localFileStore";
import { fileBadge, fileCategory, fileDirectory, fileLineLabel, fileName, localFileSrc } from "./messageLinks";
import { credentialSafeText, sanitizedHttpUrl } from "./safeDisplay";

/**
 * Whether references in this Markdown root may resolve themselves yet. The
 * active chunk of a streaming answer holds a half-written path, so asking the
 * main process about it would be one wasted lookup per token and would briefly
 * render a real-looking "file not found" for a path still being typed.
 */
type ReferenceResolutionValue = {
  settled: boolean;
  scope: object;
};

const ReferenceResolutionContext = createContext<ReferenceResolutionValue>({
  settled: true,
  scope: {}
});

export function ReferenceResolution(props: { settled: boolean; children: ReactNode }) {
  const [scope] = useState<object>(() => ({}));
  return (
    <ReferenceResolutionContext.Provider value={{ settled: props.settled, scope }}>
      {props.children}
    </ReferenceResolutionContext.Provider>
  );
}

export function MessageExternalLink(props: { href: string; children: ReactNode }) {
  const { t } = useI18n();
  const [actionError, setActionError] = useState<string | null>(null);
  const safeDisplayHref = /^https?:/i.test(props.href)
    ? sanitizedHttpUrl(props.href)
    : credentialSafeText(props.href);
  const rawLinkText = typeof props.children === "string" ? props.children.trim() : "";
  const destinationText = props.href.trim();
  const isDestinationLabel = rawLinkText === destinationText
    || (/^mailto:/i.test(destinationText) && rawLinkText === destinationText.replace(/^mailto:/i, ""));
  const visibleChildren = isDestinationLabel
    ? (safeDisplayHref || t("message.openLink"))
    : (props.children || safeDisplayHref || t("message.openLink"));
  return (
    <a
      className="message-link"
      href={safeDisplayHref || undefined}
      title={safeDisplayHref || undefined}
      onClick={(event) => {
        // DOM attributes expose only a credential-safe display URL. The full
        // destination stays in this handler closure for the explicit open.
        event.preventDefault();
        setActionError(null);
        void getBridge().openExternalUrl(props.href).catch(() => {
          setActionError(t("message.linkOpenFailed"));
        });
      }}
    >
      {visibleChildren}
      <span className="message-link-mark" aria-hidden="true">↗</span>
      {actionError && <span className="message-link-error" aria-live="polite">{actionError}</span>}
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
  const { settled, scope } = useContext(ReferenceResolutionContext);
  const description = useLocalFileDescription(props.path, settled, scope);
  const [actionError, setActionError] = useState<string | null>(null);
  const resolvedPath = description?.path ?? props.path;
  const displayPath = credentialSafeText(resolvedPath);
  const missing = description ? !description.exists : false;
  const isDirectory = description?.kind === "directory";
  const rawName = description?.name || fileName(props.path) || props.path;
  const name = credentialSafeText(rawName) || t(isDirectory ? "message.openFolder" : "message.openFile");
  const directory = displayPath ? fileDirectory(displayPath) : "";
  const badge = fileBadge(props.path, isDirectory);
  const lineLabel = fileLineLabel(props.line);
  const stateText = missing ? t("message.fileMissing") : actionError;

  return (
    <button
      type="button"
      className="file-reference"
      data-category={isDirectory ? "folder" : fileCategory(props.path)}
      data-missing={missing ? "true" : undefined}
      data-action-error={actionError ? "true" : undefined}
      title={displayPath ? (props.line ? `${displayPath}:${props.line}` : displayPath) : undefined}
      disabled={missing}
      onClick={() => {
        setActionError(null);
        void getBridge().openLocalPath(resolvedPath).catch(() => {
          setActionError(t("message.fileOpenFailed"));
        });
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (missing) return;
        setActionError(null);
        void getBridge().revealLocalPath(resolvedPath).catch(() => {
          setActionError(t("message.fileRevealFailed"));
        });
      }}
    >
      <span className="file-reference-badge" aria-hidden="true">{badge}</span>
      <span className="file-reference-body">
        <span className="file-reference-name">{props.label ?? name}</span>
        {directory && <span className="file-reference-path">{directory}</span>}
      </span>
      {lineLabel && <span className="file-reference-line" aria-hidden="true">{lineLabel}</span>}
      {stateText && <span className="file-reference-state" aria-live="polite">{stateText}</span>}
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
  const { settled, scope } = useContext(ReferenceResolutionContext);
  const description = useLocalFileDescription(props.path, settled, scope);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState(false);

  if (!description) {
    return <span className="message-image-placeholder" aria-hidden="true" />;
  }
  if (failed || !description.exists || !description.isImage) {
    return <MessageFileReference path={props.path} label={props.alt || undefined} />;
  }

  const source = localFileSrc(description.path);
  return (
    <>
      <button
        type="button"
        className="message-image"
        aria-label={props.alt ? undefined : t("message.openImage")}
        onClick={() => setPreview(true)}
      >
        <img src={source} alt={props.alt} onError={() => setFailed(true)} />
      </button>
      {props.alt && <span className="message-image-caption">{props.alt}</span>}
      {preview && (
        <ImageLightbox
          src={source}
          name={credentialSafeText(description.name) || t("message.openImage")}
          onClose={() => setPreview(false)}
        />
      )}
    </>
  );
}
