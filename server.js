"use strict";

// Migração de 'require' para 'import'
import axios from "axios";
import fs from "fs";
import path from "path";
import { writeFile } from "fs/promises";
import dotenv from "dotenv";
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Mantenha esta importação, mas certifique-se que 'insert.js' usa 'export default'
import saveToDatabase from "./insert"; 

// Correção para simular __dirname e __filename em ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

const config = JSON.parse(fs.readFileSync("./config.json", "utf8") || "{}");
const API_URL = "https://www.steamwebapi.com/steam/api/inventory?key=IXTFKGPWPFKMRU2M&select=pricelatest,markethashname,tag1&steam_id=";
const STEAM_API_URL = "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/";
const STEAM_FRIENDS_URL = "https://api.steampowered.com/ISteamUser/GetFriendList/v1/";
const STEAM_BANS_URL = "https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/";
const API_KEY = config?.STEAM_API_KEY ? config.STEAM_API_KEY : process.env.STEAM_API_KEY;

// Usa path.join() com o __dirname corrigido
const OUTPUT_FILE = path.join(__dirname, "inventory.html"); 

const MIN_INVENTORY_VALUE = 50;
const DELAY_BETWEEN_FRIENDS_MS = 3200; // 3.2 segundos de pausa solicitada

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getSteamUserInfo(steamId) {
    try {
        // Pausa para não sobrecarregar as duas chamadas seguidas para a Steam API (Nome e Ban)
        await delay(500); 

        // 1. Checagem de Nome/URL
        const response = await axios.get(STEAM_API_URL, {
            params: { key: API_KEY, steamids: steamId },
        });

        const player = response.data.response.players[0];
        const realName = player.realname || player.personaname || "Desconhecido";
        const profileUrl = player.profileurl || `https://steamcommunity.com/profiles/${steamId}`;

        // Pequena pausa antes da próxima requisição (Ban)
        await delay(500); 

        // 2. Checagem de Bans
        const banResponse = await axios.get(STEAM_BANS_URL, {
            params: { key: API_KEY, steamids: steamId },
        });

        const bans = banResponse.data.players[0];
        const hasVacBan = bans.VACBanned;

        console.log(`[BACKEND LOG] [ID ${steamId}] Nome: ${realName}, VAC Ban: ${hasVacBan ? 'SIM' : 'NÃO'}`);
        return { realName, profileUrl, hasVacBan };

    } catch (error) {
        console.error(`[BACKEND LOG] [ID ${steamId}] Erro ao buscar dados do Steam (Nome/Ban): ${error.message}`);
        return { realName: "Desconhecido", profileUrl: `https://steamcommunity.com/profiles/${steamId}`, hasVacBan: false, error: true };
    }
}

async function getCS2InventoryValue(steamId, realName, profileUrl, hasVacBan) {
    // Se já detectou ban ou erro na etapa anterior, ignora
    if (hasVacBan) {
        console.log(`[BACKEND LOG] [ID ${steamId}] ❌ Perfil ignorado: ${profileUrl} (VAC BAN)`);
        return null;
    }
    
    // Pausa antes de chamar a API Montuga (Inventário)
    await delay(1000); 

    try {
        const response = await axios.get(`${API_URL}${steamId}`, {
            headers: { Cookie: "currency=USD" },
        });

        const inventory = response.data;

        // Verifica se a resposta da Montuga API indica falha (ex: perfil privado)
        if (inventory.message && (inventory.message.includes("not found or private") || inventory.message.includes("Rate limit exceeded"))) {
            console.log(`[BACKEND LOG] [ID ${steamId}] Falha Montuga: Perfil privado ou Rate Limit.`);
            return null;
        }


        const totalValue = inventory.reduce((sum, item) => {
            return sum + (item.pricelatest ? item.pricelatest : 0);
        }, 0);

        if (totalValue <= MIN_INVENTORY_VALUE) {
            console.log(`[BACKEND LOG] [ID ${steamId}] ❌ Perfil ignorado: ${profileUrl} (Inventário abaixo de $${MIN_INVENTORY_VALUE.toFixed(2)})`);
            return null;
        }

        const casesValue = inventory
            .filter(item => item.tag1 === 'Container')
            .reduce((sum, item) => sum + (item.pricelatest || 0), 0);

        const casePercentage = totalValue > 0 ? ((casesValue / totalValue) * 100).toFixed(2) : 0;
        
        console.log(`[BACKEND LOG] [ID ${steamId}] ✅ Inventário encontrado. Valor Total: $${totalValue.toFixed(2)}`);

        return {
            profileUrl,
            realName,
            total: totalValue.toFixed(2),
            casesValue: casesValue.toFixed(2),
            casePercentage,
        };

    } catch (error) {
        console.error(`[BACKEND LOG] [ID ${steamId}] Erro ao buscar inventário (Montuga): ${error.message}`);
        return null;
    }
}

