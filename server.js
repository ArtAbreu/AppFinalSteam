// server.js (VERSÃO FINAL 3.0: Chaves de API Protegidas)
import 'dotenv/config'; // Importa e carrega as variáveis do .env
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

// --- CONFIGURAÇÃO (AGORA LÊ TUDO DO .env) ---
const MONTUGA_BASE_URL = 'https://montuga.com/api/IPricing/inventory'; 
const STEAM_API_BASE_URL = 'https://api.steampowered.com/'; 
const APP_ID = 730; 

// VARIÁVEIS DE AMBIENTE PROTEGIDAS (CRÍTICO: NÃO COLOQUE CHAVES AQUI!)
const MONTUGA_API_KEY = process.env.MONTUGA_API_KEY; 
const STEAM_API_KEY = process.env.STEAM_API_KEY; 

// Taxa de conversão fixa (USD para BRL)
const USD_TO_BRL_RATE = 5.25; 
const HISTORY_FILE = 'history.json'; 

// --- CONFIGURAÇÃO DO SERVIDOR WEB ---
const app = express();
const PORT = 3000;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

// Resolve o erro de caminho
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); 

// Serve arquivos estáticos da pasta 'dist'
app.use(express.static(path.join(__dirname, 'dist'))); 

// --- CLASSE DE DADOS E FUNÇÕES AUXILIARES ---
const currentDate = () => new Date().toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
});

// Inicializa o histórico
async function loadHistory() {
    try {
        const data = await fs.readFile(HISTORY_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return {}; 
        }
        console.error(`[ERRO CACHE] Falha ao carregar o histórico: ${error.message}`);
        return {};
    }
}

async function saveHistory(history) {
    try {
        await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
    } catch (error) {
        console.error(`[ERRO CACHE] Falha ao salvar o histórico: ${error.message}`);
    }
}

class InventoryData {
    constructor(steamId, realName, totalValueBRL, date) {
        this.steamId = steamId;
        this.realName = realName || 'N/A';
        this.totalValueBRL = totalValueBRL || 0.00;
        this.casesPercentage = 0.00; // Placeholder para % cases
        this.date = date;
        this.vacBanned = false; 
        this.gameBans = 0;      
    }
    
    toHtmlRow() {
        const valueDisplay = this.totalValueBRL.toFixed(2).replace('.', ','); 
        const casesDisplay = this.casesPercentage.toFixed(2).replace('.', ',');
        // Se o valor for 0 e não for banido, exibe "Perfil Privado/Sem Itens"
        let banStatus = this.vacBanned ? 'VAC BAN' : (this.gameBans > 0 ? `${this.gameBans} BAN(S)` : 'Clean');
        if (this.totalValueBRL === 0.00 && !this.vacBanned && this.gameBans === 0) {
            banStatus = 'Privado/Sem Itens';
        }
        
        const banClass = this.vacBanned ? 'vac-ban' : (this.gameBans > 0 && !this.vacBanned ? 'game-ban' : 'clean');
        
        return `
      <tr>
        <td><a href="https://steamcommunity.com/profiles/${this.steamId}" target="_blank">${this.realName}</a></td>
        <td class="${this.vacBanned ? 'vac-ban-cell' : ''} ${this.gameBans > 0 && !this.vacBanned ? 'game-ban-cell' : ''}">${banStatus}</td>
        <td>R$ ${valueDisplay}</td>
        <td>${casesDisplay}%</td>
        <td>${this.date}</td>
      </tr>
    `;
    }
}

