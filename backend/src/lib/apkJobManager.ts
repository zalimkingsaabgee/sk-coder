import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chown, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, normalize, relative, resolve } from "node:path";
import { APK_JOB_EXPANSION_MULTIPLIER, APK_JOB_MAX_COUNT, APK_JOB_MEMORY_MB, APK_JOB_MIN_RESERVATION_BYTES, APK_JOB_TIMEOUT_MS, APK_JOB_TTL_MS, APK_RUNTIME_IMAGE, BACKEND_INSTANCE_ID, STAGING_MAX_BYTES, WORKSPACE_ROOT } from "./backendConfig.js";
import { authorizeTerminalSession, ensureDockerReady, getWorkspaceSession } from "./sessionManager.js";
import { beginRuntimeOperationFinalization, completeRuntimeOperationFinalization, createRuntimeOperation, failRuntimeOperationFinalization } from "./operationRegistry.js";

type ApkJobMode = "inspect" | "resources" | "full";
type ApkJobStatus = "queued" | "running" | "complete" | "failed" | "expired";

type ApkJob = {
    id: string;
    deviceId: string;
    workspaceSessionId: string;
    sourcePath: string;
    mode: ApkJobMode;
    status: ApkJobStatus;
    createdAt: number;
    expiresAt: number;
    jobPath: string;
    log: string;
    outputPath: string | null;
    error: string | null;
    artifactSigned: boolean;
};

type CommandOutput = {
    stdout: string;
    stderr: string;
    exitCode: number;
};

const MAX_DECODED_TEXT_BYTES = 1024 * 1024;

const jobs = new Map<string, ApkJob>();
let cleanupStarted = false;

function run(command: string, args: string[], timeout: number) {
    return new Promise<CommandOutput>((resolveResult) => {
        const child = spawn(command, args, { env: { ...process.env, NO_COLOR: "1" } });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 1000).unref();
        }, timeout);
        child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
        child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
        child.once("error", (error: Error) => {
            clearTimeout(timer);
            resolveResult({ stdout: "", stderr: error.message, exitCode: 127 });
        });
        child.once("close", (code: number | null) => {
            clearTimeout(timer);
            resolveResult({ stdout: stdout.slice(0, 262144), stderr: `${stderr}${timedOut ? "\nAPK job timed out." : ""}`.trim(), exitCode: code ?? 1 });
        });
    });
}

function safeRelativePath(value: string) {
    const path = normalize(value.trim().replace(/^\/+/, "") || ".");
    if (path === "." || path === ".." || path.startsWith("../") || path.startsWith("..\\")) throw new Error("An APK file inside the workspace is required.");
    return path.replaceAll("\\", "/");
}

function jobPathFor(id: string) {
    return resolve(WORKSPACE_ROOT, ".apk-jobs", id);
}

function containerNameFor(id: string) {
    return `skcoder-apk-${id.replaceAll("-", "")}`;
}

function publicJob(job: ApkJob) {
    return {
        id: job.id,
        workspaceSessionId: job.workspaceSessionId,
        sourcePath: job.sourcePath,
        mode: job.mode,
        status: job.status,
        createdAt: job.createdAt,
        expiresAt: job.expiresAt,
        log: job.log,
        error: job.error,
        artifactReady: Boolean(job.outputPath),
        artifactSigned: job.artifactSigned,
    };
}

async function activeJobCount() {
    const result = await run("docker", ["ps", "--filter", "label=skcoder.apk=true", "--filter", `label=skcoder.instance=${BACKEND_INSTANCE_ID}`, "-q"], 5000);
    return result.stdout.split("\n").filter(Boolean).length;
}

async function getOwnedJob(id: string, deviceId: string, workspaceAccess: string | null | undefined) {
    await removeExpiredApkJobs();
    const job = jobs.get(id);
    if (!job || job.deviceId !== deviceId || !(await authorizeTerminalSession(job.workspaceSessionId, workspaceAccess))) throw new Error("APK job not found or expired.");
    return job;
}

