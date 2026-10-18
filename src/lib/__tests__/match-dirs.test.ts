import { describe, expect, it } from "vitest";
import type { DirEntry } from "@/lib/bridge";
import {
    climbFrom,
    displayParts,
    displayPath,
    drillPath,
    expandTilde,
    isAbsolutePath,
    MAX_CANDIDATES,
    matchDirs,
    parentOf,
    querySplit,
    splitParent,
    trimPath,
} from "@/lib/match-dirs";

const row = (name: string): DirEntry => ({ name, path: `/home/kui/${name}`, isDir: true });
const ROWS = [row("projects"), row("pictures"), row("pie"), row("notes.txt")].map((row, at) =>
    at === 3 ? { ...row, isDir: false } : row,
);

describe("splitParent", () => {
    it("splits text into the level to list and the stub to match", () => {
        expect(splitParent("/home/kui")).toEqual({ parent: "/home", stub: "kui" });
    });

    it("lists the folder itself when text ends in a separator", () => {
        expect(splitParent("/home/kui/")).toEqual({ parent: "/home/kui", stub: "" });
        expect(splitParent("/")).toEqual({ parent: "/", stub: "" });
    });

    it("lists home when there is no separator", () => {
        expect(splitParent("kui")).toEqual({ parent: null, stub: "kui" });
        expect(splitParent("")).toEqual({ parent: null, stub: "" });
    });

    it("collapses duplicate slashes and treats root slashes correctly", () => {
        expect(splitParent("//")).toEqual({ parent: "/", stub: "" });
        expect(splitParent("///")).toEqual({ parent: "/", stub: "" });
        expect(splitParent("//home")).toEqual({ parent: "/", stub: "home" });
        expect(splitParent("/home//kui")).toEqual({ parent: "/home", stub: "kui" });
    });
});

describe("parentOf", () => {
    it("names the level above", () => {
        expect(parentOf("/home/kui")).toBe("/home");
        expect(parentOf("/home/kui/")).toBe("/home");
        expect(parentOf("/a")).toBe("/");
        expect(parentOf("/")).toBe("/");
        expect(parentOf(null)).toBeNull();
        expect(parentOf("C:\\a\\b")).toBe("C:\\a");
        expect(parentOf("C:\\a")).toBe("C:\\");
    });
});

describe("isAbsolutePath", () => {
    it("reads POSIX, drive, and UNC paths as paths", () => {
        expect(isAbsolutePath("/srv")).toBe(true);
        expect(isAbsolutePath("C:\\work")).toBe(true);
        expect(isAbsolutePath("\\\\host\\share")).toBe(true);
    });

    it("reads a name, a tilde, and an empty text as no path", () => {
        expect(isAbsolutePath("~/work")).toBe(false);
        expect(isAbsolutePath("work")).toBe(false);
        expect(isAbsolutePath("")).toBe(false);
    });
});

describe("expandTilde", () => {
    it("puts the home of the host where a tilde stands", () => {
        expect(expandTilde("~", "/home/kui")).toBe("/home/kui");
        expect(expandTilde("~/work", "/home/kui")).toBe("/home/kui/work");
        expect(expandTilde("~\\work", "/home/kui")).toBe("/home/kui\\work");
    });

    it("leaves every other text as it is", () => {
        expect(expandTilde("work", "/home/kui")).toBe("work");
        expect(expandTilde("~work", "/home/kui")).toBe("~work");
        expect(expandTilde("~/work", null)).toBe("~/work");
        expect(expandTilde("~", "")).toBe("~");
    });
});

describe("trimPath", () => {
    it("takes the separators off the end", () => {
        expect(trimPath("/srv/www/")).toBe("/srv/www");
        expect(trimPath("/srv/www//")).toBe("/srv/www");
        expect(trimPath("/srv/www")).toBe("/srv/www");
    });

    it("keeps a root a root and an empty text empty", () => {
        expect(trimPath("/")).toBe("/");
        expect(trimPath("C:\\")).toBe("C:\\");
        expect(trimPath("")).toBe("");
    });
});

