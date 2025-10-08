require('dotenv/config');
const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { randomUUID } = require('crypto');

const MONTUGA_BASE_URL = 'https://montuga.com/api/IPricing/inventory';
const STEAM_API_BASE_URL = 'https://api.steampowered.com/';
const APP_ID = 730;
const USD_TO_BRL_RATE = 5.25;
const JOB_RETENTION_MS = 5 * 60 * 1000;

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

// ----------------- Funções auxiliares -----------------
function isValidWebhookUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function currentDateTimeLabel() {
  return new Date().toLocaleString('pt-BR', {
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

async function loadHistory() {
  try {
    const data = await fs.readFile(HISTORY_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    return {};
  }
}

async function saveHistory(history) {
  await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// ----------------- Controle de Jobs -----------------
function createJob() {
  const id = randomUUID();
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
    webhookUrl: process.env.NOTIFY_WEBHOOK_URL || null
  };
  jobs.set(id, job);
  return job;
}

function broadcast(job, event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of job.clients) client.write(data);
}

function appendLog(jobId, msg, type = 'info', steamId = null) {
  const job = jobs.get(jobId);
  if (!job) return;
  const prefix = steamId ? `[ID ${steamId}]` : '[GERAL]';
  const log = { message: `${prefix} ${msg}`, type, timestamp: Date.now() };
  job.logs.push(log);
  broadcast(job, 'log', log);
  console.log(`[JOB ${jobId}] ${log.message}`);
}

function scheduleCleanup(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  setTimeout(() => {
    const j = jobs.get(jobId);
    if (j && j.clients.size === 0) jobs.delete(jobId);
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
      body: JSON.stringify({ jobId: job.id, stage, ...payload })
    });
    if (!r.ok) throw new Error(`Webhook retornou ${r.status}`);
  } catch (err) {
    appendLog(job.id, `Falha webhook: ${err.message}`, 'warn');
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

function failJob(jobId, msg) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'error';
  job.result = { error: msg, logs: job.logs };
  broadcast(job, 'job-error', { error: msg });
  broadcast(job, 'end', { ok: false });
  notifyWebhook(job, 'failed', { error: msg });
  scheduleCleanup(jobId);
}

// ----------------- API Steam / Montuga -----------------
async function fetchSteamProfile(jobId, steamId) {
  const info = { id: steamId, name: 'N/A', vacBanned: false, gameBans: 0, status: 'ready' };
  try {
    const resp = await fetch(`${STEAM_API_BASE_URL}ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${steamId}`);
    const data = await resp.json();
    if (data?.response?.players?.[0]) info.name = data.response.players[0].personaname;
    appendLog(jobId, `Perfil localizado: ${info.name}`, 'info', steamId);
  } catch (e) {
    info.status = 'steam_error';
    appendLog(jobId, `Erro perfil: ${e.message}`, 'error', steamId);
  }
  return info;
}

async function fetchMontugaInventory(jobId, steamInfo) {
  const url = `${MONTUGA_BASE_URL}/${steamInfo.id}/${APP_ID}/total-value`;
  try {
    const r = await fetch(url, { headers: { 'api-key': MONTUGA_API_KEY } });
    const data = await r.json();
    const val = Number(data?.total_value || 0) * USD_TO_BRL_RATE;
    steamInfo.totalValueBRL = val;
    steamInfo.status = 'success';
    appendLog(jobId, `Inventário: R$${val.toFixed(2)}`, 'success', steamInfo.id);
  } catch (e) {
    steamInfo.status = 'montuga_error';
    appendLog(jobId, `Erro Montuga: ${e.message}`, 'error', steamInfo.id);
  }
}

function calcSummary(results) {
  const ok = results.filter(r => r.status === 'success');
  return {
    successCount: ok.length,
    total: results.length,
    montugaErrors: results.filter(r => r.status === 'montuga_error').length,
    steamErrors: results.filter(r => r.status === 'steam_error').length
  };
}

// ----------------- Execução sequencial -----------------
async function processNext(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.paused) return;

  if (job.currentIndex >= job.queue.length) {
    const summary = calcSummary(job.results);
    finalizeJob(jobId, summary);
    return;
  }

  const id = job.queue[job.currentIndex++];
  const profile = await fetchSteamProfile(jobId, id);
  if (profile.status === 'ready') await fetchMontugaInventory(jobId, profile);
  job.results.push(profile);

  broadcast(job, 'profile-processed', profile);
  setTimeout(() => processNext(jobId), 1000);
}

async function startJob(jobId, ids) {
  const job = jobs.get(jobId);
  job.status = 'processing';
  job.queue = [...new Set(ids)];
  job.totalUnique = job.queue.length;
  appendLog(jobId, `Processando ${job.totalUnique} SteamIDs...`);
  await notifyWebhook(job, 'started');
  processNext(jobId);
}

// ----------------- Rotas -----------------
app.post('/process', (req, res) => {
  const ids = (req.body.steam_ids || '').split(/\s+/).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'Informe pelo menos um SteamID.' });
  const job = createJob();
  res.json({ jobId: job.id });
  startJob(job.id, ids);
});

app.get('/process/:jobId/stream', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).end();
  res.setHeader('Content-Type', 'text/event-stream');
  res.flushHeaders?.();
  job.clients.add(res);
  req.on('close', () => job.clients.delete(res));
});

app.get('/process/:jobId/result', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  res.json(job.result || { status: job.status });
});

app.listen(PORT, () => console.log(`✅ Servidor iniciado em http://localhost:${PORT}`));