async function getOwnedDecodedJob(id: string, deviceId: string, workspaceAccess: string | null | undefined) {
    const job = await getOwnedJob(id, deviceId, workspaceAccess);
    if (job.mode === "inspect" || job.status !== "complete") throw new Error("Complete a resource or full decode before editing decoded files.");
    return job;
}

function decodedEntryPath(job: ApkJob, value: string) {
    const root = resolve(job.jobPath, "output", "decoded");
    const target = resolve(root, safeRelativePath(value));
    const relation = relative(root, target);
    if (!relation || relation.startsWith("..") || relation.includes("../")) throw new Error("A decoded file inside this APK workspace is required.");
    return target;
}

function isReadableText(value: Buffer) {
    return !value.subarray(0, Math.min(value.length, 8192)).includes(0);
}

function commandFor(mode: ApkJobMode) {
    if (mode === "inspect") return "unzip -l /job/input/source.apk > /job/output/archive-list.txt && unzip -t /job/input/source.apk";
    if (mode === "resources") return "apktool d -f -s -o /job/output/decoded /job/input/source.apk";
    return "apktool d -f -o /job/output/decoded /job/input/source.apk";
}

async function runDecode(job: ApkJob) {
    job.status = "running";
    job.log = "Starting isolated APK job...";
    const result = await run("docker", [
        "run", "--rm", "--name", containerNameFor(job.id), "--label", "skcoder.apk=true", "--label", `skcoder.apk-id=${job.id}`, "--label", `skcoder.instance=${BACKEND_INSTANCE_ID}`,
        "--network", "none", "--memory", `${APK_JOB_MEMORY_MB}m`, "--memory-swap", `${APK_JOB_MEMORY_MB}m`, "--cpus", "1", "--pids-limit", "192",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--user", "1000:1000",
        "-v", `${job.jobPath}:/job:rw`, "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m,mode=1777", APK_RUNTIME_IMAGE, "sh", "-lc", commandFor(job.mode),
    ], APK_JOB_TIMEOUT_MS);
    job.log = `${job.log}\n${result.stdout}\n${result.stderr}`.trim().slice(0, 262144);
    if (result.exitCode !== 0) {
        job.status = "failed";
        job.error = result.stderr || "The isolated APK job failed.";
        return;
    }
    if (job.mode === "inspect") {
        job.outputPath = resolve(job.jobPath, "output", "archive-list.txt");
    }
    else {
        job.outputPath = resolve(job.jobPath, "output", "decoded");
    }
    job.status = "complete";
}

export async function createApkJob(deviceId: string, workspaceAccess: string | null | undefined, input: { workspaceSessionId: string; sourcePath: string; mode: ApkJobMode }) {
    if (!(await ensureDockerReady())) throw new Error("APK decode requires the Docker backend, which is not available right now.");
    if (!(await authorizeTerminalSession(input.workspaceSessionId, workspaceAccess))) throw new Error("Workspace access is not valid for this browser session.");
    await removeExpiredApkJobs();
    if (await activeJobCount() >= APK_JOB_MAX_COUNT) throw new Error("The APK processing queue is full. Try again after the active job finishes.");
    const workspace = await getWorkspaceSession(input.workspaceSessionId);
    const sourcePath = safeRelativePath(input.sourcePath);
    const source = resolve(workspace.workspacePath, sourcePath);
    if (relative(workspace.workspacePath, source).startsWith("..")) throw new Error("APK file path escapes the workspace.");
    const sourceInfo = await stat(source);
    if (!sourceInfo.isFile()) throw new Error("The selected APK file is not available in the workspace.");
    const reservationBytes = Math.min(STAGING_MAX_BYTES, Math.max(APK_JOB_MIN_RESERVATION_BYTES, sourceInfo.size * APK_JOB_EXPANSION_MULTIPLIER));
    const id = randomUUID();
    const jobPath = jobPathFor(id);
    await mkdir(resolve(jobPath, "input"), { recursive: true, mode: 0o755 });
    await mkdir(resolve(jobPath, "output"), { recursive: true, mode: 0o755 });
    await chown(jobPath, 1000, 1000);
    await chown(resolve(jobPath, "input"), 1000, 1000);
    await chown(resolve(jobPath, "output"), 1000, 1000);
    await copyFile(source, resolve(jobPath, "input", "source.apk"));
    const job: ApkJob = { id, deviceId, workspaceSessionId: input.workspaceSessionId, sourcePath, mode: input.mode, status: "queued", createdAt: Date.now(), expiresAt: Date.now() + APK_JOB_TTL_MS, jobPath, log: "Queued isolated APK job.", outputPath: null, error: null, artifactSigned: false };
    await createRuntimeOperation({ id: `apk:${job.id}`, ownerId: job.id, kind: "apk", resources: [`path:${jobPath}`, `container:${containerNameFor(job.id)}`, `workspace:${job.workspaceSessionId}`], reservationBytes, expiresAt: job.expiresAt });
    jobs.set(id, job);
    startCleanup();
    void runDecode(job);
    return publicJob(job);
}

