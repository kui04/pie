/**
 * What the conversation in view can do: rename it, fork it, copy it, delete it, or end
 * its process.
 *
 */

import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSelector } from "@xstate/react";
import { Copy, EllipsisVertical, GitFork, Pencil, Trash2, Unplug } from "lucide-react";
import { toast } from "sonner";

import { Button, Popover, PopoverContent, PopoverTrigger } from "@/components/ui";
import * as bridge from "@/lib/bridge";
import { sessionKeys, sessionQueries } from "@/lib/query";
import type { SessionRef } from "@/lib/sessions";
import { phaseOf } from "@/machines/session.machine";
import { DeleteSession } from "@/routes/chat/menu/DeleteSession";
import { ForkSession } from "@/routes/chat/menu/ForkSession";
import { RenameSession } from "@/routes/chat/menu/RenameSession";
import { Icon } from "@/components";

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
    /** Popover side. Defaults to "bottom". */
    side?: "top" | "bottom" | "left" | "right";
    /** Pins which shape the sheets draw, for previews and tests. */
    isMobile?: boolean;
}

export function SessionMenu(props: SessionMenuProps) {
    if (props.machine) {
        return <MachineSessionMenu {...props} machine={props.machine} />;
    }
    return <BaseSessionMenu {...props} isWorking={props.working ?? false} />;
}

function MachineSessionMenu({ machine, ...props }: SessionMenuProps & { machine: SessionRef }) {
    const isWorking = useSelector(machine, phaseOf) !== "idle";
    return <BaseSessionMenu {...props} machine={machine} isWorking={isWorking} />;
}

function BaseSessionMenu({
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

    return (
        <>
            <Popover open={open} onOpenChange={onOpenChange}>
                <PopoverTrigger
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
                </PopoverTrigger>
                <PopoverContent
                    id={`${id}-popup`}
                    role="menu"
                    side={side}
                    align={align}
                    sideOffset={6}
                    className="w-56 bg-card p-1 text-foreground elevation-raised"
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
                        Rename…
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
                        Fork…
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
                        onSelect={() => choose("delete")}
                    >
                        Delete…
                    </MenuRow>
                    {activeSession && (
                        <MenuRow
                            id={`${id}-detach`}
                            icon={
                                <Icon>
                                    <Unplug />
                                </Icon>
                            }
                            onSelect={detach}
                        >
                            Detach
                        </MenuRow>
                    )}
                </PopoverContent>
            </Popover>
            {activeSession && (
                <RenameSession
                    session={activeSession}
                    open={view === "rename"}
                    onOpenChange={(next) => {
                        if (!next) setView("menu");
                    }}
                    initial={name}
                    onRenamed={renamed}
                    isMobile={isMobile}
                />
            )}
            {activeSession && (
                <ForkSession
                    session={activeSession}
                    open={view === "fork"}
                    onOpenChange={(next) => {
                        if (!next) setView("menu");
                    }}
                    onForked={adopted}
                    isMobile={isMobile}
                />
            )}
            <DeleteSession
                session={activeSession}
                file={file}
                open={view === "delete"}
                onOpenChange={(next) => {
                    if (!next) setView("menu");
                }}
                onDeleted={deleted}
                isMobile={isMobile}
            />
        </>
    );
}

/** One row of the menu: a glyph, a name, and what the press does. */
function MenuRow({
    id,
    icon,
    disabled = false,
    onSelect,
    children,
}: {
    id: string;
    icon: ReactNode;
    disabled?: boolean;
    onSelect: () => void;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            id={id}
            role="menuitem"
            disabled={disabled}
            onClick={onSelect}
            className="
                flex w-full items-center gap-2 rounded-md p-2 text-left text-body-md outline-none
                hover:bg-accent
                focus-visible:bg-accent
                disabled:pointer-events-none disabled:opacity-50
            "
        >
            <span className="flex size-4 shrink-0 text-muted-foreground [&_svg]:size-4" aria-hidden>
                {icon}
            </span>
            {children}
        </button>
    );
}
