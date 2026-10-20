/**
 * What the conversation in view can do: rename it, fork it, copy it, delete it, or end
 * its process.
 *
 * The menu and the three questions it opens live together: a row only chooses a view,
 * and the view owns the query or mutation behind its answer until it closes.
 */

import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSelector } from "@xstate/react";
import { Copy, EllipsisVertical, GitFork, Pencil, Trash2, Unplug } from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";

import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Skeleton,
} from "@/components/ui";
import { ConfirmDialog, DialogAction, DialogFrame, Icon, ScrollPane, TextDialog, TruncatedText } from "@/components";
import * as bridge from "@/lib/bridge";
import { sessionKeys, sessionQueries } from "@/lib/query";
import type { SessionRef } from "@/lib/sessions";
import { phaseOf } from "@/machines/session.machine";
import { COMPOSER_PANEL } from "@/routes/chat/composer/Composer";

const RENAME_DESCRIPTION = "The name the host lists for this conversation.";
const DELETE_DESCRIPTION = "The messages leave this machine. A conversation forked from this one keeps its own copy.";
const FORK_DESCRIPTION = "The conversation begins again before the message you pick.";
const FORK_TITLE = "Fork from a message";

export interface SessionMenuProps {
    session?: string | null;
    machine?: SessionRef;
    endpoint: string;
    /** Whether the popup is open. The caller holds this, so one popup is open at a time. */
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The conversation is given up: the process ends and the screen leaves it. */
    onClose?: () => void;
    /** The conversation is gone: the screen leaves it without ending a process. */
    onGone?: () => void;
    /** The file of the session, when known by the caller (e.g. from the sidebar listing). */
    file?: string | null;
    /** The name of the session, when known by the caller. */
    initialName?: string | null;
    /** Whether the session is actively working (running a prompt). */
    working?: boolean;
    /** Custom id for the trigger element. */
    id?: string;
    /** Custom className for the trigger button. */
    triggerClassName?: string;
    /** Popover alignment. Defaults to "end". */
    align?: "start" | "center" | "end";
    /** Shift along the align edge, for a trigger whose glyph is inset from its box. */
    alignOffset?: number;
    /** Popover side. Defaults to "bottom". */
    side?: "top" | "bottom" | "left" | "right";
    /** Pins which shape the sheets draw, for previews and tests. */
    isMobile?: boolean;
}

export function SessionMenu({ machine, working = false, ...props }: SessionMenuProps) {
    const machineWorking = useSelector(machine, (snapshot) =>
        snapshot === undefined ? false : phaseOf(snapshot) !== "idle",
    );
    return <SessionMenuBody {...props} machine={machine} isWorking={machine ? machineWorking : working} />;
}

