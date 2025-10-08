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

const DEFAULT_USD_TO_BRL_RATE = 5.25;
const HISTORY_FILE = 'history.json';
const JOB_RETENTION_MS = 5 * 60 * 1000;
const PHONE_NOTIFICATION_WEBHOOK_URL = process.env.PHONE_NOTIFICATION_WEBHOOK_URL || process.env.NOTIFICATION_WEBHOOK_URL || null;
const PHONE_NOTIFICATION_TOKEN = process.env.PHONE_NOTIFICATION_TOKEN || null;

const exchangeRateCache = {
  value: DEFAULT_USD_TO_BRL_RATE,
  fetchedAt: 0
};

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'dist')));

const jobs = new Map();

const currentDateTimeLabel = () => new Date().toLocaleString('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

async function getUsdToBrlRate(jobId) {
  const FIVE_MINUTES = 5 * 60 * 1000;
  const now = Date.now();

  if (exchangeRateCache.value && now - exchangeRateCache.fetchedAt < FIVE_MINUTES) {
    return exchangeRateCache.value;
  }

  const endpoint = 'https://open.er-api.com/v6/latest/USD';

  try {
    appendLog(jobId, 'Atualizando cotação do dólar em tempo real…');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
      response = await fetch(endpoint, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new Error(`Falha ao consultar taxa de câmbio (status ${response.status}).`);
    }

    const json = await response.json();
    const rate = Number(json?.rates?.BRL);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error('Resposta da API de câmbio inválida.');
    }

    exchangeRateCache.value = rate;
    exchangeRateCache.fetchedAt = now;
    appendLog(jobId, `Cotação atualizada: US$ 1 = R$ ${rate.toFixed(2)}.`, 'success');
    return rate;
  } catch (error) {
    if (error.name === 'AbortError') {
      appendLog(jobId, 'Tempo limite atingido ao atualizar cotação do dólar.', 'warn');
    }
    const fallback = exchangeRateCache.value || DEFAULT_USD_TO_BRL_RATE;
    appendLog(jobId, `Não foi possível atualizar a cotação (usando cache R$ ${fallback.toFixed(2)}). Motivo: ${error.message}`, 'warn');
    return fallback;
  }
}

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
    timeout: null
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
}

