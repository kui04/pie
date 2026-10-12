import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMachine } from "@xstate/react";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { useConnection } from "@/hooks/use-connection";
import { useWideWindow } from "@/hooks/use-wide-window";

import { chatMachine, errorOf, sessionOf, stageOf, type ChatDeps } from "@/machines/chat.machine";
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
            attach: async () => {
                await bridge.attachSession();
                await client.invalidateQueries({ queryKey: ["connection"] });
            },
        }),
        [client],
    );
    const [chat, , machine] = useMachine(chatMachine, { input: deps });
    const stage = stageOf(chat);
    const session = sessionOf(chat);
    const detached = errorOf(chat);
    // A connection holds one session, so the one in the list is the one.
    const held = connection.data?.sessions[0] ?? null;
    const endpoint = connection.data?.endpoint ?? "local";

    // A workspace with no host is not a workspace: the gate is where a connection
    // is made, so the window returns to it rather than sit on a page no command can
    // answer. The read is fresh on every mount (`connectionQueries.current`), so
    // this is also where a reload that finds the connection gone lands. The wait
    // for the read is what keeps the answer of the gate from bouncing back here:
    // the visit after a connect may find the `null` it cached before the connect.
    useEffect(() => {
        if (connection.isPending || connection.isFetching) return;
        if (connection.data !== null && connection.data !== undefined) return;
        bridge.log.info("the workspace has no connection, so the window returns to the gate", {
            reason: connection.isError ? bridge.asPieError(connection.error).message : "no connection is held",
        });
        navigate("/", { replace: true });
    }, [connection.isPending, connection.isFetching, connection.data, connection.isError, connection.error, navigate]);

    // Whether the workspace has to start pi is Rust's answer, not this screen's
    // guess: the read of the connection shows the session of a pi that is already
    // speaking (a reload of the webview), and no session when the machine was only
    // reached. The chart ignores a second ATTACH, so a pass of this effect over a
    // stage that is already starting one costs nothing.
    useEffect(() => {
        if (connection.data === null || connection.data === undefined) return;
        machine.send(held === null ? { type: "ATTACH" } : { type: "HELD" });
    }, [connection.data, held, machine]);

    // The sheet is a narrow window's way to the list; the column is a wide one's.
    // Pure UI, so the two live here, above both stages that draw a list.
    const [sheet, setSheet] = useState(false);
    const [column, setColumn] = useState(true);
    const toggleSessions = () => (wide ? setColumn((open) => !open) : setSheet(true));

    // What the list shows while no conversation is open: the file pi holds, so the
    // row it belongs to is the one in use, and a pick of it needs no switch (pi
    // reloads the conversation it is asked for, even when it is already the one).
    const heldState = useQuery({
        ...sessionQueries.state(held?.id ?? ""),
        enabled: stage === "landing" && held !== null,
    });

    // Which stage the window reached, and for which conversation: the shape of a
    // report about a window that would not open, where nothing else on this side
    // of the boundary says how far it got.
    useEffect(() => {
        bridge.log.info("the window is at a stage", { stage, session });
    }, [stage, session]);

    /**
     * Opens a session from the landing.
     *
     * The feed of the screen is not open yet, so the switch is asked for here: the
     * chart of a session takes a switch only while it lives (`session.machine.ts`),
     * and nothing lives before a conversation is chosen.
     */
    async function open(path: string) {
        setSheet(false);
        if (held === null) return;
        const heldFile = heldState.data?.sessionFile ?? null;
        try {
            bridge.log.info("a conversation was picked from the landing", { path, held: heldFile });
            if (path !== heldFile) await bridge.switchSession(held.id, path);
            machine.send({ type: "OPEN", session: held.id });
        } catch (thrown) {
            const error = bridge.asPieError(thrown);
            bridge.log.error("the conversation could not be opened", { path, reason: error.message });
            toast.error(error.message);
        }
    }

    if (connection.isPending) return <ChatFrame />;
    if (connection.data === null || connection.data === undefined) return <ChatFrame />;
    if (stage === "attaching") {
        return (
            <ChatFrame bodyClassName="items-center justify-center">
                <SessionLoading label="Starting pi…" />
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

    if (held === null || stage === "landing") {
        return (
            <SessionLanding
                list={{
                    endpoint,
                    currentSessionId: heldState.data?.sessionId ?? null,
                    working: false,
                    busy: false,
                    onPick: (path: string) => void open(path),
                }}
                wide={wide}
                column={column}
                sheet={sheet}
                onOpenSheet={setSheet}
                onToggleSessions={toggleSessions}
            />
        );
    }
    return (
        <SessionMain
            key={session ?? held.id}
            machine={machine}
            session={session ?? held.id}
            cwd={held.cwd}
            endpoint={endpoint}
            wide={wide}
            column={column}
            sheet={sheet}
            onOpenSheet={setSheet}
            onToggleSessions={toggleSessions}
            client={client}
        />
    );
}
