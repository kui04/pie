/**
 * The picker of a directory for a new conversation: the one field that names the
 * answer, the folders of the level it names, the recent folders pi holds sessions
 * in, and the second layer that offers to make a missing folder.
 *
 * The field is the answer: a press walks into that folder, and Tab walks
 * into the row the keyboard is on. Nothing but the keyboard moves the choice:
 * the rows carry no hover.
 *
 * The listing (`list_dirs`) and the recent folders (`list_sessions`) are Queries,
 * stubbed here: a test says what the host holds, and the picker walks it without a
 * machine. Rows are options.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Bridge from "@/lib/bridge";
import type { Listing, SessionSummary } from "@/lib/bridge";
import { queryDefaults } from "@/lib/query";
import { DirectoryPicker, type DirectoryPickerProps } from "@/routes/chat/picker/DirectoryPicker";
import { sessionSummary } from "@/preview/fixtures";

const bridge = vi.hoisted(() => ({
    listDirs: vi.fn<(path: string) => Promise<Listing>>(),
    homeDir: vi.fn<() => Promise<string | null>>(),
    listSessions: vi.fn<() => Promise<SessionSummary[]>>(),
    dirExists: vi.fn<(path: string) => Promise<boolean>>(),
    createDir: vi.fn<(path: string) => Promise<void>>(),
}));

vi.mock("@/lib/bridge", async (importOriginal) => ({
    ...(await importOriginal<typeof Bridge>()),
    ...bridge,
}));

/** What the stubbed machine holds, keyed by the path the read names (the home is `""`). */
const HOME: Listing = {
    directory: "/home/kui",
    entries: [
        { name: "projects", path: "/home/kui/projects", isDir: true },
        { name: "pictures", path: "/home/kui/pictures", isDir: true },
        { name: "Documents", path: "/home/kui/Documents", isDir: true },
        { name: "notes.txt", path: "/home/kui/notes.txt", isDir: false },
    ],
};
const HOST: Record<string, Listing> = {
    // The home answers under both its names: no path at all, and its own.
    "": HOME,
    "/home/kui": HOME,
    "/home/kui/projects": {
        directory: "/home/kui/projects",
        entries: [{ name: "pie", path: "/home/kui/projects/pie", isDir: true }],
    },
    "/home/kui/projects/pie": { directory: "/home/kui/projects/pie", entries: [] },
    "/home/kui/pictures": {
        directory: "/home/kui/pictures",
        entries: [{ name: "trip.jpg", path: "/home/kui/pictures/trip.jpg", isDir: false }],
    },
    "/home/kui/Projects": {
        directory: "/home/kui/Projects",
        entries: [
            { name: "pie", path: "/home/kui/Projects/pie", isDir: true },
            { name: "pi_rpc", path: "/home/kui/Projects/pi_rpc", isDir: true },
        ],
    },
    "/home": { directory: "/home", entries: [{ name: "kui", path: "/home/kui", isDir: true }] },
    "/srv": { directory: "/srv", entries: [{ name: "www", path: "/srv/www", isDir: true }] },
    "/": {
        directory: "/",
        entries: [
            { name: "srv", path: "/srv", isDir: true },
            { name: "home", path: "/home", isDir: true },
        ],
    },
};

/** The directories pi holds sessions in, newest first as the scan writes them. */
const SESSIONS: SessionSummary[] = [
    sessionSummary({ cwd: "/home/kui/Projects/pie", modified: "2026-01-04T00:00:00.000Z" }),
    sessionSummary({ cwd: "/srv/www", modified: "2026-01-03T00:00:00.000Z" }),
    sessionSummary({ cwd: "/home/kui/Projects", modified: "2026-01-02T00:00:00.000Z" }),
    // A fourth is beyond the picker's cap: it must not show.
    sessionSummary({ cwd: "/opt/tools", modified: "2026-01-01T00:00:00.000Z" }),
];

