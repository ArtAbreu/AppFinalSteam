import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import './App.css';

const MAX_STEAM_IDS = 10000;
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
  const [friendsLevelThreshold, setFriendsLevelThreshold] = useState('16');
  const [friendsLevelComparator, setFriendsLevelComparator] = useState('gte');
  const [friendsIncludeMissingData, setFriendsIncludeMissingData] = useState(true);
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
  const [processedRegistry, setProcessedRegistry] = useState(() => ({
    total: 0,
    ids: [],
    isLoading: false,
    error: null,
    lastUpdated: null,
  }));

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
    setIsStoppingJob(false);
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
    setFriendsLevelThreshold('16');
    setFriendsLevelComparator('gte');
    setFriendsIncludeMissingData(true);
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

    const thresholdText = friendsLevelThreshold.trim();
    let normalizedThreshold = null;
    if (thresholdText.length > 0) {
      const parsedThreshold = Number(thresholdText);
      if (Number.isFinite(parsedThreshold)) {
        normalizedThreshold = Math.max(0, Math.min(500, Math.floor(parsedThreshold)));
        if (String(normalizedThreshold) !== thresholdText) {
          setFriendsLevelThreshold(String(normalizedThreshold));
        }
      }
    }

    const comparator = friendsLevelComparator === 'lte' ? 'lte' : 'gte';
    const includeMissingData = Boolean(friendsIncludeMissingData);

    const requestPayload = {
      steamIds: ids,
      filters: {
        levelComparator: comparator,
        includeMissingData,
      },
    };

    if (normalizedThreshold !== null) {
      requestPayload.filters.levelThreshold = normalizedThreshold;
    }

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
        const referenceEntry = payload.find((entry) => !entry?.error && entry?.stats);
        const levelThreshold = Number.isFinite(referenceEntry?.stats?.levelThreshold)
          ? referenceEntry.stats.levelThreshold
          : normalizedThreshold ?? 16;
        const levelComparator = referenceEntry?.stats?.levelComparator === 'lte' ? 'lte' : 'gte';
        const comparatorSymbol = levelComparator === 'lte' ? '≤' : '≥';
        const totals = payload.reduce(
          (accumulator, entry) => {
            if (!entry?.error && entry?.stats) {
              const kept = Array.isArray(entry?.friends) ? entry.friends.length : 0;
              const eligible = Number.isFinite(entry.stats.offlineEligible) ? entry.stats.offlineEligible : 0;
              const missingIncluded =
                (Number.isFinite(entry.stats.includedMissingProfile)
                  ? entry.stats.includedMissingProfile
                  : 0) +
                (Number.isFinite(entry.stats.includedUnknownLevel)
                  ? entry.stats.includedUnknownLevel
                  : 0);
              return {
                kept: accumulator.kept + kept,
                offlineEligible: accumulator.offlineEligible + eligible,
                includedMissing: accumulator.includedMissing + missingIncluded,
              };
            }
            return accumulator;
          },
          { kept: 0, offlineEligible: 0, includedMissing: 0 },
        );

        const discardedCount = Math.max(totals.offlineEligible - totals.kept, 0);
        const thresholdMessage = `nível ${comparatorSymbol} ${levelThreshold}`;
        const rejectedMessageComparator =
          levelComparator === 'lte' ? `nível > ${levelThreshold}` : `nível < ${levelThreshold}`;

        if (totals.kept > 0) {
          const baseMessage = `Encontramos ${totals.kept} amigos que atendem aos filtros selecionados (offline/fora de jogo quando disponível e ${thresholdMessage}).`;
          const discardedMessage =
            discardedCount > 0
              ? ` ${discardedCount} foram descartados por não respeitarem o limite de nível (${rejectedMessageComparator}).`
              : '';
          const missingMessage =
            totals.includedMissing > 0
              ? ` ${totals.includedMissing} IDs foram mantidos mesmo sem dados completos, conforme sua preferência.`
              : '';
          setFriendsStatus(`${baseMessage}${discardedMessage}${missingMessage}`);
        } else {
          setFriendsStatus(
            `Nenhum amigo atendeu aos filtros selecionados (offline/fora de jogo quando disponível e ${thresholdMessage}).`,
          );
        }
      }
    } catch (error) {
      setFriendsResults([]);
      setFriendsError(error.message || 'Falha ao consultar as listas de amigos.');
    } finally {
      setIsFetchingFriends(false);
    }
  }, [
    friendsIncludeMissingData,
    friendsInput,
    friendsLevelComparator,
    friendsLevelThreshold,
  ]);

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
        setJobResult(enriched);
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
            setJobResult(payload);
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
  }, [registerHistoryEntry, updateJobReference]);

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
        setJobResult(payload);
        registerHistoryEntry(payload);
      } else {
        setJobResult(null);
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
  }, [registerHistoryEntry, subscribeToJob, updateJobReference]);

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

      setProcessedRegistry({
        total,
        ids: ids.slice(0, PROCESSED_PREVIEW_LIMIT),
        isLoading: false,
        error: null,
        lastUpdated: new Date().toISOString(),
      });
    } catch (error) {
      setProcessedRegistry((previous) => ({
        ...previous,
        isLoading: false,
        error: error.message || 'Não foi possível carregar o histórico de IDs processadas.',
      }));
    }
  }, []);

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

  useEffect(() => {
    if (!isAuthenticated || serverHistoryFetchedRef.current) {
      return;
    }
    serverHistoryFetchedRef.current = true;
    fetchServerHistory();
  }, [fetchServerHistory, isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    refreshProcessedRegistry();
  }, [isAuthenticated, refreshProcessedRegistry]);

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
  }, [steamIds, sanitizedSteamIds, steamIdLimitExceeded, webhookUrl, subscribeToJob, limitErrorMessage]);

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
      setJobResult(enriched);
      registerHistoryEntry(enriched);
      setStatusBanner({ type: 'success', message: 'Prévia HTML gerada e adicionada ao histórico.' });
    } catch (error) {
      setStatusBanner({ type: 'error', message: error.message || 'Falha ao gerar o relatório parcial.' });
    }
  }, [currentJobId, isStoppingJob, registerHistoryEntry]);

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

  const numericProcessedTotal = Number(processedRegistry.total);
  const processedTotal = Number.isFinite(numericProcessedTotal)
    ? numericProcessedTotal
    : processedRegistry.ids.length;
  const processedPreviewCount = processedRegistry.ids.length;

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
                <button
                  type="submit"
                  className="primary-btn"
                  disabled={isJobActive || isStoppingJob || !steamIds.trim() || steamIdLimitExceeded}
                >
                  Iniciar análise
                </button>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={resetInterface}
                  disabled={isJobActive || isStoppingJob}
                >
                  Limpar interface
                </button>
              </div>

              {(isJobActive || (isStoppingJob && currentJobId)) && (
                <div className="button-row secondary-controls">
                  {canControlJob && (
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={isPaused ? handleResumeJob : handlePauseJob}
                      disabled={!canControlJob || isStoppingJob}
                    >
                      {isPaused ? 'Retomar análise' : 'Pausar análise'}
                    </button>
                  )}
                  {canControlJob && (
                    <button
                      type="button"
                      className="ghost-btn"
                      onClick={handleGeneratePartialReport}
                      disabled={!isPaused || !canControlJob || isStoppingJob}
                    >
                      Gerar relatório parcial
                    </button>
                  )}
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={isPaused ? handleResumeJob : handlePauseJob}
                    disabled={!currentJobId || isStoppingJob}
                  >
                    {isPaused ? 'Retomar análise' : 'Pausar análise'}
                  </button>
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={handleGeneratePartialReport}
                    disabled={!isPaused || !currentJobId || isStoppingJob}
                  >
                    {isStoppingJob ? 'Finalizando…' : 'Finalizar análise'}
                  </button>
                  <button
                    type="button"
                    className={`danger-btn full-width-control${isStoppingJob ? ' danger-btn-pending' : ''}`}
                    onClick={handleStopJob}
                    disabled={!currentJobId || isStoppingJob}
                  >
                    {isStoppingJob ? 'Finalizando…' : 'Finalizar análise'}
                  </button>
                </div>
              )}

              <button
                type="button"
                className="secondary-btn"
                onClick={handleDownloadHistory}
                disabled={(isProcessing && !isPaused) || isStoppingJob}
              >
                Download histórico (24h)
              </button>
            </form>

            <p className="helper-text">Cada requisição verifica o status de VAC ban diretamente na Steam antes de qualquer consulta à Montuga API.</p>
          </div>

            <div className="surface registry-card">
              <div className="card-header compact">
                <h2>Histórico de IDs processadas</h2>
                <p>IDs já avaliadas são removidas automaticamente dos próximos envios.</p>
              </div>

              <div className="registry-meta-row">
                <div className="registry-total">
                  <span className="registry-total-label">Total armazenado</span>
                  <strong className="registry-total-value">{processedTotal.toLocaleString('pt-BR')}</strong>
                  {processedRegistry.lastUpdated && (
                    <span className="registry-updated">
                      Atualizado {formatHistoryTimestamp(processedRegistry.lastUpdated)}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="ghost-btn ghost-compact"
                  onClick={refreshProcessedRegistry}
                  disabled={processedRegistry.isLoading}
                >
                  {processedRegistry.isLoading ? 'Atualizando…' : 'Atualizar'}
                </button>
              </div>

              {processedRegistry.error ? (
                <div className="registry-alert registry-alert-error">{processedRegistry.error}</div>
              ) : processedRegistry.isLoading && processedPreviewCount === 0 ? (
                <div className="registry-loading">Carregando histórico de IDs…</div>
              ) : processedPreviewCount > 0 ? (
                <>
                  <p className="registry-caption">
                    Exibindo {processedPreviewCount.toLocaleString('pt-BR')} ID(s) mais recentes de um total de{' '}
                    {processedTotal.toLocaleString('pt-BR')} armazenadas no servidor.
                  </p>
                  <ul className="registry-preview">
                    {processedRegistry.ids.map((id) => (
                      <li key={id} className="registry-preview-item">{id}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <div className="registry-empty">Nenhum Steam ID processado foi registrado ainda.</div>
              )}
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

          {reportHistory.length > 0 && (
            <div className="surface history-card">
              <div className="card-header history-header">
                <div>
                  <h2>Relatórios salvos</h2>
                  <p className="card-subtitle">Cada geração concluída fica disponível para consulta rápida.</p>
                </div>
                <button type="button" className="ghost-btn ghost-compact" onClick={handleClearHistory}>
                  Limpar histórico
                </button>
              </div>
              <div className="history-tabs">
                {reportHistory.map((entry) => (
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
                  </div>
                  <div className="history-actions">
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => handleDownloadHistoryEntry(activeHistoryEntry)}
                    >
                      Baixar HTML
                    </button>
                  </div>
                  <div className="history-frame">
                    {activeHistoryEntry.reportHtml ? (
                      <iframe
                        title={`Relatório salvo ${formatHistoryTimestamp(activeHistoryEntry.generatedAt)}`}
                        srcDoc={activeHistoryEntry.reportHtml}
                        sandbox="allow-same-origin allow-scripts"
                      />
                    ) : activeHistoryEntry.reportPath ? (
                      <iframe
                        title={`Relatório salvo ${formatHistoryTimestamp(activeHistoryEntry.generatedAt)}`}
                        src={`/${activeHistoryEntry.reportPath.replace(/^\/+/, '')}`}
                        sandbox="allow-same-origin allow-scripts"
                      />
                    ) : (
                      <div className="history-frame-empty">Nenhum HTML disponível para este relatório.</div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="history-empty">Selecione um relatório para visualizar.</div>
              )}
            </div>
          )}
            </section>
          </div>
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
              <div className="friends-filter-controls">
                <div className="friends-filter-group">
                  <span className="field-label">Filtro de nível</span>
                  <div className="friends-filter-row">
                    <select
                      value={friendsLevelComparator}
                      onChange={(event) =>
                        setFriendsLevelComparator(event.target.value === 'lte' ? 'lte' : 'gte')
                      }
                      disabled={isFetchingFriends}
                    >
                      <option value="gte">Maior ou igual a</option>
                      <option value="lte">Menor ou igual a</option>
                    </select>
                    <input
                      type="number"
                      min="0"
                      max="500"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={friendsLevelThreshold}
                      onChange={(event) => {
                        const { value } = event.target;
                        if (value === '') {
                          setFriendsLevelThreshold('');
                          return;
                        }
                        const parsedValue = Number(value);
                        if (!Number.isFinite(parsedValue)) {
                          return;
                        }
                        const normalizedValue = Math.max(0, Math.min(500, Math.floor(parsedValue)));
                        setFriendsLevelThreshold(String(normalizedValue));
                      }}
                      disabled={isFetchingFriends}
                      aria-label="Limite de nível"
                    />
                    <span className="friends-filter-suffix">nível</span>
                  </div>
                  <p className="friends-filter-hint">
                    Ajuste o limite para buscar perfis acima ou abaixo do nível desejado.
                  </p>
                </div>
                <label className="friends-filter-toggle">
                  <input
                    type="checkbox"
                    checked={friendsIncludeMissingData}
                    onChange={(event) => setFriendsIncludeMissingData(event.target.checked)}
                    disabled={isFetchingFriends}
                  />
                  <span>Incluir perfis sem dados de nível ou resumo</span>
                </label>
              </div>
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
                  const stats = result?.stats || {};
                  const totalFriends = Number.isFinite(stats.totalFriends)
                    ? stats.totalFriends
                    : typeof result?.friendCount === 'number'
                      ? result.friendCount
                      : Array.isArray(result?.friends)
                        ? result.friends.length
                        : 0;
                  const keptFriends = Number.isFinite(stats.kept)
                    ? stats.kept
                    : Array.isArray(result?.friends)
                      ? result.friends.length
                      : 0;
                  const offlineEligible = Number.isFinite(stats.offlineEligible)
                    ? stats.offlineEligible
                    : keptFriends;
                  const levelThreshold = Number.isFinite(stats.levelThreshold) ? stats.levelThreshold : 16;
                  const levelComparator = stats.levelComparator === 'lte' ? 'lte' : 'gte';
                  const comparatorSymbol = levelComparator === 'lte' ? '≤' : '≥';
                  const filteredByLevel = Number.isFinite(stats.filteredByLevel) ? stats.filteredByLevel : 0;
                  const filteredMissingTotal =
                    (Number.isFinite(stats.filteredMissingProfile) ? stats.filteredMissingProfile : 0) +
                    (Number.isFinite(stats.filteredUnknownLevel) ? stats.filteredUnknownLevel : 0);
                  const includedMissingTotal =
                    (Number.isFinite(stats.includedMissingProfile) ? stats.includedMissingProfile : 0) +
                    (Number.isFinite(stats.includedUnknownLevel) ? stats.includedUnknownLevel : 0);
                  const levelFilteredLabel =
                    levelComparator === 'lte'
                      ? `Nível ≥ ${levelThreshold + 1}`
                      : `Nível ≤ ${Math.max(levelThreshold - 1, 0)}`;

                  const filteredBreakdown = [];
                  if (Number.isFinite(stats.filteredOnline) && stats.filteredOnline > 0) {
                    filteredBreakdown.push({ label: 'Online/ocupados', value: stats.filteredOnline });
                  }
                  if (Number.isFinite(stats.filteredInGame) && stats.filteredInGame > 0) {
                    filteredBreakdown.push({ label: 'Em jogo', value: stats.filteredInGame });
                  }
                  if (filteredByLevel > 0) {
                    filteredBreakdown.push({ label: levelFilteredLabel, value: filteredByLevel });
                  }
                  if (filteredMissingTotal > 0) {
                    filteredBreakdown.push({ label: 'Sem dados (descartados)', value: filteredMissingTotal });
                  }
                  if (includedMissingTotal > 0) {
                    filteredBreakdown.push({ label: 'Sem dados (incluídos)', value: includedMissingTotal, type: 'included' });
                  }

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
                          {result?.error ? 'Erro' : `${keptFriends}/${totalFriends} aprovados`}
                        </span>
                      </div>
                      {result?.error ? (
                        <p className="friends-result-error">{result.error}</p>
                      ) : (
                        <>
                          <div className="friends-stat-grid">
                            <div className="friends-stat-card friends-stat-card-total">
                              <span className="friends-stat-value">{totalFriends}</span>
                              <span className="friends-stat-label">Total na Steam</span>
                            </div>
                            <div className="friends-stat-card friends-stat-card-highlight">
                              <span className="friends-stat-value">{keptFriends}</span>
                              <span className="friends-stat-label">Aprovados (nível {comparatorSymbol} {levelThreshold})</span>
                            </div>
                            <div className="friends-stat-card">
                              <span className="friends-stat-value">{offlineEligible}</span>
                              <span className="friends-stat-label">Offline & fora de jogo (com dados)</span>
                            </div>
                          </div>
                          <div className="friends-filter-summary">
                            {filteredBreakdown.length > 0 ? (
                              filteredBreakdown.map((item) => (
                                <span
                                  key={item.label}
                                  className={`friends-filter-chip${item.type === 'included' ? ' friends-filter-chip-included' : ''}`}
                                >
                                  <span className="friends-filter-label">{item.label}</span>
                                  <span className="friends-filter-value">{item.value}</span>
                                </span>
                              ))
                            ) : (
                              <span className="friends-filter-empty">Nenhum amigo foi descartado pelos filtros.</span>
                            )}
                          </div>
                          <div className="friends-list-wrapper">
                            {Array.isArray(result?.friends) && result.friends.length > 0 ? (
                              <>
                                <p className="friends-list-description">IDs aprovados</p>
                                <pre className="friends-list">{result.friends.join('\n')}</pre>
                              </>
                            ) : (
                              <p className="friends-list-empty">
                                Nenhum amigo atendeu aos filtros selecionados (offline/fora de jogo quando disponível e nível {comparatorSymbol}{' '}
                                {levelThreshold}).
                              </p>
                            )}
                          </div>
                        </>
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
                <div className="friends-actions-info">
                  <span className="friends-actions-total">{totalApprovedFriends}</span>
                  <span>IDs aprovados prontos para download</span>
                </div>
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={handleDownloadFriends}
                  disabled={totalApprovedFriends === 0}
                >
                  Baixar IDs filtrados (.txt)
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
