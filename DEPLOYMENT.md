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
3. Defina as variáveis de ambiente obrigatórias em *Environment*:
   - `MONTUGA_API_KEY`
   - `STEAM_API_KEY`
4. Finalize a criação do serviço e acompanhe os logs de deploy. A cada `git push` na branch configurada o Render executará o build e fará o deploy automaticamente.

> Dica: caso utilize branches diferentes, configure *Auto Deploy* conforme a branch desejada ou faça deploy manualmente pelo painel.
