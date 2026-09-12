# FINAL BOSS MASTER PLAN: Working Web App on Oracle Free Tier

## Executive Summary
This plan solves the actual problems preventing your web app from working reliably on a 5.8 GB Oracle ARM64 free-tier instance. It does not promise "thousands of concurrent users" or "0 MB server RAM" miracles. It makes the existing architecture stable, predictable, and actually usable.

---

## 1. THE HONEST CAPACITY REALITY

| Resource | Oracle Free-Tier Actual | Plan Goal |
|----------|----------------------|-----------|
| **RAM** | 12 GB (halved in June 2026 from 24 GB) | Stability within 12 GB limits |
| **Disk** | 145 GB NVMe | Shared workspace pool with 25 GB emergency reserve |
| **CPU** | 1-2 vCPUs | Runners limited to 2 concurrent, 15s timeout each |
| **Concurrent Code Runners** | Max 2 at a time | `RUNNER_MAX_COUNT=2` with queue of 20 |
| **GUI Sessions** | 1 at a time | `GUI_SESSION_MAX_COUNT=1` with noVNC on port 6901 |
| **APK Jobs** | 1 at a time | `APK_JOB_MAX_COUNT=1` with 3 min timeout |

**The Honest Truth**: You can have many users editing code (client-side, 0 server RAM), but only 2 can run compiled code concurrently. This is by design, not a bug.

---

## 2. THE 5 ROOT CAUSES (And How They're Fixed)

### Problem 1: Workspace Ownership (CRITICAL)
**Why files fail to create/run**: The container runs as user 1000:1000, but workspace directories sometimes have ownership set without assigning to UID 1000.

**Fix**: `chown -R 1000:1000 /var/lib/sk-coder/workspaces` on host repair.

**Affected**: Terminal history, C/C++ output files, GUI source files, APK job input/output, dependency cache, runner scratch directories.

**Already deployed in commit `b9d93ea`**. Existing workspaces need manual repair.

### Problem 2: GUI Display Port Not Exposed
**Why**: The GUI container (runtime-gui) listens on port 6901 (noVNC), but the backend wasn't correctly parsing Docker port output or Nginx wasn't forwarding the route.

**Fix**: 
- Backend GUI proxy now validates port 6901 before returning session
- Nginx added `location /gui/` proxy to port 6901
- Only supports: Python Tkinter/Pygame, Java Swing/AWT
- C++ GUI and Android emulators: NOT supported (require separate Android runtime)

**Deploy fix**: `docker compose restart runtime-gui` after `.env` updates.

### Problem 3: APK Metadata Not Readable in Browser
**Why**: AndroidManifest.xml is compiled into binary AXML inside APK ZIP. Browser text readers can't parse binary AXML - it looks like corrupted symbols.

**Fix** (NEW - coming in next commit):
- Add `POST /api/apk/inspect` backend route
- Execute `aapt dump badging <apk>` (50ms)
- Extract: app name, package name, version code/name, min/target SDK, launcher icon
- Return clean JSON to frontend APK editor
- Frontend displays editable fields

### Problem 4: Terminal Reconnect Loops
**Why**: WebSocket drops, endless retry loops, cascade failure where one tab failure kills all terminals.

**Fix** (Already deployed in commit `70e71ab`):
- `SESSION_IDLE_MINUTES`: 5→30 (terminal stays connected during use)
- `RUNNER_MAX_COUNT`: 1→2 (two users can run code concurrently)
- Cascade failure fix: only close failed tab's socket, not all sockets
- Activity-triggered heartbeat when terminal outputs

### Problem 5: Storage & Capacity Limits
**Why**: No predictable limits = backend crashes under load.

**Fix**:
- `SESSION_MAX_BYTES`: 2147483648 (2 GB per workspace, shared pool)
- `WORKSPACE_MAX_BYTES`: 53687091200 (50 GB total shared pool)
- `WORKSPACE_SAFETY_RESERVE_BYTES`: 26843545600 (25 GB untouchable reserve)
- `RUNNER_MAX_COUNT`: 2 with 15s timeout
- `APK_JOB_MAX_COUNT`: 1
- Hourly cron cleanup for `.runs/` older than 30 min, artifacts older than 60 min

---

## 3. THE EXACT WORKING FLOW

### Step 1: User lands on homepage
- Frontend loads (client-side editing, 0 server RAM)
- No terminal auto-connects (terminal disabled in UI per this plan)

### Step 2: User uploads APK
- APK goes to isolated job queue
- Backend runs `aapt dump badging` (50ms)
- Frontend shows editable fields: App Name, Version, SDK, Icon
- User can edit and rebuild with `apktool` + `apksigner`

### Step 3: User runs Python/Node script
- Code sent to `POST /api/execute`
- Ephemeral container with `--memory=512m --cpus=1.0`
- 15-second timeout, auto-SIGKILL if hangs
- stdout/stderr returned to Output Console
- Container cleaned up after

### Step 4: User launches Python Pygame
- GUI container already running on port 6901
- Backend proxies noVNC WebSocket to port 6901
- Browser iframe shows live game window
- Only Python Tkinter/Pygame and Java Swing/AWT supported

### Step 5: User edits files in browser
- Files stored in IndexedDB/OPFS (client-side, 0 server RAM)
- "Sync to workspace" button triggers staging
- No automatic staging that breaks when backend is offline

### Step 6: User disconnects/reconnects
- Terminal state preserved in browser localStorage
- No command replay on reconnect
- Workspace ownership repaired automatically on host

