import { call } from "./invoke";

/** The two words `platform` answers. */
export type Platform = "mobile" | "desktop";

/**
 * Which kind of machine this is.
 *
 * Asked of Rust rather than measured in CSS: a phone-shaped desktop window is
 * still a desktop and a tablet in landscape is still a phone, and both of those
 * questions have to be answered the same way.
 */
export function platform(): Promise<Platform> {
    return call<Platform>("platform");
}
