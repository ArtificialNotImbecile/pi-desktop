import type { BrandSettings } from "./ipc.js";

export const MAX_BRAND_LOGO_DATA_URL_LENGTH = 2_000_000;
export const MAX_BRAND_TITLE_LENGTH = 80;
export const MAX_BRAND_SUBTITLE_LENGTH = 180;

export const DEFAULT_BRAND_SETTINGS: BrandSettings = {
  logoDataUrl: null,
  mainTitle: "Talk to yourself.",
  subtitle: "Jasmine listens. Jasmine learns. Jasmine becomes yours.",
  updatedAt: ""
};

export const LEGACY_HIRI_BRAND_COPY = {
  mainTitle: "有什么需要帮忙的？",
  subtitle: "一个想法、半句话、一段粘贴——剩下交给 Hiri One。"
} as const;

export function usesDefaultBrandCopy(brand: Pick<BrandSettings, "mainTitle" | "subtitle">): boolean {
  return brand.mainTitle === DEFAULT_BRAND_SETTINGS.mainTitle && brand.subtitle === DEFAULT_BRAND_SETTINGS.subtitle;
}

export function normalizeLegacyBrandSettings(brand: BrandSettings): BrandSettings {
  if (brand.mainTitle !== LEGACY_HIRI_BRAND_COPY.mainTitle || brand.subtitle !== LEGACY_HIRI_BRAND_COPY.subtitle) return brand;
  return {
    ...brand,
    mainTitle: DEFAULT_BRAND_SETTINGS.mainTitle,
    subtitle: DEFAULT_BRAND_SETTINGS.subtitle
  };
}

export function isSupportedBrandLogoDataUrl(value: string): boolean {
  return /^data:image\/(?:png|jpe?g|webp|gif|bmp);base64,[a-zA-Z0-9+/=]+$/.test(value);
}
