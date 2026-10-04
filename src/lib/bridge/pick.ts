import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import type { PieError } from "./error";

/**
 * Asks the person for a private key and brings back what is inside it.
 *
 * Both halves are the plugins' own JavaScript rather than a command of pie's,
 * because there is nothing pie decides here: the picker is a system dialog and
 * the file is a file.
 *
 * The text rather than the location, because the two platforms answer the picker
 * differently — a path on desktop, a `content://` URI on Android — and only one
 * of those names something `readTextFile` is guaranteed to open. What comes back
 * is what a pasted key is too, so the card treats both alike.
 *
 * `null` means the picker was closed, which is not a failure. A file that cannot
 * be read throws a [`PieError`](./error) of its own kind, so the toast says which
 * file failed rather than blaming pie.
 */
export async function pickPrivateKey(): Promise<string | null> {
    const chosen = await open({ multiple: false, title: "Private key" });
    if (typeof chosen !== "string") return null;
    try {
        return await readTextFile(chosen);
    } catch (thrown) {
        // The file the person chose could not be read — permissions, a
        // directory, a URI the platform will not hand over. Left alone this
        // reaches `asPieError` as an unfamiliar shape and is filed under
        // `internal`, which tells them pie broke when the file is theirs and
        // another one may well read.
        const failure: PieError = {
            type: "file",
            message: `could not read the key file that was chosen: ${
                thrown instanceof Error ? thrown.message : String(thrown)
            }`,
        };
        throw failure;
    }
}
