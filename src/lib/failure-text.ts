/**
 * The sentence a failure gets on screen.
 *
 * Every screen keeps its own table of them. The failures a connect can produce
 * are not the failures a read can: a table that named all of them everywhere
 * would tell a reader about states they cannot meet on the screen they are
 * looking at. What is shared is the lookup and the fallback, so that a failure
 * of a module that no table names still says something true about where it came
 * from.
 *
 * A test in Rust reads these tables beside the variants of the error enums
 * (`tests/failure_kinds.rs`), so a variant that no screen gives words to fails
 * the build instead of reaching a person as a blank.
 */

import * as bridge from "@/lib/bridge";

/**
 * One table per screen, naming the failures that screen can meet. Partial: a
 * screen names the failures it can show, and `failure_kinds.rs` is what holds the
 * screens together against the Rust enums.
 */
export type FailureText = Partial<Record<bridge.PieErrorKind, string>>;

/** What a failure of a module says, when no table names the failure itself. */
export const MODULE_REASON: Record<bridge.PieErrorModule, string> = {
    channel: "Something went wrong in the program pie started.",
    host: "Something went wrong reaching the machine that runs pi.",
    session: "Something went wrong in the session.",
    commands: "Something on pie's own side went wrong.",
    rpc: "Something went wrong talking to pi.",
    io: "That file could not be read. Another one may work.",
};

export function reasonFor(failure: bridge.PieError, table: FailureText): string {
    const named = failure.error ? table[failure.error.kind] : undefined;
    return named ?? MODULE_REASON[failure.type];
}
