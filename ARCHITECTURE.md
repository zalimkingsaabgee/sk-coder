# SK Coder Architecture Plan

## Current Boundary

The browser owns the project tree, readable file content, binary assets, editor state, previews, and recovery copy. The backend owns temporary execution mirrors, interactive Docker terminals, native runners, dependency installation, GUI sessions, web previews, APK jobs, capacity accounting, and cleanup.

The existing mirror protocol is revisioned and chunked. It compares normalized paths, sizes, and optional SHA-256 values, stages changed files, removes deleted files, and commits against a server revision. A failed transfer can resume from the server stage status. This protocol should remain the boundary for every future client-compute feature.

## Existing Client Capabilities

- Browser blobs use OPFS when available and IndexedDB as the fallback.
- Project metadata and text content use resilient localStorage and IndexedDB persistence.
- HTML, CSS, JavaScript, Markdown, media, and PDF previews run in the browser.
- Python has a Pyodide fallback loaded on demand from a pinned CDN version.
- APK archives already use JSZip in frontend package features.
- Server execution remains the reliable path for packages, project commands, native toolchains, Java, .NET, Rust, Go, GUI programs, and APK decoding or rebuilding.

## Target Hybrid Model

### Browser worker

Move deterministic, low-risk operations into a Web Worker backed by an OPFS project filesystem. The worker should provide file operations, command parsing, transcript events, cancellation, and bounded output without blocking React rendering.

Initial commands should be `pwd`, `ls`, `cd`, `cat`, `echo`, `touch`, `mkdir`, `rm`, `cp`, `mv`, `clear`, `find`, `grep`, `whoami`, and `date`. The worker should operate on the same normalized paths used by workspace staging and should never access host files or browser credentials.

### Browser execution

Keep browser execution opt-in and capability-labelled. Python can use the existing Pyodide path after moving loading and execution behind a worker interface. JavaScript and TypeScript preview code can continue using the browser preview sandbox. Do not claim Node.js, native modules, unrestricted shell access, or package compatibility for browser execution.

### Server execution

Retain the existing Docker runner for native compilation, project dependencies, interactive terminals, GUI sessions, web previews that need a project server, and APK decode or rebuild. Server actions continue to require an explicit workspace capability and remain subject to output, time, memory, PID, network, and shared-capacity limits.

### APK inspection

Add a browser-only archive inspection path for ZIP-compatible APK metadata, entry listing, file sizes, hashes, readable text, images, and manifest text when available. Keep smali decoding, compiled resource decoding, rebuilding, alignment, and signing in the isolated APK worker. The original archive must remain available locally and no server upload should be required for inspection.

## Data and Recovery Rules

1. Browser state remains authoritative for project files.
2. A server workspace is a disposable execution mirror, never the only copy.
3. Every server stage is associated with a tree revision and server revision.
4. Client operations are cancellable and report `queued`, `running`, `complete`, `failed`, or `unavailable`.
5. A dropped connection never replays an uncertain command automatically.
6. File edits schedule a mirror and expose its status; terminal commands can still await an immediate stage before execution.
7. Server-required actions show their execution tier and preserve the browser project when capacity or connectivity is unavailable.

## Incremental Delivery

### 7A: Worker and storage proof

Create a worker protocol with typed request and event messages. Implement the filesystem against an in-memory adapter first, then add OPFS persistence and an IndexedDB fallback. Measure startup, read, write, directory traversal, and 10 MB import times on Chromium, Firefox, and Safari-class environments. Keep browser storage quota unknown when the platform cannot provide an estimate.

### 7B: Capability routing

Add a capability resolver that returns the execution tier, required inputs, cancellation behavior, and fallback order for each action. Route built-in shell commands to the worker, Python to the worker-backed Pyodide runner, browser previews to the existing preview path, and heavy or workspace-dependent actions to the server. Display the tier without implying guaranteed support.

### 7C: APK and migration

Move archive inspection into a worker using JSZip and compare memory and time for 10 MB, 50 MB, and 100 MB archives. Keep large archive entries as streams or blobs where possible. Introduce the browser path behind a feature flag, preserve the server APK route, and remove the flag only after parity, cancellation, quota, and export tests pass.

## Risks and Gates

- OPFS is not universally available and private browsing can reduce persistence.
- Pyodide startup and package loading can be large; it must remain lazy and cancellable.
- Browser workers cannot provide a general POSIX shell or native package ecosystem.
- Parsing a ZIP container does not decode compiled Android resources or prove an APK is installable.
- A worker filesystem must not silently diverge from the browser-authoritative tree.
- Any client-side command parser must enforce path normalization, output limits, and cancellation.

Do not replace the current server terminal until the worker passes offline editing, reconnect, quota, cancellation, transcript, staging, and export acceptance tests. The first production rollout should allow users to return to the current server path whenever a browser capability is unavailable.
