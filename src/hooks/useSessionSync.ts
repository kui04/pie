/**
 * Keeps the session charts in step with the conversations of the connection.
 *
 * The charts belong to the connection, not to the screen: a conversation that nobody
 * shows still consumes its records, so a run continues while another conversation is in
 * view, and the screen that selects it later shows it as it is. The effect has no cleanup
 * of its own - leaving a screen does not end a conversation - and it is idempotent, which
 * is what the double mount of StrictMode needs.
 */

import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { connectionQueries } from "@/lib/query";
import { syncSessions, type SessionKey } from "@/lib/session";

export function useSessionSync(): void {
    const connection = useQuery(connectionQueries.current());
    const client = useQueryClient();

    // `undefined` is a read that has not answered yet: the registry keeps what it holds. A
    // connection that is gone answers `null`, and its conversations are gone with it.
    const keys = useMemo<SessionKey[] | null>(() => {
        const held = connection.data;
        if (held === undefined) return null;
        if (held === null) return [];
        return held.sessions.map((session) => ({ host: held.id, session: session.path }));
    }, [connection.data]);

    useEffect(() => {
        if (keys === null) return;
        syncSessions(keys, client);
    }, [keys, client]);
}