// Rota principal que serve o index.html do React
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ROTA PRINCIPAL DE PROCESSAMENTO
app.post('/process', async (req, res) => {
    const rawIds = req.body.steam_ids || '';
    let steamIds = rawIds.split(/\s+/).filter(id => id.length > 0);
    
    const logs = [];
    const pushLog = (message, type = 'info', steamId = null) => {
        const prefix = steamId ? `[ID ${steamId}]` : '[GERAL]';
        const logMessage = `${prefix} ${message}`;
        logs.push({ message: logMessage, type: type, id: steamId });
        console.log(`[BACKEND LOG] ${logMessage}`);
    };

    pushLog(`Iniciando processamento. Total de ${steamIds.length} IDs.`);
    
    const history = await loadHistory();
    const allIds = [...steamIds]; 
    const idsToProcessForSteam = [];
    const idsToSkip = [];

    // Otimização: Apenas IDs que FALHARAM ou NUNCA FORAM PROCESSADAS são reprocessadas.
    // IDs que tiveram SUCESSO, BAN, ou QUALQUER CONCLUSÃO são puladas.
    allIds.forEach(id => {
        if (history[id] && history[id].success) {
            idsToSkip.push(id);
        } else {
            idsToProcessForSteam.push(id); 
        }
    });
    
    if (idsToSkip.length > 0) {
        pushLog(`Ignorando ${idsToSkip.length} IDs: Já processadas com sucesso no histórico (ou ban/erro checado).`, 'warn');
    }
    if (idsToProcessForSteam.length === 0) {
        pushLog("Nenhuma ID nova para processar.", 'success');
        return res.json({
            reportHtml: `<div class="info-message">Todas as IDs fornecidas já foram processadas ou banidas anteriormente.</div>`,
            logs: logs,
            successCount: 0
        });
    }
    pushLog(`Processando ${idsToProcessForSteam.length} IDs novas para checagem de Ban/Nome.`);

    // 2. BUSCAR DADOS DE BANIMENTO E NOME (EM PARALELO com a Steam API)
    const steamPromises = idsToProcessForSteam.map(async (id) => {
        let name = 'N/A';
        let vacBanned = false;
        let gameBans = 0;
        let skipInventory = false; 
        let profileError = null; // Para rastrear erros de perfil/ban

        // A. GetPlayerSummaries (Nome)
        try {
            const urlName = `${STEAM_API_BASE_URL}ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${id}`;
            const resName = await fetch(urlName);
            
            // 🚨 ADIÇÃO CRÍTICA: LOG DO STATUS HTTP DA STEAM
            pushLog(`Status HTTP (Nome): ${resName.status}`, 'info', id);

            if (!resName.ok) {
                const errorText = await resName.text();
                pushLog(`Falha HTTP (Nome). Corpo da resposta: ${errorText.substring(0, 80)}...`, 'error', id);
                profileError = `Falha HTTP ${resName.status} ao buscar nome.`;
                skipInventory = true;
            } else {
                const dataName = await resName.json();
                if (dataName?.response?.players?.length > 0) {
                    name = dataName.response.players[0].personaname;
                    pushLog(`Nome encontrado: ${name}`, 'info', id);
                   } else {
                        profileError = "Perfil não encontrado na Steam API (JSON vazio).";
                        skipInventory = true;
                   }
            }
        } catch (e) {
            pushLog(`Falha ao obter o nome do perfil (Erro de Rede/JSON): ${e.message.substring(0, 80)}...`, 'error', id);
            profileError = `Erro de rede ao buscar nome: ${e.message}`;
            skipInventory = true;
        }

        // B. GetPlayerBans (Banimento)
        if (!skipInventory) {
            try {
                const urlBan = `${STEAM_API_BASE_URL}ISteamUser/GetPlayerBans/v1/?key=${STEAM_API_KEY}&steamids=${id}`;
                const resBan = await fetch(urlBan);
                
                // 🚨 ADIÇÃO CRÍTICA: LOG DO STATUS HTTP DA STEAM
                pushLog(`Status HTTP (Ban): ${resBan.status}`, 'info', id);
                
                if (!resBan.ok) {
                    const errorText = await resBan.text();
                    pushLog(`Falha HTTP (Ban). Corpo da resposta: ${errorText.substring(0, 80)}...`, 'error', id);
                    profileError = `Falha HTTP ${resBan.status} ao buscar bans.`;
                    skipInventory = true; 
                } else {
                    const dataBan = await resBan.json();
                    if (dataBan?.players?.length > 0) {
                        const bans = dataBan.players[0];
                        vacBanned = bans.VACBanned;
                        gameBans = bans.NumberOfGameBans;
                        
                        if (vacBanned) {
                            pushLog('Status: **VAC BAN DETECTADO**. Inventário será IGNORADO.', 'error', id);
                            skipInventory = true; 
                            profileError = "VAC Ban detectado.";
                        } else if (gameBans > 0) {
                            pushLog(`Status: ${gameBans} Ban(s) de Jogo.`, 'warn', id);
                        } else {
                            pushLog('Status: Clean (Sem Bans). Prosseguindo para Inventário.', 'success', id);
                        }
                    } else {
                        // Isso pode ocorrer se a Steam API falhar ou se o perfil for muito limitado
                        pushLog('Falha ao obter status de banimento (resposta JSON vazia).', 'warn', id);
                        profileError = "Falha ao obter status de banimento (API Steam).";
                        skipInventory = true; 
                    }
                }
            } catch (e) {
                pushLog(`Falha grave ao obter status de banimento: ${e.message.substring(0, 80)}...`, 'error', id);
                profileError = `Erro de rede ao buscar bans: ${e.message}`;
                skipInventory = true; 
            }
        }
        
        return { id, name, vacBanned, gameBans, skipInventory, profileError };
    });

    const steamResults = await Promise.all(steamPromises);
    const steamDataMap = new Map(steamResults.map(item => [item.id, item]));

    // 3. SEPARAR IDs PARA INVENTÁRIO
    const idsToProcessForInventory = steamResults
        .filter(item => !item.skipInventory)
        .map(item => item.id);
        
    const skippedByBanOrError = steamResults
        .filter(item => item.skipInventory)
        .length;

    if (skippedByBanOrError > 0) {
        pushLog(`${skippedByBanOrError} IDs foram ignoradas na checagem de inventário (VAC Ban ou Erro na Steam API).`, 'warn');
    }
    
    // 4. BUSCAR INVENTÁRIO (SEQUENCIAL)
    if (idsToProcessForInventory.length > 0) {
        pushLog(`Iniciando busca de inventário Montuga API em ${idsToProcessForInventory.length} IDs...`, 'info');
    }

    const successfulResults = [];

    for (const id of idsToProcessForInventory) {
        const steamInfo = steamDataMap.get(id);
        
        try {
            const url = `${MONTUGA_BASE_URL}/${id}/${APP_ID}/total-value`;
            
            const response = await fetch(url, {
                method: 'GET',
                headers: { 'api-key': MONTUGA_API_KEY, 'Accept': 'application/json' }
            });
            
            if (!response.ok) {
                let errorMessage;
                
                try {
                    const errorJson = await response.json();
                    errorMessage = errorJson.message || `Status ${response.status}. Erro Montuga (JSON).`;
                } catch (e) {
                    // É necessário clonar a resposta se for ler o body mais de uma vez, mas como o .json() falhou,
                    // lemos o texto para ver se era HTML.
                    const errorBodyText = await response.text();
                    errorMessage = `Status ${response.status}. O servidor Montuga retornou HTML (não JSON). Conteúdo: ${errorBodyText.substring(0, 80)}...`;
                }

                pushLog(`Falha Montuga: ${errorMessage}`, 'warn', id);
                steamInfo.montugaSuccess = false;
                steamInfo.montugaReason = errorMessage;
                
                // Marca como sucesso o processamento (já que a checagem de Ban/Nome foi feita), mas não salva valor.
                steamInfo.skipInventory = true; 
                steamInfo.profileError = errorMessage;
                continue;
            }

            // SUCESSO: Lê o JSON
            const data = await response.json(); 

            const totalValueUSD = data.total_value || 0.00;
            const totalValueBRL = totalValueUSD * USD_TO_BRL_RATE;

            const inventoryItem = new InventoryData(id, steamInfo.name, totalValueBRL, currentDate());
            inventoryItem.vacBanned = steamInfo.vacBanned;
            inventoryItem.gameBans = steamInfo.gameBans;
            
            successfulResults.push(inventoryItem);
            pushLog(`Valor encontrado: R$ ${totalValueBRL.toFixed(2).replace('.', ',')}.`, 'success', id);
            
            steamInfo.montugaSuccess = true;
            steamInfo.totalValueBRL = totalValueBRL;

        } catch (error) {
             pushLog(`Falha na Requisição Montuga/JSON: ${error.message}`, 'error', id);
             steamInfo.montugaSuccess = false;
             steamInfo.montugaReason = error.message;
             
             // Marca como sucesso o processamento (já que a checagem de Ban/Nome foi feita), mas não salva valor.
             steamInfo.skipInventory = true;
             steamInfo.profileError = error.message;
        }
    }
    
    // 5. SALVAR HISTÓRICO ATUALIZADO (AGORA SALVA O RESULTADO DE TODAS AS IDS INSERIDAS)
    const finalHistory = await saveFinalHistory(history, steamResults, steamDataMap);
    pushLog(`Histórico de ${Object.keys(finalHistory).length} IDs salvo.`, 'info');

    pushLog(`Processamento concluído. ${successfulResults.length} novos inventários processados.`, 'success');

    // 6. GERAR HTML FINAL
    successfulResults.sort((a, b) => b.totalValueBRL - a.totalValueBRL);
    const tableRows = successfulResults.map(item => item.toHtmlRow()).join('');
    
    // O total de IDs que foram originalmente ignoradas + as que acabaram de ser processadas.
    const totalProcessed = idsToSkip.length + successfulResults.length;
    
    const finalHtml = generateReportHtml(tableRows, successfulResults.length, totalProcessed, "Relatório Final Art Cases");

    res.json({
        reportHtml: finalHtml,
        logs: logs,
        successCount: successfulResults.length
    }); 
});

