import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, SendHorizontal, Square, Terminal, X } from "lucide-react";
import { useMemo, useRef, useState, type ComponentProps, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button, Popover, PopoverTrigger, Textarea } from "@/components/ui";
import { useIsMobile } from "@/hooks/usePlatform";
import * as bridge from "@/lib/bridge";
import type { ImageContent, StreamingBehavior } from "@/lib/rpc-protocol";
import { sessionQueries } from "@/lib/query";
import { CommandList } from "@/routes/chat/composer/CommandList";
import { bashCommandOf, commandRows, slashHint, slashName, type CommandRow } from "@/routes/chat/composer/command";
import { ModelPicker } from "@/routes/chat/composer/ModelPicker";
import { ThinkingLevelPicker } from "@/routes/chat/composer/ThinkingLevelPicker";
import { UserCommand } from "@/routes/chat/transcript/entries/UserCommand";
import { presentRunningExecution } from "@/routes/chat/transcript/presentation";
import { useSelector } from "@xstate/react";
import type { SessionRef } from "@/lib/sessions";

export interface ComposerProps {
    /** The session that this box sends to. */
    session: string;
    /**
     * Whether a run of that session is in flight, from `useSession`. It decides what a
     * key means: Enter steers a run, and starts the next turn when none goes on.
     */
    working: boolean;
    /** The chart of the session: the shell card runs in it, above this box. */
    machine: SessionRef;
}

/** One picture the reader staged, with the name of the file it came from. */
interface Staged {
    id: string;
    name: string;
    image: ImageContent;
}

