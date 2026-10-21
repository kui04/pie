/**
 * The connection, watched for the whole run of the window.
 *
 * One listener on the connection channel, held here and nowhere else: the gate listens for
 * the two events of its own dial, and this is the app's ear for the one fact no command
 * reports - the connection ended. It outlives every screen, because a lost connection is not a
 * page's business: the overlay stands over whichever page is up.
 *
 * The machine and this hook are separate on purpose: the graph is walkable without a Tauri
 * runtime (`machines/__tests__`), and this is where a real window is joined to it.
 *
 * It is rendered inside the router, so that `Go to the gate` can be a navigation, and so can
 * the way back to the gate that a window with no connection at all takes.
 */

import { useCallback, useEffect, useMemo } from "react";
import { useNavigate, useLocation } from "react-router";
import { useMachine } from "@xstate/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
    connectionWatchMachine,
    type ConnectionWatchDeps,
    type ConnectionWatchState,
} from "@/machines/connection-watch.machine";
import { subscribeToReachFailures } from "@/lib/connection-health";
import { connectionQueries } from "@/lib/query";
import * as bridge from "@/lib/bridge";

/** The state the overlay draws, and the two answers it offers. */
export interface ConnectionWatch {
    state: ConnectionWatchState;
    /** The machine pie reached: `user@host:port`, or `local`. */
    endpoint: string;
    /** What a dial that failed said, or `null`. */
    message: string | null;
    /** Dials the machine again with what Rust holds. */
    retry: () => void;
    /** Leaves the workspace for the gate. */
    leave: () => void;
}

export function useConnectionWatch(): ConnectionWatch {
    const client = useQueryClient();
    const navigate = useNavigate();
    const { pathname } = useLocation();
    const connection = useQuery(connectionQueries.current());
    const { refetch } = connection;

    const deps = useMemo<ConnectionWatchDeps>(
        () => ({
            reconnect: async () => {
                await bridge.reconnect();
                // The reads of the app are keyed on the connection: a new one is a new
                // answer to `get_connection`, and the session charts follow it.
                await client.invalidateQueries({ queryKey: ["connection"] });
            },
        }),
        [client],
    );

    const [snapshot, send] = useMachine(connectionWatchMachine, { input: deps });

    // Rust says when the reach ends. Nothing else does: no command need be in flight when a
    // network goes away, so no failed read can be read as this.
    useEffect(() => {
        let unlisten: bridge.Unsubscribe | undefined;
        let stopped = false;
        void (async () => {
            try {
                unlisten = await bridge.onConnectionState(bridge.CONNECTION_ID, (state) => {
                    if (state.type === "ended") send({ type: "LOST", at: Date.now() });
                });
                if (stopped) unlisten();
            } catch (thrown) {
                // Without the listener, the end of a reach goes unheard and the window sits
                // on a dead connection with nothing to say. The log is the only place left.
                bridge.log.warn("the end of a reach cannot be heard", {
                    reason: bridge.asPieError(thrown).message,
                });
            }
        })();
        return () => {
            stopped = true;
            unlisten?.();
        };
    }, [send]);

    // The answer of the connection read decides, whichever reason made it arrive: `open` is the
    // reach answering, and a closed one is the end of the connection - the same news as Rust's
    // own `ended`, at the moment the first failed read asked for it. The clock is the read's
    // `dataUpdatedAt`, the one the machine keeps.
    useEffect(() => {
        const at = connection.dataUpdatedAt;
        if (connection.data == null) return;
        if (connection.data.open) {
            send({ type: "RESTORED", at });
            return;
        }
        send({ type: "LOST", at });
    }, [connection.data, connection.dataUpdatedAt, send]);

    // A read that failed against the reach is the earliest news of a connection that ended: the
    // reads fail the moment the link goes, and the watch that ticks behind them is a tick late.
    // The failure is not trusted as a verdict - it can have another reason - so this asks Rust,
    // and the answer above is what decides.
    useEffect(() => subscribeToReachFailures(() => void refetch()), [refetch]);

    // A window with no connection at all is not a page to sit on: the gate is where one is made.
    // This belongs to the boundary and not to a page - the same place that veils a lost
    // connection is what sends a window with none back to where one is made, and no screen has a
    // reason of its own to know the difference.
    //
    // The read is asked again before the decision, and the fresh answer decides. The gate dials a
    // connection and then sends the window here, so the answer of the moment before that dial says
    // there is none - and this boundary is mounted for the whole run, so it is not a mount that
    // would have read it again. A cached answer is not the truth of the app.
    useEffect(() => {
        if (pathname === "/") return;
        if (connection.isPending) return;
        if (connection.data !== null && connection.data !== undefined) return;
        let cancelled = false;
        void (async () => {
            const answer = await refetch();
            if (cancelled) return;
            if (answer.data !== null && answer.data !== undefined) return;
            bridge.log.info("there is no connection, so the window returns to the gate", {
                reason: answer.error ? bridge.asPieError(answer.error).message : "no connection is held",
            });
            navigate("/", { replace: true });
        })();
        return () => {
            cancelled = true;
        };
    }, [connection.data, connection.isPending, navigate, pathname, refetch]);

    const retry = useCallback(() => send({ type: "RETRY" }), [send]);
    const leave = useCallback(() => {
        send({ type: "LEAVE" });
        navigate("/", { replace: true });
    }, [navigate, send]);

    return {
        state: snapshot.value as ConnectionWatch["state"],
        endpoint: connection.data?.endpoint ?? "the host",
        message: snapshot.context.message,
        retry,
        leave,
    };
}