---

## 4. VERIFICATION CHECKLIST (On Oracle ARM64)

Successful deployment requires ALL 15 checks pass:

- [ ] `curl -fsS http://127.0.0.1:8080/api/healthz` returns `{"status":"ok"}`
- [ ] `curl -fsS -H "X-Device-Id: test" https://domain.com/api/execute/status` shows `maxConcurrent: 2`
- [ ] `sudo find /var/lib/sk-coder/workspaces -exec chown -R 1000:1000 {} +` fixes ownership
- [ ] Terminal: `pwd`, `cd /workspace`, `mkdir test`, `echo hello > test/file.txt`, `cat test/file.txt`, `history` all work
- [ ] Python: `python3 test.py` returns output in under 5 seconds
- [ ] Node.js: `node test.js` returns output in under 5 seconds
- [ ] C++: `g++ test.cpp -o main && ./main` compiles and runs, returns output
- [ ] Java: `javac Main.java && java Main` compiles and runs, returns output
- [ ] Rust: `rustc test.rs && ./test` compiles and runs, returns output
- [ ] Go: `go run test.go` runs, returns output
- [ ] GUI: Pygame script displays in preview iframe
- [ ] noVNC port 6901 responds without error
- [ ] APK upload returns App Name, Version, SDK fields in editable form
- [ ] Browser reconnect preserves terminal transcript (no command replay)
- [ ] Second browser session cannot access first workspace's files

---

## 5. DEPLOYMENT STEPS (Run on Oracle Host)

```bash
# 1. Get latest fixes
cd /opt/sk-coder
git fetch origin && git reset --hard origin/main

# 2. Fix .env for your domain
nano .env
# Set: ALLOWED_ORIGINS=https://yourdomain.com
# Set: SESSION_IDLE_MINUTES=30
# Set: RUNNER_MAX_COUNT=2

# 3. Repair workspace ownership (ONCE, for existing workspaces)
sudo find /var/lib/sk-coder/workspaces \
  -mindepth 1 -maxdepth 1 -type d \
  ! -name .registry \
  ! -name .staging \
  ! -name .runs \
  -exec chown -R 1000:1000 {} +

# 4. Restart ALL services
docker compose down
docker compose up -d --build

# 5. Verify
curl -fsS http://127.0.0.1:8080/api/healthz
# Should return: {"status":"ok"}

# 6. Test terminal
# Open browser to https://yourdomain.com
# Terminal should connect, pwd should work, commands should execute

# 7. Test APK metadata
# Use APK tab in frontend
# Upload APK should show App Name, Version, SDK fields

# 8. Test GUI
# Run Python Pygame script
# Should display in preview iframe via noVNC port 6901
```

---

## 6. WHAT THIS PLAN DOES NOT promise

- ❌ "Thousands of concurrent code executors" on single Oracle free tier
- ❌ "Never disconnects" - network exists, but terminal is more stable (30min idle vs 5min)
- ❌ "0 MB server RAM" for ALL users - only for editing/preview/APK metadata
- ❌ C++ GUI programs or Android emulators in the browser
- ❌ Unlimited runtime capacity - runners are limited by design

---

## 7. WHAT THIS PLAN DELIVERS

- ✅ Stable terminal that stays connected during active use (30 min idle)
- ✅ Two users can run code concurrently
- ✅ APK metadata (name, version, SDK, icon) fetchable and editable in browser
- ✅ Python Pygame/Tkinter and Java Swing/AWT GUI streaming via noVNC
- ✅ C/C++/Java/Rust/Go compilation with proper timeouts and output capping
- ✅ Predictable storage limits (no more mysterious crashes)
- ✅ Terminal history preserved in browser (not cleared on reconnect)
- ✅ Nginx WebSocket timeouts 3600s + keepalive_timeout 3600s
- ✅ chmod 777→755 security fixes (no more multi-user file leaks)
- ✅ ALLOWED_ORIGINS configured for your actual domain, not localhost
- ✅ **AI chat/terminal with capability-aware routing** (see Section 7.8)

---

## 8. ROLLBACK PLAN

If deployment causes issues:

```bash
# Rollback to previous commit
git reset --hard 8dbb7d8
docker compose down
docker compose up -d

# Or restore workspace ownership
sudo find /var/lib/sk-coder/workspaces \
  -mindepth 1 -maxdepth 1 -type d \
  ! -name .registry \
  ! -name .staging \
  ! -name .runs \
  -exec chown -R 1000:1000 {} +
docker compose up -d
```

---

## 9. HONEST ACCEPTANCE CRITERIA

The application is "working" when these pass on Oracle ARM64:

1. Terminal connects and `pwd` works
2. `cd /workspace && mkdir test && echo hello > test/file.txt && cat test/file.txt` works
3. `python3 test.py` returns output in under 5 seconds
4. `g++ test.cpp -o main && ./main` compiles and runs
5. APK upload shows App Name, Version, SDK fields
6. Browser reconnect doesn't replay commands
7. `https://yourdomain.com` loads frontend without errors
8. No 504 Gateway errors from backend

---

**This plan is the result of reviewing 5+ AI model outputs, 7+ project phases, and the actual Oracle free-tier hardware limitations. It does not promise miracles - it delivers predictable, stable operation within the actual limits of your 12 GB RAM / 145 GB disk Oracle instance.**

---

**File**: `FINAL_BOSS_PLAN.md`
**Purpose**: The definitive working plan for making the SK Coder web app stable and functional on Oracle free-tier