import React, { useEffect } from "react";
import LoadingScreen from "~/components/loadingScreen";
import { resetPlayerId } from "~/lib/playerId";
import { withBasePath } from "~/lib/routes";

/**
 * Forget this browser's player id, then go home. A full page load (rather
 * than a client-side navigation) makes the whole app pick up the new id.
 */
export default function ResetSession() {
  useEffect(() => {
    resetPlayerId();
    window.location.replace(withBasePath("/"));
  }, []);

  return <LoadingScreen />;
}
