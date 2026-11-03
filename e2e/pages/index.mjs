// Builds the page objects over one platform surface.

import { createComposer } from "./composer.mjs";
import { createGate } from "./gate.mjs";
import { createSession } from "./session.mjs";
import { createSidebar } from "./sidebar.mjs";

export function createPages(surface, context = {}) {
    return {
        gate: createGate(surface, context),
        sidebar: createSidebar(surface),
        session: createSession(surface),
        composer: createComposer(surface),
    };
}