export async function buildApkJob(id: string, deviceId: string, workspaceAccess: string | null | undefined, outputName?: string, sign = false) {
    const job = await getOwnedJob(id, deviceId, workspaceAccess);
    if (job.status !== "complete" || job.mode === "inspect") throw new Error("Complete a resource or full decode before requesting a rebuild.");
    const decodedPath = resolve(job.jobPath, "output", "decoded");
    if (!(await stat(decodedPath)).isDirectory()) throw new Error("Decoded APK files are no longer available.");
    job.status = "running";
    job.error = null;
    const safeName = basename((outputName || "sk-coder-unsigned.apk").replace(/[^a-zA-Z0-9._-]/g, "_"));
    const outputFile = safeName.endsWith(".apk") ? safeName : `${safeName}.apk`;
    const output = resolve(job.jobPath, "output", outputFile);
    const aligned = resolve(job.jobPath, "output", `aligned-${outputFile}`);
    const signed = resolve(job.jobPath, "output", `signed-${outputFile}`);
    const signingPassword = randomBytes(24).toString("hex");
    const buildCommand = sign
        ? `apktool b /job/output/decoded -o /job/output/${basename(output)} && zipalign -f -p 4 /job/output/${basename(output)} /job/output/${basename(aligned)} && keytool -genkeypair -keystore /tmp/sk-coder-signing.jks -storepass ${signingPassword} -keypass ${signingPassword} -alias skcoder -keyalg RSA -keysize 2048 -validity 1 -dname 'CN=SK Coder Temporary Signing' && apksigner sign --ks /tmp/sk-coder-signing.jks --ks-key-alias skcoder --ks-pass pass:${signingPassword} --key-pass pass:${signingPassword} --out /job/output/${basename(signed)} /job/output/${basename(aligned)} && apksigner verify --verbose /job/output/${basename(signed)} && rm -f /tmp/sk-coder-signing.jks`
        : `apktool b /job/output/decoded -o /job/output/${basename(output)} && zipalign -f -p 4 /job/output/${basename(output)} /job/output/${basename(aligned)} && unzip -t /job/output/${basename(aligned)}`;
    const result = await run("docker", [
        "run", "--rm", "--name", containerNameFor(`${job.id}-build`), "--label", "skcoder.apk=true", "--label", `skcoder.apk-id=${job.id}`, "--label", `skcoder.instance=${BACKEND_INSTANCE_ID}`,
        "--network", "none", "--memory", `${APK_JOB_MEMORY_MB}m`, "--memory-swap", `${APK_JOB_MEMORY_MB}m`, "--cpus", "1", "--pids-limit", "192",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--user", "1000:1000",
        "-v", `${job.jobPath}:/job:rw`, "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m,mode=1777", APK_RUNTIME_IMAGE, "sh", "-lc", buildCommand,
    ], APK_JOB_TIMEOUT_MS);
    job.log = `${job.log}\n${result.stdout}\n${result.stderr}`.trim().slice(0, 262144);
    if (result.exitCode !== 0) {
        job.status = "failed";
        job.error = result.stderr || "The isolated APK rebuild failed.";
        return publicJob(job);
    }
    job.status = "complete";
    job.outputPath = sign ? signed : aligned;
    job.artifactSigned = sign;
    return publicJob(job);
}

