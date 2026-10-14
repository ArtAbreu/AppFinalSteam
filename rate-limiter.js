// Limitador de requisições adaptativo.
// - Limita quantas requisições rodam ao mesmo tempo (concurrency).
// - Garante um espaçamento mínimo entre o início de duas requisições (minIntervalMs).
// - Ao receber HTTP 429 (limite da API) ou 5xx, desacelera sozinho, espera e tenta de novo.
// - Depois de uma sequência de sucessos, volta a acelerar até o ritmo configurado.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseRetryAfter(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(date - Date.now(), 0);
  return null;
}

export function createRateLimiter({
  name,
  concurrency = 2,
  minIntervalMs = 250,
  maxIntervalMs = 10000,
  recoverAfter = 8,
}) {
  const baseInterval = Math.max(0, minIntervalMs);
  let interval = baseInterval;
  let active = 0;
  let nextSlotAt = 0;
  let blockedUntil = 0;
  let successStreak = 0;
  const waiting = [];

  function pump() {
    while (active < concurrency && waiting.length) {
      active += 1;
      const resolve = waiting.shift();
      resolve();
    }
  }

  async function acquire() {
    if (active >= concurrency) {
      await new Promise((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }
    // Reserva um "horário de saída" respeitando o espaçamento e eventuais bloqueios.
    const now = Date.now();
    const startAt = Math.max(now, nextSlotAt, blockedUntil);
    nextSlotAt = startAt + interval;
    if (startAt > now) {
      await sleep(startAt - now);
    }
  }

  function release() {
    active -= 1;
    pump();
  }

  function penalize(waitMs) {
    successStreak = 0;
    // Vários 429 chegando juntos contam como um só aperto no freio.
    if (Date.now() < blockedUntil) return;
    interval = Math.min(Math.max(Math.ceil(interval * 1.5), 200), maxIntervalMs);
    const pause = Math.max(waitMs ?? 0, interval);
    blockedUntil = Math.max(blockedUntil, Date.now() + pause);
    console.warn(`[RATE ${name}] Limite atingido. Pausando ${Math.round(pause / 1000)}s; novo intervalo ${interval}ms.`);
  }

  function reward() {
    successStreak += 1;
    if (successStreak >= recoverAfter && interval > baseInterval) {
      interval = Math.max(baseInterval, Math.floor(interval * 0.7));
      successStreak = 0;
    }
  }

  /**
   * fetch com limite de ritmo + novas tentativas.
   * Retorna a Response final (pode ser !ok se esgotar as tentativas ou for erro não recuperável).
   */
  async function fetchWithLimit(url, options = {}, { retries = 4, timeoutMs = 45000 } = {}) {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await acquire();
      let response;
      let networkError = null;
      try {
        response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        networkError = error;
      } finally {
        release();
      }

      const retryable = networkError || response.status === 429 || response.status >= 500;
      if (!retryable) {
        reward();
        return response;
      }

      if (attempt >= retries) {
        if (networkError) throw networkError;
        return response;
      }

      attempt += 1;
      if (response?.status === 429) {
        penalize(parseRetryAfter(response.headers.get('retry-after')) ?? 2000 * attempt);
      } else {
        // Erro de rede/servidor: espera crescente, sem derrubar o ritmo de todo mundo.
        await sleep(1000 * attempt);
      }
      // Descarta o corpo para liberar a conexão.
      try { await response?.body?.cancel(); } catch { /* ignora */ }
    }
  }

  return {
    name,
    fetch: fetchWithLimit,
    get concurrency() { return concurrency; },
  };
}
