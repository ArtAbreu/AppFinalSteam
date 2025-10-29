import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

const MONTUGA_BASE_URL = 'https://montuga.com/api/IPricing/inventory';
const STEAM_API_BASE_URL = 'https://api.steampowered.com/';
const APP_ID = 730;
const USD_TO_BRL_RATE = 5.25;
const HIGH_VALUE_THRESHOLD_BRL = 3000;
const JOB_RETENTION_MS = 5 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = __dirname;
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const HISTORY_FILE = path.join(ROOT_DIR, 'history.json');
const REPORTS_DIR = path.join(ROOT_DIR, 'reports');

const MONTUGA_API_KEY = process.env.MONTUGA_API_KEY;
const STEAM_API_KEY = process.env.STEAM_API_KEY;

if (!MONTUGA_API_KEY || !STEAM_API_KEY) {
  console.error('\n❌ Falha na inicialização: defina as variáveis MONTUGA_API_KEY e STEAM_API_KEY.');
  process.exit(1);
}

if (!globalThis.fetch) {
  console.error('\n❌ A API Fetch não está disponível. Utilize Node.js 18+.');
  process.exit(1);
}

const APP_BASE_URL = (process.env.APP_BASE_URL || '').trim();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/reports', express.static(REPORTS_DIR, { maxAge: '1d' }));
app.use(express.static(DIST_DIR));

const jobs = new Map();

const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_ENTRIES = 50;
const PROCESS_DELAY_MS = 1000;
const MAX_STEAM_IDS_PER_JOB = 10000;
const MAX_STEAM_IDS_LABEL = new Intl.NumberFormat('pt-BR').format(MAX_STEAM_IDS_PER_JOB);
const MAX_PROCESSED_STEAM_IDS = 50000;
const DEFAULT_PROCESSED_HISTORY_LIMIT = 50;
const MAX_PROCESSED_HISTORY_LIMIT = 500;

function sanitizeSteamId(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }
  const digitsOnly = trimmed.replace(/[^0-9]/g, '');
  if (!/^\d{17}$/.test(digitsOnly)) {
    return null;
  }
  return digitsOnly;
}

const PLAYER_SUMMARIES_CHUNK_SIZE = 100;
const STEAM_LEVEL_CHUNK_SIZE = 20;
const MIN_STEAM_LEVEL = 16;

const steamLevelCache = new Map();

async function fetchPlayerSummaries(steamIds = []) {
  const sanitized = steamIds.map((value) => sanitizeSteamId(value)).filter(Boolean);
  if (!sanitized.length) {
    return new Map();
  }

  const uniqueIds = Array.from(new Set(sanitized));
  const summaries = new Map();

  for (let index = 0; index < uniqueIds.length; index += PLAYER_SUMMARIES_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(index, index + PLAYER_SUMMARIES_CHUNK_SIZE);
    const params = new URLSearchParams({
      key: STEAM_API_KEY,
      steamids: chunk.join(','),
    });

    try {
      const response = await fetch(`${STEAM_API_BASE_URL}ISteamUser/GetPlayerSummaries/v2/?${params.toString()}`);
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message = payload?.error?.message || payload?.message || `Falha ao recuperar resumos de perfis (HTTP ${response.status}).`;
        console.warn(message);
        continue;
      }

      const players = Array.isArray(payload?.response?.players) ? payload.response.players : [];
      for (const player of players) {
        const id = sanitizeSteamId(player?.steamid);
        if (id) {
          summaries.set(id, player);
        }
      }
    } catch (error) {
      console.warn('Não foi possível carregar resumos de amigos da Steam.', error);
    }
  }

  return summaries;
}

async function fetchSteamLevelWithCache(steamId) {
  if (steamLevelCache.has(steamId)) {
    return steamLevelCache.get(steamId);
  }

  const params = new URLSearchParams({
    key: STEAM_API_KEY,
    steamid: steamId,
  });

  let level = null;
  try {
    const response = await fetch(`${STEAM_API_BASE_URL}IPlayerService/GetSteamLevel/v1/?${params.toString()}`);
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = payload?.error?.message || payload?.message || `Falha ao recuperar nível Steam (HTTP ${response.status}).`;
      console.warn(message);
    } else if (payload?.response && typeof payload.response.player_level === 'number') {
      level = payload.response.player_level;
    }
  } catch (error) {
    console.warn(`Não foi possível consultar o nível Steam para ${steamId}.`, error);
  }

  steamLevelCache.set(steamId, level);
  return level;
}

async function fetchSteamLevels(steamIds = []) {
  const sanitized = steamIds.map((value) => sanitizeSteamId(value)).filter(Boolean);
  if (!sanitized.length) {
    return new Map();
  }

  const uniqueIds = Array.from(new Set(sanitized));
  const levels = new Map();

  for (let index = 0; index < uniqueIds.length; index += STEAM_LEVEL_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(index, index + STEAM_LEVEL_CHUNK_SIZE);
    const responses = await Promise.all(chunk.map((steamId) => fetchSteamLevelWithCache(steamId)));
    responses.forEach((level, offset) => {
      levels.set(chunk[offset], level);
    });
  }

  return levels;
}

async function fetchFriendsForSteamId(steamId) {
  const params = new URLSearchParams({
    key: STEAM_API_KEY,
    steamid: steamId,
    relationship: 'friend',
  });

  const response = await fetch(`${STEAM_API_BASE_URL}ISteamUser/GetFriendList/v1/?${params.toString()}`);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `Resposta inesperada da Steam (HTTP ${response.status})`;
    throw new Error(message);
  }

  const rawFriends = Array.isArray(payload?.friendslist?.friends)
    ? payload.friendslist.friends.map((friend) => String(friend?.steamid || '').trim()).filter(Boolean)
    : [];

  const uniqueFriends = Array.from(new Set(rawFriends.map((value) => sanitizeSteamId(value)).filter(Boolean)));

  const stats = {
    totalFriends: uniqueFriends.length,
    offlineEligible: 0,
    kept: 0,
    filteredOnline: 0,
    filteredInGame: 0,
    filteredLowLevel: 0,
    filteredMissingProfile: 0,
    filteredUnknownLevel: 0,
    levelThreshold: MIN_STEAM_LEVEL,
  };

  if (!uniqueFriends.length) {
    return {
      steamId,
      friends: [],
      friendCount: 0,
      stats,
    };
  }

  const playerSummaries = await fetchPlayerSummaries(uniqueFriends);
  const offlineCandidates = [];

  for (const friendId of uniqueFriends) {
    const summary = playerSummaries.get(friendId);
    if (!summary) {
      stats.filteredMissingProfile += 1;
      continue;
    }

    const personaState = Number(summary.personastate);
    if (Number.isFinite(personaState) && personaState !== 0) {
      stats.filteredOnline += 1;
      continue;
    }

    if (summary.gameid || summary.gameextrainfo) {
      stats.filteredInGame += 1;
      continue;
    }

    offlineCandidates.push(friendId);
  }

  stats.offlineEligible = offlineCandidates.length;

  if (!offlineCandidates.length) {
    return {
      steamId,
      friends: [],
      friendCount: uniqueFriends.length,
      stats,
    };
  }

  const steamLevels = await fetchSteamLevels(offlineCandidates);
  const filteredFriends = [];

  for (const friendId of offlineCandidates) {
    const level = steamLevels.get(friendId);
    if (typeof level === 'number') {
      if (level >= MIN_STEAM_LEVEL) {
        filteredFriends.push(friendId);
      } else {
        stats.filteredLowLevel += 1;
      }
    } else {
      stats.filteredUnknownLevel += 1;
    }
  }

  stats.kept = filteredFriends.length;

  return {
    steamId,
    friends: filteredFriends,
    friendCount: uniqueFriends.length,
    stats,
  };
}