function renderPicker(props: Partial<DirectoryPickerProps> = {}) {
    const client = new QueryClient(queryDefaults);
    const onPick = vi.fn();
    const onOpenChange = vi.fn();
    render(
        <QueryClientProvider client={client}>
            <DirectoryPicker endpoint="local" open onOpenChange={onOpenChange} onPick={onPick} {...props} />
        </QueryClientProvider>,
    );
    return { onPick, onOpenChange };
}

/** The field, which names the answer. */
const field = () => screen.getByLabelText("Folder path");
/** A row of the picker, by the path it names (the way up says `Up to …`). */
const option = (name: string) => screen.findByRole("option", { name });
/** The rows in view, in the order the keyboard walks them. */
const labels = () => screen.getAllByRole("option").map((row) => row.getAttribute("aria-label"));
/** The settled list: the debounce and the fetch behind it have answered. */
const settled = (paths: string[]) => waitFor(() => expect(labels()).toEqual(paths));

describe("the directory picker", () => {
    beforeEach(() => {
        bridge.homeDir.mockReset();
        bridge.homeDir.mockResolvedValue("/home/kui");
        bridge.listDirs.mockReset();
        bridge.listDirs.mockImplementation(async (path: string) => HOST[path] ?? { directory: path, entries: [] });
        bridge.listSessions.mockReset();
        bridge.listSessions.mockResolvedValue(SESSIONS);
        bridge.dirExists.mockReset();
        bridge.dirExists.mockResolvedValue(false);
        bridge.createDir.mockReset();
        bridge.createDir.mockResolvedValue(undefined);
    });

    it("opens at the home of the host, with the recent folders first", async () => {
        renderPicker();

        // Recents newest first, then the up row to the level above, then the level A to Z, the cap kept.
        await settled([
            "/home/kui/Projects/pie",
            "/srv/www",
            "/home/kui/Projects",
            "Up to /home",
            "/home/kui/Documents",
            "/home/kui/pictures",
            "/home/kui/projects",
        ]);
        // The first read asks for the home directory.
        expect(bridge.listDirs).toHaveBeenCalledWith("/home/kui");
        expect(screen.queryByRole("option", { name: "/opt/tools" })).not.toBeInTheDocument();
        // A file is not a folder: the picker does not offer one.
        expect(screen.queryByRole("option", { name: "/home/kui/notes.txt" })).not.toBeInTheDocument();
        // The field starts with the home directory of the host, focused with cursor at the end.
        const input = field() as HTMLInputElement;
        expect(input).toHaveValue("/home/kui/");
        expect(input).toHaveAttribute("placeholder", "Search folders");
        expect(input).toHaveFocus();
        expect(input.selectionStart).toBe(input.value.length);
        expect(input.selectionEnd).toBe(input.value.length);
    });

    it("answers with the home directory of the host", async () => {
        const { onPick } = renderPicker();

        await option("/home/kui/projects");
        fireEvent.keyDown(field(), { key: "Enter" });

        expect(onPick).toHaveBeenCalledWith("/home/kui");
    });

    it("walks into the folder on a press", async () => {
        const { onPick } = renderPicker();

        fireEvent.click(await option("/home/kui/projects"));

        expect(await option("/home/kui/projects/pie")).toBeInTheDocument();
        expect(field()).toHaveValue("/home/kui/projects/");
        expect(bridge.listDirs).toHaveBeenLastCalledWith("/home/kui/projects");
        expect(document.querySelector('[data-slot="dialog-content"]')).not.toBeNull();
        expect(onPick).not.toHaveBeenCalled();
    });

    it("answers with the folder the field names at Open, without asking the host", async () => {
        const { onPick } = renderPicker();

        fireEvent.click(await option("/home/kui/projects"));
        const openButton = await screen.findByRole("button", { name: "Open" });
        fireEvent.click(openButton);

        expect(onPick).toHaveBeenCalledWith("/home/kui/projects");
        // A folder in view needs no question to the host.
        expect(bridge.dirExists).not.toHaveBeenCalled();
    });

    it("walks into the row on Tab", async () => {
        renderPicker();

        fireEvent.change(field(), { target: { value: "pic" } });
        await settled(["/home/kui/pictures"]);

        fireEvent.keyDown(field(), { key: "Tab" });

        expect(field()).toHaveValue("/home/kui/pictures/");
    });

    it("walks into the row the arrows lit, not only the first", async () => {
        renderPicker();

        fireEvent.change(field(), { target: { value: "p" } });
        await settled(["/home/kui/Projects/pie", "/home/kui/Projects", "/home/kui/pictures", "/home/kui/projects"]);

        fireEvent.keyDown(field(), { key: "ArrowDown" });
        fireEvent.keyDown(field(), { key: "Tab" });

        expect(field()).toHaveValue("/home/kui/Projects/");
    });

    it("draws the matched letters of a name heavy", async () => {
        renderPicker();

        fireEvent.change(field(), { target: { value: "pic" } });
        await settled(["/home/kui/pictures"]);

        // The stub draws heavy where the name holds it. The accessible-name query
        // cannot see across the mark's element edge, so the mark is read from the
        // markup it leaves.
        const row = screen.getByRole("option", { name: "/home/kui/pictures" });
        expect(row.querySelector(".font-semibold")?.textContent).toBe("pic");
    });

    it("shows a path with the head weak and the name plain", async () => {
        renderPicker();

        const row = await option("/home/kui/projects");

        const name = row.querySelector("span.truncate");
        expect(name?.firstElementChild?.textContent).toBe("/home/kui/");
        expect(name?.textContent).toBe("/home/kui/projects/");
    });

    it("answers with the folder the keyboard is on when a name is typed", async () => {
        const { onPick } = renderPicker();

        fireEvent.change(field(), { target: { value: "pic" } });
        await settled(["/home/kui/pictures"]);
        fireEvent.keyDown(field(), { key: "Enter" });

        expect(onPick).toHaveBeenCalledWith("/home/kui/pictures");
        // A name is not a path: nothing to probe.
        expect(bridge.dirExists).not.toHaveBeenCalled();
    });

    it("opens a typed path that stands in view without asking the host", async () => {
        const { onPick } = renderPicker();

        fireEvent.change(field(), { target: { value: "/srv/www" } });
        await settled(["Up to /", "/srv/www"]);
        fireEvent.keyDown(field(), { key: "Enter" });

        expect(onPick).toHaveBeenCalledWith("/srv/www");
        expect(bridge.dirExists).not.toHaveBeenCalled();
    });

    it("asks the host about a typed path that is not in view and opens it when it stands", async () => {
        bridge.dirExists.mockResolvedValue(true);
        const { onPick } = renderPicker();

        fireEvent.change(field(), { target: { value: "/srv/empty" } });
        expect(await screen.findByText("No folders match")).toBeInTheDocument();
        fireEvent.keyDown(field(), { key: "Enter" });

        expect(bridge.dirExists).toHaveBeenLastCalledWith("/srv/empty");
        await waitFor(() => expect(onPick).toHaveBeenCalledWith("/srv/empty"));
        expect(bridge.createDir).not.toHaveBeenCalled();
    });

    it("names what Open would create when nothing matches", async () => {
        renderPicker();

        fireEvent.change(field(), { target: { value: "/srv/empty" } });

        expect(await screen.findByText("No folders match")).toBeInTheDocument();
        expect(screen.getByText("Open creates \u201c/srv/empty\u201d")).toBeInTheDocument();
    });

    it("asks in a second dialog before making a typed path that names nothing", async () => {
        const { onPick } = renderPicker();

        fireEvent.change(field(), { target: { value: "/srv/empty" } });
        expect(await screen.findByText("No folders match")).toBeInTheDocument();
        fireEvent.keyDown(field(), { key: "Enter" });

        expect(bridge.dirExists).toHaveBeenLastCalledWith("/srv/empty");
        expect(await screen.findByText("This folder does not exist.")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Create folder" }));

        expect(bridge.createDir).toHaveBeenLastCalledWith("/srv/empty");
        await waitFor(() => expect(onPick).toHaveBeenCalledWith("/srv/empty"));
    });

    it("leaves the second dialog without making anything on Cancel", async () => {
        renderPicker();

        fireEvent.change(field(), { target: { value: "/srv/empty" } });
        expect(await screen.findByText("No folders match")).toBeInTheDocument();
        fireEvent.keyDown(field(), { key: "Enter" });
        await screen.findByText("This folder does not exist.");

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

        expect(bridge.createDir).not.toHaveBeenCalled();
        expect(screen.queryByText("This folder does not exist.")).not.toBeInTheDocument();
    });

    it("says what the host reported when the probe fails", async () => {
        bridge.dirExists.mockRejectedValue({
            kind: "failed",
            message: "cannot read /srv/empty: permission denied",
        });
        renderPicker();

        fireEvent.change(field(), { target: { value: "/srv/empty" } });
        expect(await screen.findByText("No folders match")).toBeInTheDocument();
        fireEvent.keyDown(field(), { key: "Enter" });

        expect(await screen.findByRole("alert")).toHaveTextContent("cannot read /srv/empty: permission denied");
    });

    it("says what the host reported when a level cannot be read", async () => {
        bridge.listDirs.mockRejectedValueOnce({
            kind: "failed",
            message: "cannot read /home/kui: permission denied",
        });
        renderPicker();

        expect(await screen.findByRole("alert")).toHaveTextContent("cannot read /home/kui: permission denied");
        expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    });

    it("draws the rows as bars while the level is on its way", async () => {
        // A listing that answers only when this test says so.
        const held: Array<() => void> = [];
        bridge.listDirs.mockImplementation(
            (path: string) =>
                new Promise((resolve) => {
                    held.push(() => resolve(HOST[path] ?? { directory: path, entries: [] }));
                }),
        );
        renderPicker();

        // The rows carry what will stand there: a folder's mark and a name's bar.
        const status = await screen.findByRole("status", { name: "Reading the folders" });
        expect(status.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(1);

        await waitFor(() => expect(held.length).toBeGreaterThan(0));
        for (const release of held) release();
        expect(await option("/home/kui/projects")).toBeInTheDocument();
    });

    it("spins the Open key while a level is on its way", async () => {
        // A listing that answers only when this test says so.
        const held: Array<() => void> = [];
        bridge.listDirs.mockImplementation(
            (path: string) =>
                new Promise((resolve) => {
                    held.push(() => resolve(HOST[path] ?? { directory: path, entries: [] }));
                }),
        );
        renderPicker();

        const open = screen.getByRole("button", { name: /Open/ });
        expect(open).toBeDisabled();
        expect(within(open).getByRole("status", { name: "Loading" })).toBeInTheDocument();

        await waitFor(() => expect(held.length).toBeGreaterThan(0));
        for (const release of held) release();
        expect(await option("/home/kui/projects")).toBeInTheDocument();
    });

    it("draws the sheet on a phone", async () => {
        renderPicker({ isMobile: true });

        expect(await option("/home/kui/projects")).toBeInTheDocument();
        expect(document.querySelector('[data-slot="drawer-popup"]')).not.toBeNull();
        expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
    });

    it("asks in a nested drawer on a phone", async () => {
        renderPicker({ isMobile: true });

        fireEvent.change(field(), { target: { value: "/srv/empty" } });
        expect(await screen.findByText("No folders match")).toBeInTheDocument();
        fireEvent.keyDown(field(), { key: "Enter" });

        expect(await screen.findByText("This folder does not exist.")).toBeInTheDocument();
        expect(document.querySelectorAll('[data-slot="drawer-popup"]').length).toBe(2);
    });

    it("clears the typing with the clear key", async () => {
        renderPicker();

        await option("/home/kui/projects");
        expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();

        fireEvent.change(field(), { target: { value: "pic" } });
        await settled(["/home/kui/pictures"]);
        fireEvent.click(screen.getByRole("button", { name: "Clear" }));

        expect(field()).toHaveValue("");
        expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
        expect(await option("/home/kui/Documents")).toBeInTheDocument();
    });

    it("clears the typing with the first Escape, before the surface closes", async () => {
        const { onOpenChange } = renderPicker();

        fireEvent.change(field(), { target: { value: "pic" } });
        await settled(["/home/kui/pictures"]);
        fireEvent.keyDown(field(), { key: "Escape" });

        expect(field()).toHaveValue("");
        expect(onOpenChange).not.toHaveBeenCalled();
    });

    it("closes on its own key", async () => {
        const { onOpenChange, onPick } = renderPicker();

        await option("/home/kui/projects");
        fireEvent.click(screen.getByRole("button", { name: "Close" }));

        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(onPick).not.toHaveBeenCalled();
    });

    it("draws the phone sheet without its close key and with compact keys", async () => {
        renderPicker({ isMobile: true });

        await option("/home/kui/projects");

        expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
        expect(document.querySelector('[data-slot="drawer-popup"]')).toHaveClass("h-[80dvh]", "max-h-[80dvh]");
        const viewport = document.querySelector('[data-slot="scroll-area-viewport"]');
        expect(viewport).not.toHaveClass("max-h-96");
        expect(screen.getByText("Recent folders")).toHaveClass("sticky", "top-0");
        expect(screen.getByText("Folders")).toHaveClass("sticky", "top-0");
        expect(field().closest('[data-slot="input-group"]')).toHaveClass("h-10");
        expect(screen.getByRole("button", { name: "Open" })).toHaveClass("h-10");
        expect(document.querySelector("#directory-picker-scroll")).toHaveClass("flex-1");
    });

    it("says that a folder holds no folder", async () => {
        renderPicker();

        fireEvent.change(field(), { target: { value: "/home/kui/projects/pie/" } });

        expect(await screen.findByText("No folders here")).toBeInTheDocument();
    });

    it("climbs with the up row", async () => {
        renderPicker();

        fireEvent.click(await option("/home/kui/projects"));
        fireEvent.click(await screen.findByRole("option", { name: "Up to /home/kui" }));

        expect(field()).toHaveValue("/home/kui/");
        expect(await option("/home/kui/projects")).toBeInTheDocument();
    });

    it("draws the up row to root as a single slash, not a double slash", async () => {
        renderPicker();

        fireEvent.change(field(), { target: { value: "/home/" } });
        const upRow = await screen.findByRole("option", { name: "Up to /" });
        expect(upRow).toBeInTheDocument();
        expect(upRow.querySelector(".truncate")?.textContent).toBe("/");
    });

    it("keeps the choice where the keyboard put it when the mouse moves", async () => {
        renderPicker();

        const first = await option("/home/kui/Projects/pie");
        const second = await option("/srv/www");
        expect(first).toHaveAttribute("data-lit", "true");
        expect(second).toHaveAttribute("data-lit", "false");

        fireEvent.mouseMove(second);
        fireEvent.mouseEnter(second);

        expect(first).toHaveAttribute("data-lit", "true");
        expect(second).toHaveAttribute("data-lit", "false");
    });

    it("narrows the recent folders to the typed name", async () => {
        renderPicker();

        await option("/home/kui/projects");
        fireEvent.change(field(), { target: { value: "pi" } });

        // The recents follow the same stub as the level: both headers stand.
        await settled(["/home/kui/Projects/pie", "/home/kui/pictures"]);
        expect(screen.getByText("Recent folders")).toBeInTheDocument();
        expect(screen.getByText("Folders")).toBeInTheDocument();
    });

    it("does not show a folder twice when a session stands in it", async () => {
        bridge.listSessions.mockResolvedValue([sessionSummary({ cwd: "/home/kui/projects" })]);
        renderPicker();

        // The recent row carries the folder: the level does not repeat it.
        await settled(["/home/kui/projects", "Up to /home", "/home/kui/Documents", "/home/kui/pictures"]);
    });
});