export function Composer({ session, working, machine }: ComposerProps) {
    const client = useQueryClient();
    const isMobile = useIsMobile();
    const [value, setValue] = useState("");
    const [staged, setStaged] = useState<Staged[]>([]);
    const [highlighted, setHighlighted] = useState<string | null>(null);
    const [pointed, setPointed] = useState<string | null>(null);
    const [dismissed, setDismissed] = useState(false);
    const [panel, setPanel] = useState<"model" | "thinking" | null>(null);
    const input = useRef<HTMLTextAreaElement>(null);
    const attachment = useRef(0);

    const state = useQuery(sessionQueries.state(session));
    const commands = useQuery(sessionQueries.commands(session));
    const runningBash = useSelector(machine, (snapshot) => snapshot.context.bash);

    const piCommands = useMemo(() => commands.data?.commands ?? [], [commands.data]);
    const name = slashName(value);
    const commandListOpen = name !== null && !/\s/.test(value.trimStart()) && !dismissed && panel === null;
    const rows = useMemo(
        () => (commandListOpen ? commandRows(name ?? "", piCommands) : []),
        [commandListOpen, name, piCommands],
    );
    const highlightedRow = rows.find((row) => row.id === highlighted) ?? rows[0] ?? null;
    // The row that is lit is the row under the pointer while there is one, and the row the
    // keyboard is on otherwise - the same rule as the popup lists. A pointer that has left, or
    // that points at a row a new search has taken away, leaves the light with the keyboard.
    const litRow = rows.find((row) => row.id === pointed) ?? highlightedRow;

    /** Sends the words and the pictures, and takes the box back when pi refuses. */
    function send(text: string, sent: Staged[], behavior: StreamingBehavior | undefined) {
        setValue("");
        setStaged([]);
        setDismissed(false);
        void bridge
            .prompt(session, text, behavior, sent.length > 0 ? sent.map((attachment) => attachment.image) : undefined)
            .catch((thrown: unknown) => {
                toast.error(bridge.asPieError(thrown).message);
                // The words and the pictures stay: a refusal of pi — no model, a
                // compaction in progress — is worth another try, and typing it all
                // again is not.
                setValue((current) => (current === "" ? text : current));
                setStaged((current) => (current.length === 0 ? sent : current));
            });
    }

    /** Runs a command of the reader's own shell; the card waits above the box. */
    function runBash(shell: { command: string; excludeFromContext: boolean }) {
        if (runningBash !== null) {
            toast.warning("A shell command is already running. Stop it first.");
            return;
        }
        setValue("");
        setDismissed(false);
        machine.send({ type: "BASH_START", run: shell });
        void bridge
            .bash(session, shell.command, shell.excludeFromContext)
            .then(() => {
                // Pi records the run as an entry, and no event carries it: the read is
                // what takes the live card down and puts the record in its place.
                void client.invalidateQueries({ queryKey: sessionQueries.entries(session).queryKey });
            })
            .catch((thrown: unknown) => {
                toast.error(bridge.asPieError(thrown).message);
                // The command never ran, so pi records nothing and no entry will take the
                // card down: it goes here.
                machine.send({ type: "BASH_DROPPED" });
                setValue((current) =>
                    current === "" ? `${shell.excludeFromContext ? "!!" : "!"}${shell.command}` : current,
                );
            });
    }

    /** Stops what runs: the answer of pi first, or the shell command of the reader. */
    function stop() {
        if (working) {
            void bridge.abort(session).catch((thrown: unknown) => toast.error(bridge.asPieError(thrown).message));
            return;
        }
        if (runningBash !== null) {
            void bridge.abortBash(session).catch((thrown: unknown) => toast.error(bridge.asPieError(thrown).message));
        }
    }

    /** What the send key does: a shell command, a command, or a message. */
    function submit(withFollowUp: boolean) {
        const text = value.trim();
        if (text === "" && staged.length === 0) return;

        const shell = bashCommandOf(text);
        if (shell !== null) {
            if (shell.command === "") {
                toast("Type a shell command after the exclamation mark.");
                return;
            }
            runBash(shell);
            return;
        }

        const hint = slashHint(
            text,
            piCommands.map((command) => command.name),
        );
        if (hint !== null) {
            // Never a message to the model: a command that nothing here knows is a
            // mistake, and pi would read it as words.
            setValue("");
            toast(hint);
            return;
        }

        const behavior: StreamingBehavior | undefined = working ? (withFollowUp ? "followUp" : "steer") : undefined;
        send(text, staged, behavior);
    }

    /** Chooses a row of the command list: the name goes to the box, ready for its arguments. */
    function choose(row: CommandRow) {
        setDismissed(false);
        setValue(`/${row.name} `);
        input.current?.focus();
    }

    /** Moves the highlight of the list by `step` rows, around its ends. */
    function move(step: number) {
        if (rows.length === 0) return;
        // A key takes the light from the pointer, as it does in the popup lists.
        setPointed(null);
        // From where the highlight is drawn, which is the first row while the keyboard
        // has not moved it: a step from nothing would land on the row it is already on.
        const at = rows.findIndex((row) => row.id === highlightedRow?.id);
        const next = (at + step + rows.length) % rows.length;
        setHighlighted(rows[next]?.id ?? null);
    }

    function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
        if (event.key === "Escape" && commandListOpen) {
            event.preventDefault();
            setDismissed(true);
            return;
        }
        // Tab takes the row the light is on, as it does in pi's own editor, and does
        // not move the focus the way a bare Tab would.
        if (event.key === "Tab" && commandListOpen && litRow !== null) {
            event.preventDefault();
            choose(litRow);
            return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (commandListOpen && !event.altKey && litRow !== null) {
                choose(litRow);
                return;
            }
            submit(event.altKey);
            return;
        }
        if (commandListOpen && event.key === "ArrowDown") {
            event.preventDefault();
            move(1);
            return;
        }
        if (commandListOpen && event.key === "ArrowUp") {
            event.preventDefault();
            move(-1);
        }
    }

    /** Asks the person for pictures and stages what they chose. */
    function attach() {
        void bridge
            .pickImages()
            .then((picked) => {
                if (picked === null || picked.length === 0) return;
                const added = picked.map(({ name, image }) => {
                    attachment.current += 1;
                    return { id: `attachment-${attachment.current}`, name, image };
                });
                setStaged((current) => [...current, ...added]);
            })
            .catch((thrown: unknown) => toast.error(bridge.asPieError(thrown).message));
    }

    const stopShown = working || runningBash !== null;
    const sendable = value.trim() !== "" || staged.length > 0;
    const shellMode = bashCommandOf(value) !== null;

    // The card the trigger wraps: everything the reader touches, in one place so
    // the trigger above stays a positioning anchor and nothing else.
    const card = (
        <>
            {runningBash !== null && (
                // The reader's own run, above the card where the command panel comes
                // from. Pi records it as an entry when it can (its own
                // `_pendingBashMessages` may defer that), and the chart takes the card
                // down when the entry of that command arrives (`bashAfter`).
                <div id="composer-run" className="absolute inset-x-0 bottom-full z-10 mb-2">
                    <UserCommand
                        id="composer-run-card"
                        tool="bash"
                        presentation={presentRunningExecution(runningBash)}
                    />
                </div>
            )}
            {staged.length > 0 && (
                <div id="composer-attachments" className="flex flex-wrap gap-2">
                    {staged.map(({ id, name, image }, index) => (
                        <div
                            key={id}
                            id={`composer-attachment-${index}`}
                            className={cn(
                                "border-border-strong bg-surface-container-highest",
                                "flex max-w-full items-center gap-2 rounded-full border p-1",
                            )}
                        >
                            <img
                                alt=""
                                src={`data:${image.mimeType};base64,${image.data}`}
                                className="size-4 shrink-0 rounded-full object-cover"
                            />
                            <span className="max-w-40 truncate text-body-md text-foreground">{name}</span>
                            <Button
                                id={`composer-attachment-${index}-remove`}
                                variant="ghost"
                                size="icon"
                                aria-label={`Remove ${name}`}
                                className={cn(
                                    "text-muted-foreground hover:bg-surface-bright",
                                    "hover:text-foreground dark:hover:bg-surface-bright",
                                    "size-5 shrink-0 rounded-full p-0",
                                )}
                                onClick={() => setStaged((current) => current.filter((_, at) => at !== index))}
                            >
                                <X className="size-3" />
                            </Button>
                        </div>
                    ))}
                </div>
            )}
            <Textarea
                id="composer-input"
                ref={input}
                value={value}
                rows={3}
                onChange={(event) => {
                    setValue(event.target.value);
                    setDismissed(false);
                    // Words of the panel's own: the row under the keyboard starts
                    // over, so the light is on the best match of the new search.
                    setHighlighted(null);
                    setPointed(null);
                }}
                onKeyDown={onKeyDown}
                placeholder={
                    isMobile
                        ? "Ask Pi anything, or type / for commands"
                        : "Ask Pi anything, or type / for commands. Enter steers, Alt+Enter queues a follow-up."
                }
                aria-label="Your message"
                enterKeyHint="send"
                onFocus={(event) => event.currentTarget.scrollIntoView({ block: "nearest" })}
                className={cn(
                    "block max-h-25 min-h-15 resize-none text-body-md",
                    "rounded-none border-0 bg-transparent p-0",
                    "focus-visible:ring-0 dark:bg-transparent",
                )}
            />
            <div id="composer-controls" className="flex items-center justify-between gap-2">
                <div id="composer-actions" className="flex items-center gap-2">
                    <ComposerKey id="composer-attach" aria-label="Attach images" onClick={attach}>
                        <Plus className="size-4" />
                    </ComposerKey>
                    <ComposerKey
                        id="composer-command"
                        aria-label="Commands"
                        onClick={() => {
                            setValue("/");
                            setDismissed(false);
                            input.current?.focus();
                        }}
                    >
                        <Terminal className="size-4" />
                    </ComposerKey>
                </div>
                <div id="composer-settings" className="flex min-w-0 items-center gap-2">
                    <ModelPicker
                        session={session}
                        current={state.data?.model ?? null}
                        open={panel === "model"}
                        onOpenChange={(open) => setPanel(open ? "model" : null)}
                    />
                    <ThinkingLevelPicker
                        session={session}
                        current={state.data?.thinkingLevel ?? null}
                        open={panel === "thinking"}
                        onOpenChange={(open) => setPanel(open ? "thinking" : null)}
                    />
                    <Button
                        id="composer-submit"
                        variant="ghost"
                        size="icon"
                        aria-label={stopShown ? "Stop" : "Send"}
                        className={cn(
                            "size-8 shrink-0 rounded-full p-0 disabled:opacity-100",
                            stopShown
                                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                : shellMode
                                  ? "bg-surface-container-highest text-violet hover:bg-surface-bright"
                                  : "bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-foreground/12 disabled:text-foreground/40",
                        )}
                        disabled={!stopShown && !sendable}
                        onClick={() => (stopShown ? stop() : submit(false))}
                    >
                        {stopShown ? <Square className="size-4" /> : <SendHorizontal className="size-4" />}
                    </Button>
                </div>
            </div>
        </>
    );

    return (
        <Popover
            open={commandListOpen && highlightedRow !== null}
            onOpenChange={(open, details) => {
                // A popover that closed itself - an outside click, an Escape - is the
                // same as the reader dismissing the panel: the same text must not
                // open it again. A press inside the card is not a verdict: the
                // card is the trigger, and typing owns the open state.
                if (!open && details.reason !== "trigger-press") setDismissed(true);
            }}
        >
            {/* The card is the trigger of the panel and not its opener: the text
                typed in it is what opens the list, and the list stands above it.
                The trigger semantics are stripped - a card holding a textbox and
                keys is no button - and only the anchor stays: positioning. */}
            <PopoverTrigger
                render={(props) => (
                    <div
                        {...props}
                        id="composer"
                        role={undefined}
                        tabIndex={undefined}
                        aria-haspopup={undefined}
                        aria-expanded={undefined}
                        aria-controls={undefined}
                        className="relative flex flex-col gap-3 rounded-xl bg-card p-4"
                    >
                        {card}
                    </div>
                )}
                nativeButton={false}
            />
            {litRow !== null && highlightedRow !== null && (
                <CommandList
                    id="composer-command-list"
                    rows={rows}
                    highlighted={highlightedRow.id}
                    lit={litRow.id}
                    onPoint={setPointed}
                    onChoose={choose}
                />
            )}
        </Popover>
    );
}

/** A round key of the composer's action row: 32px and the step of the surface ladder above the card. */
function ComposerKey({ className, ...props }: ComponentProps<typeof Button>) {
    return (
        <Button
            variant="ghost"
            size="icon"
            className={cn(
                "border-border-strong bg-surface-container-highest",
                "text-foreground hover:bg-surface-bright hover:text-foreground",
                "size-8 shrink-0 rounded-full border p-0 dark:hover:bg-surface-bright",
                className,
            )}
            {...props}
        />
    );
}