// FUNÇÃO PARA SALVAR O HISTÓRICO DE FORMA INTELIGENTE (AGORA SALVA TODAS AS IDS COM SUCESSO)
async function saveFinalHistory(currentHistory, steamResults, steamDataMap) {
    const newHistoryEntries = {};
    const dateStr = currentDate();
    const timestamp = Date.now();

    steamResults.forEach(item => {
        const steamInfo = steamDataMap.get(item.id);
        
        // Se a ID falhou em qualquer ponto do processamento (incluindo Montuga), ela será marcada como SUCESSO:TRUE no histórico.
        // Apenas se o valor > 0 é que salvamos o dado completo para o relatório 24h.
        
        const baseEntry = { 
            success: true, // Sempre marca como sucesso para não reprocessar
            date: dateStr, 
            timestamp: timestamp,
            reason: "Processado: " + (item.montugaSuccess ? "Sucesso" : item.profileError || item.montugaReason || "Erro desconhecido")
        };

        if (item.montugaSuccess === true && steamInfo.totalValueBRL > 0) {
            // Salva o dado completo para o relatório 24h
            baseEntry.data = {
                steamId: item.id,
                realName: item.name,
                totalValueBRL: steamInfo.totalValueBRL,
                vacBanned: item.vacBanned,
                gameBans: item.gameBans,
                casesPercentage: 0.00
            };
            baseEntry.reason = "Processado: Sucesso no Inventário.";
        } else if (item.vacBanned) {
             // Salva IDs Banidas no histórico, mas sem dados de inventário (BRL=0)
             baseEntry.data = {
                 steamId: item.id,
                 realName: item.name,
                 totalValueBRL: 0.00,
                 vacBanned: item.vacBanned,
                 gameBans: item.gameBans,
                 casesPercentage: 0.00
             };
             baseEntry.reason = "Processado: VAC Ban detectado.";
        }
        
        newHistoryEntries[item.id] = baseEntry;
    });

    const updatedHistory = { ...currentHistory, ...newHistoryEntries };
    await saveHistory(updatedHistory);
    return updatedHistory;
}


