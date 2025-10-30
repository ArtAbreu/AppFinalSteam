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

const DEFAULT_JOB_LEVEL_THRESHOLD = 15;
const DEFAULT_JOB_LEVEL_COMPARATOR = 'lte';
const DEFAULT_REQUIRE_ONLINE = false;
const DEFAULT_INCLUDE_UNKNOWN_LEVEL = false;

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

function clampSteamLevel(value, fallback = MIN_STEAM_LEVEL) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const normalized = Math.floor(parsed);
  if (!Number.isFinite(normalized)) {
    return fallback;
  }
  return Math.max(0, Math.min(500, normalized));
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'sim', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'n', 'não', 'nao', 'off'].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

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

function normalizeJobFilters(raw = {}) {
  const thresholdCandidate = raw.levelThreshold ?? raw.level_threshold;
  const comparatorCandidate = raw.levelComparator ?? raw.level_comparator;
  const requireOnlineCandidate = raw.requireOnline ?? raw.require_online;
  const includeUnknownCandidate = raw.includeUnknownLevel ?? raw.include_unknown_level;

  const normalizedThreshold = clampSteamLevel(
    thresholdCandidate,
    DEFAULT_JOB_LEVEL_THRESHOLD,
  );

  const comparator = comparatorCandidate === 'gte' || comparatorCandidate === 'lte'
    ? comparatorCandidate
    : DEFAULT_JOB_LEVEL_COMPARATOR;

  return {
    levelThreshold: normalizedThreshold,
    levelComparator: comparator,
    requireOnline: parseBoolean(requireOnlineCandidate, DEFAULT_REQUIRE_ONLINE),
    includeUnknownLevel: parseBoolean(includeUnknownCandidate, DEFAULT_INCLUDE_UNKNOWN_LEVEL),
  };
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

async function fetchFriendsForSteamId(steamId, options = {}) {
  const includeMissingData = options.includeMissingData !== false;

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
    filteredMissingProfile: 0,
    includedMissingProfile: 0,
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
  const includedFriends = new Set();

  for (const friendId of uniqueFriends) {
    const summary = playerSummaries.get(friendId);
    if (!summary) {
      if (includeMissingData) {
        includedFriends.add(friendId);
        stats.includedMissingProfile += 1;
      } else {
        stats.filteredMissingProfile += 1;
      }
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

    stats.offlineEligible += 1;
    includedFriends.add(friendId);
  }

  const filteredFriends = uniqueFriends.filter((friendId) => includedFriends.has(friendId));
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
    montugaErrors: 0,
    skippedOffline: 0,
    skippedInGame: 0,
    skippedLevel: 0,
    skippedUnknownLevel: 0,
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
      case 'skipped_offline':
        totals.skippedOffline += 1;
        break;
      case 'skipped_in_game':
        totals.skippedInGame += 1;
        break;
      case 'skipped_level':
        totals.skippedLevel += 1;
        break;
      case 'skipped_level_unknown':
        totals.skippedUnknownLevel += 1;
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
    case 'skipped_offline':
      return 'Ignorado (offline)';
    case 'skipped_in_game':
      return 'Ignorado (em jogo)';
    case 'skipped_level':
      return 'Ignorado (nível fora do filtro)';
    case 'skipped_level_unknown':
      return 'Ignorado (nível indisponível)';
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
    case 'montuga_error':
    case 'steam_error':
      return 'status-warning';
    case 'skipped_offline':
    case 'skipped_in_game':
    case 'skipped_level':
    case 'skipped_level_unknown':
      return 'status-muted';
    default:
      return 'status-neutral';
  }
}

function generateReportHtml({ job, results, totals, partial, generatedAt }) {
  const filters = normalizeJobFilters(job?.filters || {});
  const filterParts = [
    filters.levelComparator === 'lte'
      ? `nível ≤ ${filters.levelThreshold}`
      : `nível ≥ ${filters.levelThreshold}`,
    filters.requireOnline ? 'apenas perfis online e fora de jogo' : 'qualquer status online/offline',
    filters.includeUnknownLevel ? 'inclui níveis desconhecidos' : 'ignora níveis desconhecidos',
  ];
  const filterSummary = filterParts.join(' • ');

  const rows = results.map((profile, index) => {
    const amount = typeof profile.totalValueBRL === 'number'
      ? `R$ ${profile.totalValueBRL.toFixed(2)}`
      : '—';
    const statusLabel = formatStatusLabel(profile);
    const badgeClass = statusBadgeClass(profile.status);
    const personaLabel = profile.inGame && profile.currentGame
      ? `Jogando ${profile.currentGame}`
      : profile.personaStateLabel || (profile.inGame ? 'Em jogo' : 'Desconhecido');
    const personaClass = profile.inGame
      ? 'state-in-game'
      : Number(profile.personaState) > 0
        ? 'state-online'
        : 'state-offline';
    const levelLabel = typeof profile.steamLevel === 'number' ? profile.steamLevel : '—';
    const statusNote = profile.statusReason
      ? `<span class="status-note">${escapeHtml(profile.statusReason)}</span>`
      : '';

    return `
      <tr>
        <td>${index + 1}</td>
        <td>
          <a href="${steamProfileUrl(profile.id)}" target="_blank" rel="noopener noreferrer" class="id-link">
            ${escapeHtml(profile.id)}
          </a>
        </td>
        <td>
          <a href="${steamProfileUrl(profile.id)}" target="_blank" rel="noopener noreferrer" class="name-link">
            ${escapeHtml(profile.name ?? 'N/A')}
          </a>
        </td>
        <td><span class="state-pill ${personaClass}">${escapeHtml(personaLabel)}</span></td>
        <td>
          <span class="status-badge ${badgeClass}">${escapeHtml(statusLabel)}</span>
          ${statusNote}
        </td>
        <td>${levelLabel}</td>
        <td>${profile.vacBanned ? 'Sim' : 'Não'}</td>
        <td>${profile.gameBans ?? 0}</td>
        <td>${amount}</td>
      </tr>
    `;
  }).join('');

  const generatedLabel = currentDateTimeLabel(generatedAt);
  const title = partial ? 'Prévia parcial de inventário' : 'Relatório completo de inventário';
  const summaryTiles = [
    { label: 'IDs solicitadas', value: totals.requested },
    { label: 'Processadas', value: totals.processed },
    { label: 'Inventários avaliados', value: totals.clean },
    { label: 'VAC ban bloqueados', value: totals.vacBanned },
    { label: 'Ignorados (offline)', value: totals.skippedOffline },
    { label: 'Ignorados (em jogo)', value: totals.skippedInGame },
    { label: 'Ignorados (nível)', value: totals.skippedLevel },
    { label: 'Ignorados (nível indisp.)', value: totals.skippedUnknownLevel },
    { label: 'Falhas Steam', value: totals.steamErrors },
    { label: 'Falhas Montuga', value: totals.montugaErrors },
  ].map((tile) => `
    <div class="summary-tile">
      <span class="summary-label">${escapeHtml(tile.label)}</span>
      <span class="summary-value">${tile.value}</span>
    </div>
  `).join('');

  return `<!DOCTYPE html>
  <html lang="pt-BR">
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(title)}</title>
      <style>
        :root {
          color-scheme: dark;
          font-family: 'Inter', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        }
        body {
          margin: 0;
          min-height: 100vh;
          background: radial-gradient(120% 120% at 0% 0%, #1d4ed8 0%, #0b1120 55%, #030712 100%);
          color: #e2e8f0;
        }
        .report-shell {
          max-width: 1200px;
          margin: 0 auto;
          padding: 48px 24px 64px;
        }
        .report-card {
          background: rgba(15, 23, 42, 0.82);
          border: 1px solid rgba(148, 163, 184, 0.2);
          border-radius: 24px;
          padding: 36px 40px;
          box-shadow: 0 30px 80px rgba(15, 23, 42, 0.45);
          backdrop-filter: blur(18px);
        }
        h1 {
          margin: 0 0 12px;
          font-size: 32px;
          font-weight: 700;
          letter-spacing: -0.02em;
        }
        .meta {
          margin: 0 0 28px;
          color: #94a3b8;
          font-size: 15px;
        }
        .filter-banner {
          margin-bottom: 28px;
          padding: 16px 20px;
          border-radius: 16px;
          background: rgba(37, 99, 235, 0.2);
          border: 1px solid rgba(96, 165, 250, 0.35);
          color: #bfdbfe;
          font-size: 15px;
        }
        .filter-banner strong {
          display: block;
          font-size: 13px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          margin-bottom: 4px;
          color: #dbeafe;
        }
        .summary-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 18px;
          margin-bottom: 36px;
        }
        .summary-tile {
          background: rgba(15, 23, 42, 0.6);
          border: 1px solid rgba(148, 163, 184, 0.25);
          border-radius: 18px;
          padding: 18px 20px;
        }
        .summary-label {
          display: block;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.12em;
          color: #94a3b8;
        }
        .summary-value {
          margin-top: 8px;
          font-size: 28px;
          font-weight: 700;
          color: #f8fafc;
        }
        .table-wrapper {
          overflow-x: auto;
          border-radius: 20px;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          min-width: 960px;
          border-radius: 20px;
          overflow: hidden;
        }
        thead {
          background: rgba(51, 65, 85, 0.75);
          text-transform: uppercase;
          letter-spacing: 0.08em;
          font-size: 12px;
        }
        th {
          padding: 16px;
          text-align: left;
          color: #cbd5f5;
        }
        td {
          padding: 18px 16px;
          border-bottom: 1px solid rgba(148, 163, 184, 0.15);
          vertical-align: top;
        }
        tbody tr:nth-child(odd) {
          background: rgba(15, 23, 42, 0.65);
        }
        tbody tr:nth-child(even) {
          background: rgba(30, 41, 59, 0.55);
        }
        tbody tr:last-child td {
          border-bottom: none;
        }
        .id-link,
        .name-link {
          color: #bfdbfe;
          text-decoration: none;
          font-weight: 600;
        }
        .id-link:hover,
        .name-link:hover {
          text-decoration: underline;
        }
        .status-badge {
          display: inline-flex;
          align-items: center;
          border-radius: 999px;
          padding: 6px 14px;
          font-size: 13px;
          font-weight: 600;
          letter-spacing: 0.02em;
        }
        .status-success {
          background: rgba(34, 197, 94, 0.2);
          color: #bbf7d0;
          border: 1px solid rgba(34, 197, 94, 0.35);
        }
        .status-danger {
          background: rgba(239, 68, 68, 0.18);
          color: #fecaca;
          border: 1px solid rgba(248, 113, 113, 0.35);
        }
        .status-warning {
          background: rgba(249, 115, 22, 0.2);
          color: #fed7aa;
          border: 1px solid rgba(249, 115, 22, 0.4);
        }
        .status-muted {
          background: rgba(148, 163, 184, 0.18);
          color: #e2e8f0;
          border: 1px solid rgba(148, 163, 184, 0.35);
        }
        .status-neutral {
          background: rgba(59, 130, 246, 0.2);
          color: #dbeafe;
          border: 1px solid rgba(59, 130, 246, 0.35);
        }
        .status-note {
          display: block;
          margin-top: 8px;
          color: #cbd5f5;
          font-size: 13px;
          max-width: 320px;
          line-height: 1.4;
        }
        .state-pill {
          display: inline-flex;
          align-items: center;
          border-radius: 999px;
          padding: 6px 14px;
          font-size: 13px;
          font-weight: 600;
          letter-spacing: 0.02em;
        }
        .state-online {
          background: rgba(34, 197, 94, 0.18);
          border: 1px solid rgba(34, 197, 94, 0.35);
          color: #bbf7d0;
        }
        .state-offline {
          background: rgba(148, 163, 184, 0.16);
          border: 1px solid rgba(148, 163, 184, 0.3);
          color: #e2e8f0;
        }
        .state-in-game {
          background: rgba(59, 130, 246, 0.2);
          border: 1px solid rgba(59, 130, 246, 0.4);
          color: #dbeafe;
        }
        footer {
          margin-top: 40px;
          text-align: center;
          font-size: 13px;
          color: #94a3b8;
        }
        @media (max-width: 768px) {
          .report-card {
            padding: 28px 24px;
          }
          h1 {
            font-size: 26px;
          }
          table {
            min-width: 720px;
          }
        }
      </style>
    </head>
    <body>
      <div class="report-shell">
        <div class="report-card">
          <h1>${escapeHtml(title)}</h1>
          <p class="meta">Gerado em ${escapeHtml(generatedLabel)} • Job ${escapeHtml(job.id)}</p>
          <div class="filter-banner">
            <strong>Filtros ativos</strong>
            ${escapeHtml(filterSummary)}
          </div>
          <div class="summary-grid">
            ${summaryTiles}
          </div>
          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Steam ID</th>
                  <th>Apelido</th>
                  <th>Estado Steam</th>
                  <th>Status</th>
                  <th>Nível</th>
                  <th>VAC ban</th>
                  <th>Game bans</th>
                  <th>Inventário (BRL)</th>
                </tr>
              </thead>
              <tbody>
                ${rows || '<tr><td colspan="9">Nenhum perfil processado ainda.</td></tr>'}
              </tbody>
            </table>
          </div>
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
    filters: { ...normalizeJobFilters(job.filters || {}) },
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
    filters: normalizeJobFilters(),
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
  const info = {
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
  try {
    const summaryResponse = await fetch(`${STEAM_API_BASE_URL}ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${steamId}`);
    if (!summaryResponse.ok) {
      throw new Error(`Steam retornou ${summaryResponse.status}`);
    }
    const summaryData = await summaryResponse.json();
    const profile = summaryData?.response?.players?.[0];
    const personaDetails = describePersonaState(profile);
    const realName = typeof profile?.realname === 'string' ? profile.realname.trim() : '';
    if (realName) {
      info.name = realName;
    } else if (profile?.personaname) {
      info.name = profile.personaname;
    }
    info.personaState = Number.isFinite(personaDetails.code) ? personaDetails.code : null;
    info.personaStateLabel = personaDetails.label;
    info.inGame = Boolean(personaDetails.inGame);
    info.currentGame = personaDetails.game;
  } catch (error) {
    info.status = 'steam_error';
    info.statusReason = 'Falha ao consultar perfil na Steam.';
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
    info.statusReason = 'Perfil bloqueado por VAC/Game Ban.';
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
    steamInfo.statusReason = 'Inventário avaliado com sucesso pela Montuga.';
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
    steamInfo.statusReason = 'Falha ao consultar a Montuga API.';
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
  const filters = job.filters || normalizeJobFilters();
  const profile = await fetchSteamProfile(jobId, steamId);

  if (profile.status === 'ready' && filters.requireOnline) {
    const personaState = Number(profile.personaState);
    if (!Number.isFinite(personaState) || personaState <= 0) {
      profile.status = 'skipped_offline';
      profile.statusReason = 'Perfil offline ou invisível no momento da verificação.';
      appendLog(jobId, 'Perfil ignorado por estar offline/invisível.', 'warn', steamId);
    } else if (profile.inGame) {
      profile.status = 'skipped_in_game';
      profile.statusReason = profile.currentGame
        ? `Perfil em jogo (${profile.currentGame}).`
        : 'Perfil em jogo.';
      appendLog(jobId, 'Perfil ignorado por estar em sessão de jogo.', 'warn', steamId);
    }
  }

  if (profile.status === 'ready') {
    try {
      const steamLevel = await fetchSteamLevelWithCache(steamId);
      if (typeof steamLevel === 'number') {
        profile.steamLevel = steamLevel;
        const meetsThreshold = filters.levelComparator === 'lte'
          ? steamLevel <= filters.levelThreshold
          : steamLevel >= filters.levelThreshold;
        if (!meetsThreshold) {
          profile.status = 'skipped_level';
          profile.statusReason = filters.levelComparator === 'lte'
            ? `Nível ${steamLevel} acima do limite (${filters.levelThreshold}).`
            : `Nível ${steamLevel} abaixo do mínimo (${filters.levelThreshold}).`;
          appendLog(jobId, `Perfil ignorado por nível fora do filtro (nível ${steamLevel}).`, 'warn', steamId);
        }
      } else if (!filters.includeUnknownLevel) {
        profile.status = 'skipped_level_unknown';
        profile.statusReason = 'Nível Steam indisponível.';
        appendLog(jobId, 'Perfil ignorado por não possuir nível disponível.', 'warn', steamId);
      }
    } catch (error) {
      console.warn(`Não foi possível consultar o nível da Steam para ${steamId}.`, error);
      if (profile.status === 'ready' && !filters.includeUnknownLevel) {
        profile.status = 'skipped_level_unknown';
        profile.statusReason = 'Nível Steam não pôde ser consultado.';
        appendLog(jobId, 'Perfil ignorado por falha ao consultar nível Steam.', 'warn', steamId);
      }
    }
  }

  if (profile.status === 'ready') {
    appendLog(
      jobId,
      `Perfil elegível (nível ${profile.steamLevel ?? 'N/D'}). Consultando inventário na Montuga…`,
      'info',
      steamId,
    );
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
  const normalizedFilters = normalizeJobFilters(options.filters || job.filters || {});
  job.filters = normalizedFilters;

  appendLog(jobId, `Processando ${job.totalUnique} SteamIDs...`);
  const comparatorSymbol = normalizedFilters.levelComparator === 'lte' ? '≤' : '≥';
  appendLog(
    jobId,
    `Filtros aplicados: nível ${comparatorSymbol} ${normalizedFilters.levelThreshold}, ` +
      `${normalizedFilters.requireOnline ? 'apenas perfis online/fora de jogo' : 'qualquer status online/offline'}${
        normalizedFilters.includeUnknownLevel ? ', níveis desconhecidos incluídos' : ', níveis desconhecidos ignorados'
      }`,
    'info',
  );
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

  const rawFilters = req.body?.filters && typeof req.body.filters === 'object' ? req.body.filters : null;
  const normalizedFilters = {};
  if (rawFilters && typeof rawFilters.includeMissingData === 'boolean') {
    normalizedFilters.includeMissingData = rawFilters.includeMissingData;
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
        return await fetchFriendsForSteamId(sanitized, normalizedFilters);
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

    const filters = normalizeJobFilters({
      levelThreshold: req.body.level_threshold,
      levelComparator: req.body.level_comparator,
      requireOnline: req.body.require_online,
      includeUnknownLevel: req.body.include_unknown_level,
    });

    res.json({ jobId: job.id, shareLink, ignoredSteamIds: skippedSteamIds, filters });

    startJob(job.id, filteredIds, webhookCandidate, { skippedSteamIds, filters });
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
    filters: normalizeJobFilters(job.filters || {}),
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

