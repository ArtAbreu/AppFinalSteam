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
  if (!value) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch (error) {
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
    if (error.code === 'ENOENT') {
      return {};
    }
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
  for (const client of job.clients) {
    client.write(data);
  }
}

function appendLog(jobId, message, type = 'info', steamId = null) {
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }
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
  if (!job) {
    return;
  }
  if (job.timeout) {
    clearTimeout(job.timeout);
  }
  job.timeout = setTimeout(() => {
    const currentJob = jobs.get(jobId);
    if (!currentJob) {
      return;
    }
    if (currentJob.clients.size === 0) {
      jobs.delete(jobId);
    }
  }, JOB_RETENTION_MS);
}

async function notifyWebhook(job, stage, payload = {}) {
  const webhookUrl = job.webhookUrl || process.env.NOTIFY_WEBHOOK_URL;
  if (!webhookUrl) {
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jobId: job.id,
        stage,
        timestamp: new Date().toISOString(),
        ...payload
      })
    });
    if (!response.ok) {
      throw new Error(`Webhook retornou status ${response.status}`);
    }
  } catch (error) {
    appendLog(job.id, `Falha ao enviar webhook: ${error.message}`, 'warn');
  }
}

function finalizeJob(jobId, payload) {
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }
  job.status = 'complete';
  job.result = { ...payload, logs: job.logs };
  broadcast(job, 'complete', job.result);
  broadcast(job, 'end', { ok: true });
  scheduleCleanup(jobId);
}

function failJob(jobId, errorMessage) {
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }
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
    if (!response.ok) {
      throw new Error(`Steam retornou status ${response.status}`);
    }
    const data = await response.json();
    if (data?.response?.players?.length) {
      result.name = data.response.players[0].personaname;
      appendLog(jobId, `Perfil localizado: ${result.name}`, 'info', steamId);
    } else {
      throw new Error('Perfil não localizado na Steam API.');
    }
  } catch (error) {
    result.status = 'steam_error';
    result.reason = `Falha ao buscar perfil: ${error.message}`;
    appendLog(jobId, result.reason, 'error', steamId);
    return result;
  }

  try {
    const urlBan = `${STEAM_API_BASE_URL}ISteamUser/GetPlayerBans/v1/?key=${STEAM_API_KEY}&steamids=${steamId}`;
    const response = await fetch(urlBan);
    if (!response.ok) {
      throw new Error(`Steam retornou status ${response.status}`);
    }
    const data = await response.json();
    if (!data?.players?.length) {
      throw new Error('Resposta da Steam para bans veio vazia.');
    }
    const bans = data.players[0];
    result.vacBanned = Boolean(bans.VACBanned);
    result.gameBans = Number(bans.NumberOfGameBans || 0);

    if (result.vacBanned) {
      result.status = 'vac_banned';
      result.reason = 'VAC ban detectado. Montuga ignorado.';
      appendLog(jobId, 'Status: VAC BAN detectado. Inventário removido da análise.', 'error', steamId);
    } else {
      if (result.gameBans > 0) {
        appendLog(jobId, `Status: ${result.gameBans} ban(s) de jogo identificados.`, 'warn', steamId);
      } else {
        appendLog(jobId, 'Status: Clean (sem bans).', 'success', steamId);
      }
    }
  } catch (error) {
    result.status = 'steam_error';
    result.reason = `Falha ao buscar status de ban: ${error.message}`;
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
      headers: {
        'api-key': MONTUGA_API_KEY,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      let errorMessage = `Montuga retornou status ${response.status}.`;
      try {
        const errorJson = await response.json();
        if (errorJson?.message) {
          errorMessage = errorJson.message;
        }
      } catch (parseError) {
        const bodyText = await response.text();
        errorMessage = `${errorMessage} Corpo: ${bodyText.substring(0, 120)}...`;
      }
      throw new Error(errorMessage);
    }

    const data = await response.json();
    const totalValueUSD = Number(data?.total_value || 0);
    const totalValueBRL = Number((totalValueUSD * USD_TO_BRL_RATE).toFixed(2));

    steamInfo.totalValueBRL = totalValueBRL;
    steamInfo.casesPercentage = Number(data?.cases_percentage || 0);
    steamInfo.status = 'success';
    steamInfo.reason = 'Inventário avaliado com sucesso.';
    steamInfo.processedAt = Date.now();
    steamInfo.processedAtLabel = currentDateTimeLabel();

    const logType = totalValueBRL > 0 ? 'success' : 'warn';
    const formattedValue = totalValueBRL.toFixed(2).replace('.', ',');
    appendLog(jobId, `Inventário avaliado em R$ ${formattedValue}.`, logType, steamInfo.id);
    return { success: true };
  } catch (error) {
    steamInfo.status = 'montuga_error';
    steamInfo.reason = `Falha Montuga: ${error.message}`;
    appendLog(jobId, steamInfo.reason, 'error', steamInfo.id);
    return { success: false };
  }
}

