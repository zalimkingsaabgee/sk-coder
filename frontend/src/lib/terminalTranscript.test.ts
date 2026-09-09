import { describe, expect, it } from "vitest";
import { filterConsecutivePromptLines, isCleanLinuxPrompt } from "./terminalTranscript";

describe("terminal transcript prompt handling", () => {
    it("recognizes a clean Linux workspace prompt", () => {
        expect(isCleanLinuxPrompt("node@sk-coder:~$ ")).toBe(true);
        expect(isCleanLinuxPrompt("node@sk-coder:/workspace/project$ ")).toBe(true);
        expect(isCleanLinuxPrompt("$ ")).toBe(true);
        expect(isCleanLinuxPrompt("browser-terminal-lifecycle-ok")).toBe(false);
    });

    it("drops transport prompts while retaining command output", () => {
        expect(filterConsecutivePromptLines(["node@sk-coder:~$"], ["node@sk-coder:~$", "browser-terminal-lifecycle-ok", "node@sk-coder:~$"], "output")).toEqual(["browser-terminal-lifecycle-ok"]);
    });

    it("removes carriage-return prompt variants without changing command output", () => {
        expect(filterConsecutivePromptLines(["\rnode@sk-coder:~$"], ["node@sk-coder:~$ ", "browser-ack-once-ok", "\rnode@sk-coder:~$"], "output")).toEqual(["browser-ack-once-ok"]);
    });
});
