# Publicação no GitHub e Deploy no Render

Siga os passos abaixo após concluir as alterações no projeto.

## 1. Versionamento local
1. Certifique-se de que todos os testes e builds foram executados com sucesso:
   ```bash
   npm run build
   ```
2. Verifique o status do repositório:
   ```bash
   git status
   ```
3. Adicione os arquivos modificados e crie um commit descritivo:
   ```bash
   git add .
   git commit -m "feat: mensagem do que foi alterado"
   ```

## 2. Publicar no GitHub
1. Cadastre o remoto (substitua `SEU_USUARIO` e `SEU_REPOSITORIO`):
   ```bash
   git remote add origin git@github.com:SEU_USUARIO/SEU_REPOSITORIO.git
   ```
   > Se o remoto já existir, utilize `git remote set-url origin ...` para atualizar.
2. Envie a branch atual para o GitHub:
   ```bash
   git push -u origin <nome-da-sua-branch>
   ```

## 3. Configurar o Render
1. No painel do [Render](https://render.com), crie um novo serviço **Web Service** conectado ao repositório GitHub.
2. Na etapa de configuração utilize:
   - **Runtime**: Node
   - **Build Command**: `npm run build`
   - **Start Command**: `npm start`
3. Defina as variáveis de ambiente necessárias em *Environment*:
   - `MONTUGA_API_KEY`
   - `STEAM_API_KEY`
   - `NOTIFY_WEBHOOK_URL` (opcional, utilizado para disparar webhooks automáticos)
4. Finalize a criação do serviço e acompanhe os logs de deploy. A cada `git push` na branch configurada o Render executará o build e fará o deploy automaticamente.

> Dica: caso utilize branches diferentes, configure *Auto Deploy* conforme a branch desejada ou faça deploy manualmente pelo painel.

## Ajustes de velocidade e filtro (opcionais)
Todas têm valor padrão; só configure no Render se quiser mudar o comportamento.

| Variável | Padrão | O que faz |
|---|---|---|
| `MIN_INVENTORY_BRL` | `1000` | Contas com inventário abaixo disso ficam fora do relatório |
| `MAX_INVENTORY_BRL` | `10000` | Contas com inventário acima disso ficam fora do relatório |
| `STEAMWEBAPI_CONCURRENCY` | `4` | Consultas de inventário simultâneas na SteamWebAPI |
| `STEAMWEBAPI_MIN_INTERVAL_MS` | `100` | Espaço mínimo (ms) entre consultas na SteamWebAPI |
| `MONTUGA_CONCURRENCY` | `4` | Consultas simultâneas na Montuga |
| `MONTUGA_MIN_INTERVAL_MS` | `100` | Espaço mínimo (ms) entre consultas na Montuga |
| `STEAM_API_CONCURRENCY` | `4` | Consultas simultâneas na API oficial da Steam |
| `STEAM_API_MIN_INTERVAL_MS` | `150` | Espaço mínimo (ms) entre consultas na Steam |

Se uma API responder 429 (limite atingido), o sistema desacelera sozinho, espera e tenta de novo.
Se aparecer muito `[RATE ...] Limite atingido` no log do Render, diminua a concorrência ou aumente o intervalo daquela API.
A faixa de valor também pode ser alterada em tempo real via `POST /settings` com `minValueBRL` e `maxValueBRL`.
