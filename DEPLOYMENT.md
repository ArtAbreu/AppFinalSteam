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

Como funciona: a lista é processada em blocos. Primeiro a Steam verifica o bloco inteiro
(rápido, 100 contas por chamada) e descarta banidas, privadas e online/jogando. Só as que
sobram vão para a Montuga/SteamWebAPI, no ritmo abaixo.

| Variável | Padrão | O que faz |
|---|---|---|
| `MIN_INVENTORY_BRL` | `1000` | Contas com inventário abaixo disso ficam fora do relatório |
| `MAX_INVENTORY_BRL` | `10000` | Contas com inventário acima disso ficam fora do relatório |
| `STEAM_BLOCK_SIZE` | `500` | Quantas contas a Steam verifica por bloco antes de ir para a Montuga |
| `MONTUGA_CONCURRENCY` | `2` | Máximo de consultas simultâneas na Montuga |
| `MONTUGA_MIN_INTERVAL_MS` | `600` | Espaço mínimo (ms) entre consultas na Montuga |
| `STEAMWEBAPI_CONCURRENCY` | `2` | Máximo de consultas simultâneas na SteamWebAPI |
| `STEAMWEBAPI_MIN_INTERVAL_MS` | `600` | Espaço mínimo (ms) entre consultas na SteamWebAPI |
| `STEAM_API_CONCURRENCY` | `4` | Consultas simultâneas na API oficial da Steam |
| `STEAM_API_MIN_INTERVAL_MS` | `150` | Espaço mínimo (ms) entre consultas na Steam |
| `MAX_SAVED_REPORTS` | `1000` | Quantos relatórios ficam guardados |
| `DATA_DIR` | pasta do app | Onde ficam relatórios, histórico e configurações (veja abaixo) |

Se a API responder 429, o sistema corta as consultas simultâneas pela metade, dobra o intervalo,
pausa e tenta de novo (o log mostra "pediu calma"). Depois de várias respostas boas, volta a
acelerar devagar até o limite configurado acima.

### Relatórios permanentes no Render
No Render, os arquivos do app são apagados a cada deploy ou reinício. Para os relatórios
salvos durarem para sempre:
1. No serviço, abra **Disks** e adicione um disco (ex.: mount path `/var/data`, 1 GB basta).
2. Em **Environment**, crie `DATA_DIR=/var/data`.
Discos persistentes exigem um plano pago do Render.
