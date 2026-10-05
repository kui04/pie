import { call } from "./invoke";

/**
 * Asks the person for a private key.
 *
 * This function calls a command of pie. The frontend must not call a plugin.
 * Only Rust can name the failure. The failure is the selected file, not pie.
 *
 * The function returns the text of the key. It does not return the location of
 * the key file. Android answers the picker with a `content://` URI. A plain read
 * cannot open that URI.
 *
 * `null` means that the person closed the picker. A closed picker is not a
 * failure.
 */
export async function pickPrivateKey(): Promise<string | null> {
    return call<string | null>("pick_private_key");
}