// FUNÇÃO AUXILIAR PARA GERAR HTML DO RELATÓRIO
function generateReportHtml(tableRows, newCount, totalHistoryCount, title) {
      return `
    <!DOCTYPE html>
    <html>
    <head>
        <title>${title}</title>
        <meta charset="utf-8">
        <style>
            body { font-family: Arial, sans-serif; background: #1a1a2e; color: #E0E0E0; margin: 20px; }
            h1 { color: #FF5722; font-size: 1.5em; border-bottom: 2px solid #333; padding-bottom: 10px; }
            p { color: #AAAAAA; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 0.95em; border: 1px solid #444; }
            th, td { padding: 12px; text-align: center; border: 1px solid #444; }
            th { background: #2a2a40; color: #FF5722; text-transform: uppercase; }
            tr:nth-child(even) { background: #1e1e32; }
            tr:hover { background: #30304a; }
            a { color: #5cb85c; text-decoration: none; }
            .info-message { color: #888; text-align: center; padding: 50px; }
            .vac-ban { font-weight: bold; color: #FF0000; }
            .vac-ban-cell { background: #4a1a1a; }
            .game-ban { font-weight: bold; color: #FFD700; }
            .game-ban-cell { background: #4a3a1a; }
            .clean { color: #5cb85c; font-weight: bold; }
        </style>
    </head>
    <body>
        <h1>${title} - ${currentDate()}</h1>
        <p>Inventários **Novos** processados com sucesso: ${newCount}.</p>
        <p>Total de IDs (Sucesso/Ban/Erro) processadas: ${totalHistoryCount}.</p>
        <table>
            <tr>
              <th>PERFIL STEAM</th>
              <th>STATUS BAN</th>
              <th>VALOR TOTAL (R$)</th>
              <th>% CASES (PENDING)</th>
              <th>DATA/HORA</th>
            </tr>
          ${tableRows}
        </table>
    </body>
    </html>`;
}


