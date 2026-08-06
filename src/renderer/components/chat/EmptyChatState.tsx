import type { BrandSettings } from "../../../shared/ipc";
import { usesDefaultBrandCopy } from "../../../shared/brand";
import defaultBrandLogo from "../../assets/jasmine-logo.png";
import { useI18n } from "../../i18n";

export function EmptyChatState(props: { brand: BrandSettings }) {
  const { t } = useI18n();
  const logoUrl = props.brand.logoDataUrl || defaultBrandLogo;
  const useLocalizedDefaultCopy = usesDefaultBrandCopy(props.brand);
  return (
    <div className="empty-state">
      <BrandMark logoUrl={logoUrl} />
      <h1>{useLocalizedDefaultCopy ? t("empty.title") : props.brand.mainTitle}</h1>
      <p>{useLocalizedDefaultCopy ? t("empty.subtitle") : props.brand.subtitle}</p>
    </div>
  );
}

function BrandMark(props: { logoUrl: string }) {
  const isDefaultLogo = props.logoUrl === defaultBrandLogo;
  return (
    <span className="brand-mark-shell" aria-hidden="true">
      <img className="brand-mark" src={props.logoUrl} alt="" />
      {isDefaultLogo ? <span className="jasmine-mark-core" /> : null}
    </span>
  );
}