async function saveJobResultsToHistory(currentHistory, results) {
  const updatedHistory = { ...currentHistory };

  for (const item of results) {
    const timestamp = Date.now();
    const baseEntry = {
      status: item.status,
      success: item.status === 'success' || item.status === 'vac_banned',
      timestamp,
      date: currentDateTimeLabel(),
      reason: item.reason || null
    };

    if (item.status === 'success' || item.status === 'vac_banned') {
      const data = {
        steamId: item.id,
        realName: item.name,
        totalValueBRL: item.status === 'success' ? Number(item.totalValueBRL || 0) : 0,
        vacBanned: item.vacBanned,
        gameBans: item.gameBans,
        casesPercentage: Number(item.casesPercentage || 0),
        recordedAt: timestamp
      };
      baseEntry.data = data;
    }

    updatedHistory[item.id] = baseEntry;
  }

  await saveHistory(updatedHistory);
  return updatedHistory;
}

function buildReportRows(items) {
  if (!items.length) {
    return '<tr><td class="empty-state" colspan="5">Nenhum inventário elegível foi encontrado nesta execução.</td></tr>';
  }

  return items.map((item) => {
    const statusLabel = item.vacBanned
      ? 'VAC Ban'
      : item.gameBans > 0
        ? `${item.gameBans} Ban(s) de jogo`
        : 'Sem bans';
    const statusClass = item.vacBanned
      ? 'status-vac'
      : item.gameBans > 0
        ? 'status-warning'
        : 'status-clean';
    const formattedValue = `R$ ${Number(item.totalValueBRL || 0).toFixed(2).replace('.', ',')}`;
    const formattedCases = `${Number(item.casesPercentage || 0).toFixed(2).replace('.', ',')}%`;
    const safeName = escapeHtml(item.realName || 'Perfil Steam');
    const dateLabel = escapeHtml(item.date || currentDateTimeLabel());

    return `
      <tr>
        <td>
          <div class="profile-name">${safeName}</div>
          <a class="profile-link" href="https://steamcommunity.com/profiles/${item.steamId}" target="_blank" rel="noopener noreferrer">Abrir perfil</a>
        </td>
        <td><span class="status-chip ${statusClass}">${statusLabel}</span></td>
        <td><span class="value-highlight">${formattedValue}</span></td>
        <td>${formattedCases}</td>
        <td>${dateLabel}</td>
      </tr>
    `;
  }).join('');
}

