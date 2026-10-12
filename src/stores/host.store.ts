/**
 * The host of the last connection: what the gate fills in the next time it opens.
 *
 * Zustand rather than Query, because Rust holds no such fact — a connection dies
 * with the app, and nothing on the host records which machine this window spoke
 * to last. It is a value the app remembers, not a piece of server data that can
 * be refetched.
 *
 * A secret never enters this store. It is written to `localStorage`, so it holds
 * the transport, the address and which credential the person used, and the
 * credential itself stays in the form and in memory (PRODUCT.md).
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

/** What the gate remembers of a host that answered. */
export interface RememberedHost {
    transport: "local" | "ssh";
    /** The address as the person typed it. Empty for the local machine. */
    address: string;
    /** Which credential they used. The credential itself is not kept. */
    auth: "password" | "key";
}

interface HostStore {
    /** The host that answered last, or `null` when none has. */
    lastHost: RememberedHost | null;
    /** Keeps the host that answered, for the gate of the next launch. */
    remember: (host: RememberedHost) => void;
}

export const useHostStore = create<HostStore>()(
    persist(
        (set) => ({
            lastHost: null,
            remember: (host) => set({ lastHost: host }),
        }),
        {
            name: "pie.host",
            // The actions are not state: only the host itself is written down.
            partialize: (state) => ({ lastHost: state.lastHost }),
        },
    ),
);
