/**
 * What the extensions of pi put on screen: the dialogs that wait for a person, and the
 * status lines they report.
 *
 * Zustand rather than Query, because Rust no longer holds a snapshot of this: a dialog
 * waits on the bus with an id, and a status line is a value the app remembers until the
 * next one arrives. Zustand rather than a machine, because nothing here has guarded
 * transitions - a dialog arrives, is answered, and is gone.
 *
 * The answer travels back on the bus under the id the ask carried, so this store never
 * names a conversation to Rust.
 */

import { create } from "zustand";
import * as bridge from "@/lib/bridge";
import { idOf, type SessionKey } from "@/lib/session/key";

/** One dialog that waits for an answer. */
export interface PendingDialog {
    /** Names the waiting ask on the bus. */
    id: number;
    /** The conversation that asked, so the dialog is drawn on its screen. */
    key: SessionKey;
    request: bridge.UiRequest;
}

/** One status line of the extension area. A `null` text clears the key. */
export interface StatusLine {
    key: string;
    text: string | null;
}

interface ExtensionStore {
    /** The dialogs that wait, per conversation, oldest first. */
    dialogs: Record<string, PendingDialog[]>;
    /** The status lines of each conversation, by the key the extension chose. */
    statuses: Record<string, StatusLine[]>;
    /** The text an extension put in the editor of each conversation. */
    editors: Record<string, string>;
    /** Takes one ask. A replay of an id already held replaces it. */
    asked: (key: SessionKey, id: number, request: bridge.UiRequest) => void;
    /** Forgets one dialog, once it is answered. */
    closed: (id: number) => void;
    /** Takes one status line, or clears the key when its text is `null`. */
    reported: (key: SessionKey, line: StatusLine) => void;
    /** Takes the text an extension put in the editor. */
    edited: (key: SessionKey, text: string) => void;
}

export const useExtensionStore = create<ExtensionStore>()((set) => ({
    dialogs: {},
    statuses: {},
    editors: {},

    asked: (key, id, request) =>
        set((state) => {
            const of = idOf(key);
            const held = (state.dialogs[of] ?? []).filter((dialog) => dialog.id !== id);
            return { dialogs: { ...state.dialogs, [of]: [...held, { id, key, request }] } };
        }),

    closed: (id) =>
        set((state) => {
            const dialogs: Record<string, PendingDialog[]> = {};
            for (const [of, held] of Object.entries(state.dialogs)) {
                dialogs[of] = held.filter((dialog) => dialog.id !== id);
            }
            return { dialogs };
        }),

    reported: (key, line) =>
        set((state) => {
            const of = idOf(key);
            const held = (state.statuses[of] ?? []).filter((status) => status.key !== line.key);
            const next = line.text === null ? held : [...held, line];
            return { statuses: { ...state.statuses, [of]: next } };
        }),
    edited: (key, text) => set((state) => ({ editors: { ...state.editors, [idOf(key)]: text } })),
}));

/** One value for every conversation with nothing to show, so a selector compares equal. */
const EMPTY: never[] = [];

/**
 * The dialogs that wait for one conversation, oldest first.
 *
 * A replayed ask whose id is already answered stays here for a moment, until the next
 * answer reports that the id is gone. Drawing it once more is what lets a dialog that
 * arrived during a reload reach a person, so this is the safe side to be wrong on.
 */
export function useDialogs(key: SessionKey): PendingDialog[] {
    return useExtensionStore((state) => state.dialogs[idOf(key)] ?? EMPTY);
}

/** The status lines of one conversation. */
export function useStatuses(key: SessionKey): StatusLine[] {
    return useExtensionStore((state) => state.statuses[idOf(key)] ?? EMPTY);
}

/**
 * Answers one dialog.
 *
 * The store forgets it first: an ask that no longer waits answers `false`, and the dialog
 * leaves the screen either way.
 */
export async function answerDialog(id: number, answer: bridge.ExtensionAnswer): Promise<void> {
    useExtensionStore.getState().closed(id);
    await bridge.answer(id, { status: "resolved", data: answer });
}

/** The text an extension put in the editor of one conversation, or `null` when it put none. */
export function useEditorText(key: SessionKey): string | null {
    return useExtensionStore((state) => state.editors[idOf(key)] ?? null);
}