function generateReportHtml(items, summary) {
  const { title, subtitle, metrics } = summary;
  const rows = buildReportRows(items);

  const metricsHtml = (metrics || []).map((metric) => `
    <div class="metric">
      <span class="metric-label">${escapeHtml(metric.label)}</span>
      <strong class="metric-value">${escapeHtml(String(metric.value))}</strong>
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
      font-family: 'Inter', 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
    }
    body {
      margin: 0;
      padding: 48px 32px;
      background: radial-gradient(circle at top, #1d1e33 0%, #0b0b16 55%, #050508 100%);
      color: #f5f5ff;
    }
    .report-shell {
      max-width: 1100px;
      margin: 0 auto;
      background: rgba(15, 17, 34, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 20px;
      box-shadow: 0 25px 80px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(16px);
      padding: 40px;
    }
    h1 {
      margin: 0;
      font-size: 2.4rem;
      letter-spacing: 0.04em;
    }
    .subtitle {
      margin: 8px 0 32px;
      color: #aeb4ff;
      font-size: 1rem;
      letter-spacing: 0.02em;
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }
    .metric {
      padding: 18px;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .metric-label {
      display: block;
      color: #a0a4c2;
      font-size: 0.85rem;
      margin-bottom: 6px;
    }
    .metric-value {
      font-size: 1.4rem;
      font-weight: 700;
      letter-spacing: 0.03em;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(7, 8, 20, 0.75);
      border-radius: 16px;
      overflow: hidden;
    }
    thead {
      background: linear-gradient(135deg, rgba(69, 88, 255, 0.4), rgba(255, 118, 82, 0.25));
    }
    th, td {
      padding: 16px 18px;
      text-align: left;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }
    th {
      text-transform: uppercase;
      font-size: 0.75rem;
      letter-spacing: 0.16em;
      color: #d7dbff;
    }
    tr:last-child td {
      border-bottom: none;
    }
    tbody tr:hover {
      background: rgba(69, 88, 255, 0.1);
    }
    .profile-name {
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .profile-link {
      display: inline-block;
      margin-top: 6px;
      font-size: 0.82rem;
      color: #7ee0ff;
      text-decoration: none;
    }
    .profile-link:hover {
      text-decoration: underline;
    }
    .status-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.05em;
    }
    .status-clean {
      background: rgba(85, 239, 196, 0.16);
      color: #55efc4;
    }
    .status-warning {
      background: rgba(255, 204, 102, 0.16);
      color: #ffcc66;
    }
    .status-vac {
      background: rgba(255, 82, 82, 0.16);
      color: #ff5252;
    }
    .value-highlight {
      font-weight: 700;
      color: #ffe082;
      letter-spacing: 0.04em;
    }
    .empty-state {
      text-align: center;
      padding: 40px;
      font-size: 1rem;
      color: #b0b4d0;
    }
  </style>
</head>
<body>
  <div class="report-shell">
    <h1>${escapeHtml(title)}</h1>
    <p class="subtitle">${escapeHtml(subtitle)}</p>
    <div class="metrics-grid">${metricsHtml || ''}</div>
    <table>
      <thead>
        <tr>
          <th>Perfil Steam</th>
          <th>Status</th>
          <th>Valor Total (BRL)</th>
          <th>% Cases</th>
          <th>Processado Em</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>
</body>
</html>`;
}

function calculateJobSummary(jobResults, totalRequested) {
  const successfulInventories = jobResults
    .filter((item) => item.status === 'success')
    .map((item) => ({
      steamId: item.id,
      realName: item.name,
      totalValueBRL: item.totalValueBRL,
      casesPercentage: item.casesPercentage,
      vacBanned: item.vacBanned,
      gameBans: item.gameBans,
      date: item.processedAtLabel || currentDateTimeLabel()
    }));

  successfulInventories.sort((a, b) => b.totalValueBRL - a.totalValueBRL);

  const montugaErrors = jobResults.filter((item) => item.status === 'montuga_error').length;
  const steamErrors = jobResults.filter((item) => item.status === 'steam_error').length;
  const vacBannedCount = jobResults.filter((item) => item.status === 'vac_banned').length;
  const cleanProfiles = jobResults.filter((item) => !item.vacBanned && item.status !== 'steam_error').length;

  return {
    successfulInventories,
    successCount: successfulInventories.length,
    montugaErrors,
    steamErrors,
    vacBannedCount,
    cleanProfiles,
    totals: {
      requested: totalRequested,
      processed: jobResults.length,
      pending: Math.max(totalRequested - jobResults.length, 0),
      clean: cleanProfiles,
      vacBanned: vacBannedCount,
      steamErrors,
      montugaErrors
    }
  };
}

async function processNextProfile(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'processing') {
    return;
  }

  if (job.paused) {
    return;
  }

  if (job.currentIndex >= job.queue.length) {
    const summary = calculateJobSummary(job.results, job.totalUnique);
    const generatedAt = currentDateTimeLabel();

    job.historyCache = await saveJobResultsToHistory(job.historyCache || {}, job.results);
    appendLog(jobId, `Histórico atualizado com ${job.results.length} registro(s).`, 'info');

    appendLog(jobId, `Processamento concluído com ${summary.successCount} inventário(s) avaliados.`, 'success');

    const reportHtml = generateReportHtml(summary.successfulInventories, {
      title: 'Art Cases — Relatório de Inventário',
      subtitle: `Execução finalizada em ${generatedAt}`,
      metrics: [
        { label: 'IDs analisadas', value: job.totalUnique },
        { label: 'Inventários avaliados', value: summary.successCount },
        { label: 'Perfis limpos', value: summary.cleanProfiles },
        { label: 'VAC ban bloqueados', value: summary.vacBannedCount },
        { label: 'Falhas de API', value: summary.steamErrors + summary.montugaErrors }
      ]
    });

    finalizeJob(jobId, {
      reportHtml,
      successCount: summary.successCount,
      totals: {
        requested: job.totalUnique,
        clean: summary.cleanProfiles,
        vacBanned: summary.vacBannedCount,
        steamErrors: summary.steamErrors,
        montugaErrors: summary.montugaErrors,
        processed: job.results.length,
        pending: 0
      },
      generatedAt: new Date().toISOString()
    });

    await notifyWebhook(job, 'complete', {
      totals: summary.totals
    });

    return;
  }

  const steamId = job.queue[job.currentIndex];
  job.currentIndex += 1;

  const steamInfo = await fetchSteamProfileAndBans(jobId, steamId);

  const isReadyForMontuga = steamInfo.status === 'ready';

  if (isReadyForMontuga) {
    appendLog(jobId, 'Perfil liberado. Iniciando avaliação Montuga…', 'info', steamInfo.id);
    await fetchMontugaInventory(jobId, steamInfo);
  }

  job.results.push(steamInfo);

  broadcast(job, 'profile-processed', {
    id: steamInfo.id,
    name: steamInfo.name,
    status: steamInfo.status,
    vacBanned: steamInfo.vacBanned,
    gameBans: steamInfo.gameBans,
    totalValueBRL: steamInfo.totalValueBRL || 0,
    casesPercentage: steamInfo.casesPercentage || 0,
    reason: steamInfo.reason || null
  });

  if (!job.paused) {
    setTimeout(() => {
      processNextProfile(jobId).catch((error) => {
        console.error(`[JOB ${jobId}] Falha ao continuar processamento:`, error);
        failJob(jobId, 'Erro inesperado durante o processamento sequencial.');
      });
    }, 0);
  }
}

