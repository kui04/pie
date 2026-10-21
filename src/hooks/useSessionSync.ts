/**
 * Keeps the session actors in step with the sessions of the connection.
 *
 * The charts belong to the connection, not to the screen: a session that nobody shows still
 * consumes its records, so a run continues while another conversation is in view, and the
 * screen that selects it later shows it as it is. The effect has no cleanup of its own -
 * leaving a screen does not end a session - and it is idempotent, which is what the double
 * mount of StrictMode needs.
 */

import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { connectionQueries } from "@/lib/query";
import { syncSessions } from "@/lib/session";

export function useSessionSync(): void {
    const connection = useQuery(connectionQueries.current());
    const client = useQueryClient();

    // `undefined` is a read that has not answered yet: the registry keeps what it holds. A
    // connection that is gone answers `null`, and its sessions are gone with it.
    const ids = useMemo(
        () => (connection.data === undefined ? null : (connection.data?.sessions.map((session) => session.id) ?? [])),
        [connection.data],
    );

    useEffect(() => {
        if (ids === null) return;
        syncSessions(ids, client);
    }, [ids, client]);
}