describe("drillPath", () => {
    it("puts a separator at the end", () => {
        expect(drillPath("~/projects")).toBe("~/projects/");
        expect(drillPath("/srv/")).toBe("/srv/");
    });
});

describe("querySplit", () => {
    it("splits a path into the level to list and the stub to match", () => {
        expect(querySplit("/srv/www", "/home/kui")).toEqual({ parent: "/srv", stub: "www" });
        expect(querySplit("/srv/", "/home/kui")).toEqual({ parent: "/srv", stub: "" });
    });

    it("lists home for a name and for a path that names the home", () => {
        expect(querySplit("pic", "/home/kui")).toEqual({ parent: null, stub: "pic" });
        expect(querySplit("", "/home/kui")).toEqual({ parent: null, stub: "" });
        expect(querySplit("/home/kui/", "/home/kui")).toEqual({ parent: null, stub: "" });
        expect(querySplit("~/pic", "/home/kui")).toEqual({ parent: null, stub: "pic" });
    });

    it("lists home when the text names the home directory", () => {
        expect(querySplit("/home/kui", "/home/kui")).toEqual({ parent: null, stub: "" });
        expect(querySplit("~", "/home/kui")).toEqual({ parent: null, stub: "" });
    });

    it("resolves relative subpaths against the home directory", () => {
        expect(querySplit("projects/pie", "/home/kui")).toEqual({ parent: "/home/kui/projects", stub: "pie" });
        expect(querySplit("projects/pie/", "/home/kui")).toEqual({ parent: "/home/kui/projects/pie", stub: "" });
    });
});

describe("climbFrom", () => {
    it("names the parent of the level in view", () => {
        expect(climbFrom("/srv/", "/home/kui")).toBe("/");
        expect(climbFrom("~/projects/", "/home/kui")).toBe("/home/kui");
        expect(climbFrom("~/projects", "/home/kui")).toBe("/home");
    });

    it("has no way up from a name, an empty field, or a root", () => {
        expect(climbFrom("", "/home/kui")).toBeNull();
        expect(climbFrom("pic", "/home/kui")).toBeNull();
        expect(climbFrom("/", "/home/kui")).toBeNull();
    });
});

describe("displayPath", () => {
    it("returns the normalized absolute path", () => {
        expect(displayPath("/home/kui")).toBe("/home/kui");
        expect(displayPath("/home/kui/projects")).toBe("/home/kui/projects");
    });

    it("leaves everything else as it is", () => {
        expect(displayPath("/srv/www")).toBe("/srv/www");
        expect(displayPath("/home/kui2")).toBe("/home/kui2");
    });
});

describe("displayParts", () => {
    it("splits the shown path where the name begins", () => {
        expect(displayParts("/home/kui/Projects/pie")).toEqual({ head: "/home/kui/Projects/", leaf: "pie" });
        expect(displayParts("/home/kui/projects")).toEqual({ head: "/home/kui/", leaf: "projects" });
        expect(displayParts("/")).toEqual({ head: "/", leaf: "" });
        expect(displayParts("//")).toEqual({ head: "/", leaf: "" });
    });
});

describe("matchDirs", () => {
    it("puts prefix matches before substring matches", () => {
        expect(matchDirs(ROWS, "pi").map((row) => row.name)).toEqual(["pictures", "pie"]);
        expect(matchDirs(ROWS, "roj").map((row) => row.name)).toEqual(["projects"]);
    });

    it("matches without regard to case", () => {
        expect(matchDirs(ROWS, "PI").map((row) => row.name)).toEqual(["pictures", "pie"]);
    });

    it("never matches files", () => {
        expect(matchDirs(ROWS, "notes")).toEqual([]);
    });

    it("fits every folder on an empty stub", () => {
        expect(matchDirs(ROWS, "").map((row) => row.name)).toEqual(["projects", "pictures", "pie"]);
    });

    it("caps the candidates", () => {
        const many = Array.from({ length: MAX_CANDIDATES + 10 }, (_, at) => row(`dir-${at}`));
        expect(matchDirs(many, "")).toHaveLength(MAX_CANDIDATES);
    });
});
