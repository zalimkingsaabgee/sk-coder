import { beginWorkspaceStage, commitWorkspaceStage, createWorkspace, getWorkspaceLifecycle, getWorkspaceManifest, getWorkspaceStageStatus, uploadWorkspaceStageChunk, type WorkspaceRetentionMode } from "./backendRunner";
import { loadBrowserBlob } from "./browserStorage";
import { normalizeWorkspaceStagePath } from "./workspaceStagePath";
import { planWorkspaceDelta } from "./workspaceConnection";
import type { FileNode } from "@/types/ide";

const SESSION_ID_KEY = "sk-coder-workspace-session-id";
const ACCESS_KEY = "sk-coder-workspace-terminal-access";
const DELETE_PENDING_KEY = "sk-coder-workspace-delete-pending";
const STAGE_REVISION_PREFIX = "sk-coder-workspace-stage-revision:";
const STAGE_CHUNK_FALLBACK_BYTES = 4 * 1024 * 1024;
let timer: number | null = null;
let retryTimer: number | null = null;
let mirrorFlight: Promise<void> | null = null;
let queuedTree: FileNode[] | null = null;
let retryDelayMs = 15_000;
type MirrorStatus = "syncing" | "waiting" | "complete";

type StageSource = {
    path: string;
    blob: Blob;
    sha256?: string;
};

function getStoredValue(key: string) {
    try {
        return localStorage.getItem(key);
    }
    catch {
        return null;
    }
}

function setStoredValue(key: string, value: string) {
    try {
        localStorage.setItem(key, value);
    }
    catch {
    }
}

function removeStoredValue(key: string) {
    try {
        localStorage.removeItem(key);
    }
    catch {
    }
}

function hexDigest(value: ArrayBuffer) {
    return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashStageBlob(blob: Blob) {
    if (blob.size > 16 * 1024 * 1024)
        return undefined;
    return hexDigest(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
}

async function blobForNode(node: FileNode) {
    if (node.assetBlobId) {
        const blob = await loadBrowserBlob(node.assetBlobId);
        if (!blob)
            throw new Error(`${node.name} is no longer available in browser storage.`);
        return blob;
    }
    if (node.assetData?.startsWith("data:")) {
        const response = await fetch(node.assetData);
        if (!response.ok)
            throw new Error(`${node.name} could not be read from browser storage.`);
        return response.blob();
    }
    return new Blob([node.assetData ?? node.content ?? ""], { type: node.assetMimeType || "application/octet-stream" });
}

export async function collectWholeWorkspaceSources(nodes: FileNode[]) {
    const files: StageSource[] = [];
    async function collect(items: FileNode[]): Promise<void> {
        for (const node of items) {
            if (node.type === "file") {
                const blob = await blobForNode(node);
                files.push({ path: normalizeWorkspaceStagePath(node.path), blob, sha256: await hashStageBlob(blob) });
            }
            if (node.children)
                await collect(node.children);
        }
    }
    await collect(nodes);
    return files;
}

async function ensureWholeWorkspace(retentionMode: WorkspaceRetentionMode) {
    const storedId = getStoredValue(SESSION_ID_KEY);
    const storedAccess = getStoredValue(ACCESS_KEY);
    if (storedId && storedAccess) {
        try {
            const lifecycle = await getWorkspaceLifecycle(storedId, storedAccess);
            if (lifecycle.state === "active")
                return storedId;
        }
        catch {
            removeStoredValue(SESSION_ID_KEY);
            removeStoredValue(ACCESS_KEY);
        }
    }
    const workspace = await createWorkspace(retentionMode, false);
    setStoredValue(SESSION_ID_KEY, workspace.id);
    setStoredValue(ACCESS_KEY, workspace.terminalAccessToken);
    return workspace.id;
}

export async function mirrorWholeWorkspace(nodes: FileNode[], retentionMode: WorkspaceRetentionMode = "three-days") {
    if (getStoredValue(DELETE_PENDING_KEY) === "true")
        throw new Error("The server workspace is scheduled for deletion. Undo deletion before syncing or starting a server tool.");
    const sessionId = await ensureWholeWorkspace(retentionMode);
    const sources = await collectWholeWorkspaceSources(nodes);
    const workspaceAccess = getStoredValue(ACCESS_KEY) ?? undefined;
    const server = await getWorkspaceManifest(sessionId, workspaceAccess);
    const byPath = new Map(sources.map((source) => [source.path, source]));
    const localManifest = sources.map((source) => ({ path: source.path, size: source.blob.size, sha256: source.sha256 }));
    const { changed, deletedPaths } = planWorkspaceDelta(localManifest, server.files);
    if (changed.length === 0 && deletedPaths.length === 0)
        return { sessionId, revision: server.revision, changedFiles: 0, deletedFiles: 0 };
    let stage = await beginWorkspaceStage(sessionId, changed, undefined, { baseRevision: server.revision, deletedPaths }, workspaceAccess);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            for (const file of stage.files) {
                const source = byPath.get(file.path);
                if (!source)
                    throw new Error(`Workspace file changed during staging: ${file.path}`);
                const requiredOffsets = new Set(file.missingOffsets);
                for (let offset = 0; offset < file.size; offset += stage.chunkBytes || STAGE_CHUNK_FALLBACK_BYTES) {
                    if (!requiredOffsets.has(offset))
                        continue;
                    const chunk = source.blob.slice(offset, Math.min(file.size, offset + (stage.chunkBytes || STAGE_CHUNK_FALLBACK_BYTES)));
                    await uploadWorkspaceStageChunk(sessionId, stage.stageId, file.path, offset, chunk, undefined, workspaceAccess);
                }
            }
            const committed = await commitWorkspaceStage(sessionId, stage.stageId, workspaceAccess);
            setStoredValue(`${STAGE_REVISION_PREFIX}${sessionId}`, String(committed.revision));
            return { sessionId, revision: committed.revision, changedFiles: changed.length, deletedFiles: deletedPaths.length };
        }
        catch (error) {
            if (attempt === 1)
                throw error;
            if (!/workspace changed on the server during staging|workspace changed on the server/i.test(error instanceof Error ? error.message : String(error)) || attempt === 1)
                throw error;
            const refreshed = await getWorkspaceManifest(sessionId, workspaceAccess);
            stage = await beginWorkspaceStage(sessionId, changed, undefined, { baseRevision: refreshed.revision, deletedPaths }, workspaceAccess);
        }
    }
    throw new Error("Workspace staging did not complete.");
}

