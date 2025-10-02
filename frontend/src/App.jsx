// frontend/src/App.jsx (Versão FINAL: Usabilidade e Histórico 24h)
import React, { useState, useRef, useEffect } from 'react';
import './App.css'; 

function App() {
  const [steamIds, setSteamIds] = useState('');
  const [reportData, setReportData] = useState(null); 
  const [isLoading, setIsLoading] = useState(false);
  
  const logContainerRef = useRef(null);

  // Efeito para manter o console de log sempre na última linha
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [reportData?.logs]);

  // NOVO: Função para resetar o estado da aplicação
  const handleReset = () => {
    setSteamIds('');
    setReportData(null);
    setIsLoading(false);
    console.log("Interface resetada. Pronto para nova análise.");
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    setReportData({ logs: [{ message: '[GERAL] Iniciando conexão com o Servidor de Análise...', type: 'info' }], reportHtml: null }); 
    setIsLoading(true);

    try {
      const response = await fetch('/process', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `steam_ids=${encodeURIComponent(steamIds)}`,
      });

      const data = await response.json();

      if (response.ok) {
        setReportData(data);
      } else {
        setReportData({ 
            reportHtml: `<div class="error-message">Erro (${response.status}): ${data.error || 'Erro desconhecido.'}</div>`, 
            logs: data.logs || [{ message: `[ERRO] Falha na validação: ${data.error || 'Erro desconhecido.'}`, type: 'error' }]
        });
      }

    } catch (error) {
      setReportData({ 
        reportHtml: `<div class="error-message">Erro de conexão: Não foi possível alcançar o servidor backend.</div>`, 
        logs: [{ message: `[ERRO] Falha de rede/conexão: Não foi possível conectar ao servidor. Verifique se o Node está rodando.`, type: 'error' }] 
      });
      console.error('Erro na requisição:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownloadReport = () => {
    if (reportData?.reportHtml) {
      const blob = new Blob([reportData.reportHtml], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `relatorio_artcases_execucao_${new Date().toISOString().slice(0, 10)}.html`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }
  };
  
  const handleDownloadHistory = async () => {
    try {
        const response = await fetch('/download-history', {
            method: 'GET',
        });

        if (response.ok) {
            const contentDisposition = response.headers.get('Content-Disposition');
            let filename = `relatorio_historico_24h_${new Date().toISOString().slice(0, 10)}.html`;

            if (contentDisposition) {
                const match = contentDisposition.match(/filename="(.+)"/);
                if (match && match[1]) {
                    filename = match[1];
                }
            }

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            alert("Download do histórico de 24h iniciado com sucesso!");
        } else {
             const message = await response.text();
             alert(`Falha no download do histórico: ${message || 'Nenhum perfil processado nas últimas 24 horas ou erro desconhecido.'}`);
        }
    } catch (error) {
        alert('Erro de rede: Não foi possível conectar ao servidor para download do histórico.');
        console.error('Erro de download:', error);
    }
  };


  const getLogClassName = (type) => {
    switch(type) {
      case 'error': return 'log-error';
      case 'warn': return 'log-warn';
      case 'success': return 'log-success';
      default: return 'log-info';
    }
  }

  const renderFormOrLogs = () => {
    
    if (!isLoading && !reportData?.reportHtml) {
        return (
          <form onSubmit={handleSubmit}>
            <h3>ENTRADA DE DADOS</h3>
            <textarea
              placeholder="Cole uma Steam ID (64-bit) por linha. Ex: 76561198000000000"
              value={steamIds}
              onChange={(e) => setSteamIds(e.target.value)}
              rows="10"
              disabled={isLoading}
            />
            <button type="submit" disabled={isLoading || steamIds.trim().length === 0}>
              INICIAR VERIFICAÇÃO PREMIUM
            </button>
            <button 
                onClick={handleDownloadHistory} 
                className="download-button"
                style={{ backgroundColor: '#5c5c8a', marginTop: '10px' }}
                type="button"
                disabled={isLoading}
                title="Baixa o relatório de todas as IDs processadas com sucesso nas últimas 24 horas">
                ⬇️ BAIXAR HISTÓRICO (ÚLTIMAS 24H)
            </button>
            <p className="warning-note">
                ⚠️ **Checagem Otimizada**: O sistema checa Banimentos primeiro e pula IDs banidas, economizando tempo. IDs já processadas são salvas em `history.json` e só são reprocessadas em caso de falha anterior.
            </p>
          </form>
        );
    }
    
    const currentLogs = reportData?.logs || [];
    
    return (
        <div className="log-viewer-container">
            <h3>CONSOLE DE PROCESSAMENTO AVANÇADO</h3>
             {isLoading && (
                 <div className="loading-bar-wrapper">
                    <div className="loading-bar"></div>
                 </div>
             )}
            <div className="log-viewer" ref={logContainerRef}>
                {currentLogs.map((log, index) => (
                    <p key={index} className={getLogClassName(log.type)}>
                        <span className="log-id-prefix">{log.message.substring(0, log.message.indexOf('] ') + 1)}</span>
                        {log.message.substring(log.message.indexOf('] ') + 1).trim()}
                    </p>
                ))}
            </div>
             {!isLoading && reportData?.successCount >= 0 && (
                <>
                    <p className="summary-success">
                        ✅ **CONCLUÍDO**: {reportData.successCount} novos inventários processados com sucesso.
                    </p>
                    {/* NOVO BOTÃO DE RESET */}
                    <button 
                        onClick={handleReset} 
                        className="download-button"
                        style={{ backgroundColor: '#FF5722', marginTop: '10px' }}
                        type="button"
                        title="Volta para a tela inicial para inserir novas IDs">
                        🔄 NOVA ANÁLISE
                    </button>
                </>
             )}
        </div>
    );
  }

  const renderReport = () => {
      if (reportData?.reportHtml) {
        return (
            <div className="report-viewer-wrapper">
                <h3>RELATÓRIO DE INVENTÁRIO (MONTUGA & STEAM APIs)</h3>
                
                <div className="report-viewer">
                    <iframe
                        srcDoc={reportData.reportHtml}
                        title="Inventory Report"
                        sandbox="allow-scripts allow-same-origin"
                    />
                </div>

                <button 
                    onClick={handleDownloadReport} 
                    className="download-button"
                    title="Baixa o relatório gerado nesta execução em formato HTML">
                    ⬇️ DOWNLOAD RELATÓRIO DA EXECUÇÃO (.HTML)
                </button>

            </div>
        );
      }
      return null;
  }

  const mainClass = reportData?.reportHtml || isLoading ? 'two-columns-layout' : 'one-column-layout';

  return (
    <div className="art-cases-app">
      <header>
        <h1>Art Cases</h1>
        <p className="subtitle">Verificação Profissional e Otimizada de Inventários Steam.</p>
      </header>
      
      <main className={mainClass}>
        <div className="input-log-panel">
            {renderFormOrLogs()}
        </div>
        
        {/* Renderiza o painel de relatório se houver HTML ou se estiver em processamento */}
        {/* O painel de log aparecerá no lugar do input na tela de processamento/resultado */}
        {(reportData?.reportHtml || isLoading) && 
            <div className="report-panel">
                {renderReport()}
            </div>
        }
        
      </main>
      
      <footer>
        <p>Desenvolvido por Art Cases. Integrado com Steam Web API e Montuga API.</p>
      </footer>
    </div>
  );
}

export default App;