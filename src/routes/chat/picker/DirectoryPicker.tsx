/**
 * The directory of a new conversation: one field that names it, and the folders
 * of the level it names, drawn as a dialog on a desktop and a sheet on a phone.
 *
 */

import { useEffect, useRef, useState } from "react";
import { CornerUpLeft, Folder, Search, X } from "lucide-react";
import { cn } from "cn";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { join } from "pathe";

import { useIsMobile } from "@/hooks/usePlatform";
import * as bridge from "@/lib/bridge";
import {
    climbFrom,
    displayParts,
    displayPath,
    drillPath,
    expandTilde,
    isAbsolutePath,
    matchDirs,
    querySplit,
    trimPath,
} from "@/lib/match-dirs";
import { directoryQueries, sessionsQueries } from "@/lib/query";
import { groupSessions, pathKey } from "@/routes/chat/sidebar/session-list";
import {
    Button,
    Dialog,
    DialogClose,
    DialogContent,
    DialogTitle,
    Drawer,
    DrawerClose,
    DrawerContent,
    DrawerTitle,
    InputGroup,
    InputGroupAddon,
    InputGroupButton,
    InputGroupInput,
    Skeleton,
    Spinner,
} from "@/components/ui";

/** How long typing must stand still before the host is asked for a level. */
const READ_DELAY = 300;

const TITLE = "Choose a folder";

/** How many recent folders the picker shows. */
const RECENTS = 3;

/** The widths of the name bars while rows are on their way. */
const BARS = ["w-2/5", "w-3/5", "w-1/3", "w-1/2"];

/** One row in view: a recent folder, the way up, or a folder of the level. */
interface Offer {
    /** The folder the row names. */
    path: string;
    /** Which group it stands in, and what a press means. */
    kind: "recent" | "up" | "folder";
}

export interface DirectoryPickerProps {
    /** The host whose directories these are (`local`, or `user@host:port`). */
    endpoint: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The directory that was confirmed; `null` is the home directory of the host. */
    onPick: (cwd: string | null) => void;
    /** Pins which shape to draw, for previews and tests. */
    isMobile?: boolean;
}

