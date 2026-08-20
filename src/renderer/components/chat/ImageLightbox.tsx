import { useEffect } from "react";
import { useI18n } from "../../i18n";

// Takes a source rather than an attachment: composer previews arrive as data
// URLs, while images inside an answer are served over the local-file protocol.
export function ImageLightbox(props: { src: string; name: string; onClose(): void }) {
  const { t } = useI18n();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") props.onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.onClose]);

  return (
    <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={props.name} onMouseDown={props.onClose}>
      <div className="image-lightbox-frame" onMouseDown={(event) => event.stopPropagation()}>
        <button type="button" onClick={props.onClose} aria-label={t("message.closeImagePreview")}>x</button>
        <img src={props.src} alt={props.name} />
        <span>{props.name}</span>
      </div>
    </div>
  );
}
