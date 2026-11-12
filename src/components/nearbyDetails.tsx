import classnames from "classnames";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import CopyButton from "~/components/copyButton";
import Txt, { TxtSize } from "~/components/ui/txt";
import {
  checkCounts,
  formatReport,
  getNetworkMode,
  NearbyDiagnostics,
  NearbyDiagnosticsSource,
  ReportEnvironment,
} from "~/lib/network";

interface Props {
  /** The invitation or the reply whose connection is shown; nothing is rendered without one. */
  source: NearbyDiagnosticsSource | null;
  /** Unfolded from the start (after a failure: that's when it helps). */
  open?: boolean;
  className?: string;
}

/** The status in the summary line: a translation key and its values. */
function summaryOf(d: NearbyDiagnostics): [string, Record<string, unknown>] {
  if (d.stage === "open") return ["nearby.details.status.connected", {}];
  if (d.stage === "closed") return ["nearby.details.status.stopped", {}];
  if (d.iceConnectionState === "failed" || d.connectionState === "failed") return ["nearby.details.status.failed", {}];
  if (d.stage === "preparing") return ["nearby.details.status.preparing", {}];
  if (d.remote === null) return ["nearby.details.status.waiting", {}];
  return ["nearby.details.status.checking", checkCounts(d)];
}

/** The page and browser, for the report's header (read once mounted: pages are pre-rendered). */
function useReportEnvironment(): ReportEnvironment | null {
  const [environment, setEnvironment] = useState<ReportEnvironment>(null);

  useEffect(() => {
    let cancelled = false;
    const known: ReportEnvironment = {
      userAgent: navigator.userAgent,
      secure: window.isSecureContext,
      camera: null,
      mode: getNetworkMode(),
      origin: window.location.origin,
    };
    setEnvironment(known);
    // Not every browser can say (Firefox and Safari may not know "camera").
    try {
      navigator.permissions
        ?.query({ name: "camera" as PermissionName })
        .then((status) => !cancelled && setEnvironment({ ...known, camera: status.state }))
        .catch(() => undefined);
    } catch {
      // No permissions API.
    }

    return () => {
      cancelled = true;
    };
  }, []);

  return environment;
}

/**
 * "Connection details" under a nearby invitation or reply (docs/P2P_DESIGN.md, "Connection
 * details"): folded away, a live summary of how far the connection got, and the report of what
 * each device offered and which checks were answered, with a Copy button so that a player whose
 * devices don't connect can send it to whoever helps them.
 */
export default function NearbyDetails(props: Props) {
  const { source, open = false, className } = props;
  const { t } = useTranslation();
  const environment = useReportEnvironment();
  const [diagnostics, setDiagnostics] = useState<NearbyDiagnostics>(null);

  useEffect(() => {
    if (!source) {
      setDiagnostics(null);
      return;
    }
    setDiagnostics(source.diagnostics());
    return source.onDiagnostics(setDiagnostics);
  }, [source]);

  if (!diagnostics || !environment) {
    return null;
  }

  const [statusKey, values] = summaryOf(diagnostics);
  const report = formatReport(diagnostics, environment);

  return (
    <details className={classnames("nearby-details w-100 tc", className)} open={open}>
      <summary className="lavender pointer">
        <Txt size={TxtSize.SMALL} value={`${t("nearby.details.title")} · ${t(statusKey, values)}`} />
      </summary>
      <Txt className="db gray mt1 mb2" size={TxtSize.XSMALL} value={t("nearby.details.note")} />
      <pre className="nearby-details-report tl br2 pa2 ma0">{report}</pre>
      <div className="flex justify-center mt2">
        <CopyButton text={report} />
      </div>
    </details>
  );
}
