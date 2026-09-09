import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";
import type { FileNode, Tab, TerminalType, TerminalLine, AIChatMessage, ActivePanel, Settings, ErrorEntry, } from "../types/ide";
import { deleteBrowserBlob } from "../lib/browserStorage";
import type { GuiDisplaySession } from "../lib/guiDisplay";
import { workspaceDirectoryCommand } from "../lib/terminalOpenPath";
import { scheduleWholeWorkspaceMirror } from "../lib/wholeWorkspaceMirror";
export type ApkWorkspace = {
    blobId: string;
    name: string;
    size: number;
    updatedAt: number;
    editMode?: "full" | "simple" | "common" | "xml";
    modeSelected?: boolean;
    packageDetails?: {
        appLabel: string;
        packageName: string;
        appIcon: string;
        versionCode: string;
        versionName: string;
        minSdkVersion: string;
        targetSdkVersion: string;
        installLocation: "auto" | "internalOnly" | "preferExternal";
    };
} | null;
const DEFAULT_SETTINGS: Settings = {
    editor: {
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        tabSize: 2,
        wordWrap: "on",
        minimap: false,
        lineNumbers: "on",
        autoSave: true,
        theme: "vs-dark",
        bracketPairs: true,
        smoothScrolling: true,
        cursorStyle: "line",
        renderWhitespace: "none",
    },
    ai: {
        apiKey: "",
        apiEndpoint: "",
        model: "",
        provider: "auto",
        customModels: [],
        keyStatus: "none",
        usePuter: false,
        autoContext: true,
    },
    storage: {
        workspacePath: "",
        useExternalStorage: false,
        sdCardPath: "/sdcard/SKCoder",
        downloadPath: "",
    },
    github: {
        token: "",
        username: "",
        codespaceActive: "",
    },
    preview: {
        viewport: "mobile",
        autoRefresh: true,
        port: "3000",
    },
    backend: {
        url: "",
        enabled: true,
    },
};
const FILE_CONTENT_PREFIX = "sk-file:";
const STORAGE_DB_NAME = "sk-coder-workspace-v1";
const STORAGE_STORE_NAME = "values";
function openStorageDatabase(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === "undefined")
        return Promise.resolve(null);
    return new Promise((resolve) => {
        const request = indexedDB.open(STORAGE_DB_NAME, 1);
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(STORAGE_STORE_NAME))
                database.createObjectStore(STORAGE_STORE_NAME);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
    });
}
async function getIndexedValue(key: string): Promise<string | null> {
    const database = await openStorageDatabase();
    if (!database)
        return null;
    return new Promise((resolve) => {
        const request = database.transaction(STORAGE_STORE_NAME, "readonly").objectStore(STORAGE_STORE_NAME).get(key);
        request.onsuccess = () => resolve(typeof request.result === "string" ? request.result : null);
        request.onerror = () => resolve(null);
    });
}
async function setIndexedValue(key: string, value: string): Promise<void> {
    const database = await openStorageDatabase();
    if (!database)
        return;
    await new Promise<void>((resolve) => {
        const request = database.transaction(STORAGE_STORE_NAME, "readwrite").objectStore(STORAGE_STORE_NAME).put(value, key);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
    });
}
async function deleteIndexedValue(key: string): Promise<void> {
    const database = await openStorageDatabase();
    if (!database)
        return;
    await new Promise<void>((resolve) => {
        const request = database.transaction(STORAGE_STORE_NAME, "readwrite").objectStore(STORAGE_STORE_NAME).delete(key);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
    });
}
const resilientStorage: StateStorage = {
    getItem: async (name) => {
        try {
            const local = localStorage.getItem(name);
            if (local)
                return local;
        }
        catch {
        }
        return await getIndexedValue(name);
    },
    setItem: async (name, value) => {
        try {
            localStorage.setItem(name, value);
        }
        catch {
        }
        await setIndexedValue(name, value);
    },
    removeItem: async (name) => {
        try {
            localStorage.removeItem(name);
        }
        catch { }
        await deleteIndexedValue(name);
    },
};
function saveFileContent(path: string, content: string) {
    try {
        localStorage.setItem(FILE_CONTENT_PREFIX + path, content);
    }
    catch { }
    void setIndexedValue(FILE_CONTENT_PREFIX + path, content);
}
function loadFileContent(path: string): string {
    return localStorage.getItem(FILE_CONTENT_PREFIX + path) ?? "";
}
function deleteFileContent(path: string) {
    try {
        localStorage.removeItem(FILE_CONTENT_PREFIX + path);
    }
    catch { }
    void deleteIndexedValue(FILE_CONTENT_PREFIX + path);
}
function renameFileContent(oldPath: string, newPath: string) {
    const content = localStorage.getItem(FILE_CONTENT_PREFIX + oldPath) ?? "";
    deleteFileContent(oldPath);
    saveFileContent(newPath, content);
}
function saveAllFileContents(nodes: FileNode[]) {
    for (const node of nodes) {
        if (node.type === "file" && node.content !== undefined)
            saveFileContent(node.path, node.content);
        if (node.children)
            saveAllFileContents(node.children);
    }
}
function stripContent(nodes: FileNode[]): FileNode[] {
    return nodes.map((n) => ({
        ...n,
        content: undefined,
        children: n.children ? stripContent(n.children) : undefined,
    }));
}
function restoreContent(nodes: FileNode[]): FileNode[] {
    return nodes.map((n) => ({
        ...n,
        content: n.type === "file" ? loadFileContent(n.path) : undefined,
        children: n.children ? restoreContent(n.children) : undefined,
    }));
}
async function restoreIndexedContent(nodes: FileNode[]): Promise<FileNode[]> {
    return Promise.all(nodes.map(async (node) => {
        const localContent = node.type === "file" ? localStorage.getItem(FILE_CONTENT_PREFIX + node.path) : null;
        const content = node.type === "file"
            ? localContent ?? await getIndexedValue(FILE_CONTENT_PREFIX + node.path) ?? ""
            : undefined;
        return {
            ...node,
            content,
            children: node.children ? await restoreIndexedContent(node.children) : undefined,
        };
    }));
}
function deleteAllFileContents(nodes: FileNode[]) {
    for (const node of nodes) {
        if (node.type === "file")
            deleteFileContent(node.path);
        if (node.children)
            deleteAllFileContents(node.children);
    }
}
function collectBlobIds(nodes: FileNode[], ids = new Set<string>()) {
    for (const node of nodes) {
        if (node.assetBlobId)
            ids.add(node.assetBlobId);
        if (node.children)
            collectBlobIds(node.children, ids);
    }
    return ids;
}
function removeUnreferencedBlobs(removed: Set<string>, retainedTree: FileNode[]) {
    const retained = collectBlobIds(retainedTree);
    removed.forEach((id) => {
        if (!retained.has(id))
            void deleteBrowserBlob(id);
    });
}
type ContextMenuState = {
    x: number;
    y: number;
    node: FileNode | null;
    isFolder: boolean;
} | null;
type PreviewResult = {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    tier?: string;
    capability?: string;
    executionTime?: number;
    files?: {
        name: string;
        url?: string;
    }[];
};
type IDEState = {
    fileTree: FileNode[];
    flatFiles: Map<string, FileNode>;
    openTabs: Tab[];
    activeTabId: string | null;
    activePanel: ActivePanel;
    terminalType: TerminalType;
    terminalLines: TerminalLine[];
    terminalInput: string;
    aiChatMessages: AIChatMessage[];
    aiChatDraft: string;
    aiAttachmentPaths: string[];
    aiChatOpen: boolean;
    aiTyping: boolean;
    previewContent: string;
    previewPath: string | null;
    previewKey: number;
    previewResult: PreviewResult | null;
    guiDisplay: GuiDisplaySession | null;
    apkWorkspace: ApkWorkspace;
    contextMenu: ContextMenuState;
    expandedFolders: Set<string>;
    sidebarOpen: boolean;
    isRunning: boolean;
    renameNodeId: string | null;
    newItemParentId: string | null;
    newItemType: "file" | "folder" | null;
    settings: Settings;
    showSettings: boolean;
    settingsTab: string;
    dragOverId: string | null;
    terminalBridgeCmd: {
        cmd: string;
        cmds?: string[];
        targetTab?: string;
        targetType?: string;
        newTab?: boolean;
    } | null;
    errors: ErrorEntry[];
    selectedPaths: Set<string>;
    selectionMode: boolean;
    batchOperation: "copy" | "move" | null;
    transferStatus: {
        kind: "import" | "export" | "stage";
        stage: string;
        completed: number;
        total: number;
        current?: string;
    } | null;
};
type IDEActions = {
    saveWorkspaceToBackend: () => Promise<void>;
    loadWorkspaceFromBackend: (projectId?: string) => Promise<void>;
    setTerminalBridgeCmd: (cmd: {
        cmd: string;
        cmds?: string[];
        targetTab?: string;
        targetType?: string;
    } | null) => void;
    openInTerminal: (path: string, isFolder: boolean, termType?: string) => void;
    openFileInTerminal: (filePath: string, engine: string) => void;
    setErrors: (errors: ErrorEntry[]) => void;
    setSelectionMode: (enabled: boolean) => void;
    toggleSelectedPath: (path: string) => void;
    clearSelectedPaths: () => void;
    setBatchOperation: (operation: "copy" | "move" | null) => void;
    setTransferStatus: (status: IDEState["transferStatus"]) => void;
    deleteNodes: (paths: string[]) => void;
    moveNodes: (paths: string[], toFolderPath: string) => boolean;
    copyNodes: (paths: string[], toFolderPath: string) => boolean;
    setFileTree: (tree: FileNode[]) => void;
    addFile: (parentPath: string, name: string, type: "file" | "folder", content?: string) => void;
    deleteNode: (path: string) => void;
    renameNode: (path: string, newName: string) => void;
    updateFileContent: (path: string, content: string) => void;
    setFileAssetData: (path: string, assetData: string) => void;
    moveNode: (fromPath: string, toFolderPath: string) => void;
    openTab: (node: FileNode) => void;
    closeTab: (tabId: string) => void;
    setActiveTab: (tabId: string) => void;
    markTabModified: (tabId: string, modified: boolean) => void;
    setActivePanel: (panel: ActivePanel) => void;
    setTerminalType: (type: TerminalType) => void;
    addTerminalLine: (line: Omit<TerminalLine, "id" | "timestamp">) => void;
    clearTerminal: () => void;
    setTerminalInput: (input: string) => void;
    addAIChatMessage: (message: Omit<AIChatMessage, "id" | "timestamp">) => void;
    setAIChatDraft: (draft: string) => void;
    setAIAttachmentPaths: (paths: string[]) => void;
    clearAIChat: () => void;
    setAIChatOpen: (open: boolean) => void;
    setAITyping: (typing: boolean) => void;
    setPreviewContent: (html: string) => void;
    setPreviewPath: (path: string | null) => void;
    refreshPreview: () => void;
    setPreviewResult: (result: PreviewResult | null) => void;
    setGuiDisplay: (session: GuiDisplaySession | null) => void;
    setApkWorkspace: (workspace: ApkWorkspace) => void;
    setContextMenu: (menu: ContextMenuState) => void;
    toggleFolder: (path: string) => void;
    setSidebarOpen: (open: boolean) => void;
    setIsRunning: (running: boolean) => void;
    setRenameNodeId: (id: string | null) => void;
    setNewItem: (parentId: string | null, type: "file" | "folder" | null) => void;
    updateSettings: (settings: Partial<Settings>) => void;
    updateEditorSettings: (settings: Partial<Settings["editor"]>) => void;
    updateAISettings: (settings: Partial<Settings["ai"]>) => void;
    updateStorageSettings: (settings: Partial<Settings["storage"]>) => void;
    updateGithubSettings: (settings: Partial<Settings["github"]>) => void;
    updatePreviewSettings: (settings: Partial<Settings["preview"]>) => void;
    setShowSettings: (show: boolean) => void;
    setSettingsTab: (tab: string) => void;
    importFiles: (files: FileNode[], parentPath?: string) => void;
    setDragOver: (id: string | null) => void;
    buildFlatFiles: () => void;
    getFileContent: (path: string) => string | undefined;
    getActiveFile: () => FileNode | undefined;
};
function generateId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
function getLanguage(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase() || "";
    const map: Record<string, string> = {
        ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
        py: "python", cpp: "cpp", c: "c", cc: "cpp", cxx: "cpp", h: "cpp",
        html: "html", htm: "html", css: "css", scss: "scss", sass: "sass",
        json: "json", yaml: "yaml", yml: "yaml", xml: "xml",
        md: "markdown", markdown: "markdown", sh: "shell", bash: "shell",
        java: "java", kt: "kotlin", rs: "rust", go: "go", rb: "ruby",
        php: "php", sql: "sql", r: "r", swift: "swift", dart: "dart",
        txt: "plaintext", env: "plaintext", gitignore: "plaintext",
        toml: "toml", ini: "ini", conf: "ini",
    };
    return map[ext] || "plaintext";
}
function flattenTree(nodes: FileNode[], map: Map<string, FileNode>) {
    for (const node of nodes) {
        map.set(node.path, node);
        if (node.children)
            flattenTree(node.children, map);
    }
}
function insertNodeAtPath(nodes: FileNode[], parentPath: string, newNode: FileNode): FileNode[] {
    return nodes.map((node) => {
        if (node.path === parentPath && node.type === "folder") {
            return { ...node, children: [...(node.children || []), newNode] };
        }
        if (node.children)
            return { ...node, children: insertNodeAtPath(node.children, parentPath, newNode) };
        return node;
    });
}
function deleteNodeAtPath(nodes: FileNode[], path: string): FileNode[] {
    return nodes
        .filter((n) => n.path !== path)
        .map((n) => n.children ? { ...n, children: deleteNodeAtPath(n.children, path) } : n);
}
function renameNodeAtPath(nodes: FileNode[], path: string, newName: string, newPath: string): FileNode[] {
    return nodes.map((n) => {
        if (n.path === path)
            return { ...n, name: newName, path: newPath };
        if (n.children)
            return { ...n, children: renameNodeAtPath(n.children, path, newName, newPath) };
        return n;
    });
}
function updateContentAtPath(nodes: FileNode[], path: string, content: string): FileNode[] {
    return nodes.map((n) => {
        if (n.path === path)
            return { ...n, content };
        if (n.children)
            return { ...n, children: updateContentAtPath(n.children, path, content) };
        return n;
    });
}
function updateAssetDataAtPath(nodes: FileNode[], path: string, assetData: string): FileNode[] {
    return nodes.map((n) => {
        if (n.path === path)
            return { ...n, assetData };
        if (n.children)
            return { ...n, children: updateAssetDataAtPath(n.children, path, assetData) };
        return n;
    });
}
function compactPaths(paths: string[]): string[] {
    const unique = Array.from(new Set(paths)).sort((a, b) => a.length - b.length);
    return unique.filter((path) => !unique.some((parent) => parent !== path && path.startsWith(parent + "/")));
}
function rebaseNode(node: FileNode, newPath: string, freshIds: boolean): FileNode {
    return {
        ...node,
        id: freshIds ? generateId() : node.id,
        path: newPath,
        children: node.children?.map((child) => rebaseNode(child, `${newPath}/${child.name}`, freshIds)),
    };
}
function collectFilePaths(node: FileNode): string[] {
    if (node.type === "file")
        return [node.path];
    return (node.children || []).flatMap(collectFilePaths);
}
function uniqueChildPath(nodes: FileNode[], folderPath: string, name: string): string {
    const paths = new Set<string>();
    function collect(items: FileNode[]) {
        for (const item of items) {
            paths.add(item.path);
            if (item.children)
                collect(item.children);
        }
    }
    collect(nodes);
    const prefix = folderPath === "/" ? "" : folderPath;
    const base = `${prefix}/${name}`;
    if (!paths.has(base))
        return base;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    let counter = 2;
    while (paths.has(`${prefix}/${stem}-copy-${counter}${extension}`))
        counter += 1;
    return `${prefix}/${stem}-copy-${counter}${extension}`;
}
const INIT_LINES: TerminalLine[] = [
    { id: "i1", type: "info", content: "SK Coder Python Terminal — type Python code and press Enter.", timestamp: Date.now() },
    { id: "i2", type: "info", content: "Run any file via the ▶ Run button in the top bar.", timestamp: Date.now() },
];
export const useIDEStore = create<IDEState & IDEActions>()(persist((set, get) => ({
    fileTree: [],
    flatFiles: new Map(),
    openTabs: [],
    activeTabId: null,
    activePanel: "files",
    terminalType: "python",
    terminalLines: INIT_LINES,
    terminalInput: "",
    aiChatMessages: [],
    aiChatDraft: "",
    aiAttachmentPaths: [],
    aiChatOpen: false,
    aiTyping: false,
    previewContent: "",
    previewPath: null,
    previewKey: 0,
    previewResult: null,
    guiDisplay: null,
    apkWorkspace: null,
    contextMenu: null,
    expandedFolders: new Set(),
    sidebarOpen: false,
    isRunning: false,
    renameNodeId: null,
    newItemParentId: null,
    newItemType: null,
    settings: DEFAULT_SETTINGS,
    showSettings: false,
    settingsTab: "editor",
    dragOverId: null,
    terminalBridgeCmd: null,
    errors: [],
    selectedPaths: new Set(),
    selectionMode: false,
    batchOperation: null,
    transferStatus: null,
    buildFlatFiles: () => {
        const map = new Map<string, FileNode>();
        flattenTree(get().fileTree, map);
        set({ flatFiles: map });
    },
    getFileContent: (path) => {
        return get().flatFiles.get(path)?.content;
    },
    getActiveFile: () => {
        const { openTabs, activeTabId, flatFiles } = get();
        if (!activeTabId)
            return undefined;
        const tab = openTabs.find((t) => t.id === activeTabId);
        if (!tab)
            return undefined;
        return flatFiles.get(tab.path);
    },
    setFileTree: (tree) => {
        saveAllFileContents(tree);
        const map = new Map<string, FileNode>();
        flattenTree(tree, map);
        set({ fileTree: tree, flatFiles: map });
    },
    addFile: (parentPath, name, type, content = "") => {
        const id = generateId();
        const path = parentPath === "" ? `/${name}` : `${parentPath}/${name}`;
        if (type === "file")
            saveFileContent(path, content);
        const newNode: FileNode = {
            id, name, type, path,
            content: type === "file" ? content : undefined,
            language: type === "file" ? getLanguage(name) : undefined,
            children: type === "folder" ? [] : undefined,
        };
        let tree: FileNode[];
        if (parentPath === "" || parentPath === "/") {
            tree = [...get().fileTree, newNode];
        }
        else {
            tree = insertNodeAtPath(get().fileTree, parentPath, newNode);
        }
        const map = new Map<string, FileNode>();
        flattenTree(tree, map);
        set({ fileTree: tree, flatFiles: map, newItemParentId: null, newItemType: null });
        if (type === "file")
            get().openTab(newNode);
        void get().saveWorkspaceToBackend();
    },
    deleteNode: (path) => {
        const map = new Map<string, FileNode>();
        flattenTree(get().fileTree, map);
        const node = map.get(path);
        const removedBlobs = node ? collectBlobIds([node]) : new Set<string>();
        if (node)
            deleteAllFileContents([node]);
        const tree = deleteNodeAtPath(get().fileTree, path);
        removeUnreferencedBlobs(removedBlobs, tree);
        const newMap = new Map<string, FileNode>();
        flattenTree(tree, newMap);
        const openTabs = get().openTabs.filter((t) => !t.path.startsWith(path));
        const activeTabId = openTabs.find((t) => t.id === get().activeTabId)
            ? get().activeTabId
            : openTabs[openTabs.length - 1]?.id || null;
        set({ fileTree: tree, flatFiles: newMap, openTabs, activeTabId });
        void get().saveWorkspaceToBackend();
    },
    deleteNodes: (paths) => {
        const targets = compactPaths(paths);
        if (!targets.length)
            return;
        const currentMap = new Map<string, FileNode>();
        flattenTree(get().fileTree, currentMap);
        const removedBlobs = new Set<string>();
        targets.forEach((path) => {
            const node = currentMap.get(path);
            if (node) {
                collectBlobIds([node], removedBlobs);
                deleteAllFileContents([node]);
            }
        });
        let tree = get().fileTree;
        targets.forEach((path) => { tree = deleteNodeAtPath(tree, path); });
        removeUnreferencedBlobs(removedBlobs, tree);
        const flatFiles = new Map<string, FileNode>();
        flattenTree(tree, flatFiles);
        const openTabs = get().openTabs.filter((tab) => !targets.some((path) => tab.path === path || tab.path.startsWith(path + "/")));
        const activeTabId = openTabs.some((tab) => tab.id === get().activeTabId) ? get().activeTabId : openTabs[openTabs.length - 1]?.id || null;
        set({ fileTree: tree, flatFiles, openTabs, activeTabId, selectedPaths: new Set(), selectionMode: false, batchOperation: null });
        void get().saveWorkspaceToBackend();
    },
    renameNode: (path, newName) => {
        const parentPath = path.substring(0, path.lastIndexOf("/"));
        const newPath = `${parentPath}/${newName}`;
        renameFileContent(path, newPath);
        const tree = renameNodeAtPath(get().fileTree, path, newName, newPath);
        const map = new Map<string, FileNode>();
        flattenTree(tree, map);
        const openTabs = get().openTabs.map((t) => t.path === path ? { ...t, path: newPath, name: newName, language: getLanguage(newName) } : t);
        set({ fileTree: tree, flatFiles: map, openTabs, renameNodeId: null });
        void get().saveWorkspaceToBackend();
    },
    updateFileContent: (path, content) => {
        saveFileContent(path, content);
        const tree = updateContentAtPath(get().fileTree, path, content);
        const map = new Map<string, FileNode>();
        flattenTree(tree, map);
        const openTabs = get().openTabs.map((t) => t.path === path ? { ...t, modified: true } : t);
        set({ fileTree: tree, flatFiles: map, openTabs });
        if (get().settings.preview.autoRefresh) {
            const ext = path.split(".").pop()?.toLowerCase();
            if (["html", "css", "js", "jsx", "ts", "tsx"].includes(ext || ""))
                get().refreshPreview();
        }
    },
    setFileAssetData: (path, assetData) => {
        const tree = updateAssetDataAtPath(get().fileTree, path, assetData);
        const map = new Map<string, FileNode>();
        flattenTree(tree, map);
        set({ fileTree: tree, flatFiles: map, previewKey: get().previewKey + 1 });
    },
    moveNodes: (paths, toFolderPath) => {
        const targets = compactPaths(paths);
        if (!targets.length)
            return false;
        const map = new Map<string, FileNode>();
        flattenTree(get().fileTree, map);
        const nodes = targets.map((path) => map.get(path)).filter((node): node is FileNode => Boolean(node));
        if (!nodes.length || nodes.some((node) => toFolderPath === node.path || toFolderPath.startsWith(node.path + "/")))
            return false;
        let tree = get().fileTree;
        nodes.forEach((node) => { tree = deleteNodeAtPath(tree, node.path); });
        const replacements = new Map<string, string>();
        nodes.forEach((node) => {
            const nextPath = uniqueChildPath(tree, toFolderPath, node.name);
            collectFilePaths(node).forEach((oldPath) => replacements.set(oldPath, nextPath + oldPath.slice(node.path.length)));
            tree = insertNodeAtPath(tree, toFolderPath, rebaseNode(node, nextPath, false));
        });
        replacements.forEach((nextPath, oldPath) => renameFileContent(oldPath, nextPath));
        const flatFiles = new Map<string, FileNode>();
        flattenTree(tree, flatFiles);
        const openTabs = get().openTabs.map((tab) => {
            const path = replacements.get(tab.path);
            return path ? { ...tab, path, name: path.split("/").pop() || tab.name } : tab;
        });
        set({ fileTree: tree, flatFiles, openTabs, selectedPaths: new Set(), selectionMode: false, batchOperation: null });
        void get().saveWorkspaceToBackend();
        return true;
    },
    moveNode: (fromPath, toFolderPath) => {
        get().moveNodes([fromPath], toFolderPath);
    },
    copyNodes: (paths, toFolderPath) => {
        const targets = compactPaths(paths);
        if (!targets.length)
            return false;
        const map = new Map<string, FileNode>();
        flattenTree(get().fileTree, map);
        const nodes = targets.map((path) => map.get(path)).filter((node): node is FileNode => Boolean(node));
        if (!nodes.length || nodes.some((node) => toFolderPath === node.path || toFolderPath.startsWith(node.path + "/")))
            return false;
        let tree = get().fileTree;
        nodes.forEach((node) => {
            const nextPath = uniqueChildPath(tree, toFolderPath, node.name);
            const copy = rebaseNode(node, nextPath, true);
            saveAllFileContents([copy]);
            tree = insertNodeAtPath(tree, toFolderPath, copy);
        });
        const flatFiles = new Map<string, FileNode>();
        flattenTree(tree, flatFiles);
        set({ fileTree: tree, flatFiles, selectedPaths: new Set(), selectionMode: false, batchOperation: null });
        void get().saveWorkspaceToBackend();
        return true;
    },
    openTab: (node) => {
        const existing = get().openTabs.find((t) => t.path === node.path);
        if (existing) {
            set({ activeTabId: existing.id, activePanel: "editor" });
            return;
        }
        const tab: Tab = {
            id: generateId(), fileId: node.id, path: node.path, name: node.name,
            modified: false, language: node.language || getLanguage(node.name),
        };
        set({ openTabs: [...get().openTabs, tab], activeTabId: tab.id, activePanel: "editor" });
    },
    closeTab: (tabId) => {
        const tabs = get().openTabs.filter((t) => t.id !== tabId);
        const activeTabId = get().activeTabId === tabId
            ? tabs[tabs.length - 1]?.id || null
            : get().activeTabId;
        set({ openTabs: tabs, activeTabId });
    },
    setActiveTab: (tabId) => set({ activeTabId: tabId }),
    markTabModified: (tabId, modified) => {
        set({ openTabs: get().openTabs.map((t) => t.id === tabId ? { ...t, modified } : t) });
    },
    setActivePanel: (panel) => set({ activePanel: panel }),
    setTerminalType: (type) => set({ terminalType: type }),
    addTerminalLine: (line) => {
        const newLine: TerminalLine = { ...line, id: generateId(), timestamp: Date.now() };
        set({ terminalLines: [...get().terminalLines.slice(-500), newLine] });
    },
    clearTerminal: () => set({
        terminalLines: [{ id: generateId(), type: "info", content: "Terminal cleared.", timestamp: Date.now() }],
    }),
    setTerminalInput: (input) => set({ terminalInput: input }),
    addAIChatMessage: (message) => {
        const msg: AIChatMessage = { ...message, id: generateId(), timestamp: Date.now() };
        set({ aiChatMessages: [...get().aiChatMessages.slice(-99), msg] });
    },
    setAIChatDraft: (draft) => set({ aiChatDraft: draft }),
    setAIAttachmentPaths: (paths) => set({ aiAttachmentPaths: Array.from(new Set(paths)).slice(0, 12) }),
    clearAIChat: () => set({ aiChatMessages: [] }),
    setAIChatOpen: (open) => set({ aiChatOpen: open }),
    setAITyping: (typing) => set({ aiTyping: typing }),
    setPreviewContent: (html) => set({ previewContent: html }),
    setPreviewPath: (path) => set({ previewPath: path }),
    refreshPreview: () => set((s) => ({ previewKey: s.previewKey + 1 })),
    setPreviewResult: (result) => set({ previewResult: result }),
    setGuiDisplay: (session) => set({ guiDisplay: session }),
    setApkWorkspace: (workspace) => set({ apkWorkspace: workspace }),
    setContextMenu: (menu) => set({ contextMenu: menu }),
    toggleFolder: (path) => {
        const expanded = new Set(get().expandedFolders);
        if (expanded.has(path))
            expanded.delete(path);
        else
            expanded.add(path);
        set({ expandedFolders: expanded });
    },
    setSidebarOpen: (open) => set({ sidebarOpen: open }),
    setIsRunning: (running) => set({ isRunning: running }),
    setRenameNodeId: (id) => set({ renameNodeId: id }),
    setNewItem: (parentId, type) => set({ newItemParentId: parentId, newItemType: type }),
    updateSettings: (s) => set({ settings: { ...get().settings, ...s } }),
    updateEditorSettings: (s) => set({ settings: { ...get().settings, editor: { ...get().settings.editor, ...s } } }),
    updateAISettings: (s) => set({ settings: { ...get().settings, ai: { ...get().settings.ai, ...s } } }),
    updateStorageSettings: (s) => set({ settings: { ...get().settings, storage: { ...get().settings.storage, ...s } } }),
    updateGithubSettings: (s) => set({ settings: { ...get().settings, github: { ...get().settings.github, ...s } } }),
    updatePreviewSettings: (s) => set({ settings: { ...get().settings, preview: { ...get().settings.preview, ...s } } }),
    setShowSettings: (show) => set({ showSettings: show }),
    setSettingsTab: (tab) => set({ settingsTab: tab }),
    importFiles: (files) => {
        if (!files.length)
            return;
        saveAllFileContents(files);
        const tree = [...get().fileTree, ...files];
        const map = new Map<string, FileNode>();
        flattenTree(tree, map);
        const expanded = new Set(get().expandedFolders);
        if (files[0].type === "folder")
            expanded.add(files[0].path);
        set({ fileTree: tree, flatFiles: map, expandedFolders: expanded });
        void get().saveWorkspaceToBackend();
    },
    setDragOver: (id) => set({ dragOverId: id }),
    saveWorkspaceToBackend: async () => {
        const { fileTree, settings } = get();
        if (!settings.backend.enabled)
            return;
        scheduleWholeWorkspaceMirror(fileTree, "three-days", 1800);
    },
    loadWorkspaceFromBackend: async () => {
        const restoredTree = await restoreIndexedContent(get().fileTree);
        const map = new Map<string, FileNode>();
        flattenTree(restoredTree, map);
        set({ fileTree: restoredTree, flatFiles: map });
    },
    setTerminalBridgeCmd: (cmd) => set({ terminalBridgeCmd: cmd }),
    openInTerminal: (path, isFolder, termType) => {
        const dirPath = isFolder
            ? path
            : path.lastIndexOf("/") > 0
                ? path.substring(0, path.lastIndexOf("/"))
                : "/";
        const workspacePath = dirPath === "/" ? "/workspace" : `/workspace${dirPath}`;
        const command = `cd '${workspacePath.replace(/'/g, `"'"'`)}'`;
        set({
            terminalBridgeCmd: { cmd: command, targetType: termType || "shell", newTab: true },
            activePanel: "terminal",
            sidebarOpen: false,
        });
    },
    openFileInTerminal: (filePath, engine) => {
        const command = workspaceDirectoryCommand(filePath);
        set({
            activePanel: "terminal",
            sidebarOpen: false,
            terminalBridgeCmd: {
                cmd: command,
                targetType: engine,
                newTab: true,
            },
        });
    },
    setErrors: (errors) => set({ errors }),
    setSelectionMode: (enabled) => set({ selectionMode: enabled, selectedPaths: enabled ? get().selectedPaths : new Set(), batchOperation: null }),
    toggleSelectedPath: (path) => set((state) => {
        const selectedPaths = new Set(state.selectedPaths);
        if (selectedPaths.has(path))
            selectedPaths.delete(path);
        else
            selectedPaths.add(path);
        return { selectedPaths, selectionMode: selectedPaths.size > 0 };
    }),
    clearSelectedPaths: () => set({ selectedPaths: new Set(), selectionMode: false, batchOperation: null }),
    setBatchOperation: (operation) => set({ batchOperation: operation }),
    setTransferStatus: (status) => set({ transferStatus: status }),
}), {
    name: "sk-coder-ide-v3",
    storage: createJSONStorage(() => resilientStorage),
    partialize: (state) => ({
        fileTree: stripContent(state.fileTree),
        previewPath: state.previewPath,
        apkWorkspace: state.apkWorkspace,
        openTabs: state.openTabs,
        activeTabId: state.activeTabId,
        expandedFolders: Array.from(state.expandedFolders),
        settings: state.settings,
        terminalType: state.terminalType,
        aiChatMessages: state.aiChatMessages.slice(-50),
        aiChatDraft: state.aiChatDraft,
        aiAttachmentPaths: state.aiAttachmentPaths,
    }),
    merge: (persisted: unknown, current) => {
        const p = persisted as Partial<IDEState & {
            expandedFolders: string[];
        }>;
        const rawTree = Array.isArray(p.fileTree) ? p.fileTree : [];
        const restoredTree = restoreContent(rawTree);
        const map = new Map<string, FileNode>();
        flattenTree(restoredTree, map);
        return {
            ...current,
            ...p,
            settings: {
                ...current.settings,
                ...(p.settings ?? {}),
                backend: { ...current.settings.backend, ...(p.settings?.backend ?? {}) },
                editor: { ...current.settings.editor, ...(p.settings?.editor ?? {}) },
                ai: { ...current.settings.ai, ...(p.settings?.ai ?? {}) },
                storage: { ...current.settings.storage, ...(p.settings?.storage ?? {}) },
                github: { ...current.settings.github, ...(p.settings?.github ?? {}) },
                preview: { ...current.settings.preview, ...(p.settings?.preview ?? {}) },
            },
            fileTree: restoredTree,
            flatFiles: map,
            expandedFolders: new Set(Array.isArray(p.expandedFolders) ? p.expandedFolders : []),
            terminalLines: INIT_LINES,
            previewContent: "",
            previewResult: null,
            guiDisplay: null,
            contextMenu: null,
            aiTyping: false,
            isRunning: false,
            aiChatMessages: Array.isArray(p.aiChatMessages) ? p.aiChatMessages.slice(-30) : [],
            aiChatDraft: typeof p.aiChatDraft === "string" ? p.aiChatDraft : "",
            aiAttachmentPaths: Array.isArray(p.aiAttachmentPaths) ? p.aiAttachmentPaths.filter((path): path is string => typeof path === "string") : [],
        };
    },
    onRehydrateStorage: () => (state) => {
        if (!state)
            return;
        void restoreIndexedContent(state.fileTree).then((fileTree) => {
            const flatFiles = new Map<string, FileNode>();
            flattenTree(fileTree, flatFiles);
            useIDEStore.setState({ fileTree, flatFiles });
        });
    },
}));
