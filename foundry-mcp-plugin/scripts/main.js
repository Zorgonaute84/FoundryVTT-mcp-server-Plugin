/**
 * Foundry MCP Plugin — Remote/hosted version
 *
 * Connects FoundryVTT to a remote MCP server via WebSocket.
 * The MCP server can run on a NAS, VPS, or any remote host.
 *
 * WebSocket URL is built from plugin settings:
 *   Foundry over HTTPS → wss://[serverHost]:[serverPort]/ws
 *   Foundry over HTTP  → ws://[serverHost]:[serverPort]/ws
 *
 * Typical configurations:
 *   • Server on NAS via reverse proxy (subdomain on port 443):
 *       serverHost = mcp.yourdomain.com  |  serverPort = 443
 *       → wss://mcp.yourdomain.com/ws
 *
 *   • Server on NAS, local network only:
 *       serverHost = 192.168.1.100  |  serverPort = 3001
 *       → ws://192.168.1.100:3001/ws  (HTTP Foundry only)
 *
 *   • Server on external VPS:
 *       serverHost = mcp.yourdomain.com  |  serverPort = 443
 *       → wss://mcp.yourdomain.com/ws
 *
 * @author Zorgonaute84
 * @license MIT
 */

const MODULE_ID    = 'foundry-mcp-plugin';
const MODULE_TITLE = 'Foundry MCP Plugin';

// ─── Main class ───────────────────────────────────────────────────────────────

class FoundryMCPPlugin {
  constructor() {
    this._ws                = null;
    this._isConnecting      = false;
    this._reconnectTimer    = null;
    this._reconnectAttempts = 0;
    this._maxReconnects     = 3;
    this._pingInterval      = null;
    this._authenticated     = false;
    this._connected         = false;
  }

  // ── Settings accessors ──

  get _host()    { return game.settings.get(MODULE_ID, 'serverHost'); }
  get _port()    { return game.settings.get(MODULE_ID, 'serverPort'); }
  get _apiKey()  { return game.settings.get(MODULE_ID, 'apiKey'); }
  get _enabled() { return game.settings.get(MODULE_ID, 'enabled'); }