export function DirectoryPicker({ endpoint, open, onOpenChange, onPick, isMobile }: DirectoryPickerProps) {
    // Called whatever `isMobile` says, so pinning it and then stopping is not a
    // change in how many hooks there are.
    const mobile = useIsMobile();
    const touch = isMobile ?? mobile;
    const client = useQueryClient();

    // The home of the host is read once: it names the level of an empty field.
    const home = useQuery({ ...directoryQueries.list(endpoint), enabled: open });
    const homePath = home.data?.directory ?? null;

    // The text of the field: the answer, as typed or as selected. Defaults to
    // the home of the machine.
    const [text, setText] = useState(() => (homePath ? drillPath(homePath) : ""));
    const filledRef = useRef(Boolean(homePath));
    // The row the keyboard is on; `null` lights the first row.
    const [cursor, setCursor] = useState<number | null>(null);
    // The path the second layer offers to make; `null` offers nothing.
    const [making, setMaking] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [createFailed, setCreateFailed] = useState<string | null>(null);
    const [probeFailed, setProbeFailed] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!open) {
            filledRef.current = false;
            return;
        }
        if (homePath && !filledRef.current && text === "") {
            setText(drillPath(homePath));
            filledRef.current = true;
            requestAnimationFrame(() => {
                const input = inputRef.current;
                if (!input) return;
                const len = input.value.length;
                input.setSelectionRange(len, len);
            });
        }
    }, [open, homePath, text]);

    useEffect(() => {
        if (!open) return;
        const focusToEnd = () => {
            const input = inputRef.current;
            if (!input) return;
            input.focus();
            const len = input.value.length;
            input.setSelectionRange(len, len);
        };
        focusToEnd();
        const frame = requestAnimationFrame(focusToEnd);
        return () => cancelAnimationFrame(frame);
    }, [open]);

    // The level the live text asks for:
    const live = querySplit(text, homePath);

    // The parent level to list from the host, debounced for typed text:
    const [requestedParent, setRequestedParent] = useState<string | null>(null);

    useEffect(() => {
        const timer = setTimeout(() => {
            setRequestedParent(live.parent);
        }, READ_DELAY);
        return () => clearTimeout(timer);
    }, [live.parent]);

    const level = useQuery({ ...directoryQueries.list(endpoint, requestedParent ?? undefined), enabled: open });
    // Host order is random, so the level reads A-Z, case flat.
    const folders =
        level.data?.entries
            .filter((row) => row.isDir)
            .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" })) ?? [];
    const matched = matchDirs(folders, live.stub);

    // The folders pi holds sessions in, most recently written first.
    const sessions = useQuery({ ...sessionsQueries.list(endpoint), enabled: open });
    const recalled = groupSessions(sessions.data ?? [])
        .map((group) => group.cwd)
        .filter((cwd) => cwd !== "")
        .slice(0, RECENTS);
    // A text that names another level steps the recent folders aside; a typed name
    // narrows them the way it narrows the level.
    const inHome = live.parent === null;
    const recents = !inHome
        ? []
        : live.stub === ""
          ? recalled
          : recalled.filter((path) => displayParts(path).leaf.toLowerCase().includes(live.stub.toLowerCase()));
    const folderRows = matched.filter((row) => !recents.some((path) => path === row.path));
    const up = climbFrom(text, homePath);
    const offers: Offer[] = [
        ...recents.map((path): Offer => ({ path, kind: "recent" })),
        ...(up === null ? [] : [{ path: up, kind: "up" } as Offer]),
        ...folderRows.map((row): Offer => ({ path: row.path, kind: "folder" })),
    ];

    const levelStale = (live.parent ?? "") !== (requestedParent ?? "");
    // A query that never ran stays pending: only a fetch in flight reads.
    const reading = home.isPending || level.isFetching || levelStale;
    const failure = level.error;

    // The row the keyboard is on: the one it is on, else the first.
    const lit = offers.length === 0 ? -1 : Math.min(cursor ?? 0, offers.length - 1);

    /** The field changed by a press or a key: the choice starts over on the new text. */
    const settle = () => {
        setCursor(null);
        setMaking(null);
        setCreateFailed(null);
        setProbeFailed(null);
    };

    /** A press on a row walks into that folder. */
    const press = (offer: Offer) => {
        const next = drillPath(offer.path);
        setText(next);
        const split = querySplit(next, homePath);
        setRequestedParent(split.parent);
        settle();
    };

    const clear = () => {
        filledRef.current = true;
        setText("");
        setRequestedParent(null);
        settle();
        inputRef.current?.focus();
    };

    const changeText = (value: string) => {
        filledRef.current = true;
        setText(value);
        settle();
    };

    /** Every state of the picker starts over: the next open shows the home again. */
    const wipe = () => {
        setText(homePath ? drillPath(homePath) : "");
        setRequestedParent(null);
        setCursor(null);
        setMaking(null);
        setCreating(false);
        setCreateFailed(null);
        setProbeFailed(null);
        filledRef.current = Boolean(homePath);
    };

    /** The field answers: empty is the home of the machine. */
    const pick = (cwd: string | null) => {
        wipe();
        onPick(cwd);
    };

    /** The field's answer: a name takes the lit folder, a path opens or asks to be made. */
    const proceed = () => {
        if (reading || failure !== null || making !== null || creating) return;
        const raw = text.trim();
        if (raw === "") {
            pick(null);
            return;
        }
        const expanded = expandTilde(raw, homePath);
        // A name is not a path: answer with the folder the keyboard is on.
        if (!isAbsolutePath(expanded) && !raw.includes("/") && !raw.includes("\\")) {
            const offer = offers[lit];
            if (offer !== undefined) pick(offer.path);
            return;
        }
        const base = homePath !== null ? trimPath(homePath) : "";
        const resolved = isAbsolutePath(expanded) ? expanded : base !== "" ? join(base, expanded) : expanded;
        const value = trimPath(resolved);
        // The home of the machine is no path of pie's.
        if (homePath !== null && value === trimPath(homePath)) {
            pick(null);
            return;
        }
        // A row in view already names a folder the host has: no probe is needed.
        if (
            offers.some((offer) => offer.path === value) ||
            (level.data?.directory !== undefined && trimPath(level.data.directory) === value)
        ) {
            pick(value);
            return;
        }
        void bridge
            .dirExists(value)
            .then((stands) => {
                if (stands) pick(value);
                else setMaking(value);
            })
            .catch((thrown: unknown) => setProbeFailed(bridge.asPieError(thrown).message));
    };

    const create = () => {
        if (making === null || creating) return;
        setCreating(true);
        setCreateFailed(null);
        void bridge
            .createDir(making)
            .then(() => {
                void client.invalidateQueries({ queryKey: ["dirs", endpoint] });
                pick(making);
            })
            .catch((thrown: unknown) => setCreateFailed(bridge.asPieError(thrown).message))
            .finally(() => setCreating(false));
    };

    const closeMake = () => setMaking(null);

    /** The surface asked to close: the next open starts clean. */
    const changeOpen = (next: boolean) => {
        if (!next) wipe();
        onOpenChange(next);
    };

    const onFieldKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Tab") {
            // Rows of another level say nothing about live text: hold focus
            // until theirs arrive.
            if (levelStale) {
                event.preventDefault();
                return;
            }
            const offer = offers[lit];
            if (!reading && offer !== undefined) {
                event.preventDefault();
                press(offer);
            }
            return;
        }
        if (event.key === "Enter") {
            event.preventDefault();
            proceed();
            return;
        }
        if (event.key === "Escape" && text !== "") {
            // The first Escape puts the typing away; the next one is the surface's own.
            event.preventDefault();
            event.stopPropagation();
            clear();
            return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        if (offers.length === 0) return;
        event.preventDefault();
        setCursor((current) => {
            const at = (current ?? 0) + (event.key === "ArrowDown" ? 1 : -1);
            return (at + offers.length) % offers.length;
        });
    };

    const header = <DirectoryHeader touch={touch} />;
    const fieldRow = (
        <DirectoryField
            inputRef={inputRef}
            touch={touch}
            text={text}
            reading={reading}
            disabled={reading || failure !== null || making !== null || creating}
            onTextChange={changeText}
            onKeyDown={onFieldKey}
            onClear={clear}
            onOpen={proceed}
        />
    );
    const list = (
        <DirectoryList
            touch={touch}
            reading={reading}
            failure={failure}
            probeFailed={probeFailed}
            offers={offers}
            lit={lit}
            stub={live.stub}
            makeHint={
                !inHome && text.trim() !== "" && live.stub !== "" ? `Open creates \u201c${text.trim()}\u201d` : null
            }
            onPress={press}
        />
    );
    const confirm = making !== null && (
        <DirectoryCreateConfirm
            touch={touch}
            making={making}
            creating={creating}
            createFailed={createFailed}
            onCreate={create}
            onCloseMake={closeMake}
        />
    );

    if (touch) {
        return (
            <Drawer open={open} onOpenChange={changeOpen} swipeDirection="down" showSwipeHandle>
                <DrawerContent
                    initialFocus={inputRef}
                    // A cap, not a height: the sheet wraps its content, and a long
                    // level scrolls inside it instead of pushing its keys away.
                    className="flex max-h-[70dvh] flex-col gap-4 border-border px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] outline-none"
                >
                    {header}
                    <div className="flex min-h-0 flex-1 flex-col gap-3">
                        {fieldRow}
                        <div id="directory-picker-scroll" className="max-h-96 min-h-0 overflow-y-auto">
                            {list}
                        </div>
                    </div>
                    {confirm}
                </DrawerContent>
            </Drawer>
        );
    }

    return (
        <Dialog open={open} onOpenChange={changeOpen}>
            <DialogContent
                showCloseButton={false}
                initialFocus={inputRef}
                // Anchored to the top so content height changes do not shift the field.
                className="top-[15vh] flex max-h-[70dvh] translate-y-0 flex-col rounded-xl border border-border bg-card p-6 text-foreground sm:w-full sm:max-w-2xl"
            >
                {header}
                <div className="flex min-h-0 flex-1 flex-col gap-3">
                    {fieldRow}
                    <div id="directory-picker-scroll" className="max-h-64 min-h-0 overflow-y-auto">
                        {list}
                    </div>
                </div>
                {confirm}
            </DialogContent>
        </Dialog>
    );
}