async function getSteamFriends(steamId) {
    try {
        // Pausa antes de buscar a lista de amigos
        await delay(1000);
        const response = await axios.get(STEAM_FRIENDS_URL, {
            params: { key: API_KEY, steamid: steamId, relationship: "friend" },
        });
        // Retorna apenas a lista de IDs
        return response.data.friendslist?.friends?.map(friend => friend.steamid) || [];
    } catch (error) {
        console.error(`[BACKEND LOG] Erro ao buscar amigos do Steam ID ${steamId}:`, error.message);
        return [];
    }
}

async function saveToHTML(data) {
    let html = `
    <html>
    <head>
        <style>
            table { width: 100%; border-collapse: collapse; font-family: Arial, sans-serif; }
            th, td { border: 1px solid black; padding: 8px; text-align: center; }
            th { background-color: #333; color: white; }
            .low { background-color: red; color: white; }
            .medium { background-color: orange; color: white; }
            .high { background-color: green; color: white; }
        </style>
    </head>
    <body>
        <table>
            <tr>
                <th>STEAM PROFILE</th>
                <th>% CASES</th>
                <th>REAL NAME</th>
                <th>TOTAL INVENTORY VALUE (USD)</th>
                <th>CASES VALUE (USD)</th>
            </tr>`;

    data.forEach(({ profileUrl, realName, total, casesValue, casePercentage }) => {
        let caseClass = casePercentage < 50 ? "low" : casePercentage < 80 ? "medium" : "high";

        html += `
            <tr>
                <td><a href="${profileUrl}" target="_blank">Perfil Steam</a></td>
                <td class="${caseClass}">${casePercentage}%</td>
                <td>${realName}</td>
                <td>$${total}</td>
                <td>$${casesValue}</td>
            </tr>`;
    });

    html += `
        </table>
    </body>
    </html>`;

    await writeFile(OUTPUT_FILE, html);
    console.log(`[BACKEND LOG] ✅ Dados salvos em ${OUTPUT_FILE}`);
}

async function processFriends(steamId) {
    const friends = await getSteamFriends(steamId);
    console.log(`[BACKEND LOG] 🔍 Processando ${friends.length} amigos de forma serializada...`);
    let results = [];
    
    let processedCount = 0;

    // Loop for...of para processar UMA ID por vez de forma síncrona (resolve o Rate Limit)
    for (const friendSteamId of friends) {
        processedCount++;
        console.log(`[BACKEND LOG] [GERAL] Iniciando processamento do Amigo ${processedCount}/${friends.length}: ${friendSteamId}`);
        
        try {
            // 1. Checa Nome e Ban (Primeiro passo do fluxo)
            const userInfo = await getSteamUserInfo(friendSteamId);
            
            // 2. Busca Inventário (Segundo passo do fluxo, passa dados do usuário para evitar nova requisição)
            const inventoryData = await getCS2InventoryValue(
                friendSteamId, 
                userInfo.realName, 
                userInfo.profileUrl, 
                userInfo.hasVacBan
            );

            if (inventoryData) {
                results.push(inventoryData);
            }
            
            // 3. Pausa Solicitada (Terceiro passo do fluxo: 3.2s)
            console.log(`[BACKEND LOG] [GERAL] Pausando por ${DELAY_BETWEEN_FRIENDS_MS / 1000}s antes do próximo ID...`);
            await delay(DELAY_BETWEEN_FRIENDS_MS);

        } catch (error) {
            console.error(`[BACKEND LOG] [ERRO] Falha crítica ao processar ID ${friendSteamId}: ${error.message}`);
            // Pausa mesmo com erro para respeitar o Rate Limit.
            await delay(DELAY_BETWEEN_FRIENDS_MS);
        }
    }


    results.sort((a, b) => parseFloat(b.casesValue) - parseFloat(a.casesValue)); // Ordena corretamente como número
    await saveToHTML(results);
    await saveToDatabase(results);
    console.log(`[BACKEND LOG] [GERAL] Processamento concluído. ${results.length} inventários elegíveis.`);
}

async function main() {
    const steamId = process.argv[2];
    if (!steamId) {
        console.log("❌ Por favor, forneça um Steam ID.");
        process.exit(1);
    }
    await processFriends(steamId);
}

// Adaptação da checagem de execução principal para ES Modules
if (process.argv[1] === __filename) {
    main();
}

// O export é o único 'module.exports' que restou no CommonJS, o restante é 'export' em ESM
export { processFriends };