import React from "react";
import { useTranslation } from "react-i18next";
import { Select } from "~/components/ui/forms";
import { logFailedPromise } from "~/lib/errors";
import { setLanguage } from "~/lib/i18n";

export const Languages = {
  en: "English",
  fr: "Français",
  es: "Español",
  it: "Italiano",
  nl: "Dutch",
  ru: "Russian",
  pt: "Português",
  de: "Deutsch",
  sk: "Slovenčina",
  zh: "简体中文",
};

interface Props {
  outlined?: boolean;
}

export default function LanguageSelector(props: Props) {
  const { outlined = false } = props;

  const { t, i18n } = useTranslation();

  const languages = {
    ...Languages,
    new: `🎁 ${t("contributeLanguage")}`,
  };
  const current = (i18n.languages || []).find((language) => language in Languages) || "en";

  return (
    <label title={t("selectLanguage")}>
      <Select
        options={languages}
        outlined={outlined}
        value={current}
        onChange={(e) => {
          if (e.target.value === "new") {
            window.open("https://github.com/bstnfrmry/hanabi/issues/180", "_blank").focus();
            return;
          }

          setLanguage(e.target.value).catch(logFailedPromise);
        }}
      />
    </label>
  );
}