/** The title with its own close key, level with it. */
function DirectoryHeader({ touch }: { touch: boolean }) {
    const Title = touch ? DrawerTitle : DialogTitle;
    const Close = touch ? DrawerClose : DialogClose;
    return (
        <div className="flex items-center justify-between gap-2">
            <Title className="text-body-md font-normal">{TITLE}</Title>
            <Close render={<Button variant="ghost" size="icon-sm" aria-label="Close" />}>
                <X />
            </Close>
        </div>
    );
}

interface DirectoryFieldProps {
    inputRef: React.RefObject<HTMLInputElement | null>;
    touch: boolean;
    /** What the field names. */
    text: string;
    /** A level is on its way: the Open key shows it. */
    reading: boolean;
    /** Nothing answers while a read is in flight or failed, or a making stands. */
    disabled: boolean;
    onTextChange: (value: string) => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
    onClear: () => void;
    onOpen: () => void;
}

/** The one field, under its search mark, with the clear key and the Open key at its end. */
function DirectoryField({
    inputRef,
    touch,
    text,
    reading,
    disabled,
    onTextChange,
    onKeyDown,
    onClear,
    onOpen,
}: DirectoryFieldProps) {
    return (
        <div className="flex items-center gap-2">
            <InputGroup id="directory-picker-path" className={cn(touch && "h-12")}>
                <InputGroupAddon align="inline-start">
                    <Search aria-hidden />
                </InputGroupAddon>
                <InputGroupInput
                    ref={inputRef}
                    id="directory-picker-field"
                    value={text}
                    placeholder="Search folders"
                    onChange={(event) => onTextChange(event.target.value)}
                    onKeyDown={onKeyDown}
                    aria-label="Folder path"
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="go"
                />
                {text !== "" && (
                    <InputGroupAddon align="inline-end">
                        <InputGroupButton
                            id="directory-picker-clear"
                            size="icon-xs"
                            aria-label="Clear"
                            title="Clear"
                            onClick={onClear}
                        >
                            <X />
                        </InputGroupButton>
                    </InputGroupAddon>
                )}
            </InputGroup>
            <Button className={cn("shrink-0", touch && "h-12")} disabled={disabled} onClick={onOpen}>
                {reading && <Spinner data-icon="inline-start" />}
                Open
            </Button>
        </div>
    );
}

