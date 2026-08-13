import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { AppLanguage } from "../shared/ipc";
import { translate, type Translate } from "../shared/i18n";

// The strings themselves live in shared/i18n so Electron main can translate the
// text it owns -- OS notifications -- with the same table. This file is only the
// React binding.
export { translate } from "../shared/i18n";
export type { I18nKey } from "../shared/i18n";

type I18nContextValue = {
  language: AppLanguage;
  t: Translate;
};

const I18nContext = createContext<I18nContextValue>({
  language: "en",
  t: translate("en")
});

export function I18nProvider(props: { language: AppLanguage; children: ReactNode }) {
  const language: AppLanguage = props.language === "zh" ? "zh" : "en";
  const value = useMemo(() => ({ language, t: translate(language) }), [language]);
  return (
    <I18nContext.Provider value={value}>
      {props.children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