async function processInventoryJob(jobId, steamIdsInput) {
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }
  job.status = 'processing';

  const trimmedIds = steamIdsInput.map((id) => id.trim()).filter(Boolean);
  const uniqueIds = [...new Set(trimmedIds)];

  job.queue = uniqueIds;
  job.totalUnique = uniqueIds.length;
  job.currentIndex = 0;
  job.results = [];
  job.paused = false;
  job.historyCache = await loadHistory();

  appendLog(jobId, `Processando ${uniqueIds.length} Steam ID(s).`);
  if (trimmedIds.length !== uniqueIds.length) {
    appendLog(jobId, `${trimmedIds.length - uniqueIds.length} ID(s) duplicadas foram ignoradas.`, 'warn');
  }

  await notifyWebhook(job, 'started', {
    totals: { requested: uniqueIds.length }
  });

  await processNextProfile(jobId);
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.post('/process', (req, res) => {
  const rawIds = req.body.steam_ids || '';
  const trimmed = rawIds.split(/\s+/).filter(Boolean);

  if (!trimmed.length) {
    return res.status(400).json({ error: 'Informe ao menos uma Steam ID (64 bits).' });
  }

  const webhookInput = typeof req.body.webhook_url === 'string' ? req.body.webhook_url.trim() : '';
  if (webhookInput && !isValidWebhookUrl(webhookInput)) {
    return res.status(400).json({ error: 'Informe uma URL de webhook válida (http/https).' });
  }

  const job = createJob();
  if (webhookInput) {
    job.webhookUrl = webhookInput;
  }
  res.json({ jobId: job.id });

  processInventoryJob(job.id, trimmed).catch((error) => {
    console.error(`[JOB ${job.id}] Erro inesperado:`, error);
    failJob(job.id, 'Erro inesperado no processamento. Consulte os logs do servidor.');
  });
});

app.post('/process/:jobId/pause', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Processo não encontrado.' });
  }
  if (job.status !== 'processing') {
    return res.status(400).json({ error: 'O processo não está em execução.' });
  }
  if (job.paused) {
    return res.status(409).json({ error: 'O processo já está pausado.' });
  }

  job.paused = true;
  appendLog(job.id, 'Processamento pausado pelo usuário.', 'warn');
  broadcast(job, 'job-paused', { paused: true });

  const summary = calculateJobSummary(job.results, job.totalUnique);
  await notifyWebhook(job, 'paused', { totals: summary.totals });

  return res.json({ ok: true });
});

app.post('/process/:jobId/resume', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Processo não encontrado.' });
  }
  if (job.status !== 'processing') {
    return res.status(400).json({ error: 'O processo não está em execução.' });
  }
  if (!job.paused) {
    return res.status(409).json({ error: 'O processo já está ativo.' });
  }

  job.paused = false;
  appendLog(job.id, 'Processamento retomado.', 'info');
  broadcast(job, 'job-resumed', { paused: false });

  notifyWebhook(job, 'resumed', { totals: calculateJobSummary(job.results, job.totalUnique).totals }).catch((error) => {
    console.error(`[JOB ${job.id}] Falha ao enviar webhook de retomada:`, error);
  });

  processNextProfile(job.id).catch((error) => {
    console.error(`[JOB ${job.id}] Falha ao retomar processamento:`, error);
    failJob(job.id, 'Erro inesperado ao retomar o processamento.');
  });

  return res.json({ ok: true });
});

