import { open } from 'glimpseui';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getCompanionSocketPath, usesNamedPipe } from './socket-path.mjs';

const SOCK = getCompanionSocketPath();
const RUNCAT_FONT_DATA_URL = `data:font/truetype;base64,${readFileSync(join(homedir(), 'Library', 'Fonts', 'runcat.ttf')).toString('base64')}`;

// ── status config ─────────────────────────────────────────────────────────────

const STATUS_COLOR = {
  starting:  '#22C55E',
  thinking:  '#F59E0B',
  reading:   '#3B82F6',
  editing:   '#FACC15',
  running:   '#F97316',
  searching: '#8B5CF6',
  done:      '#22C55E',
  error:     '#EF4444',
};

const STATUS_LABEL = {
  thinking:  'Working',
  reading:   'Reading',
  editing:   'Editing',
  running:   'Running',
  searching: 'Searching',
  done:      'Done',
  error:     'Error',
};

// ── HTML ──────────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function truncate(s, max = 100) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function buildHTML() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
@font-face {
  font-family: 'RunCat';
  src: url('${RUNCAT_FONT_DATA_URL}') format('truetype');
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: transparent !important;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 11px;
  font-weight: 600;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  font-optical-sizing: auto;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  height: 100vh;
}
#pill {
  width: fit-content;
  background: rgba(0,0,0,0.45);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  border-radius: 8px;
  padding: 2px 0;
  transition: opacity 0.3s ease-out;
}
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
}
.cat {
  width: 14px;
  color: #22C55E;
  flex-shrink: 0;
  font-family: 'RunCat';
  font-size: 13px;
  font-weight: 400;
  line-height: 1;
  transition: color 0.2s ease;
}
.project {
  color: rgba(255,255,255,0.95);
  font-weight: 500;
  flex-shrink: 0;
}
.sep { color: rgba(255,255,255,0.5); flex-shrink: 0; }
.status { color: rgba(255,255,255,0.9); flex-shrink: 0; }
.detail {
  color: rgba(255,255,255,0.75);
  font-family: ui-monospace, 'SF Mono', monospace;
  font-size: 10px;
  white-space: nowrap;
}
.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px 4px 21px;
  font-size: 10px;
  font-weight: 500;
  color: rgba(255,255,255,0.85);
  font-family: ui-monospace, 'SF Mono', monospace;
}
.meta-sep { margin: 0 2px; }
</style>
</head>
<body>
<div id="pill"></div>
<script>
var _rows = {};
var _startTimes = {};
var _frozenElapsed = {};
var _tickTimer = null;
var _catTimer = null;
var _catFrame = 0;
var _catFrames = ['\ue900', '\ue901', '\ue902', '\ue903', '\ue904'];

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function fmtElapsed(ms) {
  var s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  var m = Math.floor(s / 60);
  s = s % 60;
  return m + 'm ' + (s < 10 ? '0' : '') + s + 's';
}

function startTick() {
  if (_tickTimer) return;
  _tickTimer = setInterval(function() {
    var ids = Object.keys(_rows);
    if (ids.length === 0) { clearInterval(_tickTimer); _tickTimer = null; return; }
    for (var i = 0; i < ids.length; i++) {
      if (_frozenElapsed[ids[i]]) continue;
      var el = document.getElementById('elapsed-' + ids[i]);
      if (el && _startTimes[ids[i]]) {
        el.textContent = fmtElapsed(Date.now() - _startTimes[ids[i]]);
      }
    }
  }, 1000);
}

function startCatTick() {
  if (_catTimer) return;
  _catTimer = setInterval(function() {
    var ids = Object.keys(_rows);
    if (ids.length === 0) { clearInterval(_catTimer); _catTimer = null; return; }
    _catFrame = (_catFrame + 1) % _catFrames.length;
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById('cat-' + ids[i]);
      if (el) el.textContent = _catFrames[_catFrame];
    }
  }, 167);
}

function update(id, dotColor, project, status, detail, contextPercent) {
  if (!_startTimes[id]) _startTimes[id] = Date.now();
  if (status === 'Done' && _startTimes[id] && !_frozenElapsed[id]) {
    _frozenElapsed[id] = fmtElapsed(Date.now() - _startTimes[id]);
  }
  _rows[id] = { dotColor: dotColor, project: project, status: status, detail: detail, contextPercent: contextPercent };
  render();
  startTick();
  startCatTick();
}

function remove(id) {
  delete _rows[id];
  delete _startTimes[id];
  delete _frozenElapsed[id];
  render();
}

