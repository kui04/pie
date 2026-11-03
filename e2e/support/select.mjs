// The one place that filters the case registry. A runner names its platform and
// its filters; a case never selects itself.

const PLATFORMS = new Set(["android", "linux"]);
const PRIORITIES = new Set(["P0", "P1", "P2"]);

function asList(value) {
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value : String(value).split(",");
}

function upper(value) {
    return String(value).trim().toUpperCase();
}

/** Throws when the registry cannot be run as a set. */
export function validateCases(list) {
    const seen = new Set();
    for (const item of list) {
        if (item === undefined) throw new Error("a case is missing from the registry");
        if (typeof item.id !== "string" || item.id === "") throw new Error("a case has no id");
        if (seen.has(item.id)) throw new Error(`duplicate case id ${item.id}`);
        seen.add(item.id);
        if (typeof item.name !== "string" || item.name === "") throw new Error(`${item.id} has no name`);
        if (!Array.isArray(item.platforms) || item.platforms.length === 0) {
            throw new Error(`${item.id} names no platform`);
        }
        for (const platform of item.platforms) {
            if (!PLATFORMS.has(platform)) throw new Error(`${item.id} names unknown platform ${platform}`);
        }
        if (!Array.isArray(item.behaviorIds) || item.behaviorIds.length === 0) {
            throw new Error(`${item.id} covers no behavior`);
        }
        if (!PRIORITIES.has(item.priority)) throw new Error(`${item.id} has priority ${item.priority}`);
        if (item.tags !== undefined && !Array.isArray(item.tags)) throw new Error(`${item.id} has non-array tags`);
        if (item.timeoutMs !== undefined && !(Number.isFinite(item.timeoutMs) && item.timeoutMs > 0)) {
            throw new Error(`${item.id} has timeout ${item.timeoutMs}`);
        }
        if (item.fixtures !== undefined && !Array.isArray(item.fixtures)) {
            throw new Error(`${item.id} has non-array fixtures`);
        }
        if (typeof item.run !== "function") throw new Error(`${item.id} has no run`);
    }
    return list;
}

/**
 * Selects the cases a runner can execute.
 *
 * @param {object[]} list the registry
 * @param {object} [options]
 * @param {"android" | "linux"} [options.platform]
 * @param {string | string[]} [options.cases] IDs or priorities, comma separated
 * @param {string | string[]} [options.tags] every named tag must match
 * @param {string | string[]} [options.priority]
 */
export function selectCases(list, { platform, cases, tags, priority } = {}) {
    validateCases(list);
    if (platform !== undefined && !PLATFORMS.has(platform)) throw new Error(`unknown platform ${platform}`);

    const wanted = asList(cases);
    const wantedTags = asList(tags);
    const wantedPriorities = asList(priority);
    const all = wanted === undefined || wanted.some((value) => upper(value) === "ALL");
    const keys = new Set((wanted ?? []).map(upper));
    const levels = new Set((wantedPriorities ?? []).map(upper));

    return list.filter((item) => {
        if (platform !== undefined && !item.platforms.includes(platform)) return false;
        if (!all && !keys.has(upper(item.id)) && !keys.has(item.priority)) return false;
        if (levels.size > 0 && !levels.has(item.priority)) return false;
        if (wantedTags !== undefined && !wantedTags.every((tag) => item.tags?.includes(tag))) return false;
        return true;
    });
}
