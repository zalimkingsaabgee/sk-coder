import { spawn } from "node:child_process";
import Docker from "dockerode";
import { PassThrough, type Duplex } from "node:stream";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { appendLimitedOutput } from "./outputLimit.js";
import { BACKEND_INSTANCE_ID, COMMAND_TIMEOUT_MS, DEPENDENCY_INSTALL_NETWORK_MODE, DEPENDENCY_INSTALL_NETWORK_NAME, DEPENDENCY_INSTALL_PROXY_URL, DEPENDENCY_INSTALL_TIMEOUT_MS, HOST_LOAD_MAX, HOST_MEMORY_RESERVE_BYTES, OUTPUT_MAX_BYTES, PACKAGE_CACHE_MAX_BYTES, PACKAGE_CACHE_ROOT, RUNTIME_IMAGE, RUNNER_MAX_COUNT, RUNNER_QUEUE_MAX_COUNT, RUNNER_SCRATCH_MAX_BYTES, SESSION_IDLE_MINUTES, SESSION_MAX_BYTES, SESSION_MAX_COUNT, SESSION_TTL_HOURS, STAGING_MAX_BYTES, WORKSPACE_INITIAL_RESERVATION_BYTES, WORKSPACE_INSTALL_RESERVE_BYTES, WORKSPACE_MAX_BYTES, WORKSPACE_NETWORK_MODE, WORKSPACE_ROOT, WORKSPACE_SAFETY_RESERVE_BYTES } from "./backendConfig.js";
import { cancelWorkspaceDelete, createWorkspaceRecord, getWorkspaceRecord, incrementWorkspaceRevision, listExpiredWorkspaceRecords, listScheduledWorkspaceRecords, listWorkspaceRecords, markWorkspaceDeleted, scheduleWorkspaceDelete, setWorkspaceKeepAlive, setWorkspaceRetention, touchWorkspaceRecord, type RetentionMode, type WorkspaceRecord } from "./workspaceRegistry.js";
import { createTerminalAccessToken, hashTerminalAccessToken, matchesTerminalAccessToken } from "./terminalAccess.js";
import { beginRuntimeOperationFinalization, completeRuntimeOperationFinalization, createRuntimeOperation, failRuntimeOperationFinalization, listExpiredRuntimeOperations, updateRuntimeOperationExpiry } from "./operationRegistry.js";
import { reconcileSharedCapacity, reportSharedCapacityUsage } from "./capacityLedger.js";
import { getHostPressure } from "./operationalMetrics.js";
import { SerialTaskQueue } from "./serialTaskQueue.js";
export type CommandResult = {
    stdout: string;
    stderr: string;
    exitCode: number;
    executionTime: number;
};
export type WorkspaceSession = {
    id: string;
    containerName: string;
    workspacePath: string;
    terminalAccessToken?: string;
    createdAt: number;
    lastUsedAt: number;
    retentionMode: RetentionMode;
};
export type InteractiveTerminal = {
    write: (data: string) => void;
    resize: (cols: number, rows: number) => void;
    detach: () => void;
    kill: () => void;
};