function render() {
  var pill = document.getElementById('pill');
  var ids = Object.keys(_rows);
  if (ids.length === 0) {
    pill.style.opacity = '0';
    setTimeout(function() { pill.innerHTML = ''; }, 350);
    return;
  }
  pill.style.opacity = '1';
  var html = '';
  for (var i = 0; i < ids.length; i++) {
    var r = _rows[ids[i]];
    html += '<div id="r-' + ids[i] + '">';
    html += '<div class="row">';
    html += '<span id="cat-' + ids[i] + '" class="cat" style="color:' + r.dotColor + '">' + _catFrames[_catFrame] + '</span>';
    html += '<span class="project">' + esc(r.project) + '</span>';
    if (r.status) {
      html += '<span class="sep">·</span>';
      html += '<span class="status">' + esc(r.status) + '</span>';
    }
    if (r.detail) {
      html += '<span class="detail">' + esc(r.detail) + '</span>';
    }
    html += '</div>';
    // Meta row
    var frozen = _frozenElapsed[ids[i]];
    var elapsed = frozen || (_startTimes[ids[i]] ? fmtElapsed(Date.now() - _startTimes[ids[i]]) : '');
    html += '<div class="meta">';
    if (r.contextPercent != null) {
      html += '<span id="ctx-' + ids[i] + '">' + r.contextPercent + '%</span>';
      html += '<span class="meta-sep">·</span>';
    }
    if (frozen) {
      html += '<span id="elapsed-' + ids[i] + '" style="font-weight:700">' + elapsed + '</span>';
    } else {
      html += '<span id="elapsed-' + ids[i] + '">' + elapsed + '</span>';
    }
    html += '</div>';
    html += '</div>';
  }
  pill.innerHTML = html;
}
</script>
</body>
</html>`;
}

// ── state ─────────────────────────────────────────────────────────────────────

const agents = new Map(); // id → { project, status, detail }
const sockets = new Set(); // active client connections
let win = null;
let winReady = false;
let pendingUpdates = []; // buffered calls until window is ready
let idleTimer = null;

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (agents.size === 0 && sockets.size === 0) {
      cleanup();
      process.exit(0);
    }
  }, 5000);
}

// ── render ─────────────────────────────────────────────────────────────────────

function pushUpdate(id, data) {
  const color = STATUS_COLOR[data.status] ?? '#6B7280';
  const label = STATUS_LABEL[data.status] ?? '';
  const detail = truncate(data.detail ?? '', 60);
  const project = esc(data.project ?? 'pi');
  const ctxPct = data.contextPercent ?? null;
  const js = `update(${JSON.stringify(id)},${JSON.stringify(color)},${JSON.stringify(project)},${JSON.stringify(label)},${JSON.stringify(detail)},${JSON.stringify(ctxPct)})`;
  if (winReady) win.send(js);
  else pendingUpdates.push(js);
}

function pushRemove(id) {
  const js = `remove(${JSON.stringify(id)})`;
  if (winReady) win.send(js);
  else pendingUpdates.push(js);
}

// ── socket server ─────────────────────────────────────────────────────────────

// Clean up stale socket (not needed for Windows named pipes)
if (!usesNamedPipe(SOCK)) {
  try { unlinkSync(SOCK); } catch {}
}

const server = createServer(socket => {
  sockets.add(socket);
  const rl = createInterface({ input: socket, crlfDelay: Infinity });
  let clientId = null;

  rl.on('line', line => {
    try {
      const msg = JSON.parse(line);
      if (!msg.id) return;
      clientId = msg.id;

      if (msg.type === 'remove') {
        agents.delete(clientId);
        pushRemove(clientId);
        resetIdleTimer();
        return;
      }

      agents.set(clientId, msg);
      pushUpdate(clientId, msg);
      resetIdleTimer();
    } catch {}
  });

  socket.on('close', () => {
    sockets.delete(socket);
    if (clientId) {
      agents.delete(clientId);
      pushRemove(clientId);
    }
    resetIdleTimer();
  });

  socket.on('error', () => {});
});

server.listen(SOCK, () => {
  // Socket ready
});

// ── window ────────────────────────────────────────────────────────────────────

win = open(buildHTML(), {
  width: 630,
  height: 100,
  frameless: true,
  floating: true,
  transparent: true,
  clickThrough: true,
  noDock: true,
  followCursor: true,
  followMode: 'spring',
  cursorAnchor: 'top-right',
});

win.on('ready', info => {
  winReady = true;
  for (const js of pendingUpdates) win.send(js);
  pendingUpdates = [];
  resetIdleTimer();
});

win.on('closed', () => { cleanup(); process.exit(0); });
win.on('error', () => {});

// ── cleanup ───────────────────────────────────────────────────────────────────

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  server.close();
  if (!usesNamedPipe(SOCK)) {
    try { unlinkSync(SOCK); } catch {}
  }
  if (win) try { win.close(); } catch {}
}

process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);