// ----------------- Funções auxiliares -----------------
function isValidWebhookUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function currentDateTimeLabel(date = new Date()) {
  return new Date(date).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function steamProfileUrl(steamId) {
  if (!steamId) {
    return 'https://steamcommunity.com';
  }
  const trimmed = String(steamId).trim();
  return `https://steamcommunity.com/profiles/${encodeURIComponent(trimmed)}`;
}

function ensureHistoryShape(data) {
  const base = { entries: [], processedSteamIds: [] };

  if (Array.isArray(data)) {
    base.entries = data;
    return base;
  }

  if (data && typeof data === 'object') {
    if (Array.isArray(data.entries)) {
      base.entries = data.entries;
    }

    if (Array.isArray(data.processedSteamIds)) {
      const unique = new Set();
      for (const value of data.processedSteamIds) {
        const sanitized = sanitizeSteamId(value);
        if (sanitized) {
          unique.add(sanitized);
        }
      }
      base.processedSteamIds = Array.from(unique);
    }
  }

  return base;
}

function getPendingIds(job) {
  if (!job) {
    return [];
  }
  const queue = Array.isArray(job.queue) ? job.queue : [];
  const index = Number.isInteger(job.currentIndex) ? job.currentIndex : 0;
  return queue.slice(Math.max(index, 0));
}

async function loadHistory() {
  try {
    const raw = await fs.readFile(HISTORY_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return ensureHistoryShape(parsed);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Não foi possível carregar o histórico armazenado.', error);
    }
    return { entries: [], processedSteamIds: [] };
  }
}

async function saveHistory(history) {
  await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
}

function sanitizeReportSegment(value, fallback) {
  const base = (value || fallback || '').toString();
  const normalized = base.replace(/[^a-zA-Z0-9_-]/g, '_');
  return normalized || fallback || 'relatorio';
}

async function persistReportHtml(entry) {
  if (!entry?.reportHtml) {
    return null;
  }

  try {
    await fs.mkdir(REPORTS_DIR, { recursive: true });
  } catch (error) {
    console.warn('Não foi possível preparar o diretório de relatórios.', error);
    return null;
  }

  const rawGeneratedAt = entry.generatedAt || new Date().toISOString();
  let isoCandidate = '';
  if (typeof rawGeneratedAt === 'string') {
    isoCandidate = rawGeneratedAt;
  } else {
    try {
      isoCandidate = new Date(rawGeneratedAt).toISOString();
    } catch (error) {
      console.warn('Não foi possível normalizar a data de geração do relatório.', error);
      isoCandidate = new Date().toISOString();
    }
  }
  const timestamp = sanitizeReportSegment(String(isoCandidate).replace(/[:.]/g, '-'), 'data');
  const jobIdSegment = sanitizeReportSegment(entry.jobId, 'job');
  const stageSegment = entry.partial ? 'parcial' : 'final';
  const fileName = `${jobIdSegment}_${stageSegment}_${timestamp}.html`;
  const filePath = path.join(REPORTS_DIR, fileName);

  try {
    await fs.writeFile(filePath, entry.reportHtml, 'utf-8');
  } catch (error) {
    console.warn('Não foi possível salvar o relatório HTML no disco.', error);
    return null;
  }

  return path.relative(ROOT_DIR, filePath);
}

let historyUpdateQueue = Promise.resolve();

function queueHistoryMutation(mutator) {
  const task = historyUpdateQueue.then(async () => {
    const current = await loadHistory();
    const updated = await mutator(current);
    if (updated) {
      await saveHistory(updated);
    }
  });
  historyUpdateQueue = task.catch(() => {});
  return task;
}

function normalizeHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const baseJobId = entry.jobId ? String(entry.jobId).trim() : 'desconhecido';
  let generatedAtIso = new Date().toISOString();
  if (entry.generatedAt) {
    const candidate = new Date(entry.generatedAt);
    if (!Number.isNaN(candidate.getTime())) {
      generatedAtIso = candidate.toISOString();
    }
  }

  const normalized = {
    ...entry,
    jobId: baseJobId,
    generatedAt: generatedAtIso,
    partial: Boolean(entry.partial),
    reportPath:
      typeof entry.reportPath === 'string' && entry.reportPath.trim()
        ? entry.reportPath.trim().replace(/\\+/g, '/').replace(/^\/+/, '')
        : null,
  };

  normalized.reportHtml = typeof normalized.reportHtml === 'string' ? normalized.reportHtml : '';
  normalized.successCount =
    typeof normalized.successCount === 'number' && Number.isFinite(normalized.successCount)
      ? normalized.successCount
      : null;
  normalized.id = entry.id || `${normalized.jobId}-${generatedAtIso}`;

  return normalized;
}

function prepareHistoryEntries(entries = []) {
  const now = Date.now();
  const byId = new Map();

  for (const item of entries) {
    const normalized = normalizeHistoryEntry(item);
    if (!normalized) {
      continue;
    }
    const timestamp = new Date(normalized.generatedAt).getTime();
    if (Number.isNaN(timestamp) || now - timestamp > HISTORY_RETENTION_MS) {
      continue;
    }
    byId.set(normalized.id, normalized);
  }

  return Array.from(byId.values())
    .sort((a, b) => {
      const aTime = new Date(a.generatedAt).getTime();
      const bTime = new Date(b.generatedAt).getTime();
      return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
    })
    .slice(0, MAX_HISTORY_ENTRIES);
}