function SessionMenuBody({
    session,
    machine,
    endpoint,
    open,
    onOpenChange,
    onClose,
    onGone,
    file: propsFile,
    initialName,
    isWorking,
    id = "session-menu",
    triggerClassName,
    align = "end",
    alignOffset = 0,
    side = "bottom",
    isMobile,
}: SessionMenuProps & { isWorking: boolean }) {
    const client = useQueryClient();
    const [view, setView] = useState<"menu" | "rename" | "fork" | "delete">("menu");
    const activeSession = session ?? "";

    // The name and the file of the conversation come from the same cache the bar reads when activeSession is set.
    const state = useQuery({ ...sessionQueries.state(activeSession), enabled: open && Boolean(activeSession) });
    const file = propsFile ?? state.data?.sessionFile ?? null;
    const name = initialName ?? state.data?.sessionName ?? null;

    /** The process holds another conversation: everything of the old one goes, and the reads answer again. */
    function adopted() {
        if (activeSession) {
            void client.cancelQueries({ queryKey: sessionKeys.whole(activeSession) });
            void client.invalidateQueries({ queryKey: sessionKeys.whole(activeSession) });
        }
        void client.invalidateQueries({ queryKey: ["sessions", endpoint] });
        machine?.send({ type: "REPLACED" });
    }

    /** The name the host lists has changed. */
    function renamed() {
        void client.invalidateQueries({ queryKey: ["sessions", endpoint] });
    }

    /** The process ended and the file is gone. */
    function deleted() {
        void client.invalidateQueries({ queryKey: ["connection"] });
        void client.invalidateQueries({ queryKey: ["sessions", endpoint] });
        onGone?.();
    }

    function clone() {
        if (!activeSession) return;
        onOpenChange(false);
        void bridge
            .cloneSession(activeSession)
            .then((result) => {
                if (result.cancelled) {
                    toast("An extension refused the copy.");
                    return;
                }
                adopted();
            })
            .catch((thrown: unknown) => toast.error(bridge.asPieError(thrown).message));
    }

    function detach() {
        onOpenChange(false);
        if (onClose) {
            onClose();
        } else if (activeSession) {
            void bridge.detachSession(activeSession).then(() => {
                void client.invalidateQueries({ queryKey: ["connection"] });
                void client.invalidateQueries({ queryKey: ["sessions", endpoint] });
            });
        }
    }

    function choose(next: "rename" | "fork" | "delete") {
        onOpenChange(false);
        setView(next);
    }

    const closeView = () => setView("menu");

    return (
        <>
            <DropdownMenu open={open} onOpenChange={onOpenChange}>
                <DropdownMenuTrigger
                    render={
                        <Button
                            id={id}
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Session actions"
                            className={triggerClassName}
                        />
                    }
                >
                    <Icon>
                        <EllipsisVertical />
                    </Icon>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    id={`${id}-popup`}
                    side={side}
                    align={align}
                    alignOffset={alignOffset}
                    sideOffset={6}
                    className={cn(
                        `
                            flex max-h-[min(15rem,calc(100dvh-12rem))] w-44 flex-col gap-1 overflow-hidden rounded-xl
                            p-2 text-foreground
                        `,
                        COMPOSER_PANEL,
                    )}
                >
                    <MenuRow
                        id={`${id}-rename`}
                        icon={
                            <Icon>
                                <Pencil />
                            </Icon>
                        }
                        disabled={!activeSession}
                        onSelect={() => choose("rename")}
                    >
                        Rename
                    </MenuRow>
                    <MenuRow
                        id={`${id}-fork`}
                        icon={
                            <Icon>
                                <GitFork />
                            </Icon>
                        }
                        disabled={!activeSession || isWorking}
                        onSelect={() => choose("fork")}
                    >
                        Fork
                    </MenuRow>
                    <MenuRow
                        id={`${id}-clone`}
                        icon={
                            <Icon>
                                <Copy />
                            </Icon>
                        }
                        disabled={!activeSession || isWorking}
                        onSelect={clone}
                    >
                        Clone
                    </MenuRow>
                    <MenuRow
                        id={`${id}-delete`}
                        icon={
                            <Icon>
                                <Trash2 />
                            </Icon>
                        }
                        disabled={file === null}
                        tone="destructive"
                        onSelect={() => choose("delete")}
                    >
                        Delete
                    </MenuRow>
                    {activeSession && (
                        <MenuRow
                            id={`${id}-detach`}
                            icon={
                                <Icon>
                                    <Unplug />
                                </Icon>
                            }
                            tone="warning"
                            onSelect={detach}
                        >
                            Detach
                        </MenuRow>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
            {activeSession && view === "rename" && (
                <RenameSession
                    session={activeSession}
                    initial={name}
                    onClose={closeView}
                    onRenamed={renamed}
                    isMobile={isMobile}
                />
            )}
            {activeSession && view === "fork" && (
                <ForkSession session={activeSession} onClose={closeView} onForked={adopted} isMobile={isMobile} />
            )}
            {view === "delete" && (
                <DeleteSession
                    session={activeSession}
                    file={file}
                    onClose={closeView}
                    onDeleted={deleted}
                    isMobile={isMobile}
                />
            )}
        </>
    );
}

/** One row of the menu: a glyph, a name, and what the press does. */
function MenuRow({
    id,
    icon,
    disabled = false,
    tone = "default",
    onSelect,
    children,
}: {
    id: string;
    icon: ReactNode;
    disabled?: boolean;
    tone?: "default" | "destructive" | "warning";
    onSelect: () => void;
    children: ReactNode;
}) {
    return (
        <DropdownMenuItem
            id={id}
            disabled={disabled}
            variant={tone === "destructive" ? "destructive" : "default"}
            onClick={onSelect}
            className={cn(
                `
                    flex w-full cursor-default items-center gap-2 rounded-lg p-2 text-left text-body-md
                    transition-colors outline-none select-none
                `,
                "hover:**:text-inherit!",
                "focus:**:text-inherit!",
                tone === "default" && "focus:text-foreground",
                tone === "destructive" && "focus:text-destructive",
                tone === "warning" && "text-warning focus:text-warning",
            )}
        >
            <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
                {icon}
            </span>
            {children}
        </DropdownMenuItem>
    );
}

/** The name of the conversation: one field, in a sheet on a phone and a dialog on a desktop. */
export interface RenameSessionProps {
    session: string;
    /** The name pi holds now, for the field to open with. */
    initial: string | null;
    /** The question was let go without an answer. */
    onClose: () => void;
    /** The name was taken: the listing can show it. */
    onRenamed: () => void;
    /** Pins which shape to draw, for previews and tests. */
    isMobile?: boolean;
}

export function RenameSession({ session, initial, onClose, onRenamed, isMobile }: RenameSessionProps) {
    const [name, setName] = useState(initial ?? "");

    const rename = useMutation({
        mutationFn: (next: string) => bridge.setSessionName(session, next),
        onSuccess: () => {
            onClose();
            onRenamed();
        },
        onError: (thrown: unknown) => toast.error(bridge.asPieError(thrown).message),
    });

    const trimmed = name.trim();
    const refused = trimmed === "" || rename.isPending;
    const confirm = () => {
        if (!refused) rename.mutate(trimmed);
    };

    return (
        <TextDialog
            open
            onOpenChange={(next) => {
                if (!next) onClose();
            }}
            isMobile={isMobile}
            id="session-rename"
            title="Rename the conversation"
            description={RENAME_DESCRIPTION}
            label="Name"
            value={name}
            onValueChange={setName}
            placeholder="Name this conversation"
            autoComplete="off"
            fieldId="session-rename-name"
            submitLabel="Rename"
            submitDisabled={refused}
            onSubmit={confirm}
        />
    );
}

/** Delete the conversation of this session: a sheet on a phone, a dialog on a desktop, and one confirmation. */
export interface DeleteSessionProps {
    session: string;
    /** The file of the conversation, from its state; `null` while the state is not read. */
    file: string | null;
    /** The question was let go without an answer. */
    onClose: () => void;
    /** The process ended and the file is gone: the caller reads and leaves the session. */
    onDeleted: () => void;
    /** Pins which shape to draw, for previews and tests. */
    isMobile?: boolean;
}

export function DeleteSession({ session, file, onClose, onDeleted, isMobile }: DeleteSessionProps) {
    const remove = useMutation({
        mutationFn: async (path: string) => {
            if (session !== "") {
                await bridge.detachSession(session);
            }
            await bridge.deleteSession(path);
        },
        onSuccess: () => {
            onClose();
            onDeleted();
        },
        onError: (thrown: unknown) => toast.error(bridge.asPieError(thrown).message),
    });

    const refused = file === null || remove.isPending;
    const confirm = () => {
        if (file !== null && !remove.isPending) remove.mutate(file);
    };

    return (
        <ConfirmDialog
            open
            onOpenChange={(next) => {
                if (!next) onClose();
            }}
            isMobile={isMobile}
            id="session-delete"
            title="Delete this conversation?"
            description={DELETE_DESCRIPTION}
            confirmLabel="Delete"
            confirmVariant="destructive"
            confirmDisabled={refused}
            onConfirm={confirm}
        />
    );
}

/** Fork a conversation at one of its user messages: a sheet on a phone, a dialog on a desktop. */
export interface ForkSessionProps {
    session: string;
    /** The question was let go without an answer. */
    onClose: () => void;
    /** The process holds a new branch: the caller reads the state and the entries again. */
    onForked: () => void;
    /** Pins which shape to draw, for previews and tests. */
    isMobile?: boolean;
}

export function ForkSession({ session, onClose, onForked, isMobile }: ForkSessionProps) {
    const points = useQuery(sessionQueries.forkMessages(session));
    const fork = useMutation({
        mutationFn: (entryId: string) => bridge.forkSession(session, entryId),
        onSuccess: (result) => {
            onClose();
            if (result.cancelled) {
                toast("An extension refused the fork.");
                return;
            }
            onForked();
        },
        onError: (thrown: unknown) => toast.error(bridge.asPieError(thrown).message),
    });

    const body = (
        <ScrollPane id="session-fork-scroll" className="min-h-0 flex-1" viewportClassName="-mx-2">
            {points.isError ? (
                <p id="session-fork-failure" role="alert" className="p-2 text-body-md text-muted-foreground">
                    {bridge.asPieError(points.error).message}
                </p>
            ) : points.isPending ? (
                <div role="status" aria-label="Reading the messages" className="space-y-1 px-2">
                    {[0, 1, 2, 3].map((row) => (
                        <Skeleton key={row} className="h-10 w-full motion-reduce:animate-none" />
                    ))}
                </div>
            ) : points.data.length === 0 ? (
                <p className="p-2 text-body-md text-muted-foreground">No messages to fork from</p>
            ) : (
                <div className="space-y-0.5 px-2">
                    {points.data.map((point) => (
                        <button
                            key={point.entryId}
                            type="button"
                            id={`session-fork-point-${point.entryId}`}
                            disabled={fork.isPending}
                            onClick={() => fork.mutate(point.entryId)}
                            className="
                                flex w-full rounded-md p-2 text-left outline-none
                                hover:bg-accent/50
                                focus-visible:bg-accent
                                disabled:pointer-events-none disabled:opacity-50
                            "
                        >
                            <TruncatedText
                                content={
                                    <ScrollPane
                                        bars="vertical"
                                        className="min-w-0"
                                        viewportClassName="max-h-[min(60dvh,var(--available-height))] whitespace-pre-wrap"
                                    >
                                        {point.text}
                                    </ScrollPane>
                                }
                                lines={2}
                                offset={{ top: 8, right: 12, bottom: 8, left: 12 }}
                                className="text-body-md wrap-break-word"
                            >
                                {point.text}
                            </TruncatedText>
                        </button>
                    ))}
                </div>
            )}
        </ScrollPane>
    );

    return (
        <DialogFrame
            open
            onOpenChange={(next) => {
                if (!next) onClose();
            }}
            isMobile={isMobile}
            id="session-fork"
            title={FORK_TITLE}
            description={FORK_DESCRIPTION}
            // A height, not a maximum: the viewport of a `ScrollPane` fills its root by
            // percentage, and a percentage resolves only against a definite height. Under
            // `max-h` the list would paint past the frame instead of scrolling.
            className="flex h-[70dvh] flex-col"
            actions={
                <DialogAction variant="outline" onClick={onClose}>
                    Cancel
                </DialogAction>
            }
        >
            {body}
        </DialogFrame>
    );
}
