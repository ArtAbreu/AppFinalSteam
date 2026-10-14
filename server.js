import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { createRateLimiter } from './rate-limiter.js';

const STEAMWEBAPI_BASE_URL = 'https://www.steamwebapi.com/steam/api';
const STEAM_API_BASE_URL = 'https://api.steampowered.com/';
const MONTUGA_BASE_URL = 'https://montuga.com/api/IPricing/inventory';
const APP_ID = 730;
const USD_TO_BRL_RATE = 5.25;
const HIGH_VALUE_THRESHOLD_BRL = 3000;
const CASE_PERCENTAGE_THRESHOLD_DEFAULT = 60;
const JOB_RETENTION_MS = 5 * 60 * 1000;

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// Faixa de valor aceita no relatório (BRL). Contas fora dela são excluídas.
const MIN_INVENTORY_BRL_DEFAULT = envNumber('MIN_INVENTORY_BRL', 1000);
const MAX_INVENTORY_BRL_DEFAULT = envNumber('MAX_INVENTORY_BRL', 10000);

// Ritmo das APIs. Todos ajustáveis por variável de ambiente no Render, sem mexer no código.
// Se uma API responder 429, o limitador desacelera sozinho e tenta de novo.
const steamApiLimiter = createRateLimiter({
  name: 'Steam',
  concurrency: envNumber('STEAM_API_CONCURRENCY', 4),
  minIntervalMs: envNumber('STEAM_API_MIN_INTERVAL_MS', 150),
});
const steamWebApiLimiter = createRateLimiter({
  name: 'SteamWebAPI',
  concurrency: envNumber('STEAMWEBAPI_CONCURRENCY', 4),
  minIntervalMs: envNumber('STEAMWEBAPI_MIN_INTERVAL_MS', 100),
});
const montugaLimiter = createRateLimiter({
  name: 'Montuga',
  concurrency: envNumber('MONTUGA_CONCURRENCY', 4),
  minIntervalMs: envNumber('MONTUGA_MIN_INTERVAL_MS', 100),
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = __dirname;
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const HISTORY_FILE = path.join(ROOT_DIR, 'history.json');
const REPORTS_DIR = path.join(ROOT_DIR, 'reports');

const STEAMWEBAPI_KEY = process.env.STEAMWEBAPI_KEY;
const MONTUGA_API_KEY = process.env.MONTUGA_API_KEY;
const STEAM_API_KEY = process.env.STEAM_API_KEY;
const PANEL_PASSWORD = (process.env.PANEL_PASSWORD || '').trim();

if (!STEAM_API_KEY) {
  console.error('\n❌ Falha na inicialização: defina a variável STEAM_API_KEY.');
  process.exit(1);
}
if (!STEAMWEBAPI_KEY) {
  console.warn('\n⚠️  STEAMWEBAPI_KEY não definida. A aba Steam Web API não funcionará.');
}
if (!MONTUGA_API_KEY) {
  console.warn('\n⚠️  MONTUGA_API_KEY não definida. A aba Montuga API não funcionará.');
}

if (!globalThis.fetch) {
  console.error('\n❌ A API Fetch não está disponível. Utilize Node.js 18+.');
  process.exit(1);
}

// ----------------- Configurações em tempo real -----------------
const SETTINGS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'panel_settings.json');
let runtimeSettings = {
  caseThreshold: CASE_PERCENTAGE_THRESHOLD_DEFAULT,
  webhookUrl: '',
  minValueBRL: MIN_INVENTORY_BRL_DEFAULT,
  maxValueBRL: MAX_INVENTORY_BRL_DEFAULT,
};

async function loadPanelSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    runtimeSettings = { ...runtimeSettings, ...parsed };
  } catch {
    // usa defaults
  }
}

async function savePanelSettings() {
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(runtimeSettings, null, 2), 'utf-8');
}

function getCaseThreshold() {
  const v = Number(runtimeSettings.caseThreshold);
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : CASE_PERCENTAGE_THRESHOLD_DEFAULT;
}

function getValueRange() {
  const min = Number(runtimeSettings.minValueBRL);
  const max = Number(runtimeSettings.maxValueBRL);
  return {
    min: Number.isFinite(min) && min >= 0 ? min : MIN_INVENTORY_BRL_DEFAULT,
    max: Number.isFinite(max) && max > 0 ? max : MAX_INVENTORY_BRL_DEFAULT,
  };
}

