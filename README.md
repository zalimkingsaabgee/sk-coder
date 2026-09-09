# SK Coder

SK Coder is a browser-based coding workspace with a React frontend, a Node.js backend, isolated Docker runtime sessions, file preview, terminal sessions, AI assistance, and APK archive editing.

## Repository layout

| Path | Purpose |
|---|---|
| `frontend/` | React and Vite application served to users. |
| `backend/` | Express API, terminal WebSocket bridge, workspace registry, and runtime session manager. |
| `runtime/` | Docker image definition for isolated language workspaces. |
| `runtime-gui/` | Docker image definition for isolated graphical program sessions. |
| `runtime-apk/` | Docker image definition for APK inspection and rebuild jobs. |
| `deploy/` | Docker, reverse-proxy, registry-proxy, and server configuration templates for a custom-domain deployment. |
| `docs/` | Execution-mirror contract and Oracle/Hostinger handoff acceptance checklist. |
| `docker-compose.yml` | Production service stack for the frontend, backend, and isolated runtime images. |

## Local development

Install dependencies separately for each service, then run them in two terminals:

```bash
cd frontend
pnpm install
pnpm run dev
```

```bash
cd backend
pnpm install
pnpm run dev
```

The frontend development server proxies `/api` and terminal WebSocket requests to `http://127.0.0.1:3001` by default. Set `VITE_API_PROXY_TARGET` only when the backend runs on a different local address.

## Production

Create a server-local `.env` from `deploy/server-config.example`, set the final browser origin and storage limits for the host, then start the stack with Docker Compose. Keep `.env`, SSH keys, browser workspaces, and runtime volumes outside Git:

```bash
cp deploy/server-config.example .env
docker compose up -d --build
```

For a custom domain, follow [`docs/oracle-hostinger-production-handoff.md`](docs/oracle-hostinger-production-handoff.md). It defines the DNS, TLS/WSS proxy, runtime-probe, restricted-installer, storage, and browser acceptance gates that must pass before a production claim.

## Data and database

The current application does not require a relational database for its core workflow. Browser project state uses local browser storage, while the backend stores workspace lifecycle metadata with the Docker workspace volume. Add a managed database only when a future feature requires shared accounts, billing, team workspaces, or cross-device project history.
