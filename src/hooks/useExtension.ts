/**
 * The extension UI of one session: what an extension asks, and the values it
 * sets without asking.
 *
 * The snapshot is server state (TanStack Query). A request can arrive before the
 * frontend knows the session id, so the listener is not the only source: after it
 * subscribes, the hook reads the snapshot again to recover what the event bus
 * could not replay. A notice is the one value the snapshot cannot carry, because
 * it is a moment rather than a state.
 *
 * A draft of a dialog belongs to the dialog, not here: this hook owns the read
 * and the answer, and the component owns the words the person is typing.
 */

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import * as bridge from "@/lib/bridge";
import { sessionKeys, sessionQueries } from "@/lib/query";

export function useExtension(session: string) {
    const client = useQueryClient();
    const read = useQuery(sessionQueries.extension(session));

    useEffect(() => {
        let stop: (() => void) | undefined;
        let live = true;
        const onEvent = (event: bridge.ExtensionEvent) => {
            if (event.type === "notice") {
                const say =
                    event.notifyType === "error" ? toast.error : event.notifyType === "warning" ? toast.warning : toast;
                say(event.message);
            }
            void client.invalidateQueries({ queryKey: sessionKeys.extension(session) });
        };
        // Subscribe first, then read: a request that arrived before this listener is
        // in the snapshot; one that arrives after it invalidates the read.
        void bridge
            .onExtensionEvent(session, onEvent)
            .then((unsubscribe) => {
                if (!live) {
                    unsubscribe();
                    return;
                }
                stop = unsubscribe;
                void client.invalidateQueries({ queryKey: sessionKeys.extension(session) });
            })
            .catch((thrown: unknown) => {
                bridge.log.warn("the extension UI listener did not open", {
                    session,
                    reason: bridge.asPieError(thrown).message,
                });
            });
        return () => {
            live = false;
            stop?.();
        };
    }, [client, session]);

    const answer = useMutation({
        mutationFn: (input: { id: string; answer: bridge.ExtensionAnswer }) =>
            bridge.answerExtension(session, input.id, input.answer),
        onSettled: () => client.invalidateQueries({ queryKey: sessionKeys.extension(session) }),
        onError: (thrown) => toast.error(bridge.asPieError(thrown).message),
    });

    return {
        state: read.data ?? null,
        /** The request at the head of pi's queue, if one waits. */
        request: read.data?.requests[0] ?? null,
        answer: (id: string, value: bridge.ExtensionAnswer) => answer.mutate({ id, answer: value }),
        answering: answer.isPending,
    };
}