export function durableTerminalSessionName(terminalId: string) {
    return `sk-${terminalId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 56) || "shell"}`;
}
export function workspaceVolumeName(workspaceId: string) {
    return `skcoder-workspace-${workspaceId.replace(/[^A-Za-z0-9]/g, "").slice(0, 64)}`;
}
export function shellQuote(value: string) {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}
export function terminalBootstrapCommand() {
    return "export PS1='\\$ '; export HISTFILE=/workspace/.skcoder-terminal-history; export HISTSIZE=1000; export HISTFILESIZE=1000; history -r; export PROMPT_COMMAND='history -a; printf \"__SK_CODER_CWD__%s\\n\" \"$PWD\"'; exec bash --noprofile --norc -i";
}
export function isTransientTerminalResizeError(error: unknown) {
    return /container not running|cannot resize a stopped container/i.test(error instanceof Error ? error.message : String(error));
}
export function onceTerminalClose(onClose: (code: number) => void) {
    let closed = false;
    return (code: number) => {
        if (closed)
            return;
        closed = true;
        onClose(code);
    };
}
export type RuntimeProbe = {
    name: string;
    label: string;
    available: boolean;
    output: string;
    exitCode: number;
};
export type WorkspaceFile = {
    path: string;
    content: string;
    encoding?: "utf8" | "base64";
};
export type WorkspaceStageFile = {
    path: string;
    size: number;
    sha256?: string;
    revision?: string;
};
export type WorkspaceManifestFile = {
    path: string;
    size: number;
    sha256: string;
};
type WorkspaceStage = {
    id: string;
    sessionId: string;
    rootPath: string;
    files: Map<string, WorkspaceStageFile>;
    completedOffsets: Map<string, Set<number>>;
    receivedBytes: number;
    deletedPaths: string[];
    baseRevision: number;
};
const STAGE_CHUNK_BYTES = 4 * 1024 * 1024;
const sessions = new Map<string, WorkspaceSession>();
const stages = new Map<string, WorkspaceStage>();
const activeInteractiveTerminals = new Map<string, number>();
let dockerReady: boolean | null = null;
let cleanupStarted = false;
let runtimeProbeCache: { expiresAt: number; probes: RuntimeProbe[] } | null = null;
let terminalToolProbeCache: { expiresAt: number; probes: RuntimeProbe[] } | null = null;
let workspaceLifecycleQueue = Promise.resolve();
const ephemeralRunnerQueue = new SerialTaskQueue(RUNNER_MAX_COUNT, RUNNER_QUEUE_MAX_COUNT);
const docker = new Docker({ socketPath: "/var/run/docker.sock" });
function run(command: string, args: string[], timeout = COMMAND_TIMEOUT_MS, stdin = ""): Promise<CommandResult> {
    return new Promise((resolveResult) => {
        const startedAt = Date.now();
        const proc = spawn(command, args, { env: { ...process.env, NO_COLOR: "1" } });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        proc.stdin.on("error", () => undefined);
        const timer = setTimeout(() => {
            timedOut = true;
            proc.kill("SIGTERM");
            setTimeout(() => proc.kill("SIGKILL"), 1000).unref();
        }, timeout);
        proc.stdout.on("data", (value: Buffer) => { stdout = appendLimitedOutput(stdout, value, OUTPUT_MAX_BYTES); });
        proc.stderr.on("data", (value: Buffer) => { stderr = appendLimitedOutput(stderr, value, OUTPUT_MAX_BYTES); });
        proc.stdin.end(stdin);
        proc.once("error", (error) => {
            clearTimeout(timer);
            resolveResult({ stdout: "", stderr: error.message, exitCode: 127, executionTime: Date.now() - startedAt });
        });
        proc.once("close", (code) => {
            clearTimeout(timer);
            resolveResult({ stdout, stderr: `${stderr}${timedOut ? "\nCommand timed out." : ""}`.trim(), exitCode: code ?? 1, executionTime: Date.now() - startedAt });
        });
    });
}
function safeRelativePath(pathname: string) {
    const value = normalize(pathname.trim().replace(/^\/+/, "") || ".");
    if (value === ".." || value.startsWith("..\\") || value.startsWith("../"))
        throw new Error("Workspace path escapes the session root.");
    return value;
}
function workspacePathFor(id: string) {
    return resolve(WORKSPACE_ROOT, id);
}
function workplaceOperationId(id: string) {
    return `workplace:${id}`;
}
function stageRootFor(sessionId: string, stageId: string) {
    return resolve(WORKSPACE_ROOT, ".staging", sessionId, stageId);
}
function containerNameFor(id: string) {
    return `skcoder-${id.replaceAll("-", "")}`;
}
function runnerPathFor(id: string) {
    return resolve(WORKSPACE_ROOT, ".runs", id);
}
function queueWorkspaceLifecycle<T>(work: () => Promise<T>) {
    const next = workspaceLifecycleQueue.then(work, work);
    workspaceLifecycleQueue = next.then(() => undefined, () => undefined);
    return next;
}
async function checkSize(pathname: string, limit: number, message: string) {
    const result = await run("du", ["-sb", pathname], 5000);
    const bytes = Number(result.stdout.split(/\s+/)[0]);
    if (Number.isFinite(bytes) && bytes >= limit)
        throw new Error(message);
}
async function measureDirectoryBytes(pathname: string) {
    const result = await run("du", ["-sb", pathname], 5000);
    const bytes = Number(result.stdout.split(/\s+/)[0]);
    return Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
}
async function reconcileWorkspaceCapacityUsage(id: string, additionalBytes = 0) {
    const actualBytes = await measureDirectoryBytes(workspacePathFor(id));
    const reservationBytes = Math.max(WORKSPACE_INITIAL_RESERVATION_BYTES, actualBytes + additionalBytes);
    if (reservationBytes > SESSION_MAX_BYTES)
        throw new Error("This server workspace reached its configured temporary storage limit. The browser project remains available locally.");
    await reconcileSharedCapacity(workplaceOperationId(id), id, reservationBytes, actualBytes);
}
async function reserveWorkspaceGrowth(id: string, incomingBytes: number) {
    if (!Number.isSafeInteger(incomingBytes) || incomingBytes < 0)
        throw new Error("Workspace growth must be an exact non-negative byte value.");
    await ensureCapacity(incomingBytes);
    await reconcileWorkspaceCapacityUsage(id, incomingBytes);
}
async function reportWorkspaceCapacityUsage(id: string) {
    await reconcileWorkspaceCapacityUsage(id);
}
async function pruneInstallerCacheIfNeeded() {
    let bytes = await measureDirectoryBytes(PACKAGE_CACHE_ROOT);
    if (bytes < PACKAGE_CACHE_MAX_BYTES)
        return;
    const targetBytes = Math.floor(PACKAGE_CACHE_MAX_BYTES * 0.8);
    const entries = await readdir(PACKAGE_CACHE_ROOT, { withFileTypes: true }).catch(() => []);
    const candidates = await Promise.all(entries.filter((entry) => entry.isDirectory() || entry.isFile()).map(async (entry) => {
        const path = resolve(PACKAGE_CACHE_ROOT, entry.name);
        const info = await stat(path).catch(() => null);
        return { path, modifiedAt: info?.mtimeMs ?? 0 };
    }));
    for (const candidate of candidates.sort((left, right) => left.modifiedAt - right.modifiedAt)) {
        if (bytes <= targetBytes) break;
        await rm(candidate.path, { recursive: true, force: true });
        bytes = await measureDirectoryBytes(PACKAGE_CACHE_ROOT);
    }
}
function stageRelativePath(pathname: string) {
    const requested = safeRelativePath(pathname);
    if (requested === ".")
        throw new Error("A staged file path is required.");
    return requested;
}
async function ensureWritableWorkspaceDirectory(rootPath: string, targetPath: string) {
    const directory = dirname(targetPath);
    const requested = relative(rootPath, directory);
    if (requested === ".." || requested.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
        throw new Error("Workspace path escapes the session root.");
    let current = rootPath;
    await mkdir(current, { recursive: true, mode: 0o755 });
    await chmod(current, 0o755);
    for (const part of requested.split(/[\\/]+/).filter(Boolean)) {
        current = join(current, part);
        await mkdir(current, { recursive: true, mode: 0o755 });
        await chmod(current, 0o755);
    }
}
async function writeLiveWorkspaceFile(session: WorkspaceSession, requested: string, content: Buffer) {
    const target = `/workspace/${requested.replaceAll("\\", "/")}`;
    const directory = dirname(target);
    const container = docker.getContainer(session.containerName);
    const prepare = await container.exec({
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        User: "0:0",
        WorkingDir: "/workspace",
        Cmd: ["bash", "-lc", `mkdir -p -- ${shellQuote(directory)} && chmod 777 -- ${shellQuote(directory)}`],
    });
    await prepare.start({ hijack: true, stdin: false });
    let prepared = await prepare.inspect();
    for (let attempt = 0; prepared.Running && attempt < 200; attempt += 1) {
        await new Promise((resolveResult) => setTimeout(resolveResult, 25));
        prepared = await prepare.inspect();
    }
    if (prepared.Running || prepared.ExitCode !== 0)
        throw new Error("The isolated workspace could not prepare the staged file path.");
    const exec = await container.exec({
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        User: "1000:1000",
        WorkingDir: "/workspace",
        Env: ["HOME=/workspace", "TERM=dumb"],
        Cmd: ["bash", "-lc", `cat > ${shellQuote(target)} && chmod 644 -- ${shellQuote(target)}`],
    });
    const stream = await exec.start({ hijack: true, stdin: true }) as Duplex;
    let streamError: Error | null = null;
    stream.once("error", (error) => { streamError = error instanceof Error ? error : new Error("The staged file stream failed."); });
    stream.end(content);
    let status = await exec.inspect();
    for (let attempt = 0; status.Running && attempt < 200; attempt += 1) {
        await new Promise((resolveResult) => setTimeout(resolveResult, 25));
        status = await exec.inspect();
    }
    if (streamError)
        throw streamError;
    if (status.Running) {
        stream.destroy();
        throw new Error("The isolated workspace did not finish receiving the staged file.");
    }
    if (status.ExitCode !== 0)
        throw new Error("The isolated workspace could not receive the staged file.");
}
async function removeLiveWorkspacePath(session: WorkspaceSession, requested: string) {
    const target = `/workspace/${requested.replaceAll("\\", "/")}`;
    const container = docker.getContainer(session.containerName);
    const exec = await container.exec({
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        User: "1000:1000",
        WorkingDir: "/workspace",
        Cmd: ["bash", "-lc", `rm -rf -- ${shellQuote(target)}`],
    });
    const stream = await exec.start({ hijack: true, stdin: false }) as Duplex;
    stream.resume();
    let status = await exec.inspect();
    for (let attempt = 0; status.Running && attempt < 200; attempt += 1) {
        await new Promise((resolveResult) => setTimeout(resolveResult, 25));
        status = await exec.inspect();
    }
    if (status.Running || status.ExitCode !== 0)
        throw new Error("The isolated workspace could not remove the staged path.");
}
function missingOffsets(file: WorkspaceStageFile, completed: Set<number>) {
    const offsets: number[] = [];
    for (let offset = 0; offset < file.size; offset += STAGE_CHUNK_BYTES)
        if (!completed.has(offset))
            offsets.push(offset);
    return offsets;
}
async function hashFile(pathname: string) {
    const hash = createHash("sha256");
    await new Promise<void>((resolveResult, reject) => {
        const stream = createReadStream(pathname);
        stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
        stream.once("error", reject);
        stream.once("end", resolveResult);
    });
    return hash.digest("hex");
}
async function collectWorkspaceManifest(root: string, current = root, entries: WorkspaceManifestFile[] = []): Promise<WorkspaceManifestFile[]> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
        const target = resolve(current, entry.name);
        const relation = relative(root, target);
        if (!relation || relation.startsWith("..") || entry.isSymbolicLink())
            continue;
        if (entry.isDirectory()) {
            await collectWorkspaceManifest(root, target, entries);
            continue;
        }
        if (entry.isFile()) {
            const info = await stat(target);
            entries.push({ path: relation.replaceAll("\\", "/"), size: info.size, sha256: await hashFile(target) });
        }
    }
    return entries;
}
async function ensureCapacity(incomingBytes = 0) {
    const pressure = await getHostPressure();
    if (pressure.disk.freeBytes > 0 && pressure.disk.freeBytes - incomingBytes < WORKSPACE_SAFETY_RESERVE_BYTES)
        throw new Error("Cloud runtime is preserving its safety reserve. Source files remain available in browser storage.");
    if (pressure.memory.availableBytes > 0 && pressure.memory.availableBytes < HOST_MEMORY_RESERVE_BYTES)
        throw new Error("Cloud runtime is preserving memory for active work. Source files remain available in browser storage while server work waits.");
    if (pressure.cpu.load1 > HOST_LOAD_MAX)
        throw new Error("Cloud runtime is completing active work before admitting more server tasks. Source files remain available in browser storage.");
}
async function activeRuntimeCount() {
    const result = await run("docker", ["ps", "--filter", "label=skcoder.workspace=true", "--filter", `label=skcoder.instance=${BACKEND_INSTANCE_ID}`, "-q"], 5000);
    if (result.exitCode !== 0)
        return sessions.size;
    return result.stdout.split("\n").filter(Boolean).length;
}
async function activeEphemeralRunnerCount() {
    const result = await run("docker", ["ps", "--filter", "label=skcoder.runner=true", "--filter", `label=skcoder.instance=${BACKEND_INSTANCE_ID}`, "-q"], 5000);
    if (result.exitCode !== 0)
        return RUNNER_MAX_COUNT;
    return result.stdout.split("\n").filter(Boolean).length;
}
async function runtimeIsActive(id: string) {
    const probe = await run("docker", ["inspect", "-f", "{{.State.Running}}", containerNameFor(id)], 5000);
    return probe.exitCode === 0 && probe.stdout.trim() === "true";
}
async function startWorkspaceRuntime(id: string, workspacePath: string) {
    await mkdir(workspacePath, { recursive: true, mode: 0o755 });
    await chmod(workspacePath, 0o755);
    const result = await run("docker", [
        "run", "-d", "--rm", "--name", containerNameFor(id), "--label", "skcoder.workspace=true", "--label", `skcoder.workspace-id=${id}`, "--label", `skcoder.instance=${BACKEND_INSTANCE_ID}`, "--network", WORKSPACE_NETWORK_MODE, "--memory", "768m", "--memory-swap", "768m", "--cpus", "1", "--pids-limit", "256",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000", "-v", `${workspacePath}:/workspace:rw`, "-w", "/workspace", "--tmpfs", "/tmp:rw,size=128m,mode=1777",
        RUNTIME_IMAGE, "sleep", "infinity",
    ], 30000);
    if (result.exitCode !== 0)
        throw new Error(result.stderr || "The isolated runtime could not start.");
}
async function suspendWorkspaceRuntime(id: string) {
    sessions.delete(id);
    for (const stage of stages.values())
        if (stage.sessionId === id)
            stages.delete(stage.id);
    await run("docker", ["rm", "-f", containerNameFor(id)], 10000);
}
async function suspendIdleWorkspaceRuntimes(now = Date.now()) {
    const cutoff = now - SESSION_IDLE_MINUTES * 60 * 1000;
    for (const record of await listWorkspaceRecords()) {
        if (record.state !== "active" || record.keepAlive || record.lastHeartbeatAt >= cutoff)
            continue;
        if ((activeInteractiveTerminals.get(record.id) ?? 0) > 0)
            continue;
        if (await runtimeIsActive(record.id))
            await suspendWorkspaceRuntime(record.id);
    }
}
async function resumeWorkspaceSession(record: WorkspaceRecord) {
    const workspacePath = workspacePathFor(record.id);
    if (!(await runtimeIsActive(record.id))) {
        await suspendIdleWorkspaceRuntimes();
        if (await activeRuntimeCount() >= SESSION_MAX_COUNT)
            throw new Error("All active runtime slots are busy. Keep the project in browser storage and retry when a running terminal becomes idle.");
        await ensureCapacity();
        await startWorkspaceRuntime(record.id, workspacePath);
        await createRuntimeOperation({ id: `terminal:${record.id}`, ownerId: record.id, kind: "terminal", resources: [`container:${containerNameFor(record.id)}`], reservationBytes: 0, expiresAt: record.expiresAt });
    }
    const session: WorkspaceSession = { id: record.id, containerName: containerNameFor(record.id), workspacePath, createdAt: record.createdAt, lastUsedAt: Date.now(), retentionMode: record.retentionMode };
    sessions.set(record.id, session);
    return session;
}
export async function ensureDockerReady() {
    if (dockerReady !== null)
        return dockerReady;
    const result = await run("docker", ["version", "--format", "{{.Server.Version}}"], 5000);
    dockerReady = result.exitCode === 0 && Boolean(result.stdout.trim());
    return dockerReady;
}
export async function createWorkspaceSession(options?: {
    retentionMode?: RetentionMode;
    startRuntime?: boolean;
    keepAlive?: boolean;
}) {
    return queueWorkspaceLifecycle(async () => {
        const startRuntime = options?.startRuntime !== false;
        if (startRuntime && !(await ensureDockerReady()))
            throw new Error("The isolated runtime service is not available.");
        await removeExpiredWorkspaceSessions();
        await suspendScheduledWorkspaceRuntimes();
        await suspendIdleWorkspaceRuntimes();
        if (startRuntime && await activeRuntimeCount() >= SESSION_MAX_COUNT)
            throw new Error("All active runtime slots are busy. Keep the project in browser storage and retry when a running terminal becomes idle.");
        await mkdir(WORKSPACE_ROOT, { recursive: true, mode: 0o700 });
        await ensureCapacity();
        const id = randomUUID();
        const terminalAccessToken = createTerminalAccessToken();
        const workspacePath = workspacePathFor(id);
        const retentionMode = options?.retentionMode === "four-hours" ? "four-hours" : "three-days";
        try {
            const record = await createWorkspaceRecord(id, SESSION_MAX_BYTES, retentionMode, hashTerminalAccessToken(terminalAccessToken), options?.keepAlive === true);
await mkdir(workspacePath, { recursive: true, mode: 0o755 });
    await chmod(workspacePath, 0o755);
            await createRuntimeOperation({ id: workplaceOperationId(id), ownerId: id, kind: "workplace", resources: [`path:${workspacePath}`], reservationBytes: WORKSPACE_INITIAL_RESERVATION_BYTES, expiresAt: record.expiresAt });
            if (startRuntime) {
                await startWorkspaceRuntime(id, workspacePath);
                await createRuntimeOperation({ id: `terminal:${id}`, ownerId: id, kind: "terminal", resources: [`container:${containerNameFor(id)}`], reservationBytes: 0, expiresAt: record.expiresAt });
            }
        }
        catch (error) {
            await suspendWorkspaceRuntime(id);
            await rm(workspacePath, { recursive: true, force: true });
            await beginRuntimeOperationFinalization(`terminal:${id}`, id, "terminal");
            await completeRuntimeOperationFinalization(`terminal:${id}`, id, "terminal");
            await beginRuntimeOperationFinalization(workplaceOperationId(id), id, "workplace");
            await completeRuntimeOperationFinalization(workplaceOperationId(id), id, "workplace");
            await markWorkspaceDeleted(id);
            throw error;
        }
        const session: WorkspaceSession = { id, containerName: containerNameFor(id), workspacePath, terminalAccessToken, createdAt: Date.now(), lastUsedAt: Date.now(), retentionMode };
        sessions.set(id, session);
        startCleanup();
        return session;
    });
}
export async function authorizeTerminalSession(id: string, token: string | null | undefined) {
    const record = await getWorkspaceRecord(id);
    return Boolean(record && record.state === "active" && matchesTerminalAccessToken(token, record.terminalAccessHash));
}
export async function getWorkspaceSession(id: string) {
    let session = sessions.get(id);
    if (!session || !(await runtimeIsActive(id))) {
        sessions.delete(id);
        session = await queueWorkspaceLifecycle(async () => {
            const record = await getWorkspaceRecord(id);
            if (!record || record.state === "deleted" || record.state === "scheduled-delete")
                throw new Error("Workspace session not found or expired.");
            const existing = sessions.get(id);
            if (existing && await runtimeIsActive(id))
                return existing;
            return resumeWorkspaceSession(record);
        });
    }
    session.lastUsedAt = Date.now();
    await touchWorkspaceRecord(id);
    return session;
}
export async function getWorkspaceManifest(id: string) {
    const lifecycle = await getWorkspaceLifecycle(id);
    if (lifecycle.state !== "active")
        throw new Error("Workspace session not found or expired.");
    return { revision: lifecycle.revision, files: await collectWorkspaceManifest(workspacePathFor(id)) };
}

