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

export interface SessionMenuProps {
    session: string;
    machine: SessionRef;
    endpoint: string;
    /** Whether the popup is open. The caller holds this, so one popup is open at a time. */
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The conversation is given up: the process ends and the screen leaves it. */
    onClose: () => void;
    /** The conversation is gone: the screen leaves it without ending a process. */
    onGone: () => void;
    /** Pins which shape the sheets draw, for previews and tests. */
    isMobile?: boolean;
}

export function SessionMenu({
    session,
    machine,
    endpoint,
    open,
    onOpenChange,
    onClose,
    onGone,
    isMobile,
}: SessionMenuProps) {
    const client = useQueryClient();
    const [view, setView] = useState<"menu" | "rename" | "fork" | "delete">("menu");
    // Pi replaces the session to fork or copy; a run in flight would be aborted by that,
    // so the two rows wait for the session to be idle.
    const working = useSelector(machine, phaseOf) !== "idle";
    // The name and the file of the conversation come from the same cache the bar reads.
    const state = useQuery({ ...sessionQueries.state(session), enabled: open });
    const file = state.data?.sessionFile ?? null;
    const name = state.data?.sessionName ?? null;

    /** The process holds another conversation: everything of the old one goes, and the reads answer again. */
    function adopted() {
        void client.cancelQueries({ queryKey: sessionKeys.whole(session) });
        void client.invalidateQueries({ queryKey: sessionKeys.whole(session) });
        void client.invalidateQueries({ queryKey: ["sessions", endpoint] });
        machine.send({ type: "REPLACED" });
    }

    /** The name the host lists has changed. */
    function renamed() {
        void client.invalidateQueries({ queryKey: ["sessions", endpoint] });
    }

    /** The process ended and the file is gone. */
    function deleted() {
        void client.invalidateQueries({ queryKey: ["connection"] });
        void client.invalidateQueries({ queryKey: ["sessions", endpoint] });
        onGone();
    }

    function clone() {
        onOpenChange(false);
        void bridge
            .cloneSession(session)
            .then((result) => {
                if (result.cancelled) {
                    toast("An extension refused the copy.");
                    return;
                }
                adopted();
            })
            .catch((thrown: unknown) => toast.error(bridge.asPieError(thrown).message));
    }

    function choose(next: "rename" | "fork" | "delete") {
        onOpenChange(false);
        setView(next);
    }

    return (
        <>
            <Popover open={open} onOpenChange={onOpenChange}>
                <PopoverTrigger
                    render={<Button id="session-menu" variant="ghost" size="icon-sm" aria-label="Session actions" />}
                >
                    <EllipsisVertical />
                </PopoverTrigger>
                <PopoverContent
                    id="session-menu-popup"
                    role="menu"
                    side="bottom"
                    align="end"
                    sideOffset={6}
                    className="elevation-raised bg-card text-foreground w-56 p-1"
                >
                    <MenuRow id="session-menu-rename" icon={<Pencil />} onSelect={() => choose("rename")}>
                        Rename…
                    </MenuRow>
                    <MenuRow
                        id="session-menu-fork"
                        icon={<GitFork />}
                        disabled={working}
                        onSelect={() => choose("fork")}
                    >
                        Fork…
                    </MenuRow>
                    <MenuRow id="session-menu-clone" icon={<Copy />} disabled={working} onSelect={clone}>
                        Clone
                    </MenuRow>
                    <MenuRow
                        id="session-menu-delete"
                        icon={<Trash2 />}
                        disabled={file === null}
                        onSelect={() => choose("delete")}
                    >
                        Delete…
                    </MenuRow>
                    <MenuRow id="session-menu-detach" icon={<Unplug />} onSelect={onClose}>
                        Detach
                    </MenuRow>
                </PopoverContent>
            </Popover>
            <RenameSession
                session={session}
                open={view === "rename"}
                onOpenChange={(next) => {
                    if (!next) setView("menu");
                }}
                initial={name}
                onRenamed={renamed}
                isMobile={isMobile}
            />
            <ForkSession
                session={session}
                open={view === "fork"}
                onOpenChange={(next) => {
                    if (!next) setView("menu");
                }}
                onForked={adopted}
                isMobile={isMobile}
            />
            <DeleteSession
                session={session}
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
            className="hover:bg-accent focus-visible:bg-accent text-body-md flex w-full items-center gap-2 rounded-md p-2 text-left outline-none disabled:pointer-events-none disabled:opacity-50"
        >
            <span className="text-muted-foreground flex size-4 shrink-0 [&_svg]:size-4" aria-hidden>
                {icon}
            </span>
            {children}
        </button>
    );
}
