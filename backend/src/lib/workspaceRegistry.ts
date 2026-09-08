import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { WORKSPACE_METADATA_PATH } from "./backendConfig.js";
export type RetentionMode = "three-days" | "four-hours";
const RETAINED_WORKSPACE_HOURS = 72;
const SCHEDULED_DELETE_HOURS = 4;
export type WorkspaceRecord = {
    id: string;
    terminalAccessHash: string;
    createdAt: number;
    lastHeartbeatAt: number;
    expiresAt: number;
    retentionMode: RetentionMode;
    keepAlive: boolean;
    quotaBytes: number;
    state: "active" | "scheduled-delete" | "deleted";
    deleteUndoUntil: number | null;
    revision: number;
};
type WorkspaceRegistry = {
    version: 1;
    records: WorkspaceRecord[];
};
let registryCache: WorkspaceRegistry | null = null;
let writeQueue = Promise.resolve();
function defaultRegistry(): WorkspaceRegistry {
    return { version: 1, records: [] };
}
async function readRegistry(): Promise<WorkspaceRegistry> {
    if (registryCache)
        return registryCache;
    try {
        const parsed = JSON.parse(await readFile(WORKSPACE_METADATA_PATH, "utf8")) as WorkspaceRegistry;
        registryCache = parsed?.version === 1 && Array.isArray(parsed.records) ? parsed : defaultRegistry();
    }
    catch {
        registryCache = defaultRegistry();
    }
    return registryCache;
}
async function persistRegistry() {
    const registry = await readRegistry();
    await mkdir(dirname(WORKSPACE_METADATA_PATH), { recursive: true, mode: 0o700 });
    const temporaryPath = join(dirname(WORKSPACE_METADATA_PATH), `.workspaces-${randomUUID()}.json`);
    await writeFile(temporaryPath, JSON.stringify(registry), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, WORKSPACE_METADATA_PATH);
}
function queuePersist() {
    writeQueue = writeQueue.then(() => persistRegistry());
    return writeQueue;
}
export async function createWorkspaceRecord(id: string, quotaBytes: number, retentionMode: RetentionMode = "three-days", terminalAccessHash = "", keepAlive = false) {
    const registry = await readRegistry();
    const now = Date.now();
    const duration = retentionMode === "four-hours" ? SCHEDULED_DELETE_HOURS : RETAINED_WORKSPACE_HOURS;
    const record: WorkspaceRecord = {
        id,
        terminalAccessHash,
        createdAt: now,
        lastHeartbeatAt: now,
        expiresAt: now + duration * 60 * 60 * 1000,
        retentionMode,
        keepAlive,
        quotaBytes,
        state: "active",
        deleteUndoUntil: null,
        revision: 0,
    };
    registry.records = [...registry.records.filter((item) => item.id !== id), record];
    await queuePersist();
    return record;
}
export async function getWorkspaceRecord(id: string) {
    return (await readRegistry()).records.find((item) => item.id === id) ?? null;
}
export async function touchWorkspaceRecord(id: string) {
    const registry = await readRegistry();
    const record = registry.records.find((item) => item.id === id);
    if (!record)
        return null;
    record.lastHeartbeatAt = Date.now();
    await queuePersist();
    return record;
}
export async function setWorkspaceRetention(id: string, retentionMode: RetentionMode) {
    const registry = await readRegistry();
    const record = registry.records.find((item) => item.id === id);
    if (!record)
        return null;
    const now = Date.now();
    const duration = retentionMode === "four-hours" ? SCHEDULED_DELETE_HOURS : RETAINED_WORKSPACE_HOURS;
    record.retentionMode = retentionMode;
    record.lastHeartbeatAt = now;
    record.expiresAt = now + duration * 60 * 60 * 1000;
    record.state = "active";
    record.deleteUndoUntil = null;
    await queuePersist();
    return record;
}
export async function setWorkspaceKeepAlive(id: string, keepAlive: boolean) {
    const registry = await readRegistry();
    const record = registry.records.find((item) => item.id === id);
    if (!record)
        return null;
    record.keepAlive = keepAlive;
    record.lastHeartbeatAt = Date.now();
    await queuePersist();
    return record;
}
export async function scheduleWorkspaceDelete(id: string) {
    const registry = await readRegistry();
    const record = registry.records.find((item) => item.id === id);
    if (!record)
        return null;
    const now = Date.now();
    record.state = "scheduled-delete";
    record.retentionMode = "four-hours";
    record.expiresAt = now + SCHEDULED_DELETE_HOURS * 60 * 60 * 1000;
    record.deleteUndoUntil = record.expiresAt;
    await queuePersist();
    return record;
}
export async function cancelWorkspaceDelete(id: string) {
    const registry = await readRegistry();
    const record = registry.records.find((item) => item.id === id);
    if (!record)
        return null;
    const now = Date.now();
    record.state = "active";
    record.retentionMode = "three-days";
    record.deleteUndoUntil = null;
    record.lastHeartbeatAt = now;
    record.expiresAt = now + RETAINED_WORKSPACE_HOURS * 60 * 60 * 1000;
    await queuePersist();
    return record;
}
export async function incrementWorkspaceRevision(id: string) {
    const registry = await readRegistry();
    const record = registry.records.find((item) => item.id === id);
    if (!record)
        return null;
    record.revision += 1;
    await queuePersist();
    return record;
}
export async function markWorkspaceDeleted(id: string) {
    const registry = await readRegistry();
    const record = registry.records.find((item) => item.id === id);
    if (!record)
        return null;
    record.state = "deleted";
    record.deleteUndoUntil = null;
    await queuePersist();
    return record;
}
export async function listExpiredWorkspaceRecords(now = Date.now()) {
    return (await readRegistry()).records.filter((record) => record.state !== "deleted" && record.expiresAt <= now);
}
export async function listScheduledWorkspaceRecords() {
    return (await readRegistry()).records.filter((record) => record.state === "scheduled-delete");
}
export async function listWorkspaceRecords() {
    return [...(await readRegistry()).records];
}

export async function resetWorkspaceRegistryForTest() {
    writeQueue = writeQueue.then(async () => {
        registryCache = defaultRegistry();
        await rm(WORKSPACE_METADATA_PATH, { force: true });
    });
    return writeQueue;
}
