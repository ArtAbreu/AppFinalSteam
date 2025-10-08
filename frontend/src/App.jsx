import React, { useState, useRef, useEffect, useCallback } from 'react';
import './App.css';

function App() {
  const [steamIds, setSteamIds] = useState('');
  const [logs, setLogs] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [jobResult, setJobResult] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [statusBanner, setStatusBanner] = useState(null);
  const [processedProfiles, setProcessedProfiles] = useState([]);

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

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  useEffect(() => () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
  }, []);

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
    pendingIdsRef.current = [];
  }, [closeEventSource]);

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

  const subscribeToJob = useCallback((jobId) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    finishedRef.current = false;
    const eventSource = new EventSource(`/process/${jobId}/stream`);
    eventSourceRef.current = eventSource;

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
          const existingIndex = previous.findIndex((item) => item.id === payload.id);
          if (existingIndex >= 0) {
            const clone = [...previous];
            clone[existingIndex] = { ...clone[existingIndex], ...payload };
            return clone;
          }
          return [...previous, payload];
        });

        pendingIdsRef.current = pendingIdsRef.current.filter((id) => id !== payload.id);
        setSteamIds(pendingIdsRef.current.join('\n'));
      } catch (error) {
        console.warn('Não foi possível interpretar a notificação de perfil processado.', error);
      }
    });

    eventSource.addEventListener('complete', (event) => {
      finishedRef.current = true;
      try {
        const payload = JSON.parse(event.data);
        setJobResult(payload);
        setErrorMessage(null);
      } catch (error) {
        setErrorMessage('Processamento concluído, mas não foi possível ler o relatório.');
      }
      setIsProcessing(false);
      pendingIdsRef.current = [];
      eventSource.close();
      eventSourceRef.current = null;
    });

    eventSource.addEventListener('job-error', (event) => {
      finishedRef.current = true;
      try {
        const payload = JSON.parse(event.data);
        setErrorMessage(payload.error || 'Falha ao processar as IDs informadas.');
      } catch (error) {
        setErrorMessage('Erro durante o processamento das IDs.');
      }
      setIsProcessing(false);
      pendingIdsRef.current = [];
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
            setJobResult(payload);
            setErrorMessage(null);
          } else if (payload.error) {
            setErrorMessage(payload.error);
          }
        } else if (fallbackResponse.status !== 202) {
          const payload = await fallbackResponse.json().catch(() => ({}));
          setErrorMessage(payload.error || 'Conexão com o servidor perdida durante o processamento.');
        }
      } catch (error) {
        setErrorMessage('Não foi possível restabelecer a conexão com o servidor.');
      } finally {
        setIsProcessing(false);
        finishedRef.current = true;
      }
    };
  }, []);

  const handleSubmit = useCallback(async (event) => {
    event.preventDefault();

    if (!steamIds.trim()) {
      setErrorMessage('Informe ao menos uma Steam ID (64 bits).');
      return;
    }

    const sanitizedList = Array.from(new Set(steamIds
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean)));

    if (!sanitizedList.length) {
      setErrorMessage('Informe ao menos uma Steam ID (64 bits).');
      return;
    }

    pendingIdsRef.current = sanitizedList;
    setProcessedProfiles([]);

    const payloadIds = sanitizedList.join('\n');
    setSteamIds(payloadIds);

    setLogs([]);
    setJobResult(null);
    setErrorMessage(null);
    setStatusBanner(null);
    setIsProcessing(true);

    try {
      const response = await fetch('/process', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `steam_ids=${encodeURIComponent(payloadIds)}`,
      });

      const data = await response.json().catch(() => ({}));

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
      subscribeToJob(data.jobId);
    } catch (error) {
      setErrorMessage('Erro de rede ao iniciar o processamento.');
      setIsProcessing(false);
    }
  }, [steamIds, subscribeToJob]);

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
        const message = await response.text();
        throw new Error(message || 'Nenhum relatório disponível nas últimas 24 horas.');
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

  const statusLabel = isProcessing
    ? 'Processando…'
    : jobResult
      ? 'Execução concluída'
      : 'Aguardando IDs';
  const statusTone = isProcessing ? 'processing' : jobResult ? 'success' : 'idle';

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
            placeholder="Digite a senha Artzin017"
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
              <textarea
                id="steam-ids"
                placeholder="Cole uma Steam ID (64 bits) por linha. Ex: 76561198000000000"
                value={steamIds}
                onChange={(event) => setSteamIds(event.target.value)}
                rows={10}
                disabled={isProcessing}
              />

              <div className="button-row">
                <button type="submit" className="primary-btn" disabled={isProcessing || !steamIds.trim()}>
                  Iniciar análise
                </button>
                <button type="button" className="ghost-btn" onClick={resetInterface} disabled={isProcessing && !jobResult && logs.length <= 1 && !steamIds}>
                  Limpar interface
                </button>
              </div>

              <button type="button" className="secondary-btn" onClick={handleDownloadHistory} disabled={isProcessing}>
                Download histórico (24h)
              </button>
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
                <h2>Resumo da execução</h2>
                <p>Dados consolidados da última análise concluída.</p>
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
              <span className={`status-indicator status-${statusTone}`}>
                <span className="status-pulse" />
                {statusLabel}
              </span>
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
                  <h2>Relatório detalhado</h2>
                  <p className="card-subtitle">Visualize o relatório renderizado diretamente dentro do painel.</p>
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
