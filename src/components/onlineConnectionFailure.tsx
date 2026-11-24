import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConnectionInfo } from "~/lib/network";

export default function OnlineConnectionFailure({ connection }: { connection: ConnectionInfo }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  if (!connection?.connectionFailure) return null;
  const report = [
    "Hanab online connection report",
    `Status: ${connection.status}; connected peers: ${connection.peers.length}`,
    `Stage: ${connection.connectionFailure.stage}`,
    connection.connectionFailure.message,
  ].join("\n");
  return (
    <div className="mt3 tl">
      <p>{t("onlineFailure.help")}</p>
      <p>{t("onlineFailure.android")}</p>
      <details>
        <summary className="pointer">{t("onlineFailure.details")}</summary>
        <textarea readOnly aria-label={t("onlineFailure.details")} className="w-100 mt2" rows={6} value={report} />
        <button
          className="mt2"
          type="button"
          onClick={async () => {
            setCopied(false);
            try {
              await navigator.clipboard.writeText(report);
              setCopied(true);
            } catch {
              // The selectable report remains available when clipboard access is denied.
            }
          }}
        >
          {t("copy")}
        </button>
        {copied && (
          <span className="ml2" role="status">
            {t("copied")}
          </span>
        )}
      </details>
    </div>
  );
}