export async function getApkJobStatus(id: string, deviceId: string, workspaceAccess: string | null | undefined) {
    return publicJob(await getOwnedJob(id, deviceId, workspaceAccess));
}

export async function getApkArtifact(id: string, deviceId: string, workspaceAccess: string | null | undefined) {
    const job = await getOwnedJob(id, deviceId, workspaceAccess);
    if (!job.outputPath) throw new Error("APK job output is not available.");
    const output = resolve(job.outputPath);
    if (!output.startsWith(`${job.jobPath}/`)) throw new Error("APK job output is invalid.");
    const info = await stat(output);
    if (!info.isFile()) throw new Error("This APK job output is a decoded workspace, not a downloadable artifact.");
    return { path: output, name: basename(output) };
}

export async function listDecodedEntries(id: string, deviceId: string, workspaceAccess: string | null | undefined) {
    const job = await getOwnedJob(id, deviceId, workspaceAccess);
    if (job.mode === "inspect" || job.status !== "complete") return [];
    const root = resolve(job.jobPath, "output", "decoded");
    const paths: string[] = [];
    async function collect(folder: string) {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
            const current = resolve(folder, entry.name);
            if (paths.length >= 10000) return;
            if (entry.isDirectory()) await collect(current);
            else paths.push(relative(root, current).replaceAll("\\", "/"));
        }
    }
    await collect(root);
    return paths.sort();
}

export async function readDecodedEntry(id: string, deviceId: string, workspaceAccess: string | null | undefined, entryPath: string) {
    const job = await getOwnedDecodedJob(id, deviceId, workspaceAccess);
    const target = decodedEntryPath(job, entryPath);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("The selected decoded entry is not a file.");
    if (info.size > MAX_DECODED_TEXT_BYTES) throw new Error("This decoded text file is too large to open in the editor.");
    const content = await readFile(target);
    if (!isReadableText(content)) throw new Error("This decoded entry is binary and cannot be edited as text.");
    return { path: entryPath, size: info.size, content: content.toString("utf8") };
}

export async function updateDecodedEntry(id: string, deviceId: string, workspaceAccess: string | null | undefined, entryPath: string, content: string) {
    if (Buffer.byteLength(content, "utf8") > MAX_DECODED_TEXT_BYTES) throw new Error("This decoded text edit is too large to save.");
    const job = await getOwnedDecodedJob(id, deviceId, workspaceAccess);
    const target = decodedEntryPath(job, entryPath);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("The selected decoded entry is not a file.");
    if (info.size > MAX_DECODED_TEXT_BYTES) throw new Error("This decoded text file is too large to edit.");
    const existing = await readFile(target);
    if (!isReadableText(existing)) throw new Error("This decoded entry is binary and cannot be edited as text.");
    await writeFile(target, content, "utf8");
    return { path: entryPath, size: Buffer.byteLength(content, "utf8") };
}

export async function removeExpiredApkJobs() {
    const now = Date.now();
    for (const job of [...jobs.values()]) {
        if (job.expiresAt > now) continue;
        jobs.delete(job.id);
        job.status = "expired";
        await beginRuntimeOperationFinalization(`apk:${job.id}`, job.id, "apk");
        try {
            await run("docker", ["rm", "-f", containerNameFor(job.id)], 10000);
            await run("docker", ["rm", "-f", containerNameFor(`${job.id}-build`)], 10000);
            await rm(job.jobPath, { recursive: true, force: true });
            await completeRuntimeOperationFinalization(`apk:${job.id}`, job.id, "apk");
        }
        catch (error) {
            await failRuntimeOperationFinalization(`apk:${job.id}`, job.id, error);
            throw error;
        }
    }
}

function startCleanup() {
    if (cleanupStarted) return;
    cleanupStarted = true;
    const timer = setInterval(() => void removeExpiredApkJobs(), 30000);
    timer.unref();
}
