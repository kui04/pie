/**
 * The workspace. Nothing of it is built yet — the transcript milestone fills this
 * in — but it is a real route now so that connecting has somewhere to go, and so
 * the gate's exit is somewhere to be tested from.
 */

export function ChatScreen() {
    return (
        <main
            id="chat-root"
            className="bg-surface text-foreground flex min-h-0 w-full flex-1 flex-col overflow-hidden font-sans"
        >
            <div
                id="chat-stage"
                className="border-border bg-surface m-1 flex min-h-0 flex-1 items-center justify-center rounded-lg border"
            >
                <p className="text-body-md text-muted-foreground">Connected.</p>
            </div>
        </main>
    );
}
