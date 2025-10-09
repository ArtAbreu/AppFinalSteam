import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import './App.css';

const MAX_STEAM_IDS = 10000;
const MAX_HISTORY_ITEMS = 50;

function ensureIsoString(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const numericDate = new Date(value);
    if (!Number.isNaN(numericDate.getTime())) {
      return numericDate.toISOString();
    }
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return new Date().toISOString();
}

function buildHistoryEntryId(entry) {
  const jobSegment = typeof entry.jobId === 'string' && entry.jobId.trim()
    ? entry.jobId.trim()
    : 'job';
  const partialSegment = entry.partial ? 'partial' : 'final';
  const timestamp = ensureIsoString(entry.generatedAt);
  return `${jobSegment}-${partialSegment}-${timestamp}`;
}

function normalizeHistoryEntry(entry) {
  if (!entry) {
    return null;
  }

  const generatedAt = ensureIsoString(entry.generatedAt);
  const jobId = typeof entry.jobId === 'string' && entry.jobId.trim()
    ? entry.jobId.trim()
    : 'desconhecido';
  const partial = Boolean(entry.partial);
  const totals = entry && typeof entry.totals === 'object' && entry.totals !== null
    ? entry.totals
    : {};
  const successCount = Number.isFinite(entry.successCount)
    ? entry.successCount
    : Number(entry.successCount) || 0;
  const reportHtml = typeof entry.reportHtml === 'string' ? entry.reportHtml : '';
  const shareLink = typeof entry.shareLink === 'string' && entry.shareLink.trim()
    ? entry.shareLink.trim()
    : null;

  const id = typeof entry.id === 'string' && entry.id.trim()
    ? entry.id.trim()
    : buildHistoryEntryId({ jobId, generatedAt, partial });

  return {
    id,
    jobId,
    generatedAt,
    partial,
    totals,
    successCount,
    reportHtml,
    shareLink,
  };
}

function sortHistoryEntries(entries = []) {
  return [...entries].sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt));
}

const HISTORY_FALLBACK_DOC = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8" /><style>body{margin:0;padding:16px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#ffffff;color:#0f172a;font-size:16px;line-height:1.5;}</style></head><body><p>HTML disponível apenas para download. Utilize o botão acima.</p></body></html>`;

function sanitizeSteamId(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const digits = String(value).trim().replace(/[^0-9]/g, '');
  if (!/^\d{17}$/.test(digits)) {
    return null;
  }
  return digits;
}

function extractUniqueSteamIds(value) {
  const unique = new Set();
  for (const chunk of String(value ?? '').split(/\s+/)) {
    const sanitized = sanitizeSteamId(chunk);
    if (sanitized) {
      unique.add(sanitized);
    }
  }
  return Array.from(unique);
}

