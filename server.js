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
const JOB_RETENTION_MS = 5 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = __dirname;
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const HISTORY_FILE = path.join(ROOT_DIR, 'history.json');

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

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(DIST_DIR));

const jobs = new Map();

const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_ENTRIES = 50;
const PROCESS_DELAY_MS = 1000;

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

function ensureHistoryShape(data) {
  if (Array.isArray(data)) {
    return { entries: data };
  }
  if (data && Array.isArray(data.entries)) {
    return { entries: data.entries };
  }
  return { entries: [] };
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
    return { entries: [] };
  }
}

async function saveHistory(history) {
  await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
}

async function appendHistoryEntry(entry) {
  const history = await loadHistory();
  const now = Date.now();
  const entries = [entry, ...history.entries]
    .filter((item) => {
      if (!item || !item.generatedAt) return false;
      const ts = new Date(item.generatedAt).getTime();
      if (Number.isNaN(ts)) return false;
      return now - ts <= HISTORY_RETENTION_MS;
    })
    .slice(0, MAX_HISTORY_ENTRIES);

  await saveHistory({ entries });
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
        <td>${escapeHtml(profile.id)}</td>
        <td>${escapeHtml(profile.name ?? 'N/A')}</td>
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
  const reportHtml = generateReportHtml({ job, results: job.results, totals, partial, generatedAt });

  return {
    jobId: job.id,
    successCount: totals.clean,
    totals,
    reportHtml,
    generatedAt,
    partial,
  };
}

// ----------------- Controle de Jobs -----------------
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
async function notifyWebhook(job, stage, payload = {}) {
  const url = job.webhookUrl || process.env.NOTIFY_WEBHOOK_URL;
  if (!url) return;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.id, stage, ...payload }),
    });
    if (!r.ok) {
      throw new Error(`Webhook retornou ${r.status}`);
    }
  } catch (err) {
    appendLog(job.id, `Falha webhook: ${err.message}`, 'warn');
  }
}

async function finalizeJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  const payload = await buildReport(job, { partial: false });
  job.status = 'complete';
  job.result = { ...payload, logs: job.logs };
  job.timer = null;
  job.updatedAt = Date.now();
  job.finishedAt = job.updatedAt;
  broadcast(job, 'complete', job.result);
  broadcast(job, 'end', { ok: true });
  await appendHistoryEntry(payload);
  notifyWebhook(job, 'completed', { totals: payload.totals, successCount: payload.successCount });
  scheduleCleanup(jobId);
}

function failJob(jobId, msg) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'error';
  job.result = { error: msg, logs: job.logs };
  job.timer = null;
  job.updatedAt = Date.now();
  broadcast(job, 'job-error', { error: msg });
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
    if (profile?.personaname) {
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

async function startJob(jobId, ids, webhookUrl) {
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

  appendLog(jobId, `Processando ${job.totalUnique} SteamIDs...`);
  notifyWebhook(job, 'started', { requested: job.totalUnique });

  processNext(jobId).catch((error) => {
    console.error('Falha ao iniciar processamento:', error);
    failJob(jobId, 'Erro inesperado durante o processamento.');
  });
}

// ----------------- Rotas -----------------
app.post('/process', (req, res) => {
  const ids = (req.body.steam_ids || '')
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);

  if (!ids.length) {
    return res.status(400).json({ error: 'Informe pelo menos um SteamID.' });
  }

  const webhookCandidate = (req.body.webhook_url || '').trim();
  if (webhookCandidate && !isValidWebhookUrl(webhookCandidate)) {
    return res.status(400).json({ error: 'Informe uma URL de webhook válida ou deixe o campo em branco.' });
  }

  const job = createJob();
  res.json({ jobId: job.id });

  startJob(job.id, ids, webhookCandidate);
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

function buildHistoryHtml(entries) {
  const rows = entries.map((entry, index) => {
    const encodedHtml = Buffer.from(entry.reportHtml || '', 'utf-8').toString('base64');
    return `
    <section class="history-entry">
      <header>
        <h2>Registro ${index + 1} • ${escapeHtml(currentDateTimeLabel(entry.generatedAt))}</h2>
        <span class="badge ${entry.partial ? 'badge-partial' : 'badge-final'}">${entry.partial ? 'Prévia' : 'Final'}</span>
        <span class="job-id">Job ${escapeHtml(entry.jobId || 'desconhecido')}</span>
      </header>
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
        <iframe src="data:text/html;base64,${encodedHtml}" sandbox="allow-same-origin"></iframe>
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
    const now = Date.now();
    const entries = history.entries.filter((entry) => {
      if (!entry?.generatedAt) return false;
      const timestamp = new Date(entry.generatedAt).getTime();
      if (Number.isNaN(timestamp)) return false;
      return now - timestamp <= HISTORY_RETENTION_MS;
    });

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
