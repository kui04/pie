/**
 * The message box of a session: the words of the person, the pictures they attach,
 * the commands they type, and the run they steer or stop.
 *
 * The layout is the one of `.ui-design/components/composer`: one card of a prompt
 * field over a control row, the two keys of the app ([+] attach, [/] commands) at
 * its start and the settings (model, thinking level, send) at its end. The panels
 * that belong to a key — the command panel, the model and thinking popups — float
 * above the card; a shell run of the reader that pi has not recorded yet waits in
 * the same place, because the reader's own run is not part of the thread.
 *
 * One key does the sending, and what it does follows the run: while an answer
 * streams, Enter steers it and Alt+Enter queues a follow-up; when nothing streams,
 * the message starts a run. Pi decides the same way from its own state — a behavior
 * without a stream is ignored — so this side only has to name the key that the
 * person pressed (`machines/session.machine.ts` holds the run state, and this box
 * reads it as one boolean).
 *
 * The first character of the line chooses the mode, and the mode is data, not a
 * state of its own: `/` opens the command menu, `!` and `!!` run a shell command of
 * the reader, and everything else is a message.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, SendHorizontal, Square, Terminal, X } from "lucide-react";
import { useMemo, useRef, useState, type ComponentProps, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useIsMobile } from "@/hooks/use-platform";
import * as bridge from "@/lib/bridge";
import { copyText } from "@/lib/clipboard";
import type { ImageContent, StreamingBehavior } from "@/lib/protocol";
import { sessionQueries } from "@/lib/query";
import { CommandMenu } from "@/routes/chat/components/composer/CommandMenu";
import { ModePickers } from "@/routes/chat/components/composer/ModePickers";
import {
    bashCommandOf,
    commandRows,
    slashIntent,
    slashName,
    type CommandRow,
} from "@/routes/chat/components/composer/slash";
import { ToolResultCard } from "@/routes/chat/components/entries/ToolResultCard";
import { presentRunningExecution } from "@/routes/chat/components/toolPresentation";
import { useTranscriptStore } from "@/stores/transcript.store";

export interface ComposerProps {
    /** The session that this box sends to. */
    session: string;
    /**
     * Whether a run of that session is in flight, from `useSession`. It decides what a
     * key means: Enter steers a run, and starts the next turn when none goes on.
     */
    working: boolean;
}

/** One picture the reader staged, with the name of the file it came from. */
interface Staged {
    id: string;
    name: string;
    image: ImageContent;
}

