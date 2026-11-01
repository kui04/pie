/**
 * The two event channels of every conversation, opened once and fanned out.
 *
 * Rust sends every conversation's records and ends down one channel each, with the
 * connection and the file in the payload. A listener per conversation would each
 * receive every event and throw most away, so this module holds one listener per
 * channel and hands each event to the conversations that named it.
 *
 * Both channels open together or not at all: half a pair is worth less than none,
 * because the records the missing one carried are gone either way.
 */

import * as bridge from "@/lib/bridge";
import { idOf, isOf, type SessionKey } from "./key";

type RecordListener = (event: bridge.SessionEvent) => void;
type EndedListener = (event: bridge.SessionEnded) => void;

const records = new Set<RecordListener>();
const ends = new Set<EndedListener>();

/** How many conversations hold the channels open. */
let holders = 0;
/** The open pair, or the pair that is opening. */
let channels: Promise<bridge.Unsubscribe> | null = null;

/** Opens both channels, or answers the pair that is already opening. */
function open(): Promise<bridge.Unsubscribe> {
    if (channels !== null) return channels;

    channels = (async () => {
        const events = await bridge.onSessionEvent((event) => {
            for (const hear of records) hear(event);
        });
        try {
            const ended = await bridge.onSessionEnded((event) => {
                for (const hear of ends) hear(event);
            });
            return () => {
                events();
                ended();
            };
        } catch (thrown) {
            events();
            channels = null;
            throw thrown;
        }
    })();

    return channels;
}

/** Releases the pair, and lets the next subscriber open it again. */
function close(): void {
    const pair = channels;
    channels = null;
    if (pair === null) return;
    void pair.then(
        (off) => off(),
        () => undefined,
    );
}

/**
 * Hears the records and the end of one conversation.
 *
 * The count rises before the channels are awaited, so a subscriber that leaves while
 * another is opening cannot close the pair under it.
 */
export async function subscribe(
    key: SessionKey,
    onRecord: RecordListener,
    onEnded: EndedListener,
): Promise<bridge.Unsubscribe> {
    holders += 1;

    try {
        await open();
    } catch (thrown) {
        holders -= 1;
        if (holders === 0) close();
        throw thrown;
    }

    const record: RecordListener = (event) => {
        if (isOf(key, event)) onRecord(event);
    };
    const ended: EndedListener = (event) => {
        if (isOf(key, event)) onEnded(event);
    };

    records.add(record);
    ends.add(ended);
    bridge.log.debug("a conversation is heard", { conversation: idOf(key) });

    let live = true;
    return () => {
        if (!live) return;
        live = false;
        records.delete(record);
        ends.delete(ended);
        holders -= 1;
        if (holders === 0) close();
    };
}

/**
 * Drops the channels and every listener.
 *
 * A window of the app hears its conversations for as long as it runs, so nothing in the app
 * calls this. A test window is not the app's window: the next test would otherwise inherit a
 * pair wired to the mocks of the one before it.
 */
export function resetSessionStream(): void {
    records.clear();
    ends.clear();
    holders = 0;
    close();
}