async function appendHistoryEntry(entry) {
  const normalizedEntry = normalizeHistoryEntry(entry);
  if (!normalizedEntry) {
    return;
  }

  await queueHistoryMutation(async (history) => {
    const entries = prepareHistoryEntries([normalizedEntry, ...(history.entries || [])]);
    return { ...history, entries };
  });
}

function buildSteamIdSet(ids = []) {
  const set = new Set();
  for (const value of ids) {
    const sanitized = sanitizeSteamId(value);
    if (sanitized) {
      set.add(sanitized);
    }
  }
  return set;
}

async function appendProcessedSteamIds(ids = []) {
  const sanitized = ids.map((value) => sanitizeSteamId(value)).filter(Boolean);
  if (!sanitized.length) {
    return;
  }

  await queueHistoryMutation(async (history) => {
    const existing = buildSteamIdSet(history.processedSteamIds);
    let changed = false;

    for (const id of sanitized) {
      if (!existing.has(id)) {
        existing.add(id);
        changed = true;
      }
    }

    if (!changed) {
      return null;
    }

    const next = Array.from(existing);
    const trimmed =
      next.length > MAX_PROCESSED_STEAM_IDS
        ? next.slice(next.length - MAX_PROCESSED_STEAM_IDS)
        : next;

    return { ...history, processedSteamIds: trimmed };
  });
}

async function loadProcessedSteamIdSet() {
  const history = await loadHistory();
  return buildSteamIdSet(history.processedSteamIds);
}

function buildTotals(results, requestedTotal) {
  const totals = {
    requested: requestedTotal,
    processed: results.length,
    clean: 0,
    vacBanned: 0,
    steamErrors: 0,
    montugaErrors: 0,
  };

  for (const profile of results) {
    switch (profile.status) {
      case 'success':
        totals.clean += 1;
        break;
      case 'vac_banned':
        totals.vacBanned += 1;
        break;
      case 'steam_error':
        totals.steamErrors += 1;
        break;
      case 'montuga_error':
        totals.montugaErrors += 1;
        break;
      default:
        break;
    }
  }

  totals.pending = Math.max(totals.requested - totals.processed, 0);
  return totals;
}

function formatStatusLabel(profile) {
  switch (profile.status) {
    case 'success':
      return 'Inventário avaliado';
    case 'vac_banned':
      return 'VAC ban bloqueado';
    case 'montuga_error':
      return 'Falha Montuga';
    case 'steam_error':
      return 'Falha Steam';
    default:
      return 'Processado';
  }
}

function generateReportHtml({ job, results, totals, partial, generatedAt }) {
  const rows = results.map((profile, index) => {
    const amount = typeof profile.totalValueBRL === 'number'
      ? `R$ ${profile.totalValueBRL.toFixed(2)}`
      : '—';

    return `
      <tr>
        <td>${index + 1}</td>
        <td><a href="${steamProfileUrl(profile.id)}" target="_blank" rel="noopener noreferrer">${escapeHtml(profile.id)}</a></td>
        <td><a href="${steamProfileUrl(profile.id)}" target="_blank" rel="noopener noreferrer">${escapeHtml(profile.name ?? 'N/A')}</a></td>
        <td>${formatStatusLabel(profile)}</td>
        <td>${profile.vacBanned ? 'Sim' : 'Não'}</td>
        <td>${profile.gameBans ?? 0}</td>
        <td>${amount}</td>
      </tr>
    `;
  }).join('');

  const generatedLabel = currentDateTimeLabel(generatedAt);
  const title = partial ? 'Prévia parcial de inventário' : 'Relatório completo de inventário';

  return `<!DOCTYPE html>
  <html lang="pt-BR">
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(title)}</title>
      <style>
        :root {
          color-scheme: dark light;
          font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        }
        body {
          margin: 0;
          padding: 24px;
          background: #0f172a;
          color: #e2e8f0;
        }
        h1 {
          margin-bottom: 4px;
          font-size: 24px;
        }
        .meta {
          margin-bottom: 24px;
          color: #94a3b8;
        }
        .summary-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 12px;
          margin-bottom: 24px;
        }
        .summary-tile {
          background: rgba(148, 163, 184, 0.12);
          border: 1px solid rgba(148, 163, 184, 0.2);
          border-radius: 12px;
          padding: 16px;
        }
        .summary-label {
          display: block;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #cbd5f5;
        }
        .summary-value {
          font-size: 24px;
          font-weight: 700;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          background: rgba(15, 23, 42, 0.8);
          border-radius: 12px;
          overflow: hidden;
        }
        thead {
          background: rgba(51, 65, 85, 0.6);
        }
        th, td {
          padding: 12px 16px;
          text-align: left;
          border-bottom: 1px solid rgba(148, 163, 184, 0.2);
        }
        tbody tr:nth-child(odd) {
          background: rgba(15, 23, 42, 0.6);
        }
        tbody tr:last-child td {
          border-bottom: none;
        }
        footer {
          margin-top: 32px;
          font-size: 12px;
          color: #64748b;
        }
      </style>
    </head>
    <body>
      <h1>${escapeHtml(title)}</h1>
      <p class="meta">Gerado em ${escapeHtml(generatedLabel)} • Job ${escapeHtml(job.id)}</p>
      <div class="summary-grid">
        <div class="summary-tile">
          <span class="summary-label">IDs solicitadas</span>
          <span class="summary-value">${totals.requested}</span>
        </div>
        <div class="summary-tile">
          <span class="summary-label">Processadas</span>
          <span class="summary-value">${totals.processed}</span>
        </div>
        <div class="summary-tile">
          <span class="summary-label">Inventários avaliados</span>
          <span class="summary-value">${totals.clean}</span>
        </div>
        <div class="summary-tile">
          <span class="summary-label">VAC ban bloqueados</span>
          <span class="summary-value">${totals.vacBanned}</span>
        </div>
        <div class="summary-tile">
          <span class="summary-label">Falhas Steam</span>
          <span class="summary-value">${totals.steamErrors}</span>
        </div>
        <div class="summary-tile">
          <span class="summary-label">Falhas Montuga</span>
          <span class="summary-value">${totals.montugaErrors}</span>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Steam ID</th>
            <th>Apelido</th>
            <th>Status</th>
            <th>VAC ban</th>
            <th>Game bans</th>
            <th>Inventário (BRL)</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="7">Nenhum perfil processado ainda.</td></tr>'}
        </tbody>
      </table>
      <footer>Relatório gerado automaticamente por Art Cases Inspector.</footer>
    </body>
  </html>`;
}

