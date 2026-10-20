import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
    branchGlyph,
    compactionGlyph,
    customGlyph,
    glyphFor,
    skillGlyph,
    thoughtGlyph,
    toolLabel,
} from "@/routes/chat/transcript/entries/ToolGlyph";

function iconOf(node: ReactNode): string | null {
    if (!isValidElement(node)) return null;
    const type = node.type as { displayName?: unknown };
    return typeof type.displayName === "string" ? type.displayName : null;
}

describe("what glyph a call gets", () => {
    it("draws each of pi's own tools with its own glyph", () => {
        expect(iconOf(glyphFor("read"))).toBe("FileText");
        expect(iconOf(glyphFor("write"))).toBe("FilePen");
        expect(iconOf(glyphFor("edit"))).toBe("Pencil");
        expect(iconOf(glyphFor("bash"))).toBe("Terminal");
        expect(iconOf(glyphFor("powershell"))).toBe("Terminal");
        expect(iconOf(glyphFor("ls"))).toBe("FolderTree");
        expect(iconOf(glyphFor("grep"))).toBe("Search");
        expect(iconOf(glyphFor("find"))).toBe("FileSearch");
        expect(iconOf(glyphFor("codemode"))).toBe("Braces");
        expect(iconOf(glyphFor("tool_search"))).toBe("Plug");
    });

    it("reads names whatever their case", () => {
        expect(iconOf(glyphFor("Bash"))).toBe("Terminal");
    });

    it("plugs a namespaced tool, whatever server owns it", () => {
        expect(iconOf(glyphFor("mcp__github__search_code"))).toBe("Plug");
        expect(iconOf(glyphFor("jira__create_issue"))).toBe("Plug");
    });

    it("wrenches a tool it does not know instead of guessing one", () => {
        for (const tool of ["ollama_web_search", "todowrite", "glob", "skill", "subagent", "fetch"]) {
            expect(iconOf(glyphFor(tool))).toBe("Wrench");
        }
    });

    it("keeps a thought's glyph apart from the tools", () => {
        expect(iconOf(thoughtGlyph())).toBe("Brain");
    });

    it("keeps every notice kind on its own glyph", () => {
        expect(iconOf(compactionGlyph())).toBe("Archive");
        expect(iconOf(branchGlyph())).toBe("GitBranch");
        expect(iconOf(skillGlyph())).toBe("Sparkles");
        expect(iconOf(customGlyph())).toBe("Puzzle");
    });
});

describe("what word introduces a row's kind", () => {
    it("spells pi's own tools as words", () => {
        expect(toolLabel("bash")).toBe("Bash");
        expect(toolLabel("powershell")).toBe("PowerShell");
        expect(toolLabel("codemode")).toBe("Codemode");
        expect(toolLabel("tool_search")).toBe("Tool Search");
    });

    it("names a namespaced tool by its server and its tool", () => {
        expect(toolLabel("mcp__github__search_code")).toBe("Github / Search Code");
    });

    it("humanizes a tool it does not know instead of showing its identifier", () => {
        expect(toolLabel("ollama_web_search")).toBe("Ollama Web Search");
        expect(toolLabel("todowrite")).toBe("Todowrite");
    });
});
