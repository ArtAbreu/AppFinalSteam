import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';

const MONTUGA_BASE_URL = 'https://montuga.com/api/IPricing/inventory';
const STEAM_API_BASE_URL = 'https://api.steampowered.com/';
const APP_ID = 730;

const MONTUGA_API_KEY = process.env.MONTUGA_API_KEY;
const STEAM_API_KEY = process.env.STEAM_API_KEY;

const fetch = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null;

if (!MONTUGA_API_KEY || !STEAM_API_KEY) {
  console.error('\n❌ Falha na inicialização: defina as variáveis de ambiente MONTUGA_API_KEY e STEAM_API_KEY.');
  process.exit(1);
}

if (!fetch) {
  console.error('\n❌ A API Fetch não está disponível. Utilize Node.js 18+ ou adicione um polyfill compatível.');
  process.exit(1);
}

const USD_TO_BRL_RATE = 5.25;
const HISTORY_FILE = 'history.json';
const JOB_RETENTION_MS = 5 * 60 * 1000;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'dist')));

const jobs = new Map();

function isValidWebhookUrl(value) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

const currentDateTimeLabel = () => new Date().toLocaleString('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

const escapeHtml = (value = '') => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

async function loadHistory() {
  try {
    const data = await fs.readFile(HISTORY_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    console.error(`[ERRO CACHE] Falha ao carregar history.json: ${error.message}`);
    return {};
  }
}

async function saveHistory(history) {
  try {
    await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
  } catch (error) {
    console.error(`[ERRO CACHE] Falha ao salvar history.json: ${error.message}`);
  }
}

function createJob() {
  const id = randomUUID();
  const job = {
    id,
    status: 'pending',
    logs: [],
    result: null,
    error: null,
    createdAt: Date.now(),
    clients: new Set(),
    timeout: null,
    paused: false,
    queue: [],
    currentIndex: 0,
    results: [],
    totalUnique: 0,
    webhookUrl: process.env.NOTIFY_WEBHOOK_URL || null,
    historyCache: null
  };
  jobs.set(id, job);
  return job;
}

function broadcast(job, event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of job.clients) client.write(data);
}

function appendLog(jobId, message, type = 'info', steamId = null) {
  const job = jobs.get(jobId);
  if (!job) return;
  const prefix = steamId ? `[ID ${steamId}]` : '[GERAL]';
  const logEntry = {
    message: `${prefix} ${message}`,
    type,
    id: steamId,
    timestamp: Date.now()
  };
  job.logs.push(logEntry);
  broadcast(job, 'log', logEntry);
  console.log(`[JOB ${jobId}] ${logEntry.message}`);
}

function scheduleCleanup(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  if (job.timeout) clearTimeout(job.timeout);
  job.timeout = setTimeout(() => {
    const currentJob = jobs.get(jobId);
    if (currentJob && currentJob.clients.size === 0) jobs.delete(jobId);
  }, JOB_RETENTION_MS);
}

async function notifyWebhook(job, stage, payload = {}) {
  const webhookUrl = job.webhookUrl || process.env.NOTIFY_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: job.id,
        stage,
        timestamp: new Date().toISOString(),
        ...payload
      })
    });
    if (!response.ok) throw new Error(`Webhook retornou status ${response.status}`);
  } catch (error) {
    appendLog(job.id, `Falha ao enviar webhook: ${error.message}`, 'warn');
  }
}

function finalizeJob(jobId, payload) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'complete';
  job.result = { ...payload, logs: job.logs };
  broadcast(job, 'complete', job.result);
  broadcast(job, 'end', { ok: true });
  scheduleCleanup(jobId);
}

function failJob(jobId, errorMessage) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'error';
  job.error = errorMessage;
  job.result = { error: errorMessage, logs: job.logs };
  broadcast(job, 'job-error', { error: errorMessage });
  broadcast(job, 'end', { ok: false });
  scheduleCleanup(jobId);
  notifyWebhook(job, 'failed', { error: errorMessage }).catch((error) => {
    console.error(`[JOB ${jobId}] Falha ao enviar webhook de erro:`, error);
  });
}

async function fetchSteamProfileAndBans(jobId, steamId) {
  const result = {
    id: steamId,
    name: 'N/A',
    vacBanned: false,
    gameBans: 0,
    status: 'ready',
    reason: null,
    totalValueBRL: 0,
    casesPercentage: 0
  };

  try {
    const urlName = `${STEAM_API_BASE_URL}ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${steamId}`;
    const response = await fetch(urlName);
    const data = await response.json();
    if (data?.response?.players?.length) {
      result.name = data.response.players[0].personaname;
      appendLog(jobId, `Perfil localizado: ${result.name}`, 'info', steamId);
    } else throw new Error('Perfil não localizado.');
  } catch (error) {
    result.status = 'steam_error';
    result.reason = `Falha ao buscar perfil: ${error.message}`;
    appendLog(jobId, result.reason, 'error', steamId);
    return result;
  }

  try {
    const urlBan = `${STEAM_API_BASE_URL}ISteamUser/GetPlayerBans/v1/?key=${STEAM_API_KEY}&steamids=${steamId}`;
    const response = await fetch(urlBan);
    const data = await response.json();
    const bans = data.players?.[0];
    result.vacBanned = Boolean(bans.VACBanned);
    result.gameBans = Number(bans.NumberOfGameBans || 0);
    if (result.vacBanned) {
      result.status = 'vac_banned';
      result.reason = 'VAC ban detectado.';
      appendLog(jobId, 'VAC BAN detectado — ignorado.', 'error', steamId);
    } else appendLog(jobId, 'Status: Clean (sem bans).', 'success', steamId);
  } catch (error) {
    result.status = 'steam_error';
    result.reason = `Erro ao buscar bans: ${error.message}`;
    appendLog(jobId, result.reason, 'error', steamId);
  }

  return result;
}