async function buildReport(job, { partial = false } = {}) {
  const totals = buildTotals(job.results, job.totalUnique);
  const generatedAt = new Date().toISOString();
  const getSortableValue = (profile) => {
    const raw = Number(profile?.totalValueBRL);
    return Number.isFinite(raw) ? raw : -Infinity;
  };
  const sortedResults = [...job.results].sort((a, b) => {
    const valueA = getSortableValue(a);
    const valueB = getSortableValue(b);
    if (valueA === valueB) {
      return 0;
    }
    if (valueA === -Infinity) {
      return 1;
    }
    if (valueB === -Infinity) {
      return -1;
    }
    return valueB - valueA;
  });
  const reportHtml = generateReportHtml({ job, results: sortedResults, totals, partial, generatedAt });

  return {
    jobId: job.id,
    successCount: totals.clean,
    totals,
    reportHtml,
    generatedAt,
    partial,
    shareLink: buildJobShareLink(job),
  };
}

// ----------------- Controle de Jobs -----------------
function resolveRequestBaseUrl(req) {
  if (!req) {
    return '';
  }

  const forwardedHost = req.get?.('x-forwarded-host');
  const rawHost = forwardedHost || req.get?.('host');
  if (!rawHost) {
    return '';
  }

  const forwardedProto = req.get?.('x-forwarded-proto');
  const protocolCandidate = forwardedProto ? forwardedProto.split(',')[0].trim() : '';
  const protocol = protocolCandidate || req.protocol || 'http';

  return `${protocol}://${rawHost}`.replace(/\/$/, '');
}

function normalizeBaseUrl(candidate) {
  return (candidate || '').trim().replace(/\/$/, '');
}

function buildJobShareLink(job, fallbackBase = '') {
  if (!job) {
    return null;
  }
  const normalized = normalizeBaseUrl(job.baseUrl || APP_BASE_URL || fallbackBase);
  if (!normalized) {
    return null;
  }
  return `${normalized}?job=${job.id}`;
}

function findLatestActiveJob() {
  let selected = null;
  for (const job of jobs.values()) {
    if (job.status === 'processing' || job.status === 'paused') {
      if (!selected || (job.updatedAt ?? 0) > (selected.updatedAt ?? 0)) {
        selected = job;
      }
    }
  }
  return selected;
}

function createJob() {
  const id = randomUUID();
  const now = Date.now();
  const job = {
    id,
    status: 'pending',
    logs: [],
    result: null,
    clients: new Set(),
    queue: [],
    currentIndex: 0,
    results: [],
    totalUnique: 0,
    paused: false,
    webhookUrl: process.env.NOTIFY_WEBHOOK_URL || null,
    timer: null,
    startedAt: null,
    updatedAt: now,
    requestedIds: [],
    baseUrl: normalizeBaseUrl(APP_BASE_URL),
    stopRequested: false,
    manualStopReason: null,
  };
  jobs.set(id, job);
  return job;
}

function broadcast(job, event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of job.clients) {
    client.write(data);
  }
}

function appendLog(jobId, msg, type = 'info', steamId = null) {
  const job = jobs.get(jobId);
  if (!job) return;
  const prefix = steamId ? `[ID ${steamId}]` : '[GERAL]';
  const log = { message: `${prefix} ${msg}`, type, timestamp: Date.now() };
  job.logs.push(log);
  if (job.logs.length > 1000) {
    job.logs.shift();
  }
  job.updatedAt = Date.now();
  broadcast(job, 'log', log);
  console.log(`[JOB ${jobId}] ${log.message}`);
}

function scheduleCleanup(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  setTimeout(() => {
    const activeJob = jobs.get(jobId);
    if (activeJob && activeJob.clients.size === 0) {
      jobs.delete(jobId);
    }
  }, JOB_RETENTION_MS);
}

// ----------------- Funções principais -----------------
const STAGE_LABELS = {
  started: 'iniciado',
  paused: 'pausado',
  resumed: 'retomado',
  partial: 'prévia disponível',
  completed: 'concluído',
  failed: 'falhou',
  high_value_profile: 'inventário premium',
  cancelled: 'encerrado manualmente',
};

const STAGE_BUILDERS = {
  started: (job, extra = {}) => ({
    titulo: '🚀 Monitoramento iniciado',
    mensagem: `Analisando ${extra.requested ?? job.totalUnique} perfis Steam.`,
    detalhes: {
      perfisSolicitados: extra.requested ?? job.totalUnique,
    },
  }),
  paused: () => ({
    titulo: '⏸️ Processamento pausado',
    mensagem: 'A execução foi pausada manualmente e aguarda novas instruções.',
  }),
  resumed: () => ({
    titulo: '▶️ Processamento retomado',
    mensagem: 'Continuamos a avaliação do inventário exatamente de onde parou.',
  }),
  partial: (job, extra = {}) => ({
    titulo: '📝 Prévia disponível',
    mensagem: 'Uma prévia HTML foi gerada com o status parcial da execução.',
    detalhes: {
      resumo: extra.totals ?? buildTotals(job.results, job.totalUnique),
    },
  }),
  completed: (job, extra = {}) => ({
    titulo: '✅ Relatório concluído',
    mensagem: 'O relatório completo de inventário está pronto para download.',
    detalhes: {
      resumo: extra.totals ?? buildTotals(job.results, job.totalUnique),
      inventariosAvaliados: extra.successCount ?? null,
    },
  }),
  failed: (job, extra = {}) => ({
    titulo: '❌ Falha durante a execução',
    mensagem: extra.error || 'O processamento foi interrompido por um erro inesperado.',
  }),
  high_value_profile: (_job, extra = {}) => {
    const profile = extra.profile || {};
    const nome = profile.name || 'Perfil Steam';
    const valor = typeof profile.totalValueBRL === 'number'
      ? `R$ ${profile.totalValueBRL.toFixed(2).replace('.', ',')}`
      : 'valor não informado';
    return {
      titulo: '💎 Inventário premium encontrado',
      mensagem: `${nome} possui inventário avaliado em ${valor}.`,
      detalhes: {
        perfilId: profile.id,
        nome,
        valorBRL: profile.totalValueBRL ?? null,
        vacBanned: profile.vacBanned ?? false,
      },
    };
  },
  cancelled: (job, extra = {}) => ({
    titulo: '⏹️ Processamento encerrado',
    mensagem: extra.reason || 'O processamento foi finalizado manualmente pelo usuário.',
    detalhes: {
      resumo: extra.totals ?? buildTotals(job.results, job.totalUnique),
      inventariosAvaliados: extra.successCount ?? null,
    },
  }),
};

