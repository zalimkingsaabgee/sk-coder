import { runPython } from "./pyodideRunner";
export type ExecutionTier = "workspace-server" | "public-source" | "browser-python" | "unavailable";
export interface ExecResponse {
    stdout: string;
    stderr: string;
    exitCode: number;
    executionTime: number;
    tier: ExecutionTier;
    capability: string;
}
type RuntimeConfig = {
    backend: string;
    wandboxPrefixes: string[];
    filename: string;
    compilerFilter?: (name: string) => boolean;
};
type WandboxCompiler = {
    name: string;
};
export function getExecutionTierLabel(tier: ExecutionTier) {
    if (tier === "workspace-server")
        return "Workspace server";
    if (tier === "public-source")
        return "Online source runner";
    if (tier === "browser-python")
        return "Browser Python";
    return "Unavailable";
}
const WANDBOX_RUN_URL = "https://wandbox.org/api/compile.json";
const WANDBOX_CATALOG_URL = "https://wandbox.org/api/list.json";
const CATALOG_TTL_MS = 10 * 60 * 1000;
const API_BASE = (import.meta.env.VITE_API_URL || "/api").replace(/\/$/, "");
const RUNTIME_CONFIGS: Record<string, RuntimeConfig> = {
    node: { backend: "node", wandboxPrefixes: ["nodejs-"], filename: "main.js" },
    javascript: { backend: "node", wandboxPrefixes: ["nodejs-"], filename: "main.js" },
    js: { backend: "node", wandboxPrefixes: ["nodejs-"], filename: "main.js" },
    mjs: { backend: "node", wandboxPrefixes: ["nodejs-"], filename: "main.mjs" },
    cjs: { backend: "node", wandboxPrefixes: ["nodejs-"], filename: "main.cjs" },
    jsx: { backend: "node", wandboxPrefixes: ["nodejs-"], filename: "main.jsx" },
    typescript: { backend: "typescript", wandboxPrefixes: ["typescript-"], filename: "main.ts" },
    ts: { backend: "typescript", wandboxPrefixes: ["typescript-"], filename: "main.ts" },
    tsx: { backend: "typescript", wandboxPrefixes: ["typescript-"], filename: "main.tsx" },
    python: { backend: "python", wandboxPrefixes: ["cpython-"], filename: "main.py" },
    python3: { backend: "python", wandboxPrefixes: ["cpython-"], filename: "main.py" },
    py: { backend: "python", wandboxPrefixes: ["cpython-"], filename: "main.py" },
    java: { backend: "java", wandboxPrefixes: ["openjdk-jdk-", "openjdk-"], filename: "Main.java" },
    c: { backend: "c", wandboxPrefixes: ["gcc-"], filename: "main.c", compilerFilter: (name) => name.endsWith("-c") },
    cpp: { backend: "cpp", wandboxPrefixes: ["gcc-"], filename: "main.cpp", compilerFilter: (name) => !name.endsWith("-c") && !name.endsWith("-pp") },
    cc: { backend: "cpp", wandboxPrefixes: ["gcc-"], filename: "main.cpp", compilerFilter: (name) => !name.endsWith("-c") && !name.endsWith("-pp") },
    cxx: { backend: "cpp", wandboxPrefixes: ["gcc-"], filename: "main.cpp", compilerFilter: (name) => !name.endsWith("-c") && !name.endsWith("-pp") },
    rust: { backend: "rust", wandboxPrefixes: ["rust-"], filename: "main.rs" },
    rs: { backend: "rust", wandboxPrefixes: ["rust-"], filename: "main.rs" },
    go: { backend: "go", wandboxPrefixes: ["go-"], filename: "main.go" },
    php: { backend: "php", wandboxPrefixes: ["php-"], filename: "main.php" },
    ruby: { backend: "ruby", wandboxPrefixes: ["ruby-"], filename: "main.rb" },
    rb: { backend: "ruby", wandboxPrefixes: ["ruby-"], filename: "main.rb" },
    kotlin: { backend: "kotlin", wandboxPrefixes: [], filename: "Main.kt" },
    kt: { backend: "kotlin", wandboxPrefixes: [], filename: "Main.kt" },
    kts: { backend: "kotlin", wandboxPrefixes: [], filename: "Main.kts" },
    bash: { backend: "bash", wandboxPrefixes: ["bash"], filename: "main.sh" },
    sh: { backend: "bash", wandboxPrefixes: ["bash"], filename: "main.sh" },
    csharp: { backend: "csharp", wandboxPrefixes: ["mono-"], filename: "Program.cs" },
    cs: { backend: "csharp", wandboxPrefixes: ["mono-"], filename: "Program.cs" },
    scala: { backend: "scala", wandboxPrefixes: ["scala-"], filename: "Main.scala" },
    sc: { backend: "scala", wandboxPrefixes: ["scala-"], filename: "Main.scala" },
    swift: { backend: "swift", wandboxPrefixes: ["swift-"], filename: "main.swift" },
    perl: { backend: "perl", wandboxPrefixes: ["perl-"], filename: "main.pl" },
    pl: { backend: "perl", wandboxPrefixes: ["perl-"], filename: "main.pl" },
    lua: { backend: "lua", wandboxPrefixes: ["lua-"], filename: "main.lua" },
    pascal: { backend: "pascal", wandboxPrefixes: ["fpc-"], filename: "main.pas" },
    pp: { backend: "pascal", wandboxPrefixes: ["fpc-"], filename: "main.pas" },
    haskell: { backend: "haskell", wandboxPrefixes: ["ghc-"], filename: "Main.hs" },
    hs: { backend: "haskell", wandboxPrefixes: ["ghc-"], filename: "Main.hs" },
    d: { backend: "d", wandboxPrefixes: ["dmd-"], filename: "main.d" },
    dlang: { backend: "d", wandboxPrefixes: ["dmd-"], filename: "main.d" },
    elixir: { backend: "elixir", wandboxPrefixes: ["elixir-"], filename: "main.exs" },
    ex: { backend: "elixir", wandboxPrefixes: ["elixir-"], filename: "main.exs" },
    erlang: { backend: "erlang", wandboxPrefixes: ["erlang-"], filename: "main.erl" },
    erl: { backend: "erlang", wandboxPrefixes: ["erlang-"], filename: "main.erl" },
    ocaml: { backend: "ocaml", wandboxPrefixes: ["ocaml-"], filename: "main.ml" },
    ml: { backend: "ocaml", wandboxPrefixes: ["ocaml-"], filename: "main.ml" },
    crystal: { backend: "crystal", wandboxPrefixes: ["crystal-"], filename: "main.cr" },
    cr: { backend: "crystal", wandboxPrefixes: ["crystal-"], filename: "main.cr" },
    nim: { backend: "nim", wandboxPrefixes: ["nim-"], filename: "main.nim" },
    zig: { backend: "zig", wandboxPrefixes: ["zig-"], filename: "main.zig" },
    julia: { backend: "julia", wandboxPrefixes: ["julia-"], filename: "main.jl" },
    jl: { backend: "julia", wandboxPrefixes: ["julia-"], filename: "main.jl" },
};
let wandboxCatalog: {
    value: WandboxCompiler[];
    updatedAt: number;
} | null = null;
function isFresh(updatedAt: number) {
    return Date.now() - updatedAt < CATALOG_TTL_MS;
}
function isInfrastructureFailure(stderr: string) {
    const value = stderr.toLowerCase();
    return value.includes("catatonit") || value.includes("failed to exec pid1") || value.includes("runtime unavailable") || value.includes("container unavailable") || value.includes("isolated runtime service") || value.includes("oci runtime error") || value.includes("crun: clone") || value.includes("resource temporarily unavailable");
}
async function getWandboxCatalog(): Promise<WandboxCompiler[]> {
    if (wandboxCatalog && isFresh(wandboxCatalog.updatedAt))
        return wandboxCatalog.value;
    const response = await fetch(WANDBOX_CATALOG_URL, { signal: AbortSignal.timeout(10000) });
    if (!response.ok)
        throw new Error(`Wandbox compiler catalog returned ${response.status}`);
    const value = await response.json() as WandboxCompiler[];
    wandboxCatalog = { value, updatedAt: Date.now() };
    return value;
}
async function tryWandbox(language: string, code: string, stdin = ""): Promise<ExecResponse | null> {
    try {
        const config = RUNTIME_CONFIGS[language];
        if (!config || config.wandboxPrefixes.length === 0)
            return null;
        const compilers = await getWandboxCatalog();
        const matches = compilers.filter((item) => config.wandboxPrefixes.some((prefix) => item.name.startsWith(prefix)) && (!config.compilerFilter || config.compilerFilter(item.name)));
        const compiler = matches.find((item) => !item.name.includes("head")) ?? matches[0];
        if (!compiler)
            return null;
        const source = language === "java"
            ? code.replace(/\bpublic\s+(?:final\s+)?class\s+([A-Za-z_$][\w$]*)/, "class $1")
            : code;
        const response = await fetch(WANDBOX_RUN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ compiler: compiler.name, code: source, filename: config.filename, stdin }),
            signal: AbortSignal.timeout(35000),
        });
        if (!response.ok)
            return null;
        const data = await response.json() as {
            status?: string | number;
            program_output?: string;
            program_error?: string;
            compiler_error?: string;
        };
        const stderr = [data.program_error, data.compiler_error].filter(Boolean).join("\n");
        if (isInfrastructureFailure(stderr))
            return null;
        return {
            stdout: data.program_output ?? "",
            stderr,
            exitCode: Number(data.status ?? (stderr ? 1 : 0)),
            executionTime: 0,
            tier: "public-source",
            capability: stdin ? "An online source runner executed this file with input supplied before launch. It cannot provide packages, a shell session, project files, or live prompts." : "An online source runner executed this file. It cannot provide packages, a shell session, or a full project workspace.",
        };
    }
    catch {
        return null;
    }
}
async function tryPyodide(code: string): Promise<ExecResponse | null> {
    try {
        const { output, error } = await runPython(code);
        return {
            stdout: output,
            stderr: error,
            exitCode: error ? 1 : 0,
            executionTime: 0,
            tier: "browser-python",
            capability: "Your browser ran this Python source file. Packages, shell commands, and project files require a workspace server.",
        };
    }
    catch {
        return null;
    }
}
async function tryBackend(language: string, code: string, stdin = ""): Promise<ExecResponse | null> {
    try {
        const deviceId = localStorage.getItem("sk-device-id") || "anonymous";
        const sessionId = localStorage.getItem("sk-coder-workspace-session-id");
        const workspaceAccess = localStorage.getItem("sk-coder-workspace-terminal-access");
        const useWorkspace = Boolean(sessionId && workspaceAccess);
        let response = await fetch(`${API_BASE}/execute`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Device-Id": deviceId, ...(useWorkspace ? { "X-SK-Workspace-Access": workspaceAccess! } : {}) },
            cache: "no-store",
            body: JSON.stringify({ language, code, stdin, ...(useWorkspace ? { sessionId } : {}) }),
            signal: AbortSignal.timeout(35000),
        });
        if (useWorkspace && (response.status === 401 || response.status === 403 || response.status === 404)) {
            localStorage.removeItem("sk-coder-workspace-session-id");
            localStorage.removeItem("sk-coder-workspace-terminal-access");
            response = await fetch(`${API_BASE}/execute`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Device-Id": deviceId },
                cache: "no-store",
                body: JSON.stringify({ language, code, stdin }),
                signal: AbortSignal.timeout(35000),
            });
        }
        if (!response.ok)
            return null;
        const data = await response.json() as {
            stdout?: string;
            stderr?: string;
            exitCode?: number;
            executionTime?: number;
            error?: string;
        };
        if (data.error)
            return null;
        const result = {
            stdout: data.stdout ?? "",
            stderr: data.stderr ?? "",
            exitCode: data.exitCode ?? 1,
            executionTime: data.executionTime ?? 0,
            tier: "workspace-server" as const,
            capability: useWorkspace
                ? stdin ? "Your private workspace executed this code with input supplied before launch. Its temporary runner directory was removed after the result. Use SK Shell for live prompts, commands, packages, and project work." : "Your private workspace executed this code. Its temporary runner directory was removed after the result. SK Shell and project commands use the same workspace session."
                : stdin ? "A short-lived isolated runner executed this code with input supplied before launch. Use a staged workspace for project files and live prompts." : "A short-lived isolated runner executed this code. Stage the project to a workspace for project files, commands, and retained work.",
        };
        return isInfrastructureFailure(result.stderr) ? null : result;
    }
    catch {
        return null;
    }
}
export async function execute(language: string, code: string, options?: {
    stdin?: string;
    allowExternalFallback?: boolean;
}): Promise<ExecResponse> {
    const normalized = language.toLowerCase();
    const startedAt = Date.now();
    const config = RUNTIME_CONFIGS[normalized];
    const stdin = options?.stdin ?? "";
    const backend = config ? await tryBackend(config.backend, code, stdin) : null;
    if (backend)
        return backend;
    if (["python", "python3", "py"].includes(normalized)) {
        const pyodide = await tryPyodide(code);
        if (pyodide)
            return pyodide;
    }
    if (options?.allowExternalFallback) {
        const wandbox = await tryWandbox(normalized, code, stdin);
        if (wandbox)
            return wandbox;
    }
    const label = normalized === "node" || normalized === "javascript" || normalized === "js" ? "Node.js" : language;
    return {
        stdout: "",
        stderr: `No runner is available for ${label} right now. Connect a workspace server or use an approved external source runner.`,
        exitCode: 1,
        executionTime: Date.now() - startedAt,
        tier: "unavailable",
        capability: stdin ? "No approved runner accepted this input-dependent file. SK Shell with a workspace server supports live prompts, projects, packages, and persistent work." : "No local fallback can provide a shell session, dependency installation, a multi-file project, or a persistent workspace without a workspace server.",
    };
}
