import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import { logFailedPromise } from "~/lib/errors";
import { de } from "~/locales/de";
import { en } from "~/locales/en";
import { es } from "~/locales/es";
import { fr } from "~/locales/fr";
import { it } from "~/locales/it";
import { nl } from "~/locales/nl";
import { pt } from "~/locales/pt";
import { ru } from "~/locales/ru";
import { sk } from "~/locales/sk";
import { zh } from "~/locales/zh";

/** localStorage key holding the language the player picked in the language selector. */
const LANGUAGE_STORAGE_KEY = "i18nextLng";

const resources = {
  en: { translation: en },
  fr: { translation: fr },
  es: { translation: es },
  it: { translation: it },
  nl: { translation: nl },
  ru: { translation: ru },
  pt: { translation: pt },
  de: { translation: de },
  sk: { translation: sk },
  zh: { translation: zh },
};

/**
 * Pages are pre-rendered in English at build time, so i18n starts in English
 * everywhere (keeping hydration consistent) and switches to the detected
 * language once the app is mounted (see detectLanguage).
 */
i18n
  .use(initReactI18next)
  .use(LanguageDetector)
  .init({
    resources,
    lng: "en",
    fallbackLng: "en",
    supportedLngs: Object.keys(resources),
    detection: {
      // An explicit choice (persisted by setLanguage) wins over the browser's languages.
      order: ["localStorage", "navigator"],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      // Only setLanguage persists: don't pin the auto-detected browser language.
      caches: [],
    },
    interpolation: {
      escapeValue: false,
    },
  })
  .catch(logFailedPromise);

/** Switch to the language detected from localStorage (explicit choice) or the browser. Client-side only. */
export function detectLanguage() {
  return i18n.changeLanguage();
}

/** Switch language and remember the choice in this browser. */
export async function setLanguage(language: string) {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch (e) {
    console.warn("[i18n] could not persist the language", e);
  }

  await i18n.changeLanguage(language);
}

export { i18n };