function buildWebhookPayload(job, stage, extra = {}) {
  const builder = STAGE_BUILDERS[stage];
  const basePayload = builder
    ? builder(job, extra)
    : {
        titulo: 'Atualização do processamento',
        mensagem: `Uma nova etapa foi registrada para o job ${job.id}.`,
        detalhes: extra,
      };

  const payload = {
    jobId: job.id,
    etapaCodigo: stage,
    etapa: STAGE_LABELS[stage] || stage,
    horario: new Date().toISOString(),
    ...basePayload,
  };

  const shareLink = buildJobShareLink(job);
  if (shareLink) {
    payload.linkAcompanhamento = shareLink;
  }

  return payload;
}

async function notifyWebhook(job, stage, payload = {}) {
  const url = job.webhookUrl || process.env.NOTIFY_WEBHOOK_URL;
  if (!url) return;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildWebhookPayload(job, stage, payload)),
    });
    if (!r.ok) {
      throw new Error(`Webhook retornou ${r.status}`);
    }
  } catch (err) {
    appendLog(job.id, `Falha webhook: ${err.message}`, 'warn');
  }
}

async function finalizeJob(jobId, options = {}) {
  const job = jobs.get(jobId);
  if (!job || job.status === 'complete' || job.status === 'error') {
    if (job) {
      job.stopRequested = false;
      job.manualStopReason = null;
    }
    return;
  }

  const manualStop = Boolean(options.manualStop);
  const manualReason = options.reason || null;

  if (job.timer) {
    clearTimeout(job.timer);
    job.timer = null;
  }

  const payload = await buildReport(job, { partial: false });
  const reportPath = await persistReportHtml(payload);
  if (reportPath) {
    payload.reportPath = reportPath;
    appendLog(jobId, `Relatório HTML salvo em ${reportPath}.`);
  } else {
    appendLog(jobId, 'Não foi possível salvar o relatório HTML no disco.', 'warn');
  }

  const enrichedPayload = { ...payload, manualStop, manualStopReason: manualReason };

  if (manualStop) {
    appendLog(jobId, 'Processamento encerrado manualmente. Relatório consolidado com os dados disponíveis.', 'warn');
  }

  job.status = 'complete';
  job.stopRequested = false;
  job.manualStopReason = null;
  job.result = { ...enrichedPayload, logs: job.logs, shareLink: buildJobShareLink(job) };
  job.timer = null;
  job.updatedAt = Date.now();
  job.finishedAt = job.updatedAt;

  broadcast(job, 'complete', job.result);
  broadcast(job, 'end', { ok: true, manualStop });

  await appendHistoryEntry(enrichedPayload);

  const webhookStage = manualStop ? 'cancelled' : 'completed';
  notifyWebhook(job, webhookStage, {
    totals: payload.totals,
    successCount: payload.successCount,
    reason: manualReason,
  });

  scheduleCleanup(jobId);
}

function failJob(jobId, msg) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'error';
  job.result = { error: msg, logs: job.logs, shareLink: buildJobShareLink(job) };
  job.timer = null;
  job.updatedAt = Date.now();
  job.stopRequested = false;
  job.manualStopReason = null;
  broadcast(job, 'job-error', { error: msg, shareLink: buildJobShareLink(job) });
  broadcast(job, 'end', { ok: false });
  notifyWebhook(job, 'failed', { error: msg });
  scheduleCleanup(jobId);
}

// ----------------- API Steam / Montuga -----------------
async function fetchSteamProfile(jobId, steamId) {
  const info = { id: steamId, name: 'N/A', vacBanned: false, gameBans: 0, status: 'ready' };
  try {
    const summaryResponse = await fetch(`${STEAM_API_BASE_URL}ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${steamId}`);
    if (!summaryResponse.ok) {
      throw new Error(`Steam retornou ${summaryResponse.status}`);
    }
    const summaryData = await summaryResponse.json();
    const profile = summaryData?.response?.players?.[0];
    const realName = typeof profile?.realname === 'string' ? profile.realname.trim() : '';
    if (realName) {
      info.name = realName;
    } else if (profile?.personaname) {
      info.name = profile.personaname;
    }
  } catch (error) {
    info.status = 'steam_error';
    appendLog(jobId, `Erro perfil: ${error.message}`, 'error', steamId);
    return info;
  }

  try {
    const bansResponse = await fetch(`${STEAM_API_BASE_URL}ISteamUser/GetPlayerBans/v1/?key=${STEAM_API_KEY}&steamids=${steamId}`);
    if (bansResponse.ok) {
      const bansData = await bansResponse.json();
      const banInfo = bansData?.players?.[0];
      if (banInfo) {
        info.vacBanned = Boolean(banInfo.VACBanned);
        info.gameBans = Number(banInfo.NumberOfGameBans || 0);
      }
    }
  } catch (error) {
    appendLog(jobId, `Não foi possível obter status VAC: ${error.message}`, 'warn', steamId);
  }

  if (info.vacBanned || (info.gameBans ?? 0) > 0) {
    info.status = 'vac_banned';
    appendLog(jobId, `Perfil bloqueado por VAC/GameBan (${info.gameBans} banimentos).`, 'warn', steamId);
  } else {
    appendLog(jobId, `Perfil localizado: ${info.name}`, 'info', steamId);
  }

  return info;
}

async function fetchMontugaInventory(jobId, steamInfo) {
  const url = `${MONTUGA_BASE_URL}/${steamInfo.id}/${APP_ID}/total-value`;
  try {
    const response = await fetch(url, { headers: { 'api-key': MONTUGA_API_KEY } });
    if (!response.ok) {
      throw new Error(`Montuga retornou ${response.status}`);
    }
    const data = await response.json();
    const totalUSD = Number(data?.total_value || 0);
    const totalBRL = totalUSD * USD_TO_BRL_RATE;
    steamInfo.totalValueBRL = totalBRL;
    steamInfo.status = 'success';
    appendLog(jobId, `Inventário avaliado: R$ ${totalBRL.toFixed(2)}`, 'success', steamInfo.id);
    if (totalBRL >= HIGH_VALUE_THRESHOLD_BRL) {
      appendLog(
        jobId,
        `Inventário premium identificado (≥ R$ ${HIGH_VALUE_THRESHOLD_BRL.toFixed(2)}).`,
        'success',
        steamInfo.id,
      );
      const job = jobs.get(jobId);
      if (job) {
        notifyWebhook(job, 'high_value_profile', { profile: { ...steamInfo } });
      }
    }
  } catch (error) {
    steamInfo.status = 'montuga_error';
    appendLog(jobId, `Erro Montuga: ${error.message}`, 'error', steamInfo.id);
  }
}

