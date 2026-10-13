import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMachine } from "@xstate/react";
import { Button } from "@/components/ui";
import { useConnection } from "@/hooks/use-connection";
import { useWideWindow } from "@/hooks/use-wide-window";

import { chatMachine, errorOf, pathOf, sessionOf, stageOf, type ChatDeps } from "@/machines/chat.machine";
import { sessionQueries } from "@/lib/query";
import * as bridge from "@/lib/bridge";
import { ChatFrame } from "@/routes/chat/ChatFrame";
import { SessionLanding } from "@/routes/chat/SessionLanding";
import { SessionLoading } from "@/routes/chat/SessionLoading";
import { SessionMain } from "@/routes/chat/SessionMain";

export function ChatScreen() {
    const connection = useConnection();
    const client = useQueryClient();
    const wide = useWideWindow();
    const navigate = useNavigate();

    const deps = useMemo<ChatDeps>(
        () => ({
            attach: async (path) => {
                const info = await bridge.attachSession(path ?? undefined);
                await client.invalidateQueries({ queryKey: ["connection"] });
                return info;
            },
            detach: async (session) => {
                await bridge.detachSession(session);
                await client.invalidateQueries({ queryKey: ["connection"] });
            },
        }),
        [client],
    );
    const [chat, , machine] = useMachine(chatMachine, { input: deps });
    const stage = stageOf(chat);
    const session = sessionOf(chat);
    const loading = pathOf(chat);
    const detached = errorOf(chat);
    // A connection holds one session today, so the one in the list is the one.
    const held = connection.data?.sessions[0] ?? null;
    const endpoint = connection.data?.endpoint ?? "local";

    // A workspace with no host is not a workspace: the gate is where a connection is made,
    // so the window returns to it rather than sit on a page no command can answer. The read
    // is fresh on every mount (`connectionQueries.current`), so this is also where a reload
    // that finds the connection gone lands.
    useEffect(() => {
        if (connection.isPending || connection.isFetching) return;
        if (connection.data !== null && connection.data !== undefined) return;
        bridge.log.info("the workspace has no connection, so the window returns to the gate", {
            reason: connection.isError ? bridge.asPieError(connection.error).message : "no connection is held",
        });
        navigate("/", { replace: true });
    }, [connection.isPending, connection.isFetching, connection.data, connection.isError, connection.error, navigate]);

    // The sheet is a narrow window's way to the list; the column is a wide one's.
    // Pure UI, so the two live here, above both stages that draw a list.
    const [sheet, setSheet] = useState(false);
    const [column, setColumn] = useState(true);
    const toggleSessions = () => (wide ? setColumn((open) => !open) : setSheet(true));

    // What the landing shows while no conversation is open: the file pi holds, so the row it
    // belongs to is the one in use, and a pick of it views the session that already speaks
    // (no second process is started for the conversation pi holds).
    const heldState = useQuery({
        ...sessionQueries.state(held?.id ?? ""),
        enabled: stage === "landing" && held !== null,
    });

    // Which stage the window reached, and for which conversation: the shape of a report
    // about a window that would not open, where nothing else on this side of the boundary
    // says how far it got.
    useEffect(() => {
        bridge.log.info("the window is at a stage", { stage, session });
    }, [stage, session]);

    /**
     * Opens a conversation from the landing: the session that holds it, or a new one on the
     * file. A session is one process with one conversation, so the process that was held is
     * ended when the new one answers.
     */
    function open(path: string) {
        setSheet(false);
        if (held !== null && heldState.data?.sessionFile === path) {
            bridge.log.info("the conversation is the one pi already holds", { path, session: held.id });
            machine.send({ type: "OPEN", session: held.id });
            return;
        }
        bridge.log.info("a conversation was picked from the landing", { path, held: held?.id ?? null });
        machine.send({ type: "FOCUS", path, dropping: held?.id ?? null });
    }

    /** Opens another conversation of the list, for the session in view. */
    function focus(path: string) {
        setSheet(false);
        machine.send({ type: "FOCUS", path });
    }

    if (connection.isPending) return <ChatFrame />;
    if (connection.data === null || connection.data === undefined) return <ChatFrame />;
    if (stage === "attaching") {
        return (
            <ChatFrame bodyClassName="items-center justify-center">
                <SessionLoading label={loading === null ? "Starting pi…" : "Opening the conversation…"} />
            </ChatFrame>
        );
    }

    if (stage === "unattached" && detached !== null) {
        return (
            <ChatFrame bodyClassName="items-center justify-center">
                <div
                    id="chat-unattached"
                    role="alert"
                    className="text-body-md text-muted-foreground m-auto flex max-w-prose flex-col items-center gap-3 px-6 text-center"
                >
                    <p>{detached.message}</p>
                    <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => machine.send({ type: "RETRY" })}>
                            Try again
                        </Button>
                        <Button asChild variant="ghost" size="sm">
                            <Link to="/">Connect</Link>
                        </Button>
                    </div>
                </div>
            </ChatFrame>
        );
    }

    if (stage === "viewing" && session !== null) {
        return (
            <SessionMain
                key={session}
                session={session}
                cwd={held?.cwd ?? null}
                endpoint={endpoint}
                wide={wide}
                column={column}
                sheet={sheet}
                onOpenSheet={setSheet}
                onToggleSessions={toggleSessions}
                onFocus={focus}
                client={client}
            />
        );
    }

    return (
        <SessionLanding
            list={{
                endpoint,
                currentSessionId: heldState.data?.sessionId ?? null,
                working: false,
                busy: false,
                onPick: open,
            }}
            wide={wide}
            column={column}
            sheet={sheet}
            onOpenSheet={setSheet}
            onToggleSessions={toggleSessions}
        />
    );
}
