import express, { Router } from "express";
import { authorizeTerminalSession, beginWorkspaceStage, cancelWorkspaceDeletion, commitWorkspaceStage, createWorkspaceSession, getWorkspaceLifecycle, getWorkspaceManifest, getWorkspaceStageStatus, installWorkspaceDependencies, probeRuntimeImage, probeTerminalTools, recordWorkspaceActivity, removeWorkspaceStage, runCodeInWorkspace, runEphemeralCode, runWorkspaceCommand, scheduleWorkspaceDeletion, syncWorkspaceFiles, updateWorkspaceKeepAlive, updateWorkspaceRetention, workspaceStatus, writeWorkspaceStageChunk } from "../lib/sessionManager.js";
import type { RetentionMode } from "../lib/workspaceRegistry.js";
import { installedRuntimes } from "../lib/runtimeRegistry.js";
import { runtimeProfileCatalog } from "../lib/runtimeProfileResolver.js";
const router = Router();
router.param("id", async (req, res, next, id) => {
    try {
        if (await authorizeTerminalSession(id, req.header("x-sk-workspace-access"))) {
            next();
            return;
        }
        res.status(403).json({ error: "Workspace access is not valid for this browser session." });
    }
    catch {
        res.status(403).json({ error: "Workspace access is not valid for this browser session." });
    }
});
router.get("/execute/status", async (_req, res) => {
    res.json(await workspaceStatus());
});
router.get("/execute/runtimes", async (_req, res) => {
    const [status, probes] = await Promise.all([workspaceStatus(), probeRuntimeImage()]);
    const availability = new Map(probes.map((probe) => [probe.name, probe.available]));
    res.json({ runtimes: installedRuntimes.map((runtime) => ({ ...runtime, available: status.ready && availability.get(runtime.name) === true, tier: "oracle-workspace" })), profiles: runtimeProfileCatalog(), status });
});
router.get("/execute/runtimes/probe", async (req, res) => {
    const probes = await probeRuntimeImage(req.query.force === "true");
    res.json({ image: (await workspaceStatus()).image, probes });
});
router.get("/execute/shell-tools/probe", async (req, res) => {
    const probes = await probeTerminalTools(req.query.force === "true");
    res.json({ image: (await workspaceStatus()).image, probes });
});
router.post("/execute/sessions", async (req, res) => {
    try {
        const requestedRetention = req.body?.retentionMode;
        const retentionMode: RetentionMode = requestedRetention === "four-hours" ? "four-hours" : "three-days";
        const session = await createWorkspaceSession({ retentionMode, startRuntime: req.body?.startRuntime !== false, keepAlive: req.body?.keepAlive === true });
        const lifecycle = await getWorkspaceLifecycle(session.id);
        res.status(201).json({ id: session.id, terminalAccessToken: session.terminalAccessToken, cwd: "/", expiresAt: lifecycle.expiresAt, retentionMode: lifecycle.retentionMode, quotaBytes: lifecycle.quotaBytes, tier: "oracle-workspace" });
    }
    catch (error) {
        res.status(503).json({ error: error instanceof Error ? error.message : "Session service unavailable." });
    }
});
router.get("/execute/sessions/:id", async (req, res) => {
    try {
        res.json({ ...(await getWorkspaceLifecycle(req.params.id)), tier: "oracle-workspace" });
    }
    catch (error) {
        res.status(404).json({ error: error instanceof Error ? error.message : "Workspace session not found." });
    }
});
router.get("/execute/sessions/:id/manifest", async (req, res) => {
    try {
        res.json(await getWorkspaceManifest(req.params.id));
    }
    catch (error) {
        res.status(404).json({ error: error instanceof Error ? error.message : "Workspace session not found." });
    }
});
router.post("/execute/sessions/:id/heartbeat", async (req, res) => {
    try {
        const lifecycle = await recordWorkspaceActivity(req.params.id);
        res.json({ ...lifecycle, tier: "oracle-workspace" });
    }
    catch (error) {
        res.status(404).json({ error: error instanceof Error ? error.message : "Workspace session not found." });
    }
});
router.put("/execute/sessions/:id/retention", async (req, res) => {
    const requestedRetention = req.body?.retentionMode;
    if (requestedRetention !== undefined && requestedRetention !== "three-days" && requestedRetention !== "four-hours")
        return res.status(400).json({ error: "retentionMode must be three-days or four-hours" });
    try {
        const lifecycle = requestedRetention === undefined
            ? await updateWorkspaceKeepAlive(req.params.id, req.body?.keepAlive === true)
            : await updateWorkspaceRetention(req.params.id, requestedRetention);
        res.json({ ...lifecycle, tier: "oracle-workspace" });
    }
    catch (error) {
        res.status(404).json({ error: error instanceof Error ? error.message : "Workspace session not found." });
    }
});
router.post("/execute/sessions/:id/delete", async (req, res) => {
    try {
        res.json({ ...(await scheduleWorkspaceDeletion(req.params.id)), tier: "oracle-workspace" });
    }
    catch (error) {
        res.status(404).json({ error: error instanceof Error ? error.message : "Workspace session not found." });
    }
});
router.post("/execute/sessions/:id/cancel-delete", async (req, res) => {
    try {
        res.json({ ...(await cancelWorkspaceDeletion(req.params.id)), tier: "oracle-workspace" });
    }
    catch (error) {
        res.status(404).json({ error: error instanceof Error ? error.message : "Workspace session not found." });
    }
});
router.post("/execute/sessions/:id/files", async (req, res) => {
    const files = req.body?.files;
    if (!Array.isArray(files))
        return res.status(400).json({ error: "files must be an array" });
    try {
        await syncWorkspaceFiles(req.params.id, files.map((file: unknown) => {
            const item = file as {
                path?: unknown;
                content?: unknown;
                encoding?: unknown;
            };
            return { path: String(item.path ?? ""), content: String(item.content ?? ""), encoding: item.encoding === "base64" ? "base64" as const : "utf8" as const };
        }));
        res.status(204).end();
    }
    catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Workspace synchronization failed." });
    }
});
router.post("/execute/sessions/:id/stage/manifest", async (req, res) => {
    const files = req.body?.files;
    if (!Array.isArray(files))
        return res.status(400).json({ error: "files must be an array" });
    try {
        const baseRevision = Number(req.body?.baseRevision);
        const deletedPaths = Array.isArray(req.body?.deletedPaths) && req.body.deletedPaths.every((path: unknown) => typeof path === "string") ? req.body.deletedPaths as string[] : undefined;
        res.status(201).json(await beginWorkspaceStage(req.params.id, files, typeof req.body?.stageId === "string" ? req.body.stageId : undefined, { baseRevision: Number.isSafeInteger(baseRevision) ? baseRevision : undefined, deletedPaths }));
    }
    catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Unable to create staging session." });
    }
});
router.get("/execute/sessions/:id/stage/:stageId", async (req, res) => {
    try {
        res.json(await getWorkspaceStageStatus(req.params.id, req.params.stageId));
    }
    catch (error) {
        res.status(404).json({ error: error instanceof Error ? error.message : "Staging session not found." });
    }
});
router.put("/execute/sessions/:id/stage/:stageId/chunk", express.raw({ type: "application/octet-stream", limit: "8mb" }), async (req, res) => {
    const path = req.header("x-stage-path");
    const offset = Number(req.header("x-stage-offset"));
    if (!path || !Number.isSafeInteger(offset) || !Buffer.isBuffer(req.body))
        return res.status(400).json({ error: "Binary body, x-stage-path, and x-stage-offset are required." });
    try {
        res.status(201).json(await writeWorkspaceStageChunk(req.params.id, req.params.stageId, path, offset, req.body, req.header("x-stage-checksum") ?? undefined));
    }
    catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Chunk transfer failed." });
    }
});
router.post("/execute/sessions/:id/stage/:stageId/commit", async (req, res) => {
    try {
        res.json(await commitWorkspaceStage(req.params.id, req.params.stageId));
    }
    catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Staging commit failed." });
    }
});
router.delete("/execute/sessions/:id/stage/:stageId", async (req, res) => {
    try {
        await removeWorkspaceStage(req.params.id, req.params.stageId);
        res.status(204).end();
    }
    catch (error) {
        res.status(404).json({ error: error instanceof Error ? error.message : "Staging session not found." });
    }
});
router.post("/execute/sessions/:id/command", async (req, res) => {
    const { command, cwd } = req.body as {
        command?: string;
        cwd?: string;
    };
    if (!command?.trim())
        return res.status(400).json({ error: "command is required" });
    try {
        res.json({ ...(await runWorkspaceCommand(req.params.id, command, cwd || "/")), tier: "oracle-workspace" });
    }
    catch (error) {
        res.status(400).json({ stdout: "", stderr: error instanceof Error ? error.message : "Command failed.", exitCode: 1, executionTime: 0, tier: "oracle-workspace" });
    }
});
router.post("/execute/sessions/:id/dependencies", async (req, res) => {
    const manager = req.body?.manager;
    const mode = req.body?.mode;
    const cwd = req.body?.cwd;
    const packages = req.body?.packages;
    if (!(["npm", "pnpm", "yarn"] as const).includes(manager) || !(["install", "ci"] as const).includes(mode) || (cwd !== undefined && typeof cwd !== "string") || (packages !== undefined && (!Array.isArray(packages) || packages.some((entry) => typeof entry !== "string")))) {
        return res.status(400).json({ error: "manager, mode, and optional cwd are invalid." });
    }
    try {
        res.json({ ...(await installWorkspaceDependencies(req.params.id, manager, mode, cwd || "/", packages || [])), lifecycleScriptsDisabled: true, tier: "isolated-dependency-installer" });
    }
    catch (error) {
        res.status(400).json({ stdout: "", stderr: error instanceof Error ? error.message : "Dependency installation failed.", exitCode: 1, executionTime: 0, lifecycleScriptsDisabled: true, tier: "isolated-dependency-installer" });
    }
});
router.post("/execute", async (req, res) => {
    const { language, code, sessionId, stdin } = req.body as {
        language?: string;
        code?: string;
        sessionId?: string;
        stdin?: string;
    };
    if (!language || code === undefined)
        return res.status(400).json({ error: "language and code are required" });
    try {
        if (sessionId && !(await authorizeTerminalSession(sessionId, req.header("x-sk-workspace-access"))))
            return res.status(403).json({ error: "Workspace access is not valid for this browser session." });
        const result = sessionId
            ? await runCodeInWorkspace(sessionId, language, code, typeof stdin === "string" ? stdin : "")
            : await runEphemeralCode(language, code, typeof stdin === "string" ? stdin : "");
        res.json({ ...result, ...(sessionId ? { sessionId } : {}), tier: "oracle-workspace" });
    }
    catch (error) {
        res.status(503).json({ stdout: "", stderr: error instanceof Error ? error.message : "Execution service unavailable.", exitCode: 1, executionTime: 0, error: "runtime-unavailable", tier: "unavailable" });
    }
});
export default router;