export function getWholeWorkspaceSessionId() {
    return getStoredValue(SESSION_ID_KEY);
}

export function markWholeWorkspaceDeletionPending(pending: boolean) {
    if (pending)
        setStoredValue(DELETE_PENDING_KEY, "true");
    else
        removeStoredValue(DELETE_PENDING_KEY);
}

export function scheduleWholeWorkspaceMirror(nodes: FileNode[], retentionMode: WorkspaceRetentionMode = "three-days", delayMs = 1800, onStatus?: (status: MirrorStatus) => void) {
    queuedTree = nodes;
    if (timer !== null)
        window.clearTimeout(timer);
    timer = window.setTimeout(() => {
        timer = null;
        const nextTree = queuedTree;
        queuedTree = null;
        if (!nextTree)
            return;
        onStatus?.("syncing");
        const current = mirrorFlight ?? Promise.resolve();
        const scheduledFlight = current.catch(() => undefined).then(async () => {
            await mirrorWholeWorkspace(nextTree, retentionMode);
        });
        mirrorFlight = scheduledFlight;
        void scheduledFlight.finally(() => {
            if (mirrorFlight === scheduledFlight)
                mirrorFlight = null;
        }).catch(() => {
            onStatus?.("waiting");
            if (!queuedTree)
                queuedTree = nextTree;
            if (retryTimer !== null)
                return;
            retryTimer = window.setTimeout(() => {
                retryTimer = null;
                const retryTree = queuedTree;
                if (!retryTree)
                    return;
                retryDelayMs = Math.min(5 * 60_000, retryDelayMs * 2);
                scheduleWholeWorkspaceMirror(retryTree, retentionMode, 300);
            }, retryDelayMs);
        });
        void scheduledFlight.then(() => {
            retryDelayMs = 15_000;
            onStatus?.("complete");
        }).catch(() => undefined);
    }, Math.max(300, delayMs));
}
