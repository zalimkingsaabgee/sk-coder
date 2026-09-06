import { describe, expect, it } from "vitest";
import { extractAgentProposal } from "./aiAgent";

describe("AI project proposals", () => {
    it("accepts a bounded project scaffold for explicit review", () => {
        const proposal = extractAgentProposal('Plan first.<sk-actions>[{"type":"project","files":[{"path":"/package.json","content":"{}"},{"path":"/src/main.ts","content":"console.log(1)"}]}]</sk-actions>');
        expect(proposal.actions).toHaveLength(1);
        expect(proposal.actions[0]).toMatchObject({ type: "project", files: [{ path: "/package.json" }, { path: "/src/main.ts" }] });
    });

    it("rejects an oversized project scaffold", () => {
        const files = Array.from({ length: 121 }, (_, index) => ({ path: `/src/${index}.ts`, content: "" }));
        const proposal = extractAgentProposal(`<sk-actions>${JSON.stringify([{ type: "project", files }])}</sk-actions>`);
        expect(proposal.actions).toHaveLength(0);
    });
});
