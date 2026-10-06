/**
 * The connection that pie holds, for the screens that follow the gate.
 *
 * The machine that opened the connection dies with the connect screen. The
 * workspace reads the session it subscribes to from Rust instead: TanStack Query
 * owns command-style reads (`.agents/rules/state.md`), and Rust is the source of
 * truth, so a reload of the webview reads the same connection.
 *
 * `null` is a normal answer. The window may open on the workspace with no
 * connection, and that is not a failure.
 */

import { useQuery } from "@tanstack/react-query";
import { connectionQueries } from "@/lib/query";

export function useConnection() {
    return useQuery(connectionQueries.current());
}
