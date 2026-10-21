import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Paperclip, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button, Popover, PopoverTrigger, Textarea } from "@/components/ui";
import { useMotion } from "@/hooks";
import * as bridge from "@/lib/bridge";
import type { ExtensionEditorText } from "@/lib/bridge";
import type { StreamingBehavior } from "@/lib/rpc-protocol";
import { sessionQueries } from "@/lib/query";
import { Attachments, type StagedImage } from "@/routes/chat/composer/Attachments";
import { CommandList } from "@/routes/chat/composer/CommandList";
import { bashCommandOf, commandRows, slashHint, slashName, type CommandRow } from "@/routes/chat/composer/command";
import { ModelPicker } from "@/routes/chat/composer/ModelPicker";
import { ThinkingLevelPicker } from "@/routes/chat/composer/ThinkingLevelPicker";
import { UserCommand } from "@/routes/chat/transcript/entries/UserCommand";
import { presentRunningExecution } from "@/routes/chat/transcript/presentation";
import { useSelector } from "@xstate/react";
import type { SessionRef } from "@/lib/session";
import { Icon } from "@/components";

/**
 * The flat treatment and motion the composer's panels share. Their corners differ: the
 * command list takes the composer's `3xl`, while the two pickers take the menu's `xl`.
 */
export const COMPOSER_PANEL = `
    border border-foreground/10 bg-card shadow-none origin-(--transform-origin)
    motion-safe:transition-[opacity,scale] motion-safe:duration-150 motion-safe:ease-out
    data-ending-style:scale-95 data-ending-style:opacity-0
    data-starting-style:scale-95 data-starting-style:opacity-0
`;

/** The key of a picker at the foot of the composer: a blue pill carrying the value in use. */
const PICKER_PILL = `
    h-[34px] min-w-0 max-w-full shrink gap-1 rounded-[18px] border border-primary/25 bg-primary/10 px-2.5
    text-[length:13px] leading-6 text-primary-text transition-colors duration-200
    hover:bg-primary-text/20 hover:text-primary-text
    dark:hover:bg-primary-text/20
    aria-expanded:bg-primary/15 aria-expanded:text-primary-text
`;

export function PickerPill({ className, ...props }: ComponentProps<typeof Button>) {
    return <Button variant="ghost" size="sm" className={cn(PICKER_PILL, className)} {...props} />;
}

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
    /** The latest text an extension put in the editor. */
    editorText?: ExtensionEditorText | null;
    /** Called when an editable composer field gains focus. */
    onFocus?: () => void;
    /** Called when an editable composer field loses focus. */
    onBlur?: () => void;
    /** Called with the new focus state when an editable composer field gains or loses focus. */
    onFocusChange?: (focused: boolean) => void;
}

