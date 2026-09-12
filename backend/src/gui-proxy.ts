import { logger } from "./lib/logger.js";
import net from "node:net";
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { getGuiDisplayTarget } from "./lib/guiSessionManager.js";
import { isAllowedOrigin } from "./lib/originPolicy.js";

function parseGuiPath(url: string) {
    const pathname = new URL(url, "http://localhost").pathname;
    const match = pathname.match(/^\/api\/gui\/sessions\/([^/]+)\/view\/([^/]+)(\/.*)?$/);
    if (!match)
        return null;
    return { id: decodeURIComponent(match[1]), token: decodeURIComponent(match[2]), targetPath: `${match[3] || "/"}${new URL(url, "http://localhost").search}` };
}

export function proxyGuiHttpRequest(req: IncomingMessage, res: any, id: string, token: string) {
    void getGuiDisplayTarget(id, token).then(({ port }) => {
        const parsed = parseGuiPath(req.url || "/");
        const upstream = httpRequest({ hostname: "127.0.0.1", port, method: req.method, path: parsed?.targetPath || "/", headers: { ...req.headers, host: `127.0.0.1:${port}` } }, (upstreamResponse) => {
            res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
            upstreamResponse.pipe(res);
        });
        upstream.once("error", () => res.headersSent ? res.destroy() : res.status(502).send("Display stream is unavailable."));
        req.pipe(upstream);
    }).catch(() => res.status(404).send("Display session not found or expired."));
}

export function setupGuiProxy(server: any) {
    server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
        const parsed = parseGuiPath(request.url || "/");
        if (!parsed)
            return;
        if (!isAllowedOrigin(request.headers.origin)) {
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            return socket.destroy();
        }
        void getGuiDisplayTarget(parsed.id, parsed.token).then(({ port }) => {
            const upstream = net.connect(port, "127.0.0.1", () => {
                const lines: string[] = [`GET ${parsed.targetPath} HTTP/${request.httpVersion}`, `Host: 127.0.0.1:${port}`];
                for (let index = 0; index < request.rawHeaders.length; index += 2) {
                    const name = request.rawHeaders[index];
                    const value = request.rawHeaders[index + 1];
                    if (name.toLowerCase() !== "host")
                        lines.push(`${name}: ${value}`);
                }
                upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
                if (head.length)
                    upstream.write(head);
                socket.pipe(upstream).pipe(socket);
            });
            upstream.once("error", () => socket.destroy());
        }).catch(() => {
            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            socket.destroy();
        });
    });
}
