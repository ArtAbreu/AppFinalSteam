# Publicação no GitHub e Deploy no Render

Siga os passos abaixo após concluir as alterações no projeto.

## 1. Versionamento local
1. Certifique-se de que todos os testes e builds foram executados com sucesso:
   ```bash
   npm run build
   ```
   > Observação: a pasta `dist/` é gerada pelo build e não é versionada. Execute esse comando sempre que for iniciar o servidor ou preparar um deploy.
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

## 2.1 Resolver conflitos antes do push ou merge
Se o GitHub apontar conflitos (como na imagem enviada), resolva-os localmente antes de concluir o push ou merge:

1. Atualize sua cópia da branch principal (ex.: `main`) e traga o conteúdo para a sua branch de trabalho:
   ```bash
   git fetch origin
   git checkout main
   git pull --ff-only
   git checkout <sua-branch>
   git merge origin/main
   ```
2. O Git listará os arquivos em conflito (`.gitignore`, `DEPLOYMENT.md`, `frontend/src/App.css`, `frontend/src/App.jsx`, `server.js`, etc.). Abra cada um, mantenha a versão que está no seu ambiente e remova os marcadores `<<<<<<<`, `=======`, `>>>>>>>`.
3. Quando terminar, confirme:
   ```bash
   git add .
   git commit
   ```
   O Git já sugere a mensagem "Merge branch 'main'" — basta salvar e fechar o editor.
4. Envie novamente a branch ao GitHub:
   ```bash
   git push
   ```

> Preferindo rebase: substitua o passo 1 por `git rebase origin/main` e finalize com `git push --force-with-lease`.

## 3. Configurar o Render
1. No painel do [Render](https://render.com), crie um novo serviço **Web Service** conectado ao repositório GitHub.
2. Na etapa de configuração utilize:
   - **Runtime**: Node
   - **Build Command**: `npm run build`
   - **Start Command**: `npm start`
3. Defina as variáveis de ambiente obrigatórias em *Environment*:
   - `MONTUGA_API_KEY`
   - `STEAM_API_KEY`
   - `PHONE_NOTIFICATION_WEBHOOK_URL` *(opcional, habilita alerta > R$ 3.000)*
   - `PHONE_NOTIFICATION_TOKEN` *(opcional, token extra para o webhook)*
4. Finalize a criação do serviço e acompanhe os logs de deploy. A cada `git push` na branch configurada o Render executará o build e fará o deploy automaticamente.

> Dica: caso utilize branches diferentes, configure *Auto Deploy* conforme a branch desejada ou faça deploy manualmente pelo painel.

### Acesso ao painel
O painel web é protegido por senha. Utilize **Artzin017** no primeiro acesso. Após autenticado, a sessão fica salva no navegador (sessionStorage). Para limpar a sessão imediatamente, utilize o botão **Sair com segurança** no canto superior do painel.
