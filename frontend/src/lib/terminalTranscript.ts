export function isCleanLinuxPrompt(line: string) {
    const normalized = line.trim();
    return /^node@sk-coder:(?:~|\/workspace(?:\/[^\s$#]+)*)[$#]\s?$/.test(normalized) || /^[$#]\s?$/.test(normalized) || /^bash-\d+\.\d+[$#]\s?$/.test(normalized);
}

export function filterConsecutivePromptLines(existing: string[], incoming: string[], lineType: string) {
    let previous = existing.at(-1) ?? "";
    const accepted: string[] = [];
    for (const line of incoming) {
        const prompt = isCleanLinuxPrompt(line);
        if (lineType === "output" && prompt)
            continue;
        const normalized = prompt ? line.trim() : line;
        const duplicatePrompt = lineType === "output" && prompt && isCleanLinuxPrompt(previous) && previous.trim() === normalized;
        if (!duplicatePrompt)
            accepted.push(normalized);
        previous = normalized;
    }
    return accepted;
}
