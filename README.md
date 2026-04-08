# Foundry MCP — Connect Claude AI to FoundryVTT

[![FoundryVTT](https://img.shields.io/badge/FoundryVTT-v13-orange)](https://foundryvtt.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-blue)](https://modelcontextprotocol.io)

**Foundry MCP** is a bridge between [Claude AI](https://claude.ai) and [FoundryVTT](https://foundryvtt.com) using the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). It lets Claude read and write data directly in your Foundry world — journals, actors, items, chat, playlists, macros, and more.

> **System agnostic** — works with any FoundryVTT game system (D&D 5e, Pathfinder, Call of Cthulhu, City of Mist, Warhammer, etc.)

---

## What can you do with it?

Once connected, you can ask Claude things like:

- *"List all NPCs in my world and summarize their descriptions"*
- *"Create a journal entry for the tavern The Silver Dragon with a full description"*
- *"Add a page to the journal 'Session 5' with tonight's recap"*
- *"Roll 2d6+3 and send the result to chat"*
- *"Play the 'Combat' playlist"*
- *"Show me all actors in the Villains folder"*
- *"Create a folder called 'Important NPCs' for actors"*

---

## Available MCP Tools (31 tools)

| Category | Tools |
|----------|-------|
| **World** | `foundry_ping`, `foundry_get_world_info` |
| **Journals** | `foundry_list_journals`, `foundry_get_journal`, `foundry_create_journal`, `foundry_update_journal_page`, `foundry_add_journal_page`, `foundry_delete_journal_page`, `foundry_delete_journal` |
| **Actors** | `foundry_list_actors`, `foundry_get_actor`, `foundry_create_actor`, `foundry_update_actor`, `foundry_delete_actor` |
| **Items** | `foundry_list_items`, `foundry_get_item`, `foundry_create_item`, `foundry_update_item`, `foundry_delete_item` |
| **Chat & Dice** | `foundry_send_chat_message`, `foundry_roll_dice`, `foundry_get_recent_messages` |
| **Playlists** | `foundry_list_playlists`, `foundry_play_playlist`, `foundry_stop_playlist`, `foundry_stop_all_sounds` |
| **Folders** | `foundry_list_folders`, `foundry_create_folder` |
| **Macros** | `foundry_list_macros`, `foundry_execute_macro` |
| **Users** | `foundry_list_users` |

---

## Architecture

```
Claude Desktop (your computer)
       │
       │  HTTPS  POST /mcp
       ▼
┌──────────────────────────────────────┐
│         MCP Server (Node.js)         │
│   Streamable HTTP transport          │
│                                      │
│   POST/GET /mcp  → Claude            │
│   WS       /ws   → Foundry plugin   │
│   GET       /    → Status page       │
└──────────────────────────────────────┘
       │
       │  WSS  /ws
       ▼
┌──────────────────────────────────────┐
│   Foundry MCP Plugin (browser JS)    │
│   foundry-mcp-plugin                 │
└──────────────────────────────────────┘
       │
       ▼
    FoundryVTT v13
```

The **MCP server** is the central hub:
- Claude connects to it via HTTP (Streamable HTTP transport)
- The Foundry plugin connects to it via WebSocket
- When Claude calls a tool, the server forwards the request to the plugin, which executes it inside Foundry and returns the result

---

## Installation

### Prerequisites

- FoundryVTT v13+
- Node.js 18+ (on the machine hosting the MCP server)
- Claude Desktop

---

## Scenario 1 — Everything on the same machine (simplest)

> FoundryVTT, MCP server, and Claude Desktop all run on the **same computer** (Windows/Mac/Linux).
> FoundryVTT is served over **HTTP** (localhost, no SSL).

```
Your computer
├── FoundryVTT       → http://localhost:30000
├── MCP server       → http://localhost:3001
└── Claude Desktop
```

### 1. Install the MCP server

```bash
cd /path/to/foundry-mcp/mcp-server
npm install
node src/index.js
```

### 2. Install the Foundry plugin

Copy the `foundry-mcp-plugin/` folder to your Foundry modules directory:
```
FoundryVTT/Data/modules/foundry-mcp-plugin/
```
> The folder name **must** be `foundry-mcp-plugin` (matches the module ID).

In Foundry: **Game Settings → Manage Modules → Foundry MCP Plugin → Enable**

### 3. Configure the plugin

In Foundry: **Game Settings → Module Settings → Foundry MCP Plugin**

| Setting | Value |
|---------|-------|
| MCP server host | `localhost` |
| MCP server port | `3001` |
| SSL | ☐ disabled |

Since Foundry runs on HTTP, the plugin will use `ws://localhost:3001/ws` — no SSL needed.

### 4. Configure Claude Desktop

Open **Claude Desktop → Settings → Connectors → Add Custom Connector**:

| Field | Value |
|-------|-------|
| Name | `Foundry VTT` |
| Remote MCP Server URL | `http://localhost:3001/mcp` |

> ⚠️ This only works if Claude Desktop and the MCP server are on the same machine.

---

## Scenario 2 — FoundryVTT on a remote server (NAS/VPS), Claude Desktop on your computer

> FoundryVTT and the MCP server are hosted remotely (Synology NAS, VPS, dedicated server).
> FoundryVTT is served over **HTTPS** (recommended for remote access).
> Claude Desktop is on your local computer.

```
Your computer
└── Claude Desktop   → connects via HTTPS to MCP server

Remote server (NAS / VPS)
├── FoundryVTT       → https://foundry.yourdomain.com
├── MCP server       → http://localhost:3001 (internal)
└── Reverse proxy    → https://mcp.yourdomain.com → localhost:3001
```

### Why a reverse proxy is required for HTTPS Foundry

When FoundryVTT is served over HTTPS, the browser enforces **Mixed Content** security rules: a page loaded via `https://` cannot make unencrypted WebSocket connections (`ws://`). The plugin, running in the browser, **must** use `wss://` (WebSocket Secure).

The MCP server itself runs plain HTTP/WS internally. The reverse proxy handles SSL termination, converting `wss://` from the browser to `ws://` locally. This is the same pattern used for FoundryVTT itself.

### 1. Set up a subdomain for the MCP server

In your DNS provider, create an A record:
```
mcp.yourdomain.com  →  [your server's public IP]
```

### 2. Obtain a TLS certificate

On Synology DSM: **Control Panel → Security → Certificate → Add → Let's Encrypt**
- Domain: `mcp.yourdomain.com`

On Linux (standalone): use Certbot or your preferred ACME client.

### 3. Configure the reverse proxy

#### Synology DSM

**DSM → Application Portal → Reverse Proxy → Create** (do not touch the existing Foundry rule):

| Field | Value |
|-------|-------|
| Source protocol | HTTPS |
| Source hostname | `mcp.yourdomain.com` |
| Source port | **443** |
| Destination protocol | HTTP |
| Destination hostname | `localhost` |
| Destination port | `3001` |

In the **Custom Headers** tab, add these two entries for WebSocket support:

| Header name | Value |
|-------------|-------|
| `Upgrade` | `$http_upgrade` |
| `Connection` | `$connection_upgrade` |

> **Why port 443?** Your router already forwards port 443 to your NAS for Foundry. By using a different subdomain on the same port, no additional port forwarding is needed. Synology differentiates rules by hostname (SNI).

#### Nginx (Linux VPS)

```nginx
server {
    listen 443 ssl;
    server_name mcp.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/mcp.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

### 4. Install and start the MCP server on the remote host

```bash
cd /path/to/foundry-mcp/mcp-server
npm install
node src/index.js
```

#### Auto-start on Synology NAS (using forever)

In **DSM → Control Panel → Task Scheduler → Create → Triggered Task → Boot-up**:

| Field | Value |
|-------|-------|
| User | root |
| Event | Boot-up |

Command:
```bash
sudo /usr/local/bin/forever start -c /var/packages/Node.js_v20/target/usr/local/bin/node /path/to/mcp-server/src/index.js
```

To manually stop/restart:
```bash
sudo forever stop /path/to/mcp-server/src/index.js
sudo forever start -c /var/packages/Node.js_v20/target/usr/local/bin/node /path/to/mcp-server/src/index.js
```

#### Auto-start on Linux (systemd)

```ini
# /etc/systemd/system/foundry-mcp.service
[Unit]
Description=Foundry MCP Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/mcp-server
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable foundry-mcp
systemctl start foundry-mcp
```

### 5. Install the Foundry plugin

Same as Scenario 1 — copy `foundry-mcp-plugin/` to your Foundry modules directory.

### 6. Configure the plugin

In Foundry: **Game Settings → Module Settings → Foundry MCP Plugin**

| Setting | Value |
|---------|-------|
| MCP server host | `mcp.yourdomain.com` |
| MCP server port | `443` |
| SSL | ✅ enabled |

The plugin will connect to `wss://mcp.yourdomain.com/ws`, which the reverse proxy routes to `ws://localhost:3001/ws`.

### 7. Configure Claude Desktop

**Claude Desktop → Settings → Connectors → Add Custom Connector**:

| Field | Value |
|-------|-------|
| Name | `Foundry VTT` |
| Remote MCP Server URL | `https://mcp.yourdomain.com/mcp` |

---

## Configuration reference

### MCP server — config.json

```json
{
  "http": {
    "host": "0.0.0.0",
    "port": 3001
  },
  "security": {
    "mcpApiKey": "",
    "wsApiKey": ""
  },
  "timeouts": {
    "queryTimeoutMs": 30000
  },
  "logging": {
    "level": "info"
  }
}
```

All values can be overridden with environment variables:

| config.json key | Env variable | Default |
|-----------------|--------------|---------|
| `http.host` | `HTTP_HOST` | `0.0.0.0` |
| `http.port` | `HTTP_PORT` | `3001` |
| `security.mcpApiKey` | `MCP_API_KEY` | *(empty, no auth)* |
| `security.wsApiKey` | `WS_API_KEY` | *(empty, no auth)* |
| `timeouts.queryTimeoutMs` | `QUERY_TIMEOUT_MS` | `30000` |
| `logging.level` | `LOG_LEVEL` | `info` |

### Security notes

- `mcpApiKey` — if set, Claude must send `Authorization: Bearer <key>` with each MCP request
- `wsApiKey` — if set, the Foundry plugin must authenticate before the WebSocket is accepted
- Both keys are independent and optional; leave empty for open access on a trusted local network

---

## Verification

Once everything is running:

- **Server status page**: `https://mcp.yourdomain.com/` — shows whether the Foundry plugin is connected
- **Health check**: `https://mcp.yourdomain.com/health` — returns JSON `{"status":"ok","pluginConnected":true}`
- **Foundry settings badge**: should show ✅ Connected in green
- **Test from Claude**: ask *"Ping Foundry"* — Claude will call `foundry_ping` and return world info

---

## Project structure

```
foundry-mcp/
├── mcp-server/
│   ├── src/
│   │   └── index.js          # MCP server (Streamable HTTP + WebSocket)
│   ├── config.json           # Configuration file
│   └── package.json
└── foundry-mcp-plugin/
    ├── module.json            # Foundry module manifest
    ├── scripts/
    │   └── main.js           # Plugin (WebSocket client + Foundry API calls)
    ├── styles/
    │   └── module.css        # Status badge styles
    └── lang/
        ├── en.json
        └── fr.json
```

---

## License

MIT — see [LICENSE](LICENSE)

## Author

[Zorgonaute84](https://github.com/Zorgonaute84)