// ----------------- Execução sequencial -----------------
async function processNext(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.paused || job.status !== 'processing') {
    return;
  }

  if (job.stopRequested) {
    await finalizeJob(jobId, { manualStop: true, reason: job.manualStopReason });
    return;
  }

  if (job.currentIndex >= job.queue.length) {
    await finalizeJob(jobId);
    return;
  }

  const steamId = job.queue[job.currentIndex++];
  const profile = await fetchSteamProfile(jobId, steamId);
  if (profile.status === 'ready') {
    await fetchMontugaInventory(jobId, profile);
  }
  job.results.push(profile);
  job.updatedAt = Date.now();

  if (job.stopRequested) {
    await finalizeJob(jobId, { manualStop: true, reason: job.manualStopReason });
    return;
  }

  try {
    await appendProcessedSteamIds([steamId]);
  } catch (error) {
    console.error('Falha ao registrar SteamID processada:', error);
  }

  broadcast(job, 'profile-processed', profile);

  if (!job.paused && job.status === 'processing') {
    job.timer = setTimeout(() => {
      job.timer = null;
      processNext(jobId).catch((error) => {
        console.error('Falha ao processar próxima ID:', error);
        failJob(jobId, 'Erro inesperado durante o processamento.');
      });
    }, PROCESS_DELAY_MS);
  }
}

async function startJob(jobId, ids, webhookUrl, options = {}) {
  const job = jobs.get(jobId);
  if (!job) return;

  job.queue = [...new Set(ids.map((value) => value.trim()).filter(Boolean))];
  job.requestedIds = [...job.queue];
  job.totalUnique = job.queue.length;
  job.currentIndex = 0;
  job.results = [];
  job.logs = [];
  job.paused = false;
  job.status = 'processing';
  job.startedAt = Date.now();
  job.updatedAt = job.startedAt;
  job.webhookUrl = webhookUrl || job.webhookUrl;
  job.skippedSteamIds = Array.isArray(options.skippedSteamIds)
    ? options.skippedSteamIds
    : [];
  job.stopRequested = false;
  job.manualStopReason = null;

  appendLog(jobId, `Processando ${job.totalUnique} SteamIDs...`);
  if (job.skippedSteamIds.length) {
    const preview = job.skippedSteamIds.slice(0, 5).join(', ');
    appendLog(
      jobId,
      `${job.skippedSteamIds.length} SteamIDs já processadas foram ignoradas automaticamente.` +
        (job.skippedSteamIds.length > 5 ? ` Exemplos: ${preview}...` : ` (${preview})`),
      'warn',
    );
  }
  notifyWebhook(job, 'started', { requested: job.totalUnique });

  processNext(jobId).catch((error) => {
    console.error('Falha ao iniciar processamento:', error);
    failJob(jobId, 'Erro inesperado durante o processamento.');
  });
}

// ----------------- Rotas -----------------
app.post('/friends/list', async (req, res) => {
  const input = Array.isArray(req.body?.steamIds) ? req.body.steamIds : [];
  const entries = input
    .map((value) => {
      const raw = String(value ?? '').trim();
      return {
        raw,
        sanitized: sanitizeSteamId(raw),
      };
    })
    .filter(({ raw }) => raw.length > 0);

  if (entries.length === 0) {
    res.status(400).json({ error: 'Informe pelo menos uma SteamID64.' });
    return;
  }

  try {
    const results = await Promise.all(entries.map(async ({ raw, sanitized }) => {
      if (!sanitized) {
        return {
          steamId: raw,
          error: 'SteamID64 inválido. Utilize 17 dígitos numéricos.',
        };
      }

      try {
        return await fetchFriendsForSteamId(sanitized);
      } catch (error) {
        return {
          steamId: raw || sanitized,
          error: error.message || 'Não foi possível carregar a lista de amigos.',
        };
      }
    }));

    res.json({ results });
  } catch (error) {
    console.error('Falha ao consultar listas de amigos da Steam.', error);
    res.status(500).json({ error: 'Não foi possível consultar as listas de amigos no momento.' });
  }
});

app.post('/process', async (req, res) => {
  try {
    const ids = (req.body.steam_ids || '')
      .split(/\s+/)
      .map((value) => sanitizeSteamId(value))
      .filter(Boolean);

    if (!ids.length) {
      return res.status(400).json({ error: 'Informe pelo menos um SteamID.' });
    }

    const uniqueIds = [...new Set(ids)];

    if (uniqueIds.length > MAX_STEAM_IDS_PER_JOB) {
      return res.status(400).json({ error: `Limite máximo de ${MAX_STEAM_IDS_LABEL} Steam IDs por requisição.` });
    }

    const processedSet = await loadProcessedSteamIdSet();
    const filteredIds = uniqueIds.filter((id) => !processedSet.has(id));
    const skippedSteamIds = uniqueIds.filter((id) => processedSet.has(id));

    if (!filteredIds.length) {
      return res.status(400).json({
        error: 'Todos os Steam IDs informados já foram processados anteriormente.',
        ignoredSteamIds: skippedSteamIds,
      });
    }

    const webhookCandidate = (req.body.webhook_url || '').trim();
    if (webhookCandidate && !isValidWebhookUrl(webhookCandidate)) {
      return res.status(400).json({ error: 'Informe uma URL de webhook válida ou deixe o campo em branco.' });
    }

    const job = createJob();
    const requestBase = normalizeBaseUrl(resolveRequestBaseUrl(req));
    if (requestBase) {
      job.baseUrl = requestBase;
    }
    const shareLink = buildJobShareLink(job, requestBase);

    res.json({ jobId: job.id, shareLink, ignoredSteamIds: skippedSteamIds });

    startJob(job.id, filteredIds, webhookCandidate, { skippedSteamIds });
  } catch (error) {
    console.error('Falha ao iniciar processamento de SteamIDs:', error);
    res.status(500).json({ error: 'Não foi possível iniciar o processamento.' });
  }
});

app.post('/process/:jobId/pause', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job não encontrado.' });
  }
  if (job.status !== 'processing' || job.paused) {
    return res.status(400).json({ error: 'Nenhum processamento ativo para pausar.' });
  }
  job.paused = true;
  job.status = 'paused';
  if (job.timer) {
    clearTimeout(job.timer);
    job.timer = null;
  }
  appendLog(job.id, 'Processamento pausado pelo usuário.');
  broadcast(job, 'job-paused', { ok: true });
  notifyWebhook(job, 'paused');
  res.json({ ok: true });
});

