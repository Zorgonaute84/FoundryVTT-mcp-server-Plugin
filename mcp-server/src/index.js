/**
 * Foundry MCP Server — Remote/hosted version (NAS, VPS, any server)
 *
 * Transport: Streamable HTTP — Claude connects via URL instead of spawning a local process.
 *
 * A single HTTP port exposes three endpoints:
 *   POST/GET /mcp  → Streamable HTTP MCP transport (for Claude)
 *   GET       /ws  → WebSocket (for the Foundry plugin, HTTP→WS upgrade)
 *   GET       /    → Status page (debug)
 *
 * Claude Desktop configuration (Settings → Connectors → Add Custom Connector):
 *   Remote MCP Server URL: https://mcp.yourdomain.com/mcp
 *
 * @author Zorgonaute84
 * @license MIT
 */

import { McpServer }                     from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebSocketServer }               from 'ws';
import { createServer }                  from 'http';
import { z }                             from 'zod';
import { readFileSync, existsSync }      from 'fs';
import { fileURLToPath }                 from 'url';
import { dirname, join }                 from 'path';

// ─── Configuration ────────────────────────────────────────────────────────────

const __dirname   = dirname(fileURLToPath(import.meta.url));
const configPath  = join(__dirname, '..', 'config.json');
let fileConfig    = {};
if (existsSync(configPath)) {
  try { fileConfig = JSON.parse(readFileSync(configPath, 'utf-8')); } catch (_) {}
}

const HTTP_HOST     = process.env.HTTP_HOST          || fileConfig.http?.host          || '0.0.0.0';
const HTTP_PORT     = parseInt(process.env.HTTP_PORT || fileConfig.http?.port          || '3001', 10);
const MCP_API_KEY   = process.env.MCP_API_KEY        || fileConfig.security?.mcpApiKey || '';
const WS_API_KEY    = process.env.WS_API_KEY         || fileConfig.security?.wsApiKey  || '';
const QUERY_TIMEOUT = parseInt(process.env.QUERY_TIMEOUT_MS || fileConfig.timeouts?.queryTimeoutMs || '30000', 10);
const LOG_LEVEL     = process.env.LOG_LEVEL          || fileConfig.logging?.level      || 'info';

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
function log(level, ...args) {
  if ((LOG_LEVELS[level] ?? 1) >= (LOG_LEVELS[LOG_LEVEL] ?? 1)) {
    console.log(`[foundry-mcp] [${level.toUpperCase()}]`, ...args);
  }
}

// ─── Foundry plugin connection state ─────────────────────────────────────────

let foundrySocket     = null;
const pendingRequests = new Map();
let requestCounter    = 0;

function rejectAllPending(reason) {
  for (const [, p] of pendingRequests) { clearTimeout(p.timeout); p.reject(new Error(reason)); }
  pendingRequests.clear();
}