export function Composer({ session, working }: ComposerProps) {
    const client = useQueryClient();
    const isMobile = useIsMobile();
    const [value, setValue] = useState("");
    const [staged, setStaged] = useState<Staged[]>([]);
    const [highlighted, setHighlighted] = useState<string | null>(null);
    const [dismissed, setDismissed] = useState(false);
    const [panel, setPanel] = useState<"model" | "thinking" | null>(null);
    const input = useRef<HTMLTextAreaElement>(null);
    const attachment = useRef(0);

    const state = useQuery(sessionQueries.state(session));
    const commands = useQuery(sessionQueries.commands(session));
    const runningBash = useTranscriptStore((store) => store.runningBash);
    const startBash = useTranscriptStore((store) => store.startBash);
    const finishBash = useTranscriptStore((store) => store.finishBash);

    const piCommands = useMemo(() => commands.data?.commands ?? [], [commands.data]);
    const name = slashName(value);
    // The menu is for the name of a command. Once a space separates the name from its
    // arguments, the choice is made; and one panel at a time is the design's rule.
    const menuOpen = name !== null && !/\s/.test(value.trimStart()) && !dismissed && panel === null;
    const autoCompaction = state.data?.autoCompactionEnabled ?? false;
    const rows = useMemo(
        () => (menuOpen ? commandRows(name ?? "", piCommands, autoCompaction) : []),
        [menuOpen, name, piCommands, autoCompaction],
    );
    // The row under the keyboard follows the filter: a highlight that the list no
    // longer holds gives way to the first row, without a state of its own.
    const highlightedRow = rows.find((row) => row.id === highlighted) ?? rows[0] ?? null;

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
        startBash(shell);
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
                finishBash();
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

    /** Reads the last answer of the session and puts it on the clipboard. */
    function copyLastAnswer() {
        void bridge
            .getLastAssistantText(session)
            .then(async (answer) => {
                if (!answer.text) {
                    toast("There is no answer to copy yet.");
                    return;
                }
                const copied = await copyText(answer.text);
                if (copied) toast.success("Copied.");
            })
            .catch((thrown: unknown) => toast.error(bridge.asPieError(thrown).message));
    }

    /** Compacts the conversation now, with what follows the command as instructions. */
    function compactNow(instructions: string) {
        void bridge
            .compact(session, instructions === "" ? undefined : instructions)
            .then(() => client.invalidateQueries({ queryKey: sessionQueries.state(session).queryKey }))
            .catch((thrown: unknown) => toast.error(bridge.asPieError(thrown).message));
    }

    /** The commands of the composer that pie answers itself. */
    function runOwn(command: "compact" | "copy" | "name", argument: string) {
        if (command === "copy") {
            setValue("");
            copyLastAnswer();
            return;
        }
        if (command === "compact") {
            setValue("");
            compactNow(argument);
            return;
        }
        if (argument === "") {
            toast("Name the session: /name <new name>");
            return;
        }
        setValue("");
        void bridge
            .setSessionName(session, argument)
            .then(() => client.invalidateQueries({ queryKey: sessionQueries.state(session).queryKey }))
            .catch((thrown: unknown) => toast.error(bridge.asPieError(thrown).message));
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

        if (name !== null) {
            const intent = slashIntent(
                text,
                piCommands.map((command) => command.name),
            );
            if (intent?.kind === "own") {
                runOwn(intent.command, intent.argument);
                return;
            }
            if (intent?.kind === "hint") {
                // Never a message to the model: a command that nothing here knows is
                // a mistake, and pi would read it as words.
                setValue("");
                toast(intent.message);
                return;
            }
        }

        const behavior: StreamingBehavior | undefined = working ? (withFollowUp ? "followUp" : "steer") : undefined;
        send(text, staged, behavior);
    }

    /** Chooses a row of the command menu. */
    function choose(row: CommandRow) {
        setDismissed(false);
        switch (row.action.kind) {
            case "complete":
                setValue(`/${row.action.name} `);
                input.current?.focus();
                break;
            case "copy":
                setValue("");
                copyLastAnswer();
                break;
            case "compact":
                setValue("");
                compactNow("");
                break;
            case "toggle-compaction":
                setValue("");
                void bridge
                    .setAutoCompaction(session, row.action.enabled)
                    .then(() => client.invalidateQueries({ queryKey: sessionQueries.state(session).queryKey }))
                    .catch((thrown: unknown) => toast.error(bridge.asPieError(thrown).message));
                break;
        }
    }

    /** Moves the highlight of the menu by `step` rows, around its ends. */
    function move(step: number) {
        if (rows.length === 0) return;
        // From where the highlight is drawn, which is the first row while the keyboard
        // has not moved it: a step from nothing would land on the row it is already on.
        const at = rows.findIndex((row) => row.id === highlightedRow?.id);
        const next = (at + step + rows.length) % rows.length;
        setHighlighted(rows[next]?.id ?? null);
    }

    function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
        if (event.key === "Escape" && menuOpen) {
            event.preventDefault();
            setDismissed(true);
            return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (menuOpen && !event.altKey && highlightedRow !== null) {
                choose(highlightedRow);
                return;
            }
            submit(event.altKey);
            return;
        }
        if (menuOpen && event.key === "ArrowDown") {
            event.preventDefault();
            move(1);
            return;
        }
        if (menuOpen && event.key === "ArrowUp") {
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

    return (
        <div id="composer" className="bg-card relative flex flex-col gap-3 rounded-md p-4">
            {menuOpen && highlightedRow !== null && (
                <CommandMenu
                    id="composer-command-menu"
                    rows={rows}
                    highlighted={highlightedRow.id}
                    onHighlight={setHighlighted}
                    onChoose={choose}
                    className="absolute inset-x-0 bottom-full z-20 mb-2"
                />
            )}
            {runningBash !== null && (
                // The reader's own run, above the card where the command panel comes
                // from. Pi records it as an entry when it can (its own
                // `_pendingBashMessages` may defer that), and the store takes the card
                // down with the record.
                <div id="composer-run" className="absolute inset-x-0 bottom-full z-10 mb-2">
                    <ToolResultCard
                        id="composer-run-card"
                        presentation={presentRunningExecution(runningBash)}
                        className="shadow-md"
                    />
                </div>
            )}
            {staged.length > 0 && (
                <div id="composer-attachments" className="flex flex-wrap gap-2">
                    {staged.map(({ id, name, image }, index) => (
                        <div
                            key={id}
                            id={`composer-attachment-${index}`}
                            className="border-border-strong bg-surface-container-highest flex max-w-full items-center gap-2 rounded-full border p-1"
                        >
                            <img
                                alt=""
                                src={`data:${image.mimeType};base64,${image.data}`}
                                className="size-4 shrink-0 rounded-full object-cover"
                            />
                            <span className="text-body-md text-foreground max-w-40 truncate">{name}</span>
                            <Button
                                id={`composer-attachment-${index}-remove`}
                                variant="ghost"
                                size="icon"
                                aria-label={`Remove ${name}`}
                                className="text-muted-foreground hover:bg-surface-bright hover:text-foreground size-5 shrink-0 rounded-full p-0"
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
                }}
                onKeyDown={onKeyDown}
                placeholder={
                    isMobile
                        ? "What would you like to change or create?"
                        : "What would you like to change or create? · Enter steers · Alt+Enter queues a follow-up"
                }
                aria-label="Your message"
                className="text-body-md placeholder:text-outline max-h-[6.25rem] min-h-[3.75rem] resize-none border-0 bg-transparent p-0 focus-visible:ring-0 dark:bg-transparent"
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
                    <ModePickers
                        session={session}
                        model={state.data?.model ?? null}
                        thinking={state.data?.thinkingLevel ?? null}
                        panel={panel}
                        onOpenChange={setPanel}
                    />
                    <Button
                        id="composer-submit"
                        variant="ghost"
                        size="icon"
                        aria-label={stopShown ? "Stop" : "Send"}
                        // The designs key: a 32px round key, the primary fill while
                        // the prompt can be sent, the shell's own ink in bash mode
                        // (components.md: the submit key wears `--user-run`), the
                        // failure fill while a run can be stopped, and the quiet
                        // disabled paint `DESIGN.md` gives a filled key.
                        className={cn(
                            "size-8 shrink-0 rounded-full p-0 disabled:opacity-100",
                            stopShown
                                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                : shellMode
                                  ? "bg-surface-container-highest text-user-run hover:bg-surface-bright"
                                  : "bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-foreground/12 disabled:text-foreground/40",
                        )}
                        disabled={!stopShown && !sendable}
                        onClick={() => (stopShown ? stop() : submit(false))}
                    >
                        {stopShown ? <Square className="size-4" /> : <SendHorizontal className="size-4" />}
                    </Button>
                </div>
            </div>
        </div>
    );
}

/** A round key of the composer's action row: 32px and the step of the surface ladder above the card. */
function ComposerKey({ className, ...props }: ComponentProps<typeof Button>) {
    return (
        <Button
            variant="ghost"
            size="icon"
            className={cn(
                "border-border-strong bg-surface-container-highest text-foreground hover:bg-surface-bright hover:text-foreground size-8 shrink-0 rounded-full border p-0",
                className,
            )}
            {...props}
        />
    );
}