function formatBRL(value) {
  return `R$ ${Number(value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

loadPanelSettings().catch(console.warn);

// ----------------- Auth -----------------
function authMiddleware(req, res, next) {
  if (!PANEL_PASSWORD) return next();
  const header = req.headers['x-panel-password'] || '';
  if (header !== PANEL_PASSWORD) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }
  next();
}

const APP_BASE_URL = (process.env.APP_BASE_URL || '').trim();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use('/reports', express.static(REPORTS_DIR, { maxAge: '1d' }));
app.use(express.static(DIST_DIR));

const jobs = new Map();

const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_ENTRIES = 50;
const MAX_STEAM_IDS_PER_JOB = 25000;
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

const STEAM_LEVEL_CHUNK_SIZE = 20;
const PLAYER_SUMMARIES_CHUNK_SIZE = 100;
const PERSONA_STATE_LABELS = {
  0: 'Offline',
  1: 'Online',
  2: 'Ocupado',
  3: 'Ausente',
  4: 'Soneca',
  5: 'Procurando troca',
  6: 'Procurando jogar',
};

const steamLevelCache = new Map();

function describePersonaState(summary) {
  if (!summary || typeof summary !== 'object') {
    return { code: null, label: 'Desconhecido', inGame: false, game: null };
  }

  const personaState = Number(summary.personastate);
  const hasPersonaState = Number.isFinite(personaState);
  const inGame = Boolean(summary.gameid || summary.gameextrainfo);
  const game = typeof summary.gameextrainfo === 'string' && summary.gameextrainfo.trim()
    ? summary.gameextrainfo.trim()
    : null;

  if (!hasPersonaState) {
    return { code: null, label: inGame && game ? `Jogando ${game}` : 'Desconhecido', inGame, game };
  }

  if (inGame && game) {
    return { code: personaState, label: `Jogando ${game}`, inGame: true, game };
  }

  const label = PERSONA_STATE_LABELS[personaState] || 'Online';
  return { code: personaState, label, inGame, game };
}

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
      const response = await steamApiLimiter.fetch(`${STEAM_API_BASE_URL}ISteamUser/GetPlayerSummaries/v2/?${params.toString()}`);
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
    const response = await steamApiLimiter.fetch(`${STEAM_API_BASE_URL}IPlayerService/GetSteamLevel/v1/?${params.toString()}`);
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

  const response = await steamApiLimiter.fetch(`${STEAM_API_BASE_URL}ISteamUser/GetFriendList/v1/?${params.toString()}`);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `Resposta inesperada da Steam (HTTP ${response.status})`;
    throw new Error(message);
  }

  const rawFriends = Array.isArray(payload?.friendslist?.friends)
    ? payload.friendslist.friends.map((friend) => String(friend?.steamid || '').trim()).filter(Boolean)
    : [];

  const uniqueFriends = Array.from(new Set(rawFriends.map((value) => sanitizeSteamId(value)).filter(Boolean)));

  return {
    steamId,
    friends: uniqueFriends,
    friendCount: uniqueFriends.length,
    stats: {
      totalFriends: uniqueFriends.length,
      uniqueReturned: uniqueFriends.length,
    },
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

function collectSteamIdCandidates(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (value instanceof Set) {
    return Array.from(value);
  }

  if (typeof value === 'string') {
    return value.split(/[\s,;]+/).filter(Boolean);
  }

  return [];
}

function ensureHistoryShape(data) {
  const fallback = { entries: [], processedSteamIds: [] };

  if (Array.isArray(data)) {
    return { ...fallback, entries: data };
  }

  if (!data || typeof data !== 'object') {
    return { ...fallback };
  }

  const normalized = { ...data };

  if (Array.isArray(data.entries)) {
    normalized.entries = data.entries;
  } else if (Array.isArray(data.history)) {
    normalized.entries = data.history;
  } else if (!Array.isArray(normalized.entries)) {
    normalized.entries = [];
  }

  const processedCandidates = [
    collectSteamIdCandidates(data.processedSteamIds),
    collectSteamIdCandidates(data.processed),
    collectSteamIdCandidates(data.ids),
    collectSteamIdCandidates(data.processedIds),
  ].flat();

  const unique = new Set();
  for (const candidate of processedCandidates) {
    const sanitized = sanitizeSteamId(candidate);
    if (sanitized) {
      unique.add(sanitized);
    }
  }

  let processedSteamIds = Array.from(unique);
  if (processedSteamIds.length > MAX_PROCESSED_STEAM_IDS) {
    processedSteamIds = processedSteamIds.slice(processedSteamIds.length - MAX_PROCESSED_STEAM_IDS);
  }

  normalized.processedSteamIds = processedSteamIds;

  return { ...fallback, ...normalized };
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
  const serialized = JSON.stringify(history, null, 2);

  if (existsSync(HISTORY_FILE)) {
    const backupPath = `${HISTORY_FILE}.bak`;
    try {
      await fs.copyFile(HISTORY_FILE, backupPath);
    } catch (error) {
      console.warn('Não foi possível atualizar o backup do histórico.', error);
    }
  }

  await fs.writeFile(HISTORY_FILE, serialized, 'utf-8');
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
    inventoryErrors: 0,
    lowCaseRatio: 0,
    montugaErrors: 0,
    privateProfiles: 0,
    outOfRange: 0,
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
      case 'inventory_error':
        totals.inventoryErrors += 1;
        break;
      case 'low_case_ratio':
        totals.lowCaseRatio += 1;
        break;
      case 'montuga_error':
        totals.montugaErrors += 1;
        break;
      case 'private_profile':
        totals.privateProfiles += 1;
        break;
      case 'out_of_range':
        totals.outOfRange += 1;
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
    case 'inventory_error':
      return 'Falha Inventário';
    case 'low_case_ratio':
      return `Filtrado (${typeof profile.casePercentage === 'number' ? profile.casePercentage.toFixed(1) : '0.0'}% caixas)`;
    case 'montuga_error':
      return 'Falha Montuga';
    case 'steam_error':
      return 'Falha Steam';
    case 'private_profile':
      return 'Perfil privado';
    case 'out_of_range':
      return 'Fora da faixa de valor';
    default:
      return 'Processado';
  }
}

function statusBadgeClass(status) {
  switch (status) {
    case 'success':
      return 'status-success';
    case 'vac_banned':
      return 'status-danger';
    case 'inventory_error':
    case 'montuga_error':
    case 'steam_error':
      return 'status-warning';
    case 'low_case_ratio':
    case 'private_profile':
    case 'out_of_range':
      return 'status-muted';
    default:
      return 'status-neutral';
  }
}

function generateReportHtml({ job, results, totals, partial, generatedAt }) {
  const isMontuga = job.jobType === 'montuga';
  const range = getValueRange();
  const successResults = results.filter((p) => p.status === 'success');
  const totalInventoryValue = successResults.reduce(
    (sum, p) => sum + (typeof p.totalValueBRL === 'number' ? p.totalValueBRL : 0),
    0,
  );

  const rows = successResults.map((profile, index) => {
    const totalAmount = typeof profile.totalValueBRL === 'number' ? formatBRL(profile.totalValueBRL) : '—';
    const caseAmount = typeof profile.caseValueBRL === 'number' ? formatBRL(profile.caseValueBRL) : '—';
    const casePct = typeof profile.casePercentage === 'number' ? `${profile.casePercentage.toFixed(1)}%` : '—';
    const lastLoginLabel = typeof profile.lastLogoff === 'number'
      ? new Date(profile.lastLogoff * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '—';
    const personaLabel = profile.inGame && profile.currentGame
      ? `Jogando ${profile.currentGame}`
      : profile.personaStateLabel || (profile.inGame ? 'Em jogo' : 'Desconhecido');
    const personaClass = profile.inGame
      ? 'state-in-game'
      : Number(profile.personaState) > 0
        ? 'state-online'
        : 'state-offline';
    const levelLabel = typeof profile.steamLevel === 'number' ? profile.steamLevel : '—';
    const url = steamProfileUrl(profile.id);

    return `
      <tr>
        <td class="cell-index" data-label="#">${index + 1}</td>
        <td class="cell-account" data-label="Conta">
          <a href="${url}" target="_blank" rel="noopener noreferrer" class="name-link">${escapeHtml(profile.name ?? 'N/A')}</a>
          <a href="${url}" target="_blank" rel="noopener noreferrer" class="id-link">${escapeHtml(profile.id)}</a>
        </td>
        <td class="cell-value" data-label="Inventário">${totalAmount}</td>
        ${!isMontuga ? `
          <td class="cell-case" data-label="Caixas"><span>${caseAmount}<span class="cell-sub">${casePct}</span></span></td>
        ` : ''}
        <td data-label="Nível">${levelLabel}</td>
        <td data-label="Estado"><span class="state-pill ${personaClass}">${escapeHtml(personaLabel)}</span></td>
        ${!isMontuga ? `<td class="cell-muted" data-label="Último login">${lastLoginLabel}</td>` : ''}
      </tr>
    `;
  }).join('');

  const generatedLabel = currentDateTimeLabel(generatedAt);
  const title = partial ? 'Prévia parcial de inventário' : 'Relatório completo de inventário';
  const rangeLabel = `${formatBRL(range.min)} – ${formatBRL(range.max)}`;
  const summaryTilesData = [
    { label: 'Contas no relatório', value: totals.clean, highlight: true },
    { label: 'Valor somado', value: formatBRL(totalInventoryValue), highlight: true },
    { label: 'IDs solicitadas', value: totals.requested },
    { label: 'Processadas', value: totals.processed },
    { label: 'Fora da faixa', value: totals.outOfRange },
    ...(!isMontuga ? [{ label: `Poucas caixas (<${getCaseThreshold().toFixed(0)}%)`, value: totals.lowCaseRatio }] : []),
    { label: 'Perfis privados', value: totals.privateProfiles },
    { label: 'VAC / Game ban', value: totals.vacBanned },
    { label: 'Falhas', value: totals.steamErrors + totals.inventoryErrors + totals.montugaErrors },
  ];
  const summaryTiles = summaryTilesData.map((tile) => `
    <div class="summary-tile${tile.highlight ? ' summary-highlight' : ''}">
      <span class="summary-label">${escapeHtml(tile.label)}</span>
      <span class="summary-value">${escapeHtml(String(tile.value ?? 0))}</span>
    </div>
  `).join('');
  const columnCount = isMontuga ? 5 : 7;

  return `<!DOCTYPE html>
  <html lang="pt-BR">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${escapeHtml(title)}</title>
      <style>
        :root {
          color-scheme: dark;
          font-family: 'Inter', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          min-height: 100vh;
          background: radial-gradient(120% 120% at 0% 0%, #1d4ed8 0%, #0b1120 55%, #030712 100%);
          color: #e2e8f0;
        }
        .report-shell {
          max-width: 1400px;
          margin: 0 auto;
          padding: 24px 16px 40px;
        }
        .report-card {
          background: rgba(15, 23, 42, 0.82);
          border: 1px solid rgba(148, 163, 184, 0.2);
          border-radius: 20px;
          padding: 24px;
          box-shadow: 0 30px 80px rgba(15, 23, 42, 0.45);
        }
        h1 {
          margin: 0 0 6px;
          font-size: 26px;
          font-weight: 700;
          letter-spacing: -0.02em;
        }
        .meta {
          margin: 0 0 20px;
          color: #94a3b8;
          font-size: 13px;
        }
        .range-tag, .montuga-tag {
          display: inline-block;
          border-radius: 999px;
          padding: 3px 12px;
          font-size: 12px;
          font-weight: 600;
          margin-left: 10px;
          vertical-align: middle;
        }
        .range-tag {
          background: rgba(34, 197, 94, 0.15);
          border: 1px solid rgba(34, 197, 94, 0.35);
          color: #bbf7d0;
        }
        .montuga-tag {
          background: rgba(139, 92, 246, 0.2);
          border: 1px solid rgba(139, 92, 246, 0.4);
          color: #c4b5fd;
        }
        .summary-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
          gap: 10px;
          margin-bottom: 24px;
        }
        .summary-tile {
          background: rgba(15, 23, 42, 0.6);
          border: 1px solid rgba(148, 163, 184, 0.25);
          border-radius: 14px;
          padding: 12px 14px;
        }
        .summary-highlight {
          border-color: rgba(34, 197, 94, 0.45);
          background: rgba(22, 101, 52, 0.25);
        }
        .summary-label {
          display: block;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #94a3b8;
        }
        .summary-value {
          display: block;
          margin-top: 4px;
          font-size: 20px;
          font-weight: 700;
          color: #f8fafc;
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 14px;
        }
        thead {
          background: rgba(51, 65, 85, 0.75);
          text-transform: uppercase;
          letter-spacing: 0.06em;
          font-size: 11px;
        }
        th {
          padding: 10px 12px;
          text-align: left;
          color: #cbd5f5;
          white-space: nowrap;
        }
        td {
          padding: 10px 12px;
          border-bottom: 1px solid rgba(148, 163, 184, 0.15);
          vertical-align: middle;
        }
        tbody tr:nth-child(odd) { background: rgba(15, 23, 42, 0.65); }
        tbody tr:nth-child(even) { background: rgba(30, 41, 59, 0.55); }
        tbody tr:hover { background: rgba(59, 130, 246, 0.12); }
        .cell-index { color: #64748b; width: 1%; }
        .cell-account { min-width: 0; }
        .name-link {
          display: block;
          color: #bfdbfe;
          text-decoration: none;
          font-weight: 600;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 260px;
        }
        .id-link {
          display: block;
          margin-top: 2px;
          color: #64748b;
          text-decoration: none;
          font-size: 12px;
          font-variant-numeric: tabular-nums;
        }
        .name-link:visited, .id-link:visited { color: #f87171; }
        .name-link:hover, .id-link:hover { text-decoration: underline; }
        .cell-value {
          font-size: 16px;
          font-weight: 800;
          color: #4ade80;
          white-space: nowrap;
          font-variant-numeric: tabular-nums;
        }
        .cell-case {
          font-weight: 600;
          color: #bbf7d0;
          white-space: nowrap;
          font-variant-numeric: tabular-nums;
        }
        .cell-sub {
          display: block;
          font-size: 12px;
          font-weight: 500;
          color: #94a3b8;
        }
        .cell-muted { color: #94a3b8; white-space: nowrap; font-size: 13px; }
        .state-pill {
          display: inline-block;
          border-radius: 999px;
          padding: 3px 10px;
          font-size: 12px;
          font-weight: 600;
          white-space: nowrap;
          max-width: 180px;
          overflow: hidden;
          text-overflow: ellipsis;
          vertical-align: middle;
        }
        .state-online { background: rgba(34, 197, 94, 0.18); border: 1px solid rgba(34, 197, 94, 0.35); color: #bbf7d0; }
        .state-offline { background: rgba(148, 163, 184, 0.16); border: 1px solid rgba(148, 163, 184, 0.3); color: #e2e8f0; }
        .state-in-game { background: rgba(59, 130, 246, 0.2); border: 1px solid rgba(59, 130, 246, 0.4); color: #dbeafe; }
        footer {
          margin-top: 24px;
          text-align: center;
          font-size: 12px;
          color: #94a3b8;
        }

        /* Telas estreitas (e o painel embutido): cada conta vira um cartão, sem rolagem lateral. */
        @media (max-width: 760px) {
          .report-shell { padding: 12px 8px 24px; }
          .report-card { padding: 16px 12px; border-radius: 16px; }
          h1 { font-size: 20px; }
          .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
          .summary-tile { padding: 10px 12px; }
          .summary-value { font-size: 17px; }
          thead { display: none; }
          table, tbody, tr, td { display: block; width: 100%; }
          tbody tr {
            display: grid;
            grid-template-columns: 1fr auto;
            gap: 4px 12px;
            padding: 12px;
            margin-bottom: 8px;
            border-radius: 12px;
            border: 1px solid rgba(148, 163, 184, 0.18);
          }
          td { padding: 0; border: none; }
          .cell-index { display: none; }
          .cell-account { grid-column: 1; grid-row: 1; }
          .cell-value { grid-column: 2; grid-row: 1; text-align: right; font-size: 18px; }
          .name-link { max-width: 100%; }
          td:not(.cell-account):not(.cell-value):not(.cell-index) {
            grid-column: 1 / -1;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 13px;
          }
          td:not(.cell-account):not(.cell-value):not(.cell-index)::before {
            content: attr(data-label);
            color: #64748b;
            font-size: 12px;
            font-weight: 400;
            margin-right: 12px;
          }
          .cell-case .cell-sub { display: inline; margin-left: 6px; }
        }
      </style>
    </head>
    <body>
      <div class="report-shell">
        <div class="report-card">
          <h1>${escapeHtml(title)}${isMontuga ? '<span class="montuga-tag">Montuga API</span>' : ''}<span class="range-tag">${escapeHtml(rangeLabel)}</span></h1>
          <p class="meta">Gerado em ${escapeHtml(generatedLabel)} • Job ${escapeHtml(job.id)}</p>
          <div class="summary-grid">
            ${summaryTiles}
          </div>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Conta</th>
                <th>Inventário</th>
                ${!isMontuga ? '<th>Caixas</th>' : ''}
                <th>Nível</th>
                <th>Estado</th>
                ${!isMontuga ? '<th>Último login</th>' : ''}
              </tr>
            </thead>
            <tbody>
              ${rows || `<tr><td colspan="${columnCount}">Nenhuma conta dentro da faixa ${escapeHtml(rangeLabel)} ainda.</td></tr>`}
            </tbody>
          </table>
          <footer>Relatório gerado automaticamente por Art Cases.</footer>
        </div>
      </div>
    </body>
  </html>`;
}

async function buildReport(job, { partial = false } = {}) {
  const totals = buildTotals(job.results, job.totalUnique);
  const generatedAt = new Date().toISOString();
  const getSortableValue = (profile) => {
    const key = job.jobType === 'montuga' ? 'totalValueBRL' : 'caseValueBRL';
    const raw = Number(profile?.[key]);
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

function findLatestActiveJob(jobType = null) {
  let selected = null;
  for (const job of jobs.values()) {
    if (job.status === 'processing' || job.status === 'paused') {
      if (jobType && (job.jobType || 'steamwebapi') !== jobType) {
        continue;
      }
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
    jobType: 'steamwebapi',
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
  const bodyPayload = buildWebhookPayload(job, stage, payload);
  try {
    let r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyPayload),
    });

    if (r.status === 415) {
      const fallbackBody = new URLSearchParams({ payload: JSON.stringify(bodyPayload) }).toString();
      r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: fallbackBody,
      });
    }

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
const PROFILE_BATCH_SIZE = 100; // GetPlayerSummaries e GetPlayerBans aceitam até 100 IDs por chamada.
const PROFILE_PREFETCH_AHEAD = 50; // Quando faltam 50 contas no lote atual, já busca o próximo.

function createBaseProfileInfo(steamId) {
  return {
    id: steamId,
    name: 'N/A',
    vacBanned: false,
    gameBans: 0,
    status: 'ready',
    personaState: null,
    personaStateLabel: 'Desconhecido',
    inGame: false,
    currentGame: null,
    steamLevel: null,
    statusReason: null,
  };
}

async function fetchJsonOrThrow(limiter, url, label) {
  const response = await limiter.fetch(url);
  if (!response.ok) {
    throw new Error(`${label} retornou ${response.status}`);
  }
  return response.json();
}

// Busca perfil + banimentos de até 100 contas com 2 chamadas no total.
async function fetchProfilesBatch(jobId, steamIds) {
  const ids = steamIds.join(',');
  const [summariesResult, bansResult] = await Promise.allSettled([
    fetchJsonOrThrow(
      steamApiLimiter,
      `${STEAM_API_BASE_URL}ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${ids}`,
      'Steam (perfis)',
    ),
    fetchJsonOrThrow(
      steamApiLimiter,
      `${STEAM_API_BASE_URL}ISteamUser/GetPlayerBans/v1/?key=${STEAM_API_KEY}&steamids=${ids}`,
      'Steam (bans)',
    ),
  ]);

  const summaries = new Map();
  if (summariesResult.status === 'fulfilled') {
    for (const player of summariesResult.value?.response?.players ?? []) {
      if (player?.steamid) summaries.set(String(player.steamid), player);
    }
  } else {
    appendLog(jobId, `Erro ao consultar lote de ${steamIds.length} perfis: ${summariesResult.reason?.message}`, 'error');
  }

  const bans = new Map();
  if (bansResult.status === 'fulfilled') {
    for (const ban of bansResult.value?.players ?? []) {
      if (ban?.SteamId) bans.set(String(ban.SteamId), ban);
    }
  } else {
    appendLog(jobId, `Não foi possível obter status VAC do lote: ${bansResult.reason?.message}`, 'warn');
  }

  const infos = new Map();
  for (const steamId of steamIds) {
    const info = createBaseProfileInfo(steamId);
    const profile = summaries.get(steamId);

    if (!profile) {
      info.status = 'steam_error';
      info.statusReason = summariesResult.status === 'fulfilled'
        ? 'Perfil não encontrado na Steam.'
        : 'Falha ao consultar perfil na Steam.';
      infos.set(steamId, info);
      continue;
    }

    const personaDetails = describePersonaState(profile);
    const realName = typeof profile.realname === 'string' ? profile.realname.trim() : '';
    info.name = realName || profile.personaname || 'N/A';
    info.personaState = Number.isFinite(personaDetails.code) ? personaDetails.code : null;
    info.personaStateLabel = personaDetails.label;
    info.inGame = Boolean(personaDetails.inGame);
    info.currentGame = personaDetails.game;
    if (typeof profile.lastlogoff === 'number') {
      info.lastLogoff = profile.lastlogoff;
    }

    const ban = bans.get(steamId);
    if (ban) {
      info.vacBanned = Boolean(ban.VACBanned);
      info.gameBans = Number(ban.NumberOfGameBans || 0);
    }

    if (info.vacBanned || info.gameBans > 0) {
      info.status = 'vac_banned';
      info.statusReason = 'Perfil bloqueado por VAC/Game Ban.';
    } else if (Number(profile.communityvisibilitystate) !== 3) {
      // Perfil privado: o inventário também é privado, então nem gastamos consulta de inventário.
      info.status = 'private_profile';
      info.statusReason = 'Perfil privado — inventário inacessível.';
    }

    infos.set(steamId, info);
  }

  return infos;
}

function loadProfileBatch(job, batchStart) {
  if (!job.profileBatches) job.profileBatches = new Map();
  if (batchStart >= job.queue.length) return null;
  if (!job.profileBatches.has(batchStart)) {
    const ids = job.queue.slice(batchStart, batchStart + PROFILE_BATCH_SIZE);
    const promise = fetchProfilesBatch(job.id, ids).catch((error) => {
      appendLog(job.id, `Falha inesperada no lote de perfis: ${error.message}`, 'error');
      return new Map();
    });
    job.profileBatches.set(batchStart, promise);
  }
  return job.profileBatches.get(batchStart);
}

async function getProfileInfo(job, index, steamId) {
  const batchStart = Math.floor(index / PROFILE_BATCH_SIZE) * PROFILE_BATCH_SIZE;
  const batchPromise = loadProfileBatch(job, batchStart);
  if (index - batchStart >= PROFILE_PREFETCH_AHEAD) {
    loadProfileBatch(job, batchStart + PROFILE_BATCH_SIZE);
  }
  // Libera da memória lotes que já ficaram para trás.
  job.profileBatches?.delete(batchStart - 2 * PROFILE_BATCH_SIZE);

  const infos = await batchPromise;
  const info = infos.get(steamId);
  if (info) return { ...info };
  const fallback = createBaseProfileInfo(steamId);
  fallback.status = 'steam_error';
  fallback.statusReason = 'Falha ao consultar perfil na Steam.';
  return fallback;
}

async function fetchSteamWebApiInventory(jobId, steamInfo) {
  const params = new URLSearchParams({
    key: STEAMWEBAPI_KEY,
    steam_id: steamInfo.id,
    game: 'cs2',
    parse: '1',
    currency: 'BRL',
  });
  try {
    const response = await steamWebApiLimiter.fetch(`${STEAMWEBAPI_BASE_URL}/inventory?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`SteamWebAPI retornou ${response.status}`);
    }
    const raw = await response.json();
    if (!Array.isArray(raw)) {
      console.warn(`[SteamWebAPI][${steamInfo.id}] resposta não é um array:`, JSON.stringify(raw).slice(0, 300));
    }
    const items = Array.isArray(raw) ? raw : [];

    let totalValue = 0;
    let caseValue = 0;
    let caseCount = 0;

    for (const item of items) {
      const price = Number(item?.pricelatest ?? item?.pricesafe ?? item?.priceavg ?? 0);
      if (!Number.isFinite(price) || price < 0) continue;
      totalValue += price;
      if (item?.itemtype === 'case') {
        caseValue += price;
        caseCount++;
      }
    }

    steamInfo.totalValueBRL = totalValue;
    steamInfo.caseValueBRL = caseValue;
    steamInfo.caseCount = caseCount;
    steamInfo.casePercentage = totalValue > 0 ? (caseValue / totalValue) * 100 : 0;
    steamInfo.status = 'success';
  } catch (error) {
    steamInfo.status = 'inventory_error';
    steamInfo.statusReason = 'Falha ao consultar a SteamWebAPI.';
    appendLog(jobId, `Erro SteamWebAPI: ${error.message}`, 'error', steamInfo.id);
  }
}

async function fetchMontugaInventory(jobId, steamInfo) {
  const url = `${MONTUGA_BASE_URL}/${steamInfo.id}/${APP_ID}/total-value`;
  try {
    const response = await montugaLimiter.fetch(url, {
      headers: {
        'api-key': MONTUGA_API_KEY,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Montuga retornou ${response.status}`);
    }
    const data = await response.json();
    if (!data || data.total_value === undefined || data.total_value === null) {
      console.warn(`[Montuga][${steamInfo.id}] campo "total_value" ausente:`, JSON.stringify(data).slice(0, 300));
    }
    const totalUSD = Number(data?.total_value || 0);
    steamInfo.totalValueBRL = totalUSD * USD_TO_BRL_RATE;
    steamInfo.status = 'success';
  } catch (error) {
    steamInfo.status = 'montuga_error';
    steamInfo.statusReason = 'Falha ao consultar a Montuga API.';
    appendLog(jobId, `Erro Montuga: ${error.message}`, 'error', steamInfo.id);
  }
}

// Aplica a faixa de valor e (na SteamWebAPI) o filtro de % em caixas.
function classifyInventory(job, profile) {
  if (profile.status !== 'success') return;
  const total = Number(profile.totalValueBRL) || 0;
  const range = getValueRange();

  if (total < range.min || total > range.max) {
    profile.status = 'out_of_range';
    profile.statusReason = `Inventário de ${formatBRL(total)} fora da faixa ${formatBRL(range.min)} – ${formatBRL(range.max)}.`;
    appendLog(job.id, `Excluído: ${formatBRL(total)} fora da faixa.`, 'warn', profile.id);
    return;
  }

  if (job.jobType !== 'montuga') {
    const threshold = getCaseThreshold();
    const pct = profile.casePercentage ?? 0;
    if (pct < threshold) {
      profile.status = 'low_case_ratio';
      profile.statusReason = `Inventário filtrado: ${pct.toFixed(1)}% em caixas (mínimo: ${threshold.toFixed(0)}%).`;
      appendLog(job.id, `Filtrado: ${pct.toFixed(1)}% em caixas (mínimo ${threshold.toFixed(0)}%). ${formatBRL(total)} total.`, 'warn', profile.id);
      return;
    }
    profile.statusReason = `Inventário avaliado. ${pct.toFixed(1)}% em caixas.`;
    appendLog(job.id, `Inventário: ${formatBRL(total)} total | ${formatBRL(profile.caseValueBRL)} em caixas (${pct.toFixed(1)}%)`, 'success', profile.id);
  } else {
    profile.statusReason = 'Inventário avaliado com sucesso pela Montuga.';
    appendLog(job.id, `Inventário avaliado: ${formatBRL(total)}`, 'success', profile.id);
  }

  if (total >= HIGH_VALUE_THRESHOLD_BRL) {
    appendLog(job.id, `Inventário premium identificado (≥ ${formatBRL(HIGH_VALUE_THRESHOLD_BRL)}).`, 'success', profile.id);
    notifyWebhook(job, 'high_value_profile', { profile: { ...profile } });
  }
}

// ----------------- IDs processadas (gravação em lote) -----------------
const processedIdBuffer = new Set();
let processedFlushTimer = null;
let processedFlushPromise = Promise.resolve();
const PROCESSED_FLUSH_DELAY_MS = 2000;

function markSteamIdProcessed(steamId) {
  processedIdBuffer.add(steamId);
  if (!processedFlushTimer) {
    processedFlushTimer = setTimeout(() => {
      processedFlushTimer = null;
      flushProcessedSteamIds();
    }, PROCESSED_FLUSH_DELAY_MS);
  }
}

function flushProcessedSteamIds() {
  if (processedFlushTimer) {
    clearTimeout(processedFlushTimer);
    processedFlushTimer = null;
  }
  if (!processedIdBuffer.size) return processedFlushPromise;
  const ids = Array.from(processedIdBuffer);
  processedIdBuffer.clear();
  processedFlushPromise = processedFlushPromise
    .then(() => appendProcessedSteamIds(ids))
    .catch((error) => console.error('Falha ao registrar SteamIDs processadas:', error));
  return processedFlushPromise;
}

// ----------------- Execução paralela -----------------
async function processOneProfile(job, index, steamId) {
  let profile;
  try {
    profile = await getProfileInfo(job, index, steamId);

    if (profile.status === 'vac_banned') {
      appendLog(job.id, `Perfil bloqueado por VAC/GameBan (${profile.gameBans} banimentos).`, 'warn', steamId);
    } else if (profile.status === 'private_profile') {
      appendLog(job.id, 'Perfil privado — inventário ignorado.', 'warn', steamId);
    } else if (profile.status === 'steam_error') {
      appendLog(job.id, profile.statusReason, 'error', steamId);
    }

    if (profile.status === 'ready') {
      if (job.jobType === 'montuga') {
        await fetchMontugaInventory(job.id, profile);
      } else {
        await fetchSteamWebApiInventory(job.id, profile);
      }
      classifyInventory(job, profile);
    }

    // Nível só é buscado para quem vai aparecer no relatório (economiza chamadas na Steam).
    if (profile.status === 'success') {
      try {
        const steamLevel = await fetchSteamLevelWithCache(steamId);
        if (typeof steamLevel === 'number') profile.steamLevel = steamLevel;
      } catch (error) {
        console.warn(`Não foi possível consultar o nível da Steam para ${steamId}.`, error);
      }
    }
  } catch (error) {
    console.error(`Falha inesperada ao processar ${steamId}:`, error);
    profile = profile || createBaseProfileInfo(steamId);
    profile.status = 'steam_error';
    profile.statusReason = 'Erro inesperado ao processar o perfil.';
    appendLog(job.id, `Erro inesperado: ${error.message}`, 'error', steamId);
  }

  // Se o job já foi finalizado enquanto esta conta estava em andamento, descarta.
  if (job.status === 'complete' || job.status === 'error') return;

  job.results.push(profile);
  job.updatedAt = Date.now();
  markSteamIdProcessed(steamId);
  broadcast(job, 'profile-processed', profile);
}

async function worker(job) {
  while (
    job.status === 'processing'
    && !job.paused
    && !job.stopRequested
    && job.currentIndex < job.queue.length
  ) {
    const index = job.currentIndex++;
    const steamId = job.queue[index];
    await processOneProfile(job, index, steamId);
  }
}

function inventoryConcurrencyFor(job) {
  const limiter = job.jobType === 'montuga' ? montugaLimiter : steamWebApiLimiter;
  // Um pouco mais de "trabalhadores" do que vagas na API, para a fila do limitador nunca ficar vazia
  // (contas banidas/privadas não usam a API de inventário e passam direto).
  return Math.max(1, limiter.concurrency * 2);
}

async function runJob(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.running) return;
  job.running = true;
  try {
    while (job.status === 'processing' && !job.paused) {
      if (job.stopRequested) {
        await flushProcessedSteamIds();
        await finalizeJob(jobId, { manualStop: true, reason: job.manualStopReason });
        return;
      }
      const remaining = job.queue.length - job.currentIndex;
      if (remaining <= 0) {
        await flushProcessedSteamIds();
        await finalizeJob(jobId);
        return;
      }
      const workerCount = Math.min(inventoryConcurrencyFor(job), remaining);
      await Promise.all(Array.from({ length: workerCount }, () => worker(job)));
    }
    // Saiu por pausa: grava o que já foi processado.
    await flushProcessedSteamIds();
  } finally {
    job.running = false;
  }
}

function startProcessing(jobId, context) {
  runJob(jobId).catch((error) => {
    console.error(`Falha ao ${context}:`, error);
    failJob(jobId, 'Erro inesperado durante o processamento.');
  });
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
  job.profileBatches = new Map();

  const range = getValueRange();
  appendLog(jobId, `Processando ${job.totalUnique} SteamIDs em paralelo...`);
  appendLog(jobId, `Somente contas entre ${formatBRL(range.min)} e ${formatBRL(range.max)} entram no relatório.`, 'info');
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

  startProcessing(jobId, 'iniciar processamento');
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

    await flushProcessedSteamIds();
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
    job.jobType = req.body.type === 'montuga' ? 'montuga' : 'steamwebapi';
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
  flushProcessedSteamIds();
  appendLog(job.id, 'Processamento pausado pelo usuário. As consultas em andamento serão concluídas.');
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

  startProcessing(job.id, 'retomar processamento');

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
      await flushProcessedSteamIds();
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
  appendLog(job.id, 'Finalização manual solicitada. Encerrando após as consultas em andamento.', 'warn');
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
    jobType: job.jobType || 'steamwebapi',
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
  const requestedType = req.query.type === 'montuga' ? 'montuga'
    : req.query.type === 'steamwebapi' ? 'steamwebapi'
    : null;
  const job = findLatestActiveJob(requestedType);
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
    jobType: job.jobType || 'steamwebapi',
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
        <div><strong>${entry.totals?.inventoryErrors ?? 0}</strong><span>Falhas Inventário</span></div>
        <div><strong>${entry.totals?.lowCaseRatio ?? 0}</strong><span>Filtrados caixas</span></div>
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

app.post('/auth', (req, res) => {
  if (!PANEL_PASSWORD) return res.json({ ok: true });
  const { password } = req.body;
  if (password === PANEL_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false, error: 'Senha incorreta.' });
});

app.get('/settings', authMiddleware, (req, res) => {
  res.json(runtimeSettings);
});

app.post('/settings', authMiddleware, async (req, res) => {
  const { caseThreshold, webhookUrl, minValueBRL, maxValueBRL } = req.body;
  if (typeof caseThreshold === 'number' && caseThreshold >= 0 && caseThreshold <= 100) {
    runtimeSettings.caseThreshold = caseThreshold;
  }
  if (typeof minValueBRL === 'number' && minValueBRL >= 0) {
    runtimeSettings.minValueBRL = minValueBRL;
  }
  if (typeof maxValueBRL === 'number' && maxValueBRL > 0) {
    runtimeSettings.maxValueBRL = maxValueBRL;
  }
  if (typeof webhookUrl === 'string') {
    runtimeSettings.webhookUrl = webhookUrl.trim();
  }
  try {
    await savePanelSettings();
  } catch (err) {
    console.warn('Não foi possível salvar configurações:', err);
  }
  res.json(runtimeSettings);
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
