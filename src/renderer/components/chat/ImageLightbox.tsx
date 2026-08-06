import { useEffect } from "react";
import type { PickedPath } from "../../../shared/ipc";
import { useI18n } from "../../i18n";

export function ImageLightbox(props: { attachment: PickedPath; onClose(): void }) {
  const { t } = useI18n();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") props.onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.onClose]);

  return (
    <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={props.attachment.name} onMouseDown={props.onClose}>
      <div className="image-lightbox-frame" onMouseDown={(event) => event.stopPropagation()}>
        <button type="button" onClick={props.onClose} aria-label={t("message.closeImagePreview")}>x</button>
        <img src={props.attachment.previewDataUrl ?? ""} alt={props.attachment.name} />
        <span>{props.attachment.name}</span>
      </div>
    </div>
  );
}