interface DirectoryListProps {
    touch: boolean;
    reading: boolean;
    /** What the host reported, or `null` when it answered. */
    failure: unknown;
    /** What the probe reported, or `null` when it stood or was never asked. */
    probeFailed: string | null;
    /** The rows in view, in the order the keyboard walks them: recents, up, folders. */
    offers: readonly Offer[];
    /** The row the keyboard is on; `-1` lights nothing. */
    lit: number;
    /** The stub the heavy mark follows. */
    stub: string;
    /** What Open would make of a path that names nothing; `null` says nothing. */
    makeHint: string | null;
    onPress: (offer: Offer) => void;
}

/** The rows in view: skeleton, error, the recent folders and the level's own, or the word for none. */
function DirectoryList({
    touch,
    reading,
    failure,
    probeFailed,
    offers,
    lit,
    stub,
    makeHint,
    onPress,
}: DirectoryListProps) {
    // The row the list has already brought into view: the rows mount with the
    // popup's portal, so a row scrolls itself into view once the keyboard moves.
    const brought = useRef<string | null>(null);

    const hold = (offer: Offer, element: HTMLButtonElement | null) => {
        if (element === null) return;
        if (offers[lit]?.path === offer.path && brought.current !== offer.path) {
            brought.current = offer.path;
            element.scrollIntoView({ block: "nearest" });
        }
    };

    if (reading) return <DirectorySkeleton touch={touch} />;
    if (failure) {
        return (
            <div id="directory-picker-failure" role="alert" className="p-2">
                <p className="text-body-md text-muted-foreground">{bridge.asPieError(failure).message}</p>
            </div>
        );
    }
    if (probeFailed !== null) {
        return (
            <div id="directory-picker-failure" role="alert" className="p-2">
                <p className="text-body-md text-muted-foreground">{probeFailed}</p>
            </div>
        );
    }
    const recents = offers.filter((offer) => offer.kind === "recent");
    const up = offers.find((offer) => offer.kind === "up");
    const folders = offers.filter((offer) => offer.kind === "folder");
    const row = (offer: Offer) => (
        <DirectoryRow
            key={offer.path}
            offer={offer}
            lit={offers.indexOf(offer) === lit}
            stub={stub}
            touch={touch}
            onPress={onPress}
            hold={hold}
        />
    );
    return (
        <div
            role="listbox"
            id="directory-picker-offers"
            aria-label="Folders"
            className="flex flex-col gap-1 outline-none"
        >
            {recents.length > 0 && (
                <div role="group" aria-label="Recent folders" className="flex flex-col gap-1">
                    <p role="presentation" className="px-2 pt-1 text-body-sm text-muted-foreground">
                        Recent folders
                    </p>
                    {recents.map(row)}
                </div>
            )}
            <div role="group" aria-label="Folders" className="flex flex-col gap-1">
                <p role="presentation" className="px-2 pt-1 text-body-sm text-muted-foreground">
                    Folders
                </p>
                {up !== undefined && row(up)}
                {folders.map(row)}
                {folders.length === 0 && (
                    <div className="px-2 py-1">
                        <p className="text-body-md text-muted-foreground">
                            {stub === "" ? "No folders here" : "No folders match"}
                        </p>
                        {makeHint !== null && (
                            <p className="text-body-md break-all text-muted-foreground">{makeHint}</p>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

interface DirectoryRowProps {
    offer: Offer;
    lit: boolean;
    stub: string;
    touch: boolean;
    onPress: (offer: Offer) => void;
    hold: (offer: Offer, element: HTMLButtonElement | null) => void;
}

/** One row: its mark, the path with a weak head and a plain name, and a tail. */
function DirectoryRow({ offer, lit, stub, touch, onPress, hold }: DirectoryRowProps) {
    const parts = displayParts(offer.path);
    const up = offer.kind === "up";
    return (
        <button
            type="button"
            id={`directory-picker-row-${pathKey(offer.path)}`}
            role="option"
            aria-selected={lit}
            aria-label={up ? `Up to ${offer.path}` : offer.path}
            data-path={offer.path}
            data-lit={lit}
            ref={(element) => hold(offer, element)}
            onClick={() => onPress(offer)}
            className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 text-left text-foreground outline-none focus-visible:bg-accent",
                "data-[lit=true]:bg-accent",
                touch ? "min-h-12" : "min-h-9",
            )}
        >
            {up ? (
                <CornerUpLeft className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            ) : (
                <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="min-w-0 flex-1 truncate text-body-md">
                <span className="text-muted-foreground">{parts.head}</span>
                <Name name={parts.leaf} stub={stub} />
                {parts.leaf !== "" && <span className="text-muted-foreground">/</span>}
            </span>
        </button>
    );
}

/** A name with its matched stub heavy, as the reference shows the match. */
function Name({ name, stub }: { name: string; stub: string }) {
    const at = stub === "" ? -1 : name.toLowerCase().indexOf(stub.toLowerCase());
    if (at === -1) return <>{name}</>;
    return (
        <>
            {name.slice(0, at)}
            <span className="font-semibold">{name.slice(at, at + stub.length)}</span>
            {name.slice(at + stub.length)}
        </>
    );
}

interface DirectoryCreateConfirmProps {
    touch: boolean;
    /** The missing path; the layer only renders while this stands. */
    making: string;
    creating: boolean;
    createFailed: string | null;
    onCreate: () => void;
    onCloseMake: () => void;
}

/** The nested layer: the missing path asks to be made. Same body, container follows touch. */
function DirectoryCreateConfirm({
    touch,
    making,
    creating,
    createFailed,
    onCreate,
    onCloseMake,
}: DirectoryCreateConfirmProps) {
    const body = (
        <>
            <p className="flex items-center gap-2 text-body-md text-foreground">
                <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{displayPath(making)}</span>
            </p>
            <p id="directory-picker-make-description" className="text-body-md text-muted-foreground">
                This folder does not exist.
            </p>
            {createFailed !== null && (
                <p role="alert" className="text-body-md text-muted-foreground">
                    {createFailed}
                </p>
            )}
            <div className="flex gap-2">
                <Button size="sm" disabled={creating} onClick={onCreate}>
                    {creating ? "Making…" : "Create folder"}
                </Button>
                <Button variant="outline" size="sm" disabled={creating} onClick={onCloseMake}>
                    Cancel
                </Button>
            </div>
        </>
    );
    if (touch) {
        return (
            <Drawer open onOpenChange={(next) => !next && onCloseMake()} swipeDirection="down">
                <DrawerContent
                    className="flex flex-col gap-4 border-border px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] outline-none"
                    aria-describedby="directory-picker-make-description"
                >
                    <DrawerTitle>Create folder</DrawerTitle>
                    <div className="mt-4 flex flex-col gap-2 text-muted-foreground">{body}</div>
                </DrawerContent>
            </Drawer>
        );
    }
    return (
        <Dialog open onOpenChange={(next) => !next && onCloseMake()}>
            <DialogContent
                showCloseButton={false}
                className="top-[15vh] flex translate-y-0 flex-col gap-4 rounded-xl border border-border bg-card p-6 text-foreground"
                aria-describedby="directory-picker-make-description"
            >
                <DialogTitle className="text-body-md font-normal">Create folder</DialogTitle>
                <div className="flex flex-col gap-2 text-muted-foreground">{body}</div>
            </DialogContent>
        </Dialog>
    );
}

/** The rows on their way, drawn as the rows that will stand there. */
function DirectorySkeleton({ touch }: { touch: boolean }) {
    return (
        <div role="status" aria-label="Reading the folders" className="space-y-1">
            {BARS.map((bar) => (
                <div
                    key={bar}
                    aria-hidden
                    className={cn("flex items-center gap-2 rounded-lg p-2", touch ? "min-h-12" : "min-h-9")}
                >
                    <Skeleton className="size-4 shrink-0 motion-reduce:animate-none" />
                    <Skeleton className={cn("h-5", bar, "motion-reduce:animate-none")} />
                </div>
            ))}
        </div>
    );
}
