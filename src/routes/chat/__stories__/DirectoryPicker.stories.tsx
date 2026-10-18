import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Listing, SessionSummary } from "@/lib/bridge";
import { queryDefaults } from "@/lib/query";
import { DirectoryPicker } from "@/routes/chat/picker/DirectoryPicker";
import { sessionSummary } from "@/preview/fixtures";

/**
 * The rows come from the host (`list_dirs`) and the recent folders from its sessions
 * (`list_sessions`), which no story can call: each story seeds the cache with the
 * answers instead, under the key of the level they belong to, where `""` is the home
 * of the machine, and under `["sessions", "local"]` for the recents. The candidates
 * are picked from those rows by the picker itself, so typing in a preview needs no
 * second answer from anywhere.
 */
const LEVELS: Record<string, Listing> = {
    "": {
        directory: "/home/kui",
        entries: [
            { name: "Projects", path: "/home/kui/Projects", isDir: true },
            { name: "pictures", path: "/home/kui/pictures", isDir: true },
            { name: "Documents", path: "/home/kui/Documents", isDir: true },
            { name: "notes.txt", path: "/home/kui/notes.txt", isDir: false },
        ],
    },
    "/home/kui/Projects": {
        directory: "/home/kui/Projects",
        entries: [
            { name: "pie", path: "/home/kui/Projects/pie", isDir: true },
            { name: "pi_rpc", path: "/home/kui/Projects/pi_rpc", isDir: true },
            { name: "README.md", path: "/home/kui/Projects/README.md", isDir: false },
        ],
    },
    "/home/kui/Projects/pie": {
        directory: "/home/kui/Projects/pie",
        entries: [{ name: "src", path: "/home/kui/Projects/pie/src", isDir: true }],
    },
};

/** The directories pi holds sessions in: the latest three are the recent folders. */
const SESSIONS: SessionSummary[] = [
    sessionSummary({ cwd: "/home/kui/Projects/pie", modified: "2026-01-04T00:00:00.000Z" }),
    sessionSummary({ cwd: "/srv/www", modified: "2026-01-03T00:00:00.000Z" }),
    sessionSummary({ cwd: "/home/kui/Projects", modified: "2026-01-02T00:00:00.000Z" }),
    sessionSummary({ cwd: "/home/kui/Documents", modified: "2026-01-01T00:00:00.000Z" }),
];

/** A home with more folders than the frame can hold: the rows scroll under the field. */
const MANY: Listing = {
    directory: "/home/kui",
    entries: Array.from({ length: 40 }, (_, at) => {
        const name = `.folder-${String(at + 1).padStart(2, "0")}`;
        return { name, path: `/home/kui/${name}`, isDir: true };
    }),
};

function Seeded({
    levels,
    sessions,
    children,
}: {
    levels: Record<string, Listing>;
    sessions: SessionSummary[];
    children: ReactNode;
}) {
    const [client] = useState(() => {
        const client = new QueryClient(queryDefaults);
        for (const [path, listing] of Object.entries(levels)) {
            client.setQueryData(["dirs", "local", path], listing);
        }
        client.setQueryData(["sessions", "local"], sessions);
        return client;
    });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const meta = {
    title: "Chat/DirectoryPicker",
    component: DirectoryPicker,
    parameters: { layout: "fullscreen", levels: LEVELS, sessions: SESSIONS },
    decorators: [
        (Story, context) => (
            <Seeded
                levels={context.parameters.levels as Record<string, Listing>}
                sessions={context.parameters.sessions as SessionSummary[]}
            >
                <Story />
            </Seeded>
        ),
    ],
    args: {
        endpoint: "local",
        open: true,
        onOpenChange: () => undefined,
        onPick: () => undefined,
        isMobile: false,
    },
} satisfies Meta<typeof DirectoryPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The desktop shape: a dialog with the recent folders above the home of the host. */
export const Home: Story = {};

/** The same, as the sheet a thumb can reach: a long list scrolls under the field. */
export const Phone: Story = {
    args: { isMobile: true },
    parameters: { levels: { "": MANY }, sessions: [] },
};

/** A folder that holds no folder, and no session anywhere: the level says so. */
export const Empty: Story = {
    parameters: { levels: { "": { directory: "/home/kui", entries: [] } }, sessions: [] },
};

/** A long level: the rows scroll while the field and its mark stand still. */
export const Many: Story = {
    parameters: { levels: { "": MANY }, sessions: [] },
};
