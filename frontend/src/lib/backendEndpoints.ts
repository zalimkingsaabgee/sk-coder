export function resolveWebSocketBase(apiBase: string, configuredWebSocket?: string, browserOrigin?: string) {
    const origin = browserOrigin || (typeof window !== "undefined" ? window.location.origin : undefined);
    const resolveAbsolute = (value: string) => {
        if (/^wss?:\/\//i.test(value))
            return value;
        if (/^https?:\/\//i.test(value))
            return value.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:").replace(/\/$/, "");
        if (!origin)
            return value;
        const absolute = new URL(value, origin);
        absolute.protocol = absolute.protocol === "https:" ? "wss:" : "ws:";
        return absolute.toString().replace(/\/$/, "");
    };
    if (configuredWebSocket)
        return resolveAbsolute(configuredWebSocket);
    return `${resolveAbsolute(apiBase)}/ws/terminal`;
}