function queryFoundry(method, params = {}, timeoutMs = QUERY_TIMEOUT) {
  return new Promise((resolve, reject) => {
    if (!foundrySocket || foundrySocket.readyState !== 1) {
      return reject(new Error(
        'Foundry plugin not connected. Make sure the module is active in FoundryVTT.'
      ));
    }
    const id      = `req-${++requestCounter}-${Date.now()}`;
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Timeout: ${method} (${timeoutMs}ms)`));
    }, timeoutMs);
    pendingRequests.set(id, { resolve, reject, timeout });
    foundrySocket.send(JSON.stringify({ type: 'mcp-query', id, data: { method, params } }));
    log('debug', `→ ${method} [${id}]`);
  });
}

// ─── MCP tools registration ───────────────────────────────────────────────────
// Factored into a function because a new McpServer is created per HTTP request (stateless mode).

function registerTools(server) {

  server.tool('foundry_ping',
    'Check that the Foundry plugin is connected and responding.',
    {},
    async () => {
      const data = await queryFoundry('ping', {}, 5000);
      return { content: [{ type: 'text', text: `✅ Plugin connected\n${JSON.stringify(data, null, 2)}` }] };
    }
  );

  server.tool('foundry_get_world_info',
    'Returns information about the active FoundryVTT world: name, description, game system (D&D 5e, PF2e, etc.), Foundry version, and list of active modules.',
    {},
    async () => {
      const data = await queryFoundry('getWorldInfo', {});
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool('foundry_list_journals',
    'Lists all journal entries in the Foundry world. Returns ID, name, folder, and page list for each journal.',
    { folder: z.string().optional().describe('Filter by folder name (optional).') },
    async ({ folder } = {}) => {
      const data = await queryFoundry('listJournals', { folder });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool('foundry_get_journal',
    'Retrieves the full content of a journal, including all pages and their HTML content.',
    {
      id:   z.string().optional().describe('Journal ID (preferred if known)'),
      name: z.string().optional().describe('Journal name (used if ID is unknown)'),
    },
    async ({ id, name } = {}) => {
      if (!id && !name) throw new Error('Provide id or name.');
      const data = await queryFoundry('getJournal', { id, name });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool('foundry_create_journal',
    'Creates a new journal in FoundryVTT, optionally with a first page.',
    {
      name:      z.string().describe('Journal name'),
      folder:    z.string().optional().describe('Folder name where the journal will be placed (must exist in Foundry)'),
      content:   z.string().optional().describe('HTML content of the first page (optional)'),
      pageTitle: z.string().optional().describe('Title of the first page (defaults to journal name)'),
      pageType:  z.enum(['text', 'image', 'pdf', 'video']).optional().describe('Page type (default: text)'),
    },
    async ({ name, folder, content, pageTitle, pageType } = {}) => {
      if (!name) throw new Error('Name is required.');
      const data = await queryFoundry('createJournal', { name, folder, content, pageTitle, pageType });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool('foundry_update_journal_page',
    'Updates the content and/or title of an existing page in a Foundry journal.',
    {
      journalId:   z.string().optional().describe('Journal ID'),
      journalName: z.string().optional().describe('Journal name (if ID unknown)'),
      pageId:      z.string().optional().describe('Page ID to update'),
      pageName:    z.string().optional().describe('Page name (if ID unknown; omit if journal has only one page)'),
      content:     z.string().describe('New HTML content of the page'),
      title:       z.string().optional().describe('New page title (optional)'),
    },
    async ({ journalId, journalName, pageId, pageName, content, title } = {}) => {
      if (!journalId && !journalName) throw new Error('Provide journalId or journalName.');
      const data = await queryFoundry('updateJournalPage', { journalId, journalName, pageId, pageName, content, title });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool('foundry_add_journal_page',
    'Adds a new page to an existing journal.',
    {
      journalId:   z.string().optional().describe('Journal ID'),
      journalName: z.string().optional().describe('Journal name (if ID unknown)'),
      title:       z.string().describe('New page title'),
      content:     z.string().optional().describe('HTML content of the new page'),
      type:        z.enum(['text', 'image', 'pdf', 'video']).optional().describe('Page type (default: text)'),
    },
    async ({ journalId, journalName, title, content, type } = {}) => {
      if (!journalId && !journalName) throw new Error('Provide journalId or journalName.');
      if (!title) throw new Error('Title is required.');
      const data = await queryFoundry('addJournalPage', { journalId, journalName, title, content, type });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool('foundry_delete_journal_page',
    'Deletes a page from a journal. Warning: this action is irreversible.',
    {
      journalId:   z.string().optional().describe('Journal ID'),
      journalName: z.string().optional().describe('Journal name'),
      pageId:      z.string().optional().describe('Page ID to delete'),
      pageName:    z.string().optional().describe('Page name to delete'),
    },
    async ({ journalId, journalName, pageId, pageName } = {}) => {
      if (!journalId && !journalName) throw new Error('Provide journalId or journalName.');
      if (!pageId && !pageName) throw new Error('Provide pageId or pageName.');
      const data = await queryFoundry('deleteJournalPage', { journalId, journalName, pageId, pageName });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool('foundry_delete_journal',
    'Deletes an entire journal with all its pages. Warning: this action is irreversible.',
    {
      id:   z.string().optional().describe('Journal ID to delete'),
      name: z.string().optional().describe('Journal name to delete'),
    },
    async ({ id, name } = {}) => {
      if (!id && !name) throw new Error('Provide id or name.');
      const data = await queryFoundry('deleteJournal', { id, name });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Actors ───────────────────────────────────────────────────────────────────

  server.tool('foundry_list_actors',
    'Lists all actors in the Foundry world (NPCs, PCs, creatures). Returns ID, name, type, and folder.',
    {
      type:   z.string().optional().describe('Filter by type (e.g. npc, character)'),
      folder: z.string().optional().describe('Filter by folder name'),
    },
    async ({ type, folder } = {}) => {
      const data = await queryFoundry('listActors', { type, folder });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool('foundry_get_actor',
    'Retrieves full details of an actor: system stats, equipped items, active effects.',
    {
      id:   z.string().optional().describe('Actor ID (preferred if known)'),
      name: z.string().optional().describe('Actor name'),
    },
    async ({ id, name } = {}) => {
      if (!id && !name) throw new Error('Provide id or name.');
      const data = await queryFoundry('getActor', { id, name });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool('foundry_create_actor',
    'Creates a new actor in FoundryVTT.',
    {
      name:   z.string().describe('Actor name'),
      type:   z.string().describe('Actor type according to the system (e.g. npc, character)'),
      folder: z.string().optional().describe('Destination folder name'),
      data:   z.record(z.unknown()).optional().describe('Initial system data (system-specific fields)'),
    },
    async ({ name, type, folder, data } = {}) => {
      if (!name) throw new Error('Name is required.');
      if (!type) throw new Error('Type is required.');
      const result = await queryFoundry('createActor', { name, type, folder, data });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool('foundry_update_actor',
    'Updates the data of an existing actor.',
    {
      id:   z.string().optional().describe('Actor ID'),
      name: z.string().optional().describe('Actor name'),
      data: z.record(z.unknown()).describe('Fields to update (dot notation supported, e.g. {"system.hp.value": 10})'),
    },
    async ({ id, name, data } = {}) => {
      if (!id && !name) throw new Error('Provide id or name.');
      if (!data) throw new Error('Provide data with fields to update.');
      const result = await queryFoundry('updateActor', { id, name, data });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool('foundry_delete_actor',
    'Deletes an actor. Warning: this action is irreversible.',
    {
      id:   z.string().optional().describe('Actor ID'),
      name: z.string().optional().describe('Actor name'),
    },
    async ({ id, name } = {}) => {
      if (!id && !name) throw new Error('Provide id or name.');
      const data = await queryFoundry('deleteActor', { id, name });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Items ────────────────────────────────────────────────────────────────────

  server.tool('foundry_list_items',
    'Lists all items in the Foundry world (weapons, spells, equipment, etc.).',
    {
      type:   z.string().optional().describe('Filter by item type'),
      folder: z.string().optional().describe('Filter by folder name'),
    },
    async ({ type, folder } = {}) => {
      const data = await queryFoundry('listItems', { type, folder });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool('foundry_get_item',
    'Retrieves full details of an item: system data, effects.',
    {
      id:   z.string().optional().describe('Item ID'),
      name: z.string().optional().describe('Item name'),
    },
    async ({ id, name } = {}) => {
      if (!id && !name) throw new Error('Provide id or name.');
      const data = await queryFoundry('getItem', { id, name });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool('foundry_create_item',
    'Creates a new item in the Foundry world.',
    {
      name:   z.string().describe('Item name'),
      type:   z.string().describe('Item type according to the system (e.g. weapon, spell, equipment)'),
      folder: z.string().optional().describe('Destination folder name'),
      data:   z.record(z.unknown()).optional().describe('Initial system data'),
    },
    async ({ name, type, folder, data } = {}) => {
      if (!name) throw new Error('Name is required.');
      if (!type) throw new Error('Type is required.');
      const result = await queryFoundry('createItem', { name, type, folder, data });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool('foundry_update_item',
    'Updates the data of an existing item.',
    {
      id:   z.string().optional().describe('Item ID'),
      name: z.string().optional().describe('Item name'),
      data: z.record(z.unknown()).describe('Fields to update (dot notation supported, e.g. {"system.quantity": 5})'),
    },
    async ({ id, name, data } = {}) => {
      if (!id && !name) throw new Error('Provide id or name.');
      if (!data) throw new Error('Provide data with fields to update.');
      const result = await queryFoundry('updateItem', { id, name, data });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool('foundry_delete_item',
    'Deletes an item from the world. Warning: this action is irreversible.',
    {
      id:   z.string().optional().describe('Item ID'),
      name: z.string().optional().describe('Item name'),
    },
    async ({ id, name } = {}) => {
      if (!id && !name) throw new Error('Provide id or name.');
      const data = await queryFoundry('deleteItem', { id, name });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Chat & Dice ──────────────────────────────────────────────────────────────

  server.tool('foundry_send_chat_message',
    'Sends a message to the Foundry chat, visible to all players (or as a whisper).',
    {
      content:   z.string().describe('HTML content of the message'),
      whisperTo: z.array(z.string()).optional().describe('List of user names or IDs for a private whisper'),
    },
    async ({ content, whisperTo } = {}) => {
      if (!content) throw new Error('Content is required.');
      const data = await queryFoundry('sendChatMessage', { content, whisperTo });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool('foundry_roll_dice',
    'Rolls dice in Foundry and displays the result in chat. Supports all standard formulas (2d6+3, 1d20, 4d6kh3, etc.).',
    {
      formula: z.string().describe('Dice formula (e.g. "2d6+3", "1d20", "4d6kh3")'),
      flavor:  z.string().optional().describe('Roll description shown in chat'),
    },
    async ({ formula, flavor } = {}) => {
      if (!formula) throw new Error('Formula is required.');
      const data = await queryFoundry('rollDice', { formula, flavor });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool('foundry_get_recent_messages',
    'Retrieves the latest messages from the Foundry chat.',
    {
      limit: z.number().optional().describe('Number of messages to return (default: 20, max: 100)'),
    },
    async ({ limit = 20 } = {}) => {
      const data = await queryFoundry('getRecentMessages', { limit: Math.min(limit, 100) });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Playlists & Audio ────────────────────────────────────────────────────────

  server.tool('foundry_list_playlists',
    'Lists all playlists in the Foundry world with their sounds and playback status.',
    {},
    async () => {
      const data = await queryFoundry('listPlaylists', {});
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool('foundry_play_playlist',
    'Starts playback of a playlist (or a specific sound within the playlist).',
    {
      id:        z.string().optional().describe('Playlist ID'),
      name:      z.string().optional().describe('Playlist name'),
      soundName: z.string().optional().describe('Name of a specific sound to play (plays entire playlist if omitted)'),
    },
    async ({ id, name, soundName } = {}) => {
      if (!id && !name) throw new Error('Provide id or name.');
      const data = await queryFoundry('playPlaylist', { id, name, soundName });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool('foundry_stop_playlist',
    'Stops playback of a playlist.',
    {
      id:   z.string().optional().describe('Playlist ID'),
      name: z.string().optional().describe('Playlist name'),
    },
    async ({ id, name } = {}) => {
      if (!id && !name) throw new Error('Provide id or name.');
      const data = await queryFoundry('stopPlaylist', { id, name });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool('foundry_stop_all_sounds',
    'Immediately stops all playlists and sounds currently playing.',
    {},
    async () => {
      const data = await queryFoundry('stopAllSounds', {});
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Users ────────────────────────────────────────────────────────────────────

  server.tool('foundry_list_users',
    'Lists all users in the Foundry world with their connection status, role, and associated character.',
    {},
    async () => {
      const data = await queryFoundry('listUsers', {});
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Folders ──────────────────────────────────────────────────────────────────

  server.tool('foundry_list_folders',
    'Lists Foundry folders, filterable by content type.',
    {
      type: z.enum(['Actor', 'Item', 'JournalEntry', 'Macro', 'Playlist', 'RollTable', 'Scene']).optional()
        .describe('Content type of the folder'),
    },
    async ({ type } = {}) => {
      const data = await queryFoundry('listFolders', { type });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool('foundry_create_folder',
    'Creates a new folder in Foundry to organize actors, items, journals, etc.',
    {
      name:   z.string().describe('Folder name'),
      type:   z.enum(['Actor', 'Item', 'JournalEntry', 'Macro', 'Playlist', 'RollTable', 'Scene'])
        .describe('Content type of the folder'),
      parent: z.string().optional().describe('Parent folder name (for nesting)'),
      color:  z.string().optional().describe('Folder color in hexadecimal (e.g. #ff0000)'),
    },
    async ({ name, type, parent, color } = {}) => {
      if (!name) throw new Error('Name is required.');
      if (!type) throw new Error('Type is required.');
      const data = await queryFoundry('createFolder', { name, type, parent, color });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Macros ───────────────────────────────────────────────────────────────────

  server.tool('foundry_list_macros',
    'Lists all macros available in the Foundry world.',
    {},
    async () => {
      const data = await queryFoundry('listMacros', {});
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool('foundry_execute_macro',
    'Executes a Foundry macro by name or ID.',
    {
      id:   z.string().optional().describe('Macro ID'),
      name: z.string().optional().describe('Macro name'),
    },
    async ({ id, name } = {}) => {
      if (!id && !name) throw new Error('Provide id or name.');
      const data = await queryFoundry('executeMacro', { id, name });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

/** Reads the body of an HTTP request */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

/** HTML status page */
function statusPage() {
  const pluginOk = foundrySocket?.readyState === 1;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Foundry MCP Server</title>
<style>body{font-family:sans-serif;max-width:600px;margin:60px auto;padding:0 20px}
.ok{color:green}.ko{color:red}.info{background:#f5f5f5;padding:12px;border-radius:6px;margin:12px 0;font-size:.9em}
</style></head><body>
<h1>Foundry MCP Server</h1>
<p class="${pluginOk ? 'ok' : 'ko'}">${pluginOk ? '🟢 Foundry plugin connected' : '🔴 Waiting for Foundry plugin'}</p>
<div class="info">
  <strong>Endpoints:</strong><br>
  <code>POST/GET /mcp</code> — Streamable HTTP MCP transport (Claude)<br>
  <code>WS /ws</code> — WebSocket Foundry plugin
</div>
<div class="info">
  <strong>Security:</strong> MCP API key ${MCP_API_KEY ? '✅ configured' : '⚠️ not configured'} | WS key ${WS_API_KEY ? '✅ configured' : '⚠️ not configured'}
</div>
</body></html>`;
}

const httpServer = createServer(async (req, res) => {
  const url    = req.url?.split('?')[0] ?? '/';
  const method = req.method ?? 'GET';

  // ── Status page ──
  if (url === '/' || url === '/health') {
    res.writeHead(200, { 'Content-Type': url === '/health' ? 'application/json' : 'text/html; charset=utf-8' });
    res.end(url === '/health'
      ? JSON.stringify({ status: 'ok', pluginConnected: foundrySocket?.readyState === 1 })
      : statusPage()
    );
    return;
  }

  // ── MCP endpoint (for Claude) ──
  if (url === '/mcp') {
    // API key check if configured
    if (MCP_API_KEY) {
      const auth = req.headers['authorization'] ?? '';
      if (auth !== `Bearer ${MCP_API_KEY}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized — invalid or missing API key' }));
        return;
      }
    }

    // CORS headers for remote MCP clients
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');

    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    try {
      const rawBody   = await readBody(req);
      // Parse JSON body (handleRequest expects an object, not a Buffer)
      let body;
      if (rawBody.length > 0) {
        try { body = JSON.parse(rawBody.toString('utf-8')); } catch (_) {}
      }
      // New server + transport per request (stateless mode)
      const mcpServer = new McpServer({ name: 'foundry-mcp-server', version: '1.0.0' });
      registerTools(mcpServer);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => transport.close().catch(() => {}));
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log('error', `MCP error: ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ─── WebSocket server (for the Foundry plugin) — same port, path /ws ─────────

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  log('info', `WebSocket connection from ${ip}`);

  // Replace existing connection
  if (foundrySocket?.readyState === 1) {
    log('warn', 'Replacing existing plugin connection');
    rejectAllPending('Connection replaced');
    foundrySocket.close(1001, 'Replaced');
  }

  if (WS_API_KEY) {
    ws._authenticated = false;
    ws._authTimeout   = setTimeout(() => {
      log('warn', `Auth timeout for ${ip}`);
      ws.close(4001, 'Auth timeout');
    }, 10_000);
  } else {
    ws._authenticated = true;
    foundrySocket     = ws;
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (!ws._authenticated) {
        if (msg.type === 'auth' && msg.apiKey === WS_API_KEY) {
          clearTimeout(ws._authTimeout);
          ws._authenticated = true;
          foundrySocket     = ws;
          ws.send(JSON.stringify({ type: 'auth-ok' }));
          log('info', `Plugin authenticated from ${ip}`);
        } else {
          log('warn', `Auth failed from ${ip}`);
          ws.close(4003, 'Invalid key');
        }
        return;
      }

      switch (msg.type) {
        case 'plugin-connected':
          log('info', `Plugin — Foundry v${msg.data?.foundryVersion}, world: "${msg.data?.worldTitle}", system: ${msg.data?.systemId}`);
          break;
        case 'mcp-response':
          if (msg.id) {
            const p = pendingRequests.get(msg.id);
            if (p) {
              clearTimeout(p.timeout);
              pendingRequests.delete(msg.id);
              msg.data?.success ? p.resolve(msg.data.data) : p.reject(new Error(msg.data?.error || 'Unknown error'));
            }
          }
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;
      }
    } catch (e) { log('warn', `Parse error: ${e.message}`); }
  });

  ws.on('close', (code) => {
    log('info', `Plugin disconnected (code: ${code})`);
    if (foundrySocket === ws) { foundrySocket = null; rejectAllPending('Plugin disconnected'); }
  });

  ws.on('error', (e) => log('warn', `WS error: ${e.message}`));
});

// ─── Startup ──────────────────────────────────────────────────────────────────

httpServer.on('error', (e) => {
  log('error', `Server error: ${e.message}`);
  if (e.code === 'EADDRINUSE') log('error', `Port ${HTTP_PORT} already in use. Change HTTP_PORT in config.json`);
});

httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
  log('info', `Server started on http://${HTTP_HOST}:${HTTP_PORT}`);
  log('info', `  → MCP  : POST/GET http://[host]:${HTTP_PORT}/mcp`);
  log('info', `  → WS   : ws://[host]:${HTTP_PORT}/ws`);
  log('info', `  → Page : http://[host]:${HTTP_PORT}/`);
  if (!MCP_API_KEY) log('warn', `MCP API key not configured — /mcp endpoint is publicly accessible`);
  if (!WS_API_KEY)  log('warn', `WS key not configured — WebSocket is publicly accessible`);
});
