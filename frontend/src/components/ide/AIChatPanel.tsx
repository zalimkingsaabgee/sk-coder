import { useRef, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useIDEStore } from "@/store/ideStore";
import { sendAIMessage, buildSystemPrompt } from "@/lib/aiClient";
import { actionLabel, buildAgentInstruction, extractAgentProposal, type AgentAction } from "@/lib/aiAgent";
import { execute } from "@/lib/executorChain";
import type { AIChatMessage } from "@/types/ide";
import { toast } from "sonner";
import { isSensitiveProjectPath as isSensitiveMapPath } from "@/lib/projectMap";
import { connectPuterSession, sendPuterChat } from "@/lib/puterClient";
import { normalizeAIWorkspaceCommand } from "@/lib/aiWorkspaceCommand";
import { retryHistoryForAssistant } from "@/lib/aiChatRetry";
function getAllPaths(nodes: ReturnType<typeof useIDEStore.getState>["fileTree"]): string[] {
    const paths: string[] = [];
    function walk(ns: typeof nodes) {
        for (const n of ns) {
            paths.push(n.path);
            if (n.children)
                walk(n.children);
        }
    }
    walk(nodes);
    return paths;
}
function isSensitiveWorkspacePath(path: string) {
    return isSensitiveMapPath(path);
}
function AssistantMark({ size = 14 }: { size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="5"/><path d="M9 10h.01M15 10h.01M9.5 15h5"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3"/></svg>;
}
function buildConversationWindow(messages: AIChatMessage[]) {
    const kept: AIChatMessage[] = [];
    let characters = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        const nextCharacters = characters + message.content.length;
        if (kept.length > 0 && nextCharacters > 120000)
            break;
        kept.unshift(message);
        characters = nextCharacters;
    }
    return kept;
}
function AssistantChart({ source }: { source: string }) {
    try {
        const parsed = JSON.parse(source) as { title?: unknown; data?: unknown };
        if (!Array.isArray(parsed.data)) throw new Error("invalid");
        const points = parsed.data.slice(0, 16).map((point) => point as { label?: unknown; value?: unknown }).filter((point): point is { label: string; value: number } => typeof point.label === "string" && typeof point.value === "number" && Number.isFinite(point.value));
        if (!points.length) throw new Error("empty");
        const maximum = Math.max(1, ...points.map((point) => Math.abs(point.value)));
        return <div className="ai-code-block" style={{ display: "grid", gap: 8 }}><strong style={{ fontSize: 12 }}>{typeof parsed.title === "string" ? parsed.title.slice(0, 120) : "Chart"}</strong><div style={{ height: 150, display: "flex", alignItems: "end", gap: 6 }}>{points.map((point) => <div key={point.label} style={{ minWidth: 0, flex: 1, display: "grid", gap: 4, justifyItems: "center" }}><span title={`${point.label}: ${point.value}`} style={{ width: "100%", minHeight: 4, height: `${Math.max(4, Math.abs(point.value) / maximum * 112)}px`, borderRadius: "4px 4px 1px 1px", background: "linear-gradient(180deg, #a78bfa, #3b82f6)" }} /><small style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 9 }}>{point.label}</small></div>)}</div></div>;
    }
    catch {
        return <pre className="ai-code-block"><code>{source}</code></pre>;
    }
}
export default function AIChatPanel() {
    const { aiChatMessages, aiChatDraft, aiAttachmentPaths, aiTyping, settings, addAIChatMessage, setAIChatDraft, setAIAttachmentPaths, clearAIChat, setAITyping, setShowSettings, setSettingsTab, updateAISettings, fileTree, flatFiles, addFile, updateFileContent, deleteNode, renameNode, moveNode, setTerminalBridgeCmd, setActivePanel, setPreviewPath, openTab, setPreviewResult, setIsRunning, } = useIDEStore();
    const input = aiChatDraft;
    const setInput = setAIChatDraft;
    const [proposals, setProposals] = useState<AgentAction[]>([]);
    const [sessionApprovedCommands, setSessionApprovedCommands] = useState<Set<string>>(new Set());
    const [puterConnecting, setPuterConnecting] = useState(false);
    const [showAttachmentPicker, setShowAttachmentPicker] = useState(false);
    const [attachmentFolderPath, setAttachmentFolderPath] = useState("/");
    const [activeMessageActions, setActiveMessageActions] = useState<string | null>(null);
    const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
    const [showLatestButton, setShowLatestButton] = useState(false);
    const messagesRef = useRef<HTMLDivElement>(null);
    const stickToLatestRef = useRef(true);
    const latestMessageRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const { apiKey, keyStatus, usePuter } = settings.ai;
    const noKey = !apiKey && !usePuter;
    const attachmentTargets = useMemo(() => aiAttachmentPaths
        .map((path) => flatFiles.get(path))
        .filter((node): node is NonNullable<typeof node> => Boolean(node && !isSensitiveWorkspacePath(node.path))), [aiAttachmentPaths, flatFiles]);
    const attachedContextFiles = useMemo(() => {
        const included = new Set<string>();
        for (const target of attachmentTargets) {
            if (target.type === "file") {
                included.add(target.path);
                continue;
            }
            for (const node of flatFiles.values()) {
                if (node.type === "file" && node.path.startsWith(`${target.path}/`) && !isSensitiveWorkspacePath(node.path))
                    included.add(node.path);
            }
        }
        return Array.from(included)
            .map((path) => flatFiles.get(path))
            .filter((file): file is NonNullable<typeof file> => Boolean(file && file.type === "file" && !isSensitiveWorkspacePath(file.path)))
            .sort((a, b) => a.path.localeCompare(b.path))
            .map((file) => ({ path: file.path, content: file.content || "" }));
    }, [attachmentTargets, flatFiles]);
    const attachmentPickerItems = useMemo(() => {
        if (attachmentFolderPath === "/") return fileTree.filter((node) => !isSensitiveWorkspacePath(node.path));
        const folder = flatFiles.get(attachmentFolderPath);
        return (folder?.children || []).filter((node) => !isSensitiveWorkspacePath(node.path));
    }, [attachmentFolderPath, fileTree, flatFiles]);
    useEffect(() => {
        const messages = messagesRef.current;
        if (!messages)
            return;
        if (stickToLatestRef.current)
            latestMessageRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    }, [aiChatMessages, aiTyping]);
    function handleMessageScroll() {
        const messages = messagesRef.current;
        if (!messages)
            return;
        const atLatest = messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 80;
        stickToLatestRef.current = atLatest;
        setShowLatestButton(!atLatest && aiChatMessages.length > 0);
    }
    function scrollToLatest() {
        stickToLatestRef.current = true;
        setShowLatestButton(false);
        latestMessageRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    }
    function deliverAIReply(reply: string) {
        const { explanation, actions } = extractAgentProposal(reply);
        addAIChatMessage({ role: "assistant", content: explanation || (actions.length ? "I prepared actions for your review." : reply) });
        if (actions.length) {
            const pending: AgentAction[] = [];
            for (const action of actions) {
                const command = action.type === "run" ? normalizeAIWorkspaceCommand(action.command) : null;
                if (command && sessionApprovedCommands.has(command))
                    void approveProposal(action);
                else
                    pending.push(action);
            }
            if (pending.length)
                setProposals((previous) => [...previous, ...pending]);
        }
    }
    async function connectFreePuter() {
        setPuterConnecting(true);
        try {
            await connectPuterSession();
            updateAISettings({ usePuter: true });
            toast.success("Free Puter AI is connected in this browser");
        }
        catch (error) {
            toast.error(error instanceof Error ? error.message : "Puter sign-in was cancelled or failed.");
        }
        finally {
            setPuterConnecting(false);
        }
    }
    function attachWorkspaceTarget(path: string) {
        const node = flatFiles.get(path);
        if (!node || isSensitiveWorkspacePath(path)) {
            toast.error("That workspace item is no longer available for attachment.");
            return;
        }
        if (!aiAttachmentPaths.includes(path)) setAIAttachmentPaths([...aiAttachmentPaths, path]);
        toast.success(`${node.type === "folder" ? "Folder" : "File"} attached to this chat.`);
    }
    function removeAttachment(path: string) {
        setAIAttachmentPaths(aiAttachmentPaths.filter((item) => item !== path));
    }
    function openAttachmentFolder(path: string) {
        setAttachmentFolderPath(path);
    }
    function openAttachmentPicker() {
        setAttachmentFolderPath("/");
        setShowAttachmentPicker((open) => !open);
    }
    function removeProposal(id: string) {
        setProposals((previous) => previous.filter((proposal) => proposal.id !== id));
    }
    function applyProposedFile(path: string, content: string) {
        const exists = getAllPaths(fileTree).includes(path);
        if (exists) {
            updateFileContent(path, content);
            const existingFile = useIDEStore.getState().flatFiles.get(path);
            if (existingFile) openTab(existingFile);
            return;
        }
        const separator = path.lastIndexOf("/");
        addFile(separator <= 0 ? "/" : path.slice(0, separator), path.slice(separator + 1), "file", content);
    }
    async function approveCommandForChat(action: Extract<AgentAction, { type: "run" }>) {
        const command = normalizeAIWorkspaceCommand(action.command);
        if (!command) {
            toast.error("This terminal command is outside the approved workspace safety policy.");
            removeProposal(action.id);
            return;
        }
        setSessionApprovedCommands((previous) => new Set([...previous, command]));
        await approveProposal(action);
    }
    function clearConversation() {
        setProposals([]);
        setSessionApprovedCommands(new Set());
        clearAIChat();
    }
    async function copyChatMessage(content: string) {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(content);
            }
            else {
                const area = document.createElement("textarea");
                area.value = content;
                area.style.position = "fixed";
                area.style.opacity = "0";
                document.body.appendChild(area);
                area.select();
                document.execCommand("copy");
                document.body.removeChild(area);
            }
            toast.success("Message copied");
        }
        catch {
            toast.error("Unable to copy this response in the current browser.");
        }
    }
    function editUserMessage(content: string) {
        setInput(content);
        window.setTimeout(() => textareaRef.current?.focus(), 0);
    }
    function toggleReadMessageAloud(messageId: string, content: string) {
        if (!window.speechSynthesis) {
            toast.error("Read aloud is not available in this browser.");
            return;
        }
        if (speakingMessageId === messageId && window.speechSynthesis.speaking) {
            window.speechSynthesis.cancel();
            setSpeakingMessageId(null);
            return;
        }
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(content);
        utterance.onend = () => setSpeakingMessageId(null);
        utterance.onerror = () => {
            setSpeakingMessageId(null);
            toast.error("This browser could not read the response aloud.");
        };
        setSpeakingMessageId(messageId);
        window.speechSynthesis.speak(utterance);
    }
    async function approveProposal(action: AgentAction) {
        let resultMessage = `Applied: ${actionLabel(action)}`;
        if (action.type === "read") {
            const file = useIDEStore.getState().flatFiles.get(action.path);
            if (!file || file.type !== "file")
                throw new Error("The requested workspace file is no longer available.");
            openTab(file);
            setActivePanel("editor");
        }
        else if (action.type === "write") {
            applyProposedFile(action.path, action.content);
            setActivePanel("editor");
            resultMessage = `Applied: ${actionLabel(action)}\n\nThe file is open in the editor for review.`;
        }
        else if (action.type === "project") {
            for (const file of action.files) applyProposedFile(file.path, file.content);
            setActivePanel("files");
            resultMessage = `Applied: ${actionLabel(action)}\n\nCreated:\n${action.files.map((file) => file.path).join("\n")}`;
        }
        else if (action.type === "create_folder") {
            const separator = action.path.lastIndexOf("/");
            addFile(separator <= 0 ? "/" : action.path.slice(0, separator), action.path.slice(separator + 1), "folder");
            setActivePanel("files");
        }
        else if (action.type === "rename") {
            renameNode(action.path, action.name);
            setActivePanel("files");
        }
        else if (action.type === "move") {
            moveNode(action.path, action.folderPath);
            setActivePanel("files");
        }
        else if (action.type === "delete") {
            deleteNode(action.path);
            setActivePanel("files");
        }
        else if (action.type === "run") {
            const command = normalizeAIWorkspaceCommand(action.command);
            if (!command) {
                toast.error("This terminal command is outside the approved workspace safety policy.");
                removeProposal(action.id);
                return;
            }
            const directRun = command.match(/^(?:run|node|python(?:3)?|java)\s+([^\s]+)$/i);
            const sourcePath = directRun?.[1];
            const sourceFile = sourcePath
                ? useIDEStore.getState().flatFiles.get(sourcePath) ?? Array.from(useIDEStore.getState().flatFiles.values()).find((file) => file.type === "file" && file.name === sourcePath)
                : undefined;
            if (sourceFile?.type === "file") {
                const extension = sourceFile.name.split(".").pop()?.toLowerCase() || sourceFile.language || "";
                setActivePanel("preview");
                setPreviewPath(sourceFile.path);
                setPreviewResult(null);
                setIsRunning(true);
                try {
                    const result = await execute(extension, sourceFile.content || "");
                    setPreviewResult({
                        stdout: result.stdout,
                        stderr: result.stderr,
                        exitCode: result.exitCode,
                        tier: result.tier,
                        capability: result.capability,
                        executionTime: result.executionTime,
                    });
                    const output = [result.stdout && `stdout:\n${result.stdout}`, result.stderr && `stderr:\n${result.stderr}`].filter(Boolean).join("\n\n") || "No output.";
                    resultMessage = `Run completed for ${sourceFile.path}\nExit code: ${result.exitCode}\n\n${output}`;
                }
                finally {
                    setIsRunning(false);
                }
            }
            else {
                setActivePanel("terminal");
                setTerminalBridgeCmd({ cmd: command, targetType: "shell" });
                resultMessage = `Opened SK Shell for:\n${command}\n\nReview the terminal output, then ask me to continue with the result.`;
            }
        }
        else if (action.type === "preview") {
            if (action.path) {
                const previewFile = useIDEStore.getState().flatFiles.get(action.path);
                if (previewFile?.type === "file")
                    setPreviewPath(previewFile.path);
            }
            setActivePanel("preview");
        }
        addAIChatMessage({ role: "assistant", content: resultMessage });
        removeProposal(action.id);
    }
    async function requestAssistantReply(messages: AIChatMessage[]) {
        if (noKey) {
            setSettingsTab("ai");
            setShowSettings(true);
            return;
        }
        setAITyping(true);
        try {
            const systemPrompt = `${buildSystemPrompt({
                    fileTree: attachedContextFiles.map((file) => file.path),
                    workspaceFiles: attachedContextFiles,
                })}\n\n${buildAgentInstruction()}`;
            const conversation = buildConversationWindow(messages);
            if (usePuter) {
                const reply = await sendPuterChat(conversation, systemPrompt);
                deliverAIReply(reply);
                return;
            }
            const res = await sendAIMessage({
                    key: apiKey,
                    provider: settings.ai.provider,
                    customEndpoint: settings.ai.apiEndpoint,
                    customModel: settings.ai.model,
                    messages: conversation,
                    systemPrompt,
                });
            if (res.error === "invalid_key") {
                    addAIChatMessage({ role: "assistant", content: "Your API key appears invalid. Go to **Settings → AI Assistant** and update your key." });
                }
                else if (res.error === "provider_not_configured") {
                    addAIChatMessage({ role: "assistant", content: "This AI provider is not configured in SK Coder yet. Add an OpenAI-compatible endpoint and model in **Settings → AI Assistant**, or use a supported provider." });
                }
                else if (res.error === "configuration_error") {
                    addAIChatMessage({ role: "assistant", content: "The AI service responded, but the selected model or endpoint is not available. Review the provider endpoint and model in **Settings → AI Assistant**." });
                }
                else if (res.error === "credits_exhausted") {
                    addAIChatMessage({ role: "assistant", content: "This provider has no remaining credits or has reached its spending limit. Check the provider billing settings, choose another model or provider, or connect free Puter AI in Settings → AI Assistant." });
                }
                else if (res.error === "rate_limited") {
                    addAIChatMessage({ role: "assistant", content: "This provider is temporarily rate-limiting requests. Wait a moment and try again, or choose another provider in Settings → AI Assistant." });
                }
                else if (res.error === "expired") {
                    addAIChatMessage({ role: "assistant", content: "Your API usage limit has been reached. Please check your account." });
                }
                else if (res.error === "network_error") {
                    addAIChatMessage({ role: "assistant", content: "Could not connect to the AI service. Check your internet connection." });
                }
                else if (res.error) {
                    addAIChatMessage({ role: "assistant", content: `Something went wrong: ${res.error}` });
                }
            else {
                deliverAIReply(res.content);
            }
        }
        catch (e) {
            addAIChatMessage({ role: "assistant", content: `Error: ${String(e)}` });
        }
        finally {
            setAITyping(false);
        }
    }
    async function handleSend() {
        const trimmed = input.trim();
        if (!trimmed || aiTyping)
            return;
        const outgoing: AIChatMessage = { id: `pending-${Date.now()}`, role: "user", content: trimmed, timestamp: Date.now() };
        setInput("");
        if (textareaRef.current)
            textareaRef.current.style.height = "auto";
        addAIChatMessage(outgoing);
        await requestAssistantReply([...aiChatMessages, outgoing]);
    }
    async function retryAssistantResponse(assistantId: string) {
        if (aiTyping)
            return;
        const history = retryHistoryForAssistant(aiChatMessages, assistantId);
        if (!history) {
            toast.error("There is no earlier user request to retry.");
            return;
        }
        await requestAssistantReply(history);
    }
    function handleKeyDown(e: React.KeyboardEvent) {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    }
    function handleTextareaChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
        setInput(e.target.value);
        const ta = e.target;
        ta.style.height = "auto";
        ta.style.height = Math.min(ta.scrollHeight, Math.max(320, window.innerHeight * 0.48)) + "px";
    }
    return (<div className="ai-chat-panel">
      <div className="ai-chat-header">
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <div style={{ width: 22, height: 22, borderRadius: 7, display: "grid", placeItems: "center", background: "linear-gradient(135deg, rgba(167,139,250,0.3), rgba(0,122,204,0.28))", color: "#d7c7ff", flexShrink: 0 }}><AssistantMark size={13}/></div>
          <span style={{ fontWeight: 700, fontSize: 13 }}>SK Coder AI Assistant</span>
          {usePuter && (<span className="badge badge-green" style={{ fontSize: 9 }}>Free via Puter</span>)}
          {keyStatus === "valid" && (<span className="badge badge-green" style={{ fontSize: 9 }}>Active</span>)}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button className="btn-icon" onClick={() => { setSettingsTab("ai"); setShowSettings(true); }} title="AI Assistant Settings">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
          <button className="btn-icon" onClick={clearConversation} title="Clear chat" disabled={aiChatMessages.length === 0}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6M14 11v6"/>
            </svg>
          </button>
        </div>
      </div>

      {proposals.length > 0 && (<div style={{ margin: "0.75rem", display: "grid", gap: 8 }}>
          {proposals.map((proposal) => (<div key={proposal.id} style={{ padding: "0.75rem", borderRadius: 10, background: "rgba(167,139,250,0.1)", border: "1px solid rgba(167,139,250,0.28)", display: "grid", gap: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700 }}>{actionLabel(proposal)}</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Review this scoped workspace action before allowing it. It cannot access host files, private keys, or another workspace.</div>
              {proposal.type === "read" && <div style={{ color: "var(--text-muted)", fontSize: 10 }}>Workspace file: {proposal.path}</div>}
              {proposal.type === "write" && (<div style={{ display: "grid", gap: 5 }}>
                  <div style={{ color: "var(--text-muted)", fontSize: 10 }}>File: {proposal.path}</div>
                  <pre style={{ margin: 0, maxHeight: 150, overflow: "auto", padding: "0.55rem", borderRadius: 6, background: "rgba(0,0,0,0.24)", color: "#e2c08d", fontSize: 10, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{proposal.content.slice(0, 2400)}{proposal.content.length > 2400 ? "\n… preview shortened" : ""}</pre>
                </div>)}
              {proposal.type === "create_folder" && <div style={{ color: "var(--text-muted)", fontSize: 10 }}>Folder: {proposal.path}</div>}
              {proposal.type === "rename" && <div style={{ color: "var(--text-muted)", fontSize: 10 }}>New name: {proposal.name}</div>}
              {proposal.type === "move" && <div style={{ color: "var(--text-muted)", fontSize: 10 }}>Destination folder: {proposal.folderPath}</div>}
              {proposal.type === "delete" && <div style={{ color: "#f97583", fontSize: 10 }}>Delete target: {proposal.path}</div>}
              {proposal.type === "run" && <pre style={{ margin: 0, padding: "0.55rem", borderRadius: 6, background: "rgba(0,0,0,0.24)", color: "#e2c08d", fontSize: 10, whiteSpace: "pre-wrap" }}>{proposal.command}</pre>}
              {proposal.type === "preview" && <div style={{ color: "var(--text-muted)", fontSize: 10 }}>Preview target: {proposal.path || "active workspace preview"}</div>}
              {proposal.type === "project" && <div style={{ display: "grid", gap: 4 }}><div style={{ color: "var(--text-muted)", fontSize: 10 }}>Project files: {proposal.files.length}</div><pre style={{ margin: 0, maxHeight: 150, overflow: "auto", padding: "0.55rem", borderRadius: 6, background: "rgba(0,0,0,0.24)", color: "#e2c08d", fontSize: 10 }}>{proposal.files.map((file) => file.path).join("\n")}</pre></div>}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn btn-primary" style={{ fontSize: 11, padding: "0.42rem 0.7rem" }} onClick={() => void approveProposal(proposal)}>Allow once</button>
                {proposal.type === "run" && <button className="btn btn-ghost" style={{ fontSize: 11, padding: "0.42rem 0.7rem" }} onClick={() => void approveCommandForChat(proposal)}>Allow this command for this chat</button>}
                <button className="btn btn-ghost" style={{ fontSize: 11, padding: "0.42rem 0.7rem" }} onClick={() => removeProposal(proposal.id)}>Deny</button>
              </div>
              {proposal.type === "run" && <div style={{ fontSize: 10, color: "var(--text-muted)" }}>Reusable approval applies only to this exact safe command until this chat is cleared. File changes, deletes, moves, previews, and unsafe commands always require separate review.</div>}
            </div>))}
        </div>)}

      {noKey && (<div className="ai-no-key-notice" style={{ display: "grid", gap: "0.5rem" }}>
          <div><div style={{ fontWeight: 700 }}>Choose your assistant</div><div style={{ fontSize: 11, opacity: 0.8 }}>Start with free Puter AI in this browser or connect your own provider.</div></div>
          <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}><button className="btn btn-primary" onClick={() => void connectFreePuter()} disabled={puterConnecting}>{puterConnecting ? "Connecting…" : "Use free Puter AI"}</button><button className="btn btn-ghost" onClick={() => { setSettingsTab("ai"); setShowSettings(true); }}>AI settings</button></div>
        </div>)}

    <div ref={messagesRef} className="ai-chat-messages" onScroll={handleMessageScroll}>
        {aiChatMessages.length === 0 && !noKey && (<div className="panel-placeholder" style={{ padding: "2rem 1rem" }}>
            <div style={{ margin: "0 auto 0.75rem", width: 56, height: 56, borderRadius: 16, display: "grid", placeItems: "center", background: "rgba(167,139,250,0.14)", boxShadow: "0 0 16px rgba(0,122,204,0.25)" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="4"/>
                <path d="M9 9h.01M15 9h.01M9 15h6"/>
              </svg>
            </div>
            <p style={{ fontWeight: 700, color: "var(--text-primary)", fontSize: 14 }}>SK Coder AI Assistant</p>
            <p style={{ fontSize: 12, color: "var(--text-muted)", maxWidth: 220, textAlign: "center" }}>
              {usePuter ? "Free Puter AI is ready in this browser. Sign in when asked, then review scoped workspace actions before applying them." : "Ask about your code, review workspace changes, and apply scoped actions after you inspect them."}
            </p>
            {["Explain this file", "Fix the bug in my code", "Write a function to..."].map((s) => (<button key={s} className="btn btn-ghost" style={{ fontSize: 11, marginTop: "0.25rem", width: "100%", maxWidth: 240 }} onClick={() => { setInput(s); textareaRef.current?.focus(); }}>
                {s}
              </button>))}
          </div>)}

        {aiChatMessages.map((msg) => (<div key={msg.id} className={`ai-chat-message ${msg.role}`}>
            <div className={`ai-chat-avatar ${msg.role}`}>
              {msg.role === "user" ? (<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                  <circle cx="12" cy="7" r="4"/>
                </svg>) : <AssistantMark/>}
            </div>
            <div className={`ai-message-stack ${activeMessageActions === msg.id ? "actions-open" : ""}`} tabIndex={0} onClick={() => setActiveMessageActions((current) => current === msg.id ? null : msg.id)}>
              <div className="ai-chat-bubble">
              {msg.role === "assistant" ? (<ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                    code({ children, className }) {
                        const isBlock = className?.includes("language-");
                        const content = String(children).replace(/\n$/, "");
                        if (className?.includes("language-chart")) return <AssistantChart source={content} />;
                        return isBlock ? (<pre className="ai-code-block"><button type="button" className="ai-code-copy" onClick={() => void copyChatMessage(content)} title="Copy code" aria-label="Copy code">Copy</button><code className={className}>{children}</code></pre>) : (<code>{children}</code>);
                    },
                }}>
                  {msg.content}
                </ReactMarkdown>) : (<span style={{ whiteSpace: "pre-wrap" }}>{msg.content}</span>)}
              </div>
              <div className="ai-message-actions" onClick={(event) => event.stopPropagation()}><button type="button" className="ai-message-action" onClick={() => void copyChatMessage(msg.content)} title="Copy message" aria-label="Copy message"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>{msg.role === "assistant" ? <><button type="button" className="ai-message-action" onClick={() => void retryAssistantResponse(msg.id)} disabled={aiTyping} title="Retry response" aria-label="Retry response"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/></svg></button><button type="button" className={`ai-message-action ${speakingMessageId === msg.id ? "active" : ""}`} onClick={() => toggleReadMessageAloud(msg.id, msg.content)} title={speakingMessageId === msg.id ? "Stop reading" : "Read aloud"} aria-label={speakingMessageId === msg.id ? "Stop reading" : "Read aloud"}>{speakingMessageId === msg.id ? <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1"/></svg> : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18 6a8.5 8.5 0 0 1 0 12"/></svg>}</button></> : <button type="button" className="ai-message-action" onClick={() => editUserMessage(msg.content)} title="Edit message" aria-label="Edit message"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>}</div>
            </div>
          </div>))}

        {aiTyping && (<div className="ai-chat-message assistant">
            <div className="ai-chat-avatar assistant">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="4"/>
                <path d="M9 9h.01M15 9h.01M9 15h6"/>
              </svg>
            </div>
            <div className="ai-chat-bubble">
              <div className="ai-typing-dots">
                <span /><span /><span />
              </div>
            </div>
          </div>)}

                <div ref={latestMessageRef} />
                {showLatestButton && <button type="button" className="btn btn-ghost" onClick={scrollToLatest} style={{ position: "sticky", bottom: 8, alignSelf: "center", zIndex: 2, fontSize: 11 }}>Jump to latest</button>}
      </div>

      <div className="ai-chat-input-area">
        {attachmentTargets.length > 0 && <div className="ai-attachment-chips" aria-label="Workspace items attached to this chat">
            <span className="ai-attachment-label">Attached</span>
            {attachmentTargets.map((target) => <span key={target.path} className="ai-attachment-chip" title={target.path}>{target.type === "folder" ? "Folder · " : ""}{target.path === "/" ? "Workspace" : target.name}<button type="button" onClick={() => removeAttachment(target.path)} aria-label={`Remove ${target.path}`}>×</button></span>)}
          </div>}
        <div className="ai-chat-input-row">
          <div className="ai-attach-wrap">
            <button className="ai-attach-btn" type="button" onClick={openAttachmentPicker} title="Add workspace file or folder" aria-label="Add workspace file or folder">+</button>
            {showAttachmentPicker && <div className="ai-attach-menu ai-workspace-picker" role="dialog" aria-label="Add workspace context">
              <div className="ai-picker-header"><strong>Add from workspace</strong><button type="button" onClick={() => setShowAttachmentPicker(false)} aria-label="Close attachment picker">×</button></div>
              <div className="ai-picker-path"><button type="button" onClick={() => setAttachmentFolderPath("/")}>Workspace</button>{attachmentFolderPath !== "/" && <><span>/</span><button type="button" onClick={() => setAttachmentFolderPath(attachmentFolderPath.slice(0, attachmentFolderPath.lastIndexOf("/")) || "/")}>Up</button></>}</div>
              {attachmentFolderPath !== "/" && <button type="button" className="ai-picker-select-folder" onClick={() => { attachWorkspaceTarget(attachmentFolderPath); setShowAttachmentPicker(false); }}><strong>Select this folder</strong><span>Attach its readable files as context</span></button>}
              <div className="ai-picker-list">
                {attachmentPickerItems.length === 0 ? <div className="ai-picker-empty">This folder is empty.</div> : attachmentPickerItems.map((node) => node.type === "folder" ? <button key={node.path} type="button" className="ai-picker-row ai-picker-folder" onClick={() => openAttachmentFolder(node.path)} onDoubleClick={() => { attachWorkspaceTarget(node.path); setShowAttachmentPicker(false); }} title="Single-click to open. Double-click to select this folder."><span>▸</span><strong>{node.name}</strong><small>Folder</small></button> : <button key={node.path} type="button" className="ai-picker-row" onClick={() => { attachWorkspaceTarget(node.path); setShowAttachmentPicker(false); }}><span>•</span><strong>{node.name}</strong><small>File</small></button>)}
              </div>
            </div>}
          </div>
          <textarea ref={textareaRef} value={input} onChange={handleTextareaChange} onKeyDown={handleKeyDown} placeholder={noKey ? "Connect free Puter AI or add your own key…" : "Describe the task, paste code, or request a reviewed workspace action…"} disabled={aiTyping} rows={1} aria-label="SK Coder AI Assistant message"/>
          <button className="ai-send-btn" onClick={handleSend} disabled={!input.trim() || aiTyping} title="Send (Enter)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="22" y1="2" x2="11" y2="13"/>
              <polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
        </div>
      </div>
    </div>);
}
