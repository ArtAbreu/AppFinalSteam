import React, { useState, useRef, useEffect, useCallback } from 'react';
import './App.css';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeSteamId(value) {
  const digits = String(value ?? '').trim().replace(/[^0-9]/g, '');
  return /^\d{17}$/.test(digits) ? digits : null;
}

function extractUniqueSteamIds(text) {
  const unique = new Set();
  for (const chunk of String(text ?? '').split(/[\s,;]+/)) {
    const id = sanitizeSteamId(chunk);
    if (id) unique.add(id);
  }
  return Array.from(unique);
}

function fmtBRL(value) {
  if (typeof value !== 'number') return '—';
  return `R$ ${value.toFixed(2)}`;
}

function fmtLastLogin(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function downloadHtml(html, filename) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadTxt(text, filename) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function apiHeaders(password) {
  const h = { 'Content-Type': 'application/json' };
  if (password) h['x-panel-password'] = password;
  return h;
}

const TABS = [
  { id: 'analise',       label: 'Análise',       icon: '⚡' },
  { id: 'resultados',    label: 'Resultados',     icon: '📦' },
  { id: 'historico',     label: 'Histórico',      icon: '🕓' },
  { id: 'configuracoes', label: 'Config',         icon: '⚙' },
];

// ─── Login ────────────────────────────────────────────────────────────────────

function LoginScreen({ onLogin }) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok) {
        onLogin(pw);
      } else {
        setError(data.error || 'Senha incorreta.');
      }
    } catch {
      setError('Erro de conexão com o servidor.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <p className="login-eyebrow">Art Cases</p>
        <h1 className="login-title">Painel de controle</h1>
        <form className="login-form" onSubmit={handleSubmit}>
          <input
            type="password"
            className="login-input"
            placeholder="Senha de acesso"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            autoFocus
          />
          {error && <p className="login-error">{error}</p>}
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? 'Verificando…' : 'Entrar'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Tab Nav ──────────────────────────────────────────────────────────────────

function TabNav({ active, onChange }) {
  return (
    <nav className="tab-nav">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          className={`tab-btn${active === tab.id ? ' tab-btn--active' : ''}`}
          onClick={() => onChange(tab.id)}
          type="button"
        >
          <span className="tab-icon">{tab.icon}</span>
          <span className="tab-label">{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}

// ─── Log Viewer ───────────────────────────────────────────────────────────────

function LogViewer({ logs }) {
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  if (!logs.length) {
    return <div className="log-empty">Os logs aparecerão aqui durante o processamento.</div>;
  }

  return (
    <div className="log-viewer">
      {logs.map((log, i) => (
        <div key={i} className={`log-line log-line--${log.type || 'info'}`}>
          <span className="log-time">
            {new Date(log.timestamp).toLocaleTimeString('pt-BR')}
          </span>
          <span className="log-msg">{log.message}</span>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

// ─── Análise Tab ──────────────────────────────────────────────────────────────

function AnaliseTab({ password, onProfilesUpdate, onJobComplete }) {
  const [steamIds, setSteamIds]         = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPaused, setIsPaused]         = useState(false);
  const [isStopping, setIsStopping]     = useState(false);
  const [currentJobId, setCurrentJobId] = useState(null);
  const [logs, setLogs]                 = useState([]);
  const [jobStats, setJobStats]         = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);

  // Friends list
  const [showFriends, setShowFriends]         = useState(false);
  const [friendsInput, setFriendsInput]       = useState('');
  const [isFetching, setIsFetching]           = useState(false);
  const [friendsResults, setFriendsResults]   = useState([]);
  const [friendsError, setFriendsError]       = useState('');

  const eventSourceRef = useRef(null);

  const idCount = extractUniqueSteamIds(steamIds).length;

  function addLog(log) {
    setLogs((prev) => {
      const next = [...prev, log];
      return next.length > 1000 ? next.slice(next.length - 1000) : next;
    });
  }

  function connectStream(jobId) {
    if (eventSourceRef.current) eventSourceRef.current.close();
    const es = new EventSource(`/process/${jobId}/stream`);
    eventSourceRef.current = es;

    es.addEventListener('log', (e) => {
      try { addLog(JSON.parse(e.data)); } catch {}
    });

    es.addEventListener('profile-processed', (e) => {
      try {
        const profile = JSON.parse(e.data);
        onProfilesUpdate((prev) => [...prev, profile]);
        setJobStats((s) => s ? { ...s, processed: (s.processed || 0) + 1 } : s);
        setSteamIds((prev) =>
          prev.split(/[\s,;]+/)
            .filter((tok) => sanitizeSteamId(tok) !== profile.id)
            .join('\n')
        );
      } catch {}
    });

    es.addEventListener('complete', (e) => {
      try {
        const result = JSON.parse(e.data);
        onJobComplete(result);
        setIsProcessing(false);
        setIsPaused(false);
        setIsStopping(false);
      } catch {}
    });

    es.addEventListener('job-paused', () => {
      setIsPaused(true);
    });

    es.addEventListener('job-resumed', () => {
      setIsPaused(false);
    });

    es.addEventListener('job-error', (e) => {
      try {
        const { error } = JSON.parse(e.data);
        addLog({ message: `Erro: ${error}`, type: 'error', timestamp: Date.now() });
      } catch {}
      setIsProcessing(false);
      setIsPaused(false);
      setIsStopping(false);
    });

    es.addEventListener('end', () => {
      es.close();
      setIsProcessing(false);
    });

    es.onerror = () => {
      es.close();
    };
  }

  async function handleStart() {
    const ids = extractUniqueSteamIds(steamIds);
    if (!ids.length) return;

    setLogs([]);
    onProfilesUpdate([]);
    setJobStats({ requested: ids.length, processed: 0 });

    try {
      const res = await fetch('/process', {
        method: 'POST',
        headers: apiHeaders(password),
        body: JSON.stringify({ steam_ids: ids.join('\n') }),
      });
      const data = await res.json();
      if (!res.ok) {
        addLog({ message: data.error || 'Erro ao iniciar.', type: 'error', timestamp: Date.now() });
        return;
      }
      setCurrentJobId(data.jobId);
      setIsProcessing(true);
      setIsPaused(false);
      connectStream(data.jobId);
      if (data.ignoredSteamIds?.length) {
        addLog({
          message: `${data.ignoredSteamIds.length} IDs ignoradas (já processadas anteriormente).`,
          type: 'warn',
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      addLog({ message: `Erro: ${err.message}`, type: 'error', timestamp: Date.now() });
    }
  }

  async function handlePause() {
    if (!currentJobId) return;
    await fetch(`/process/${currentJobId}/pause`, {
      method: 'POST',
      headers: apiHeaders(password),
    }).catch(() => {});
  }

  async function handleResume() {
    if (!currentJobId) return;
    await fetch(`/process/${currentJobId}/resume`, {
      method: 'POST',
      headers: apiHeaders(password),
    }).catch(() => {});
    setIsPaused(false);
    connectStream(currentJobId);
  }

  async function handleStop() {
    if (!currentJobId) return;
    setIsStopping(true);
    await fetch(`/process/${currentJobId}/stop`, {
      method: 'POST',
      headers: apiHeaders(password),
    }).catch(() => {});
  }

  async function handleGenerateReport() {
    if (!currentJobId) return;
    setIsGenerating(true);
    try {
      const res = await fetch(`/process/${currentJobId}/partial-report`, {
        headers: apiHeaders(password),
      });
      const data = await res.json();
      if (data.reportHtml) {
        downloadHtml(data.reportHtml, `relatorio_parcial_${currentJobId.slice(0, 8)}.html`);
      }
    } catch (err) {
      addLog({ message: `Erro ao gerar relatório: ${err.message}`, type: 'error', timestamp: Date.now() });
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleFetchFriends() {
    const ids = extractUniqueSteamIds(friendsInput);
    if (!ids.length) { setFriendsError('Informe pelo menos uma SteamID.'); return; }
    setIsFetching(true);
    setFriendsError('');
    setFriendsResults([]);
    try {
      const res = await fetch('/friends/list', {
        method: 'POST',
        headers: apiHeaders(password),
        body: JSON.stringify({ steamIds: ids }),
      });
      const data = await res.json();
      if (!res.ok) { setFriendsError(data.error || 'Erro.'); return; }
      setFriendsResults(data.results || []);
    } catch (err) {
      setFriendsError(err.message);
    } finally {
      setIsFetching(false);
    }
  }

  function handleUseFriendsAsInput() {
    const allIds = friendsResults.flatMap((r) => r.friends || []);
    const unique = Array.from(new Set(allIds.map(sanitizeSteamId).filter(Boolean)));
    setSteamIds(unique.join('\n'));
  }

  function handleDownloadFriends() {
    const allIds = friendsResults.flatMap((r) => r.friends || []);
    const unique = Array.from(new Set(allIds.map(sanitizeSteamId).filter(Boolean)));
    downloadTxt(unique.join('\n'), 'amigos.txt');
  }

  const totalFriends = friendsResults.reduce((sum, r) => sum + (r.friends?.length || 0), 0);

  return (
    <div className="tab-content">

      <div className="analise-grid">
        {/* Steam IDs input */}
        <section className="panel-section">
          <div className="section-header">
            <h2 className="section-title">Steam IDs</h2>
            {idCount > 0 && <span className="badge">{idCount.toLocaleString('pt-BR')} IDs</span>}
          </div>
          <textarea
            className="ids-textarea"
            placeholder="Cole as Steam IDs aqui (uma por linha ou separadas por espaço)"
            value={steamIds}
            onChange={(e) => setSteamIds(e.target.value)}
            disabled={isProcessing}
            rows={8}
          />

          <div className="job-controls">
            {!isProcessing && (
              <button className="btn-primary" onClick={handleStart} disabled={!idCount} type="button">
                Iniciar análise
              </button>
            )}
            {isProcessing && !isPaused && (
              <button className="btn-secondary" onClick={handlePause} type="button">
                Pausar
              </button>
            )}
            {isProcessing && isPaused && (
              <button className="btn-primary" onClick={handleResume} type="button">
                Retomar
              </button>
            )}
            {isProcessing && (
              <button className="btn-danger" onClick={handleStop} disabled={isStopping} type="button">
                {isStopping ? 'Encerrando…' : 'Parar'}
              </button>
            )}
            {currentJobId && (
              <button className="btn-ghost" onClick={handleGenerateReport} disabled={isGenerating} type="button">
                {isGenerating ? 'Gerando…' : 'Gerar relatório HTML'}
              </button>
            )}
          </div>

          {jobStats && (
            <div className="job-progress">
              <span className="progress-label">
                Processados: <strong>{jobStats.processed ?? 0}</strong> / {jobStats.requested ?? 0}
              </span>
              {isPaused && <span className="badge badge--warn">Pausado</span>}
              {isStopping && <span className="badge badge--warn">Encerrando…</span>}
            </div>
          )}
        </section>

        {/* Logs */}
        <section className="panel-section">
          <div className="section-header">
            <h2 className="section-title">Logs</h2>
            {logs.length > 0 && (
              <button className="btn-ghost btn-sm" onClick={() => setLogs([])} type="button">
                Limpar
              </button>
            )}
          </div>
          <LogViewer logs={logs} />
        </section>
      </div>

      {/* Friends list */}
      <section className="panel-section analise-full">
        <button
          className="collapsible-header"
          onClick={() => setShowFriends((v) => !v)}
          type="button"
        >
          <span>Buscar lista de amigos</span>
          <span className="collapse-arrow">{showFriends ? '▲' : '▼'}</span>
        </button>

        {showFriends && (
          <div className="friends-body">
            <p className="section-desc">
              Insira Steam IDs para buscar a lista de amigos de cada perfil.
            </p>
            <textarea
              className="ids-textarea"
              placeholder="Steam IDs (uma por linha)"
              value={friendsInput}
              onChange={(e) => setFriendsInput(e.target.value)}
              rows={4}
            />
            {friendsError && <p className="error-msg">{friendsError}</p>}
            <div className="job-controls">
              <button
                className="btn-primary"
                onClick={handleFetchFriends}
                disabled={isFetching}
                type="button"
              >
                {isFetching ? 'Buscando…' : 'Buscar amigos'}
              </button>
            </div>

            {friendsResults.length > 0 && (
              <>
                <div className="friends-results">
                  {friendsResults.map((r) => (
                    <div key={r.steamId} className="friends-result-item">
                      <div className="friends-result-header">
                        <span className="friends-steam-id">{r.steamId}</span>
                        {r.error ? (
                          <span className="badge badge--danger">{r.error}</span>
                        ) : (
                          <span className="badge">{r.friendCount} amigos</span>
                        )}
                      </div>
                      {!r.error && r.friends?.length > 0 && (
                        <pre className="friends-ids-pre">{r.friends.join('\n')}</pre>
                      )}
                    </div>
                  ))}
                </div>
                <div className="job-controls">
                  <button className="btn-secondary" onClick={handleUseFriendsAsInput} type="button">
                    Usar como input ({totalFriends.toLocaleString('pt-BR')} IDs)
                  </button>
                  <button className="btn-ghost" onClick={handleDownloadFriends} type="button">
                    Baixar .txt
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Resultados Tab ───────────────────────────────────────────────────────────

function ResultadosTab({ profiles }) {
  const successProfiles = [...profiles]
    .filter((p) => p.status === 'success')
    .sort((a, b) => (b.caseValueBRL ?? 0) - (a.caseValueBRL ?? 0));

  if (!successProfiles.length) {
    return (
      <div className="tab-content">
        <div className="empty-state">
          <span className="empty-icon">📦</span>
          <p>Nenhum perfil passou o filtro de caixas ainda.</p>
          <p className="empty-sub">Os resultados aparecerão aqui em tempo real durante o processamento.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="tab-content">
      <section className="panel-section">
        <div className="section-header">
          <h2 className="section-title">Perfis com ≥60% em caixas</h2>
          <span className="badge">{successProfiles.length} perfis</span>
        </div>
        <div className="table-wrapper">
          <table className="results-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Apelido</th>
                <th>Steam ID</th>
                <th>Inventário (BRL)</th>
                <th className="th-highlight">Valor Caixas (BRL)</th>
                <th className="th-highlight">% Caixas</th>
                <th>Último Login</th>
                <th>Nível</th>
                <th>VAC</th>
              </tr>
            </thead>
            <tbody>
              {successProfiles.map((p, i) => (
                <tr key={p.id}>
                  <td>{i + 1}</td>
                  <td>
                    <a
                      href={`https://steamcommunity.com/profiles/${p.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="profile-link"
                    >
                      {p.name ?? 'N/A'}
                    </a>
                  </td>
                  <td>
                    <a
                      href={`https://steamcommunity.com/profiles/${p.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="profile-link id-link"
                    >
                      {p.id}
                    </a>
                  </td>
                  <td>{fmtBRL(p.totalValueBRL)}</td>
                  <td className="td-highlight">{fmtBRL(p.caseValueBRL)}</td>
                  <td className="td-highlight">
                    {typeof p.casePercentage === 'number'
                      ? `${p.casePercentage.toFixed(1)}%`
                      : '—'}
                  </td>
                  <td>{fmtLastLogin(p.lastLogoff)}</td>
                  <td>{typeof p.steamLevel === 'number' ? p.steamLevel : '—'}</td>
                  <td>
                    {p.vacBanned
                      ? <span className="badge badge--danger">Sim</span>
                      : <span className="badge badge--ok">Não</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ─── Histórico Tab ────────────────────────────────────────────────────────────

function HistoricoTab({ password }) {
  const [entries, setEntries]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const res = await fetch('/history/entries', { headers: apiHeaders(password) });
        const data = await res.json();
        setEntries(data.entries || []);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [password]);

  function handleDownload(entry) {
    if (!entry.reportHtml) return;
    const label = entry.partial ? 'previa' : 'relatorio';
    const ts = String(entry.generatedAt || '').replace(/[:.]/g, '-');
    downloadHtml(entry.reportHtml, `${label}_${entry.jobId?.slice(0, 8) || 'job'}_${ts}.html`);
  }

  if (loading) return <div className="tab-content"><div className="loading-msg">Carregando histórico…</div></div>;
  if (error)   return <div className="tab-content"><div className="error-msg">{error}</div></div>;

  if (!entries.length) {
    return (
      <div className="tab-content">
        <div className="empty-state">
          <span className="empty-icon">🕓</span>
          <p>Nenhum relatório nas últimas 24 horas.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="tab-content">
      <section className="panel-section">
        <div className="section-header">
          <h2 className="section-title">Relatórios (últimas 24h)</h2>
          <span className="badge">{entries.length}</span>
        </div>
        <div className="history-list">
          {entries.map((entry) => (
            <div key={entry.id} className="history-item">
              <div className="history-item-main">
                <div className="history-item-info">
                  <span className={`badge ${entry.partial ? 'badge--warn' : 'badge--ok'}`}>
                    {entry.partial ? 'Prévia' : 'Final'}
                  </span>
                  <span className="history-date">{fmtDateTime(entry.generatedAt)}</span>
                  <span className="history-job-id">Job {entry.jobId?.slice(0, 8)}…</span>
                </div>
                <div className="history-stats">
                  <span>{entry.totals?.clean ?? 0} passaram filtro</span>
                  <span>{entry.totals?.processed ?? 0} processados</span>
                  <span>{entry.totals?.vacBanned ?? 0} VAC ban</span>
                </div>
              </div>
              {entry.reportHtml && (
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => handleDownload(entry)}
                  type="button"
                >
                  Baixar HTML
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

// ─── Configurações Tab ────────────────────────────────────────────────────────

function ConfiguracoesTab({ password }) {
  const [threshold, setThreshold] = useState(60);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [saving, setSaving]         = useState(false);
  const [saved, setSaved]           = useState(false);
  const [error, setError]           = useState('');

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/settings', { headers: apiHeaders(password) });
        const data = await res.json();
        if (typeof data.caseThreshold === 'number') setThreshold(data.caseThreshold);
        if (typeof data.webhookUrl === 'string') setWebhookUrl(data.webhookUrl);
      } catch {}
    }
    load();
  }, [password]);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const res = await fetch('/settings', {
        method: 'POST',
        headers: apiHeaders(password),
        body: JSON.stringify({ caseThreshold: Number(threshold), webhookUrl }),
      });
      if (!res.ok) throw new Error('Falha ao salvar.');
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="tab-content">
      <section className="panel-section">
        <h2 className="section-title">Filtro de caixas</h2>
        <p className="section-desc">
          Perfis com menos de <strong>{threshold}%</strong> do inventário em caixas serão filtrados.
        </p>
        <div className="settings-field">
          <label className="settings-label">% mínimo de caixas</label>
          <div className="threshold-row">
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="threshold-slider"
            />
            <input
              type="number"
              min={0}
              max={100}
              value={threshold}
              onChange={(e) => setThreshold(Math.min(100, Math.max(0, Number(e.target.value))))}
              className="threshold-input"
            />
            <span className="threshold-pct">%</span>
          </div>
        </div>
      </section>

      <section className="panel-section">
        <h2 className="section-title">Webhook</h2>
        <p className="section-desc">URL para notificações de eventos (jobs iniciados, concluídos, inventários premium).</p>
        <div className="settings-field">
          <label className="settings-label">URL do Webhook</label>
          <input
            type="url"
            className="settings-input"
            placeholder="https://..."
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
          />
        </div>
      </section>

      {error && <p className="error-msg">{error}</p>}

      <div className="settings-actions">
        <button className="btn-primary" onClick={handleSave} disabled={saving} type="button">
          {saving ? 'Salvando…' : saved ? 'Salvo ✓' : 'Salvar configurações'}
        </button>
      </div>
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar({ active, onChange, onLogout }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-dot" />
        <span className="brand-name">Art Cases</span>
      </div>
      <nav className="sidebar-nav">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`sidebar-btn${active === tab.id ? ' sidebar-btn--active' : ''}`}
            onClick={() => onChange(tab.id)}
            type="button"
          >
            <span className="sidebar-icon">{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </nav>
      <button className="sidebar-logout" onClick={onLogout} type="button">
        Sair
      </button>
    </aside>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────

function Panel({ password, onLogout }) {
  const [activeTab, setActiveTab]       = useState('analise');
  const [liveProfiles, setLiveProfiles] = useState([]);

  function handleProfilesUpdate(updater) { setLiveProfiles(updater); }
  function handleJobComplete(result) {
    if (Array.isArray(result?.results)) setLiveProfiles(result.results);
  }

  return (
    <div className="panel-shell">
      <Sidebar active={activeTab} onChange={setActiveTab} onLogout={onLogout} />

      <main className="panel-main">
        {activeTab === 'analise' && (
          <AnaliseTab
            password={password}
            onProfilesUpdate={handleProfilesUpdate}
            onJobComplete={handleJobComplete}
          />
        )}
        {activeTab === 'resultados' && <ResultadosTab profiles={liveProfiles} />}
        {activeTab === 'historico'   && <HistoricoTab password={password} />}
        {activeTab === 'configuracoes' && <ConfiguracoesTab password={password} />}
      </main>

      {/* Mobile bottom nav */}
      <TabNav active={activeTab} onChange={setActiveTab} mobile />
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [password, setPassword] = useState(() => {
    try { return localStorage.getItem('panel-pw') || ''; } catch { return ''; }
  });
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking]           = useState(true);

  useEffect(() => {
    if (!password) { setChecking(false); return; }
    fetch('/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
      .then((r) => r.json())
      .then((d) => { if (d.ok) setAuthenticated(true); })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  function handleLogin(pw) {
    try { localStorage.setItem('panel-pw', pw); } catch {}
    setPassword(pw);
    setAuthenticated(true);
  }

  function handleLogout() {
    try { localStorage.removeItem('panel-pw'); } catch {}
    setAuthenticated(false);
    setPassword('');
  }

  if (checking) {
    return (
      <div className="splash">
        <span className="splash-dot" />
      </div>
    );
  }

  if (!authenticated) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return <Panel password={password} onLogout={handleLogout} />;
}
