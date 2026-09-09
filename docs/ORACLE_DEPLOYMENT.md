# Oracle Deployment Guide

This guide deploys SK Coder to one Oracle Linux or Ubuntu compute instance with your own domain name. The application runs as three internal services: the browser frontend, the backend API, and the reusable language-runtime image. Users access only the frontend endpoint; it safely forwards API and terminal traffic to the backend inside the Docker network.

> Keep the Docker socket private. The backend needs it to create isolated workspaces, so only a trusted server administrator should control the host.

## 1. What you need

You need an Oracle compute instance with Ubuntu 24.04 or another 64-bit Docker-supported Linux distribution, a domain name, and a DNS record that you can point to the instance public IP. Docker supports Ubuntu 24.04 on both amd64 and arm64; use Docker’s repository installation method rather than an unattended convenience script for a production server. [1]

Open only these inbound ports in both the Oracle cloud network rule and the server firewall:

| Port | Public access | Purpose |
|---|---|---|
| `22` | Only your administrator IP range | SSH administration. |
| `80` | Yes | Certificate verification and HTTP-to-HTTPS redirect. |
| `443` | Yes | Secure website traffic. |
| `8080` | No | Internal Compose troubleshooting only. |

Oracle networking must allow the TCP ports that the instance receives. [2] Docker-published ports can bypass simple host-firewall expectations, so do not expose the Compose port publicly when a host reverse proxy is installed. [1]

## 2. Prepare the server

Connect through SSH, update the server, and install Docker Engine plus the Compose plugin. Docker documents installing `docker-ce`, `containerd.io`, `docker-buildx-plugin`, and `docker-compose-plugin` from its official repository. [1] Verify the installation with `docker compose version`. [3]

```bash
sudo apt update
sudo apt install -y ca-certificates curl git nginx certbot python3-certbot-nginx
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run hello-world
```

Clone the repository into a stable host path and give your administrator account permission to run Docker. Log out and sign in again after the group change.

```bash
sudo mkdir -p /opt/sk-coder
sudo chown "$USER":"$USER" /opt/sk-coder
git clone https://github.com/zalimkingsaabgee/sk-coder.git /opt/sk-coder
cd /opt/sk-coder
sudo usermod -aG docker "$USER"
```

## 3. Configure storage and backend limits

Create the production environment file. Do not commit this file or place private keys in the frontend.

```bash
cd /opt/sk-coder
cp .env.example .env
nano .env
```

The supplied values use a cautious 150 GB host-disk policy. They reserve 25 GiB of free disk, keep server workspaces below 75 GiB in total, reserve cache and log capacity, and cap one workspace at 5 GiB.

Set `ALLOWED_ORIGINS` to the final HTTPS site origin, for example `https://code.example.com`. The browser frontend and terminal WebSocket requests are rejected in production when this setting is absent or does not match the public domain.

| Setting | Recommended value | Meaning |
|---|---:|---|
| `SESSION_TTL_HOURS` | `72` | Default workspace retention time. |
| `SESSION_MAX_BYTES` | `5368709120` | Maximum bytes for one backend workspace. |
| `WORKSPACE_MAX_BYTES` | `80530636800` | Maximum bytes for all backend workspaces. |
| `WORKSPACE_SAFETY_RESERVE_BYTES` | `26843545600` | Disk capacity left free for the operating system and recovery. |
| `PACKAGE_CACHE_MAX_BYTES` | `21474836480` | Maximum package-cache allocation. |
| `LOG_MAX_BYTES` | `5368709120` | Maximum service and runtime log allocation. |
| `SESSION_MAX_COUNT` | `50` | Maximum managed workspace records. |
| `OUTPUT_MAX_BYTES` | `500000` | Maximum captured stdout or stderr per command result. |
| `HTTP_PORT` | `8080` | Local port used only by the host reverse proxy. |
| `ALLOWED_ORIGINS` | `https://code.example.com` | Required browser origin for API and terminal WebSocket access. |

The browser keeps a local project mirror for resilience. It is not a replacement for a live server workspace when users need terminal commands, package installation, or persistent build processes. Command output is capped by `OUTPUT_MAX_BYTES` so a noisy or malicious program cannot grow the backend process memory without bound.

## 4. Build and start the application

Build the standard, GUI, and APK runtime images and start all services:

```bash
cd /opt/sk-coder
docker compose build runtime runtime-gui runtime-apk
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:8080/api/healthz
```

The health request should return JSON with `"status":"ok"`. The GUI Preview path is available only after `runtime-gui` builds successfully. It starts a short-lived, one-session Xvfb/noVNC display for supported Python Tkinter/Pygame and Java Swing/AWT programs; it does not make every language graphical or provide an Android emulator. The backend keeps the GUI port on loopback and exposes it through an authenticated session URL. If the GUI image cannot be built, normal editing, terminal, and non-GUI runners remain independent.

If a service does not start, inspect its logs:

```bash
docker compose logs --tail=200 backend
docker compose logs --tail=200 frontend
```

## 5. Connect your domain and HTTPS

Create an `A` record for your chosen domain, such as `code.example.com`, pointing to the Oracle instance public IPv4 address. Wait until DNS resolves to the server before requesting a certificate.

Install the supplied host Nginx configuration, replacing `code.example.com` with your real domain in both server-name lines:

```bash
sudo cp /opt/sk-coder/deploy/sk-coder.nginx.conf /etc/nginx/sites-available/sk-coder
sudo nano /etc/nginx/sites-available/sk-coder
sudo ln -s /etc/nginx/sites-available/sk-coder /etc/nginx/sites-enabled/sk-coder
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d code.example.com
```

The host Nginx server terminates HTTPS and forwards all normal, API, and WebSocket requests to `127.0.0.1:8080`. The internal frontend Nginx container then forwards `/api` and terminal WebSocket routes to the backend service. Keep the `8080` firewall port private after Nginx is working.

## 6. Start automatically after a restart

Install the supplied system service so Docker Compose starts when the VM boots:

```bash
sudo cp /opt/sk-coder/deploy/sk-coder.service /etc/systemd/system/sk-coder.service
sudo systemctl daemon-reload
sudo systemctl enable --now sk-coder
sudo systemctl status sk-coder
```

## 7. Update safely

Pull the latest pushed repository content, rebuild the services, and confirm the health route:

```bash
cd /opt/sk-coder
git pull --ff-only origin main
docker compose up -d --build
curl -fsS https://code.example.com/api/healthz
```

Do not delete the Docker workspace volume during ordinary updates. Deleting it permanently removes server-side workspaces and lifecycle metadata. Use `docker compose logs -f backend` for live backend diagnostics.

## 8. Database decision

No database server is needed for the current application. The core workspace lifecycle data lives with the Docker volume, and browser-only project state remains in the browser. Add PostgreSQL or MySQL only when you intentionally introduce accounts, shared teams, billing, durable cross-device projects, or organization administration. If you add a database later, keep it internal to the Docker network, store its password outside Git, and add scheduled backups before accepting user data.

## References

[1]: https://docs.docker.com/engine/install/ubuntu/ "Docker Engine installation on Ubuntu"
[2]: https://www.oracle.com/webfolder/technetwork/tutorials/obe/cloud/compute/permitting_public_tcp_traffic_to_compute_instances/permitting_public_tcp_traffic_to_compute_instances.html "Oracle guidance for permitting public TCP traffic"
[3]: https://docs.docker.com/compose/install/linux/ "Docker Compose plugin installation on Linux"
