import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { useIDEStore } from "@/store/ideStore";
import { deleteBrowserBlob, loadBrowserBlob, storeBrowserBlob } from "@/lib/browserStorage";
import { beginWorkspaceStage, buildApkJob, commitWorkspaceStage, createApkJob, createWorkspace, downloadApkArtifact, getApkDecodedEntry, getApkJob, getApkDecodedEntries, isBackendAvailable, updateApkDecodedEntry, uploadWorkspaceStageChunk, type ApkJob } from "@/lib/backendRunner";
import { readApkManifestMetadata, updateApkManifestMetadata, type ApkManifestMetadataField } from "@/lib/apkManifest";
import { closeAfterDraftSave } from "@/lib/apkDraftClose";
import { isReadableArchiveText, isTextFilename } from "@/lib/archiveText";
import { getArchiveArtifactStatus } from "@/lib/archiveArtifactStatus";
import { describeBrowserStorageError } from "@/lib/browserStorageStatus";
interface ApkFile {
    name: string;
    path: string;
    size: number;
    isText: boolean;
    isDir: boolean;
}
interface ArchiveFrame {
    name: string;
    zip: ZipInstance;
    files: ApkFile[];
    parentEntryPath: string;
    modified: Set<string>;
}
interface PackageDetailsDraft {
    appLabel: string;
    packageName: string;
    appIcon: string;
    versionCode: string;
    versionName: string;
    minSdkVersion: string;
    targetSdkVersion: string;
    installLocation: "auto" | "internalOnly" | "preferExternal";
}
interface LocalStorageSummary {
    usage: number;
    quota: number;
    persistent: boolean;
}
function packageDetailsFromManifest(metadata: ReturnType<typeof readApkManifestMetadata>): PackageDetailsDraft {
    const installLocation = metadata.installLocation === "internalOnly" || metadata.installLocation === "preferExternal" ? metadata.installLocation : "auto";
    return { ...metadata, installLocation };
}
const EMPTY_PACKAGE_DETAILS: PackageDetailsDraft = {
    appLabel: "",
    packageName: "",
    appIcon: "",
    versionCode: "",
    versionName: "",
    minSdkVersion: "",
    targetSdkVersion: "",
    installLocation: "auto",
};
type ApkEditMode = "full" | "simple" | "common" | "xml";
type ApkWorkspaceView = "files" | "strings" | "manifest" | "resources" | "languages" | "advanced";
type DecodeLevel = "inspect" | "resources" | "full";
interface ZipEntry {
    async: (type: "string" | "uint8array") => Promise<string | Uint8Array>;
    _data?: {
        uncompressedSize?: number;
        compressedSize?: number;
    };
}
interface ZipInstance {
    file(n: string): ZipEntry | null | undefined;
    file(n: string, content: string | Uint8Array): void;
    remove(path: string): void;
    generateAsync(opts: unknown): Promise<Blob>;
    forEach(cb: (path: string, entry: {
        dir: boolean;
        _data?: {
            uncompressedSize?: number;
        };
    }) => void): void;
}
type RememberedApkWorkspace = {
    blobId: string;
    name: string;
    zip: ZipInstance;
    files: ApkFile[];
    expanded: Set<string>;
    modified: Set<string>;
    packageDetails: PackageDetailsDraft;
    detectedPackageDetails: PackageDetailsDraft | null;
};
let rememberedApkWorkspace: RememberedApkWorkspace | null = null;
function isImageFile(name: string): boolean {
    return /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
}
function isNestedArchive(name: string): boolean {
    return /\.(?:zip|jar|aar|apk|xapk|apks)$/i.test(name);
}
function isArchiveFile(file: File): boolean {
    const lower = file.name.toLowerCase();
    return /\.(?:apk|xapk|apks|zip|jar|aar|war|ear)$/i.test(lower) || ["application/vnd.android.package-archive", "application/zip", "application/java-archive", "application/octet-stream"].includes(file.type);
}
function imageMimeType(name: string): string {
    const ext = name.split(".").pop()?.toLowerCase() ?? "png";
    if (ext === "jpg")
        return "image/jpeg";
    if (ext === "svg")
        return "image/svg+xml";
    return `image/${ext}`;
}
function humanSize(bytes: number): string {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1048576)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}
function entryState(file: ApkFile): { label: string; detail: string } {
    if (file.isText) return { label: "Editable text", detail: "Open and save this entry directly in the package draft." };
    if (isImageFile(file.path)) return { label: "Image resource", detail: "Preview this image and replace it from this device." };
    if (isNestedArchive(file.path)) return { label: "Nested archive", detail: "Open it as a child package, then return through the breadcrumb." };
    if (/\.(?:dex|arsc|so|rsa|dsa|sf|mf)$/i.test(file.path)) return { label: "Compiled or signed entry", detail: "Keep, inspect, or replace this entry. Decoding is required before text editing." };
    return { label: "Binary entry", detail: "Replace this file from this device to include it in the local package draft." };
}
async function createJSZip(): Promise<new () => ZipInstance & {
    loadAsync: (data: ArrayBuffer) => Promise<ZipInstance>;
}> {
    const mod = await import("jszip");
    return ((mod as unknown as {
        default: unknown;
    }).default ?? mod) as new () => ZipInstance & {
        loadAsync: (data: ArrayBuffer) => Promise<ZipInstance>;
    };
}
function ApkIcon({ size = 16, color = "currentColor" }: {
    size?: number;
    color?: string;
}) {
    return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8">
      <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
      <path d="M12 18h.01"/>
      <path d="M9 6h6"/>
      <path d="M9 10h6"/>
      <path d="M9 14h4"/>
    </svg>);
}
function AndroidIcon({ size = 14, color = "currentColor" }: {
    size?: number;
    color?: string;
}) {
    return (<svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none">
      <path d="M17.523 15.341a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm-11.046 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM15.65 4.826l1.521-2.634a.5.5 0 0 0-.866-.5l-1.54 2.668A8.943 8.943 0 0 0 12 4c-.96 0-1.882.156-2.742.434L7.695 1.692a.5.5 0 0 0-.866.5L8.35 4.826C5.84 6.124 4 8.617 4 11.5h16c0-2.883-1.84-5.376-4.35-6.674z"/>
    </svg>);
}
function getFileIcon(path: string, isText: boolean): string {
    const lower = path.toLowerCase();
    if (lower.endsWith(".xml"))
        return "📋";
    if (lower.endsWith(".smali"))
        return "⚙";
    if (lower.endsWith(".dex"))
        return "◈";
    if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".webp") || lower.endsWith(".gif"))
        return "🖼";
    if (lower.endsWith(".so"))
        return "⬡";
    if (lower.endsWith(".jar") || lower.endsWith(".aar"))
        return "📦";
    if (lower.endsWith(".json"))
        return "{ }";
    if (lower.endsWith(".kotlin_module") || lower.endsWith(".kt"))
        return "K";
    if (lower.endsWith(".java"))
        return "J";
    if (lower.endsWith(".arsc"))
        return "R";
    if (lower.endsWith(".mf") || lower.endsWith(".sf") || lower.endsWith(".rsa") || lower.endsWith(".dsa"))
        return "🔑";
    if (isText)
        return "📄";
    return "⬜";
}
function buildFolderTree(files: ApkFile[]): Map<string, ApkFile[]> {
    const tree = new Map<string, ApkFile[]>();
    tree.set("", []);
    for (const f of files) {
        const parts = f.path.split("/");
        for (let i = 1; i < parts.length; i++) {
            const parent = parts.slice(0, i).join("/");
            if (!tree.has(parent))
                tree.set(parent, []);
        }
        const parent = parts.slice(0, -1).join("/");
        const arr = tree.get(parent) ?? [];
        arr.push(f);
        tree.set(parent, arr);
    }
    return tree;
}
function listArchiveFiles(zip: ZipInstance): ApkFile[] {
    const archiveFiles: ApkFile[] = [];
    zip.forEach((path, entry) => {
        if (!entry.dir) archiveFiles.push({ name: path.split("/").pop() ?? path, path, size: entry._data?.uncompressedSize ?? 0, isText: isTextFilename(path), isDir: false });
    });
    return archiveFiles.sort((a, b) => a.path.localeCompare(b.path));
}
function FolderRow({ path, depth, expanded, onToggle, children, }: {
    path: string;
    depth: number;
    expanded: boolean;
    onToggle: () => void;
    children: React.ReactNode;
}) {
    const name = path.split("/").pop() || path;
    return (<div>
      <div onClick={onToggle} style={{
            display: "flex", alignItems: "center", gap: "0.3rem",
            padding: "0.25rem 0.4rem", paddingLeft: `${0.4 + depth * 0.9}rem`,
            cursor: "pointer", userSelect: "none",
            color: "var(--text-secondary)", fontSize: 11,
            background: "transparent",
        }} onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
        <span style={{ fontSize: 10, width: 10, flexShrink: 0, color: "var(--text-muted)" }}>
          {expanded ? "▾" : "▸"}
        </span>
        <span style={{ fontSize: 12 }}>📁</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
      </div>
      {expanded && <div>{children}</div>}
    </div>);
}
export default function ApkEditor() {
    const { apkWorkspace, setApkWorkspace, setAIChatDraft, setActivePanel } = useIDEStore();
    const [files, setFiles] = useState<ApkFile[]>([]);
    const [selected, setSelected] = useState<ApkFile | null>(null);
    const [editContent, setEditContent] = useState("");
    const [apkName, setApkName] = useState("");
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [zipRef, setZipRef] = useState<{
        zip: ZipInstance;
    } | null>(null);
    const [archiveTrail, setArchiveTrail] = useState<ArchiveFrame[]>([]);
    const [expanded, setExpanded] = useState<Set<string>>(new Set(["", "META-INF", "res"]));
    const [search, setSearch] = useState("");
    const [modified, setModified] = useState<Set<string>>(new Set());
    const [imagePreview, setImagePreview] = useState("");
    const [imagePreviewError, setImagePreviewError] = useState("");
    const [launcherIconPreview, setLauncherIconPreview] = useState("");
    const [editMode, setEditMode] = useState<ApkEditMode>("full");
    const [workspaceView, setWorkspaceView] = useState<ApkWorkspaceView>("files");
    const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
    const [showModeChooser, setShowModeChooser] = useState(false);
    const [showDecodeChooser, setShowDecodeChooser] = useState(false);
    const [showReleaseReview, setShowReleaseReview] = useState(false);
    const [decodeLevel, setDecodeLevel] = useState<DecodeLevel>("inspect");
    const [showExitDialog, setShowExitDialog] = useState(false);
    const [searchScope, setSearchScope] = useState<"path" | "extension" | "text">("path");
    const [draftSaved, setDraftSaved] = useState(false);
    const [apkJob, setApkJob] = useState<ApkJob | null>(null);
    const [decodedEntryCount, setDecodedEntryCount] = useState<number | null>(null);
    const [decodedFiles, setDecodedFiles] = useState<ApkFile[]>([]);
    const [decodedWorkspace, setDecodedWorkspace] = useState(false);
    const [selectedSource, setSelectedSource] = useState<"archive" | "decoded">("archive");
    const [backendReady, setBackendReady] = useState(false);
    const [loadStage, setLoadStage] = useState("Ready to open a package");
    const [loadProgress, setLoadProgress] = useState(0);
    const [loadError, setLoadError] = useState("");
    const [artifactStage, setArtifactStage] = useState("");
    const [artifactProgress, setArtifactProgress] = useState(0);
    const [storageSummary, setStorageSummary] = useState<LocalStorageSummary | null>(null);
    const [packageDetails, setPackageDetails] = useState<PackageDetailsDraft>(EMPTY_PACKAGE_DETAILS);
    const [detectedPackageDetails, setDetectedPackageDetails] = useState<PackageDetailsDraft | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const replacementInputRef = useRef<HTMLInputElement>(null);
    const loadVersionRef = useRef(0);
    const apkWorkspaceAccessRef = useRef<string | null>(null);
    const activeFiles = decodedWorkspace ? decodedFiles : files;
    const folderTree = useMemo(() => buildFolderTree(activeFiles), [activeFiles]);
    const manifestDetails = useMemo(() => {
        if (!decodedWorkspace || !selected?.isText || !/AndroidManifest\.xml$/i.test(selected.path)) return null;
        return readApkManifestMetadata(editContent);
    }, [decodedWorkspace, editContent, selected]);
    const activePackageDetails = manifestDetails ?? packageDetails;
    const detectedIconFile = useMemo(() => {
        const resource = activePackageDetails.appIcon.replace(/^@(?:mipmap|drawable)\//i, "").replace(/\.[^.]+$/, "").toLowerCase();
        if (!resource) return null;
        return files.find((file) => isImageFile(file.path) && file.path.split("/").pop()?.replace(/\.[^.]+$/, "").toLowerCase() === resource) ?? null;
    }, [activePackageDetails.appIcon, files]);
    const hasDetectedPackageDetails = Boolean(detectedPackageDetails || manifestDetails);
    useEffect(() => {
        let url = "";
        let cancelled = false;
        if (!detectedIconFile || !zipRef) {
            setLauncherIconPreview("");
            return;
        }
        void (async () => {
            try {
                const entry = zipRef.zip.file(detectedIconFile.path);
                const bytes = entry ? (await entry.async("uint8array")) as Uint8Array : null;
                if (!bytes || cancelled) return;
                const copy = new Uint8Array(bytes.byteLength);
                copy.set(bytes);
                url = URL.createObjectURL(new Blob([copy.buffer], { type: imageMimeType(detectedIconFile.path) }));
                if (!cancelled) setLauncherIconPreview(url);
            }
            catch {
                if (!cancelled) setLauncherIconPreview("");
            }
        })();
        return () => {
            cancelled = true;
            if (url) URL.revokeObjectURL(url);
        };
    }, [detectedIconFile, zipRef]);
    const refreshBackendAvailability = useCallback(async () => {
        setBackendReady(await isBackendAvailable());
    }, []);
    const refreshStorageSummary = useCallback(async (requestPersistence = false) => {
        if (typeof navigator === "undefined" || !navigator.storage)
            return;
        try {
            if (requestPersistence && navigator.storage.persist)
                await navigator.storage.persist();
            const [estimate, persistent] = await Promise.all([
                navigator.storage.estimate(),
                navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(false),
            ]);
            setStorageSummary({ usage: estimate.usage ?? 0, quota: estimate.quota ?? 0, persistent });
        }
        catch {
            setStorageSummary(null);
        }
    }, []);
    function toggleFolder(path: string) {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(path))
                next.delete(path);
            else
                next.add(path);
            return next;
        });
    }
    const loadApk = useCallback(async (file: File, persistWorkspace = true, restoredWorkspace?: NonNullable<typeof apkWorkspace>, loadVersion = ++loadVersionRef.current) => {
        setLoading(true);
        setModified(new Set());
        setLoadError("");
        setLoadProgress(1);
        setLoadStage(`Reading ${file.name}`);
        try {
            const JSZip = await createJSZip();
            const zip = new JSZip();
            const buf = await file.arrayBuffer();
            setLoadProgress(1);
            setLoadStage("Indexing package entries");
            const loaded = await zip.loadAsync(buf);
            if (loadVersion !== loadVersionRef.current)
                return;
            const apkFiles = listArchiveFiles(loaded as ZipInstance);
            let archiveMetadata: PackageDetailsDraft | null = null;
            const readableManifest = apkFiles.find((entry) => entry.isText && /(?:^|\/)AndroidManifest\.xml$/i.test(entry.path));
            if (readableManifest) {
                try {
                    const source = (await loaded.file(readableManifest.path)?.async("string")) as string | undefined;
                    if (source) {
                        const metadata = packageDetailsFromManifest(readApkManifestMetadata(source));
                        if (metadata.packageName || metadata.appLabel || metadata.versionCode || metadata.versionName)
                            archiveMetadata = metadata;
                    }
                }
                catch {
                    archiveMetadata = null;
                }
            }
            setLoadProgress(1);
            setLoadStage("Preparing local package workspace");
            setFiles(apkFiles);
            setArchiveTrail([]);
            setDecodedFiles([]);
            setDecodedWorkspace(false);
            setSelectedSource("archive");
            setApkName(file.name);
            setEditMode("full");
            setWorkspaceView("files");
            setShowModeChooser(false);
            setShowDecodeChooser(false);
            setDecodeLevel("inspect");
            setSelectedPaths(new Set());
            setDraftSaved(false);
            setSelected(null);
            setEditContent("");
            setZipRef({ zip: loaded as ZipInstance });
            setDetectedPackageDetails(archiveMetadata);
            setPackageDetails(restoredWorkspace?.packageDetails ?? archiveMetadata ?? EMPTY_PACKAGE_DETAILS);
            if (persistWorkspace) {
                try {
                    setLoadProgress(1);
                    setLoadStage("Saving a local recovery draft");
                    const blobId = await storeBrowserBlob(file);
                    if (loadVersion !== loadVersionRef.current) {
                        void deleteBrowserBlob(blobId);
                        return;
                    }
                    const previousBlobId = useIDEStore.getState().apkWorkspace?.blobId;
                    setApkWorkspace({ blobId, name: file.name, size: file.size, updatedAt: Date.now(), editMode: "full", modeSelected: true, packageDetails: archiveMetadata ?? EMPTY_PACKAGE_DETAILS });
                    if (previousBlobId && previousBlobId !== blobId)
                        void deleteBrowserBlob(previousBlobId);
                }
                catch (error) {
                    const message = describeBrowserStorageError(error, "save a local recovery draft");
                    setLoadError(message);
                    toast.error(message);
                }
            }
            const rootFolders = new Set<string>([""]);
            for (const f of apkFiles) {
                const parts = f.path.split("/");
                if (parts.length > 1)
                    rootFolders.add(parts[0]);
            }
            setExpanded(new Set(Array.from(rootFolders).slice(0, 6)));
            setLoadProgress(100);
            setLoadStage(`${apkFiles.length} entries ready`);
            void refreshStorageSummary(true);
            toast.success(`Loaded ${apkFiles.length} files from ${file.name}`);
        }
        catch (e) {
            if (loadVersion === loadVersionRef.current) {
                setLoadProgress(0);
                setLoadStage("Package could not be opened");
                setLoadError(e instanceof Error ? e.message : "This file is not a readable ZIP-family package.");
                toast.error(`Failed to open APK: ${String(e).slice(0, 80)}`);
            }
        }
        finally {
            if (loadVersion === loadVersionRef.current)
                setLoading(false);
        }
    }, []);
    useEffect(() => {
        if (!apkWorkspace || zipRef || loading)
            return;
        if (rememberedApkWorkspace?.blobId === apkWorkspace.blobId) {
            setZipRef({ zip: rememberedApkWorkspace.zip });
            setFiles(rememberedApkWorkspace.files);
            setApkName(rememberedApkWorkspace.name);
            setExpanded(new Set(rememberedApkWorkspace.expanded));
            setModified(new Set(rememberedApkWorkspace.modified));
            setPackageDetails(rememberedApkWorkspace.packageDetails);
            setDetectedPackageDetails(rememberedApkWorkspace.detectedPackageDetails);
            setLoadError("");
            setLoadProgress(100);
            setLoadStage(`${rememberedApkWorkspace.files.length} entries ready`);
            return;
        }
        const loadVersion = ++loadVersionRef.current;
        void loadBrowserBlob(apkWorkspace.blobId).then((blob) => {
            if (loadVersion !== loadVersionRef.current)
                return;
            if (!blob) {
                setApkWorkspace(null);
                toast.error("The saved APK workspace file is no longer available in this browser.");
                return;
            }
            void loadApk(new File([blob], apkWorkspace.name, { type: "application/vnd.android.package-archive" }), false, apkWorkspace, loadVersion);
        });
    }, [apkWorkspace, zipRef, loading, loadApk, setApkWorkspace]);
    useEffect(() => {
        if (!apkWorkspace || !zipRef || decodedWorkspace)
            return;
        rememberedApkWorkspace = {
            blobId: apkWorkspace.blobId,
            name: apkName,
            zip: zipRef.zip,
            files,
            expanded: new Set(expanded),
            modified: new Set(modified),
            packageDetails,
            detectedPackageDetails,
        };
    }, [apkWorkspace, apkName, decodedWorkspace, detectedPackageDetails, expanded, files, modified, packageDetails, zipRef]);
    useEffect(() => {
        void refreshBackendAvailability();
        const timer = window.setInterval(() => void refreshBackendAvailability(), 15000);
        return () => window.clearInterval(timer);
    }, [refreshBackendAvailability]);
    useEffect(() => {
        void refreshStorageSummary();
    }, [refreshStorageSummary]);
    useEffect(() => {
        if (!apkJob || !["queued", "running"].includes(apkJob.status)) return;
        const timer = window.setInterval(() => {
            void getApkJob(apkJob.id, apkWorkspaceAccessRef.current ?? undefined).then((job) => {
                setApkJob(job);
                if (job.status === "complete" && job.mode !== "inspect") void getApkDecodedEntries(job.id, apkWorkspaceAccessRef.current ?? undefined).then((result) => setDecodedEntryCount(result.entries.length)).catch(() => setDecodedEntryCount(null));
            }).catch((error) => setApkJob((previous) => previous ? { ...previous, status: "failed", error: error instanceof Error ? error.message : "APK job status could not be loaded." } : previous));
        }, 1800);
        return () => window.clearInterval(timer);
    }, [apkJob]);
    async function openDecodedWorkspace() {
        if (!apkJob || apkJob.status !== "complete" || apkJob.mode === "inspect") {
            toast.error("Complete a resource or full decode before opening decoded files.");
            return;
        }
        setLoading(true);
        try {
            const result = await getApkDecodedEntries(apkJob.id, apkWorkspaceAccessRef.current ?? undefined);
            const entries = result.entries.map((path) => ({ name: path.split("/").pop() || path, path, size: 0, isText: isTextFilename(path), isDir: false }));
            setDecodedFiles(entries);
            setDecodedWorkspace(true);
            setSelected(null);
            setSelectedSource("decoded");
            setEditContent("");
            setSelectedPaths(new Set());
            setWorkspaceView("manifest");
            setSearch("");
            toast.success(`Opened ${entries.length} decoded files`);
        }
        catch (error) {
            toast.error(error instanceof Error ? error.message : "Decoded APK files could not be opened.");
        }
        finally {
            setLoading(false);
        }
    }
    function returnToArchiveWorkspace() {
        setDecodedWorkspace(false);
        setSelected(null);
        setSelectedSource("archive");
        setEditContent("");
        setSelectedPaths(new Set());
        setWorkspaceView("files");
        setSearch("");
    }
    async function openNestedArchive() {
        if (!selected || selectedSource !== "archive" || !zipRef || !isNestedArchive(selected.path)) return;
        setLoading(true);
        try {
            const entry = zipRef.zip.file(selected.path);
            if (!entry) throw new Error("The selected archive entry is no longer available.");
            const bytes = (await entry.async("uint8array")) as Uint8Array;
            const copy = new Uint8Array(bytes.byteLength);
            copy.set(bytes);
            const JSZip = await createJSZip();
            const nested = await new JSZip().loadAsync(copy.buffer);
            setArchiveTrail((previous) => [...previous, { name: apkName, zip: zipRef.zip, files, parentEntryPath: selected.path, modified: new Set(modified) }]);
            setZipRef({ zip: nested as ZipInstance });
            setFiles(listArchiveFiles(nested as ZipInstance));
            setApkName(selected.name);
            setModified(new Set());
            setSelected(null);
            setSelectedPaths(new Set());
            setEditContent("");
            setImagePreview("");
            setWorkspaceView("files");
            setSearch("");
            setDraftSaved(false);
            toast.success(`Opened nested archive ${selected.name}`);
        }
        catch (error) {
            toast.error(error instanceof Error ? error.message : "This archive entry could not be opened.");
        }
        finally {
            setLoading(false);
        }
    }
    async function returnToParentArchive() {
        const frame = archiveTrail[archiveTrail.length - 1];
        if (!frame || !zipRef) return;
        setLoading(true);
        try {
            const childChanged = modified.size > 0;
            if (childChanged) {
                const child = await zipRef.zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
                const bytes = new Uint8Array(await child.arrayBuffer());
                frame.zip.file(frame.parentEntryPath, bytes);
            }
            const parentModified = new Set(frame.modified);
            if (childChanged) parentModified.add(frame.parentEntryPath);
            setZipRef({ zip: frame.zip });
            setFiles(listArchiveFiles(frame.zip));
            setArchiveTrail((previous) => previous.slice(0, -1));
            setApkName(frame.name);
            setModified(parentModified);
            setSelected(null);
            setSelectedPaths(new Set());
            setEditContent("");
            setImagePreview("");
            setWorkspaceView("files");
            setSearch("");
            setDraftSaved(false);
            toast.success(childChanged ? "Saved nested archive changes into the parent draft" : "Returned to the parent archive");
        }
        catch (error) {
            toast.error(error instanceof Error ? error.message : "Unable to return to the parent archive.");
        }
        finally {
            setLoading(false);
        }
    }
    function updateManifestMetadata(field: ApkManifestMetadataField, value: string) {
        setEditContent((current) => updateApkManifestMetadata(current, field, value));
    }
    function updatePackageDetail(field: keyof PackageDetailsDraft, value: string) {
        if (manifestDetails) {
            updateManifestMetadata(field as ApkManifestMetadataField, value);
            return;
        }
        const next = { ...packageDetails, [field]: value } as PackageDetailsDraft;
        setPackageDetails(next);
        const workspace = useIDEStore.getState().apkWorkspace;
        if (workspace) setApkWorkspace({ ...workspace, packageDetails: next, updatedAt: Date.now() });
    }
    function clearLocalPackageDetails() {
        setPackageDetails(EMPTY_PACKAGE_DETAILS);
        const workspace = useIDEStore.getState().apkWorkspace;
        if (workspace) setApkWorkspace({ ...workspace, packageDetails: EMPTY_PACKAGE_DETAILS, updatedAt: Date.now() });
    }
    function restoreDetectedPackageDetails() {
        if (!detectedPackageDetails) {
            clearLocalPackageDetails();
            toast.info("No readable package metadata was detected, so the local detail request was reset.");
            return;
        }
        if (manifestDetails) {
            let next = editContent;
            (Object.keys(detectedPackageDetails) as ApkManifestMetadataField[]).forEach((field) => {
                next = updateApkManifestMetadata(next, field, detectedPackageDetails[field]);
            });
            setEditContent(next);
            toast.success("Restored the detected manifest values.");
            return;
        }
        setPackageDetails(detectedPackageDetails);
        const workspace = useIDEStore.getState().apkWorkspace;
        if (workspace) setApkWorkspace({ ...workspace, packageDetails: detectedPackageDetails, updatedAt: Date.now() });
        toast.success("Restored the detected package values.");
    }
    function askAIAboutSelectedEntry() {
        if (!selected?.isText || !editContent.trim()) {
            toast.error("Open a readable text entry before asking the assistant.");
            return;
        }
        const source = selectedSource === "decoded" ? "decoded APK workspace" : "APK archive";
        setAIChatDraft(`Review this ${source} entry and propose the smallest safe change. Return the complete replacement text in a code block so I can review it before saving.\n\nPath: ${selected.path}\n\n\`\`\`xml\n${editContent.slice(0, 12000)}\n\`\`\``);
        setActivePanel("ai");
    }
    async function handleFileSelect(apkFile: ApkFile) {
        if (!zipRef && !decodedWorkspace)
            return;
        setSelected(apkFile);
        setSelectedSource(decodedWorkspace ? "decoded" : "archive");
        if (imagePreview)
            URL.revokeObjectURL(imagePreview);
        setImagePreview("");
        setImagePreviewError("");
        if (decodedWorkspace) {
            if (!apkFile.isText || !apkJob) {
                setEditContent("");
                return;
            }
            try {
                const entry = await getApkDecodedEntry(apkJob.id, apkFile.path, apkWorkspaceAccessRef.current ?? undefined);
                setSelected({ ...apkFile, size: entry.size });
                setEditContent(entry.content);
                if (/AndroidManifest\.xml$/i.test(apkFile.path)) setDetectedPackageDetails(packageDetailsFromManifest(readApkManifestMetadata(entry.content)));
            }
            catch (error) {
                setEditContent("");
                toast.error(error instanceof Error ? error.message : "Unable to open this decoded entry.");
            }
            return;
        }
        if (!zipRef)
            return;
        if (isImageFile(apkFile.path)) {
            try {
                const entry = zipRef.zip.file(apkFile.path);
                const bytes = entry ? (await entry.async("uint8array")) as Uint8Array : null;
                if (bytes) {
                    const copy = new Uint8Array(bytes.byteLength);
                    copy.set(bytes);
                    setImagePreview(URL.createObjectURL(new Blob([copy.buffer], { type: imageMimeType(apkFile.path) })));
                }
                else {
                    setImagePreviewError("This image entry could not be read from the package.");
                }
            }
            catch {
                setImagePreviewError("This image format could not be previewed in this browser.");
                toast.error("Unable to preview this image resource");
            }
        }
        if (!apkFile.isText) {
            setEditContent("");
            return;
        }
        try {
            const entry = zipRef.zip.file(apkFile.path);
            const content = entry ? (await entry.async("string")) as string : "";
            if (!isReadableArchiveText(content)) {
                setSelected({ ...apkFile, isText: false });
                setEditContent("");
                toast.info("This archive entry is compiled or binary. Decode it with a connected workspace before editing.");
                return;
            }
            setEditContent(content);
        }
        catch {
            setEditContent("[Binary or unreadable file]");
        }
    }
    async function saveEdit() {
        if (!selected)
            return;
        setSaving(true);
        if (selectedSource === "decoded") {
            if (!apkJob) {
                setSaving(false);
                return;
            }
            try {
                const saved = await updateApkDecodedEntry(apkJob.id, selected.path, editContent, apkWorkspaceAccessRef.current ?? undefined);
                setDecodedFiles((previous) => previous.map((file) => file.path === selected.path ? { ...file, size: saved.size } : file));
                setModified((previous) => new Set([...previous, selected.path]));
                toast.success(`Saved decoded ${selected.name}`);
            }
            catch (error) {
                toast.error(error instanceof Error ? error.message : "Could not save this decoded entry.");
            }
            finally {
                setSaving(false);
            }
            return;
        }
        if (!zipRef) {
            setSaving(false);
            return;
        }
        setTimeout(() => {
            zipRef.zip.file(selected.path, editContent);
            setModified((prev) => new Set([...prev, selected.path]));
            setSaving(false);
            toast.success(`Saved ${selected.name}`);
        }, 80);
    }
    async function replaceArchiveEntry(file: File | undefined) {
        if (!selected || !zipRef || !file)
            return;
        if (selectedSource === "decoded") {
            toast.info("Return to the archive workspace to replace files and images.");
            return;
        }
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            zipRef.zip.file(selected.path, bytes);
            if (isImageFile(selected.path) && imagePreview)
                URL.revokeObjectURL(imagePreview);
            if (isImageFile(selected.path))
                setImagePreview(URL.createObjectURL(file));
            setImagePreviewError("");
            setModified((prev) => new Set([...prev, selected.path]));
            toast.success(`Replaced ${selected.name}`);
        }
        catch {
            toast.error("Unable to replace this archive entry");
        }
    }
    function toggleSelection(path: string) {
        setSelectedPaths((previous) => {
            const next = new Set(previous);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    }
    function selectEditMode(mode: ApkEditMode) {
        setEditMode(mode);
        setShowModeChooser(false);
        setShowDecodeChooser(false);
        if (mode === "simple") setWorkspaceView("files");
        if (mode === "common") setWorkspaceView("manifest");
        if (mode === "xml") setWorkspaceView("strings");
        if (mode === "full") setWorkspaceView("files");
        const workspace = useIDEStore.getState().apkWorkspace;
        if (workspace) setApkWorkspace({ ...workspace, editMode: mode, modeSelected: true, updatedAt: Date.now() });
    }
    function startFullEdit() {
        setShowModeChooser(false);
        if (backendReady) {
            setShowDecodeChooser(true);
            return;
        }
        selectEditMode("full");
        toast.info("Full local editing is ready. Decode, rebuild, and validation appear when the backend connects.");
    }
    function chooseDecodeLevel(level: DecodeLevel) {
        setDecodeLevel(level);
        selectEditMode("full");
        if (level !== "inspect") toast.info("Decode and rebuild are ready when a workspace server is connected. Archive exploration stays available locally now.");
    }
    async function startBackendDecode(level: Exclude<DecodeLevel, "inspect">) {
        if (archiveTrail.length > 0) {
            toast.info("Return to the root APK archive before starting decode or rebuild.");
            return;
        }
        if (!backendReady) {
            toast.error("APK decode requires a connected backend. Local archive tools remain available.");
            return;
        }
        if (!zipRef) return;
        setLoading(true);
        setApkJob(null);
        setDecodedEntryCount(null);
        try {
            const blob = await zipRef.zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
            const workspace = await createWorkspace("four-hours");
            apkWorkspaceAccessRef.current = workspace.terminalAccessToken;
            const sourcePath = `apk/${apkName.replace(/[^a-zA-Z0-9._-]/g, "_") || "workspace.apk"}`;
            const stage = await beginWorkspaceStage(workspace.id, [{ path: sourcePath, size: blob.size }], undefined, undefined, workspace.terminalAccessToken);
            const staged = stage.files.find((file) => file.path === sourcePath);
            if (!staged) throw new Error("APK staging did not accept the archive path.");
            const pendingOffsets = new Set(staged.missingOffsets);
            for (let offset = 0; offset < blob.size; offset += stage.chunkBytes) {
                if (pendingOffsets.has(offset)) await uploadWorkspaceStageChunk(workspace.id, stage.stageId, sourcePath, offset, blob.slice(offset, Math.min(blob.size, offset + stage.chunkBytes)), undefined, workspace.terminalAccessToken);
            }
            await commitWorkspaceStage(workspace.id, stage.stageId, workspace.terminalAccessToken);
            const job = await createApkJob(workspace.id, sourcePath, level, workspace.terminalAccessToken);
            setApkJob(job);
            setDecodeLevel(level);
            setShowDecodeChooser(false);
            toast.success(`${level === "full" ? "Full" : "Resource"} decode started`);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "APK decode could not start.";
            setBackendReady(false);
            setApkJob((previous) => previous ?? { id: "unavailable", workspaceSessionId: "", sourcePath: "", mode: level, status: "failed", createdAt: Date.now(), expiresAt: Date.now(), log: "", error: message, artifactReady: false, artifactSigned: false });
            toast.error(message);
        }
        finally {
            setLoading(false);
        }
    }
    async function requestBackendBuild(sign = false) {
        if (archiveTrail.length > 0) {
            toast.info("Return to the root APK archive before starting a build.");
            return;
        }
        if (!backendReady) {
            toast.error("APK rebuild requires a connected backend.");
            return;
        }
        if (!apkJob || apkJob.status !== "complete" || apkJob.mode === "inspect") return;
        setLoading(true);
        try {
            toast.info("Building the decoded workspace. Archive-only edits are exported separately as an archive.");
            const suffix = sign ? "_skcoder_signed.apk" : "_skcoder_unsigned.apk";
            const next = await buildApkJob(apkJob.id, apkName.replace(/\.(apk|zip|xapk|apks)$/i, suffix), sign, apkWorkspaceAccessRef.current ?? undefined);
            setApkJob(next);
            toast.success(sign ? "Signed APK rebuild started" : "Unsigned APK rebuild started");
        }
        catch (error) {
            toast.error(error instanceof Error ? error.message : "APK rebuild could not start.");
        }
        finally {
            setLoading(false);
        }
    }
    async function openReleaseReview() {
        if (archiveTrail.length > 0) {
            toast.info("Return to the root APK archive before opening the final release review.");
            return;
        }
        if (decodedWorkspace && apkJob) {
            const manifest = decodedFiles.find((file) => /AndroidManifest\.xml$/i.test(file.path));
            if (manifest && selected?.path !== manifest.path) {
                setLoading(true);
                try {
                    const entry = await getApkDecodedEntry(apkJob.id, manifest.path, apkWorkspaceAccessRef.current ?? undefined);
                    setSelected({ ...manifest, size: entry.size });
                    setSelectedSource("decoded");
                    setEditContent(entry.content);
                    setDetectedPackageDetails(packageDetailsFromManifest(readApkManifestMetadata(entry.content)));
                    setWorkspaceView("manifest");
                }
                catch (error) {
                    toast.error(error instanceof Error ? error.message : "Unable to open the decoded manifest for release review.");
                }
                finally {
                    setLoading(false);
                }
            }
        }
        setShowReleaseReview(true);
    }
    async function extractSelected() {
        if (decodedWorkspace) {
            toast.info("Return to the archive workspace to extract archive entries.");
            return;
        }
        if (!zipRef || !selectedPaths.size) return;
        setLoading(true);
        try {
            const JSZip = await createJSZip();
            const zip = new JSZip();
            for (const path of selectedPaths) {
                const entry = zipRef.zip.file(path);
                if (entry) zip.file(path, (await entry.async("uint8array")) as Uint8Array);
            }
            const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `${apkName.replace(/\.(apk|zip|xapk|apks)$/i, "")}_selection.zip`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            toast.success(`Extracted ${selectedPaths.size} selected entries`);
        }
        catch {
            toast.error("Could not extract the selected archive entries");
        }
        finally {
            setLoading(false);
        }
    }
    function deleteSelected() {
        if (decodedWorkspace) {
            toast.info("Decoded entries can be edited as text but are not deleted from this workspace.");
            return;
        }
        if (!zipRef || !selectedPaths.size) return;
        for (const path of selectedPaths) zipRef.zip.remove(path);
        setFiles((previous) => previous.filter((file) => !selectedPaths.has(file.path)));
        setModified((previous) => new Set([...previous, ...selectedPaths]));
        setSelectedPaths(new Set());
        setSelected(null);
        setEditContent("");
        toast.success("Selected entries were removed from this local draft");
    }
    async function saveLocalDraft(): Promise<boolean> {
        if (archiveTrail.length > 0) {
            toast.info("Return to the root archive to save a browser draft. Nested changes are kept when you return to the parent.");
            return false;
        }
        if (!zipRef) return false;
        setSaving(true);
        setArtifactProgress(1);
        setArtifactStage("Preparing local package draft");
        try {
            const blob = await zipRef.zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
            setArtifactProgress(1);
            setArtifactStage("Saving package draft on this device");
            const blobId = await storeBrowserBlob(blob);
            const previousBlobId = useIDEStore.getState().apkWorkspace?.blobId;
            const workspace = useIDEStore.getState().apkWorkspace;
            setApkWorkspace({ blobId, name: apkName, size: blob.size, updatedAt: Date.now(), editMode, modeSelected: true, packageDetails });
            if (previousBlobId && previousBlobId !== blobId) void deleteBrowserBlob(previousBlobId);
            setModified(new Set());
            setDraftSaved(true);
            setArtifactProgress(100);
            setArtifactStage("Package draft saved on this device");
            void refreshStorageSummary(true);
            toast.success("APK draft saved in this browser workspace");
            return true;
        }
        catch (error) {
            const message = describeBrowserStorageError(error, "save a package draft");
            setArtifactProgress(0);
            setArtifactStage(message);
            toast.error(message);
            return false;
        }
        finally {
            setSaving(false);
        }
    }
    async function repackage() {
        if (archiveTrail.length > 0) {
            toast.info("Return to the root archive before exporting. Nested changes are inserted into the parent draft on return.");
            return;
        }
        if (!zipRef)
            return;
        setLoading(true);
        setArtifactProgress(1);
        setArtifactStage("Preparing repackaged archive");
        try {
            const blob = await zipRef.zip.generateAsync({
                type: "blob",
                compression: "DEFLATE",
                compressionOptions: { level: 6 },
            });
            setArtifactProgress(1);
            setArtifactStage("Creating download");
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = getArchiveArtifactStatus(apkName, modified.size).downloadName;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            setDraftSaved(false);
            setArtifactProgress(100);
            setArtifactStage("Repackaged archive download started");
            void refreshStorageSummary();
            toast.success("Repackaged archive download started");
        }
        catch {
            setArtifactProgress(0);
            setArtifactStage("Repackage could not be completed");
            toast.error("Failed to repackage APK");
        }
        finally {
            setLoading(false);
        }
    }
    function handleDrop(e: React.DragEvent) {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (!file) return;
        if (!isArchiveFile(file)) {
            toast.error("This file is not a valid APK, XAPK, APKS, or ZIP package.");
            return;
        }
        void loadApk(file);
    }
    function closeApk() {
        if (archiveTrail.length > 0) {
            void returnToParentArchive();
            return;
        }
        if (modified.size > 0) {
            setShowExitDialog(true);
            return;
        }
        if (imagePreview)
            URL.revokeObjectURL(imagePreview);
        setFiles([]);
        setDecodedFiles([]);
        setDecodedWorkspace(false);
        setSelected(null);
        setEditContent("");
        setApkName("");
        setZipRef(null);
        setModified(new Set());
        const blobId = useIDEStore.getState().apkWorkspace?.blobId;
        setApkWorkspace(null);
        if (blobId)
            void deleteBrowserBlob(blobId);
    }
    function discardAndClose() {
        if (imagePreview) URL.revokeObjectURL(imagePreview);
        setShowExitDialog(false);
        setFiles([]);
        setDecodedFiles([]);
        setDecodedWorkspace(false);
        setSelected(null);
        setEditContent("");
        setApkName("");
        setZipRef(null);
        setModified(new Set());
        setSelectedPaths(new Set());
        const blobId = useIDEStore.getState().apkWorkspace?.blobId;
        setApkWorkspace(null);
        if (blobId) void deleteBrowserBlob(blobId);
    }
    function keepDraftAndClose() {
        if (imagePreview) URL.revokeObjectURL(imagePreview);
        setShowExitDialog(false);
        setFiles([]);
        setDecodedFiles([]);
        setDecodedWorkspace(false);
        setSelected(null);
        setEditContent("");
        setApkName("");
        setZipRef(null);
        setModified(new Set());
        setSelectedPaths(new Set());
    }
    const modeFiles = activeFiles;
    const workspaceFiles = useMemo(() => workspaceView === "manifest"
        ? modeFiles.filter((file) => /AndroidManifest\.xml$/i.test(file.path))
        : workspaceView === "strings"
            ? modeFiles.filter((file) => /(?:^|\/)res\/values[^/]*\/.*\.xml$/i.test(file.path))
            : workspaceView === "resources"
                ? modeFiles.filter((file) => /(?:^|\/)(?:res|assets)\//i.test(file.path))
                : workspaceView === "languages"
                    ? modeFiles.filter((file) => /(?:^|\/)res\/values(?:-[^/]+)?\/.*\.xml$/i.test(file.path))
                    : workspaceView === "advanced"
                        ? modeFiles.filter((file) => /\.(?:smali|java|kt|dex|so)$/i.test(file.path))
                        : modeFiles, [modeFiles, workspaceView]);
    const filteredFiles = useMemo(() => search.trim()
        ? workspaceFiles.filter((file) => searchScope === "extension"
            ? file.name.toLowerCase().endsWith(search.trim().toLowerCase().replace(/^\./, "."))
            : file.path.toLowerCase().includes(search.toLowerCase()))
        : null, [search, searchScope, workspaceFiles]);
    function renderTree(parentPath: string, depth: number): React.ReactNode {
        const children = folderTree.get(parentPath) ?? [];
        const subFolders = new Set<string>();
        folderTree.forEach((_, key) => {
            if (key === parentPath)
                return;
            const parts = key.split("/");
            if (parts.slice(0, -1).join("/") === parentPath) {
                subFolders.add(key);
            }
        });
        const folders = Array.from(subFolders).sort();
        return (<>
        {folders.map((folderPath) => {
                const isExp = expanded.has(folderPath);
                return (<FolderRow key={folderPath} path={folderPath} depth={depth} expanded={isExp} onToggle={() => toggleFolder(folderPath)}>
              {isExp && renderTree(folderPath, depth + 1)}
            </FolderRow>);
            })}
        {children.map((f) => (<div key={f.path} onClick={() => handleFileSelect(f)} style={{
                    display: "flex", alignItems: "center", gap: "0.35rem",
                    padding: "0.25rem 0.4rem",
                    paddingLeft: `${0.4 + depth * 0.9 + 0.4}rem`,
                    cursor: "pointer",
                    background: selected?.path === f.path ? "var(--bg-active)" : "transparent",
                    borderLeft: selected?.path === f.path ? "2px solid var(--accent)" : "2px solid transparent",
                    fontSize: 11,
                    color: "var(--text-primary)",
                }} onMouseEnter={(e) => { if (selected?.path !== f.path)
                e.currentTarget.style.background = "var(--bg-hover)"; }} onMouseLeave={(e) => { if (selected?.path !== f.path)
                e.currentTarget.style.background = "transparent"; }}>
            <span style={{ fontSize: 11, flexShrink: 0 }}>{getFileIcon(f.path, f.isText)}</span>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {f.name}
            </span>
            {modified.has(f.path) && (<span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 }}/>)}
          </div>))}
      </>);
    }
    const artifactStatus = getArchiveArtifactStatus(apkName, modified.size);
    return (<div style={{ display: "flex", flexDirection: "column", height: "100%", background: "var(--bg-primary)", overflow: "hidden", position: "relative" }}>
      <div className="apk-editor-header" style={{
            display: "flex", alignItems: "center", gap: "0.5rem",
            padding: "0.5rem 0.75rem", borderBottom: "1px solid var(--border)",
            background: "var(--bg-secondary)", flexShrink: 0,
        }}>
        <AndroidIcon size={15} color="#a6e3a1"/>
        <span style={{ fontWeight: 700, fontSize: 12, color: "var(--text-primary)" }}>APK Editor</span>
        {apkName && (<span style={{ fontSize: 11, color: "var(--accent)", marginLeft: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 120 }}>
            {apkName}
          </span>)}
        {files.length > 0 && (<span style={{ fontSize: 10, color: "var(--text-muted)" }}>
            {files.length} files{modified.size > 0 ? ` · ${modified.size} modified` : ""}
          </span>)}
        {files.length > 0 && loadError && <span style={{ fontSize: 10, color: "var(--yellow)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }} title={loadError}>Local draft not saved</span>}
        <div className="apk-header-spacer" style={{ flex: 1 }}/>
        {files.length > 0 && (<div className="apk-header-actions">
            {archiveTrail.length > 0 && <button className="btn btn-ghost" onClick={() => void returnToParentArchive()} disabled={loading} style={{ fontSize: 11, padding: "0.2rem 0.55rem", flexShrink: 0 }}>
              ← Parent archive
            </button>}
            <button className="btn btn-primary" onClick={() => void openReleaseReview()} disabled={loading || archiveTrail.length > 0} title="Review package changes and repackage this archive" style={{ fontSize: 11, padding: "0.2rem 0.6rem", flexShrink: 0 }}>
              {loading ? "Preparing..." : archiveTrail.length > 0 ? "Return to package" : "Repackage"}
            </button>
            <button className="btn btn-ghost" onClick={closeApk} style={{ fontSize: 11, padding: "0.2rem 0.4rem", color: "var(--text-muted)", flexShrink: 0 }} title="Close APK">
              ✕
            </button>
          </div>)}
        {files.length === 0 && (<button className="btn btn-primary" onClick={() => inputRef.current?.click()} style={{ fontSize: 11, padding: "0.2rem 0.6rem" }}>
            Open APK / ZIP
          </button>)}
        <input ref={inputRef} type="file" accept=".apk,.zip,.xapk,.apks,.aar,.jar,.war,.ear,application/vnd.android.package-archive,application/zip,application/java-archive" style={{ display: "none" }} onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) {
                e.target.value = "";
                return;
            }
            if (!isArchiveFile(f)) {
                toast.error("This file is not a valid APK, XAPK, APKS, or ZIP package.");
                e.target.value = "";
                return;
            }
            void loadApk(f);
            e.target.value = "";
        }}/>
        <input ref={replacementInputRef} type="file" style={{ display: "none" }} onChange={(event) => {
            void replaceArchiveEntry(event.target.files?.[0]);
            event.target.value = "";
        }}/>
      </div>

      {archiveTrail.length > 0 && <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", padding: "0.32rem 0.55rem", borderBottom: "1px solid var(--border-subtle)", background: "rgba(137,180,250,0.07)", fontSize: 10, flexShrink: 0 }}>
          <button className="btn btn-ghost" onClick={() => void returnToParentArchive()} disabled={loading} style={{ fontSize: 10, padding: "0.16rem 0.38rem" }}>← {archiveTrail[archiveTrail.length - 1].name}</button>
          <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Nested archive: {apkName}. Return through this breadcrumb to insert changed child bytes into the parent draft.</span>
        </div>}

      {files.length === 0 ? (<div onDrop={handleDrop} onDragOver={(e) => e.preventDefault()} style={{
                flex: 1, display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center",
                gap: "1.25rem", cursor: "pointer", padding: "2rem",
            }} onClick={() => inputRef.current?.click()}>
          {loading ? <div style={{ width: "min(440px, 100%)", display: "grid", gap: "0.85rem", padding: "1.25rem", border: "1px solid var(--border)", borderRadius: 14, background: "var(--bg-secondary)", boxShadow: "0 14px 44px rgba(0,0,0,0.2)" }} onClick={(event) => event.stopPropagation()}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}><div><strong style={{ color: "var(--text-primary)", fontSize: 13 }}>Preparing package workspace</strong><p style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)" }}>{loadStage}</p></div><span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--accent)" }}>{loadProgress === 100 ? "Complete" : "Working locally"}</span></div>
              <div style={{ height: 7, borderRadius: 999, background: "var(--bg-primary)", overflow: "hidden" }}><div style={{ height: "100%", width: loadProgress === 100 ? "100%" : "32%", background: "linear-gradient(90deg, #89b4fa, #a6e3a1)", transition: "width 180ms ease" }}/></div>
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>The package stays on this device while its archive is indexed.</span>
            </div> : <><div style={{ position: "relative" }}>
            <div style={{
                width: 72, height: 72, borderRadius: 18,
                background: "linear-gradient(135deg, #a6e3a1 0%, #007acc 100%)",
                display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: "0 8px 32px rgba(0,122,204,0.3)",
            }}>
              <AndroidIcon size={36} color="#fff"/>
            </div>
            <div style={{
                position: "absolute", bottom: -4, right: -4,
                background: "var(--bg-elevated)", borderRadius: 8, padding: "2px 5px",
                border: "1px solid var(--border)", fontSize: 10, color: "var(--accent)",
                fontWeight: 600,
            }}>APK</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <p style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", marginBottom: 6 }}>
              {loading ? "Loading APK..." : "Open an APK File"}
            </p>
            <p style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6 }}>
              Drag & drop or click to browse<br />
              Supports .apk · .xapk · .apks · .zip
            </p>
          </div>
          <div style={{ maxWidth: 440, textAlign: "center", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.55 }}>Browse package entries, inspect images, edit readable files, and replace files directly from this device.</div>
          {loadError && <div style={{ maxWidth: 440, padding: "0.6rem 0.75rem", borderRadius: 8, background: "rgba(243,139,168,0.1)", border: "1px solid rgba(243,139,168,0.25)", color: "var(--red)", fontSize: 11, textAlign: "center", display: "grid", gap: 8 }}><span>{loadError}</span><button className="btn btn-ghost" onClick={(event) => { event.stopPropagation(); inputRef.current?.click(); }} style={{ justifySelf: "center", fontSize: 10 }}>Choose another package</button></div>}
          </>}
        </div>) : (<div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.45rem", padding: "0.48rem 0.62rem", borderBottom: "1px solid var(--border-subtle)", background: "var(--bg-secondary)", flexShrink: 0 }}>
            <strong style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>Package workspace</strong>
            <span style={{ color: "var(--text-muted)", fontSize: 10 }}>{archiveTrail.length > 0 ? "Nested package open — return through the breadcrumb to keep its changes" : "Browse files, edit readable content, replace files or images, then repackage"}</span>
          </div>
          <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden" }}>
          <div style={{ width: "38%", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ padding: "0.48rem 0.55rem", borderBottom: "1px solid var(--border-subtle)", flexShrink: 0 }}>
              <input type="text" placeholder="Find a file in this package..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ fontSize: 11, padding: "0.28rem 0.55rem", width: "100%" }}/>
            </div>
            <div style={{ flex: 1, overflowY: "auto", fontFamily: "var(--font-mono)", fontSize: 11 }}>
              {filteredFiles ? (filteredFiles.length === 0 ? (<div style={{ padding: "1rem", textAlign: "center", color: "var(--text-muted)", fontSize: 11 }}>No results</div>) : filteredFiles.map((f) => (<div key={f.path} onClick={() => handleFileSelect(f)} style={{
                    display: "flex", alignItems: "center", gap: "0.35rem",
                    padding: "0.25rem 0.5rem",
                    cursor: "pointer",
                    background: selected?.path === f.path ? "var(--bg-active)" : "transparent",
                    fontSize: 11,
                }}>
                    <span style={{ fontSize: 11 }}>{getFileIcon(f.path, f.isText)}</span>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path}</span>
                    {modified.has(f.path) && <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)" }}/>}
                  </div>))) : renderTree("", 0) }
            </div>
          </div>

          <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
            {selected ? (<>
                <div style={{ padding: "0.42rem 0.55rem", borderBottom: "1px solid var(--border-subtle)", background: "var(--bg-secondary)", flexShrink: 0, display: "grid", gap: "0.32rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: 11 }}>
                    <span style={{ fontSize: 11 }}>{getFileIcon(selected.path, selected.isText)}</span>
                    <span style={{ color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{selected.path}</span>
                    {selected.size > 0 && <span style={{ color: "var(--text-muted)", fontSize: 10, flexShrink: 0 }}>{humanSize(selected.size)}</span>}
                    {selected.isText && (<button className="btn btn-primary" onClick={saveEdit} disabled={saving} style={{ fontSize: 10, padding: "0.15rem 0.5rem", flexShrink: 0 }}>{saving ? "Saving..." : "Save"}</button>)}
                    {selectedSource === "archive" && <button className="btn btn-primary" onClick={() => replacementInputRef.current?.click()} style={{ fontSize: 10, padding: "0.15rem 0.5rem", flexShrink: 0 }}>Replace</button>}
                    {selectedSource === "archive" && isNestedArchive(selected.path) && <button className="btn btn-ghost" onClick={() => void openNestedArchive()} disabled={loading} style={{ fontSize: 10, padding: "0.15rem 0.5rem", flexShrink: 0 }}>Open archive</button>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.42rem", color: "var(--text-muted)", fontSize: 10 }}>
                    <span style={{ color: selected.isText ? "var(--green)" : "var(--accent)", fontWeight: 700 }}>{entryState(selected).label}</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entryState(selected).detail}</span>
                  </div>
                </div>
                {selected.isText ? (<>{manifestDetails && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(132px, 1fr))", gap: "0.4rem", padding: "0.45rem 0.55rem", borderBottom: "1px solid var(--border-subtle)", background: "rgba(137,180,250,0.06)" }}>
                    <label style={{ display: "grid", gap: 3, minWidth: 0, fontSize: 10, color: "var(--text-muted)" }}>App label<input value={manifestDetails.appLabel} onChange={(event) => updateManifestMetadata("appLabel", event.target.value)} placeholder="App name" style={{ fontFamily: "var(--font-mono)", fontSize: 10, minWidth: 0 }}/></label>
                    <label style={{ display: "grid", gap: 3, minWidth: 0, fontSize: 10, color: "var(--text-muted)" }}>Package name<input value={manifestDetails.packageName} onChange={(event) => updateManifestMetadata("packageName", event.target.value)} placeholder="com.example.app" style={{ fontFamily: "var(--font-mono)", fontSize: 10, minWidth: 0 }}/></label>
                    <label style={{ display: "grid", gap: 3, minWidth: 0, fontSize: 10, color: "var(--text-muted)" }}>Install location<select value={manifestDetails.installLocation} onChange={(event) => updateManifestMetadata("installLocation", event.target.value)} style={{ fontSize: 10, minWidth: 0 }}><option value="auto">Automatic</option><option value="internalOnly">Internal only</option><option value="preferExternal">Prefer external</option></select></label>
                    <label style={{ display: "grid", gap: 3, minWidth: 0, fontSize: 10, color: "var(--text-muted)" }}>Version code<input value={manifestDetails.versionCode} onChange={(event) => updateManifestMetadata("versionCode", event.target.value)} placeholder="1" style={{ fontFamily: "var(--font-mono)", fontSize: 10, minWidth: 0 }}/></label>
                    <label style={{ display: "grid", gap: 3, minWidth: 0, fontSize: 10, color: "var(--text-muted)" }}>Version name<input value={manifestDetails.versionName} onChange={(event) => updateManifestMetadata("versionName", event.target.value)} placeholder="1.0" style={{ fontFamily: "var(--font-mono)", fontSize: 10, minWidth: 0 }}/></label>
                    <label style={{ display: "grid", gap: 3, minWidth: 0, fontSize: 10, color: "var(--text-muted)" }}>Min SDK<input inputMode="numeric" value={manifestDetails.minSdkVersion} onChange={(event) => updateManifestMetadata("minSdkVersion", event.target.value)} placeholder="24" style={{ fontFamily: "var(--font-mono)", fontSize: 10, minWidth: 0 }}/></label>
                    <label style={{ display: "grid", gap: 3, minWidth: 0, fontSize: 10, color: "var(--text-muted)" }}>Target SDK<input inputMode="numeric" value={manifestDetails.targetSdkVersion} onChange={(event) => updateManifestMetadata("targetSdkVersion", event.target.value)} placeholder="35" style={{ fontFamily: "var(--font-mono)", fontSize: 10, minWidth: 0 }}/></label>
                  </div>}<textarea value={editContent} onChange={(e) => setEditContent(e.target.value)} style={{
                        flex: 1, width: "100%", background: "var(--bg-primary)", color: "var(--text-primary)",
                        border: "none", outline: "none", padding: "0.6rem 0.75rem", resize: "none",
                        fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.7,
                    }} spellCheck={false}/></>) : isImageFile(selected.path) ? (<div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "0.8rem", padding: "1rem", minHeight: 0 }}>
                    {imagePreview ? <img src={imagePreview} alt={selected.name} onError={() => setImagePreviewError("This image format could not be rendered by this browser.")} style={{ maxWidth: "100%", maxHeight: "calc(100% - 86px)", objectFit: "contain", borderRadius: 6, border: "1px solid var(--border)" }}/> : <span style={{ color: imagePreviewError ? "var(--red)" : "var(--text-muted)", fontSize: 11 }}>{imagePreviewError || "Loading image preview…"}</span>}
                    <div style={{ textAlign: "center" }}>
                      <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>{selected.name}</p>
                      <p style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.55 }}>Preview the current resource, then choose Replace to use an image from this device.</p>
                    </div>
                  </div>) : (<div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "0.75rem", padding: "1rem" }}>
                    <span style={{ fontSize: 36 }}>{getFileIcon(selected.path, false)}</span>
                    <div style={{ textAlign: "center" }}>
                      <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>{selected.name}</p>
                      <p style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6 }}>
                        Compiled or binary entry<br />
                        Replace the original entry, or decode supported resources before text editing
                      </p>
                      {selectedSource === "archive" && <button className="btn btn-primary" onClick={() => replacementInputRef.current?.click()} style={{ fontSize: 10, padding: "0.25rem 0.55rem", marginTop: 9 }}>Replace entry</button>}
                      {selectedSource === "archive" && isNestedArchive(selected.path) && <button className="btn btn-ghost" onClick={() => void openNestedArchive()} disabled={loading} style={{ fontSize: 10, padding: "0.25rem 0.55rem", marginTop: 9, marginLeft: 6 }}>Open as archive</button>}
                      <p style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 6, opacity: 0.5 }}>{selected.path}</p>
                    </div>
                  </div>)}
              </>) : (<div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "0.75rem" }}>
                <AndroidIcon size={32} color="var(--text-muted)"/>
                <div style={{ textAlign: "center" }}>
                  <p style={{ fontSize: 12, color: "var(--text-muted)" }}>Select a file to view or edit</p>
                  <p style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4, opacity: 0.6 }}>
                    Text files (XML, SMALI, JSON) are editable
                  </p>
                </div>
              </div>)}
          </div>
          </div></div>)}
      {showModeChooser && files.length > 0 && <div className="apk-dialog-backdrop">
          <section className="apk-dialog apk-decode-dialog" role="dialog" aria-modal="true" aria-labelledby="apk-mode-title" aria-describedby="apk-mode-description">
            <header className="apk-dialog-header"><div><strong id="apk-mode-title">Choose an APK editing mode</strong><p id="apk-mode-description">Choose how you want to work with this archive. You can change modes later without losing the browser draft.</p></div></header>
            <div className="apk-dialog-body"><div className="apk-dialog-stack">
              <button className="btn btn-ghost apk-dialog-option" onClick={startFullEdit}><strong>Full edit</strong><span>Browse every archive entry, replace files or images, and, when a backend is connected, decode resources or all supported files before rebuilding.</span></button>
              <button className="btn btn-ghost apk-dialog-option" onClick={() => selectEditMode("simple")}><strong>Simple edit</strong><span>Replace existing files and image resources, then save a browser draft or review an unsigned export.</span></button>
              <button className="btn btn-ghost apk-dialog-option" onClick={() => selectEditMode("common")}><strong>Common edit</strong><span>Focus on the Android manifest, app name, package, version, SDK, install location, and icon resource review when the manifest is decoded.</span></button>
              <button className="btn btn-ghost apk-dialog-option" onClick={() => selectEditMode("xml")}><strong>XML and text edit</strong><span>Focus on readable XML, strings, and text resources. Compiled resources remain decode-required rather than being presented as editable text.</span></button>
            </div></div>
            <footer className="apk-dialog-footer"><button className="btn btn-ghost" onClick={() => selectEditMode("full")}>Open archive workspace</button></footer>
          </section>
        </div>}
      {showDecodeChooser && backendReady && files.length > 0 && <div className="apk-dialog-backdrop">
          <section className="apk-dialog apk-decode-dialog" role="dialog" aria-modal="true" aria-labelledby="apk-decode-title" aria-describedby="apk-decode-description">
            <header className="apk-dialog-header"><div><strong id="apk-decode-title">Full edit setup</strong><p id="apk-decode-description">Choose the amount of workspace processing. Job status is the source of truth for decode and rebuild completion.</p></div></header>
            <div className="apk-dialog-body"><div className="apk-dialog-stack">
              <button className="btn btn-ghost apk-dialog-option" onClick={() => chooseDecodeLevel("inspect")}><strong>Explore archive</strong><span>Open the original archive tree, search, preview, text edit, extract, replace, and local drafts now.</span></button>
              <button className="btn btn-ghost apk-dialog-option" onClick={() => void startBackendDecode("resources")} disabled={loading}><strong>Decode resources and manifest</strong><span>Stage this archive, open editable manifest and resources, then validate them before an unsigned rebuild.</span></button>
              <button className="btn btn-ghost apk-dialog-option" onClick={() => void startBackendDecode("full")} disabled={loading}><strong>Decode all files</strong><span>Stage the archive, decode supported resources, and prepare the advanced-code workspace.</span></button>
            </div>
            {apkJob && <div className="apk-job-status">
                <strong style={{ fontSize: 11, color: apkJob.status === "complete" ? "var(--green)" : apkJob.status === "failed" ? "var(--red)" : "var(--accent)" }}>Workspace job: {apkJob.status}</strong>
                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{apkJob.mode === "full" ? "Full decode" : "Resource decode"}{decodedEntryCount !== null ? ` · ${decodedEntryCount} decoded entries` : ""}</span>
                {apkJob.error && <span style={{ fontSize: 10, color: "var(--red)", whiteSpace: "pre-wrap" }}>{apkJob.error}</span>}
                {apkJob.log && <pre style={{ margin: 0, maxHeight: 112, overflow: "auto", padding: "0.45rem", borderRadius: 6, background: "rgba(0,0,0,0.22)", color: "var(--text-secondary)", fontSize: 9.5, whiteSpace: "pre-wrap" }}>{apkJob.log}</pre>}
                {apkJob.status === "complete" && apkJob.mode !== "inspect" && <div style={{ display: "grid", gap: "0.4rem" }}>
                    <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                      <button className="btn btn-primary" onClick={() => void requestBackendBuild(false)} disabled={loading}>Build unsigned APK</button>
                      <button className="btn btn-ghost" onClick={() => void requestBackendBuild(true)} disabled={loading}>Build and sign</button>
                    </div>
                    <span style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.45 }}>Build and sign creates a one-time signing key inside the isolated job and deletes it before the artifact is available. It does not use or retain a personal keystore.</span>
                    {apkJob.artifactReady && <button className="btn btn-ghost" onClick={() => void downloadApkArtifact(apkJob.id, apkWorkspaceAccessRef.current ?? undefined).catch((error) => toast.error(error instanceof Error ? error.message : "APK artifact download failed."))}>Download artifact</button>}
                  </div>}
              </div>}</div>
            <footer className="apk-dialog-footer"><button className="btn btn-ghost" onClick={() => setShowDecodeChooser(false)}>Cancel</button></footer>
          </section>
        </div>}
      {showReleaseReview && files.length > 0 && <div className="apk-dialog-backdrop">
          <section className="apk-dialog apk-decode-dialog" role="dialog" aria-modal="true" aria-labelledby="apk-release-title" aria-describedby="apk-release-description">
            <header className="apk-dialog-header"><strong id="apk-release-title">Package details</strong><button className="btn btn-ghost" onClick={restoreDetectedPackageDetails} title="Restore values detected from this package" aria-label="Restore detected package values" style={{ padding: "0.25rem 0.45rem", fontSize: 11 }}>↺ Reset</button></header>
            <div className="apk-dialog-body"><div style={{ display: "grid", gap: "0.75rem" }}>
              <button className="btn btn-ghost" onClick={() => { if (!detectedIconFile) return; setShowReleaseReview(false); returnToArchiveWorkspace(); void handleFileSelect(detectedIconFile); replacementInputRef.current?.click(); }} disabled={!detectedIconFile} title={detectedIconFile ? "Replace launcher image" : "No launcher image was found"} aria-label="Replace launcher image" style={{ width: 58, height: 58, padding: 0, borderRadius: 14, overflow: "hidden", display: "grid", placeItems: "center", margin: "0 auto" }}>{launcherIconPreview ? <img src={launcherIconPreview} alt="Current launcher icon" style={{ width: "100%", height: "100%", objectFit: "cover" }}/> : <ApkIcon size={28} color="var(--accent)"/>}</button>
              {hasDetectedPackageDetails ? <div style={{ display: "grid", gap: "0.55rem" }}>
                <label style={{ display: "grid", gap: 4, fontSize: 11, color: "var(--text-secondary)" }}>App name<input value={activePackageDetails.appLabel} onChange={(event) => updatePackageDetail("appLabel", event.target.value)} /></label>
                <label style={{ display: "grid", gap: 4, fontSize: 11, color: "var(--text-secondary)" }}>Package name<input value={activePackageDetails.packageName} onChange={(event) => updatePackageDetail("packageName", event.target.value)} /></label>
                <label style={{ display: "grid", gap: 4, fontSize: 11, color: "var(--text-secondary)" }}>Install location<select value={activePackageDetails.installLocation} onChange={(event) => updatePackageDetail("installLocation", event.target.value)}><option value="auto">Default</option><option value="internalOnly">Internal only</option><option value="preferExternal">Prefer external</option></select></label>
                <label style={{ display: "grid", gap: 4, fontSize: 11, color: "var(--text-secondary)" }}>Version code<input inputMode="numeric" value={activePackageDetails.versionCode} onChange={(event) => updatePackageDetail("versionCode", event.target.value)} /></label>
                <label style={{ display: "grid", gap: 4, fontSize: 11, color: "var(--text-secondary)" }}>Version name<input value={activePackageDetails.versionName} onChange={(event) => updatePackageDetail("versionName", event.target.value)} /></label>
                <label style={{ display: "grid", gap: 4, fontSize: 11, color: "var(--text-secondary)" }}>Minimum SDK<input inputMode="numeric" value={activePackageDetails.minSdkVersion} onChange={(event) => updatePackageDetail("minSdkVersion", event.target.value)} /></label>
                <label style={{ display: "grid", gap: 4, fontSize: 11, color: "var(--text-secondary)" }}>Target SDK<input inputMode="numeric" value={activePackageDetails.targetSdkVersion} onChange={(event) => updatePackageDetail("targetSdkVersion", event.target.value)} /></label>
              </div> : <div style={{ display: "grid", gap: "0.4rem", textAlign: "center", color: "var(--text-muted)", fontSize: 11 }}>Binary package metadata is not readable in the browser. Choose Decode resources and manifest to inspect and edit it.</div>}
            </div></div>
            <footer className="apk-dialog-footer"><button className="btn btn-primary" onClick={() => void (manifestDetails ? saveEdit() : saveLocalDraft())} disabled={saving || loading}>Save</button><button className="btn btn-ghost" onClick={() => { setShowReleaseReview(false); void repackage(); }} disabled={loading}>Export</button><button className="btn btn-ghost" onClick={() => setShowReleaseReview(false)}>Close</button></footer>
          </section>
        </div>}
      {showExitDialog && <div className="apk-dialog-backdrop">
          <section className="apk-dialog apk-exit-dialog" role="dialog" aria-modal="true" aria-labelledby="apk-exit-title" aria-describedby="apk-exit-description">
            <header className="apk-dialog-header"><div><strong id="apk-exit-title">Keep APK changes?</strong><p id="apk-exit-description">You have {modified.size} changed archive {modified.size === 1 ? "entry" : "entries"}. Review metadata and artifact options before saving or repackaging, or discard these changes.</p></div></header>
            <footer className="apk-dialog-footer">
              <button className="btn btn-primary" onClick={() => { setShowExitDialog(false); void openReleaseReview(); }}>Review save / repackage</button>
              <button className="btn btn-ghost" onClick={discardAndClose} style={{ color: "var(--red)" }}>Discard</button>
              <button className="btn btn-ghost" onClick={() => setShowExitDialog(false)}>Cancel</button>
            </footer>
          </section>
        </div>}
    </div>);
}
