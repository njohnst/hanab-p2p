import React, { useContext } from "react";
import { ConnectionInfo } from "~/lib/network";

/** The game page's connection to its peer-to-peer room (provided by GameIndex). */
export const ConnectionContext = React.createContext<ConnectionInfo | null>(null);

export function useConnection(): ConnectionInfo | null {
  return useContext(ConnectionContext);
}