export function Composer({
    session,
    working,
    machine,
    editorText = null,
    onFocus,
    onBlur,
    onFocusChange,
}: ComposerProps) {
    const client = useQueryClient();
    const [value, setValue] = useState("");
    const [staged, setStaged] = useState<StagedImage[]>([]);
    const [highlighted, setHighlighted] = useState<string | null>(null);
    const [pointed, setPointed] = useState<string | null>(null);
    const [dismissed, setDismissed] = useState(false);
    const [panel, setPanel] = useState<"model" | "thinking" | null>(null);
    const input = useRef<HTMLTextAreaElement>(null);
    const attachment = useRef(0);
    const appliedEditorText = useRef<number | null>(null);

    const blurTimer = useRef<number | null>(null);
    const focused = useRef(false);

    const handleFocus = useCallback(() => {
        if (blurTimer.current !== null) {
            cancelAnimationFrame(blurTimer.current);
            blurTimer.current = null;
        }
        if (!focused.current) {
            focused.current = true;
            onFocusChange?.(true);
            onFocus?.();
        }
    }, [onFocus, onFocusChange]);

    const handleBlur = useCallback(() => {
        if (blurTimer.current !== null) {
            cancelAnimationFrame(blurTimer.current);
        }
        blurTimer.current = requestAnimationFrame(() => {
            blurTimer.current = null;
            if (focused.current) {
                focused.current = false;
                onFocusChange?.(false);
                onBlur?.();
            }
        });
    }, [onBlur, onFocusChange]);

    useEffect(() => {
        return () => {
            if (blurTimer.current !== null) {
                cancelAnimationFrame(blurTimer.current);
            }
            if (focused.current) {
                onFocusChange?.(false);
                onBlur?.();
            }
        };
    }, [onBlur, onFocusChange]);

    const { reveal, swap } = useMotion();

    useEffect(() => {
        appliedEditorText.current = null;
    }, [session]);

    useEffect(() => {
        if (editorText === null || appliedEditorText.current === editorText.seq) return;
        appliedEditorText.current = editorText.seq;
        setValue(editorText.text);
        input.current?.focus();
    }, [editorText]);

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
    function send(text: string, sent: StagedImage[], behavior: StreamingBehavior | undefined) {
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
                        className="relative flex flex-col rounded-3xl border border-foreground/10 bg-card"
                    >
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
                        <AnimatePresence initial={false}>
                            {staged.length > 0 && (
                                <motion.div key="attachments" {...reveal} className="overflow-hidden">
                                    <Attachments
                                        className="mt-3"
                                        items={staged}
                                        onRemove={(id) =>
                                            setStaged((current) => current.filter((item) => item.id !== id))
                                        }
                                    />
                                </motion.div>
                            )}
                        </AnimatePresence>
                        <Textarea
                            id="composer-input"
                            ref={input}
                            value={value}
                            rows={2}
                            onChange={(event) => {
                                setValue(event.target.value);
                                setDismissed(false);
                                // Words of the panel's own: the row under the keyboard starts
                                // over, so the light is on the best match of the new search.
                                setHighlighted(null);
                                setPointed(null);
                            }}
                            onKeyDown={onKeyDown}
                            placeholder="Message Pi, or type / for commands"
                            aria-label="Your message"
                            enterKeyHint="send"
                            onFocus={(event) => {
                                handleFocus();
                                event.currentTarget.scrollIntoView({ block: "nearest" });
                            }}
                            onBlur={handleBlur}
                            onPointerDown={handleFocus}
                            className={cn(
                                `
                                    block h-15 max-h-15 min-h-15 resize-none rounded-none border-0 bg-transparent pt-3
                                    pr-3 pb-0 pl-4 text-(length:--text-body-lg) leading-6
                                    focus-visible:ring-0
                                    md:text-(length:--text-body-lg) md:leading-6
                                    dark:bg-transparent
                                `,
                                staged.length > 0 ? "mt-1" : "mt-3",
                            )}
                        />
                        <div id="composer-controls" className="flex items-center justify-between p-3">
                            <div id="composer-pickers" className="flex min-w-0 flex-1 items-center gap-2.5">
                                <ModelPicker
                                    session={session}
                                    current={state.data?.model ?? null}
                                    open={panel === "model"}
                                    onOpenChange={(open) => setPanel(open ? "model" : null)}
                                    onFocus={handleFocus}
                                    onBlur={handleBlur}
                                />
                                <ThinkingLevelPicker
                                    session={session}
                                    current={state.data?.thinkingLevel ?? null}
                                    open={panel === "thinking"}
                                    onOpenChange={(open) => setPanel(open ? "thinking" : null)}
                                    onFocus={handleFocus}
                                    onBlur={handleBlur}
                                />
                            </div>
                            <div id="composer-actions" className="flex shrink-0 items-center gap-2.5">
                                <Button
                                    id="composer-attach"
                                    variant="ghost"
                                    size="icon"
                                    aria-label="Attach images"
                                    onClick={attach}
                                    className="
                                        size-8.5 shrink-0 rounded-full p-0 text-muted-foreground
                                        hover:bg-accent/50 hover:text-foreground
                                        dark:hover:bg-accent/50
                                    "
                                >
                                    <Icon>
                                        <Paperclip />
                                    </Icon>
                                </Button>
                                <Button
                                    id="composer-submit"
                                    variant="ghost"
                                    size="icon"
                                    aria-label={stopShown ? "Stop" : "Send"}
                                    className={cn(
                                        "size-8.5 shrink-0 rounded-full p-0 disabled:opacity-100",
                                        stopShown
                                            ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                            : shellMode
                                              ? "bg-surface-container-highest text-violet hover:bg-surface-bright"
                                              : `
                                                  bg-primary text-primary-foreground
                                                  hover:bg-primary/90
                                                  disabled:bg-foreground/12 disabled:text-foreground/40
                                              `,
                                    )}
                                    disabled={!stopShown && !sendable}
                                    onClick={() => (stopShown ? stop() : submit(false))}
                                >
                                    <AnimatePresence initial={false} mode="wait">
                                        <motion.span key={stopShown ? "stop" : "send"} className="flex" {...swap}>
                                            <Icon>{stopShown ? <Square /> : <ArrowUp />}</Icon>
                                        </motion.span>
                                    </AnimatePresence>
                                </Button>
                            </div>
                        </div>
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