async function fetchMontugaInventory(jobId, steamInfo) {
  const url = `${MONTUGA_BASE_URL}/${steamInfo.id}/${APP_ID}/total-value`;
  appendLog(jobId, 'Consultando inventário na Montuga API...', 'info', steamInfo.id);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'api-key': MONTUGA_API_KEY, 'Accept': 'application/json' }
    });

    const data = await response.json();
    const totalValueUSD = Number(data?.total_value || 0);
    const totalValueBRL = Number((totalValueUSD * USD_TO_BRL_RATE).toFixed(2));

    steamInfo.totalValueBRL = totalValueBRL;
    steamInfo.casesPercentage = Number(data?.cases_percentage || 0);
    steamInfo.status = 'success';
    steamInfo.reason = 'Inventário avaliado com sucesso.';
    steamInfo.processedAtLabel = currentDateTimeLabel();

    appendLog(jobId, `Inventário avaliado em R$ ${totalValueBRL.toFixed(2).replace('.', ',')}`, 'success', steamInfo.id);
    return { success: true };
  } catch (error) {
    steamInfo.status = 'montuga_error';
    steamInfo.reason = `Falha Montuga: ${error.message}`;
    appendLog(jobId, steamInfo.reason, 'error', steamInfo.id);
    return { success: false };
  }
}

function calculateJobSummary(jobResults, totalRequested) {
  const successfulInventories = jobResults
    .filter((i) => i.status === 'success')
    .map((i) => ({
      steamId: i.id,
      realName: i.name,
      totalValueBRL: i.totalValueBRL,
      casesPercentage: i.casesPercentage,
      vacBanned: i.vacBanned,
      gameBans: i.gameBans,
      date: i.processedAtLabel || currentDateTimeLabel()
    }));

  return {
    successfulInventories,
    successCount: successfulInventories.length,
    montugaErrors: jobResults.filter((i) => i.status === 'montuga_error').length,
    steamErrors: jobResults.filter((i) => i.status === 'steam_error').length,
    vacBannedCount: jobResults.filter((i) => i.status === 'vac_banned').length,
    cleanProfiles: jobResults.filter((i) => !i.vacBanned && i.status !== 'steam_error').length,
    totals: {
      requested: totalRequested,
      processed: jobResults.length,
      pending: Math.max(totalRequested - jobResults.length, 0)
    }
  };
}

async function processNextProfile(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'processing') return;
  if (job.paused) return;

  if (job.currentIndex >= job.queue.length) {
    const summary = calculateJobSummary(job.results, job.totalUnique);
    const generatedAt = currentDateTimeLabel();

    job.historyCache = await saveHistory(job.historyCache || {});
    appendLog(jobId, `Concluído com ${summary.successCount} inventários avaliados.`, 'success');

    finalizeJob(jobId, { summary, generatedAt });
    await notifyWebhook(job, 'complete', { totals: summary.totals });
    return;
  }

  const steamId = job.queue[job.currentIndex++];
  const steamInfo = await fetchSteamProfileAndBans(jobId, steamId);

  if (steamInfo.status === 'ready') {
    appendLog(jobId, 'Perfil liberado. Iniciando avaliação Montuga…', 'info', steamInfo.id);
    await fetchMontugaInventory(jobId, steamInfo);
  }

  job.results.push(steamInfo);
  broadcast(job, 'profile-processed', steamInfo);

  if (!job.paused) setTimeout(() => processNextProfile(jobId), 0);
}

async function processInventoryJob(jobId, steamIdsInput) {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = 'processing';
  const uniqueIds = [...new Set(steamIdsInput.map((id) => id.trim()).filter(Boolean))];

  job.queue = uniqueIds;
  job.totalUnique = uniqueIds.length;
  job.currentIndex = 0;
  job.results = [];
  job.paused = false;
  job.historyCache = await loadHistory();

  appendLog(jobId, `Processando ${uniqueIds.length} Steam ID(s).`);
  await notifyWebhook(job, 'started', { totals: { requested: uniqueIds.length } });
  await processNextProfile(jobId);
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));

app.post('/process', (req, res) => {
  const rawIds = req.body.steam_ids || '';
  const trimmed = rawIds.split(/\s+/).filter(Boolean);

  if (!trimmed.length) return res.status(400).json({ error: 'Informe ao menos uma Steam ID válida.' });

  const webhookUrl = typeof req.body.webhook_url === 'string' ? req.body.webhook_url.trim() : '';
  if (webhookUrl && !isValidWebhookUrl(webhookUrl)) {
    return res.status(400).json({ error: 'Informe uma URL de webhook válida.' });
  }

  const job = createJob();
  if (webhookUrl) job.webhookUrl = webhookUrl;
  res.json({ jobId: job.id });

  processInventoryJob(job.id, trimmed).catch((error) => {
    console.error(`[JOB ${job.id}] Erro inesperado:`, error);
    failJob(job.id, 'Erro inesperado no processamento.');
  });
});

app.listen(PORT, () => console.log(`✅ Servidor iniciado em http://localhost:${PORT}`));