  /**
   * WebSocket URL built from settings.
   * Uses wss:// if the page is loaded over HTTPS, ws:// otherwise.
   * The /ws path is fixed — matches the WebSocket endpoint of the MCP server.
   */
  get _wsUrl() {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${this._host}:${this._port}/ws`;
  }

  // ── Settings registration ─────────────────────────────────────────────────

  registerSettings() {

    game.settings.register(MODULE_ID, 'enabled', {
      name: 'Enable MCP bridge',
      hint: 'Enable or disable the connection to the MCP server.',
      scope: 'world',
      config: true,
      type: Boolean,
      default: true,
      onChange: (val) => val ? this._startFresh() : this.disconnect(),
    });

    game.settings.register(MODULE_ID, 'serverHost', {
      name: 'MCP server host',
      hint: 'Hostname or IP of the MCP server. Examples: "mcp.yourdomain.com" (NAS/VPS via reverse proxy), "192.168.1.100" (local NAS).',
      scope: 'world',
      config: true,
      type: String,
      default: 'mcp.yourdomain.com',
      onChange: () => this._reconnectIfEnabled(),
    });

    game.settings.register(MODULE_ID, 'serverPort', {
      name: 'MCP server port',
      hint: 'Port exposed by the MCP server. Use 443 if behind a reverse proxy (recommended), or 3001 for direct access.',
      scope: 'world',
      config: true,
      type: Number,
      default: 443,
      onChange: () => this._reconnectIfEnabled(),
    });

    game.settings.register(MODULE_ID, 'apiKey', {
      name: 'WebSocket API key (optional)',
      hint: 'Matches WS_API_KEY in the server config.json. Leave empty if not configured.',
      scope: 'world',
      config: true,
      type: String,
      default: '',
      onChange: () => this._reconnectIfEnabled(),
    });

    game.settings.register(MODULE_ID, 'connectionStatus', {
      scope: 'world',
      config: false,
      type: String,
      default: 'disconnected',
    });
  }

  // ── Connection ────────────────────────────────────────────────────────────

  _startFresh() {
    this._reconnectAttempts = 0;
    this.connect();
  }

  connect() {
    if (!this._enabled || !game.user?.isGM) return;
    if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) return;
    if (this._isConnecting) return;

    this._isConnecting  = true;
    this._authenticated = false;
    this._connected     = false;

    const url = this._wsUrl;
    this._log(`Attempt ${this._reconnectAttempts + 1}/${this._maxReconnects} → ${url}`);
    ui.notifications?.info(`🔄 ${MODULE_TITLE}: Connecting to MCP server… (${url})`);

    try {
      this._ws = new WebSocket(url);

      this._ws.onopen = () => {
        this._isConnecting      = false;
        this._reconnectAttempts = 0;
        this._log('WebSocket open');
        const key = this._apiKey;
        if (key) {
          this._send({ type: 'auth', apiKey: key });
        } else {
          this._authenticated = true;
          this._onAuthenticated();
        }
      };

      this._ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);
          await this._handleMessage(msg);
        } catch (e) { this._log(`Parse error: ${e.message}`, 'error'); }
      };

      this._ws.onclose = (event) => {
        const wasConnected  = this._connected;
        this._isConnecting  = false;
        this._authenticated = false;
        this._connected     = false;
        this._stopPing();
        this._setStatus('disconnected');
        if (wasConnected) {
          ui.notifications?.warn(`⚠️ ${MODULE_TITLE}: Connection lost.`);
        }
        if (this._enabled) this._scheduleReconnect();
      };

      this._ws.onerror = () => { this._isConnecting = false; };

    } catch (e) {
      this._isConnecting = false;
      this._log(`WebSocket creation error: ${e.message}`, 'error');
      if (this._enabled) this._scheduleReconnect();
    }
  }

  disconnect() {
    this._clearReconnect();
    this._stopPing();
    if (this._ws) { this._ws.close(1000, 'Disconnected'); this._ws = null; }
    this._authenticated = false;
    this._connected     = false;
    this._setStatus('disconnected');
    this._refreshSettingsDisplay();
  }

  _onAuthenticated() {
    this._connected = true;
    this._log('Connected ✅');
    this._setStatus('connected');
    this._refreshSettingsDisplay();
    ui.notifications?.info(`✅ ${MODULE_TITLE}: Connected to MCP server.`);
    this._send({
      type: 'plugin-connected',
      data: {
        foundryVersion: game.version,
        worldId:        game.world?.id,
        worldTitle:     game.world?.title,
        systemId:       game.system?.id,
        systemTitle:    game.system?.title,
        moduleVersion:  game.modules?.get(MODULE_ID)?.version ?? '2.0.0',
      }
    });
    this._startPing();
  }

  // ── Message handling ──────────────────────────────────────────────────────

  async _handleMessage(msg) {
    switch (msg.type) {
      case 'auth-ok':
        this._authenticated = true;
        this._onAuthenticated();
        break;
      case 'mcp-query':
        await this._handleQuery(msg);
        break;
      case 'pong':
        break;
      default:
        this._log(`Unknown message type: ${msg.type}`, 'warn');
    }
  }

  async _handleQuery(msg) {
    const { id, data } = msg;
    const { method, params } = data ?? {};
    if (!game.user?.isGM) { this._respond(id, false, null, 'Access denied: GM only'); return; }
    this._log(`Request: ${method} [${id}]`);
    try {
      let result;
      switch (method) {
        case 'ping':
          result = { pong: true, timestamp: Date.now(), world: game.world?.title, system: game.system?.id };
          break;
        // Journals
        case 'getWorldInfo':      result = this._getWorldInfo(); break;
        case 'listJournals':      result = this._listJournals(params ?? {}); break;
        case 'getJournal':        result = await this._getJournal(params ?? {}); break;
        case 'createJournal':     result = await this._createJournal(params ?? {}); break;
        case 'updateJournalPage': result = await this._updateJournalPage(params ?? {}); break;
        case 'addJournalPage':    result = await this._addJournalPage(params ?? {}); break;
        case 'deleteJournalPage': result = await this._deleteJournalPage(params ?? {}); break;
        case 'deleteJournal':     result = await this._deleteJournal(params ?? {}); break;
        // Actors
        case 'listActors':        result = this._listActors(params ?? {}); break;
        case 'getActor':          result = await this._getActor(params ?? {}); break;
        case 'createActor':       result = await this._createActor(params ?? {}); break;
        case 'updateActor':       result = await this._updateActor(params ?? {}); break;
        case 'deleteActor':       result = await this._deleteActor(params ?? {}); break;
        // Items
        case 'listItems':         result = this._listItems(params ?? {}); break;
        case 'getItem':           result = await this._getItem(params ?? {}); break;
        case 'createItem':        result = await this._createItem(params ?? {}); break;
        case 'updateItem':        result = await this._updateItem(params ?? {}); break;
        case 'deleteItem':        result = await this._deleteItem(params ?? {}); break;
        // Chat & Dice
        case 'sendChatMessage':   result = await this._sendChatMessage(params ?? {}); break;
        case 'rollDice':          result = await this._rollDice(params ?? {}); break;
        case 'getRecentMessages': result = this._getRecentMessages(params ?? {}); break;
        // Playlists
        case 'listPlaylists':     result = this._listPlaylists(); break;
        case 'playPlaylist':      result = await this._playPlaylist(params ?? {}); break;
        case 'stopPlaylist':      result = await this._stopPlaylist(params ?? {}); break;
        case 'stopAllSounds':     result = await this._stopAllSounds(); break;
        // Users
        case 'listUsers':         result = this._listUsers(); break;
        // Folders
        case 'listFolders':       result = this._listFolders(params ?? {}); break;
        case 'createFolder':      result = await this._createFolder(params ?? {}); break;
        // Macros
        case 'listMacros':        result = this._listMacros(); break;
        case 'executeMacro':      result = await this._executeMacro(params ?? {}); break;
        default: throw new Error(`Unknown method: ${method}`);
      }
      this._respond(id, true, result);
    } catch (e) {
      this._log(`Error ${method}: ${e.message}`, 'error');
      this._respond(id, false, null, e.message);
    }
  }

  // ── World ─────────────────────────────────────────────────────────────────

  _getWorldInfo() {
    return {
      id: game.world?.id, title: game.world?.title, description: game.world?.description,
      system: { id: game.system?.id, title: game.system?.title, version: game.system?.version },
      foundryVersion: game.version,
      activeModules: (game.modules?.contents ?? []).filter(m => m.active)
        .map(m => ({ id: m.id, title: m.title, version: m.version })),
    };
  }

  // ── Journals ──────────────────────────────────────────────────────────────

  _listJournals({ folder } = {}) {
    let journals = game.journal?.contents ?? [];
    if (folder) {
      const f = game.folders?.find(f => f.type === 'JournalEntry' && f.name === folder);
      if (!f) return { journals: [], warning: `Folder "${folder}" not found.` };
      journals = journals.filter(j => j.folder?.id === f.id);
    }
    return {
      total: journals.length,
      journals: journals.map(j => ({
        id: j.id, name: j.name, folder: j.folder?.name ?? null, folderId: j.folder?.id ?? null,
        pageCount: j.pages?.size ?? 0,
        pages: (j.pages?.contents ?? []).map(p => ({ id: p.id, name: p.name, type: p.type, sort: p.sort })),
      })),
    };
  }

  async _getJournal({ id, name } = {}) {
    const j = this._findJournal(id, name);
    if (!j) throw new Error(`Journal not found: ${id || name}`);
    return {
      id: j.id, name: j.name, folder: j.folder?.name ?? null, folderId: j.folder?.id ?? null,
      pages: (j.pages?.contents ?? []).map(p => ({
        id: p.id, name: p.name, type: p.type, sort: p.sort,
        content: p.text?.content ?? null, markdown: p.text?.markdown ?? null, src: p.src ?? null,
      })),
    };
  }

  async _createJournal({ name, folder, content, pageTitle, pageType = 'text' } = {}) {
    if (!name) throw new Error('Name is required.');
    const data = { name, pages: [] };
    if (folder) {
      const f = game.folders?.find(f => f.type === 'JournalEntry' && f.name === folder);
      if (!f) throw new Error(`Folder "${folder}" not found.`);
      data.folder = f.id;
    }
    if (content !== undefined || pageTitle) {
      const p = { name: pageTitle || name, type: pageType, sort: 100000 };
      if (pageType === 'text') p.text = { content: content || '' };
      data.pages = [p];
    }
    const j = await JournalEntry.create(data);
    return { id: j.id, name: j.name, folder: j.folder?.name ?? null, created: true,
      pages: (j.pages?.contents ?? []).map(p => ({ id: p.id, name: p.name, type: p.type })) };
  }

  async _updateJournalPage({ journalId, journalName, pageId, pageName, content, title } = {}) {
    const j = this._findJournal(journalId, journalName);
    if (!j) throw new Error(`Journal not found: ${journalId || journalName}`);
    const p = this._findPage(j, pageId, pageName);
    if (!p) throw new Error(`Page not found: ${pageId || pageName}`);
    if (content === undefined && title === undefined) throw new Error('Provide content or title.');
    const u = {};
    if (content !== undefined) u['text.content'] = content;
    if (title   !== undefined) u.name = title;
    await p.update(u);
    return { journalId: j.id, journalName: j.name, pageId: p.id, pageName: p.name, updated: true };
  }

  async _addJournalPage({ journalId, journalName, title, content, type = 'text' } = {}) {
    const j = this._findJournal(journalId, journalName);
    if (!j) throw new Error(`Journal not found: ${journalId || journalName}`);
    if (!title) throw new Error('Title is required.');
    const maxSort = Math.max(0, ...(j.pages?.contents ?? []).map(p => p.sort ?? 0));
    const pd = { name: title, type, sort: maxSort + 100000 };
    if (type === 'text') pd.text = { content: content || '' };
    const [page] = await j.createEmbeddedDocuments('JournalEntryPage', [pd]);
    return { journalId: j.id, journalName: j.name, pageId: page.id, pageName: page.name, type: page.type, created: true };
  }

  async _deleteJournalPage({ journalId, journalName, pageId, pageName } = {}) {
    const j = this._findJournal(journalId, journalName);
    if (!j) throw new Error(`Journal not found: ${journalId || journalName}`);
    const p = this._findPage(j, pageId, pageName);
    if (!p) throw new Error(`Page not found: ${pageId || pageName}`);
    const info = { pageId: p.id, pageName: p.name };
    await p.delete();
    return { journalId: j.id, journalName: j.name, ...info, deleted: true };
  }

  async _deleteJournal({ id, name } = {}) {
    const j = this._findJournal(id, name);
    if (!j) throw new Error(`Journal not found: ${id || name}`);
    const info = { journalId: j.id, journalName: j.name };
    await j.delete();
    return { ...info, deleted: true };
  }

  _findJournal(id, name) {
    if (id)   return game.journal?.get(id)       ?? null;
    if (name) return game.journal?.getName(name) ?? null;
    return null;
  }

  _findPage(j, pageId, pageName) {
    if (pageId)   return j.pages?.get(pageId) ?? null;
    if (pageName) return (j.pages?.contents ?? []).find(p => p.name === pageName) ?? null;
    const pages = j.pages?.contents ?? [];
    return pages.length === 1 ? pages[0] : null;
  }

  // ── Actors ────────────────────────────────────────────────────────────────

  _listActors({ type, folder } = {}) {
    let actors = game.actors?.contents ?? [];
    if (type)   actors = actors.filter(a => a.type === type);
    if (folder) {
      const f = game.folders?.find(f => f.type === 'Actor' && f.name === folder);
      if (!f) return { actors: [], warning: `Folder "${folder}" not found.` };
      actors = actors.filter(a => a.folder?.id === f.id);
    }
    return {
      total: actors.length,
      actors: actors.map(a => ({
        id: a.id, name: a.name, type: a.type,
        folder: a.folder?.name ?? null, folderId: a.folder?.id ?? null,
        img: a.img,
      })),
    };
  }

  async _getActor({ id, name } = {}) {
    const a = this._findActor(id, name);
    if (!a) throw new Error(`Actor not found: ${id || name}`);
    return {
      id: a.id, name: a.name, type: a.type,
      folder: a.folder?.name ?? null, img: a.img,
      system: a.system,
      items: (a.items?.contents ?? []).map(i => ({ id: i.id, name: i.name, type: i.type, img: i.img })),
      effects: (a.effects?.contents ?? []).map(e => ({ id: e.id, name: e.name ?? e.label ?? '', disabled: e.disabled })),
    };
  }

  async _createActor({ name, type, folder, data } = {}) {
    if (!name) throw new Error('Name is required.');
    if (!type) throw new Error('Type is required.');
    const actorData = { name, type, system: data || {} };
    if (folder) {
      const f = game.folders?.find(f => f.type === 'Actor' && f.name === folder);
      if (!f) throw new Error(`Folder "${folder}" not found.`);
      actorData.folder = f.id;
    }
    const a = await Actor.create(actorData);
    return { id: a.id, name: a.name, type: a.type, created: true };
  }

  async _updateActor({ id, name, data } = {}) {
    const a = this._findActor(id, name);
    if (!a) throw new Error(`Actor not found: ${id || name}`);
    if (!data) throw new Error('Provide data with fields to update.');
    await a.update(data);
    return { id: a.id, name: a.name, updated: true };
  }

  async _deleteActor({ id, name } = {}) {
    const a = this._findActor(id, name);
    if (!a) throw new Error(`Actor not found: ${id || name}`);
    const info = { actorId: a.id, actorName: a.name };
    await a.delete();
    return { ...info, deleted: true };
  }

  _findActor(id, name) {
    if (id)   return game.actors?.get(id)       ?? null;
    if (name) return game.actors?.getName(name) ?? null;
    return null;
  }

  // ── Items ─────────────────────────────────────────────────────────────────

  _listItems({ type, folder } = {}) {
    let items = game.items?.contents ?? [];
    if (type)   items = items.filter(i => i.type === type);
    if (folder) {
      const f = game.folders?.find(f => f.type === 'Item' && f.name === folder);
      if (!f) return { items: [], warning: `Folder "${folder}" not found.` };
      items = items.filter(i => i.folder?.id === f.id);
    }
    return {
      total: items.length,
      items: items.map(i => ({
        id: i.id, name: i.name, type: i.type,
        folder: i.folder?.name ?? null, img: i.img,
      })),
    };
  }

  async _getItem({ id, name } = {}) {
    const item = this._findItem(id, name);
    if (!item) throw new Error(`Item not found: ${id || name}`);
    return {
      id: item.id, name: item.name, type: item.type,
      folder: item.folder?.name ?? null, img: item.img,
      system: item.system,
      effects: (item.effects?.contents ?? []).map(e => ({ id: e.id, name: e.name ?? e.label ?? '' })),
    };
  }

  async _createItem({ name, type, folder, data } = {}) {
    if (!name) throw new Error('Name is required.');
    if (!type) throw new Error('Type is required.');
    const itemData = { name, type, system: data || {} };
    if (folder) {
      const f = game.folders?.find(f => f.type === 'Item' && f.name === folder);
      if (!f) throw new Error(`Folder "${folder}" not found.`);
      itemData.folder = f.id;
    }
    const item = await Item.create(itemData);
    return { id: item.id, name: item.name, type: item.type, created: true };
  }

  async _updateItem({ id, name, data } = {}) {
    const item = this._findItem(id, name);
    if (!item) throw new Error(`Item not found: ${id || name}`);
    if (!data) throw new Error('Provide data with fields to update.');
    await item.update(data);
    return { id: item.id, name: item.name, updated: true };
  }

  async _deleteItem({ id, name } = {}) {
    const item = this._findItem(id, name);
    if (!item) throw new Error(`Item not found: ${id || name}`);
    const info = { itemId: item.id, itemName: item.name };
    await item.delete();
    return { ...info, deleted: true };
  }

  _findItem(id, name) {
    if (id)   return game.items?.get(id)       ?? null;
    if (name) return game.items?.getName(name) ?? null;
    return null;
  }

  // ── Chat & Dice ───────────────────────────────────────────────────────────

  async _sendChatMessage({ content, whisperTo } = {}) {
    if (!content) throw new Error('Content is required.');
    const data = { content, speaker: ChatMessage.getSpeaker() };
    if (whisperTo?.length > 0) {
      const ids = whisperTo
        .map(n => game.users?.find(u => u.name === n || u.id === n)?.id)
        .filter(Boolean);
      if (ids.length > 0) data.whisper = ids;
    }
    const msg = await ChatMessage.create(data);
    return { id: msg.id, content: msg.content, created: true };
  }

  async _rollDice({ formula, flavor } = {}) {
    if (!formula) throw new Error('Formula is required.');
    const roll = await new Roll(formula).evaluate();
    const msgData = { rolls: [roll.toJSON()], speaker: ChatMessage.getSpeaker() };
    if (flavor) msgData.flavor = flavor;
    const msg = await ChatMessage.create(msgData);
    return {
      formula, total: roll.total, result: roll.result,
      terms: roll.terms.map(t => ({
        type: t.constructor.name,
        results: t.results?.map(r => r.result) ?? [],
        number: t.number, faces: t.faces,
      })),
      messageId: msg.id, created: true,
    };
  }

  _getRecentMessages({ limit = 20 } = {}) {
    const messages = (game.messages?.contents ?? []).slice(-Math.min(limit, 100));
    return {
      total: messages.length,
      messages: messages.map(m => ({
        id: m.id, content: m.content,
        speaker: m.speaker, timestamp: m.timestamp,
        whisper: m.whisper,
        rolls: (m.rolls ?? []).map(r => ({ formula: r.formula, total: r.total })),
      })),
    };
  }

  // ── Playlists & Audio ─────────────────────────────────────────────────────

  _listPlaylists() {
    const playlists = game.playlists?.contents ?? [];
    return {
      total: playlists.length,
      playlists: playlists.map(p => ({
        id: p.id, name: p.name, playing: p.playing,
        sounds: (p.sounds?.contents ?? []).map(s => ({
          id: s.id, name: s.name, playing: s.playing,
          repeat: s.repeat, volume: s.volume,
        })),
      })),
    };
  }

  async _playPlaylist({ id, name, soundName } = {}) {
    const p = this._findPlaylist(id, name);
    if (!p) throw new Error(`Playlist not found: ${id || name}`);
    if (soundName) {
      const sound = p.sounds?.contents.find(s => s.name === soundName);
      if (!sound) throw new Error(`Sound "${soundName}" not found in playlist.`);
      await p.playSound(sound);
      return { playlistId: p.id, playlistName: p.name, soundName: sound.name, playing: true };
    }
    await p.playAll();
    return { playlistId: p.id, playlistName: p.name, playing: true };
  }

  async _stopPlaylist({ id, name } = {}) {
    const p = this._findPlaylist(id, name);
    if (!p) throw new Error(`Playlist not found: ${id || name}`);
    await p.stopAll();
    return { playlistId: p.id, playlistName: p.name, playing: false };
  }

  async _stopAllSounds() {
    for (const p of (game.playlists?.contents ?? [])) {
      if (p.playing) await p.stopAll();
    }
    return { stopped: true };
  }

  _findPlaylist(id, name) {
    if (id)   return game.playlists?.get(id)       ?? null;
    if (name) return game.playlists?.getName(name) ?? null;
    return null;
  }

  // ── Users ─────────────────────────────────────────────────────────────────

  _listUsers() {
    return {
      total: game.users?.size ?? 0,
      users: (game.users?.contents ?? []).map(u => ({
        id: u.id, name: u.name, active: u.active,
        isGM: u.isGM, role: u.role, color: u.color,
        character: u.character?.name ?? null,
      })),
    };
  }

  // ── Folders ───────────────────────────────────────────────────────────────

  _listFolders({ type } = {}) {
    let folders = game.folders?.contents ?? [];
    if (type) folders = folders.filter(f => f.type === type);
    return {
      total: folders.length,
      folders: folders.map(f => ({
        id: f.id, name: f.name, type: f.type,
        parent: f.folder?.name ?? null, parentId: f.folder?.id ?? null,
        depth: f.depth,
      })),
    };
  }

  async _createFolder({ name, type, parent, color } = {}) {
    const valid = ['Actor','Item','JournalEntry','Macro','Playlist','RollTable','Scene'];
    if (!name) throw new Error('Name is required.');
    if (!type || !valid.includes(type)) throw new Error(`Invalid type. Valid values: ${valid.join(', ')}`);
    const data = { name, type, color: color ?? '#000000' };
    if (parent) {
      const pf = game.folders?.find(f => f.type === type && f.name === parent);
      if (!pf) throw new Error(`Parent folder "${parent}" not found.`);
      data.folder = pf.id;
    }
    const f = await Folder.create(data);
    return { id: f.id, name: f.name, type: f.type, parent: f.folder?.name ?? null, created: true };
  }

  // ── Macros ────────────────────────────────────────────────────────────────

  _listMacros() {
    return {
      total: game.macros?.size ?? 0,
      macros: (game.macros?.contents ?? []).map(m => ({
        id: m.id, name: m.name, type: m.type,
        img: m.img, scope: m.scope,
        folder: m.folder?.name ?? null,
      })),
    };
  }

  async _executeMacro({ id, name } = {}) {
    const macro = id ? game.macros?.get(id) : game.macros?.getName(name);
    if (!macro) throw new Error(`Macro not found: ${id || name}`);
    if (!macro.canExecute) throw new Error(`Cannot execute macro "${macro.name}" (insufficient permissions).`);
    await macro.execute();
    return { macroId: macro.id, macroName: macro.name, executed: true };
  }

  // ── Communication ─────────────────────────────────────────────────────────

  _send(msg)                    { if (this._ws?.readyState === WebSocket.OPEN) this._ws.send(JSON.stringify(msg)); }
  _respond(id, ok, data, error) {
    this._send({ type: 'mcp-response', id,
      data: ok ? { success: true, data } : { success: false, error: error || 'Unknown error' } });
  }

  // ── Ping ──────────────────────────────────────────────────────────────────

  _startPing() {
    this._stopPing();
    this._pingInterval = setInterval(() => {
      if (this._ws?.readyState === WebSocket.OPEN) this._send({ type: 'ping', timestamp: Date.now() });
    }, 30_000);
  }
  _stopPing() { if (this._pingInterval) { clearInterval(this._pingInterval); this._pingInterval = null; } }

  // ── Reconnection ──────────────────────────────────────────────────────────

  _scheduleReconnect() {
    if (!this._enabled) return;
    if (this._reconnectAttempts >= this._maxReconnects) {
      const url = this._wsUrl;
      this._log(`Giving up after ${this._maxReconnects} attempts.`, 'warn');
      ui.notifications?.error(
        `❌ ${MODULE_TITLE}: Could not connect after ${this._maxReconnects} attempts.\n` +
        `URL: ${url}\n` +
        `Check: 1) MCP server is running  2) Host and port are correct  3) Reverse proxy is configured`
      );
      this._setStatus('error');
      this._refreshSettingsDisplay();
      return;
    }
    this._reconnectAttempts++;
    ui.notifications?.warn(`⚠️ ${MODULE_TITLE}: Attempt ${this._reconnectAttempts}/${this._maxReconnects} failed. Retrying in 3s…`);
    this._clearReconnect();
    this._reconnectTimer = setTimeout(() => this.connect(), 3000);
  }

  _clearReconnect()     { if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; } }
  _reconnectIfEnabled() {
    if (!game.user?.isGM) return;
    this.disconnect();
    if (this._enabled) { this._reconnectAttempts = 0; setTimeout(() => this.connect(), 500); }
  }

  // ── Status ────────────────────────────────────────────────────────────────

  getStatus() {
    if (this._connected) return 'connected';
    if (this._isConnecting || this._reconnectTimer) return 'connecting';
    try { return game.settings.get(MODULE_ID, 'connectionStatus') ?? 'disconnected'; } catch (_) { return 'disconnected'; }
  }

  async _setStatus(s) { try { await game.settings.set(MODULE_ID, 'connectionStatus', s); } catch (_) {} }

  _refreshSettingsDisplay() {
    const badge = document.querySelector(`#${MODULE_ID}-status-badge`);
    if (!badge) return;
    const s = this.getStatus();
    badge.className = `fred-mcp-status-badge fred-mcp-status-${s}`;
    badge.textContent = { connected: '✅ Connected', connecting: '🔄 Connecting…', error: '❌ Error', disconnected: '⭕ Disconnected' }[s] ?? s;
  }

  _log(msg, level = 'info') {
    const p = `[${MODULE_ID}]`;
    if (level === 'error') console.error(p, msg);
    else if (level === 'warn') console.warn(p, msg);
    else console.log(p, msg);
  }
}