export async function syncWorkspaceFiles(id: string, files: WorkspaceFile[]) {
    const session = await getWorkspaceSession(id);
    for (const file of files) {
        if (typeof file.path !== "string" || typeof file.content !== "string")
            throw new Error("Invalid workspace file payload.");
        if (file.encoding && file.encoding !== "utf8" && file.encoding !== "base64")
            throw new Error("Unsupported workspace file encoding.");
        const requested = safeRelativePath(file.path);
        if (requested === ".")
            throw new Error("A workspace file path is required.");
        const content = file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
        await reserveWorkspaceGrowth(id, content.length);
        await writeLiveWorkspaceFile(session, requested, content);
    }
    await ensureCapacity();
    await incrementWorkspaceRevision(id);
    await reportWorkspaceCapacityUsage(id);
}
function describeWorkspaceStage(stage: WorkspaceStage) {
    return {
        stageId: stage.id,
        chunkBytes: STAGE_CHUNK_BYTES,
        files: [...stage.files.values()].map((file) => ({
            path: file.path,
            size: file.size,
            missingOffsets: missingOffsets(file, stage.completedOffsets.get(file.path) ?? new Set<number>()),
        })),
    };
}
async function requireWorkspaceStage(sessionId: string, stageId: string) {
    const record = await getWorkspaceLifecycle(sessionId);
    if (record.state !== "active")
        throw new Error("Workspace session not found or expired.");
    const stage = stages.get(stageId);
    if (!stage || stage.sessionId !== sessionId)
        throw new Error("Staging session not found or expired.");
    return stage;
}
export async function beginWorkspaceStage(sessionId: string, requestedFiles: WorkspaceStageFile[], existingStageId?: string, options?: { baseRevision?: number; deletedPaths?: string[] }) {
    const record = await getWorkspaceLifecycle(sessionId);
    if (record.state !== "active")
        throw new Error("Workspace session not found or expired.");
    if (existingStageId) {
        const existing = await requireWorkspaceStage(sessionId, existingStageId);
        return describeWorkspaceStage(existing);
    }
    if (!Array.isArray(requestedFiles))
        throw new Error("A staging manifest is required.");
    const lifecycle = await getWorkspaceLifecycle(sessionId);
    if (options?.baseRevision !== undefined && options.baseRevision !== lifecycle.revision)
        throw new Error("Workspace changed on the server. Refresh the manifest and review the changed files before retrying.");
    const files = new Map<string, WorkspaceStageFile>();
    for (const item of requestedFiles) {
        const path = stageRelativePath(item.path);
        if (!Number.isSafeInteger(item.size) || item.size < 0 || (item.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(item.sha256)))
            throw new Error("A staged file requires a valid size and optional SHA-256 checksum.");
        if (files.has(path))
            throw new Error("The staging manifest contains duplicate file paths.");
        files.set(path, { path, size: item.size, sha256: item.sha256?.toLowerCase(), revision: item.revision });
    }
    const deletedPaths = [...new Set((options?.deletedPaths ?? []).map(stageRelativePath))].filter((path) => !files.has(path));
    const totalBytes = [...files.values()].reduce((total, file) => total + file.size, 0);
    if (totalBytes > STAGING_MAX_BYTES)
        throw new Error("This server staging request exceeds the current temporary staging capacity. The browser project remains available locally.");
    const id = randomUUID();
    const stage: WorkspaceStage = {
        id,
        sessionId,
        rootPath: stageRootFor(sessionId, id),
        files,
        completedOffsets: new Map([...files.keys()].map((path) => [path, new Set<number>()])),
        receivedBytes: 0,
        deletedPaths,
        baseRevision: lifecycle.revision,
    };
    await createRuntimeOperation({ id: `staging:${id}`, ownerId: sessionId, kind: "staging", resources: [`path:${stage.rootPath}`], reservationBytes: Math.max(1, totalBytes), expiresAt: Date.now() + 30 * 60 * 1000 });
    try {
        await mkdir(stage.rootPath, { recursive: true, mode: 0o700 });
    }
    catch (error) {
        await beginRuntimeOperationFinalization(`staging:${id}`, sessionId, "staging");
        await failRuntimeOperationFinalization(`staging:${id}`, sessionId, error);
        throw error;
    }
    stages.set(id, stage);
    return describeWorkspaceStage(stage);
}
export async function getWorkspaceStageStatus(sessionId: string, stageId: string) {
    return describeWorkspaceStage(await requireWorkspaceStage(sessionId, stageId));
}
export async function writeWorkspaceStageChunk(sessionId: string, stageId: string, filePath: string, offset: number, data: Buffer, checksum?: string) {
    const stage = await requireWorkspaceStage(sessionId, stageId);
    const path = stageRelativePath(filePath);
    const file = stage.files.get(path);
    if (!file)
        throw new Error("Chunk path is not part of the staging manifest.");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset % STAGE_CHUNK_BYTES !== 0)
        throw new Error("Chunk offset is invalid.");
    const expectedLength = Math.min(STAGE_CHUNK_BYTES, file.size - offset);
    if (expectedLength < 0 || data.length !== expectedLength)
        throw new Error("Chunk length does not match the manifest.");
    const receivedHash = createHash("sha256").update(data).digest("hex");
    if (checksum && checksum.toLowerCase() !== receivedHash)
        throw new Error("Chunk checksum verification failed.");
    await ensureCapacity(data.length);
    const target = resolve(stage.rootPath, path);
    if (relative(stage.rootPath, target).startsWith(".."))
        throw new Error("Staging path escapes the session root.");
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    let handle;
    try {
        handle = await open(target, "r+");
    }
    catch {
        handle = await open(target, "w+");
    }
    try {
        await handle.write(data, 0, data.length, offset);
    }
    finally {
        await handle.close();
    }
    const completedOffsets = stage.completedOffsets.get(path);
    if (!completedOffsets?.has(offset)) {
        completedOffsets?.add(offset);
        stage.receivedBytes += data.length;
    }
    await reportSharedCapacityUsage(`staging:${stage.id}`, sessionId, stage.receivedBytes);
    await ensureCapacity();
    return { path, offset, receivedBytes: data.length, checksum: receivedHash };
}
export async function commitWorkspaceStage(sessionId: string, stageId: string) {
    const stage = await requireWorkspaceStage(sessionId, stageId);
    const lifecycle = await getWorkspaceLifecycle(sessionId);
    if (lifecycle.revision !== stage.baseRevision)
        throw new Error("Workspace changed on the server during staging. Refresh the manifest and resolve the conflict before committing.");
    await reserveWorkspaceGrowth(sessionId, [...stage.files.values()].reduce((total, file) => total + file.size, 0));
    for (const file of stage.files.values()) {
        const completed = stage.completedOffsets.get(file.path) ?? new Set<number>();
        if (missingOffsets(file, completed).length > 0)
            throw new Error(`Staging file is incomplete: ${file.path}`);
        const staged = resolve(stage.rootPath, file.path);
        if (file.size === 0) {
            await mkdir(dirname(staged), { recursive: true, mode: 0o700 });
            await writeFile(staged, "");
        }
        if ((await stat(staged)).size !== file.size || (file.sha256 !== undefined && (await hashFile(staged)) !== file.sha256))
            throw new Error(`Staging verification failed: ${file.path}`);
    }
    for (const file of stage.files.values()) {
        const staged = resolve(stage.rootPath, file.path);
        const target = resolve(workspacePathFor(sessionId), file.path);
        if (relative(workspacePathFor(sessionId), target).startsWith(".."))
            throw new Error("Staging path escapes the session root.");
        await ensureWritableWorkspaceDirectory(workspacePathFor(sessionId), target);
        await chmod(staged, 0o644);
        await rename(staged, target);
    }
    for (const path of stage.deletedPaths) {
        const target = resolve(workspacePathFor(sessionId), path);
        if (relative(workspacePathFor(sessionId), target).startsWith(".."))
            throw new Error("Staging path escapes the session root.");
        await rm(target, { recursive: true, force: true });
    }
    await beginRuntimeOperationFinalization(`staging:${stage.id}`, sessionId, "staging");
    try {
        stages.delete(stage.id);
        await rm(stage.rootPath, { recursive: true, force: true });
        await completeRuntimeOperationFinalization(`staging:${stage.id}`, sessionId, "staging");
    }
    catch (error) {
        await failRuntimeOperationFinalization(`staging:${stage.id}`, sessionId, error);
        throw error;
    }
    await ensureCapacity();
    await incrementWorkspaceRevision(sessionId);
    await reportWorkspaceCapacityUsage(sessionId);
    return { revision: (await getWorkspaceLifecycle(sessionId)).revision };
}
export async function removeWorkspaceStage(sessionId: string, stageId: string) {
    const stage = await requireWorkspaceStage(sessionId, stageId);
    await beginRuntimeOperationFinalization(`staging:${stage.id}`, sessionId, "staging");
    try {
        stages.delete(stage.id);
        await rm(stage.rootPath, { recursive: true, force: true });
        await completeRuntimeOperationFinalization(`staging:${stage.id}`, sessionId, "staging");
    }
    catch (error) {
        await failRuntimeOperationFinalization(`staging:${stage.id}`, sessionId, error);
        throw error;
    }
}
export async function runWorkspaceCommand(id: string, command: string, cwd = "/", stdin = "") {
    const session = await getWorkspaceSession(id);
    const requested = safeRelativePath(cwd);
    const workspaceCwd = requested === "." ? "/workspace" : `/workspace/${requested.replaceAll("\\", "/")}`;
    const result = await run("docker", ["exec", "-i", "--user", "1000:1000", "-e", "HOME=/workspace", "-w", workspaceCwd, session.containerName, "bash", "-lc", command], COMMAND_TIMEOUT_MS, stdin);
    await ensureCapacity();
    await checkSize(session.workspacePath, SESSION_MAX_BYTES, "The workspace reached its storage limit while running this command.");
    await incrementWorkspaceRevision(id);
    await reportWorkspaceCapacityUsage(id);
    return result;
}

