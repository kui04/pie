/**
 * What a person selects with a system dialog: a private key, and pictures for a
 * message.
 *
 * The mirror of `src-tauri/src/commands/pick.rs`. Both functions call a command
 * of pie: the frontend must not call a plugin itself, and only Rust can name the
 * failure of a file the person selected — that failure is the file, not pie.
 *
 * Neither function returns a path. Android answers the picker with a
 * `content://` URI, and a plain read cannot open one, so the file crosses as
 * text: the key as the key file holds it, a picture as base64 with a MIME type.
 */

import type { ImageContent } from "@/lib/rpc-protocol";
import { call } from "./invoke";

/**
 * Asks the person for a private key.
 *
 * The function returns the text of the key. It does not return the location of
 * the key file.
 *
 * `null` means that the person closed the picker. A closed picker is not a
 * failure.
 */
export async function pickPrivateKey(): Promise<string | null> {
    return call<string | null>("pick_private_key");
}

/**
 * One image that a person picked, with the name of the file it came from.
 *
 * The name is for the chip that the composer shows. Pi never sees it: the
 * `images` of a prompt carry no name. A picker on Android answers with a
 * `content://` URI, which may have no name of its own; such a picture is called
 * `Image`.
 */
export interface PickedImage {
    /** The name of the file, or `Image` when the picker gave none. */
    name: string;
    /** The picture, as the `images` of a prompt take it. */
    image: ImageContent;
}

/**
 * Asks the person for images to attach to a message.
 *
 * The answer is what a prompt takes as its `images`: base64 with a MIME type,
 * each with the name of the file for the chip. `null` means that the person
 * closed the picker, which is not a failure. A file that cannot be read fails as
 * [`PieError`](./error), and the toast then blames the selected file, not pie.
 */
export async function pickImages(): Promise<PickedImage[] | null> {
    return call<PickedImage[] | null>("pick_images");
}
