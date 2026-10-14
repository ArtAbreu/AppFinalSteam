// Limitador de requisições adaptativo (estilo "freio ABS").
// - Limita quantas requisições rodam ao mesmo tempo e o espaço mínimo entre elas.
// - Ao receber HTTP 429 (limite da API): corta pela metade as consultas simultâneas,
//   dobra o intervalo e pausa tudo. Se o 429 continuar, a pausa cresce (2s, 4s, 8s… até 60s).
// - Depois de uma sequência de sucessos, volta a acelerar devagar até o ritmo configurado.
// - Um 429 nunca vira erro rapidamente: a consulta espera e tenta de novo várias vezes.

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
  maxIntervalMs = 15000,
  recoverAfter = 15,
  onThrottle = null,
}) {
  const maxConcurrency = Math.max(1, Math.floor(concurrency));
  const baseInterval = Math.max(0, minIntervalMs);
  let limit = maxConcurrency; // consultas simultâneas permitidas agora
  let interval = baseInterval; // espaço mínimo agora
  let active = 0;
  let nextSlotAt = 0;
  let blockedUntil = 0;
  let successStreak = 0;
  let consecutive429 = 0;
  const waiting = [];

  function pump() {
    while (active < limit && waiting.length) {
      active += 1;
      waiting.shift()();
    }
  }

  async function acquire() {
    if (active >= limit) {
      await new Promise((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }
    // Espera o próximo horário livre (espaçamento + pausas de 429). Rechecagem em loop,
    // porque uma pausa pode ter sido criada enquanto esta consulta esperava.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = Date.now();
      const startAt = Math.max(now, nextSlotAt, blockedUntil);
      if (startAt <= now) {
        nextSlotAt = now + interval;
        return;
      }
      await sleep(Math.min(startAt - now, 1000));
    }
  }

  function release() {
    active -= 1;
    pump();
  }

  function snapshot() {
    return { limit, maxConcurrency, interval, pauseMs: Math.max(blockedUntil - Date.now(), 0) };
  }

  function penalize(retryAfterMs) {
    successStreak = 0;
    const now = Date.now();
    // Vários 429 da mesma rajada contam como um só aperto no freio.
    if (now < blockedUntil) return;
    consecutive429 += 1;
    limit = Math.max(1, Math.floor(limit / 2));
    interval = Math.min(Math.max(interval * 2, 500), maxIntervalMs);
    const backoff = Math.min(2000 * 2 ** (consecutive429 - 1), 60000);
    const pause = Math.max(retryAfterMs ?? 0, backoff);
    blockedUntil = now + pause;
    const info = snapshot();
    console.warn(`[RATE ${name}] 429 → ${info.limit} simultânea(s), intervalo ${info.interval}ms, pausa ${Math.round(pause / 1000)}s.`);
    try { onThrottle?.({ type: 'slowdown', ...info }); } catch { /* ignora */ }
  }

  function reward() {
    consecutive429 = 0;
    successStreak += 1;
    if (successStreak < recoverAfter) return;
    successStreak = 0;
    if (interval > baseInterval) {
      interval = Math.max(baseInterval, Math.floor(interval * 0.8));
    } else if (limit < maxConcurrency) {
      limit += 1;
      pump();
    } else {
      return;
    }
    try { onThrottle?.({ type: 'speedup', ...snapshot() }); } catch { /* ignora */ }
  }

  /**
   * fetch com limite de ritmo + novas tentativas.
   * 429: até `rateLimitRetries` tentativas (com pausas crescentes).
   * Rede/5xx: até `retries` tentativas.
   * Retorna a Response final; `response.rateLimited = true` se esgotou por 429.
   */
  async function fetchWithLimit(url, options = {}, {
    retries = 3,
    rateLimitRetries = 12,
    timeoutMs = 45000,
    onRetry = null,
  } = {}) {
    let attempt = 0;
    let rateAttempts = 0;
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

      const is429 = response?.status === 429;
      const retryable = networkError || is429 || response.status >= 500;
      if (!retryable) {
        reward();
        return response;
      }

      if (is429) {
        rateAttempts += 1;
        penalize(parseRetryAfter(response.headers.get('retry-after')));
        if (rateAttempts > rateLimitRetries) {
          response.rateLimited = true;
          return response;
        }
      } else {
        attempt += 1;
        if (attempt > retries) {
          if (networkError) throw networkError;
          return response;
        }
        await sleep(1000 * attempt);
      }

      try {
        onRetry?.({ attempt: is429 ? rateAttempts : attempt, status: response?.status ?? null, error: networkError?.message ?? null });
      } catch { /* ignora */ }
      // Descarta o corpo para liberar a conexão.
      try { await response?.body?.cancel(); } catch { /* ignora */ }
    }
  }

  return {
    name,
    fetch: fetchWithLimit,
    get concurrency() { return maxConcurrency; },
    get state() { return snapshot(); },
  };
}