app.post('/process/:jobId/resume', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job não encontrado.' });
  }
  if (!job.paused) {
    return res.status(400).json({ error: 'Nenhum processamento pausado para retomar.' });
  }
  job.paused = false;
  job.status = 'processing';
  appendLog(job.id, 'Processamento retomado.');
  broadcast(job, 'job-resumed', { ok: true });
  notifyWebhook(job, 'resumed');

  processNext(job.id).catch((error) => {
    console.error('Falha ao retomar processamento:', error);
    failJob(job.id, 'Erro inesperado durante o processamento.');
  });

  res.json({ ok: true });
});

app.post('/process/:jobId/stop', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job não encontrado.' });
  }

  if (job.status === 'complete' || job.status === 'error') {
    return res.status(400).json({ error: 'Nenhum processamento ativo para finalizar.' });
  }

  if (job.timer) {
    clearTimeout(job.timer);
    job.timer = null;
  }

  const completionReason = 'Processamento finalizado manualmente pelo usuário.';
  const requestReason = 'Finalização manual solicitada pelo usuário.';

  if (job.status === 'paused') {
    try {
      job.paused = false;
      job.stopRequested = false;
      job.manualStopReason = completionReason;
      appendLog(job.id, completionReason, 'warn');
      await finalizeJob(job.id, { manualStop: true, reason: completionReason });
      return res.json({ ok: true, finalized: true, reason: completionReason });
    } catch (error) {
      console.error('Falha ao finalizar job manualmente:', error);
      failJob(job.id, 'Não foi possível finalizar o processamento manualmente.');
      return res.status(500).json({ error: 'Não foi possível finalizar o processamento manualmente.' });
    }
  }

  if (job.status !== 'processing') {
    return res.status(400).json({ error: 'Nenhum processamento ativo para finalizar.' });
  }

  if (job.stopRequested) {
    return res.json({ ok: true, finalized: false, reason: requestReason });
  }

  job.stopRequested = true;
  job.manualStopReason = completionReason;
  appendLog(job.id, 'Finalização manual solicitada. Encerrando após o perfil atual.', 'warn');
  broadcast(job, 'job-stopping', { manual: true, reason: requestReason });

  return res.json({ ok: true, finalized: false, reason: requestReason });
});

app.get('/process/:jobId/partial-report', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job não encontrado.' });
  }
  if (!job.results.length) {
    return res.status(400).json({ error: 'Ainda não há dados suficientes para gerar um relatório parcial.' });
  }

  try {
    const payload = await buildReport(job, { partial: true });
    const reportPath = await persistReportHtml(payload);
    if (reportPath) {
      payload.reportPath = reportPath;
      appendLog(job.id, `Prévia HTML salva em ${reportPath}.`);
    } else {
      appendLog(job.id, 'Não foi possível salvar a prévia HTML no disco.', 'warn');
    }
    await appendHistoryEntry(payload);
    notifyWebhook(job, 'partial', { totals: payload.totals });
    res.json(payload);
  } catch (error) {
    console.error('Falha ao gerar relatório parcial:', error);
    res.status(500).json({ error: 'Não foi possível gerar o relatório parcial.' });
  }
});

app.get('/process/:jobId/stream', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).end();
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders?.();
  job.clients.add(res);
  req.on('close', () => {
    job.clients.delete(res);
  });
});

app.get('/process/:jobId/result', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job não encontrado.' });
  }
  if (!job.result) {
    return res.status(202).json({ status: job.status });
  }
  res.json(job.result);
});

app.get('/process/:jobId/inspect', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job não encontrado.' });
  }

  const totals = buildTotals(job.results, job.totalUnique);
  const requestBase = normalizeBaseUrl(resolveRequestBaseUrl(req));
  if (requestBase && !job.baseUrl) {
    job.baseUrl = requestBase;
  }
  const shareLink = buildJobShareLink(job, requestBase);

  res.json({
    jobId: job.id,
    status: job.status,
    paused: job.paused,
    totals,
    successCount: totals.clean,
    requestedIds: job.requestedIds,
    pendingIds: getPendingIds(job),
    skippedSteamIds: job.skippedSteamIds ?? [],
    results: job.results,
    logs: job.logs,
    reportHtml: job.result?.reportHtml ?? null,
    reportPath: job.result?.reportPath ?? null,
    partial: job.result?.partial ?? false,
    generatedAt: job.result?.generatedAt ?? null,
    error: job.result?.error ?? null,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    shareLink,
    manualStop: Boolean(job.result?.manualStop),
    stopRequested: Boolean(job.stopRequested),
    manualStopReason: job.result?.manualStopReason || job.manualStopReason || null,
  });
});

app.get('/process/active', (req, res) => {
  const job = findLatestActiveJob();
  if (!job) {
    return res.json({ jobId: null });
  }

  const totals = buildTotals(job.results, job.totalUnique);
  const requestBase = normalizeBaseUrl(resolveRequestBaseUrl(req));
  if (requestBase && !job.baseUrl) {
    job.baseUrl = requestBase;
  }
  const shareLink = buildJobShareLink(job, requestBase);

  res.json({
    jobId: job.id,
    status: job.status,
    paused: job.paused,
    totals,
    pendingCount: getPendingIds(job).length,
    updatedAt: job.updatedAt,
    shareLink,
  });
});

