import { useState, useRef, useEffect, useCallback, Fragment } from "react";
import { useIDEStore } from "@/store/ideStore";
import { execute, getExecutionTierLabel, type ExecResponse } from "@/lib/executorChain";
import { beginWorkspaceStage, commitWorkspaceStage, createTerminalWebSocket, createWorkspace, getWorkspaceLifecycle, getWorkspaceManifest, getWorkspaceRuntimeStatus, getWorkspaceStageStatus, heartbeatWorkspace, installWorkspaceDependencies, isBackendAvailable, type WorkspaceFilePayload, type WorkspaceLifecycle, uploadWorkspaceStageChunk } from "@/lib/backendRunner";
import { sendAIMessage, buildSystemPrompt } from "@/lib/aiClient";
import { sendPuterChat } from "@/lib/puterClient";
import { parseErrors } from "@/components/ide/ErrorPanel";
import type { FileNode, AIChatMessage } from "@/types/ide";
import { buildPreview } from "@/lib/previewBuilder";
import { loadBrowserBlob } from "@/lib/browserStorage";
import { normalizeWorkspaceStagePath } from "@/lib/workspaceStagePath";
import { filterConsecutivePromptLines } from "@/lib/terminalTranscript";
import { shouldClearPendingCommand } from "@/lib/terminalCommandRecovery";
import { extractAIWorkspaceCommand } from "@/lib/aiWorkspaceCommand";
import { needsWorkspaceStage, planWorkspaceDelta, workspaceTreeRevision } from "@/lib/workspaceConnection";
import { isSameWorkspaceStagingFlight, type WorkspaceStagingFlight } from "@/lib/workspaceStagingFlight";
type TermType = "shell" | "python" | "nodejs" | "java" | "ai";
type TermLine = {
    id: string;
    type: "input" | "output" | "error" | "info" | "success" | "ai-response" | "ai-thinking";
    content: string;
};
type TabDef = {
    id: string;
    type: TermType;
    label: string;
};
type TabState = {
    lines: TermLine[];
    input: string;
    history: string[];
    histIdx: number;
    historyDraft: string;
    cwd: string;
    running: boolean;
};
type WorkspaceConnectionState = "checking" | "connected" | "starting" | "resuming" | "auth" | "waiting" | "offline" | "capacity";
type TerminalLease = {
    sessionId: string;
    terminalId: string;
    terminalAccessToken: string;
};
type PendingAICommand = {
    tabId: string;
    command: string;
    scope: string;
};
function mkLine(type: TermLine["type"], content: string): TermLine {
    return { id: Math.random().toString(36).slice(2), type, content };
}
function initState(type: TermType): TabState {
    return {
        lines: type === "ai" ? [mkLine("info", "AI Terminal — Ask about the current workspace or propose an approved action")] : [],
        input: "",
        history: [],
        histIdx: -1,
        historyDraft: "",
        cwd: "/",
        running: false,
    };
}
let _tabCounter = 10;
function nextTabId(type: TermType) {
    return `${type}-${++_tabCounter}`;
}
function findNodeAtPath(tree: FileNode[], path: string): FileNode | null {
    for (const n of tree) {
        if (n.path === path)
            return n;
        if (n.children) {
            const found = findNodeAtPath(n.children, path);
            if (found)
                return found;
        }
    }
    return null;
}
function getChildrenAt(tree: FileNode[], path: string): FileNode[] {
    if (path === "/" || path === "")
        return tree;
    const node = findNodeAtPath(tree, path);
    return node?.children || [];
}
type StageSource = {
    path: string;
    blob: Blob;
    sha256?: string;
};
function hexDigest(value: ArrayBuffer) {
    return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function hashStageBlob(blob: Blob) {
    if (blob.size > 16 * 1024 * 1024)
        return undefined;
    return hexDigest(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
}
async function collectWorkspaceStageSources(nodes: FileNode[]): Promise<StageSource[]> {
    const files: StageSource[] = [];
    async function collect(items: FileNode[]): Promise<void> {
        for (const node of items) {
            if (node.type === "file") {
                if (node.assetBlobId) {
                    const blob = await loadBrowserBlob(node.assetBlobId);
                    if (!blob)
                        throw new Error(`${node.name} is no longer available in browser storage. Re-import it before using SK Shell.`);
                    files.push({ path: node.path, blob, sha256: await hashStageBlob(blob) });
                }
                else {
                    const content = node.content ?? "";
                    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
                    files.push({ path: node.path, blob, sha256: await hashStageBlob(blob) });
                }
            }
            if (node.children)
                await collect(node.children);
        }
    }
    await collect(nodes);
    return files;
}
async function stageProjectToWorkspace(sessionId: string, nodes: FileNode[], onProgress: (completed: number, total: number) => void) {
    const sources = await collectWorkspaceStageSources(nodes);
    const server = await getWorkspaceManifest(sessionId);
    const byPath = new Map(sources.map((source) => [normalizeWorkspaceStagePath(source.path), source]));
    const localManifest = sources.map((source) => ({ path: normalizeWorkspaceStagePath(source.path), size: source.blob.size, sha256: source.sha256 }));
    const { changed: changedManifest, deletedPaths } = planWorkspaceDelta(localManifest, server.files);
    const changed = changedManifest.map((entry) => byPath.get(entry.path)).filter((source): source is StageSource => Boolean(source));
    if (changed.length === 0 && deletedPaths.length === 0) {
        onProgress(0, 0);
        return;
    }
    let stage = await beginWorkspaceStage(sessionId, changed.map((source) => ({ path: normalizeWorkspaceStagePath(source.path), size: source.blob.size, sha256: source.sha256 })), undefined, { baseRevision: server.revision, deletedPaths });
    const total = changed.reduce((sum, source) => sum + source.blob.size, 0);
    let completed = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            completed = 0;
            for (const file of stage.files) {
                const source = byPath.get(file.path);
                if (!source)
                    throw new Error(`Workspace file changed during staging: ${file.path}`);
                const missing = new Set(file.missingOffsets);
                for (let offset = 0; offset < file.size; offset += stage.chunkBytes) {
                    const chunk = source.blob.slice(offset, Math.min(file.size, offset + stage.chunkBytes));
                    if (missing.has(offset))
                        await uploadWorkspaceStageChunk(sessionId, stage.stageId, file.path, offset, chunk);
                    completed += chunk.size;
                    onProgress(completed, total);
                }
            }
            await commitWorkspaceStage(sessionId, stage.stageId);
            return;
        }
        catch (error) {
            if (attempt === 1)
                throw error;
            stage = await getWorkspaceStageStatus(sessionId, stage.stageId);
        }
    }
}
function collectTextWorkspaceFiles(nodes: FileNode[], files: WorkspaceFilePayload[] = []): WorkspaceFilePayload[] {
    for (const node of nodes) {
        if (node.type === "file" && !node.assetBlobId)
            files.push({ path: node.path, content: node.content ?? "" });
        if (node.children)
            collectTextWorkspaceFiles(node.children, files);
    }
    return files;
}
function resolvePath(cwd: string, input: string): string {
    if (!input || input === "~")
        return "/";
    if (input.startsWith("/"))
        return input.replace(/\/$/, "") || "/";
    const parts = cwd === "/" ? [] : cwd.split("/").filter(Boolean);
    for (const seg of input.split("/")) {
        if (seg === "..")
            parts.pop();
        else if (seg !== ".")
            parts.push(seg);
    }
    return parts.length ? "/" + parts.join("/") : "/";
}