async function notifyHighValueInventory(jobId, context) {
  if (!PHONE_NOTIFICATION_WEBHOOK_URL) {
    appendLog(jobId, 'Nenhum webhook configurado para alertas premium. Defina PHONE_NOTIFICATION_WEBHOOK_URL para habilitar.', 'warn', context.id);
    return;
  }

  const payload = {
    title: 'Art Cases • Inventário premium detectado',
    message: `Perfil ${context.personaName || context.name} excedeu R$ ${context.totalValueBRL.toFixed(2)}.`,
    steamId: context.id,
    totalValueBRL: context.totalValueBRL,
    totalValueUSD: context.totalValueUSD,
    conversionRate: context.conversionRate,
    profileUrl: `https://steamcommunity.com/profiles/${context.id}`,
    timestamp: Date.now(),
    token: PHONE_NOTIFICATION_TOKEN || undefined
  };

  const response = await fetch(PHONE_NOTIFICATION_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Webhook respondeu ${response.status}: ${errorText}`);
  }

  appendLog(jobId, 'Alerta enviado para o telefone (inventário acima de R$ 3.000).', 'success', context.id);
}

async function fetchSteamProfileAndBans(jobId, steamId) {
  const result = {
    id: steamId,
    name: 'N/A',
    personaName: 'N/A',
    realName: null,
    vacBanned: false,
    gameBans: 0,
    status: 'ready',
    reason: null,
    totalValueBRL: 0,
    casesPercentage: 0,
    timeCreated: null,
    lastLogOff: null
  };

  try {
    const urlName = `${STEAM_API_BASE_URL}ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${steamId}`;
    const response = await fetch(urlName);
    if (!response.ok) {
      throw new Error(`Steam retornou status ${response.status}`);
    }
    const data = await response.json();
    if (data?.response?.players?.length) {
      const player = data.response.players[0];
      result.name = player.personaname;
      result.personaName = player.personaname;
      result.realName = player.realname || null;
      result.timeCreated = player.timecreated ? Number(player.timecreated) : null;
      result.lastLogOff = player.lastlogoff ? Number(player.lastlogoff) : null;
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
    const conversionRate = Number(steamInfo.conversionRate || exchangeRateCache.value || DEFAULT_USD_TO_BRL_RATE);
    const totalValueBRL = Number((totalValueUSD * conversionRate).toFixed(2));

    steamInfo.totalValueBRL = totalValueBRL;
    steamInfo.casesPercentage = Number(data?.cases_percentage || 0);
    steamInfo.status = 'success';
    steamInfo.reason = 'Inventário avaliado com sucesso.';
    steamInfo.processedAt = Date.now();
    steamInfo.processedAtLabel = currentDateTimeLabel();

    const logType = totalValueBRL > 0 ? 'success' : 'warn';
    const formattedValue = totalValueBRL.toFixed(2).replace('.', ',');
    appendLog(jobId, `Inventário avaliado em R$ ${formattedValue}.`, logType, steamInfo.id);

    if (totalValueBRL >= 3000) {
      notifyHighValueInventory(jobId, {
        ...steamInfo,
        totalValueBRL,
        totalValueUSD,
        conversionRate
      }).catch((error) => {
        appendLog(jobId, `Falha ao enviar notificação premium: ${error.message}`, 'warn', steamInfo.id);
      });
    }
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
        personaName: item.personaName,
        realIdentity: item.realName,
        totalValueBRL: item.status === 'success' ? Number(item.totalValueBRL || 0) : 0,
        vacBanned: item.vacBanned,
        gameBans: item.gameBans,
        casesPercentage: Number(item.casesPercentage || 0),
        recordedAt: timestamp,
        timeCreated: item.timeCreated,
        lastLogOff: item.lastLogOff,
        conversionRate: item.conversionRate
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

function scoreInventoryCandidate(item) {
  let score = 0;

  const valueScore = Math.min(item.totalValueBRL / 1000, 5);
  score += valueScore * 2;

  if (item.timeCreated) {
    const years = (Date.now() - item.timeCreated * 1000) / (365 * 24 * 60 * 60 * 1000);
    score += Math.min(years, 10) * 0.5;
  } else {
    score += 1;
  }

  if (item.realIdentity) {
    score += 3;
  } else if ((item.realName || item.personaName || '').includes(' ')) {
    score += 1.5;
  }

  if (item.lastLogOff) {
    const daysSince = (Date.now() - item.lastLogOff * 1000) / (24 * 60 * 60 * 1000);
    score += Math.min(daysSince / 30, 3);
  } else {
    score += 1;
  }

  if (item.personaName && /^[a-zA-Z]+\s[a-zA-Z]+/.test(item.personaName)) {
    score += 1.5;
  }

  return Number(score.toFixed(2));
}

function generateInsightsHtml(items) {
  const candidates = items
    .map((item) => ({
      ...item,
      score: scoreInventoryCandidate(item)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const rows = candidates.length
    ? candidates.map((item) => {
      const ageLabel = item.timeCreated
        ? `${Math.floor((Date.now() - item.timeCreated * 1000) / (365 * 24 * 60 * 60 * 1000))} anos`
        : 'N/D';
      const lastSeenLabel = item.lastLogOff
        ? new Date(item.lastLogOff * 1000).toLocaleString('pt-BR')
        : 'Sem registro';
      const nameLabel = escapeHtml(item.personaName || item.realName || 'Perfil Steam');
      const identityLabel = escapeHtml(item.realIdentity || 'N/A');
      const valueLabel = `R$ ${Number(item.totalValueBRL || 0).toFixed(2).replace('.', ',')}`;

      return `
        <tr>
          <td>
            <div class="profile">${nameLabel}</div>
            <small>${identityLabel}</small>
          </td>
          <td>${valueLabel}</td>
          <td>${ageLabel}</td>
          <td>${lastSeenLabel}</td>
          <td>${item.score.toFixed(2)}</td>
          <td><a class="profile-link" href="https://steamcommunity.com/profiles/${item.steamId}" target="_blank" rel="noopener noreferrer">Abrir</a></td>
        </tr>
      `;
    }).join('')
    : '<tr><td colspan="6" class="empty-state">Nenhum inventário disponível para análise preditiva.</td></tr>';

  return `<!DOCTYPE html>
  <html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <title>Art Cases — Radar Inteligente</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: 'Inter', 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
      }
      body {
        margin: 0;
        padding: 40px 24px;
        background: radial-gradient(circle at top, #05172d 0%, #03070e 60%, #01030a 100%);
        color: #f1f4ff;
      }
      .report-shell {
        max-width: 1050px;
        margin: 0 auto;
        background: rgba(8, 14, 28, 0.9);
        border: 1px solid rgba(120, 149, 255, 0.18);
        border-radius: 22px;
        padding: 36px;
        box-shadow: 0 30px 90px rgba(0, 0, 0, 0.55);
      }
      h1 {
        margin: 0;
        font-size: 2.2rem;
        letter-spacing: 0.05em;
      }
      p.lead {
        margin: 10px 0 28px;
        color: #8aa2ff;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        overflow: hidden;
        border-radius: 18px;
        border: 1px solid rgba(255, 255, 255, 0.08);
      }
      thead {
        background: linear-gradient(135deg, rgba(73, 125, 255, 0.45), rgba(30, 213, 169, 0.22));
      }
      th, td {
        padding: 16px;
        text-align: left;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        font-size: 0.95rem;
      }
      th {
        text-transform: uppercase;
        font-size: 0.72rem;
        letter-spacing: 0.14em;
        color: #d7e0ff;
      }
      tr:last-child td {
        border-bottom: none;
      }
      tbody tr:hover {
        background: rgba(73, 125, 255, 0.08);
      }
      .profile {
        font-weight: 600;
        margin-bottom: 4px;
      }
      small {
        color: #9aa6d6;
        font-size: 0.75rem;
      }
      .empty-state {
        text-align: center;
        padding: 32px;
        color: #a6a9c9;
      }
    </style>
  </head>
  <body>
    <div class="report-shell">
      <h1>Radar Inteligente Art Cases</h1>
      <p class="lead">Contas priorizadas com base em valor, idade, identidade provável e atividade recente.</p>
      <table>
        <thead>
          <tr>
            <th>Perfil</th>
            <th>Inventário</th>
            <th>Idade</th>
            <th>Último login</th>
            <th>Score IA</th>
            <th>Ação</th>
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

async function processInventoryJob(jobId, steamIdsInput) {
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }
  job.status = 'processing';

  const trimmedIds = steamIdsInput.map((id) => id.trim()).filter(Boolean);
  const uniqueIds = [...new Set(trimmedIds)];

  appendLog(jobId, `Processando ${uniqueIds.length} Steam ID(s).`);
  if (trimmedIds.length !== uniqueIds.length) {
    appendLog(jobId, `${trimmedIds.length - uniqueIds.length} ID(s) duplicadas foram ignoradas.`, 'warn');
  }

  const history = await loadHistory();

  const steamLookups = [];
  const conversionRate = await getUsdToBrlRate(jobId);

  for (const steamId of uniqueIds) {
    appendLog(jobId, 'Iniciando validação sequencial do perfil…', 'info', steamId);
    const steamInfo = await fetchSteamProfileAndBans(jobId, steamId);
    if (steamInfo.status === 'ready') {
      steamInfo.conversionRate = conversionRate;
      await fetchMontugaInventory(jobId, steamInfo);
    }
    steamLookups.push(steamInfo);

    broadcast(job, 'progress', { processedId: steamId });
  }

  const cleanProfiles = steamLookups.filter((item) => item.status === 'success' || item.status === 'montuga_error');
  const vacBannedCount = steamLookups.filter((item) => item.status === 'vac_banned').length;

  const successfulInventories = steamLookups
    .filter((item) => item.status === 'success')
    .map((item) => ({
      steamId: item.id,
      realName: item.name,
      totalValueBRL: item.totalValueBRL,
      casesPercentage: item.casesPercentage,
      vacBanned: item.vacBanned,
      gameBans: item.gameBans,
      date: item.processedAtLabel || currentDateTimeLabel(),
      personaName: item.personaName,
      timeCreated: item.timeCreated,
      lastLogOff: item.lastLogOff,
      realIdentity: item.realName,
      conversionRate: item.conversionRate
    }));

  successfulInventories.sort((a, b) => b.totalValueBRL - a.totalValueBRL);

  const montugaErrors = steamLookups.filter((item) => item.status === 'montuga_error').length;
  const steamErrors = steamLookups.filter((item) => item.status === 'steam_error').length;

  await saveJobResultsToHistory(history, steamLookups);
  appendLog(jobId, `Histórico atualizado com ${steamLookups.length} registro(s).`, 'info');

  const successCount = successfulInventories.length;
  appendLog(jobId, `Processamento concluído com ${successCount} inventário(s) avaliados.`, 'success');

  const generatedAt = currentDateTimeLabel();
  const reportHtml = generateReportHtml(successfulInventories, {
    title: 'Art Cases — Relatório de Inventário',
    subtitle: `Execução finalizada em ${generatedAt}`,
    metrics: [
      { label: 'IDs analisadas', value: uniqueIds.length },
      { label: 'Inventários avaliados', value: successCount },
      { label: 'VAC ban bloqueados', value: vacBannedCount },
      { label: 'Falhas de API', value: steamErrors + montugaErrors },
      { label: 'Cotação utilizada', value: `R$ ${conversionRate.toFixed(2)}` }
    ]
  });

  const analysisHtml = generateInsightsHtml(successfulInventories);

  finalizeJob(jobId, {
    reportHtml,
    analysisHtml,
    successCount,
    totals: {
      requested: uniqueIds.length,
      clean: cleanProfiles.length,
      vacBanned: vacBannedCount,
      steamErrors,
      montugaErrors
    },
    conversionRate
  });
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

  const job = createJob();
  res.json({ jobId: job.id });

  processInventoryJob(job.id, trimmed).catch((error) => {
    console.error(`[JOB ${job.id}] Erro inesperado:`, error);
    failJob(job.id, 'Erro inesperado no processamento. Consulte os logs do servidor.');
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