function App() {
  const [steamIds, setSteamIds] = useState('');
  const [logs, setLogs] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [jobResult, setJobResult] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [statusBanner, setStatusBanner] = useState(null);
  const [processedProfiles, setProcessedProfiles] = useState([]);
  const [currentJobId, setCurrentJobId] = useState(null);
  const [isPaused, setIsPaused] = useState(false);
  const [historyEntries, setHistoryEntries] = useState([]);
  const [activeHistoryId, setActiveHistoryId] = useState(null);
  const [isFetchingHistory, setIsFetchingHistory] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [historyBanner, setHistoryBanner] = useState(null);
  const [webhookUrl, setWebhookUrl] = useState(() => {
    if (typeof window === 'undefined') {
      return '';
    }
    return window.localStorage.getItem('aci-webhook-url') || '';
  });
  const [activeShareLink, setActiveShareLink] = useState(() => {
    if (typeof window === 'undefined') {
      return null;
    }
    const params = new URLSearchParams(window.location.search);
    const jobParam = params.get('job');
    if (jobParam) {
      return `${window.location.origin}${window.location.pathname}?job=${jobParam}`;
    }
    try {
      const storedLink = window.localStorage.getItem('aci-share-link');
      if (storedLink) {
        return storedLink;
      }
      const stored = window.localStorage.getItem('aci-active-job-id');
      if (stored) {
        return `${window.location.origin}${window.location.pathname}?job=${stored}`;
      }
    } catch (error) {
      console.warn('Não foi possível recuperar o link de acompanhamento salvo.', error);
    }
    return null;
  });
  const [activeTab, setActiveTab] = useState('analysis');
  const [friendsInput, setFriendsInput] = useState('');
  const [friendsResults, setFriendsResults] = useState([]);
  const [friendsError, setFriendsError] = useState(null);
  const [friendsStatus, setFriendsStatus] = useState(null);
  const [isFetchingFriends, setIsFetchingFriends] = useState(false);
  const hydrationAttemptedRef = useRef(false);
  const sharedJobCandidateRef = useRef(null);
  const [isHydratingJob, setIsHydratingJob] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      if (activeShareLink) {
        window.localStorage.setItem('aci-share-link', activeShareLink);
      } else {
        window.localStorage.removeItem('aci-share-link');
      }
    } catch (error) {
      console.warn('Não foi possível persistir o link compartilhado.', error);
    }
  }, [activeShareLink]);

  useEffect(() => {
    if (historyEntries.length === 0) {
      setActiveHistoryId(null);
      return;
    }
    if (!activeHistoryId || !historyEntries.some((entry) => entry.id === activeHistoryId)) {
      setActiveHistoryId(historyEntries[0].id);
    }
  }, [historyEntries, activeHistoryId]);

  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return window.localStorage.getItem('aci-auth') === 'true';
  });
  const [passwordInput, setPasswordInput] = useState('');
  const [authError, setAuthError] = useState(null);

  const logContainerRef = useRef(null);
  const eventSourceRef = useRef(null);
  const finishedRef = useRef(false);
  const pendingIdsRef = useRef([]);

  const formattedMaxSteamIds = useMemo(() => MAX_STEAM_IDS.toLocaleString('pt-BR'), []);
  const limitErrorMessage = useMemo(
    () => `Limite máximo de ${formattedMaxSteamIds} Steam IDs por processamento. Reduza a lista e tente novamente.`,
    [formattedMaxSteamIds],
  );

  const steamIdMetrics = useMemo(() => {
    const sanitized = extractUniqueSteamIds(steamIds);
    return {
      sanitized,
      count: sanitized.length,
      limitExceeded: sanitized.length > MAX_STEAM_IDS,
    };
  }, [steamIds]);

  const sanitizedSteamIds = steamIdMetrics.sanitized;
  const steamIdCount = steamIdMetrics.count;
  const steamIdLimitExceeded = steamIdMetrics.limitExceeded;

  useEffect(() => {
    if (!steamIdLimitExceeded && errorMessage === limitErrorMessage) {
      setErrorMessage(null);
    }
  }, [steamIdLimitExceeded, errorMessage, limitErrorMessage]);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const updateJobReference = useCallback((jobId) => {
    if (typeof window === 'undefined') {
      return null;
    }

    const url = new URL(window.location.href);
    const base = `${url.origin}${url.pathname}`;

    if (jobId) {
      url.searchParams.set('job', jobId);
      window.history.replaceState({}, '', url.toString());
      try {
        window.localStorage.setItem('aci-active-job-id', jobId);
      } catch (error) {
        console.warn('Não foi possível persistir o job ativo localmente.', error);
      }
      return `${base}?job=${jobId}`;
    }

    url.searchParams.delete('job');
    window.history.replaceState({}, '', url.toString());
    try {
      window.localStorage.removeItem('aci-active-job-id');
    } catch (error) {
      console.warn('Não foi possível limpar o job ativo armazenado.', error);
    }
    return null;
  }, []);

  useEffect(() => () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const trimmed = webhookUrl.trim();
    if (trimmed) {
      window.localStorage.setItem('aci-webhook-url', trimmed);
    } else {
      window.localStorage.removeItem('aci-webhook-url');
    }
  }, [webhookUrl]);

  const closeEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    finishedRef.current = true;
  }, []);

  const resetInterface = useCallback(() => {
    closeEventSource();
    setSteamIds('');
    setLogs([]);
    setJobResult(null);
    setErrorMessage(null);
    setStatusBanner(null);
    setIsProcessing(false);
    setProcessedProfiles([]);
    setCurrentJobId(null);
    setIsPaused(false);
    pendingIdsRef.current = [];
    hydrationAttemptedRef.current = false;
    sharedJobCandidateRef.current = null;
    setActiveShareLink(null);
    updateJobReference(null);
  }, [closeEventSource, updateJobReference]);

  const resetFriendsInterface = useCallback(() => {
    setFriendsInput('');
    setFriendsResults([]);
    setFriendsError(null);
    setFriendsStatus(null);
  }, []);

  const handleFriendsSubmit = useCallback(async (event) => {
    event.preventDefault();
    setFriendsError(null);
    setFriendsStatus(null);

    const ids = friendsInput
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    if (ids.length === 0) {
      setFriendsError('Informe pelo menos uma SteamID64.');
      setFriendsResults([]);
      return;
    }

    setIsFetchingFriends(true);
    try {
      const response = await fetch('/friends/list', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ steamIds: ids }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Não foi possível consultar as listas de amigos.');
      }
      const payload = Array.isArray(data.results) ? data.results : [];
      setFriendsResults(payload);
      const hasSuccessfulLookup = payload.some((entry) => !entry?.error && Array.isArray(entry?.friends));
      setFriendsStatus(
        hasSuccessfulLookup
          ? 'Listas de amigos carregadas com sucesso.'
          : 'Não foi possível recuperar amigos para os IDs informados.',
      );
    } catch (error) {
      setFriendsResults([]);
      setFriendsError(error.message || 'Falha ao consultar as listas de amigos.');
    } finally {
      setIsFetchingFriends(false);
    }
  }, [friendsInput]);

  const handleDownloadFriends = useCallback(() => {
    if (friendsResults.length === 0) {
      return;
    }

    const sections = friendsResults.map((result) => {
      if (result?.error) {
        return `❌ Erro ao buscar amigos do Steam ID ${result.steamId}: ${result.error}`;
      }
      const friends = Array.isArray(result?.friends) && result.friends.length > 0
        ? result.friends.join('\n')
        : 'Nenhum amigo encontrado.';
      return `🧑‍🤝‍🧑 Amigos do Steam ID ${result.steamId}:\n${friends}`;
    });

    const blob = new Blob([`${sections.join('\n\n')}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `friends_list_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, [friendsResults]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    if (isAuthenticated) {
      window.localStorage.setItem('aci-auth', 'true');
    } else {
      window.localStorage.removeItem('aci-auth');
      resetInterface();
    }
  }, [isAuthenticated, resetInterface]);

  const handleAuthenticate = useCallback((event) => {
    event.preventDefault();
    if (passwordInput.trim() === 'Artzin017') {
      setIsAuthenticated(true);
      setPasswordInput('');
      setAuthError(null);
      return;
    }
    setAuthError('Senha incorreta. Tente novamente.');
  }, [passwordInput]);

  const fetchHistoryFromServer = useCallback(async () => {
    setIsFetchingHistory(true);
    try {
      const response = await fetch('/history');
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || 'Não foi possível carregar o histórico recente.');
      }

      const entries = Array.isArray(payload?.entries)
        ? sortHistoryEntries(payload.entries.map((item) => normalizeHistoryEntry(item)).filter(Boolean))
        : [];

      setHistoryEntries(entries.slice(0, MAX_HISTORY_ITEMS));
      setHistoryError(null);
    } catch (error) {
      setHistoryError(error.message || 'Falha ao carregar histórico das últimas 24 horas.');
    } finally {
      setIsFetchingHistory(false);
    }
  }, []);

  const registerHistoryEntry = useCallback((entry) => {
    const normalized = normalizeHistoryEntry(entry);
    if (!normalized) {
      return;
    }

    setHistoryEntries((previous) => {
      const filtered = previous.filter((item) => item.id !== normalized.id);
      const sorted = sortHistoryEntries([normalized, ...filtered]);
      return sorted.slice(0, MAX_HISTORY_ITEMS);
    });
    setActiveHistoryId(normalized.id);
    setHistoryError(null);
  }, []);

  useEffect(() => {
    fetchHistoryFromServer();
  }, [fetchHistoryFromServer]);

  const subscribeToJob = useCallback((jobId, options = {}) => {
    const { initialPaused = false, shareLink: shareLinkOverride = null } = options;
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    finishedRef.current = false;
    const eventSource = new EventSource(`/process/${jobId}/stream`);
    eventSourceRef.current = eventSource;
    setCurrentJobId(jobId);
    setIsPaused(initialPaused);
    const link = updateJobReference(jobId);
    setActiveShareLink(shareLinkOverride || link);

    eventSource.addEventListener('log', (event) => {
      try {
        const entry = JSON.parse(event.data);
        setLogs((previous) => [...previous, entry]);
      } catch (error) {
        console.warn('Não foi possível interpretar uma entrada de log SSE.', error);
      }
    });

    eventSource.addEventListener('profile-processed', (event) => {
      try {
        const payload = JSON.parse(event.data);
        setProcessedProfiles((previous) => {
          const filtered = previous.filter((item) => item.id !== payload.id);
          return [{ ...payload }, ...filtered].slice(0, 200);
        });

        pendingIdsRef.current = pendingIdsRef.current.filter((id) => id !== payload.id);
        setSteamIds(pendingIdsRef.current.join('\n'));
      } catch (error) {
        console.warn('Não foi possível interpretar a notificação de perfil processado.', error);
      }
    });

    eventSource.addEventListener('job-paused', () => {
      setIsPaused(true);
      setIsProcessing(false);
      setStatusBanner({ type: 'info', message: 'Processamento pausado. Gere um relatório parcial ou retome quando desejar.' });
    });

    eventSource.addEventListener('job-resumed', () => {
      setIsPaused(false);
      setIsProcessing(true);
      setStatusBanner({ type: 'success', message: 'Processamento retomado com sucesso.' });
    });

    eventSource.addEventListener('complete', (event) => {
      finishedRef.current = true;
      let parsedPayload = null;
      try {
        parsedPayload = JSON.parse(event.data);
        const enriched = { ...parsedPayload, jobId, partial: false };
        setJobResult(enriched);
        registerHistoryEntry(enriched);
        fetchHistoryFromServer();
        setErrorMessage(null);
      } catch (error) {
        setErrorMessage('Processamento concluído, mas não foi possível ler o relatório.');
      }
      setIsProcessing(false);
      setIsPaused(false);
      setCurrentJobId(null);
      pendingIdsRef.current = [];
      const clearedLink = updateJobReference(null);
      setActiveShareLink((previous) => {
        if (parsedPayload?.shareLink) {
          return parsedPayload.shareLink;
        }
        return previous || clearedLink;
      });
      eventSource.close();
      eventSourceRef.current = null;
    });

    eventSource.addEventListener('job-error', (event) => {
      finishedRef.current = true;
      let parsedError = null;
      try {
        parsedError = JSON.parse(event.data);
        setErrorMessage(parsedError.error || 'Falha ao processar as IDs informadas.');
      } catch (error) {
        setErrorMessage('Erro durante o processamento das IDs.');
      }
      setIsProcessing(false);
      setIsPaused(false);
      setCurrentJobId(null);
      pendingIdsRef.current = [];
      const clearedLink = updateJobReference(null);
      setActiveShareLink((previous) => {
        if (parsedError?.shareLink) {
          return parsedError.shareLink;
        }
        return previous || clearedLink;
      });
      eventSource.close();
      eventSourceRef.current = null;
    });

    eventSource.addEventListener('end', () => {
      finishedRef.current = true;
    });

    eventSource.onerror = async () => {
      if (finishedRef.current) {
        return;
      }
      eventSource.close();
      eventSourceRef.current = null;

      try {
        const fallbackResponse = await fetch(`/process/${jobId}/result`);
        if (fallbackResponse.ok) {
          const payload = await fallbackResponse.json();
          if (payload.logs) {
            setLogs(payload.logs);
          }
          if (payload.reportHtml) {
            const enriched = payload.jobId ? payload : { ...payload, jobId };
            setJobResult(enriched);
            registerHistoryEntry(enriched);
            fetchHistoryFromServer();
            setErrorMessage(null);
          } else if (payload.error) {
            setErrorMessage(payload.error);
          }
          if (payload.shareLink) {
            setActiveShareLink((previous) => payload.shareLink || previous);
          }
        } else if (fallbackResponse.status !== 202) {
          const payload = await fallbackResponse.json().catch(() => ({}));
          setErrorMessage(payload.error || 'Conexão com o servidor perdida durante o processamento.');
        }
      } catch (error) {
        setErrorMessage('Não foi possível restabelecer a conexão com o servidor.');
      } finally {
        setIsProcessing(false);
        setIsPaused(false);
        setCurrentJobId(null);
        finishedRef.current = true;
        const clearedLink = updateJobReference(null);
        setActiveShareLink((previous) => previous || clearedLink);
      }
    };
  }, [fetchHistoryFromServer, registerHistoryEntry, updateJobReference]);

  const hydrateJobFromServer = useCallback(async (jobId) => {
    setIsHydratingJob(true);
    try {
      const response = await fetch(`/process/${jobId}/inspect`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Não foi possível carregar o job compartilhado.');
      }

      finishedRef.current = data.status === 'complete' || data.status === 'error';

      const pending = Array.isArray(data.pendingIds) ? data.pendingIds : [];
      pendingIdsRef.current = pending;
      setSteamIds(pending.join('\n'));

      const logsPayload = Array.isArray(data.logs) ? data.logs : [];
      setLogs(logsPayload);

      const processedPayload = Array.isArray(data.results) ? [...data.results].reverse().slice(0, 200) : [];
      setProcessedProfiles(processedPayload);

      if (data.reportHtml) {
        const payload = {
          jobId,
          reportHtml: data.reportHtml,
          totals: data.totals,
          successCount: data.successCount,
          generatedAt: data.generatedAt || new Date().toISOString(),
          partial: data.partial,
        };
        setJobResult(payload);
        registerHistoryEntry(payload);
        fetchHistoryFromServer();
      } else {
        setJobResult(null);
      }

      if (data.status === 'error') {
        setErrorMessage(data.error || 'O processamento foi encerrado com erro.');
      } else {
        setErrorMessage(null);
      }

      if (data.status === 'processing' || data.status === 'paused') {
        setIsProcessing(data.status === 'processing');
        setIsPaused(data.status === 'paused');
        setCurrentJobId(jobId);
        const link = updateJobReference(jobId);
        const remoteLink = typeof data.shareLink === 'string' && data.shareLink.trim() ? data.shareLink : null;
        setActiveShareLink(remoteLink || link);
        setStatusBanner({
          type: 'info',
          message: data.status === 'processing'
            ? 'Conectado a uma análise em andamento em outro dispositivo.'
            : 'Conectado a um job pausado. Você pode retomar quando quiser.',
        });
        subscribeToJob(jobId, { initialPaused: data.status === 'paused', shareLink: remoteLink || link });
      } else {
        setIsProcessing(false);
        setIsPaused(false);
        setCurrentJobId(null);
        if (data.shareLink) {
          setActiveShareLink((previous) => data.shareLink || previous);
        }
        const clearedLink = updateJobReference(null);
        setActiveShareLink((previous) => previous || clearedLink);
        if (data.status === 'complete') {
          setStatusBanner({ type: 'success', message: 'Relatório concluído recuperado do servidor.' });
        } else if (data.status === 'error') {
          setStatusBanner({ type: 'error', message: data.error || 'O processamento foi encerrado com erro.' });
        } else {
          setStatusBanner({ type: 'info', message: 'Estado atual sincronizado com o servidor.' });
        }
      }
    } finally {
      setIsHydratingJob(false);
    }
  }, [fetchHistoryFromServer, registerHistoryEntry, subscribeToJob, updateJobReference]);

  useEffect(() => {
    if (!isAuthenticated || hydrationAttemptedRef.current) {
      return;
    }
    if (typeof window === 'undefined') {
      return;
    }

    hydrationAttemptedRef.current = true;

    const attemptHydration = async () => {
      const params = new URLSearchParams(window.location.search);
      let candidate = params.get('job');

      if (!candidate) {
        try {
          candidate = window.localStorage.getItem('aci-active-job-id') || '';
        } catch (error) {
          console.warn('Não foi possível recuperar o job ativo armazenado.', error);
        }
      }

      if (candidate) {
        try {
          await hydrateJobFromServer(candidate);
          return;
        } catch (error) {
          console.warn('Falha ao hidratar job existente:', error);
          setStatusBanner({ type: 'error', message: error.message || 'Não foi possível recuperar o job informado.' });
          setActiveShareLink(null);
          updateJobReference(null);
        }
      }

      try {
        const response = await fetch('/process/active');
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || 'Não foi possível localizar análises ativas.');
        }
        if (data.jobId) {
          await hydrateJobFromServer(data.jobId);
          return;
        }
        setStatusBanner({ type: 'info', message: 'Nenhuma análise ativa encontrada no servidor.' });
        setActiveShareLink(null);
      } catch (error) {
        console.warn('Falha ao localizar job ativo:', error);
        setStatusBanner({ type: 'error', message: error.message || 'Não foi possível localizar análises ativas.' });
        setActiveShareLink(null);
      }
    };

    attemptHydration();
  }, [hydrateJobFromServer, isAuthenticated, updateJobReference]);

  const handleSubmit = useCallback(async (event) => {
    event.preventDefault();

    if (!steamIds.trim()) {
      setErrorMessage('Informe ao menos uma Steam ID (64 bits).');
      return;
    }

    if (!sanitizedSteamIds.length) {
      setErrorMessage('Informe ao menos uma Steam ID (64 bits).');
      return;
    }

    if (steamIdLimitExceeded) {
      setErrorMessage(limitErrorMessage);
      return;
    }

    pendingIdsRef.current = sanitizedSteamIds;
    setProcessedProfiles([]);

    const payloadIds = sanitizedSteamIds.join('\n');
    setSteamIds(payloadIds);

    setLogs([]);
    setJobResult(null);
    setErrorMessage(null);
    setStatusBanner(null);
    setIsProcessing(true);
    setIsPaused(false);
    setCurrentJobId(null);

    try {
      const params = new URLSearchParams();
      params.set('steam_ids', payloadIds);
      const trimmedWebhook = webhookUrl.trim();
      if (trimmedWebhook) {
        params.set('webhook_url', trimmedWebhook);
      }

      const response = await fetch('/process', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      const data = await response.json().catch(() => ({}));

      if (Array.isArray(data.ignoredSteamIds) && data.ignoredSteamIds.length) {
        const ignoredSet = new Set(
          data.ignoredSteamIds
            .map((item) => sanitizeSteamId(item))
            .filter(Boolean),
        );
        if (ignoredSet.size > 0) {
          pendingIdsRef.current = pendingIdsRef.current.filter((id) => !ignoredSet.has(id));
          setSteamIds(pendingIdsRef.current.join('\n'));
        }
      }

      if (!response.ok) {
        setErrorMessage(data.error || 'Não foi possível iniciar o processamento.');
        setIsProcessing(false);
        return;
      }

      if (!data.jobId) {
        setErrorMessage('Resposta inválida do servidor.');
        setIsProcessing(false);
        return;
      }

      setLogs([{ message: '[CLIENT] Aguardando streaming de logs do servidor...', type: 'info', id: null }]);
      const remoteLink = typeof data.shareLink === 'string' && data.shareLink.trim() ? data.shareLink : null;
      subscribeToJob(data.jobId, { shareLink: remoteLink });
    } catch (error) {
      setErrorMessage('Erro de rede ao iniciar o processamento.');
      setIsProcessing(false);
    }
  }, [steamIds, sanitizedSteamIds, steamIdLimitExceeded, webhookUrl, subscribeToJob, limitErrorMessage]);

  const handleDownloadReport = useCallback(async () => {
    if (!jobResult?.jobId) {
      setStatusBanner({ type: 'error', message: 'Nenhum relatório disponível para download no momento.' });
      return;
    }

    try {
      let htmlContent = typeof jobResult.reportHtml === 'string' && jobResult.reportHtml.trim()
        ? jobResult.reportHtml
        : null;

      if (!htmlContent) {
        const response = await fetch(`/process/${encodeURIComponent(jobResult.jobId)}/download?partial=${jobResult.partial ? 'true' : 'false'}`);
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || 'Não foi possível baixar o relatório atual.');
        }
        htmlContent = await response.text();
      }

      if (!htmlContent) {
        throw new Error('Relatório indisponível para download.');
      }

      const timestampSource = jobResult.generatedAt ? new Date(jobResult.generatedAt) : new Date();
      const safeTimestamp = Number.isNaN(timestampSource.getTime()) ? new Date() : timestampSource;
      const sanitized = safeTimestamp.toISOString().replace(/[:.]/g, '-');
      const prefix = jobResult.partial ? 'previa' : 'relatorio';
      const jobSegment = typeof jobResult.jobId === 'string' && jobResult.jobId.trim()
        ? jobResult.jobId.trim()
        : 'desconhecido';

      const blob = new Blob([htmlContent], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${prefix}_job_${jobSegment}_${sanitized}.html`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setStatusBanner({ type: 'success', message: 'Download do relatório iniciado.' });

      if (!jobResult.reportHtml && htmlContent) {
        setJobResult((previous) => (previous ? { ...previous, reportHtml: htmlContent } : previous));
      }
    } catch (error) {
      setStatusBanner({ type: 'error', message: error.message || 'Falha ao baixar o relatório atual.' });
    }
  }, [jobResult, setStatusBanner, setJobResult]);

  const handleDownloadHistory = useCallback(async () => {
    setHistoryBanner(null);
    try {
      const response = await fetch('/download-history');
      if (!response.ok) {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || 'Nenhum relatório disponível nas últimas 24 horas.');
        }
        const message = await response.text();
        const cleanMessage = message && /<\/?[a-z][^>]*>/i.test(message)
          ? 'Nenhum relatório disponível nas últimas 24 horas.'
          : (message || 'Nenhum relatório disponível nas últimas 24 horas.');
        throw new Error(cleanMessage);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `relatorio_historico_24h_${new Date().toISOString().slice(0, 10)}.html`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setHistoryBanner({ type: 'success', message: 'Download do histórico iniciado com sucesso.' });
    } catch (error) {
      setHistoryBanner({ type: 'error', message: error.message || 'Falha ao baixar o histórico de 24h.' });
    }
  }, []);

  const handleDownloadHistoryEntry = useCallback(async (entry) => {
    if (!entry?.id) {
      setHistoryBanner({ type: 'error', message: 'Selecione um relatório válido para download.' });
      return;
    }

    setHistoryBanner(null);

    try {
      let htmlContent = typeof entry.reportHtml === 'string' && entry.reportHtml.trim()
        ? entry.reportHtml
        : null;

      if (!htmlContent) {
        const response = await fetch(`/history/${encodeURIComponent(entry.id)}/download`);
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || 'Não foi possível baixar o relatório selecionado.');
        }
        htmlContent = await response.text();
      }

      if (!htmlContent) {
        throw new Error('Relatório indisponível para download.');
      }

      const timestampSource = entry.generatedAt ? new Date(entry.generatedAt) : new Date();
      const safeTimestamp = Number.isNaN(timestampSource.getTime())
        ? new Date().toISOString()
        : timestampSource.toISOString();
      const sanitized = safeTimestamp.replace(/[:.]/g, '-');
      const prefix = entry.partial ? 'previa' : 'relatorio';
      const jobSegment = typeof entry.jobId === 'string' && entry.jobId.trim()
        ? entry.jobId.trim()
        : 'desconhecido';

      const blob = new Blob([htmlContent], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${prefix}_job_${jobSegment}_${sanitized}.html`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setHistoryBanner({ type: 'success', message: 'Download iniciado com sucesso.' });

      if (!entry.reportHtml && htmlContent) {
        setHistoryEntries((previous) => previous.map((item) => (
          item.id === entry.id
            ? { ...item, reportHtml: htmlContent }
            : item
        )));
      }
    } catch (error) {
      setHistoryBanner({ type: 'error', message: error.message || 'Falha ao baixar o relatório selecionado.' });
    }
  }, []);

  const handleCopyShareLink = useCallback(async () => {
    if (!activeShareLink) {
      setStatusBanner({ type: 'error', message: 'Nenhum processamento ativo para compartilhar.' });
      return;
    }
    try {
      await navigator.clipboard.writeText(activeShareLink);
      setStatusBanner({ type: 'success', message: 'Link de acompanhamento copiado para a área de transferência.' });
    } catch (error) {
      console.warn('Não foi possível copiar o link automaticamente.', error);
      setStatusBanner({ type: 'info', message: `Copie manualmente: ${activeShareLink}` });
    }
  }, [activeShareLink]);

  const handlePauseJob = useCallback(async () => {
    if (!currentJobId) {
      return;
    }
    setStatusBanner(null);
    try {
      const response = await fetch(`/process/${currentJobId}/pause`, { method: 'POST' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || 'Não foi possível pausar o processamento.');
      }
      setIsPaused(true);
      setIsProcessing(false);
      setStatusBanner({ type: 'info', message: 'Processamento pausado com sucesso.' });
    } catch (error) {
      setStatusBanner({ type: 'error', message: error.message || 'Falha ao pausar o processamento.' });
    }
  }, [currentJobId]);

  const handleResumeJob = useCallback(async () => {
    if (!currentJobId) {
      return;
    }
    setStatusBanner(null);
    try {
      const response = await fetch(`/process/${currentJobId}/resume`, { method: 'POST' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || 'Não foi possível retomar o processamento.');
      }
      setIsPaused(false);
      setIsProcessing(true);
      setStatusBanner({ type: 'success', message: 'Processamento retomado.' });
    } catch (error) {
      setStatusBanner({ type: 'error', message: error.message || 'Falha ao retomar o processamento.' });
    }
  }, [currentJobId]);

  const handleGeneratePartialReport = useCallback(async () => {
    if (!currentJobId) {
      return;
    }
    setStatusBanner(null);
    try {
      const response = await fetch(`/process/${currentJobId}/partial-report`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Não foi possível gerar o relatório parcial.');
      }
      const enriched = { ...data, jobId: currentJobId };
      setJobResult(enriched);
      registerHistoryEntry(enriched);
      fetchHistoryFromServer();
      setStatusBanner({ type: 'success', message: 'Prévia HTML gerada e adicionada ao histórico.' });
    } catch (error) {
      setStatusBanner({ type: 'error', message: error.message || 'Falha ao gerar o relatório parcial.' });
    }
  }, [currentJobId, fetchHistoryFromServer, registerHistoryEntry]);

  const handleSelectHistory = useCallback((entryId) => {
    setActiveHistoryId(entryId);
  }, []);

  const formatHistoryTimestamp = useCallback((value) => {
    if (!value) {
      return 'Sem data';
    }
    try {
      return new Date(value).toLocaleString('pt-BR');
    } catch (error) {
      return value;
    }
  }, []);

  const isJobActive = isProcessing || isPaused || isHydratingJob;
  const statusLabel = isHydratingJob
    ? 'Sincronizando…'
    : isProcessing
      ? 'Processando…'
      : isPaused
        ? 'Pausado'
        : jobResult
          ? 'Execução concluída'
          : 'Aguardando IDs';
  const statusTone = isHydratingJob
    ? 'processing'
    : isProcessing
      ? 'processing'
      : isPaused
        ? 'paused'
        : jobResult
          ? 'success'
          : 'idle';
  const activeHistoryEntry = useMemo(
    () => historyEntries.find((entry) => entry.id === activeHistoryId) || null,
    [historyEntries, activeHistoryId],
  );
  const hasFriendsResults = friendsResults.length > 0;

  const formatProcessedStatus = useCallback((profile) => {
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
  }, []);

  if (!isAuthenticated) {
    return (
      <div className="auth-gate">
        <form className="auth-card" onSubmit={handleAuthenticate}>
          <h1>Art Cases — Acesso Restrito</h1>
          <p>Digite a senha de acesso para continuar.</p>
          <label htmlFor="auth-password">Senha</label>
          <input
            id="auth-password"
            type="password"
            value={passwordInput}
            onChange={(event) => {
              setPasswordInput(event.target.value);
              setAuthError(null);
            }}
            placeholder="Digite a senha de acesso"
            autoFocus
          />
          {authError && <span className="auth-error">{authError}</span>}
          <button type="submit">Entrar</button>
        </form>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <div className="hero-content">
          <h1>Art Cases Intelligence</h1>
          <p>Monitoramento profissional de inventários da Steam com bloqueio automático de VAC ban e avaliação instantânea via Montuga API.</p>
          <ul className="hero-highlights">
            <li>Filtragem em tempo real de contas com VAC ban antes de qualquer consulta.</li>
            <li>Logs transmitidos ao vivo diretamente do backend.</li>
            <li>Relatórios premium prontos para download em HTML.</li>
          </ul>
        </div>
      </header>

      <main className="workspace">
        <div className="tab-navigation">
          <button
            type="button"
            className={`tab-button ${activeTab === 'analysis' ? 'tab-button-active' : ''}`}
            onClick={() => setActiveTab('analysis')}
          >
            Análise de inventário
          </button>
          <button
            type="button"
            className={`tab-button ${activeTab === 'history' ? 'tab-button-active' : ''}`}
            onClick={() => {
              setActiveTab('history');
              fetchHistoryFromServer();
            }}
          >
            Histórico (24h)
          </button>
          <button
            type="button"
            className={`tab-button ${activeTab === 'friends' ? 'tab-button-active' : ''}`}
            onClick={() => setActiveTab('friends')}
          >
            Lista de amigos
          </button>
        </div>

        {activeTab === 'analysis' ? (
          <div className="analysis-layout">
            <section className="control-column">
              <div className="surface form-card">
            <div className="card-header">
              <h2>Análise instantânea</h2>
              <p>Informe as Steam IDs (64 bits), uma por linha, e acompanhe o processamento em tempo real.</p>
            </div>

            {errorMessage && (
              <div className="alert alert-error">{errorMessage}</div>
            )}

            {statusBanner && (
              <div className={`alert alert-${statusBanner.type}`}>{statusBanner.message}</div>
            )}

            <form onSubmit={handleSubmit} className="control-form">
              <label className="field-label" htmlFor="steam-ids">Steam IDs</label>
              <div className="textarea-field">
                <textarea
                  id="steam-ids"
                  placeholder="Cole uma Steam ID (64 bits) por linha. Ex: 76561198000000000"
                  value={steamIds}
                  onChange={(event) => setSteamIds(event.target.value)}
                  rows={10}
                  disabled={isJobActive}
                  className={steamIdLimitExceeded ? 'input-error' : ''}
                />

                <div className="field-meta">
                  <p className={`field-counter ${steamIdLimitExceeded ? 'field-counter-error' : ''}`}>
                    IDs detectadas: {steamIdCount.toLocaleString('pt-BR')} / {formattedMaxSteamIds}
                  </p>
                  {steamIdLimitExceeded && (
                    <p className="field-warning">Limite máximo excedido. Reduza a lista para iniciar o processamento.</p>
                  )}
                </div>
              </div>

              <label className="field-label" htmlFor="webhook-url">Webhook (opcional)</label>
              <input
                id="webhook-url"
                type="url"
                placeholder="https://seu-endpoint.com/notificacoes"
                value={webhookUrl}
                onChange={(event) => setWebhookUrl(event.target.value)}
                disabled={isJobActive}
              />
              <p className="field-hint">
                Receba notificações automáticas sobre início, pausa, retomada, conclusão e inventários premium (≥ R$ 3.000).
              </p>

              <div className="button-row">
                <button type="submit" className="primary-btn" disabled={isJobActive || !steamIds.trim() || steamIdLimitExceeded}>
                  Iniciar análise
                </button>
                <button type="button" className="ghost-btn" onClick={resetInterface} disabled={isJobActive}>
                  Limpar interface
                </button>
              </div>

              {isJobActive && (
                <div className="button-row secondary-controls">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={isPaused ? handleResumeJob : handlePauseJob}
                    disabled={!currentJobId}
                  >
                    {isPaused ? 'Retomar análise' : 'Pausar análise'}
                  </button>
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={handleGeneratePartialReport}
                    disabled={!isPaused || !currentJobId}
                  >
                    Gerar relatório parcial
                  </button>
                </div>
              )}

            </form>

            <p className="helper-text">Cada requisição verifica o status de VAC ban diretamente na Steam antes de qualquer consulta à Montuga API.</p>
          </div>

          {processedProfiles.length > 0 && (
            <div className="surface processed-card">
              <div className="card-header compact">
                <h2>Perfis processados</h2>
                <p>IDs concluídas são removidas automaticamente do campo de entrada.</p>
              </div>
              <ul className="processed-list">
                {processedProfiles.map((profile) => (
                  <li key={profile.id} className={`processed-item processed-${profile.status}`}>
                    <div className="processed-meta">
                      <span className="processed-name">{profile.name || 'Perfil Steam'}</span>
                      <span className="processed-id">{profile.id}</span>
                    </div>
                    <div className="processed-status-row">
                      <span className="processed-status-label">{formatProcessedStatus(profile)}</span>
                      {profile.status === 'success' && (
                        <span className="processed-value">
                          R$ {Number(profile.totalValueBRL || 0).toFixed(2).replace('.', ',')}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {jobResult && (
            <div className="surface metrics-card">
              <div className="card-header compact">
                <h2>{jobResult.partial ? 'Prévia do processamento' : 'Resumo da execução'}</h2>
                <p>
                  {jobResult.partial
                    ? 'Dados parciais disponíveis enquanto a análise está pausada.'
                    : 'Dados consolidados da última análise concluída.'}
                </p>
              </div>
              <div className="summary-grid">
                <div className="metric-tile">
                  <span className="metric-label">Inventários avaliados</span>
                  <strong className="metric-value">{jobResult.successCount ?? 0}</strong>
                </div>
                <div className="metric-tile">
                  <span className="metric-label">IDs recebidas</span>
                  <strong className="metric-value">{jobResult.totals?.requested ?? 0}</strong>
                </div>
                <div className="metric-tile">
                  <span className="metric-label">Perfis limpos</span>
                  <strong className="metric-value">{jobResult.totals?.clean ?? 0}</strong>
                </div>
                <div className="metric-tile">
                  <span className="metric-label">VAC ban bloqueados</span>
                  <strong className="metric-value">{jobResult.totals?.vacBanned ?? 0}</strong>
                </div>
                <div className="metric-tile">
                  <span className="metric-label">Falhas Steam</span>
                  <strong className="metric-value">{jobResult.totals?.steamErrors ?? 0}</strong>
                </div>
                <div className="metric-tile">
                  <span className="metric-label">Falhas Montuga</span>
                  <strong className="metric-value">{jobResult.totals?.montugaErrors ?? 0}</strong>
                </div>
              </div>
            </div>
          )}
            </section>

            <section className="output-column">
          <div className="surface log-card">
            <div className="card-header log-header">
              <div>
                <h2>Log em tempo real</h2>
                <p className="card-subtitle">Eventos transmitidos diretamente pelo backend via SSE.</p>
              </div>
              <div className="log-header-tools">
                {currentJobId && (
                  <span className="job-pill" title={`Job ${currentJobId}`}>
                    Job {currentJobId.slice(0, 8)}…
                  </span>
                )}
                {activeShareLink && (
                  <button type="button" className="ghost-btn ghost-compact" onClick={handleCopyShareLink}>
                    Copiar link de acompanhamento
                  </button>
                )}
                <span className={`status-indicator status-${statusTone}`}>
                  <span className="status-pulse" />
                  {statusLabel}
                </span>
              </div>
            </div>

            <div className="log-stream" ref={logContainerRef}>
              {logs.length === 0 ? (
                <div className="log-empty">
                  <p>Os eventos da análise aparecerão aqui em tempo real.</p>
                </div>
              ) : (
                logs.map((log, index) => {
                  const separatorIndex = log.message.indexOf(']');
                  const prefix = separatorIndex >= 0 ? `${log.message.substring(0, separatorIndex + 1)} ` : '';
                  const message = separatorIndex >= 0 ? log.message.substring(separatorIndex + 1).trim() : log.message;

                  return (
                    <div key={`${index}-${log.timestamp ?? index}`} className={`log-entry log-${log.type || 'info'}`}>
                      <span className="log-prefix">{prefix}</span>
                      <span className="log-message">{message}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {jobResult?.reportHtml && (
            <div className="surface report-card">
              <div className="card-header report-header">
                <div>
                  <h2>{jobResult.partial ? 'Relatório parcial' : 'Relatório detalhado'}</h2>
                  <p className="card-subtitle">
                    {jobResult.partial
                      ? 'Prévia em HTML da execução pausada para consulta imediata.'
                      : 'Visualize o relatório renderizado diretamente dentro do painel.'}
                  </p>
                </div>
                <button type="button" className="secondary-btn" onClick={handleDownloadReport}>
                  Baixar HTML
                </button>
              </div>
              <div className="report-frame">
                <iframe
                  title="Relatório de inventário"
                  srcDoc={jobResult.reportHtml}
                  sandbox="allow-same-origin allow-scripts"
                />
              </div>
            </div>
          )}

            </section>
          </div>
        ) : activeTab === 'history' ? (
          <section className="surface history-card history-panel">
            <div className="card-header history-header">
              <div>
                <h2>Histórico de relatórios (24h)</h2>
                <p className="card-subtitle">Baixe os HTMLs gerados nas últimas 24 horas diretamente pelo painel.</p>
              </div>
              <div className="history-controls">
                <button
                  type="button"
                  className="ghost-btn ghost-compact"
                  onClick={fetchHistoryFromServer}
                  disabled={isFetchingHistory}
                >
                  {isFetchingHistory ? 'Atualizando…' : 'Atualizar'}
                </button>
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={handleDownloadHistory}
                  disabled={isFetchingHistory || historyEntries.length === 0}
                >
                  Baixar HTML (24h)
                </button>
              </div>
            </div>

            {historyBanner && (
              <div className={`alert alert-${historyBanner.type}`}>{historyBanner.message}</div>
            )}

            {historyError && (
              <div className="alert alert-error">{historyError}</div>
            )}

            {historyEntries.length > 0 ? (
              <>
                <div className="history-tabs">
                  {historyEntries.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className={`history-tab ${activeHistoryId === entry.id ? 'history-tab-active' : ''}`}
                      onClick={() => handleSelectHistory(entry.id)}
                    >
                      <span className="history-tab-label">{entry.partial ? 'Prévia' : 'Final'}</span>
                      <strong className="history-tab-date">{formatHistoryTimestamp(entry.generatedAt)}</strong>
                    </button>
                  ))}
                </div>

                {activeHistoryEntry ? (
                  <div className="history-preview">
                    <div className="history-summary">
                      <span className={`history-badge ${activeHistoryEntry.partial ? 'history-badge-partial' : 'history-badge-final'}`}>
                        {activeHistoryEntry.partial ? 'Prévia' : 'Final'}
                      </span>
                      <div className="history-metrics">
                        <span>
                          IDs processadas: {activeHistoryEntry.totals?.processed ?? activeHistoryEntry.totals?.requested ?? 0}
                        </span>
                        <span>Inventários avaliados: {activeHistoryEntry.successCount ?? 0}</span>
                      </div>
                      {isFetchingHistory && (
                        <span className="history-loading">Atualizando…</span>
                      )}
                    </div>
                    <div className="history-actions">
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => handleDownloadHistoryEntry(activeHistoryEntry)}
                      >
                        Baixar HTML individual
                      </button>
                    </div>
                    <div className="history-frame">
                      <iframe
                        title={`Relatório salvo ${formatHistoryTimestamp(activeHistoryEntry.generatedAt)}`}
                        srcDoc={activeHistoryEntry.reportHtml || HISTORY_FALLBACK_DOC}
                        sandbox="allow-same-origin allow-scripts"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="history-empty">Selecione um relatório para visualizar.</div>
                )}
              </>
            ) : (
              <div className="history-empty">
                {isFetchingHistory
                  ? 'Carregando relatórios gerados nas últimas 24 horas…'
                  : 'Nenhum relatório disponível nas últimas 24 horas.'}
              </div>
            )}
          </section>
        ) : (
          <section className="friends-panel surface">
            <div className="card-header">
              <h2>Listas de amigos Steam</h2>
              <p>Gere rapidamente arquivos .txt com os amigos de qualquer SteamID64 utilizando a API oficial da Steam.</p>
            </div>

            {friendsError && (
              <div className="alert alert-error">{friendsError}</div>
            )}

            {friendsStatus && (
              <div className="alert alert-success">{friendsStatus}</div>
            )}

            <form className="friends-form" onSubmit={handleFriendsSubmit}>
              <label className="field-label" htmlFor="friends-steam-ids">Steam IDs</label>
              <textarea
                id="friends-steam-ids"
                placeholder="Cole uma SteamID64 por linha. Ex: 76561198077240100"
                value={friendsInput}
                onChange={(event) => setFriendsInput(event.target.value)}
                rows={8}
                disabled={isFetchingFriends}
              />
              <p className="field-hint">Aceitamos apenas IDs numéricos de 17 dígitos. Outros caracteres são ignorados automaticamente.</p>
              <div className="button-row">
                <button type="submit" className="primary-btn" disabled={isFetchingFriends || !friendsInput.trim()}>
                  {isFetchingFriends ? 'Consultando…' : 'Buscar amigos'}
                </button>
                <button type="button" className="ghost-btn" onClick={resetFriendsInterface} disabled={isFetchingFriends}>
                  Limpar campos
                </button>
              </div>
            </form>

            <div className="friends-results">
              {isFetchingFriends ? (
                <div className="friends-empty">Consultando listas de amigos diretamente na Steam…</div>
              ) : hasFriendsResults ? (
                friendsResults.map((result, index) => {
                  const friendCount = typeof result?.friendCount === 'number'
                    ? result.friendCount
                    : Array.isArray(result?.friends)
                      ? result.friends.length
                      : 0;
                  return (
                    <div
                      key={`${result?.steamId || 'steam-id'}-${index}`}
                      className={`friends-result-card ${result?.error ? 'friends-result-card-error' : ''}`}
                    >
                      <div className="friends-result-header">
                        <div>
                          <span className="friends-result-label">Steam ID</span>
                          <strong>{result?.steamId || 'Informada'}</strong>
                        </div>
                        <span className="friends-count">
                          {result?.error ? 'Erro' : `${friendCount} ${friendCount === 1 ? 'amigo' : 'amigos'}`}
                        </span>
                      </div>
                      {result?.error ? (
                        <p className="friends-result-error">{result.error}</p>
                      ) : (
                        <div className="friends-list-wrapper">
                          {Array.isArray(result?.friends) && result.friends.length > 0 ? (
                            <pre className="friends-list">{result.friends.join('\n')}</pre>
                          ) : (
                            <p className="friends-list-empty">Nenhum amigo retornado pela Steam para este ID.</p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="friends-empty">Os resultados aparecerão aqui após a consulta.</div>
              )}
            </div>

            {hasFriendsResults && (
              <div className="friends-actions">
                <button type="button" className="secondary-btn" onClick={handleDownloadFriends}>
                  Baixar arquivo .txt
                </button>
              </div>
            )}
          </section>
        )}
      </main>

      <footer className="footer">
        <p>
          Infraestrutura pronta para ambientes em nuvem. Backend Node.js com SSE, frontend React responsivo e integrações oficiais Steam Web API &amp; Montuga API.
        </p>
      </footer>
    </div>
  );
}

export default App;