function workspaceShellPath(path: string) {
    return path === "/" ? "/workspace" : `/workspace${path}`;
}
function terminalDimensions() {
    return {
        cols: Math.min(240, Math.max(40, Math.floor(window.innerWidth / 8))),
        rows: Math.min(120, Math.max(12, Math.floor(window.innerHeight / 22))),
    };
}
function browserWorkspacePath(path: string) {
    return path === "/workspace" ? "/" : path.startsWith("/workspace/") ? path.slice("/workspace".length) : path;
}

function quoteShellValue(value: string) {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function workspaceRunCommand(path: string, filename: string) {
    const extension = filename.split(".").pop()?.toLowerCase() || "";
    const target = quoteShellValue(filename);
    const className = filename.replace(/\.java$/i, "").replace(/[^A-Za-z0-9_$]/g, "");
    const directory = quoteShellValue(workspaceShellPath(path.slice(0, Math.max(0, path.lastIndexOf("/"))) || "/"));
    if (["js", "mjs", "cjs"].includes(extension)) return `cd ${directory} && node ${target}`;
    if (["ts", "tsx"].includes(extension)) return `cd ${directory} && npx tsx ${target}`;
    if (extension === "cs") return `cd ${directory} && rm -rf .skcoder-dotnet && dotnet new console --force --output .skcoder-dotnet >/dev/null && cp ${target} .skcoder-dotnet/Program.cs && dotnet run --project .skcoder-dotnet`;
    if (extension === "py") return `cd ${directory} && python3 ${target}`;
    if (extension === "java") return `cd ${directory} && javac -d /tmp/sk-coder-java $(find . -name '*.java' -print) && java -cp /tmp/sk-coder-java ${quoteShellValue(className)}`;
    if (extension === "kt") return `cd ${directory} && kotlinc ${target} -include-runtime -d /tmp/sk-coder-run.jar && java -jar /tmp/sk-coder-run.jar`;
    if (extension === "kts") return `cd ${directory} && kotlinc -script ${target}`;
    if (extension === "c") return `cd ${directory} && gcc ${target} -o /tmp/sk-coder-run && /tmp/sk-coder-run`;
    if (["cpp", "cc", "cxx"].includes(extension)) return `cd ${directory} && g++ ${target} -o /tmp/sk-coder-run && /tmp/sk-coder-run`;
    if (extension === "rs") return `cd ${directory} && rustc ${target} -o /tmp/sk-coder-run && /tmp/sk-coder-run`;
    if (extension === "go") return `cd ${directory} && go run ${target}`;
    if (extension === "php") return `cd ${directory} && php ${target}`;
    if (extension === "rb") return `cd ${directory} && ruby ${target}`;
    if (["sh", "bash"].includes(extension)) return `cd ${directory} && bash ${target}`;
    return "";
}
function isCompressedArtifact(filename: string) {
    return ["zip", "7z", "rar", "tar", "gz", "bz2", "xz", "apk", "aab", "apks", "xapk", "apkm", "dex"].includes(filename.split(".").pop()?.toLowerCase() || "");
}
const TERM_COLORS: Record<TermType, string> = {
    shell: "#4eaa25",
    python: "#3572a5",
    nodejs: "#68a063",
    java: "#f89820",
    ai: "#a78bfa",
};
const TERM_LABELS: Record<TermType, string> = {
    shell: "SK Shell",
    python: "Python Run",
    nodejs: "Node Run",
    java: "Java Run",
    ai: "AI Terminal",
};
const WORKSPACE_COMMANDS = new Set([
    "npm", "npx", "pnpm", "yarn", "pip", "pip3", "git", "curl", "wget", "bash", "sh", "chmod", "rm", "cp", "mv", "find", "grep", "sed", "apt", "apk", "go", "cargo", "rustc", "javac",
]);
function isWorkspaceCommand(input: string) {
    const command = input.trim().split(/\s+/, 1)[0]?.toLowerCase();
    return Boolean(command && WORKSPACE_COMMANDS.has(command));
}
function parseDependencyInstall(input: string): { manager: "npm" | "pnpm" | "yarn"; mode: "install" | "ci"; packages: string[] } | null {
    const match = input.trim().match(/^(npm|pnpm|yarn)\s+(install|i|ci|add)(?:\s+(.+))?$/i);
    if (!match)
        return null;
    const packages = match[3]?.trim().split(/\s+/).filter(Boolean) ?? [];
    return { manager: match[1].toLowerCase() as "npm" | "pnpm" | "yarn", mode: match[2].toLowerCase() === "ci" ? "ci" : "install", packages };
}
const ADD_OPTIONS: {
    type: TermType;
    label: string;
    desc: string;
}[] = [
    { type: "shell", label: "SK Shell", desc: "Live workspace terminal for Node.js, packages, builds, and commands" },
    { type: "ai", label: "AI Terminal", desc: "Workspace-aware help with explicit approvals" },
];
function TermIcon({ type }: {
    type: TermType;
}) {
    if (type === "shell")
        return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
    </svg>);
    if (type === "python")
        return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2C8 2 6 4 6 7v2h6v1H5C3 10 2 11 2 13s1 3 3 4h2v2c0 2 2 3 5 3s5-1 5-3v-2h6c2 0 3-1 3-3s-1-3-3-4h-1V7C22 4 20 2 16 2h-4z"/>
    </svg>);
    if (type === "nodejs")
        return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
    </svg>);
    if (type === "java")
        return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 3c0 2 3 2 3 4s-3 2-3 4 3 2 3 4-3 2-3 4"/><path d="M14 6c2 1 3 2 3 4s-1 3-3 4"/>
    </svg>);
    if (type === "ai")
        return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h2a7 7 0 0 1 7 7H2a7 7 0 0 1 7-7h2V5.73A2 2 0 0 1 10 4a2 2 0 0 1 2-2z"/>
      <rect x="2" y="14" width="20" height="8" rx="2"/>
      <circle cx="8" cy="18" r="1" fill="currentColor" stroke="none"/>
      <circle cx="16" cy="18" r="1" fill="currentColor" stroke="none"/>
    </svg>);
    return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
    </svg>);
}
const DEFAULT_TABS: TabDef[] = [
    { id: "shell-1", type: "shell", label: "SK Shell" },
    { id: "ai-1", type: "ai", label: "AI Terminal" },
];
const DEFAULT_STATES: Record<string, TabState> = {
    "shell-1": initState("shell"),
    "ai-1": initState("ai"),
};
const TERMINAL_LEASE_STORAGE_KEY = "sk-coder-terminal-leases-v1";
function workspaceStageRevisionKey(sessionId: string) {
    return `sk-coder-workspace-stage-revision:${sessionId}`;
}
function loadPersistedTerminalLeases(): Record<string, TerminalLease> {
    try {
        const parsed = JSON.parse(localStorage.getItem(TERMINAL_LEASE_STORAGE_KEY) ?? "{}") as Record<string, TerminalLease>;
        return Object.fromEntries(Object.entries(parsed).filter(([tabId, lease]) => typeof tabId === "string" && typeof lease?.sessionId === "string" && typeof lease?.terminalId === "string" && typeof lease?.terminalAccessToken === "string"));
    }
    catch {
        return {};
    }
}
function loadPersistedTerminalState() {
    try {
        const raw = localStorage.getItem("sk-coder-terminal-state-v1");
        if (!raw)
            return null;
        const parsed = JSON.parse(raw) as {
            tabs?: TabDef[];
            activeTab?: string;
            tabStates?: Record<string, TabState>;
        };
        if (!parsed.tabs || !parsed.tabStates)
            return null;
        const allowedTypes = new Set<TermType>(["shell", "ai"]);
        const tabs = parsed.tabs
            .filter((tab) => allowedTypes.has(tab.type))
            .map((tab) => ({
            ...tab,
            label: tab.type === "ai" ? "AI Terminal" : "SK Shell",
        }));
        if (!tabs.some((tab) => tab.type === "shell"))
            tabs.unshift({ id: "shell-1", type: "shell", label: "SK Shell" });
        if (!tabs.some((tab) => tab.type === "ai"))
            tabs.push({ id: "ai-1", type: "ai", label: "AI Terminal" });
        const tabStates: Record<string, TabState> = {};
        for (const tab of tabs) {
            const stored = parsed.tabStates[tab.id];
            const state = initState(tab.type);
            state.history = Array.isArray(stored?.history) ? stored.history.slice(-200) : [];
            tabStates[tab.id] = state;
        }
        const activeTab = tabs.some((tab) => tab.id === parsed.activeTab) ? parsed.activeTab : tabs[0].id;
        return { tabs, activeTab, tabStates };
    }
    catch {
        return null;
    }
}
export default function MultiTerminal() {
    const { fileTree, addFile, settings, getActiveFile, setShowSettings, setSettingsTab, terminalBridgeCmd, setTerminalBridgeCmd, setErrors, setActivePanel, setPreviewContent, setPreviewResult } = useIDEStore();
    const [tabs, setTabs] = useState<TabDef[]>(() => loadPersistedTerminalState()?.tabs ?? DEFAULT_TABS);
    const [activeTab, setActiveTab] = useState(() => loadPersistedTerminalState()?.activeTab ?? "shell-1");
    const [tabStates, setTabStates] = useState<Record<string, TabState>>(() => loadPersistedTerminalState()?.tabStates ?? DEFAULT_STATES);
    const [showAddMenu, setShowAddMenu] = useState(false);
    const [addMenuPos, setAddMenuPos] = useState<{
        x: number;
        y: number;
    } | null>(null);
    const [aiReady, setAiReady] = useState(false);
    const [workspaceLifecycle, setWorkspaceLifecycle] = useState<WorkspaceLifecycle | null>(null);
    const [workspaceConnection, setWorkspaceConnection] = useState<WorkspaceConnectionState>("checking");
    const [pendingAICommand, setPendingAICommand] = useState<PendingAICommand | null>(null);
    const addMenuRef = useRef<HTMLDivElement>(null);
    const addBtnRef = useRef<HTMLButtonElement>(null);
    const outputRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const terminalSocketsRef = useRef(new Map<string, ReturnType<typeof createTerminalWebSocket>>());
    const projectSessionIdRef = useRef<string | null>(null);
    const projectTerminalAccessTokenRef = useRef<string | null>(null);
    const projectStagedTreeRef = useRef<string | null>(null);
    const workspaceStagingFlightRef = useRef<(WorkspaceStagingFlight & { promise: Promise<void> }) | null>(null);
    const terminalLeasesRef = useRef(new Map<string, TerminalLease>(Object.entries(loadPersistedTerminalLeases())));
    const terminalErrorMessagesRef = useRef(new Set<string>());
    const pendingShellCommandsRef = useRef(new Map<string, string>());
    const recoveringTabsRef = useRef(new Set<string>());
    const connectingTabsRef = useRef(new Set<string>());
    const reconnectAttemptsRef = useRef(new Map<string, number>());
    const reconnectTimersRef = useRef(new Map<string, number>());
    const shellTabIdsRef = useRef(new Set<string>());
    const stickToOutputEndRef = useRef(true);
    const activeState = tabStates[activeTab] ?? initState("shell");
    const activeType = tabs.find((t) => t.id === activeTab)?.type ?? "shell";
    useEffect(() => {
        if (outputRef.current && stickToOutputEndRef.current) {
            outputRef.current.scrollTop = outputRef.current.scrollHeight;
        }
    }, [tabStates, activeTab]);
    useEffect(() => {
        try {
            localStorage.setItem("sk-coder-terminal-state-v1", JSON.stringify({ tabs, activeTab, tabStates }));
        }
        catch {
        }
    }, [tabs, activeTab, tabStates]);
    useEffect(() => {
        inputRef.current?.focus();
    }, [activeTab]);
    useEffect(() => {
        shellTabIdsRef.current = new Set(tabs.filter((tab) => tab.type === "shell").map((tab) => tab.id));
    }, [tabs]);
    function resetShellTranscript(tabId: string) {
        setTabStates((previous) => {
            const current = previous[tabId] ?? initState("shell");
            const clean = initState("shell");
            clean.history = current.history.slice(-200);
            return { ...previous, [tabId]: clean };
        });
    }
    function persistTerminalLeases() {
        try {
            localStorage.setItem(TERMINAL_LEASE_STORAGE_KEY, JSON.stringify(Object.fromEntries(terminalLeasesRef.current)));
        }
        catch {
        }
    }
    function setTerminalLease(tabId: string, sessionId: string, terminalAccessToken: string) {
        terminalLeasesRef.current.set(tabId, { sessionId, terminalId: tabId, terminalAccessToken });
        persistTerminalLeases();
    }
    function clearTerminalLeases() {
        terminalLeasesRef.current.clear();
        try {
            localStorage.removeItem(TERMINAL_LEASE_STORAGE_KEY);
        }
        catch {
        }
    }
    function queueTabReconnect(tabId: string, sessionId?: string | null) {
        if (reconnectTimersRef.current.has(tabId))
            return;
        const attempt = reconnectAttemptsRef.current.get(tabId) ?? 0;
        reconnectAttemptsRef.current.set(tabId, Math.min(attempt + 1, 6));
        const delay = Math.min(8000, 300 * 2 ** attempt) + Math.round(Math.random() * 150);
        const timer = window.setTimeout(() => {
            reconnectTimersRef.current.delete(tabId);
            if (shellTabIdsRef.current.has(tabId))
                void connectShell(tabId, sessionId);
        }, delay);
        reconnectTimersRef.current.set(tabId, timer);
    }
    function recoverShell(tabId: string, command?: string, preserveWorkspace = false) {
        if (command)
            pendingShellCommandsRef.current.set(tabId, command);
        if (recoveringTabsRef.current.has(tabId))
            return;
        recoveringTabsRef.current.add(tabId);
        const previousSessionId = projectSessionIdRef.current ?? localStorage.getItem("sk-coder-workspace-session-id");
        const previousAccessToken = projectTerminalAccessTokenRef.current ?? localStorage.getItem("sk-coder-workspace-terminal-access");
        if (preserveWorkspace && previousSessionId && previousAccessToken) {
            const activeSocket = terminalSocketsRef.current.get(tabId);
            terminalSocketsRef.current.delete(tabId);
            activeSocket?.close();
            setWorkspaceConnection("resuming");
            window.setTimeout(() => {
                recoveringTabsRef.current.delete(tabId);
                void connectShell(tabId, previousSessionId);
            }, 0);
            return;
        }
        const activeSocket = terminalSocketsRef.current.get(tabId);
        terminalSocketsRef.current.delete(tabId);
        activeSocket?.close();
        const hasOtherActiveSockets = terminalSocketsRef.current.size > 0;
        if (!hasOtherActiveSockets) {
            if (previousSessionId)
                localStorage.removeItem(workspaceStageRevisionKey(previousSessionId));
            localStorage.removeItem("sk-coder-workspace-session-id");
            localStorage.removeItem("sk-coder-workspace-terminal-access");
            projectSessionIdRef.current = null;
            projectTerminalAccessTokenRef.current = null;
            projectStagedTreeRef.current = null;
            workspaceStagingFlightRef.current = null;
            clearTerminalLeases();
        }
        setWorkspaceConnection("auth");
        window.setTimeout(() => {
            recoveringTabsRef.current.delete(tabId);
            void connectShell(tabId);
        }, 0);
    }
    async function connectShell(tabId: string, requestedSessionId?: string | null) {
        if (!settings.backend.enabled || terminalSocketsRef.current.has(tabId) || connectingTabsRef.current.has(tabId))
            return;
        connectingTabsRef.current.add(tabId);
        const lease = terminalLeasesRef.current.get(tabId);
        let savedSessionId = requestedSessionId ?? lease?.sessionId ?? projectSessionIdRef.current ?? localStorage.getItem("sk-coder-workspace-session-id");
        let terminalAccessToken = lease?.terminalAccessToken ?? projectTerminalAccessTokenRef.current ?? localStorage.getItem("sk-coder-workspace-terminal-access");
        if (!savedSessionId || !terminalAccessToken) {
            try {
                const workspace = await createWorkspace();
                savedSessionId = workspace.id;
                terminalAccessToken = workspace.terminalAccessToken;
                projectSessionIdRef.current = workspace.id;
                projectTerminalAccessTokenRef.current = workspace.terminalAccessToken;
                localStorage.setItem("sk-coder-workspace-session-id", workspace.id);
                localStorage.setItem("sk-coder-workspace-terminal-access", workspace.terminalAccessToken);
            }
            catch (error) {
                connectingTabsRef.current.delete(tabId);
                const message = error instanceof Error ? error.message : "";
                setWorkspaceConnection(/shared server workplace capacity is busy|existing work remains protected/i.test(message) ? "capacity" : /runtime service|backend|docker/i.test(message) ? "starting" : "waiting");
                queueTabReconnect(tabId, savedSessionId);
                return;
            }
        }
        let socket: ReturnType<typeof createTerminalWebSocket> | null = null;
        const isCurrentSocket = () => socket !== null && terminalSocketsRef.current.get(tabId) === socket;
        socket = createTerminalWebSocket({
            onReady: (sessionId) => {
                if (!isCurrentSocket())
                    return;
                connectingTabsRef.current.delete(tabId);
                reconnectAttemptsRef.current.delete(tabId);
                terminalErrorMessagesRef.current.delete(tabId);
                setWorkspaceConnection("checking");
                if (projectSessionIdRef.current !== sessionId) {
                    projectStagedTreeRef.current = localStorage.getItem(workspaceStageRevisionKey(sessionId));
                    workspaceStagingFlightRef.current = null;
                }
                projectSessionIdRef.current = sessionId;
                projectTerminalAccessTokenRef.current = terminalAccessToken;
                setTerminalLease(tabId, sessionId, terminalAccessToken!);
                localStorage.setItem("sk-coder-workspace-session-id", sessionId);
                const dimensions = terminalDimensions();
                socket?.resize(dimensions.cols, dimensions.rows);
                void getWorkspaceLifecycle(sessionId).then(setWorkspaceLifecycle).catch(() => setWorkspaceLifecycle(null));
                const treeRevision = workspaceTreeRevision(fileTree);
                if (!needsWorkspaceStage(projectStagedTreeRef.current, treeRevision)) {
                    setWorkspaceConnection("connected");
                    recoveringTabsRef.current.delete(tabId);
                    return;
                }
                let staging = workspaceStagingFlightRef.current;
                if (!isSameWorkspaceStagingFlight(staging, sessionId, treeRevision)) {
                    const promise = stageProjectToWorkspace(sessionId, fileTree, () => undefined).then(() => {
                        projectStagedTreeRef.current = treeRevision;
                        localStorage.setItem(workspaceStageRevisionKey(sessionId), treeRevision);
                    });
                    staging = { sessionId, tree: treeRevision, promise };
                    workspaceStagingFlightRef.current = staging;
                }
                const activeStaging = staging as WorkspaceStagingFlight & { promise: Promise<void> };
                void activeStaging.promise
                    .then(() => {
                    setWorkspaceConnection("connected");
                    recoveringTabsRef.current.delete(tabId);
                })
                    .catch(() => {
                    recoveringTabsRef.current.delete(tabId);
                    setWorkspaceConnection("offline");
                })
                    .finally(() => {
                    if (workspaceStagingFlightRef.current?.promise === activeStaging.promise)
                        workspaceStagingFlightRef.current = null;
                });
            },
            onStdout: (data) => {
                if (!isCurrentSocket())
                    return;
                const marker = /__SK_CODER_CWD__(\/workspace(?:\/[^\r\n]*)?)/g;
                let match: RegExpExecArray | null;
                while ((match = marker.exec(data))) {
                    updateState(tabId, { cwd: browserWorkspacePath(match[1]) });
                }
                const visible = data
                    .replace(/(?:^|\r?\n)?__SK_CODER_CWD__\/workspace(?:\/[^\r\n]*)?\r?\n?/g, "")
                    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[()][0-2AB])/g, "");
                if (visible)
                    addLines(tabId, "output", visible);
            },
            onStderr: (data) => {
                if (isCurrentSocket())
                    addLines(tabId, "error", data);
            },
            onExit: (code) => {
                if (isCurrentSocket()) {
                    pendingShellCommandsRef.current.delete(tabId);
                    recoverShell(tabId, undefined, true);
                }
            },
            onState: (state, cwd) => {
                if (!isCurrentSocket())
                    return;
                if (cwd)
                    updateState(tabId, { cwd });
                updateState(tabId, { running: state === "running" });
                if (shouldClearPendingCommand(state, recoveringTabsRef.current.has(tabId)))
                    pendingShellCommandsRef.current.delete(tabId);
            },
            onError: (message) => {
                if (!isCurrentSocket())
                    return;
                terminalSocketsRef.current.delete(tabId);
                connectingTabsRef.current.delete(tabId);
                if (/workspace access is not valid|invalid.*workspace.*(access|session)|unauthorized|forbidden|401|403/i.test(message)) {
                    setWorkspaceConnection("auth");
                    recoverShell(tabId);
                    return;
                }
                if (/workspace runtime is not active|no such container/i.test(message)) {
                    setWorkspaceConnection("resuming");
                    recoverShell(tabId, undefined, true);
                    return;
                }
                if (/workspace session not found|404/i.test(message)) {
                    recoverShell(tabId);
                    return;
                }
                setWorkspaceConnection("waiting");
                queueTabReconnect(tabId, savedSessionId);
            },
            onClose: () => {
                if (!isCurrentSocket())
                    return;
                terminalSocketsRef.current.delete(tabId);
                connectingTabsRef.current.delete(tabId);
                const currentLease = terminalLeasesRef.current.get(tabId);
                if (!currentLease?.sessionId) {
                    setWorkspaceConnection("offline");
                    return;
                }
                setWorkspaceConnection("waiting");
                queueTabReconnect(tabId, currentLease.sessionId);
            },
        }, savedSessionId || undefined, tabId, terminalAccessToken || undefined);
        terminalSocketsRef.current.set(tabId, socket);
    }
    useEffect(() => {
        if (!settings.backend.enabled)
            return;
        let disposed = false;
        let retry: number | undefined;
        const connect = async () => {
            const available = await isBackendAvailable();
            if (disposed)
                return;
            if (!available) {
                setWorkspaceConnection("offline");
                retry = window.setTimeout(() => void connect(), 2000);
                return;
            }
            const status = await getWorkspaceRuntimeStatus();
            if (disposed)
                return;
            if (!status.ready) {
                setWorkspaceConnection("starting");
                retry = window.setTimeout(() => void connect(), 2000);
                return;
            }
            await connectShell("shell-1");
            if (!disposed && !terminalSocketsRef.current.has("shell-1"))
                retry = window.setTimeout(() => void connect(), 2000);
        };
        void connect();
        return () => {
            disposed = true;
            if (retry !== undefined)
                window.clearTimeout(retry);
            projectSessionIdRef.current = null;
            setWorkspaceLifecycle(null);
            for (const socket of terminalSocketsRef.current.values())
                socket.close();
            terminalSocketsRef.current.clear();
            for (const timer of reconnectTimersRef.current.values())
                window.clearTimeout(timer);
            reconnectTimersRef.current.clear();
        };
    }, [settings.backend.enabled]);
    useEffect(() => {
        const resize = () => {
            const dimensions = terminalDimensions();
            for (const socket of terminalSocketsRef.current.values())
                socket.resize(dimensions.cols, dimensions.rows);
        };
        window.addEventListener("resize", resize);
        return () => window.removeEventListener("resize", resize);
    }, []);
    useEffect(() => {
        if (!workspaceLifecycle)
            return;
        const interval = window.setInterval(() => {
            void heartbeatWorkspace(workspaceLifecycle.id, workspaceLifecycle.retentionMode)
                .then(setWorkspaceLifecycle)
                .catch(() => undefined);
        }, 30000);
        return () => window.clearInterval(interval);
    }, [workspaceLifecycle?.id, workspaceLifecycle?.retentionMode]);
    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
                setShowAddMenu(false);
            }
        }
        if (showAddMenu) {
            document.addEventListener("mousedown", handleClick);
            return () => document.removeEventListener("mousedown", handleClick);
        }
        return undefined;
    }, [showAddMenu]);
    function openAddMenu(e: React.MouseEvent) {
        e.preventDefault();
        e.stopPropagation();
        if (showAddMenu) {
            setShowAddMenu(false);
            setAddMenuPos(null);
        }
        else {
            const rect = addBtnRef.current?.getBoundingClientRect();
            if (rect)
                setAddMenuPos({ x: rect.left, y: rect.bottom + 6 });
            setShowAddMenu(true);
        }
    }
    useEffect(() => {
        if (!terminalBridgeCmd)
            return;
        const targetType = (terminalBridgeCmd.targetType as TermType | undefined) ?? "shell";
        let tab = terminalBridgeCmd.targetTab
            ? tabs.find((entry) => entry.id === terminalBridgeCmd.targetTab)
            : terminalBridgeCmd.newTab
                ? undefined
                : tabs.find((entry) => entry.type === targetType);
        let currentTabs = tabs;
        let currentStates = tabStates;
        if (!tab) {
            const id = nextTabId(targetType);
            const label = TERM_LABELS[targetType] ?? targetType;
            const newTab: TabDef = { id, type: targetType, label };
            currentTabs = [...tabs, newTab];
            currentStates = { ...tabStates, [id]: initState(targetType) };
            setTabs(currentTabs);
            setTabStates(currentStates);
            tab = newTab;
        }
        const tabId = tab.id;
        setActiveTab(tabId);
        const cmds = terminalBridgeCmd.cmds ?? [terminalBridgeCmd.cmd];
        setTerminalBridgeCmd(null);
        let delay = 50;
        for (const cmd of cmds) {
            const c = cmd;
            const d = delay;
            setTimeout(() => {
                addLine(tabId, "input", `$ ${c}`);
                handleShell(tabId, c).catch(() => { });
            }, d);
            delay += 120;
        }
    }, [terminalBridgeCmd]);
    function updateState(tabId: string, patch: Partial<TabState>) {
        setTabStates((prev) => ({ ...prev, [tabId]: { ...(prev[tabId] ?? initState("shell")), ...patch } }));
    }
    function addLine(tabId: string, type: TermLine["type"], content: string) {
        setTabStates((prev) => {
            const cur = prev[tabId] ?? initState("shell");
            return { ...prev, [tabId]: { ...cur, lines: [...cur.lines.slice(-600), mkLine(type, content)] } };
        });
    }
    function addLines(tabId: string, type: TermLine["type"], text: string) {
        const parts = text.split("\n").filter((l) => l !== "");
        setTabStates((previous) => {
            const current = previous[tabId] ?? initState("shell");
            const accepted = filterConsecutivePromptLines(current.lines.map((line) => line.content), parts, type);
            if (!accepted.length)
                return previous;
            return { ...previous, [tabId]: { ...current, lines: [...current.lines.slice(-600), ...accepted.map((content) => mkLine(type, content))] } };
        });
        if (workspaceLifecycle && type !== "input") {
            void heartbeatWorkspace(workspaceLifecycle.id, workspaceLifecycle.retentionMode)
                .then(setWorkspaceLifecycle)
                .catch(() => undefined);
        }
    }
    function publishExecutionResult(result: ExecResponse) {
        setPreviewResult({
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            tier: result.tier,
            capability: result.capability,
            executionTime: result.executionTime,
        });
        setActivePanel("preview");
    }
    const DEFAULT_TAB_IDS = ["shell-1", "ai-1"];
    function clearTerminalHistory(tabId: string) {
        if (DEFAULT_TAB_IDS.includes(tabId)) {
            updateState(tabId, { lines: [], cwd: "/", history: [], input: "", histIdx: -1, historyDraft: "" });
        }
        else {
            updateState(tabId, { lines: [], input: "", histIdx: -1, historyDraft: "" });
        }
    }
    function addNewTab(type: TermType) {
        const id = nextTabId(type);
        const label = TERM_LABELS[type];
        setTabs((prev) => [...prev, { id, type, label }]);
        setTabStates((prev) => ({ ...prev, [id]: initState(type) }));
        setActiveTab(id);
        setShowAddMenu(false);
        if (type === "shell")
            connectShell(id);
        setTimeout(() => inputRef.current?.focus(), 50);
    }
    function closeTab(tabId: string) {
        if (tabs.length === 1)
            return;
        const idx = tabs.findIndex((t) => t.id === tabId);
        terminalSocketsRef.current.get(tabId)?.close();
        terminalSocketsRef.current.delete(tabId);
        const reconnectTimer = reconnectTimersRef.current.get(tabId);
        if (reconnectTimer !== undefined)
            window.clearTimeout(reconnectTimer);
        reconnectTimersRef.current.delete(tabId);
        reconnectAttemptsRef.current.delete(tabId);
        terminalLeasesRef.current.delete(tabId);
        persistTerminalLeases();
        const newTabs = tabs.filter((t) => t.id !== tabId);
        setTabs(newTabs);
        if (activeTab === tabId) {
            setActiveTab(newTabs[Math.max(0, idx - 1)].id);
        }
        setTabStates((prev) => {
            const next = { ...prev };
            delete next[tabId];
            return next;
        });
    }
    async function handleShell(tabId: string, input: string) {
        const state = tabStates[tabId];
        const cwd = state?.cwd || "/";
        const terminalSocket = terminalSocketsRef.current.get(tabId);
        const lease = terminalLeasesRef.current.get(tabId);
        const parts = input.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);
        if (lease?.sessionId && terminalSocket?.isOpen()) {
            try {
                const treeRevision = workspaceTreeRevision(fileTree);
                if (needsWorkspaceStage(projectStagedTreeRef.current, treeRevision)) {
                    await stageProjectToWorkspace(lease.sessionId, fileTree, () => undefined);
                    projectStagedTreeRef.current = treeRevision;
                }
                if (cmd === "run") {
                    const requested = args[0];
                    const path = requested ? resolvePath(cwd, requested) : "";
                    const node = path ? findNodeAtPath(fileTree, path) : null;
                    if (!requested || !node || node.type !== "file") {
                        addLine(tabId, "error", `run: ${requested || "specify a filename"}: No such file`);
                        return;
                    }
                    if (isCompressedArtifact(node.name)) {
                        const androidArtifact = ["apk", "aab", "apks", "xapk", "apkm", "dex"].includes(node.name.split(".").pop()?.toLowerCase() || "");
                        addLine(tabId, "error", androidArtifact
                            ? `${node.name} is an Android artifact, not a terminal program. Open it in the APK tab to inspect, decode, edit, rebuild, or sign it.`
                            : `${node.name} is an archive, not an executable. Extract or import it, choose the project entry file or build command, then run that source file in SK Shell.`);
                        return;
                    }
                    const command = workspaceRunCommand(path, node.name);
                    if (!command) {
                        addLine(tabId, "error", `run: .${node.name.split(".").pop()?.toLowerCase() || "file"} needs a supported workspace command`);
                        return;
                    }
                    terminalSocket.sendCommand(command);
                    return;
                }
                const dependencyInstall = parseDependencyInstall(input);
                if (dependencyInstall) {
                    updateState(tabId, { running: true });
                    addLine(tabId, "input", `$ ${input}`);
                    try {
                        const result = await installWorkspaceDependencies(lease.sessionId, dependencyInstall.manager, dependencyInstall.mode, cwd, dependencyInstall.packages);
                        if (result.stdout)
                            addLines(tabId, "output", result.stdout.trimEnd());
                        if (result.stderr)
                            addLines(tabId, result.exitCode === 0 ? "info" : "error", result.stderr.trimEnd());
                        if (result.exitCode !== 0)
                            addLine(tabId, "error", `Dependency installation finished with code ${result.exitCode}.`);
                    }
                    finally {
                        updateState(tabId, { running: false });
                    }
                    return;
                }
                pendingShellCommandsRef.current.set(tabId, input);
                terminalSocket.sendCommand(input);
                return;
            }
            catch (error) {
                const message = error instanceof Error ? error.message : "Workspace synchronization failed.";
                if (/Workspace runtime is not active|no such container/i.test(message)) {
                    recoverShell(tabId, undefined, true);
                    return;
                }
                if (/Workspace session not found|expired/i.test(message)) {
                    recoverShell(tabId);
                    return;
                }
                addLine(tabId, "error", message);
                return;
            }
        }
        updateState(tabId, { input });
        recoverShell(tabId);
    }
    async function handlePython(tabId: string, code: string) {
        const res = await execute("python", code);
        addLine(tabId, "info", `Runtime: ${getExecutionTierLabel(res.tier)} — ${res.capability}`);
        if (res.stdout)
            addLines(tabId, "output", res.stdout.trimEnd());
        if (res.stderr) {
            addLines(tabId, "error", res.stderr.trimEnd());
            const errs = parseErrors(res.stderr);
            if (errs.length)
                setErrors(errs);
        }
        if (!res.stdout && !res.stderr)
            addLine(tabId, "info", "(no output)");
        if (res.executionTime > 0)
            addLine(tabId, "info", `⏱ ${res.executionTime}ms | exit ${res.exitCode}`);
        publishExecutionResult(res);
    }
    async function handleNodeJs(tabId: string, code: string) {
        const state = tabStates[tabId];
        const cwd = state?.cwd || "/";
        const trimmed = code.trim();
        const runMatch = trimmed.match(/^(?:run|node)\s+(\S+)/);
        let execCode = trimmed;
        if (runMatch) {
            const filename = runMatch[1];
            const path = resolvePath(cwd, filename);
            const node = findNodeAtPath(fileTree, path);
            if (!node || node.type === "folder") {
                addLine(tabId, "error", `run: ${filename}: No such file`);
                return;
            }
            addLine(tabId, "info", `Running ${filename}...`);
            execCode = node.content || "";
        }
        const res = await execute("node", execCode);
        addLine(tabId, "info", `Runtime: ${getExecutionTierLabel(res.tier)} — ${res.capability}`);
        if (res.stdout)
            addLines(tabId, "output", res.stdout.trimEnd());
        if (res.stderr)
            addLines(tabId, "error", res.stderr.trimEnd());
        if (!res.stdout && !res.stderr)
            addLine(tabId, "info", "(no output)");
        if (res.executionTime > 0)
            addLine(tabId, "info", `⏱ ${res.executionTime}ms | exit ${res.exitCode}`);
        publishExecutionResult(res);
    }
    async function handleJava(tabId: string, code: string) {
        const res = await execute("java", code);
        addLine(tabId, "info", `Runtime: ${getExecutionTierLabel(res.tier)} — ${res.capability}`);
        if (res.stdout)
            addLines(tabId, "output", res.stdout.trimEnd());
        if (res.stderr)
            addLines(tabId, "error", res.stderr.trimEnd());
        if (!res.stdout && !res.stderr)
            addLine(tabId, "info", "(no output)");
        if (res.executionTime > 0)
            addLine(tabId, "info", `⏱ ${res.executionTime}ms | exit ${res.exitCode}`);
        publishExecutionResult(res);
    }
    async function handleAI(tabId: string, question: string) {
        const { apiKey, keyStatus, autoContext, usePuter } = settings.ai;
        const hasProviderKey = Boolean(apiKey && keyStatus === "valid");
        if (!hasProviderKey && !usePuter) {
            addLine(tabId, "error", "Connect free Puter AI or a verified provider in Settings → AI before using AI Terminal.");
            setSettingsTab("ai");
            setShowSettings(true);
            return;
        }
        const thinkingId = Math.random().toString(36).slice(2);
        setTabStates((prev) => {
            const cur = prev[tabId] ?? initState("ai");
            return { ...prev, [tabId]: { ...cur, lines: [...cur.lines, { id: thinkingId, type: "ai-thinking" as const, content: "Thinking..." }] } };
        });
        const activeFile = getActiveFile();
        const cwd = tabStates[tabId]?.cwd || "/";
        const workspaceFiles = cwd === "/" ? [] : collectTextWorkspaceFiles(fileTree).filter((file) => file.path.startsWith(`${cwd}/`)).slice(0, 8);
        const scopedActiveFile = activeFile && (cwd === "/" || activeFile.path === cwd || activeFile.path.startsWith(`${cwd}/"`.slice(0, -1))) ? activeFile : undefined;
        const systemPrompt = `${buildSystemPrompt({
            activeFilePath: scopedActiveFile?.path,
            activeFileContent: autoContext ? scopedActiveFile?.content : undefined,
            fileTree: workspaceFiles.map((file) => file.path),
            workspaceFiles,
        })}\nIf a single workspace-scoped command would help, include it on its own line as SK_CODER_COMMAND: <command>. Do not propose sudo, Docker, OS package managers, system services, remote shell access, deployment commands, or destructive commands. The command will never execute automatically.`;
        try {
            const messages: AIChatMessage[] = [{ id: "q", role: "user", content: question, timestamp: Date.now() }];
            const res = usePuter
                ? { content: await sendPuterChat(messages, systemPrompt) }
                : await sendAIMessage({ key: apiKey, provider: settings.ai.provider, customEndpoint: settings.ai.apiEndpoint, customModel: settings.ai.model, messages, systemPrompt });
            const reply = res.error ? `Error: ${res.error}` : res.content || "(no response)";
            const command = extractAIWorkspaceCommand(reply);
            if (command)
                setPendingAICommand({ tabId, command, scope: cwd || "/" });
            setTabStates((prev) => {
                const cur = prev[tabId] ?? initState("ai");
                const withoutThinking = cur.lines.filter((l) => l.id !== thinkingId);
                const replyLines = reply.split("\n").map((line) => mkLine("ai-response", line));
                return { ...prev, [tabId]: { ...cur, lines: [...withoutThinking, ...replyLines, mkLine("info", "─────")] } };
            });
        }
        catch (e) {
            setTabStates((prev) => {
                const cur = prev[tabId] ?? initState("ai");
                const withoutThinking = cur.lines.filter((l) => l.id !== thinkingId);
                return { ...prev, [tabId]: { ...cur, lines: [...withoutThinking, mkLine("error", `AI Error: ${String(e)}`)] } };
            });
        }
    }
    async function approveAIWorkspaceCommand() {
        const pending = pendingAICommand;
        if (!pending)
            return;
        setPendingAICommand(null);
        let shell = tabs.find((tab) => tab.type === "shell");
        if (!shell) {
            const id = nextTabId("shell");
            shell = { id, type: "shell", label: "SK Shell" };
            setTabs((previous) => [...previous, shell!]);
            setTabStates((previous) => ({ ...previous, [id]: initState("shell") }));
            connectShell(id);
        }
        setActiveTab(shell.id);
        addLine(shell.id, "info", `Approved AI workspace command for ${pending.scope}: ${pending.command}`);
        await handleShell(shell.id, pending.command);
    }
    async function handleSubmit(tabId: string) {
        const state = tabStates[tabId];
        const input = state?.input?.trim();
        if (!input || state?.running)
            return;
        const type = tabs.find((t) => t.id === tabId)?.type || "shell";
        const newHistory = [input, ...(state.history || []).slice(0, 99)];
        updateState(tabId, { input: "", history: newHistory, histIdx: -1, historyDraft: "" });
        const liveShell = type === "shell" && workspaceConnection === "connected" && Boolean(terminalSocketsRef.current.get(tabId)?.isOpen());
        if (!liveShell && type === "shell") {
            recoverShell(tabId, input);
            return;
        }
        const prompts: Record<TermType, string> = { shell: `[${state.cwd || "/"}]$`, python: ">>>", nodejs: ">", java: "java>", ai: "you>" };
        if (!liveShell)
            addLine(tabId, "input", `${prompts[type]} ${input}`);
        if (input === "clear" || input === "cls") {
            updateState(tabId, { lines: [] });
            return;
        }
        updateState(tabId, { running: true });
        try {
            if (type === "shell")
                await handleShell(tabId, input);
            else if (type === "python" && isWorkspaceCommand(input)) {
                await handleShell(tabId, input);
            }
            else if (type === "nodejs" && isWorkspaceCommand(input)) {
                await handleShell(tabId, input);
            }
            else if (type === "java" && isWorkspaceCommand(input)) {
                await handleShell(tabId, input);
            }
            else if (type === "python")
                await handlePython(tabId, input);
            else if (type === "nodejs")
                await handleNodeJs(tabId, input);
            else if (type === "java")
                await handleJava(tabId, input);
            else if (type === "ai")
                await handleAI(tabId, input);
        }
        finally {
            if (!liveShell)
                setTabStates((prev) => prev[tabId] ? { ...prev, [tabId]: { ...prev[tabId], running: false } } : prev);
        }
    }
    function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>, tabId: string) {
        const state = tabStates[tabId];
        if (e.key === "Enter") {
            e.preventDefault();
            void handleSubmit(tabId);
            return;
        }
        if (e.key === "ArrowUp") {
            e.preventDefault();
            if (!state?.history?.length)
                return;
            const next = Math.min((state?.histIdx ?? -1) + 1, (state?.history?.length ?? 0) - 1);
            updateState(tabId, { histIdx: next, historyDraft: state?.histIdx === -1 ? state.input : state?.historyDraft || "", input: state?.history?.[next] || "" });
            return;
        }
        if (e.key === "ArrowDown") {
            e.preventDefault();
            const next = Math.max((state?.histIdx ?? -1) - 1, -1);
            updateState(tabId, { histIdx: next, input: next === -1 ? state?.historyDraft || "" : state?.history?.[next] || "" });
            return;
        }
        if (e.key === "c" && e.ctrlKey) {
            e.preventDefault();
            terminalSocketsRef.current.get(tabId)?.interrupt();
            addLine(tabId, "info", "^C");
            updateState(tabId, { input: "", running: false });
        }
        if (e.key === "l" && e.ctrlKey) {
            e.preventDefault();
            updateState(tabId, { lines: [] });
        }
        if (e.key === "Tab") {
            e.preventDefault();
            const input = state?.input || "";
            const cwd = state?.cwd || "/";
            const children = getChildrenAt(fileTree, cwd);
            const lastWord = input.split(" ").pop() || "";
            const match = children.find((c) => c.name.startsWith(lastWord));
            if (match) {
                const words = input.split(" ");
                words[words.length - 1] = match.type === "folder" ? match.name + "/" : match.name;
                updateState(tabId, { input: words.join(" ") });
            }
        }
    }
    function sendAccessory(tabId: string, key: "tab" | "up" | "down" | "escape" | "ctrl-c" | "ctrl-l" | "ctrl-a" | "ctrl-e" | "left" | "right") {
        const socket = terminalSocketsRef.current.get(tabId);
        const sequences: Record<typeof key, string> = {
            tab: "\t",
            up: "\u001b[A",
            down: "\u001b[B",
            escape: "\u001b",
            "ctrl-c": "\u0003",
            "ctrl-l": "\u000c",
            "ctrl-a": "\u0001",
            "ctrl-e": "\u0005",
            left: "\u001b[D",
            right: "\u001b[C",
        };
        if (key === "ctrl-c") {
            socket?.interrupt();
            addLine(tabId, "info", "^C");
            updateState(tabId, { input: "", running: false });
            return;
        }
        if (key === "ctrl-l") {
            updateState(tabId, { lines: [] });
            inputRef.current?.focus();
            return;
        }
        const state = tabStates[tabId];
        if (key === "up" && !state?.running) {
            if (!state?.history?.length)
                return;
            const next = Math.min((state?.histIdx ?? -1) + 1, (state?.history?.length ?? 0) - 1);
            updateState(tabId, { histIdx: next, historyDraft: state?.histIdx === -1 ? state.input : state?.historyDraft || "", input: state?.history?.[next] || "" });
            inputRef.current?.focus();
            return;
        }
        if (key === "down" && !state?.running) {
            const next = Math.max((state?.histIdx ?? -1) - 1, -1);
            updateState(tabId, { histIdx: next, input: next === -1 ? state?.historyDraft || "" : state?.history?.[next] || "" });
            inputRef.current?.focus();
            return;
        }
        if (socket)
            socket.sendInput(sequences[key]);
        if (key === "ctrl-a" || key === "ctrl-e") {
            const input = inputRef.current;
            if (input) {
                const position = key === "ctrl-a" ? 0 : input.value.length;
                input.focus();
                input.setSelectionRange(position, position);
            }
        }
        if (key === "tab")
            inputRef.current?.focus();
    }
    const promptLabels: Record<TermType, string> = {
        shell: workspaceConnection === "connected" ? "$" : "",
        python: ">>>",
        nodejs: ">",
        java: "java>",
        ai: "ask>",
    };
    const placeholders: Record<TermType, string> = {
        shell: workspaceConnection === "connected" ? "Enter command" : "Connecting…",
        python: "print('hello')  • import math  • source only",
        nodejs: "console.log('hello')  • require('fs')  • source only",
        java: "class Main { public static void main(String[] args) { System.out.println(\"hello\"); } }",
        ai: "Ask about the workspace · Enter sends",
    };
    const visibleLines = (() => {
        let unavailableSeen = false;
        return activeState.lines.reduce<TermLine[]>((lines, line) => {
            if (!/isolated runtime service is not available|Oracle Docker workspace is unavailable|Live workspace is unavailable|Workspace session could not start/i.test(line.content)) {
                lines.push(line);
                return lines;
            }
            if (unavailableSeen)
                return lines;
            unavailableSeen = true;
            return lines;
        }, []);
    })();
    return (<div className="multi-terminal">
      <div className="multi-terminal-tabs">
        {tabs.map((tab, idx) => {
            const isActive = tab.id === activeTab;
            const isReady = tab.type !== "shell" || workspaceConnection === "connected";
            const isAiReady = tab.type === "ai" && (aiReady || !!settings.ai.apiKey);
            const isDefault = DEFAULT_TAB_IDS.includes(tab.id);
            return (<div key={tab.id} className={`multi-term-tab ${isActive ? "active" : ""}`} onClick={() => setActiveTab(tab.id)}>
              <span style={{ color: TERM_COLORS[tab.type], display: "flex", alignItems: "center" }}>
                <TermIcon type={tab.type}/>
              </span>
              <span>{tab.label}</span>
              {(isReady || tab.type === "nodejs" || tab.type === "java" || isAiReady) && (<span style={{ width: 5, height: 5, borderRadius: "50%", background: tab.type === "ai" ? "#a78bfa" : "var(--green)", flexShrink: 0 }}/>)}
              {!isDefault && (<button onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }} style={{ marginLeft: "0.5rem", padding: "0.2rem", background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: "1.2rem", lineHeight: "1" }} title="Close terminal">
                  ×
                </button>)}
            </div>);
        })}

        <div ref={addMenuRef} style={{ flexShrink: 0 }}>
          <button ref={addBtnRef} className="term-add-btn" onMouseDown={openAddMenu} title="Add new terminal">+</button>
        </div>

        {showAddMenu && addMenuPos && (<div className="term-add-menu" style={{ position: "fixed", left: addMenuPos.x, top: addMenuPos.y, zIndex: 2000 }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="term-add-menu-title">New Terminal</div>
            {ADD_OPTIONS.map((opt) => (<button key={opt.type} className="term-add-option" onMouseDown={(e) => { e.preventDefault(); addNewTab(opt.type); }}>
                <span style={{ color: TERM_COLORS[opt.type] }}><TermIcon type={opt.type}/></span>
                <div>
                  <div style={{ fontWeight: 600 }}>{opt.label}</div>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 1 }}>{opt.desc}</div>
                </div>
              </button>))}
          </div>)}

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", paddingRight: 4, gap: 4 }}>
          <button className="btn-icon" onClick={() => {
            const tab = tabs.find((item) => item.id === activeTab);
            if (window.confirm(`Clear the history for ${tab?.label ?? "this terminal"}?`))
                clearTerminalHistory(activeTab);
        }} title="Clear terminal">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            </svg>
          </button>
        </div>
      </div>

      {activeType === "shell" && workspaceConnection !== "connected" && (<div className="terminal-workspace-notice" role="status">
          {workspaceConnection === "checking" && "Checking SK Shell connection…"}
          {workspaceConnection === "starting" && "Backend service is starting. Retrying SK Shell…"}
          {workspaceConnection === "resuming" && "Workspace paused. Resuming your private workspace…"}
          {workspaceConnection === "auth" && "Session expired. Creating a new workspace session…"}
          {workspaceConnection === "waiting" && `Connection lost. Reconnecting${(reconnectAttemptsRef.current.get(activeTab) ?? 0) > 0 ? ` (attempt ${reconnectAttemptsRef.current.get(activeTab)})` : ""}…`}
          {workspaceConnection === "offline" && "Workspace server is unavailable. Your browser project remains available while it retries."}
          {workspaceConnection === "capacity" && "Server workspace capacity is full. Your project remains in browser storage and will retry when server space is available."}
        </div>)}

      <div className="terminal-output" ref={outputRef} onScroll={(event) => {
            const target = event.currentTarget;
            stickToOutputEndRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 28;
        }}>
        {visibleLines.map((line) => {
            if (line.type === "ai-thinking") {
                return (<div key={line.id} className="terminal-line info" style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "#a78bfa", opacity: 0.8 }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: "spin 1s linear infinite", flexShrink: 0 }}>
                  <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                </svg>
                <span style={{ fontStyle: "italic" }}>{line.content}</span>
              </div>);
            }
            if (line.type === "ai-response") {
                const isCode = line.content.startsWith("```") || line.content.startsWith("    ");
                if (line.content === "─────")
                    return <div key={line.id} style={{ borderTop: "1px solid rgba(167,139,250,0.2)", margin: "0.4rem 0" }}/>;
                return (<div key={line.id} style={{
                        fontFamily: isCode ? "var(--font-mono)" : "inherit",
                        fontSize: isCode ? 11 : 12,
                        color: isCode ? "#e2c08d" : "var(--text-primary)",
                        background: isCode ? "rgba(167,139,250,0.06)" : "transparent",
                        borderLeft: isCode ? "2px solid #a78bfa" : "none",
                        paddingLeft: isCode ? "0.5rem" : 0,
                        lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word",
                    }}>{line.content}</div>);
            }
            return (<div key={line.id} className={`terminal-line ${line.type}`}>
              <span>{line.content}</span>
            </div>);
        })}
      </div>

      {activeType === "shell" && (<div className="terminal-keyboard-row" aria-label="Terminal controls">
          <button onClick={() => sendAccessory(activeTab, "tab")}>Tab</button>
          <button onClick={() => sendAccessory(activeTab, "up")}>↑</button>
          <button onClick={() => sendAccessory(activeTab, "down")}>↓</button>
          <button onClick={() => sendAccessory(activeTab, "left")}>←</button>
          <button onClick={() => sendAccessory(activeTab, "right")}>→</button>
          <button onClick={() => sendAccessory(activeTab, "escape")}>Esc</button>
          <button onClick={() => sendAccessory(activeTab, "ctrl-c")}>Ctrl+C</button>
          <button onClick={() => sendAccessory(activeTab, "ctrl-l")}>Ctrl+L</button>
          <button onClick={() => sendAccessory(activeTab, "ctrl-a")}>Home</button>
          <button onClick={() => sendAccessory(activeTab, "ctrl-e")}>End</button>
        </div>)}

      {activeType === "ai" && pendingAICommand?.tabId === activeTab && (<div className="terminal-workspace-notice" role="status" style={{ display: "flex", alignItems: "center", gap: "0.45rem", flexWrap: "wrap" }}>
          <span>AI proposes: <code>{pendingAICommand.command}</code></span>
          <button className="btn-secondary" type="button" onClick={() => void approveAIWorkspaceCommand()}>Run once</button>
          <button className="btn-secondary" type="button" onClick={() => setPendingAICommand(null)}>Dismiss</button>
        </div>)}

      <form className="terminal-input-row" onSubmit={(event) => { event.preventDefault(); void handleSubmit(activeTab); }}>
        <span className="terminal-prompt-label" style={{ color: TERM_COLORS[activeType], fontSize: 11, whiteSpace: "nowrap", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis" }}>
          {promptLabels[activeType]}
        </span>
        <input ref={inputRef} className="terminal-input" value={activeState.input} onChange={(e) => updateState(activeTab, { input: e.target.value, histIdx: -1 })} onKeyDown={(e) => handleKeyDown(e, activeTab)} placeholder={placeholders[activeType]} disabled={activeState.running || (activeType === "shell" && workspaceConnection !== "connected")} autoComplete="off" spellCheck={false} aria-label={activeType === "ai" ? "AI Terminal message" : "Terminal command or program input"}/>
        <button type="submit" className="terminal-submit" disabled={activeState.running || !activeState.input.trim() || (activeType === "shell" && workspaceConnection !== "connected")} title={activeType === "ai" ? "Ask SK-AI" : "Run command"} aria-label={activeType === "ai" ? "Ask SK-AI" : "Run command"}>
          {activeType === "ai" ? "↑" : "↵"}
        </button>
      </form>

    </div>);
}