// Rota para download do histórico das últimas 24h
app.get('/download-history', async (req, res) => {
    const history = await loadHistory();
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000); 
    const recentProfiles = [];

    // Filtra perfis processados com sucesso e dentro das últimas 24 horas, que tenham dados.
    for (const id in history) {
        const record = history[id];
        // Filtra apenas registros que tenham a chave 'data' e o timestamp correto
        if (record.success && record.timestamp && record.timestamp >= oneDayAgo && record.data) {
            recentProfiles.push(record.data);
        }
    }
    
    // Filtra os perfis que tiveram valor (inventário lido) ou ban
    const inventoriesForReport = recentProfiles.filter(p => p.totalValueBRL > 0 || p.vacBanned);

    if (inventoriesForReport.length === 0) {
        return res.status(404).send("Nenhum inventário com valor ou ban detectado nas últimas 24 horas.");
    }
    
    // Gera as linhas da tabela a partir dos dados do histórico
    const tableRows = inventoriesForReport.map(data => {
        // Recria um objeto temporário InventoryData
        const item = new InventoryData(data.steamId, data.realName, data.totalValueBRL, new Date(data.timestamp).toLocaleString('pt-BR'));
        item.vacBanned = data.vacBanned;
        item.gameBans = data.gameBans;
        item.casesPercentage = data.casesPercentage;
        return item.toHtmlRow();
    }).join('');

    // Gera o HTML final do relatório
    const totalProcessed = Object.keys(history).length;
    const finalHtml = generateReportHtml(tableRows, inventoriesForReport.length, totalProcessed, "Relatório Histórico Art Cases (Últimas 24 Horas)");

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="relatorio_historico_24h_${new Date().toISOString().slice(0, 10)}.html"`);
    res.send(finalHtml);
});


// INICIA O SERVIDOR
app.listen(PORT, () => {
    console.log(`\n✅ SERVIDOR WEB LIGADO! (Backend Art Cases)`);
    console.log(`ABRA O SEU NAVEGADOR e acesse: http://localhost:${PORT}`);
    console.log(`------------------------------------------------------\n`);
});