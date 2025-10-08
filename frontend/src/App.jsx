import React, { useState, useRef, useEffect, useCallback } from 'react';
import './App.css';

function App() {
  const [steamIds, setSteamIds] = useState('');
  const [pendingIds, setPendingIds] = useState([]);
  const [logs, setLogs] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [jobResult, setJobResult] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [statusBanner, setStatusBanner] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [authError, setAuthError] = useState(null);

  const logContainerRef = useRef(null);
  const eventSourceRef = useRef(null);
  const finishedRef = useRef(false);
  const passwordFieldRef = useRef(null);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  useEffect(() => {
    if (!isAuthenticated && passwordFieldRef.current) {
      passwordFieldRef.current.focus();
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const storedAuth = sessionStorage.getItem('artcases-authenticated');
    if (storedAuth === 'true') {
      setIsAuthenticated(true);
    }
  }, []);

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
    setPendingIds([]);
    setLogs([]);
    setJobResult(null);
    setErrorMessage(null);
    setStatusBanner(null);
    setIsProcessing(false);
  }, [closeEventSource]);

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

    eventSource.addEventListener('complete', (event) => {
      finishedRef.current = true;
      try {
        const payload = JSON.parse(event.data);
        setJobResult(payload);
        setErrorMessage(null);
        setPendingIds([]);
      } catch (error) {
        setErrorMessage('Processamento concluído, mas não foi possível ler o relatório.');
      }
      setIsProcessing(false);
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
      setPendingIds([]);
      eventSource.close();
      eventSourceRef.current = null;
    });

    eventSource.addEventListener('progress', (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.processedId) {
          setPendingIds((previous) => {
            const next = [...previous];
            const index = next.indexOf(payload.processedId);
            if (index >= 0) {
              next.splice(index, 1);
            }
            return next;
          });
          setSteamIds((prev) => {
            if (!prev.trim()) {
              return '';
            }
            const ids = prev.split(/\s+/).filter(Boolean);
            const index = ids.indexOf(payload.processedId);
            if (index >= 0) {
              ids.splice(index, 1);
            }
            return ids.join('\n');
          });
        }
      } catch (error) {
        console.warn('Falha ao interpretar progresso do job.', error);
      }
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

    const normalizedIds = steamIds
      .split(/\s+/)
      .map((id) => id.trim())
      .filter(Boolean);

    const uniqueIds = Array.from(new Set(normalizedIds));
    setPendingIds(uniqueIds);
    setSteamIds(uniqueIds.join('\n'));
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
        body: `steam_ids=${encodeURIComponent(uniqueIds.join('\n'))}`,
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

  const downloadHtmlDocument = useCallback((html, prefix) => {
    if (!html) {
      return;
    }
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${prefix}_${new Date().toISOString().slice(0, 10)}.html`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, []);

  const handleDownloadReport = useCallback(() => {
    downloadHtmlDocument(jobResult?.reportHtml, 'relatorio_artcases_execucao');
  }, [downloadHtmlDocument, jobResult]);

  const handleDownloadInsights = useCallback(() => {
    downloadHtmlDocument(jobResult?.analysisHtml, 'relatorio_artcases_inteligencia');
  }, [downloadHtmlDocument, jobResult]);

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

  const handleAuthenticate = useCallback((event) => {
    event.preventDefault();
    if (passwordInput === 'Artzin017') {
      setIsAuthenticated(true);
      setAuthError(null);
      setPasswordInput('');
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('artcases-authenticated', 'true');
      }
      return;
    }
    setAuthError('Senha inválida. Tente novamente.');
  }, [passwordInput]);

  const handleLogout = useCallback(() => {
    resetInterface();
    setPasswordInput('');
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem('artcases-authenticated');
    }
    setIsAuthenticated(false);
  }, [resetInterface]);

  const pendingLabel = pendingIds.length ? `${pendingIds.length} ID(s) restantes` : 'Nenhuma ID pendente';

  if (!isAuthenticated) {
    return (
      <div className="login-shell">
        <form className="login-card" onSubmit={handleAuthenticate}>
          <h1>Art Cases — Painel restrito</h1>
          <p>Informe a senha de acesso para continuar.</p>
          <label htmlFor="password" className="field-label">Senha de acesso</label>
          <input
            ref={passwordFieldRef}
            id="password"
            type="password"
            value={passwordInput}
            onChange={(event) => setPasswordInput(event.target.value)}
            placeholder="Digite a senha fornecida"
            autoComplete="current-password"
          />
          {authError && <div className="alert alert-error">{authError}</div>}
          <button type="submit" className="primary-btn full">Entrar</button>
        </form>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <div className="topbar">
          <div className="brand">Art Cases Intelligence</div>
          <button type="button" className="logout-btn" onClick={handleLogout}>
            Sair com segurança
          </button>
        </div>
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

              <div className="pending-banner" aria-live="polite">
                <span className="dot" />
                {pendingLabel}
              </div>

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
                <div className="metric-tile">
                  <span className="metric-label">Cotação utilizada</span>
                  <strong className="metric-value">R$ {(jobResult.conversionRate ?? 0).toFixed(2)}</strong>
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

          {jobResult?.analysisHtml && (
            <div className="surface report-card">
              <div className="card-header report-header">
                <div>
                  <h2>Insights inteligentes</h2>
                  <p className="card-subtitle">Contas priorizadas pelo motor analítico proprietário.</p>
                </div>
                <button type="button" className="secondary-btn" onClick={handleDownloadInsights}>
                  Baixar HTML
                </button>
              </div>
              <div className="report-frame">
                <iframe
                  title="Relatório inteligente"
                  srcDoc={jobResult.analysisHtml}
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
