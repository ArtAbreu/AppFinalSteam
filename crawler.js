// crawler.js — crawler recursivo de amigos Steam com dois workers (Explorer + Evaluator).
// Estado persistido em DATA_DIR/crawler_state.json. Resume automaticamente no boot se estava rodando.
// Expõe uma factory `createCrawler(deps)` para receber as funções do server.js (evita import circular).

import fs from 'fs/promises';
import path from 'path';

const CRAWLER_LOG_MAX = 500;
const CRAWLER_SAVE_INTERVAL_MS = 15_000;
const EVALUATOR_BATCH_SIZE = 100;
const EXPLORER_IDLE_SLEEP_MS = 2_000;
const EVALUATOR_IDLE_SLEEP_MS = 3_000;
const DEFAULT_LIMIT = 200_000;
const MAX_LIMIT = 1_000_000;
const MIN_LIMIT = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

export function createCrawler({
  dataDir,
  sanitizeSteamId,
  fetchFriendsForSteamId,
  fetchProfilesBatch,
  fetchMontugaInventory,
  markSteamIdProcessed,
  loadProcessedSteamIdSet,
  getValueRange,
  onComplete = null,
  logger = console,
}) {
  const stateFile = path.join(dataDir, 'crawler_state.json');

  const state = {
    running: false,
    seed: null,
    limit: DEFAULT_LIMIT,
    startedAt: null,
    stoppedAt: null,
    exploreQueue: [],
    evaluateQueue: [],
    visitedExplored: new Set(),
    visitedEvaluated: new Set(),
    knownProcessed: new Set(),
    // knownUniverse = união de IDs NOVOS que entraram no crawl atual (fila + visitadas).
    // Cap do crescimento: quando atinge state.limit, enqueueId para de aceitar IDs novos.
    knownUniverse: new Set(),
    // knownExploreOnly = IDs já processados em runs anteriores que agora entraram APENAS na fila
    // de exploração (pra pegar amigos-de-amigos novos). Não contam no universo nem na Montuga.
    knownExploreOnly: new Set(),
    stats: {
      explored: 0,
      evaluated: 0,
      approved: 0,
      outOfRange: 0,
      wrongCountry: 0,
      privateProfiles: 0,
      online: 0,
      banned: 0,
      errors: 0,
      rateLimit429: 0,
      approvedValueBRL: 0,
    },
    approvedProfiles: [],
    logs: [],
    sseClients: new Set(),
    workers: { explorer: false, evaluator: false },
  };

  let saveTimer = null;
  let saveInFlight = Promise.resolve();

  function log(msg, type = 'info') {
    const entry = { ts: Date.now(), msg, type };
    state.logs.push(entry);
    if (state.logs.length > CRAWLER_LOG_MAX) state.logs.shift();
    broadcast('log', entry);
    const consoleMsg = `[CRAWLER][${type}] ${msg}`;
    if (type === 'error') logger.error(consoleMsg);
    else if (type === 'warn') logger.warn(consoleMsg);
    else logger.log(consoleMsg);
  }

  function broadcast(event, payload) {
    const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of state.sseClients) {
      try {
        client.write(data);
      } catch (_) {
        state.sseClients.delete(client);
      }
    }
  }

  function buildProgress() {
    return {
      running: state.running,
      seed: state.seed,
      limit: state.limit,
      universeSize: state.knownUniverse.size,
      universeFull: state.knownUniverse.size >= state.limit,
      startedAt: state.startedAt,
      stoppedAt: state.stoppedAt,
      exploreQueueSize: state.exploreQueue.length,
      evaluateQueueSize: state.evaluateQueue.length,
      visitedExplored: state.visitedExplored.size,
      visitedEvaluated: state.visitedEvaluated.size,
      stats: { ...state.stats },
      workers: { ...state.workers },
    };
  }

  async function persist() {
    const snapshot = {
      version: 1,
      seed: state.seed,
      limit: state.limit,
      running: state.running,
      startedAt: state.startedAt,
      stoppedAt: state.stoppedAt,
      exploreQueue: state.exploreQueue,
      evaluateQueue: state.evaluateQueue,
      visitedExplored: Array.from(state.visitedExplored),
      visitedEvaluated: Array.from(state.visitedEvaluated),
      stats: state.stats,
      approvedProfiles: state.approvedProfiles.slice(-5000),
      savedAt: nowIso(),
    };
    const tmp = stateFile + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(snapshot), 'utf-8');
    await fs.rename(tmp, stateFile);
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveInFlight = saveInFlight.then(() => persist()).catch((e) => log(`Falha ao salvar estado: ${e.message}`, 'warn'));
    }, CRAWLER_SAVE_INTERVAL_MS);
  }

  async function hydrate() {
    try {
      const raw = await fs.readFile(stateFile, 'utf-8');
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== 'object') return;
      state.seed = saved.seed || null;
      state.limit = Number.isFinite(saved.limit) ? saved.limit : DEFAULT_LIMIT;
      state.startedAt = saved.startedAt || null;
      state.stoppedAt = saved.stoppedAt || null;
      state.exploreQueue = Array.isArray(saved.exploreQueue) ? saved.exploreQueue : [];
      state.evaluateQueue = Array.isArray(saved.evaluateQueue) ? saved.evaluateQueue : [];
      state.visitedExplored = new Set(Array.isArray(saved.visitedExplored) ? saved.visitedExplored : []);
      state.visitedEvaluated = new Set(Array.isArray(saved.visitedEvaluated) ? saved.visitedEvaluated : []);
      state.stats = { ...state.stats, ...(saved.stats || {}) };
      state.approvedProfiles = Array.isArray(saved.approvedProfiles) ? saved.approvedProfiles.slice(-5000) : [];
      try {
        state.knownProcessed = await loadProcessedSteamIdSet();
      } catch (_) {
        state.knownProcessed = new Set();
      }
      // Reclassifica cada ID conhecido: os já-processados vão pra knownExploreOnly (não contam
      // no universo nem viram Montuga); os novos pra knownUniverse (contam no limite).
      state.knownUniverse = new Set();
      state.knownExploreOnly = new Set();
      const classify = (id) => {
        if (state.knownProcessed.has(id)) state.knownExploreOnly.add(id);
        else state.knownUniverse.add(id);
      };
      for (const id of state.exploreQueue) classify(id);
      for (const id of state.evaluateQueue) classify(id);
      for (const id of state.visitedExplored) classify(id);
      for (const id of state.visitedEvaluated) classify(id);
      log(`Estado hidratado: fila explore=${state.exploreQueue.length}, evaluate=${state.evaluateQueue.length}, visitadas=${state.visitedExplored.size}+${state.visitedEvaluated.size}, histórico=${state.knownProcessed.size}.`, 'info');
      if (saved.running && state.seed) {
        log('Crawler estava rodando antes do restart — retomando automaticamente.', 'warn');
        await start({ seed: state.seed, limit: state.limit, resuming: true });
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        log(`Falha ao hidratar estado: ${e.message}`, 'warn');
      }
    }
  }

  function enqueueId(id) {
    if (!id) return false;
    if (state.knownUniverse.has(id)) return false;   // já está na fila nova ou foi visitado

    // Já processado numa run anterior: enfileira SÓ pra exploração (pegar amigos novos),
    // sem Montuga e sem contar no limite do universo — assim o grafo rompe o muro do histórico.
    if (state.knownProcessed.has(id)) {
      if (state.knownExploreOnly.has(id)) return false;
      if (state.visitedExplored.has(id)) return false;
      state.knownExploreOnly.add(id);
      state.exploreQueue.push(id);
      return true;
    }

    if (state.knownUniverse.size >= state.limit) return false; // universo cheio — não aceita novos
    state.knownUniverse.add(id);
    state.exploreQueue.push(id);
    state.evaluateQueue.push(id);
    return true;
  }

  function universeFull() {
    return state.knownUniverse.size >= state.limit;
  }

  async function explorerLoop() {
    state.workers.explorer = true;
    log('Explorer iniciado.', 'info');
    try {
      while (state.running) {
        // Universo cheio: parar imediatamente — qualquer amigo novo seria rejeitado por enqueueId,
        // então continuar consultando friend lists é desperdício de chamada na Steam.
        if (universeFull()) {
          log(`Explorer: universo cheio (${state.knownUniverse.size}/${state.limit}). Encerrando.`, 'info');
          break;
        }
        const id = state.exploreQueue.shift();
        if (!id) {
          await sleep(EXPLORER_IDLE_SLEEP_MS);
          continue;
        }
        if (state.visitedExplored.has(id)) continue;
        state.visitedExplored.add(id);
        try {
          const { friends } = await fetchFriendsForSteamId(id);
          let added = 0;
          for (const fid of friends) {
            const sanitized = sanitizeSteamId(fid);
            if (sanitized && enqueueId(sanitized)) added++;
          }
          state.stats.explored++;
          if (state.stats.explored <= 10 || state.stats.explored % 25 === 0) {
            log(`Explorer: ${state.stats.explored} perfis mapeados · último +${added}/${friends.length} amigos · fila explore=${state.exploreQueue.length} evaluate=${state.evaluateQueue.length}.`, 'info');
          }
        } catch (e) {
          state.stats.errors++;
        }
        broadcast('progress', buildProgress());
        scheduleSave();
      }
    } finally {
      state.workers.explorer = false;
      log('Explorer parado.', 'info');
      broadcast('progress', buildProgress());
      checkCompletion().catch((e) => log(`Falha no checkCompletion: ${e.message}`, 'warn'));
    }
  }

  async function evaluatorLoop() {
    state.workers.evaluator = true;
    log('Evaluator iniciado.', 'info');
    try {
      while (state.running) {
        const batch = [];
        while (batch.length < EVALUATOR_BATCH_SIZE && state.evaluateQueue.length > 0) {
          const id = state.evaluateQueue.shift();
          if (!id) break;
          if (state.visitedEvaluated.has(id)) continue;
          if (state.knownProcessed.has(id)) continue;
          state.visitedEvaluated.add(id);
          batch.push(id);
        }
        if (batch.length === 0) {
          // Fila vazia. Com universo cheio, nada novo entra na evaluateQueue (enqueueId rejeita),
          // então pode encerrar mesmo que o explorer ainda tenha fila (ele sai sozinho pelo mesmo motivo).
          if (universeFull()) {
            log(`Evaluator: universo cheio (${state.knownUniverse.size}/${state.limit}) e fila vazia. Encerrando.`, 'info');
            break;
          }
          await sleep(EVALUATOR_IDLE_SLEEP_MS);
          continue;
        }
        try {
          const infos = await fetchProfilesBatch('crawler', batch);
          const toInventory = [];
          for (const steamId of batch) {
            const info = infos.get(steamId);
            if (!info) {
              state.stats.errors++;
              log(`⚠️ ERRO · ${steamId} · perfil não retornado pela Steam`, 'warn');
              markSteamIdProcessed(steamId);
              state.knownProcessed.add(steamId);
              continue;
            }
            if (info.status === 'ready') {
              toInventory.push(info);
            } else {
              logRejection(info);
              state.stats.evaluated++;
              markSteamIdProcessed(steamId);
              state.knownProcessed.add(steamId);
            }
          }
          await Promise.all(toInventory.map(async (profile) => {
            await fetchMontugaInventory('crawler', profile);
            processInventoryResult(profile);
            state.stats.evaluated++;
            markSteamIdProcessed(profile.id);
            state.knownProcessed.add(profile.id);
          }));
        } catch (e) {
          log(`Evaluator: falha em lote de ${batch.length}: ${e.message}`, 'error');
          state.stats.errors += batch.length;
          for (const id of batch) {
            markSteamIdProcessed(id);
            state.knownProcessed.add(id);
          }
        }
        broadcast('progress', buildProgress());
        scheduleSave();
      }
    } finally {
      state.workers.evaluator = false;
      log('Evaluator parado.', 'info');
      broadcast('progress', buildProgress());
      checkCompletion().catch((e) => log(`Falha no checkCompletion: ${e.message}`, 'warn'));
    }
  }

  async function checkCompletion() {
    if (state.workers.explorer || state.workers.evaluator) return;
    if (state.completionHandled) return;
    state.completionHandled = true;
    const limitReached = state.knownUniverse.size >= state.limit && state.exploreQueue.length === 0 && state.evaluateQueue.length === 0;
    const reason = limitReached ? 'limite_atingido' : (state.running ? 'fila_esgotada' : 'parada_manual');
    state.running = false;
    state.stoppedAt = Date.now();
    log(`Crawler finalizado (${reason}). ${state.stats.approved} aprovadas, R$ ${state.stats.approvedValueBRL.toFixed(2)} em valor.`, 'success');
    await persist();
    broadcast('completed', { reason, stats: { ...state.stats }, approvedCount: state.approvedProfiles.length });
    if (onComplete) {
      try {
        await onComplete({ reason, approved: state.approvedProfiles.slice(), stats: { ...state.stats }, progress: buildProgress() });
      } catch (e) {
        log(`Falha no callback de conclusão: ${e.message}`, 'error');
      }
    }
  }

  function logRejection(info) {
    const label = info.name || info.id;
    switch (info.status) {
      case 'private_profile':
        state.stats.privateProfiles++;
        log(`🔒 PRIVADA · ${label}`, 'info');
        break;
      case 'online_profile':
        state.stats.online++;
        log(`🎮 ONLINE/JOGANDO · ${label}`, 'info');
        break;
      case 'vac_banned':
        state.stats.banned++;
        log(`🚫 BANIDA · ${label}`, 'info');
        break;
      case 'wrong_country':
        state.stats.wrongCountry++;
        log(`🌍 FORA DO BR · ${label}${info.country ? ' · ' + info.country : ''}`, 'info');
        break;
      default:
        state.stats.errors++;
        log(`⚠️ ERRO · ${label} · status desconhecido "${info.status}"`, 'warn');
    }
  }

  function processInventoryResult(profile) {
    const label = profile.name || profile.id;
    if (profile.status !== 'success') {
      state.stats.errors++;
      log(`⚠️ ERRO · ${label} · inventário indisponível (${profile.status || 'sem status'})`, 'warn');
      return;
    }
    const range = getValueRange();
    const total = Number(profile.totalValueBRL) || 0;
    if (total < range.min || total > range.max) {
      state.stats.outOfRange++;
      log(`💸 FORA DA FAIXA · ${label} · R$ ${total.toFixed(2)}`, 'info');
      return;
    }
    state.stats.approved++;
    state.stats.approvedValueBRL += total;
    const approvedEntry = {
      id: profile.id,
      name: profile.name,
      country: profile.country,
      totalValueBRL: total,
      steamLevel: profile.steamLevel,
      approvedAt: nowIso(),
    };
    state.approvedProfiles.push(approvedEntry);
    if (state.approvedProfiles.length > 5000) state.approvedProfiles.shift();
    broadcast('approved', approvedEntry);
    log(`✅ APROVADA · ${profile.name || profile.id} · R$ ${total.toFixed(2)}${profile.country ? ' · ' + profile.country : ''}`, 'success');
  }

  async function start({ seed, limit, resuming = false } = {}) {
    if (state.running) throw new Error('Crawler já está rodando.');
    const seedSanitized = sanitizeSteamId(seed);
    if (!seedSanitized) throw new Error('SteamID da semente inválida (precisa ter 17 dígitos).');

    const lim = Number(limit);
    state.limit = Math.max(MIN_LIMIT, Math.min(Number.isFinite(lim) && lim > 0 ? lim : DEFAULT_LIMIT, MAX_LIMIT));
    state.seed = seedSanitized;
    state.running = true;
    state.startedAt = state.startedAt || Date.now();
    state.stoppedAt = null;
    state.completionHandled = false;

    const freshStart = !resuming && (state.exploreQueue.length === 0 && state.evaluateQueue.length === 0);
    if (freshStart) {
      state.exploreQueue = [seedSanitized];
      state.evaluateQueue = [seedSanitized];
      state.knownUniverse.add(seedSanitized);
    } else if (!state.knownUniverse.has(seedSanitized)) {
      state.knownUniverse.add(seedSanitized);
    }
    try {
      state.knownProcessed = await loadProcessedSteamIdSet();
    } catch (_) { /* segue */ }

    log(`Crawler ${resuming ? 'retomado' : 'iniciado'} · semente ${seedSanitized} · limite ${state.limit}.`, 'info');
    explorerLoop().catch((e) => log(`Explorer crashou: ${e.message}`, 'error'));
    evaluatorLoop().catch((e) => log(`Evaluator crashou: ${e.message}`, 'error'));
    await persist();
    broadcast('progress', buildProgress());
    return buildProgress();
  }

  async function stop() {
    if (!state.running) return buildProgress();
    state.running = false;
    state.stoppedAt = Date.now();
    log('Crawler recebeu sinal de parada. Aguardando workers terminarem o trabalho atual…', 'warn');
    broadcast('progress', buildProgress());
    await sleep(500);
    await persist();
    return buildProgress();
  }

  async function reset() {
    if (state.running) throw new Error('Pare o crawler antes de resetar.');
    state.seed = null;
    state.exploreQueue = [];
    state.evaluateQueue = [];
    state.visitedExplored = new Set();
    state.visitedEvaluated = new Set();
    state.knownUniverse = new Set();
    state.knownExploreOnly = new Set();
    state.stats = {
      explored: 0, evaluated: 0, approved: 0, outOfRange: 0,
      wrongCountry: 0, privateProfiles: 0, online: 0, banned: 0,
      errors: 0, rateLimit429: 0, approvedValueBRL: 0,
    };
    state.approvedProfiles = [];
    state.startedAt = null;
    state.stoppedAt = null;
    await persist();
    log('Estado do crawler resetado.', 'warn');
    return buildProgress();
  }

  function subscribe(client) {
    state.sseClients.add(client);
    client.write(`event: progress\ndata: ${JSON.stringify(buildProgress())}\n\n`);
    for (const entry of state.logs.slice(-100)) {
      client.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
    }
  }

  function unsubscribe(client) {
    state.sseClients.delete(client);
  }

  function getLogs(limit = 200) {
    return state.logs.slice(-limit);
  }

  function getApprovedProfiles(limit = 500) {
    return state.approvedProfiles.slice(-limit).reverse();
  }

  function count429(delta = 1) {
    state.stats.rateLimit429 += delta;
  }

  return {
    hydrate,
    start,
    stop,
    reset,
    subscribe,
    unsubscribe,
    getProgress: buildProgress,
    getLogs,
    getApprovedProfiles,
    count429,
  };
}