function buildHistoryHtml(entries) {
  const rows = entries.map((entry, index) => {
    const hasHtml = typeof entry.reportHtml === 'string' && entry.reportHtml.length > 0;
    const encodedHtml = hasHtml ? Buffer.from(entry.reportHtml, 'utf-8').toString('base64') : '';
    const isoTimestamp = new Date(entry.generatedAt || Date.now()).toISOString();
    const sanitizedTimestamp = isoTimestamp.replace(/[:.]/g, '-');
    const baseFileName = `${entry.partial ? 'previa' : 'relatorio'}_${sanitizeReportSegment(entry.jobId, 'job')}_${sanitizedTimestamp}.html`;
    const downloadHref = entry.reportPath
      ? `/${entry.reportPath.replace(/^\/+/, '')}`
      : hasHtml
        ? `data:text/html;base64,${encodedHtml}`
        : null;
    const escapedHref = downloadHref ? escapeHtml(downloadHref) : null;
    const iframeMarkup = hasHtml
      ? `<iframe src="data:text/html;base64,${encodedHtml}" sandbox="allow-same-origin"></iframe>`
      : '<p class="history-empty">Este registro não possui HTML disponível para visualização.</p>';
    const downloadMarkup = escapedHref
      ? `<a class="download-btn" href="${escapedHref}" download="${escapeHtml(baseFileName)}">Baixar HTML</a>`
      : '';

    return `
    <section class="history-entry">
      <header>
        <h2>Registro ${index + 1} • ${escapeHtml(currentDateTimeLabel(entry.generatedAt))}</h2>
        <span class="badge ${entry.partial ? 'badge-partial' : 'badge-final'}">${entry.partial ? 'Prévia' : 'Final'}</span>
        <span class="job-id">Job ${escapeHtml(entry.jobId || 'desconhecido')}</span>
      </header>
      ${downloadMarkup}
      <div class="history-metrics">
        <div><strong>${entry.totals?.requested ?? 0}</strong><span>IDs solicitadas</span></div>
        <div><strong>${entry.totals?.processed ?? 0}</strong><span>Processadas</span></div>
        <div><strong>${entry.totals?.clean ?? 0}</strong><span>Inventários avaliados</span></div>
        <div><strong>${entry.totals?.vacBanned ?? 0}</strong><span>VAC ban</span></div>
        <div><strong>${entry.totals?.steamErrors ?? 0}</strong><span>Falhas Steam</span></div>
        <div><strong>${entry.totals?.montugaErrors ?? 0}</strong><span>Falhas Montuga</span></div>
      </div>
      <details open>
        <summary>Visualizar HTML gerado</summary>
        ${iframeMarkup}
      </details>
    </section>
  `;
  }).join('');

  return `<!DOCTYPE html>
  <html lang="pt-BR">
    <head>
      <meta charset="utf-8" />
      <title>Histórico de relatórios (24h)</title>
      <style>
        body {
          font-family: 'Segoe UI', Roboto, sans-serif;
          background: #0f172a;
          color: #e2e8f0;
          margin: 0;
          padding: 24px;
        }
        h1 {
          margin-bottom: 24px;
        }
        .history-entry {
          background: rgba(15, 23, 42, 0.8);
          border: 1px solid rgba(148, 163, 184, 0.25);
          border-radius: 16px;
          padding: 20px;
          margin-bottom: 24px;
        }
        .download-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          background: rgba(34, 197, 94, 0.18);
          color: #4ade80;
          padding: 8px 16px;
          border-radius: 999px;
          text-decoration: none;
          font-weight: 600;
          font-size: 14px;
          margin-bottom: 16px;
        }
        .download-btn:hover {
          background: rgba(34, 197, 94, 0.28);
        }
        header {
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
          align-items: center;
          margin-bottom: 16px;
        }
        .badge {
          padding: 4px 12px;
          border-radius: 999px;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }
        .badge-partial {
          background: rgba(250, 204, 21, 0.25);
          color: #facc15;
        }
        .badge-final {
          background: rgba(34, 197, 94, 0.2);
          color: #4ade80;
        }
        .job-id {
          font-size: 13px;
          color: #94a3b8;
        }
        .history-metrics {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
          gap: 12px;
          margin-bottom: 16px;
        }
        .history-metrics div {
          background: rgba(148, 163, 184, 0.12);
          border-radius: 12px;
          padding: 12px;
          text-align: center;
        }
        details {
          background: rgba(15, 23, 42, 0.6);
          border-radius: 12px;
          padding: 12px;
        }
        summary {
          cursor: pointer;
          font-weight: 600;
          margin-bottom: 8px;
        }
        iframe {
          width: 100%;
          min-height: 360px;
          border: none;
          border-radius: 12px;
          background: white;
        }
        .history-empty {
          padding: 16px;
          border-radius: 12px;
          background: rgba(148, 163, 184, 0.12);
          color: #cbd5f5;
        }
      </style>
    </head>
    <body>
      <h1>Relatórios gerados nas últimas 24 horas</h1>
      ${rows || '<p>Nenhum relatório disponível no período informado.</p>'}
    </body>
  </html>`;
}

app.get('/download-history', async (req, res) => {
  try {
    const history = await loadHistory();
    const entries = prepareHistoryEntries(history.entries);

    if (!entries.length) {
      return res.status(404).json({ error: 'Nenhum relatório disponível nas últimas 24 horas.' });
    }

    const html = buildHistoryHtml(entries);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="relatorios_24h.html"');
    res.send(html);
  } catch (error) {
    console.error('Falha ao gerar histórico consolidado:', error);
    res.status(500).json({ error: 'Não foi possível gerar o histórico das últimas 24 horas.' });
  }
});

app.get('/history/processed', async (req, res) => {
  try {
    const limitParam = Number.parseInt(req.query.limit, 10);
    let limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_PROCESSED_HISTORY_LIMIT;
    limit = Math.min(Math.max(limit, 1), MAX_PROCESSED_HISTORY_LIMIT);

    const history = await loadHistory();
    const sanitized = Array.isArray(history.processedSteamIds)
      ? history.processedSteamIds.map((value) => sanitizeSteamId(value)).filter(Boolean)
      : [];
    const unique = Array.from(new Set(sanitized));
    const total = unique.length;
    const steamIds = unique.slice(Math.max(total - limit, 0)).reverse();

    res.json({ total, steamIds });
  } catch (error) {
    console.error('Não foi possível carregar o histórico de SteamIDs processadas:', error);
    res.status(500).json({ error: 'Falha ao carregar o histórico de IDs processadas.' });
  }
});

app.get('/history/entries', async (req, res) => {
  try {
    const history = await loadHistory();
    const entries = prepareHistoryEntries(history.entries);
    res.json({ entries });
  } catch (error) {
    console.error('Não foi possível carregar o histórico de relatórios:', error);
    res.status(500).json({ error: 'Falha ao carregar o histórico de relatórios.' });
  }
});

app.get('/process/:jobId/state', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job não encontrado.' });
  }
  res.json({
    status: job.status,
    paused: job.paused,
    processed: job.results.length,
    requested: job.totalUnique,
    stopRequested: Boolean(job.stopRequested),
    manualStop: Boolean(job.result?.manualStop),
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    distReady: existsSync(DIST_DIR),
  });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/process') || req.path.startsWith('/download-history')) {
    return next();
  }
  const indexFile = path.join(DIST_DIR, 'index.html');
  if (!existsSync(indexFile)) {
    return res.status(404).send('Aplicação front-end não está construída. Execute npm run build.');
  }
  res.sendFile(indexFile);
});

app.listen(PORT, () => console.log(`✅ Servidor iniciado em http://localhost:${PORT}`));