export type DependencyManager = "npm" | "pnpm" | "yarn";
export type DependencyInstallMode = "install" | "ci";

export function dependencyInstallArgs(manager: DependencyManager, mode: DependencyInstallMode, packages: string[] = []) {
    if (manager === "npm") {
        return [mode === "ci" ? "ci" : "install", ...packages, "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/", "--userconfig=/dev/null"];
    }
    if (manager === "pnpm") {
        return [packages.length ? "add" : "install", ...packages, "--ignore-scripts", "--registry=https://registry.npmjs.org/", ...(mode === "ci" ? ["--frozen-lockfile"] : [])];
    }
    return [packages.length ? "add" : "install", ...packages, "--ignore-scripts", "--registry=https://registry.npmjs.org/", ...(mode === "ci" ? ["--immutable"] : [])];
}

export async function installWorkspaceDependencies(id: string, manager: DependencyManager, mode: DependencyInstallMode, cwd = "/", packages: string[] = []): Promise<CommandResult> {
    if (DEPENDENCY_INSTALL_NETWORK_MODE !== "bridge") {
        throw new Error("Dependency installation is disabled until the server enables the separate installer network. The live terminal remains safely offline.");
    }
    if (!/^https?:\/\/[^\s/]+/i.test(DEPENDENCY_INSTALL_PROXY_URL)) {
        throw new Error("Dependency installation requires a configured registry egress proxy. The live terminal remains safely offline.");
    }
    if (packages.length > 32 || packages.some((entry) => !/^(?:@[-a-z0-9_.]+\/)?[a-z0-9][a-z0-9_.-]*(?:@[-a-z0-9_.+*~^<>=|]+)?$/i.test(entry))) {
        throw new Error("Only up to 32 registry package names with optional versions are accepted for isolated installation.");
    }
    if (mode === "ci" && packages.length > 0) {
        throw new Error("A clean lockfile install cannot add package names. Use install instead.");
    }
    const session = await getWorkspaceSession(id);
    await reserveWorkspaceGrowth(id, WORKSPACE_INSTALL_RESERVE_BYTES);
    const requested = safeRelativePath(cwd);
    const workspaceCwd = requested === "." ? "/workspace" : `/workspace/${requested.replaceAll("\\", "/")}`;
    await mkdir(PACKAGE_CACHE_ROOT, { recursive: true, mode: 0o755 });
    await chmod(PACKAGE_CACHE_ROOT, 0o755);
    const permissionResult = await run("docker", [
        "run", "--rm", "--network", "none", "--user", "0:0", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--volumes-from", session.containerName,
        RUNTIME_IMAGE, "bash", "-lc", `mkdir -p -- ${shellQuote(workspaceCwd)} && chmod 777 -- ${shellQuote(workspaceCwd)}`,
    ], 10000);
    if (permissionResult.exitCode !== 0)
        throw new Error("The isolated installer could not prepare the selected project directory.");
    const result = await run("docker", [
        "run", "--rm", "--network", DEPENDENCY_INSTALL_NETWORK_NAME, "--memory", "1024m", "--memory-swap", "1024m", "--cpus", "1", "--pids-limit", "256",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000", "-e", "HOME=/tmp", "-e", "npm_config_cache=/sk-coder-cache/npm", "-e", "npm_config_store_dir=/sk-coder-cache/pnpm", "-e", "YARN_CACHE_FOLDER=/sk-coder-cache/yarn", "-e", `HTTP_PROXY=${DEPENDENCY_INSTALL_PROXY_URL}`, "-e", `HTTPS_PROXY=${DEPENDENCY_INSTALL_PROXY_URL}`, "-e", `http_proxy=${DEPENDENCY_INSTALL_PROXY_URL}`, "-e", `https_proxy=${DEPENDENCY_INSTALL_PROXY_URL}`, "-e", `NO_PROXY=localhost,127.0.0.1,registry-proxy`, "--volumes-from", session.containerName, "-v", `${PACKAGE_CACHE_ROOT}:/sk-coder-cache:rw`, "-w", workspaceCwd, "--tmpfs", "/tmp:rw,size=256m,mode=1777",
        RUNTIME_IMAGE, manager, ...dependencyInstallArgs(manager, mode, packages),
    ], DEPENDENCY_INSTALL_TIMEOUT_MS);
    await ensureCapacity();
    await checkSize(session.workspacePath, SESSION_MAX_BYTES, "The workspace reached its storage limit while installing dependencies.");
    await pruneInstallerCacheIfNeeded();
    await incrementWorkspaceRevision(id);
    await reportWorkspaceCapacityUsage(id);
    return result;
}
export async function runCodeInWorkspace(id: string, language: string, code: string, stdin = "") {
    return ephemeralRunnerQueue.run(async () => {
    const session = await getWorkspaceSession(id);
    const runPath = `.skcoder-runs/${randomUUID()}`;
    const hostRunPath = resolve(session.workspacePath, runPath);
    const config: Record<string, {
        filename: string;
        command: string;
    }> = {
        python: { filename: "main.py", command: "python3 main.py" }, py: { filename: "main.py", command: "python3 main.py" },
        node: { filename: "main.js", command: "node main.js" }, nodejs: { filename: "main.js", command: "node main.js" }, javascript: { filename: "main.js", command: "node main.js" }, js: { filename: "main.js", command: "node main.js" }, mjs: { filename: "main.mjs", command: "node main.mjs" }, cjs: { filename: "main.cjs", command: "node main.cjs" },
        typescript: { filename: "main.tsx", command: "tsx main.tsx" }, ts: { filename: "main.tsx", command: "tsx main.tsx" }, tsx: { filename: "main.tsx", command: "tsx main.tsx" },
        bash: { filename: "main.sh", command: "bash main.sh" }, shell: { filename: "main.sh", command: "bash main.sh" },
        java: { filename: "Main.java", command: "javac Main.java && java Main" }, c: { filename: "main.c", command: "gcc main.c -O2 -o main && ./main" }, cpp: { filename: "main.cpp", command: "g++ main.cpp -O2 -o main && ./main" }, cxx: { filename: "main.cpp", command: "g++ main.cpp -O2 -o main && ./main" },
        csharp: { filename: "Program.cs", command: "rm -rf .skcoder-dotnet && dotnet new console --force --output .skcoder-dotnet >/dev/null && cp Program.cs .skcoder-dotnet/Program.cs && dotnet run --project .skcoder-dotnet" }, cs: { filename: "Program.cs", command: "rm -rf .skcoder-dotnet && dotnet new console --force --output .skcoder-dotnet >/dev/null && cp Program.cs .skcoder-dotnet/Program.cs && dotnet run --project .skcoder-dotnet" },
        cc: { filename: "main.cpp", command: "g++ main.cpp -O2 -o main && ./main" }, kotlin: { filename: "Main.kt", command: "kotlinc Main.kt -include-runtime -d main.jar && java -jar main.jar" }, kt: { filename: "Main.kt", command: "kotlinc Main.kt -include-runtime -d main.jar && java -jar main.jar" }, kts: { filename: "Main.kts", command: "kotlinc -script Main.kts" },
        rust: { filename: "main.rs", command: "rustc main.rs -O -o main && ./main" }, rs: { filename: "main.rs", command: "rustc main.rs -O -o main && ./main" }, go: { filename: "main.go", command: "mkdir -p .go-tmp && TMPDIR=$PWD/.go-tmp go run main.go" }, php: { filename: "main.php", command: "php main.php" }, ruby: { filename: "main.rb", command: "ruby main.rb" }, rb: { filename: "main.rb", command: "ruby main.rb" },
    };
    const selected = config[language.toLowerCase()];
    if (!selected)
        throw new Error(`Unsupported runtime: ${language}`);
    if (stdin.length > 65536)
        throw new Error("Program input exceeds the 64 KB source-run limit.");
    await reserveWorkspaceGrowth(id, Buffer.byteLength(code));
    await mkdir(hostRunPath, { recursive: true, mode: 0o755 });
    await writeFile(join(hostRunPath, selected.filename), code, "utf8");
    try {
        return await runWorkspaceCommand(id, selected.command, runPath, stdin);
    }
    finally {
        await rm(hostRunPath, { recursive: true, force: true });
        await reportWorkspaceCapacityUsage(id);
    }
    });
}
export function runEphemeralCode(language: string, code: string, stdin = "") {
    return ephemeralRunnerQueue.run(async () => {
    const profiles: Record<string, { filename: string; command: string }> = {
        python: { filename: "main.py", command: "python3 main.py" }, py: { filename: "main.py", command: "python3 main.py" },
        node: { filename: "main.js", command: "node main.js" }, nodejs: { filename: "main.js", command: "node main.js" }, javascript: { filename: "main.js", command: "node main.js" }, js: { filename: "main.js", command: "node main.js" }, mjs: { filename: "main.mjs", command: "node main.mjs" }, cjs: { filename: "main.cjs", command: "node main.cjs" },
        typescript: { filename: "main.tsx", command: "tsx main.tsx" }, ts: { filename: "main.tsx", command: "tsx main.tsx" }, tsx: { filename: "main.tsx", command: "tsx main.tsx" },
        bash: { filename: "main.sh", command: "bash main.sh" }, shell: { filename: "main.sh", command: "bash main.sh" },
        java: { filename: "Main.java", command: "javac Main.java && java Main" }, c: { filename: "main.c", command: "gcc main.c -O2 -o main && ./main" }, cpp: { filename: "main.cpp", command: "g++ main.cpp -O2 -o main && ./main" }, cc: { filename: "main.cpp", command: "g++ main.cpp -O2 -o main && ./main" }, cxx: { filename: "main.cpp", command: "g++ main.cpp -O2 -o main && ./main" },
        csharp: { filename: "Program.cs", command: "dotnet new console --force --output app >/dev/null && cp Program.cs app/Program.cs && dotnet run --project app" }, cs: { filename: "Program.cs", command: "dotnet new console --force --output app >/dev/null && cp Program.cs app/Program.cs && dotnet run --project app" },
        kotlin: { filename: "Main.kt", command: "kotlinc Main.kt -include-runtime -d main.jar && java -jar main.jar" }, kt: { filename: "Main.kt", command: "kotlinc Main.kt -include-runtime -d main.jar && java -jar main.jar" }, kts: { filename: "Main.kts", command: "kotlinc -script Main.kts" },
        rust: { filename: "main.rs", command: "rustc main.rs -O -o main && ./main" }, rs: { filename: "main.rs", command: "rustc main.rs -O -o main && ./main" }, go: { filename: "main.go", command: "mkdir -p .go-tmp && TMPDIR=$PWD/.go-tmp go run main.go" }, php: { filename: "main.php", command: "php main.php" }, ruby: { filename: "main.rb", command: "ruby main.rb" }, rb: { filename: "main.rb", command: "ruby main.rb" },
    };
    const profile = profiles[language.toLowerCase()];
    if (!profile)
        throw new Error(`Unsupported runtime: ${language}`);
    if (Buffer.byteLength(code) > RUNNER_SCRATCH_MAX_BYTES || Buffer.byteLength(stdin) > 65536)
        throw new Error("Runner input exceeds the isolated execution limit.");
    if (!(await ensureDockerReady()))
        throw new Error("The isolated runtime service is not available.");
    await ensureCapacity(Buffer.byteLength(code));
    const id = randomUUID();
    const root = runnerPathFor(id);
    const containerName = `skcoder-runner-${id.replaceAll("-", "")}`;
    try {
        await mkdir(root, { recursive: true, mode: 0o755 });
        await chmod(root, 0o755);
        await writeFile(join(root, profile.filename), code, "utf8");
        await createRuntimeOperation({ id: `runner:${id}`, ownerId: id, kind: "runner", resources: [`container:${containerName}`, `path:${root}`], expiresAt: Date.now() + COMMAND_TIMEOUT_MS + 60_000 });
        return await run("docker", [
            "run", "--rm", "--name", containerName, "--label", "skcoder.runner=true", "--label", `skcoder.instance=${BACKEND_INSTANCE_ID}`, "--network", "none", "--memory", "768m", "--memory-swap", "768m", "--cpus", "1", "--pids-limit", "256",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000", "-v", `${root}:/run:rw`, "-w", "/run", "--tmpfs", "/tmp:rw,size=128m,mode=1777",
            RUNTIME_IMAGE, "bash", "-lc", profile.command,
        ], COMMAND_TIMEOUT_MS, stdin);
    }
    finally {
        await beginRuntimeOperationFinalization(`runner:${id}`, id, "runner");
        try {
            await run("docker", ["rm", "-f", containerName], 10000);
            await rm(root, { recursive: true, force: true });
            await completeRuntimeOperationFinalization(`runner:${id}`, id, "runner");
        }
        catch (error) {
            await failRuntimeOperationFinalization(`runner:${id}`, id, error);
            throw error;
        }
    }
    });
}
export async function openInteractiveTerminal(id: string, onStdout: (value: string) => void, _onStderr: (value: string) => void, onClose: (code: number) => void, size?: { cols?: number; rows?: number }, terminalId = "shell"): Promise<InteractiveTerminal> {
    const session = await getWorkspaceSession(id);
    const cols = Math.min(240, Math.max(40, Math.floor(size?.cols ?? 100)));
    const rows = Math.min(120, Math.max(12, Math.floor(size?.rows ?? 30)));
    const tmuxSession = durableTerminalSessionName(terminalId);
    const promptBootstrap = terminalBootstrapCommand();
    const exec = await docker.getContainer(session.containerName).exec({
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        User: "1000:1000",
        WorkingDir: "/workspace",
        Env: ["HOME=/workspace", "TERM=xterm-256color"],
        Cmd: ["bash", "-lc", `if command -v tmux >/dev/null 2>&1; then tmux has-session -t ${tmuxSession} 2>/dev/null || tmux new-session -d -s ${tmuxSession} bash -lc ${shellQuote(promptBootstrap)}; tmux set-option -t ${tmuxSession} status off; exec tmux attach-session -d -t ${tmuxSession}; else ${promptBootstrap}; fi`],
    });
    const stream = await exec.start({ hijack: true, stdin: true }) as Duplex;
    const output = new PassThrough();
    docker.modem.demuxStream(stream, output, output);
    activeInteractiveTerminals.set(id, (activeInteractiveTerminals.get(id) ?? 0) + 1);
    const closeOnce = onceTerminalClose((code) => {
        const remaining = Math.max(0, (activeInteractiveTerminals.get(id) ?? 1) - 1);
        if (remaining === 0)
            activeInteractiveTerminals.delete(id);
        else
            activeInteractiveTerminals.set(id, remaining);
        onClose(code);
    });
    let initialized = false;
    let startupOutput = "";
    let resolveInitialized: (() => void) | null = null;
    let rejectInitialized: ((error: Error) => void) | null = null;
    const initializedSignal = new Promise<void>((resolveInitializedSignal, rejectInitializedSignal) => {
        resolveInitialized = resolveInitializedSignal;
        rejectInitialized = rejectInitializedSignal;
    });
    output.on("data", (value: Buffer) => {
        const data = value.toString();
        if (initialized) {
            onStdout(data);
            return;
        }
        startupOutput += data;
        const marker = /__SK_CODER_CWD__\/workspace(?:\/[^\r\n\x1b]*)?(?:\x1b\[[0-?]*[ -\/]*[@-~])*\r?\n/.exec(startupOutput);
        const promptSeen = /(?:^|\r?\n)[$#] $|bash-\d+\.\d+[$#]/m.test(startupOutput);
        if (!marker && !promptSeen)
            return;
        initialized = true;
        if (!marker) {
            onStdout(startupOutput);
            startupOutput = "";
            resolveInitialized?.();
            return;
        }
        const markerEnd = marker.index + marker[0].length;
        onStdout(marker[0]);
        const remainder = startupOutput.slice(markerEnd);
        startupOutput = "";
        if (remainder)
            onStdout(remainder);
        resolveInitialized?.();
    });
    stream.once("end", () => closeOnce(0));
    stream.once("close", () => closeOnce(0));
    stream.once("error", () => {
        rejectInitialized?.(new Error("Terminal transport closed before Bash initialized."));
        closeOnce(1);
    });
    let resizeError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await exec.resize({ h: rows, w: cols });
            resizeError = undefined;
            break;
        }
        catch (error) {
            resizeError = error;
            if (!isTransientTerminalResizeError(error) || attempt === 4)
                break;
            await new Promise((resolveResult) => setTimeout(resolveResult, 100));
        }
    }
    if (resizeError)
        throw resizeError;
    const initializedTimeout = setTimeout(() => rejectInitialized?.(new Error("Terminal prompt did not initialize.")), 5000);
    try {
        await initializedSignal;
    }
    catch (error) {
        closeOnce(1);
        stream.destroy();
        throw error;
    }
    finally {
        clearTimeout(initializedTimeout);
    }
    return {
        write: (data) => stream.write(data),
        resize: (nextCols, nextRows) => { void exec.resize({ h: Math.min(120, Math.max(12, Math.floor(nextRows))), w: Math.min(240, Math.max(40, Math.floor(nextCols))) }); },
        detach: () => stream.destroy(),
        kill: () => {
            stream.write("\u0002d");
            setTimeout(() => stream.destroy(), 25);
        },
    };
}
export function terminateInteractiveTerminal(proc: InteractiveTerminal) {
    proc.kill();
}
export const RUNTIME_PROBE_DEFINITIONS: Array<{ name: string; label: string; command: string }> = [
    { name: "node", label: "Node.js", command: "node -e \"console.log('node-ok')\"" },
    { name: "csharp", label: ".NET / C#", command: "rm -rf /tmp/sk-coder-dotnet && dotnet new console --force --output /tmp/sk-coder-dotnet >/dev/null && printf 'Console.WriteLine(\"csharp-ok\");\\n' >/tmp/sk-coder-dotnet/Program.cs && dotnet run --project /tmp/sk-coder-dotnet" },
    { name: "typescript", label: "TypeScript", command: "tsx -e \"const value: number = 1; console.log('typescript-ok', value)\"" },
    { name: "python", label: "Python with NumPy", command: "python3 -c \"import numpy; print('python-numpy-ok', numpy.__version__)\"" },
    { name: "c", label: "C", command: "printf 'int main(void){return 0;}\\n' >/tmp/main.c && gcc /tmp/main.c -o /tmp/main-c && /tmp/main-c" },
    { name: "cpp", label: "C++", command: "printf '#include <iostream>\\nint main(){std::cout << \\\"cpp-ok\\\\n\\\";}\\n' >/tmp/main.cpp && g++ /tmp/main.cpp -o /tmp/main-cpp && /tmp/main-cpp" },
    { name: "java", label: "Java", command: "printf 'class Main { public static void main(String[] args) { System.out.println(\\\"java-ok\\\"); } }\\n' >/tmp/Main.java && javac /tmp/Main.java && java -cp /tmp Main" },
    { name: "kotlin", label: "Kotlin script", command: "printf 'println(\\\"kotlin-ok\\\")\\n' >/tmp/main.kts && kotlinc -script /tmp/main.kts" },
    { name: "rust", label: "Rust", command: "printf 'fn main(){println!(\"rust-ok\");}\\n' >/tmp/main.rs && rustc /tmp/main.rs -o /tmp/main-rust && /tmp/main-rust" },
    { name: "go", label: "Go", command: "printf 'package main\\nimport \"fmt\"\\nfunc main(){fmt.Println(\"go-ok\")}\\n' >/tmp/main.go && go run /tmp/main.go" },
    { name: "php", label: "PHP", command: "php -r \"echo 'php-ok\\n';\"" },
    { name: "ruby", label: "Ruby", command: "ruby -e \"puts 'ruby-ok'\"" },
    { name: "bash", label: "Bash", command: "bash -lc \"printf 'bash-ok\\n'\"" },
];
export const TERMINAL_TOOL_PROBE_DEFINITIONS: Array<{ name: string; label: string }> = [
    { name: "bash", label: "Bash" },
    { name: "tmux", label: "tmux" },
    { name: "dotnet", label: ".NET SDK" },
    { name: "node", label: "Node.js" },
    { name: "npm", label: "npm" },
    { name: "npx", label: "npx" },
    { name: "pnpm", label: "pnpm" },
    { name: "yarn", label: "Yarn" },
    { name: "git", label: "Git" },
    { name: "python3", label: "Python" },
    { name: "pip3", label: "pip" },
    { name: "gcc", label: "GCC" },
    { name: "g++", label: "G++" },
    { name: "javac", label: "Java compiler" },
    { name: "kotlinc", label: "Kotlin compiler" },
    { name: "cargo", label: "Cargo" },
    { name: "go", label: "Go" },
    { name: "php", label: "PHP" },
    { name: "ruby", label: "Ruby" },
    { name: "mvn", label: "Maven" },
    { name: "gradle", label: "Gradle" },
    { name: "cmake", label: "CMake" },
    { name: "composer", label: "Composer" },
    { name: "bundle", label: "Bundler" },
];
export async function probeRuntimeImage(force = false): Promise<RuntimeProbe[]> {
    if (!force && runtimeProbeCache && runtimeProbeCache.expiresAt > Date.now())
        return runtimeProbeCache.probes;
    if (!(await ensureDockerReady())) {
        const probes = RUNTIME_PROBE_DEFINITIONS.map((definition) => ({ name: definition.name, label: definition.label, available: false, output: "The isolated runtime service is not available.", exitCode: 1 }));
        runtimeProbeCache = { probes, expiresAt: Date.now() + 5000 };
        return probes;
    }
    const probes: RuntimeProbe[] = [];
    for (const definition of RUNTIME_PROBE_DEFINITIONS) {
        const result = await run("docker", ["run", "--rm", "--network", "none", "--user", "1000:1000", "--tmpfs", "/tmp:rw,size=64m,mode=1777,exec", RUNTIME_IMAGE, "bash", "-lc", definition.command], 30000);
        probes.push({ name: definition.name, label: definition.label, available: result.exitCode === 0, output: `${result.stdout}${result.stderr}`.trim().slice(0, 1200), exitCode: result.exitCode });
    }
    runtimeProbeCache = { probes, expiresAt: Date.now() + 60_000 };
    return probes;
}
export async function probeTerminalTools(force = false): Promise<RuntimeProbe[]> {
    if (!force && terminalToolProbeCache && terminalToolProbeCache.expiresAt > Date.now())
        return terminalToolProbeCache.probes;
    if (!(await ensureDockerReady())) {
        const probes = TERMINAL_TOOL_PROBE_DEFINITIONS.map((definition) => ({ name: definition.name, label: definition.label, available: false, output: "The isolated runtime service is not available.", exitCode: 1 }));
        terminalToolProbeCache = { probes, expiresAt: Date.now() + 5000 };
        return probes;
    }
    const names = TERMINAL_TOOL_PROBE_DEFINITIONS.map((definition) => definition.name).join(" ");
    const command = `for tool in ${names}; do if command -v "$tool" >/dev/null 2>&1; then printf '%s|1|%s\\n' "$tool" "$(command -v "$tool")"; else printf '%s|0|missing\\n' "$tool"; fi; done`;
    const result = await run("docker", ["run", "--rm", "--network", "none", "--user", "1000:1000", "--tmpfs", "/tmp:rw,size=64m,mode=1777", RUNTIME_IMAGE, "bash", "-lc", command], 30000);
    const availability = new Map(result.stdout.split("\n").filter(Boolean).map((line) => {
        const [name, available, output] = line.split("|", 3);
        return [name, { available: available === "1", output: output || "missing" }];
    }));
    const probes = TERMINAL_TOOL_PROBE_DEFINITIONS.map((definition) => {
        const value = availability.get(definition.name);
        return { name: definition.name, label: definition.label, available: result.exitCode === 0 && value?.available === true, output: value?.output ?? (result.stderr.trim() || "missing"), exitCode: result.exitCode };
    });
    terminalToolProbeCache = { probes, expiresAt: Date.now() + 60_000 };
    return probes;
}
export async function workspaceStatus() {
    startCleanup();
    await removeExpiredWorkspaceSessions();
    await suspendScheduledWorkspaceRuntimes();
    const [disk, activeSessions] = await Promise.all([
        run("df", ["-B1", "--output=size,used,avail", WORKSPACE_ROOT], 5000),
        activeRuntimeCount(),
    ]);
    return {
        ready: await ensureDockerReady(),
        activeSessions,
        runnerQueue: ephemeralRunnerQueue.status(),
        image: RUNTIME_IMAGE,
        capacity: {
            workspaceMaxBytes: WORKSPACE_MAX_BYTES,
            sessionMaxBytes: SESSION_MAX_BYTES,
            safetyReserveBytes: WORKSPACE_SAFETY_RESERVE_BYTES,
            disk: disk.exitCode === 0 ? disk.stdout.trim().split("\n").at(-1) : null,
        },
    };
}
export async function getWorkspaceLifecycle(id: string) {
    const record = await getWorkspaceRecord(id);
    if (!record)
        throw new Error("Workspace session not found or expired.");
    return record;
}
export async function recordWorkspaceActivity(id: string) {
    const record = await touchWorkspaceRecord(id);
    if (!record)
        throw new Error("Workspace session not found or expired.");
    return record;
}
export async function updateWorkspaceRetention(id: string, retentionMode: RetentionMode) {
    const record = await setWorkspaceRetention(id, retentionMode);
    if (!record)
        throw new Error("Workspace session not found or expired.");
    await updateRuntimeOperationExpiry(`terminal:${id}`, id, record.expiresAt);
    await updateRuntimeOperationExpiry(workplaceOperationId(id), id, record.expiresAt);
    const session = sessions.get(id);
    if (session)
        session.retentionMode = retentionMode;
    return record;
}
export async function updateWorkspaceKeepAlive(id: string, keepAlive: boolean) {
    const record = await setWorkspaceKeepAlive(id, keepAlive);
    if (!record)
        throw new Error("Workspace session not found or expired.");
    return record;
}
export async function scheduleWorkspaceDeletion(id: string) {
    const record = await scheduleWorkspaceDelete(id);
    if (!record)
        throw new Error("Workspace session not found or expired.");
    await updateRuntimeOperationExpiry(`terminal:${id}`, id, record.expiresAt);
    await updateRuntimeOperationExpiry(workplaceOperationId(id), id, record.expiresAt);
    await suspendWorkspaceRuntime(id);
    return record;
}
export async function cancelWorkspaceDeletion(id: string) {
    const record = await cancelWorkspaceDelete(id);
    if (!record)
        throw new Error("Workspace session not found or expired.");
    await updateRuntimeOperationExpiry(`terminal:${id}`, id, record.expiresAt);
    await updateRuntimeOperationExpiry(workplaceOperationId(id), id, record.expiresAt);
    return record;
}
export async function destroyWorkspaceSession(id: string) {
    const session = sessions.get(id);
    const containerName = session?.containerName ?? containerNameFor(id);
    const workspacePath = session?.workspacePath ?? workspacePathFor(id);
    sessions.delete(id);
    for (const stage of stages.values())
        if (stage.sessionId === id)
            stages.delete(stage.id);
    await beginRuntimeOperationFinalization(`terminal:${id}`, id, "terminal");
    await beginRuntimeOperationFinalization(workplaceOperationId(id), id, "workplace");
    try {
        await run("docker", ["rm", "-f", containerName], 10000);
        await Promise.all([
            rm(workspacePath, { recursive: true, force: true }),
            rm(resolve(WORKSPACE_ROOT, ".staging", id), { recursive: true, force: true }),
        ]);
        await markWorkspaceDeleted(id);
        await completeRuntimeOperationFinalization(`terminal:${id}`, id, "terminal");
        await completeRuntimeOperationFinalization(workplaceOperationId(id), id, "workplace");
    }
    catch (error) {
        await failRuntimeOperationFinalization(`terminal:${id}`, id, error);
        await failRuntimeOperationFinalization(workplaceOperationId(id), id, error);
        throw error;
    }
}
async function removeExpiredWorkspaceSessions() {
    for (const record of await listExpiredWorkspaceRecords())
        await destroyWorkspaceSession(record.id);
}
async function suspendScheduledWorkspaceRuntimes() {
    for (const record of await listScheduledWorkspaceRecords()) {
        await suspendWorkspaceRuntime(record.id);
    }
}
function operationPathIsOwned(kind: string, pathname: string) {
    const roots: Record<string, string> = {
        staging: resolve(WORKSPACE_ROOT, ".staging"),
        runner: resolve(WORKSPACE_ROOT, ".runs"),
        apk: resolve(WORKSPACE_ROOT, ".apk-jobs"),
    };
    const root = roots[kind];
    if (!root)
        return false;
    const relation = relative(root, pathname);
    return Boolean(relation && relation !== ".." && !relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}
function operationContainerIsOwned(name: string) {
    return /^skcoder-(?:runner|gui|preview|apk)-[a-z0-9]+(?:-build)?$/.test(name);
}
async function recoverExpiredRuntimeOperations() {
    for (const operation of await listExpiredRuntimeOperations()) {
        const current = await beginRuntimeOperationFinalization(operation.id, operation.ownerId, operation.kind);
        if (!current)
            continue;
        try {
            for (const resource of current.resources) {
                if (resource.startsWith("container:")) {
                    const name = resource.slice("container:".length);
                    if (operationContainerIsOwned(name))
                        await run("docker", ["rm", "-f", name], 10000);
                }
                if (resource.startsWith("path:")) {
                    const pathname = resource.slice("path:".length);
                    if (operationPathIsOwned(current.kind, pathname))
                        await rm(pathname, { recursive: true, force: true });
                }
            }
            await completeRuntimeOperationFinalization(current.id, current.ownerId, current.kind);
        }
        catch (error) {
            await failRuntimeOperationFinalization(current.id, current.ownerId, error);
        }
    }
}
function startCleanup() {
    if (cleanupStarted)
        return;
    cleanupStarted = true;
    void removeExpiredWorkspaceSessions();
    void suspendScheduledWorkspaceRuntimes();
    void recoverExpiredRuntimeOperations();
    const timer = setInterval(async () => {
        await suspendIdleWorkspaceRuntimes();
        await removeExpiredWorkspaceSessions();
        await suspendScheduledWorkspaceRuntimes();
        await recoverExpiredRuntimeOperations();
    }, 5 * 60 * 1000);
    timer.unref();
}