// ─── Instance & hooks ─────────────────────────────────────────────────────────

const foundryMCPPlugin = new FoundryMCPPlugin();
window.foundryMCPPlugin = foundryMCPPlugin;

Hooks.once('init', () => { foundryMCPPlugin.registerSettings(); console.log(`[${MODULE_ID}] Initialized`); });

Hooks.once('ready', () => {
  if (!game.user?.isGM) return;
  if (foundryMCPPlugin._enabled) foundryMCPPlugin._startFresh();
  console.log(`[${MODULE_ID}] Ready`);
});

Hooks.on('closeSettingsConfig', () => {
  if (!game.user?.isGM) return;
  foundryMCPPlugin._reconnectIfEnabled();
});

window.addEventListener('beforeunload', () => foundryMCPPlugin.disconnect());

// ─── Connection status in settings UI ────────────────────────────────────────

Hooks.on('renderSettingsConfig', (_app, html) => {
  const section = html instanceof jQuery
    ? html.find(`[data-category="${MODULE_ID}"]`)[0]
    : html.querySelector?.(`[data-category="${MODULE_ID}"]`);
  if (!section) return;

  const s      = foundryMCPPlugin.getStatus();
  const labels = { connected: '✅ Connected', connecting: '🔄 Connecting…', error: '❌ Error', disconnected: '⭕ Disconnected' };

  const banner = document.createElement('div');
  banner.className = 'form-group';
  banner.innerHTML = `
    <label>Connection status</label>
    <div class="form-fields">
      <span id="${MODULE_ID}-status-badge" class="fred-mcp-status-badge fred-mcp-status-${s}">${labels[s] ?? s}</span>
      <button type="button" id="${MODULE_ID}-reconnect-btn" style="margin-left:8px;padding:2px 10px;font-size:12px;">🔄 Reconnect</button>
    </div>
    <p class="notes">WebSocket: <code>${foundryMCPPlugin._wsUrl}</code></p>
  `;

  section.prepend(banner);
  banner.querySelector(`#${MODULE_ID}-reconnect-btn`)?.addEventListener('click', () => {
    foundryMCPPlugin._reconnectAttempts = 0;
    foundryMCPPlugin.disconnect();
    setTimeout(() => foundryMCPPlugin.connect(), 300);
  });
});