app.get('/process/:jobId/partial-report', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Processo não encontrado.' });
    return;
  }

  if (job.status === 'complete' && job.result) {
    res.json({ ...job.result, partial: false });
    return;
  }

  if (job.status !== 'processing') {
    res.status(400).json({ error: 'Nenhuma execução ativa para gerar relatório parcial.' });
    return;
  }

  const summary = calculateJobSummary(job.results, job.totalUnique);
  const generatedAt = currentDateTimeLabel();

  const reportHtml = generateReportHtml(summary.successfulInventories, {
    title: 'Art Cases — Relatório Parcial',
    subtitle: `Prévia gerada em ${generatedAt}`,
    metrics: [
      { label: 'IDs processadas', value: summary.totals.processed },
      { label: 'IDs pendentes', value: summary.totals.pending },
      { label: 'Inventários avaliados', value: summary.successCount },
      { label: 'Perfis limpos', value: summary.cleanProfiles },
      { label: 'VAC ban bloqueados', value: summary.vacBannedCount }
    ]
  });

  res.json({
    reportHtml,
    successCount: summary.successCount,
    totals: {
      requested: job.totalUnique,
      processed: summary.totals.processed,
      pending: summary.totals.pending,
      clean: summary.cleanProfiles,
      vacBanned: summary.vacBannedCount,
      steamErrors: summary.steamErrors,
      montugaErrors: summary.montugaErrors
    },
    generatedAt: new Date().toISOString(),
    partial: true
  });
});

app.get('/process/:jobId/stream', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).end();
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  job.clients.add(res);

  for (const log of job.logs) {
    res.write(`event: log\ndata: ${JSON.stringify(log)}\n\n`);
  }

  if (job.status === 'complete' && job.result) {
    res.write(`event: complete\ndata: ${JSON.stringify(job.result)}\n\n`);
    res.write('event: end\ndata: {"ok":true}\n\n');
  }

  if (job.status === 'error' && job.error) {
    res.write(`event: job-error\ndata: ${JSON.stringify({ error: job.error })}\n\n`);
    res.write('event: end\ndata: {"ok":false}\n\n');
  }

  req.on('close', () => {
    job.clients.delete(res);
  });
});

app.get('/process/:jobId/result', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Processo não encontrado ou expirado.' });
  }

  if (job.status === 'complete' && job.result) {
    return res.json(job.result);
  }

  if (job.status === 'error') {
    return res.status(500).json({ error: job.error, logs: job.logs });
  }

  return res.status(202).json({ status: job.status });
});

app.get('/download-history', async (req, res) => {
  const history = await loadHistory();
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
  const recentProfiles = [];

  for (const id in history) {
    const record = history[id];
    if (record.success && record.timestamp && record.timestamp >= oneDayAgo && record.data) {
      recentProfiles.push({ ...record.data, recordedAt: record.data.recordedAt || record.timestamp });
    }
  }

  const inventoriesForReport = recentProfiles.filter((profile) => profile.totalValueBRL > 0 || profile.vacBanned);

  if (!inventoriesForReport.length) {
    return res.status(404).send('Nenhum inventário elegível encontrado nas últimas 24 horas.');
  }

  const items = inventoriesForReport.map((profile) => ({
    steamId: profile.steamId,
    realName: profile.realName,
    totalValueBRL: profile.totalValueBRL,
    casesPercentage: profile.casesPercentage,
    vacBanned: profile.vacBanned,
    gameBans: profile.gameBans,
    date: new Date(profile.recordedAt || Date.now()).toLocaleString('pt-BR')
  }));

  const vacBannedCount = items.filter((item) => item.vacBanned).length;
  const reportHtml = generateReportHtml(items, {
    title: 'Art Cases — Histórico (24h)',
    subtitle: `Relatório gerado em ${currentDateTimeLabel()}`,
    metrics: [
      { label: 'Perfis elegíveis', value: items.length },
      { label: 'VAC ban no período', value: vacBannedCount },
      { label: 'Inventários avaliados', value: items.filter((item) => !item.vacBanned).length }
    ]
  });

  res.setHeader('Content-Type', 'text/html');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="relatorio_historico_24h_${new Date().toISOString().slice(0, 10)}.html"`
  );
  res.send(reportHtml);
});

app.listen(PORT, () => {
  console.log(`\n✅ Servidor iniciado em http://localhost:${PORT}`);
});
