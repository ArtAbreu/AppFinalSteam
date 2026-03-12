import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import './App.css';

const MAX_STEAM_IDS = 25000;
const PROCESSED_PREVIEW_LIMIT = 20;
function normalizeHistoryEntryPayload(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const jobId = entry.jobId ? String(entry.jobId).trim() : 'desconhecido';
  let generatedAt = new Date().toISOString();
  if (entry.generatedAt) {
    const candidate = new Date(entry.generatedAt);
    if (!Number.isNaN(candidate.getTime())) {
      generatedAt = candidate.toISOString();
    }
  }

  const normalized = {
    ...entry,
    jobId,
    generatedAt,
    partial: Boolean(entry.partial),
    reportHtml: typeof entry.reportHtml === 'string' ? entry.reportHtml : '',
    reportPath:
      typeof entry.reportPath === 'string' && entry.reportPath.trim()
        ? entry.reportPath.trim().replace(/\\+/g, '/').replace(/^\/+/, '')
        : null,
  };

  normalized.successCount =
    typeof normalized.successCount === 'number' && Number.isFinite(normalized.successCount)
      ? normalized.successCount
      : null;
  normalized.id = entry.id || `${jobId}-${generatedAt}`;

  return normalized;
}

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

function inferLogLevel(entry) {
  const explicitLevel = String(entry?.level || entry?.type || '').toLowerCase();
  if (['success', 'error', 'warning', 'info'].includes(explicitLevel)) {
    return explicitLevel;
  }

  const message = String(entry?.message || '').toLowerCase();
  if (/error|falha|failed|failure|not found|inválid|inválida/.test(message)) {
    return 'error';
  }
  if (/vac|warn|warning|ban|indisponível|unavailable|rate limit/.test(message)) {
    return 'warning';
  }
  if (/success|sucesso|avaliado|processed|concluído|valid/.test(message)) {
    return 'success';
  }
  return 'info';
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
  const [isStoppingJob, setIsStoppingJob] = useState(false);
  const [reportHistory, setReportHistory] = useState(() => {
    if (typeof window === 'undefined') {
      return [];
    }
    try {
      const stored = window.localStorage.getItem('aci-history');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          return parsed
            .map((entry) => normalizeHistoryEntryPayload(entry))
            .filter((entry) => entry !== null);
        }
      }
    } catch (error) {
      console.warn('Não foi possível carregar o histórico salvo localmente.', error);
    }
    return [];
  });
  const [activeHistoryId, setActiveHistoryId] = useState(null);
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
  const aggregatedFriendIds = useMemo(() => {
    const unique = new Set();
    for (const result of friendsResults) {
      if (result?.error || !Array.isArray(result?.friends)) {
        continue;
      }
      for (const friendId of result.friends) {
        const sanitized = sanitizeSteamId(friendId);
        if (sanitized) {
          unique.add(sanitized);
        }
      }
    }
    return Array.from(unique);
  }, [friendsResults]);
  const totalApprovedFriends = aggregatedFriendIds.length;
  const hasFriendsResults = friendsResults.length > 0;
  const hydrationAttemptedRef = useRef(false);
  const sharedJobCandidateRef = useRef(null);
  const [isHydratingJob, setIsHydratingJob] = useState(false);
  const serverHistoryFetchedRef = useRef(false);
  const [processedRegistry, setProcessedRegistry] = useState(() => {
    if (typeof window === 'undefined') {
      return {
        total: 0,
        ids: [],
        isLoading: false,
        error: null,
        lastUpdated: null,
      };
    }
    try {
      const stored = window.localStorage.getItem('aci-processed-registry');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed === 'object') {
          return {
            total: Number.isFinite(Number(parsed.total)) ? Number(parsed.total) : 0,
            ids: Array.isArray(parsed.ids) ? parsed.ids.filter(Boolean) : [],
            isLoading: false,
            error: null,
            lastUpdated: parsed.lastUpdated || null,
          };
        }
      }
    } catch (error) {
      console.warn('Não foi possível recuperar o histórico de IDs processadas salvo localmente.', error);
    }
    return {
      total: 0,
      ids: [],
      isLoading: false,
      error: null,
      lastUpdated: null,
    };
  });
  const [processedExclusions, setProcessedExclusions] = useState(() => {
    if (typeof window === 'undefined') {
      return {
        ids: [],
        lastUpdated: null,
      };
    }
    try {
      const stored = window.localStorage.getItem('aci-processed-exclusions');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed === 'object') {
          return {
            ids: Array.isArray(parsed.ids) ? parsed.ids.filter(Boolean) : [],
            lastUpdated: parsed.lastUpdated || null,
          };
        }
      }
    } catch (error) {
      console.warn('Não foi possível recuperar o histórico de exclusões salvo localmente.', error);
    }
    return {
      ids: [],
      lastUpdated: null,
    };
  });

  const applyJobResultPayload = useCallback((payload) => {
    if (!payload) {
      setJobResult(null);
      return;
    }

    setJobResult(payload);
  }, []);

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
    if (reportHistory.length === 0) {
      setActiveHistoryId(null);
      return;
    }
    if (!activeHistoryId || !reportHistory.some((entry) => entry.id === activeHistoryId)) {
      setActiveHistoryId(reportHistory[0].id);
    }
  }, [reportHistory, activeHistoryId]);

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
  const processedExclusionSet = useMemo(() => {
    const combined = new Set();
    for (const id of processedRegistry.ids || []) {
      const sanitized = sanitizeSteamId(id);
      if (sanitized) {
        combined.add(sanitized);
      }
    }
    for (const id of processedExclusions.ids || []) {
      const sanitized = sanitizeSteamId(id);
      if (sanitized) {
        combined.add(sanitized);
      }
    }
    return combined;
  }, [processedRegistry.ids, processedExclusions.ids]);

  const excludedCount = processedExclusionSet.size;

  useEffect(() => {
    if (!steamIdLimitExceeded && errorMessage === limitErrorMessage) {
      setErrorMessage(null);
    }
  }, [steamIdLimitExceeded, errorMessage, limitErrorMessage]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      window.localStorage.setItem('aci-processed-exclusions', JSON.stringify(processedExclusions));
    } catch (error) {
      console.warn('Não foi possível persistir o histórico de exclusões de IDs.', error);
    }
  }, [processedExclusions]);

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
    try {
      const serialized = JSON.stringify(reportHistory.slice(0, 10));
      window.localStorage.setItem('aci-history', serialized);
    } catch (error) {
      console.warn('Não foi possível persistir o histórico local.', error);
    }
  }, [reportHistory]);

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

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      window.localStorage.setItem('aci-processed-registry', JSON.stringify(processedRegistry));
    } catch (error) {
      console.warn('Não foi possível persistir o histórico de IDs processadas.', error);
    }
  }, [processedRegistry]);

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
    applyJobResultPayload(null);
    setErrorMessage(null);
    setStatusBanner(null);
    setIsProcessing(false);
    setProcessedProfiles([]);
    setCurrentJobId(null);
    setIsPaused(false);
    setIsStoppingJob(false);
    pendingIdsRef.current = [];
    hydrationAttemptedRef.current = false;
    sharedJobCandidateRef.current = null;
    setActiveShareLink(null);
    updateJobReference(null);
  }, [applyJobResultPayload, closeEventSource, updateJobReference]);

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

    const requestPayload = { steamIds: ids };

    setIsFetchingFriends(true);
    try {
      const response = await fetch('/friends/list', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestPayload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Não foi possível consultar as listas de amigos.');
      }
      const payload = Array.isArray(data.results) ? data.results : [];
      setFriendsResults(payload);
      const hasValidResponse = payload.some((entry) => !entry?.error);
      if (!hasValidResponse) {
        setFriendsStatus('Não foi possível recuperar amigos para os IDs informados.');
      } else {
        const totals = payload.reduce(
          (accumulator, entry) => {
            if (!entry?.error) {
              const returned = Array.isArray(entry?.friends) ? entry.friends.length : 0;
              const totalFriends = Number.isFinite(entry?.stats?.totalFriends)
                ? entry.stats.totalFriends
                : returned;
              return {
                returned: accumulator.returned + returned,
                total: accumulator.total + totalFriends,
              };
            }
            return accumulator;
          },
          { returned: 0, total: 0 },
        );

        if (totals.returned > 0) {
          const duplicatesRemoved = Math.max(totals.total - totals.returned, 0);
          const baseMessage = `Encontramos ${totals.returned} amigos no total.`;
          const duplicatesMessage = duplicatesRemoved > 0
            ? ` ${duplicatesRemoved} entradas duplicadas foram removidas automaticamente.`
            : ' Todos os IDs foram mantidos sem filtros.';
          setFriendsStatus(`${baseMessage}${duplicatesMessage}`);
        } else {
          setFriendsStatus('Nenhum amigo foi retornado para os IDs informados.');
        }
      }
    } catch (error) {
      setFriendsResults([]);
      setFriendsError(error.message || 'Falha ao consultar as listas de amigos.');
    } finally {
      setIsFetchingFriends(false);
    }
  }, [friendsInput]);

  const handleDownloadFriends = useCallback(() => {
    if (aggregatedFriendIds.length === 0) {
      return;
    }

    const blob = new Blob([`${aggregatedFriendIds.join('\n')}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `friends_list_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, [aggregatedFriendIds]);

  const upsertHistoryEntries = useCallback((entries, { focusLast = false } = {}) => {
    if (!Array.isArray(entries) || entries.length === 0) {
      return;
    }

    const normalizedEntries = entries
      .map((entry) => normalizeHistoryEntryPayload(entry))
      .filter((entry) => entry !== null);

    if (normalizedEntries.length === 0) {
      return;
    }

    const targetId = focusLast ? normalizedEntries[normalizedEntries.length - 1].id : null;

    setReportHistory((previous) => {
      const map = new Map(previous.map((item) => [item.id, item]));
      let changed = false;

      for (const normalized of normalizedEntries) {
        const existing = map.get(normalized.id);
        if (
          !existing ||
          existing.generatedAt !== normalized.generatedAt ||
          existing.reportHtml !== normalized.reportHtml ||
          existing.reportPath !== normalized.reportPath ||
          existing.partial !== normalized.partial ||
          (existing.successCount ?? null) !== (normalized.successCount ?? null)
        ) {
          map.set(normalized.id, normalized);
          changed = true;
        }
      }

      if (!changed) {
        return previous;
      }

      const next = Array.from(map.values()).sort((a, b) => {
        const aTime = new Date(a.generatedAt).getTime();
        const bTime = new Date(b.generatedAt).getTime();
        return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
      });

      return next.slice(0, 10);
    });

    if (focusLast && targetId) {
      setActiveHistoryId(targetId);
    }
  }, []);

  const registerHistoryEntry = useCallback(
    (entry) => {
      upsertHistoryEntries([entry], { focusLast: true });
    },
    [upsertHistoryEntries],
  );

  const subscribeToJob = useCallback((jobId, options = {}) => {
    const { initialPaused = false, shareLink: shareLinkOverride = null } = options;
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    finishedRef.current = false;
    setIsStoppingJob(false);
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

        setProcessedRegistry((previous) => {
          const sanitizedId = sanitizeSteamId(payload?.id);
          if (!sanitizedId) {
            return previous;
          }

          const existingIds = Array.isArray(previous.ids) ? previous.ids : [];
          if (existingIds.includes(sanitizedId)) {
            return {
              ...previous,
              isLoading: false,
              lastUpdated: new Date().toISOString(),
            };
          }

          const updatedIds = [sanitizedId, ...existingIds].slice(0, PROCESSED_PREVIEW_LIMIT);
          const previousTotal = Number(previous.total);
          const baselineTotal = Number.isFinite(previousTotal) ? previousTotal : existingIds.length;

          return {
            ...previous,
            ids: updatedIds,
            total: baselineTotal + 1,
            isLoading: false,
            error: null,
            lastUpdated: new Date().toISOString(),
          };
        });
      } catch (error) {
        console.warn('Não foi possível interpretar a notificação de perfil processado.', error);
      }
    });

    eventSource.addEventListener('job-paused', () => {
      setIsPaused(true);
      setIsProcessing(false);
      setIsStoppingJob(false);
      setStatusBanner({ type: 'info', message: 'Processamento pausado. Gere um relatório parcial ou retome quando desejar.' });
    });

    eventSource.addEventListener('job-resumed', () => {
      setIsPaused(false);
      setIsProcessing(true);
      setIsStoppingJob(false);
      setStatusBanner({ type: 'success', message: 'Processamento retomado com sucesso.' });
    });

    eventSource.addEventListener('job-stopping', (event) => {
      let payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch (error) {
        payload = null;
      }
      const message = payload?.reason || 'Finalização manual solicitada. O relatório será consolidado em instantes.';
      setIsStoppingJob(true);
      setIsProcessing(false);
      setIsPaused(false);
      setStatusBanner({ type: 'info', message });
    });

    eventSource.addEventListener('complete', (event) => {
      finishedRef.current = true;
      let parsedPayload = null;
      try {
        parsedPayload = JSON.parse(event.data);
        const enriched = { ...parsedPayload, jobId, partial: false, manualStop: Boolean(parsedPayload?.manualStop) };
        applyJobResultPayload(enriched);
        registerHistoryEntry({ ...enriched, partial: false });
        setErrorMessage(null);
      } catch (error) {
        setErrorMessage('Processamento concluído, mas não foi possível ler o relatório.');
      }
      setIsProcessing(false);
      setIsPaused(false);
      setIsStoppingJob(false);
      setCurrentJobId(null);
      pendingIdsRef.current = [];
      const clearedLink = updateJobReference(null);
      setActiveShareLink((previous) => {
        if (parsedPayload?.shareLink) {
          return parsedPayload.shareLink;
        }
        return previous || clearedLink;
      });
      if (parsedPayload?.manualStop) {
        setStatusBanner({ type: 'info', message: 'Processamento finalizado manualmente. Relatório consolidado com os dados disponíveis.' });
      } else {
        setStatusBanner({ type: 'success', message: 'Processamento concluído com sucesso.' });
      }
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
      setIsStoppingJob(false);
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
      setIsStoppingJob(false);
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
            applyJobResultPayload(payload);
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
        setIsStoppingJob(false);
        setCurrentJobId(null);
        finishedRef.current = true;
        const clearedLink = updateJobReference(null);
        setActiveShareLink((previous) => previous || clearedLink);
      }
    };
  }, [applyJobResultPayload, registerHistoryEntry, updateJobReference]);

  const hydrateJobFromServer = useCallback(async (jobId) => {
    setIsHydratingJob(true);
    try {
      const response = await fetch(`/process/${jobId}/inspect`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Não foi possível carregar o job compartilhado.');
      }

      finishedRef.current = data.status === 'complete' || data.status === 'error';
      const stopRequested = Boolean(data.stopRequested);
      const manualStop = Boolean(data.manualStop);
      const manualStopReason = data.manualStopReason || null;

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
          reportPath: data.reportPath || null,
          manualStop,
        };
        applyJobResultPayload(payload);
        registerHistoryEntry(payload);
      } else {
        applyJobResultPayload(null);
      }

      if (data.status === 'error') {
        setErrorMessage(data.error || 'O processamento foi encerrado com erro.');
      } else {
        setErrorMessage(null);
      }

      if (data.status === 'processing' || data.status === 'paused') {
        setIsProcessing(stopRequested ? false : data.status === 'processing');
        setIsPaused(stopRequested ? false : data.status === 'paused');
        setIsStoppingJob(stopRequested);
        setCurrentJobId(jobId);
        const link = updateJobReference(jobId);
        const remoteLink = typeof data.shareLink === 'string' && data.shareLink.trim() ? data.shareLink : null;
        setActiveShareLink(remoteLink || link);
        if (stopRequested) {
          setStatusBanner({
            type: 'info',
            message: manualStopReason || 'Finalização manual solicitada. O relatório será consolidado em instantes.',
          });
        } else {
          setStatusBanner({
            type: 'info',
            message: data.status === 'processing'
              ? 'Conectado a uma análise em andamento em outro dispositivo.'
              : 'Conectado a um job pausado. Você pode retomar quando quiser.',
          });
        }
        subscribeToJob(jobId, { initialPaused: data.status === 'paused', shareLink: remoteLink || link });
      } else {
        setIsProcessing(false);
        setIsPaused(false);
        setIsStoppingJob(false);
        setCurrentJobId(null);
        if (data.shareLink) {
          setActiveShareLink((previous) => data.shareLink || previous);
        }
        const clearedLink = updateJobReference(null);
        setActiveShareLink((previous) => previous || clearedLink);
        if (data.status === 'complete') {
          if (manualStop) {
            setStatusBanner({
              type: 'info',
              message: manualStopReason || 'Processamento finalizado manualmente. Relatório consolidado com os dados disponíveis.',
            });
          } else {
            setStatusBanner({ type: 'success', message: 'Relatório concluído recuperado do servidor.' });
          }
        } else if (data.status === 'error') {
          setStatusBanner({ type: 'error', message: data.error || 'O processamento foi encerrado com erro.' });
        } else {
          setStatusBanner({ type: 'info', message: 'Estado atual sincronizado com o servidor.' });
        }
      }
    } finally {
      setIsHydratingJob(false);
    }
  }, [applyJobResultPayload, registerHistoryEntry, subscribeToJob, updateJobReference]);

  const fetchServerHistory = useCallback(async () => {
    try {
      const response = await fetch('/history/entries');
      if (!response.ok) {
        return;
      }
      const payload = await response.json().catch(() => ({}));
      if (Array.isArray(payload.entries) && payload.entries.length > 0) {
        upsertHistoryEntries(payload.entries);
      }
    } catch (error) {
      console.warn('Não foi possível recuperar o histórico do servidor.', error);
    }
  }, [upsertHistoryEntries]);

  const refreshProcessedRegistry = useCallback(async () => {
    setProcessedRegistry((previous) => ({
      ...previous,
      isLoading: true,
      error: null,
    }));

    try {
      const response = await fetch(`/history/processed?limit=${PROCESSED_PREVIEW_LIMIT}`);
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || 'Não foi possível carregar o histórico de IDs processadas.');
      }

      const ids = Array.isArray(data.steamIds)
        ? data.steamIds.map((item) => sanitizeSteamId(item)).filter(Boolean)
        : [];
      const numericTotal = Number(data.total);
      const total = Number.isFinite(numericTotal) ? numericTotal : ids.length;

      const nextRegistry = {
        total,
        ids: ids.slice(0, PROCESSED_PREVIEW_LIMIT),
        isLoading: false,
        error: null,
        lastUpdated: new Date().toISOString(),
      };

      setProcessedRegistry(nextRegistry);
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem('aci-processed-registry', JSON.stringify(nextRegistry));
        } catch (error) {
          console.warn('Não foi possível persistir o histórico de IDs processadas.', error);
        }
      }
    } catch (error) {
      setProcessedRegistry((previous) => ({
        ...previous,
        isLoading: false,
        error: error.message || 'Não foi possível carregar o histórico de IDs processadas.',
      }));
    }
  }, []);

  useEffect(() => {
    if (hydrationAttemptedRef.current) {
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
  }, [hydrateJobFromServer, updateJobReference]);

  useEffect(() => {
    if (serverHistoryFetchedRef.current) {
      return;
    }
    serverHistoryFetchedRef.current = true;
    fetchServerHistory();
  }, [fetchServerHistory]);

  useEffect(() => {
    refreshProcessedRegistry();
  }, [refreshProcessedRegistry]);

  const handleSteamIdFileUpload = useCallback(async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const sanitized = extractUniqueSteamIds(text);
      if (!sanitized.length) {
        setErrorMessage('Nenhuma Steam ID válida foi encontrada no arquivo enviado.');
        setSteamIds('');
        return;
      }

      const limitedIds = sanitized.slice(0, MAX_STEAM_IDS);
      setSteamIds(limitedIds.join('\n'));
      if (sanitized.length > MAX_STEAM_IDS) {
        setErrorMessage(limitErrorMessage);
      } else {
        setErrorMessage(null);
      }
    } catch (error) {
      setErrorMessage('Não foi possível ler o arquivo enviado.');
    } finally {
      event.target.value = '';
    }
  }, [limitErrorMessage]);

  const handleProcessedIdsUpload = useCallback(async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const sanitized = extractUniqueSteamIds(text);
      if (!sanitized.length) {
        setStatusBanner({ type: 'warning', message: 'Nenhuma Steam ID válida foi encontrada no arquivo enviado.' });
        return;
      }

      setProcessedExclusions((previous) => {
        const merged = new Set(previous.ids || []);
        for (const id of sanitized) {
          merged.add(id);
        }
        return {
          ids: Array.from(merged),
          lastUpdated: new Date().toISOString(),
        };
      });
      setStatusBanner({
        type: 'success',
        message: `${sanitized.length.toLocaleString('pt-BR')} ID(s) adicionada(s) à exclusão local.`,
      });
    } catch (error) {
      setStatusBanner({ type: 'error', message: 'Não foi possível ler o arquivo de IDs processadas.' });
    } finally {
      event.target.value = '';
    }
  }, []);

  const handleClearProcessedExclusions = useCallback(() => {
    setProcessedExclusions({ ids: [], lastUpdated: null });
    setStatusBanner({ type: 'info', message: 'Lista de exclusão local limpa.' });
  }, []);

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

    const filteredIds = sanitizedSteamIds.filter((id) => !processedExclusionSet.has(id));
    if (filteredIds.length === 0) {
      setErrorMessage('Todos os IDs informados já constam como processados.');
      return;
    }

    pendingIdsRef.current = filteredIds;
    setProcessedProfiles([]);

    const payloadIds = filteredIds.join('\n');
    setSteamIds(payloadIds);

    setLogs([]);
    applyJobResultPayload(null);
    setErrorMessage(null);
    setStatusBanner(null);
    setIsProcessing(true);
    setIsPaused(false);
    setIsStoppingJob(false);
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
  }, [
    steamIds,
    sanitizedSteamIds,
    steamIdLimitExceeded,
    processedExclusionSet,
    webhookUrl,
    subscribeToJob,
    limitErrorMessage,
    applyJobResultPayload,
  ]);

  const handleDownloadReport = useCallback(() => {
    if (!jobResult?.reportHtml) {
      return;
    }
    const blob = new Blob([jobResult.reportHtml], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `relatorio_artcases_execucao_${new Date().toISOString().slice(0, 10)}.html`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [jobResult]);

  const handleDownloadHistory = useCallback(async () => {
    setStatusBanner(null);
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
      setStatusBanner({ type: 'success', message: 'Download do histórico iniciado com sucesso.' });
    } catch (error) {
      setStatusBanner({ type: 'error', message: error.message || 'Falha ao baixar o histórico de 24h.' });
    }
  }, []);

  const handleDownloadHistoryEntry = useCallback(
    async (entry) => {
      if (!entry) {
        setStatusBanner({ type: 'error', message: 'Registro selecionado inválido.' });
        return;
      }

      let html = entry.reportHtml;

      if (!html && entry.reportPath) {
        try {
          const response = await fetch(`/${entry.reportPath.replace(/^\/+/, '')}`);
          if (response.ok) {
            html = await response.text();
          }
        } catch (error) {
          console.warn('Falha ao baixar o HTML salvo no servidor.', error);
        }
      }

      if (!html) {
        setStatusBanner({ type: 'error', message: 'Este registro não possui HTML disponível para download.' });
        return;
      }

      const timestampSource = entry.generatedAt ? new Date(entry.generatedAt) : new Date();
      const safeTimestamp = Number.isNaN(timestampSource.getTime())
        ? new Date().toISOString()
        : timestampSource.toISOString();
      const sanitized = safeTimestamp.replace(/[:.]/g, '-');
      const prefix = entry.partial ? 'previa' : 'relatorio';

      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${prefix}_job_${entry.jobId || 'desconhecido'}_${sanitized}.html`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    },
    [setStatusBanner],
  );

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
    if (isStoppingJob) {
      setStatusBanner({ type: 'info', message: 'A finalização manual já está em andamento.' });
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
  }, [currentJobId, isStoppingJob]);

  const handleResumeJob = useCallback(async () => {
    if (!currentJobId) {
      return;
    }
    if (isStoppingJob) {
      setStatusBanner({ type: 'info', message: 'A finalização manual já está em andamento.' });
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
  }, [currentJobId, isStoppingJob]);

  const handleStopJob = useCallback(async () => {
    if (!currentJobId) {
      return;
    }
    if (isStoppingJob) {
      setStatusBanner({ type: 'info', message: 'Uma finalização manual já está em andamento.' });
      return;
    }
    setStatusBanner(null);
    setIsStoppingJob(true);
    try {
      const response = await fetch(`/process/${currentJobId}/stop`, { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || 'Não foi possível finalizar o processamento.');
      }
      setIsProcessing(false);
      setIsPaused(false);
      if (payload.finalized) {
        setIsStoppingJob(false);
        pendingIdsRef.current = [];
        setCurrentJobId(null);
        const clearedLink = updateJobReference(null);
        setActiveShareLink((previous) => previous || clearedLink);
        setStatusBanner({
          type: 'success',
          message: 'Processamento finalizado manualmente. Relatório consolidado com os dados disponíveis.',
        });
      } else {
        setStatusBanner({
          type: 'info',
          message: payload.reason || 'Finalização manual solicitada. O relatório será consolidado em instantes.',
        });
      }
    } catch (error) {
      console.warn('Falha ao finalizar o processamento manualmente.', error);
      setIsStoppingJob(false);
      setStatusBanner({ type: 'error', message: error.message || 'Falha ao finalizar o processamento.' });
    }
  }, [currentJobId, isStoppingJob, updateJobReference]);

  const handleGeneratePartialReport = useCallback(async () => {
    if (!currentJobId || isStoppingJob) {
      if (isStoppingJob) {
        setStatusBanner({ type: 'info', message: 'A finalização manual está em andamento. Aguarde a consolidação.' });
      }
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
      applyJobResultPayload(enriched);
      registerHistoryEntry(enriched);
      setStatusBanner({ type: 'success', message: 'Prévia HTML gerada e adicionada ao histórico.' });
    } catch (error) {
      setStatusBanner({ type: 'error', message: error.message || 'Falha ao gerar o relatório parcial.' });
    }
  }, [applyJobResultPayload, currentJobId, isStoppingJob, registerHistoryEntry]);

  const handleClearHistory = useCallback(() => {
    setReportHistory([]);
    setActiveHistoryId(null);
    setStatusBanner({ type: 'info', message: 'Histórico local apagado.' });
  }, []);

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
  const canControlJob = Boolean(currentJobId) && !isHydratingJob && !isStoppingJob;
  const statusLabel = isHydratingJob
    ? 'Sincronizando…'
    : isStoppingJob
      ? 'Finalizando…'
      : isProcessing
        ? 'Processando…'
        : isPaused
          ? 'Pausado'
          : jobResult
            ? 'Execução concluída'
            : 'Aguardando IDs';
  const statusTone = isHydratingJob
    ? 'processing'
    : isStoppingJob
      ? 'stopping'
      : isProcessing
        ? 'processing'
        : isPaused
          ? 'paused'
          : jobResult
            ? 'success'
            : 'idle';
  const activeHistoryEntry = reportHistory.find((entry) => entry.id === activeHistoryId) || null;

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

  const filtersSummaryMessage = 'Nenhum filtro automático aplicado — todos os perfis são analisados.';

  const metricTiles = useMemo(() => {
    if (!jobResult?.totals) {
      return [];
    }
    const totals = jobResult.totals;
    return [
      { label: 'IDs recebidas', value: totals.requested ?? 0 },
      { label: 'Processadas', value: totals.processed ?? 0 },
      { label: 'Inventários avaliados', value: jobResult.successCount ?? totals.clean ?? 0 },
      { label: 'VAC ban bloqueados', value: totals.vacBanned ?? 0 },
      { label: 'Falhas Steam', value: totals.steamErrors ?? 0 },
      { label: 'Falhas Montuga', value: totals.montugaErrors ?? 0 },
    ];
  }, [jobResult]);

  const numericProcessedTotal = Number(processedRegistry.total);
  const processedTotal = Number.isFinite(numericProcessedTotal)
    ? numericProcessedTotal
    : processedRegistry.ids.length;
  const processedPreviewCount = processedRegistry.ids.length;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-mini">
          <div className="logo-crop logo-crop-sidebar" aria-hidden="true">
            <img src="/assets/logo-artcases.svg" alt="" className="app-logo" />
          </div>
          <div className="brand-copy">
            <strong>Art Cases</strong>
            <small>Control</small>
          </div>
        </div>
        <nav className="sidebar-nav">
          {[
            ['analysis', '⌂', 'Main Analysis'],
            ['friends', '👥', 'Friends List'],
            ['reports', '🧾', 'Saved Reports'],
            ['history', '🗂', 'Processed IDs History'],
            ['settings', '⚙', 'Settings'],
          ].map(([key, icon, label]) => (
            <button
              key={key}
              type="button"
              className={`sidebar-item ${activeTab === key ? 'active' : ''}`}
              onClick={() => setActiveTab(key)}
            >
              <span className="icon">{icon}</span>
              <span className="label">{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-status">Backend connected</div>
      </aside>

      <div className="main-shell">
        <header className="top-header surface">
          <div className="title-wrap">
            <img src="/assets/logo-artcases.svg" alt="Art Cases logo" className="app-logo app-logo-header" />
            <div>
              <h1>Art Cases</h1>
              <p>Steam Inventory Monitor</p>
            </div>
          </div>
          <div className="header-chips">
            {currentJobId && <span className="job-pill">Job {currentJobId.slice(0, 8)}…</span>}
            <span className={`status-indicator status-${statusTone}`}>
              <span className="status-pulse" />
              {statusLabel}
            </span>
          </div>
        </header>

        {activeTab === 'analysis' && (
          <main className="workspace">
            <section className="metrics-row">
              <article className="metric"><span>Processed IDs</span><strong>{processedTotal.toLocaleString('pt-BR')}</strong></article>
              <article className="metric"><span>Evaluated Inventories</span><strong>{jobResult?.successCount ?? 0}</strong></article>
              <article className="metric"><span>VAC Blocked</span><strong>{jobResult?.totals?.vacBanned ?? 0}</strong></article>
              <article className="metric"><span>Failures</span><strong>{(jobResult?.totals?.steamErrors ?? 0) + (jobResult?.totals?.montugaErrors ?? 0)}</strong></article>
            </section>

            <section className="analysis-layout">
              <div className="surface form-card">
                {errorMessage && <div className="alert alert-error">{errorMessage}</div>}
                {statusBanner && <div className={`alert alert-${statusBanner.type}`}>{statusBanner.message}</div>}

                <form onSubmit={handleSubmit} className="control-form">
                  <label className="field-label" htmlFor="steam-ids">Steam IDs</label>
                  <textarea
                    id="steam-ids"
                    placeholder="Uma Steam ID64 por linha"
                    value={steamIds}
                    onChange={(event) => setSteamIds(event.target.value)}
                    rows={10}
                    disabled={isJobActive}
                    className={steamIdLimitExceeded ? 'input-error' : ''}
                  />
                  <p className={`field-counter ${steamIdLimitExceeded ? 'field-counter-error' : ''}`}>
                    {steamIdCount.toLocaleString('pt-BR')} / {formattedMaxSteamIds}
                  </p>
                  <input id="steam-ids-file" type="file" accept=".txt,text/plain" onChange={handleSteamIdFileUpload} disabled={isJobActive} className="file-input" />

                  <details className="advanced-options" open={Boolean(webhookUrl.trim())}>
                    <summary>Webhook (optional)</summary>
                    <input id="webhook-url" type="url" placeholder="https://seu-endpoint.com/notificacoes" value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} disabled={isJobActive} />
                  </details>

                  <div className="button-row">
                    <button
                      type="submit"
                      className="primary-btn"
                      disabled={isJobActive || isStoppingJob || !steamIds.trim() || steamIdLimitExceeded}
                      title={isJobActive ? 'Analysis already running' : 'Start analysis'}
                    >
                      {isJobActive ? 'Analysis Running…' : 'Start Analysis'}
                    </button>
                    <button type="button" className="secondary-btn" onClick={isPaused ? handleResumeJob : handlePauseJob} disabled={!canControlJob}>{isPaused ? 'Retomar' : 'Pause'}</button>
                    <button type="button" className="ghost-btn" onClick={handleStopJob} disabled={!canControlJob || isStoppingJob}>{isStoppingJob ? 'Finalizando…' : 'Finalize'}</button>
                  </div>
                  <div className="button-row utility-row">
                    <button type="button" className="ghost-btn" onClick={resetInterface} disabled={isJobActive || isStoppingJob}>Clear</button>
                    <button type="button" className="ghost-btn" onClick={handleGeneratePartialReport} disabled={!isPaused || !currentJobId || isStoppingJob}>Partial Report</button>
                    <button type="button" className="ghost-btn" onClick={handleDownloadHistory} disabled={(isProcessing && !isPaused) || isStoppingJob}>Download 24h</button>
                  </div>
                </form>
              </div>

              <div className="surface log-card">
                <div className="log-toolbar">
                  {activeShareLink && <button type="button" className="ghost-btn" onClick={handleCopyShareLink}>Copy tracking link</button>}
                  {jobResult?.reportHtml && <button type="button" className="ghost-btn" onClick={handleDownloadReport}>Open report</button>}
                </div>
                <div className="log-stream" ref={logContainerRef}>
                  {logs.length === 0 ? (
                    <div className="empty-state">Logs will appear here after start.</div>
                  ) : (
                    logs.map((entry, index) => (
                      <article key={`${entry.timestamp || 'log'}-${index}`} className={`log-entry log-${inferLogLevel(entry)}`}>
                        <span>{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('pt-BR') : '--:--:--'}</span>
                        <p>{entry.message || 'Evento recebido'}</p>
                      </article>
                    ))
                  )}
                </div>
              </div>
            </section>

            <section className="surface reports-compact">
              <div className="section-head">
                <h3>Saved reports</h3>
                <button type="button" className="ghost-btn" onClick={() => setActiveTab('reports')}>Open module</button>
              </div>
              <div className="compact-list">
                {reportHistory.slice(0, 3).map((entry) => (
                  <div className="compact-item" key={entry.id}>
                    <div>
                      <strong>{entry.partial ? 'Partial' : 'Final'} report</strong>
                      <span>{formatHistoryTimestamp(entry.generatedAt)}</span>
                    </div>
                    <button type="button" className="ghost-btn" onClick={() => handleSelectHistory(entry.id)}>View</button>
                  </div>
                ))}
                {reportHistory.length === 0 && <div className="empty-state">No saved reports yet.</div>}
              </div>
            </section>
          </main>
        )}

        {activeTab === 'friends' && (
          <section className="surface friends-panel">
            <form className="friends-form" onSubmit={handleFriendsSubmit}>
              <label className="field-label" htmlFor="friends-steam-ids">Steam IDs</label>
              <textarea id="friends-steam-ids" value={friendsInput} onChange={(event) => setFriendsInput(event.target.value)} rows={8} disabled={isFetchingFriends} />
              <div className="button-row">
                <button type="submit" className="primary-btn" disabled={isFetchingFriends || !friendsInput.trim()}>{isFetchingFriends ? 'Consultando…' : 'Buscar amigos'}</button>
                <button type="button" className="ghost-btn" onClick={resetFriendsInterface} disabled={isFetchingFriends}>Limpar</button>
              </div>
            </form>
            {friendsStatus && <div className="alert alert-success">{friendsStatus}</div>}
            {friendsError && <div className="alert alert-error">{friendsError}</div>}
          </section>
        )}

        {activeTab === 'reports' && (
          <section className="surface module-page">
            <div className="section-head">
              <h2>Saved Reports</h2>
              <button type="button" className="ghost-btn" onClick={handleClearHistory} disabled={reportHistory.length === 0}>Clear history</button>
            </div>
            <div className="compact-list">
              {reportHistory.map((entry) => (
                <div className="compact-item" key={entry.id}>
                  <div>
                    <strong>{entry.partial ? 'Partial' : 'Final'} - {entry.jobId}</strong>
                    <span>{formatHistoryTimestamp(entry.generatedAt)}</span>
                  </div>
                  <div className="button-row">
                    <button type="button" className="ghost-btn" onClick={() => handleSelectHistory(entry.id)}>Open</button>
                    <button type="button" className="ghost-btn" onClick={() => handleDownloadHistoryEntry(entry)}>Download</button>
                  </div>
                </div>
              ))}
            </div>
            {activeHistoryEntry?.reportHtml && <iframe title="Report preview" srcDoc={activeHistoryEntry.reportHtml} className="history-frame" sandbox="allow-same-origin allow-scripts" />}
          </section>
        )}

        {activeTab === 'history' && (
          <section className="surface module-page">
            <div className="section-head">
              <h2>Processed IDs History</h2>
              <button type="button" className="ghost-btn" onClick={refreshProcessedRegistry} disabled={processedRegistry.isLoading}>{processedRegistry.isLoading ? 'Atualizando…' : 'Atualizar'}</button>
            </div>
            <p>Total: {processedTotal.toLocaleString('pt-BR')} IDs</p>
            <input type="file" className="file-input" accept=".txt,text/plain" onChange={handleProcessedIdsUpload} />
            <button type="button" className="ghost-btn" onClick={handleClearProcessedExclusions} disabled={processedExclusions.ids.length === 0}>Limpar exclusões</button>
            <ul className="registry-preview">
              {processedRegistry.ids.map((id) => <li key={id}>{id}</li>)}
            </ul>
          </section>
        )}

        {activeTab === 'settings' && (
          <section className="surface module-page">
            <h2>Settings</h2>
            <label className="field-label" htmlFor="settings-webhook">Webhook URL</label>
            <input id="settings-webhook" type="url" value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} />
            <p className="field-hint">Optional external notifications endpoint.</p>
          </section>
        )}
      </div>
    </div>
  );

}

export default App;
