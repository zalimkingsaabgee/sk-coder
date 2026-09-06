import { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { authorizeTerminalSession, getWorkspaceSession, openInteractiveTerminal, terminateInteractiveTerminal } from "./lib/sessionManager.js";
import { isAllowedOrigin } from "./lib/originPolicy.js";
import { OUTPUT_MAX_BYTES } from "./lib/backendConfig.js";
import { limitTerminalChunk, parseTerminalChunk } from "./lib/outputLimit.js";
import { terminalAccessTokenFromProtocolHeader } from "./lib/terminalAccess.js";

const terminalDisconnectLingerMs = 10 * 60 * 1000;
const terminalReplayBufferSize = 20000;
const terminalReplayBuffers = new Map<string, { buffer: string[]; timer: NodeJS.Timeout | null }>();

function replayKey(sessionId: string, terminalId: string) {
    return `${sessionId}:${terminalId}`;
}

export function setupTerminalWs(server: Server) {
    const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => protocols.has("sk-coder-v1") ? "sk-coder-v1" : false });
    server.on("upgrade", async (request, socket, head) => {
        if (new URL(request.url || "/", "http://localhost").pathname !== "/api/ws/terminal")
            return;
        if (!isAllowedOrigin(request.headers.origin)) {
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            return socket.destroy();
        }
        const url = new URL(request.url || "/", "http://localhost");
        const sessionId = url.searchParams.get("sessionId");
        const accessToken = terminalAccessTokenFromProtocolHeader(request.headers["sec-websocket-protocol"]);
        if (!sessionId || !(await authorizeTerminalSession(sessionId, accessToken))) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            return socket.destroy();
        }
        wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
    });
    wss.on("connection", async (ws: WebSocket, request: IncomingMessage) => {
        try {
            const url = new URL(request.url || "/", "http://localhost");
            const requestedSessionId = url.searchParams.get("sessionId");
            const terminalId = url.searchParams.get("terminalId") || "shell";
            if (!requestedSessionId)
                throw new Error("Terminal session is required.");
            let cwd = "/";
            let sentBytes = 0;
            let terminal: { write: (data: string) => void; resize: (cols: number, rows: number) => void; detach: () => void; kill: () => void; } | null = null;
            let closed = false;
            const terminalReplayKey = replayKey(requestedSessionId, terminalId);
            const pendingMessages: Array<{ type?: string; command?: string; data?: string; cols?: number; rows?: number; }> = [];
            const replayState = terminalReplayBuffers.get(terminalReplayKey) ?? { buffer: [], timer: null };
            terminalReplayBuffers.set(terminalReplayKey, replayState);
            if (replayState.timer) {
                clearTimeout(replayState.timer);
                replayState.timer = null;
            }
            const handleMessage = (raw: import("ws").RawData) => {
                try {
                    const message = JSON.parse(raw.toString()) as { type?: string; command?: string; data?: string; cols?: number; rows?: number; };
                    if (!terminal) {
                        if (pendingMessages.length < 32 && ((message.type === "command" && Boolean(message.command)) || (message.type === "input" && typeof message.data === "string" && message.data.length <= 65536) || message.type === "interrupt" || (message.type === "resize" && Number.isFinite(message.cols) && Number.isFinite(message.rows))))
                            pendingMessages.push(message);
                        return;
                    }
                    if (message.type === "kill")
                        terminateInteractiveTerminal(terminal);
                    if (message.type === "command" && message.command) {
                        ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "state", state: "running", cwd }));
                        terminal.write(`${message.command}\r`);
                    }
                    if (message.type === "input" && typeof message.data === "string" && message.data.length <= 65536)
                        terminal.write(message.data);
                    if (message.type === "interrupt")
                        terminal.write("\u0003");
                    if (message.type === "resize" && Number.isFinite(message.cols) && Number.isFinite(message.rows))
                        terminal.resize(message.cols!, message.rows!);
                }
                catch { }
            };
            ws.on("message", handleMessage);
            ws.on("close", () => {
                closed = true;
                if (!terminal)
                    return;
                if (replayState.timer)
                    clearTimeout(replayState.timer);
                replayState.timer = setTimeout(() => {
                    terminal?.detach();
                    terminalReplayBuffers.delete(terminalReplayKey);
                }, terminalDisconnectLingerMs);
            });
            const session = await getWorkspaceSession(requestedSessionId);
            terminal = await openInteractiveTerminal(session.id, (data) => {
                const parsed = parseTerminalChunk(data, cwd);
                cwd = parsed.cwd;
                if (replayState.buffer.length > 32)
                    replayState.buffer.shift();
                if (data)
                    replayState.buffer.push(data);
                if (replayState.buffer.length > terminalReplayBufferSize)
                    replayState.buffer = replayState.buffer.slice(-terminalReplayBufferSize);
                if (ws.readyState === WebSocket.OPEN) {
                    const limited = limitTerminalChunk(parsed.visible, sentBytes, OUTPUT_MAX_BYTES);
                    sentBytes = limited.sentBytes;
                    if (limited.data) {
                        ws.send(JSON.stringify({ type: "stdout", data: limited.data }));
                        if (limited.capped)
                            ws.send(JSON.stringify({ type: "stderr", data: "\nTerminal output was capped for this live session.\n" }));
                    }
                    if (parsed.reachedPrompt)
                        ws.send(JSON.stringify({ type: "state", state: "live", cwd }));
                }
            }, (data) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "stderr", data })), (code) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "exit", code, cwd })), undefined, terminalId);
            if (closed) {
                return;
            }
            const replay = replayState.buffer.join("");
            if (replay)
                ws.send(JSON.stringify({ type: "stdout", data: replay.slice(-terminalReplayBufferSize) }));
            ws.send(JSON.stringify({ type: "ready", cwd, sessionId: session.id, mode: "pty" }));
            ws.send(JSON.stringify({ type: "state", state: "live", cwd }));
            for (const message of pendingMessages)
                handleMessage(Buffer.from(JSON.stringify(message)));
        }
        catch (error) {
            ws.send(JSON.stringify({ type: "stderr", data: `${error instanceof Error ? error.message : "Terminal unavailable."}\n` }));
            ws.close();
        }
    });
}
