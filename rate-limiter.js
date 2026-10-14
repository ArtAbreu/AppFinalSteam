// Limitador de requisições com ritmo FIXO.
// - No máximo `concurrency` consultas ao mesmo tempo e `minIntervalMs` entre o início de duas.
// - O ritmo nunca muda sozinho: quem calibra é você, pelas variáveis de ambiente.
// - Se a API responder 429 (limite), só a consulta afetada espera um pouco e tenta de novo,
//   para a conta não virar erro. Cada 429 é avisado (onRetry) para você ajustar o número.

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
}) {
  const limit = Math.max(1, Math.floor(concurrency));
  const interval = Math.max(0, minIntervalMs);
  let active = 0;
  let nextSlotAt = 0;
  const waiting = [];

  async function acquire() {
    if (active >= limit) {
      await new Promise((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }
    const now = Date.now();
    const startAt = Math.max(now, nextSlotAt);
    nextSlotAt = startAt + interval;
    if (startAt > now) await sleep(startAt - now);
  }

  function release() {
    if (waiting.length) {
      waiting.shift()(); // passa a vaga direto para quem está esperando
    } else {
      active -= 1;
    }
  }

  /**
   * fetch com ritmo fixo + novas tentativas.
   * 429: espera (Retry-After ou 2s, 4s, 8s… até 30s) e repete, até `rateLimitRetries` vezes.
   * Rede/5xx: até `retries` tentativas.
   * Retorna a Response final; `response.rateLimited = true` se esgotou por 429.
   */
  async function fetchWithLimit(url, options = {}, {
    retries = 3,
    rateLimitRetries = 8,
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
      if (!networkError && !is429 && response.status < 500) {
        return response;
      }

      let waitMs;
      if (is429) {
        rateAttempts += 1;
        if (rateAttempts > rateLimitRetries) {
          response.rateLimited = true;
          return response;
        }
        waitMs = parseRetryAfter(response.headers.get('retry-after'))
          ?? Math.min(2000 * 2 ** (rateAttempts - 1), 30000);
      } else {
        attempt += 1;
        if (attempt > retries) {
          if (networkError) throw networkError;
          return response;
        }
        waitMs = 1000 * attempt;
      }

      try {
        onRetry?.({
          attempt: is429 ? rateAttempts : attempt,
          status: response?.status ?? null,
          error: networkError?.message ?? null,
          waitMs,
        });
      } catch { /* ignora */ }
      try { await response?.body?.cancel(); } catch { /* ignora */ }
      await sleep(waitMs);
    }
  }

  return {
    name,
    fetch: fetchWithLimit,
    get concurrency() { return limit; },
  };
}
