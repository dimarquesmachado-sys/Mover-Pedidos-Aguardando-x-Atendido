# 📋 Guia Passo a Passo — Bling Automação no Render
### Para quem não é programador

---

## O que você vai precisar (tudo gratuito para criar conta)

- Conta no **GitHub** → github.com
- Conta no **Render** → render.com
- O arquivo ZIP do projeto (você já tem)

---

## PARTE 1 — Subir o projeto no GitHub

O GitHub é como um "pen drive na nuvem" para o código. O Render vai buscar o projeto de lá.

### Passo 1 — Criar conta no GitHub
1. Acesse **github.com**
2. Clique em **Sign up** (canto superior direito)
3. Preencha e-mail, senha, username → confirme o e-mail

### Passo 2 — Criar o repositório
1. Após fazer login, clique no **+** no canto superior direito
2. Clique em **New repository**
3. Em **Repository name**, coloque: `bling-automacao-girassol`
4. Deixe marcado **Private** (ninguém verá seu código)
5. Clique em **Create repository**

### Passo 3 — Subir os arquivos
1. Na página do repositório recém-criado, clique em **uploading an existing file**
   *(aparece um link assim: "...or uploading an existing file")*
2. **Descompacte o ZIP** que você baixou no seu computador
3. Abra a pasta `bling-automacao` que foi descompactada
4. Selecione **todos os arquivos e pastas** dentro dela e arraste para a página do GitHub
   *(exceto a pasta `data` se ela aparecer — ela é criada automaticamente)*
5. Role a página até o final, onde diz **Commit changes**
6. Clique no botão verde **Commit changes**

✅ Pronto! Seu código está no GitHub.

---

## PARTE 2 — Criar o serviço no Render

O Render é quem vai rodar o código 24 horas por dia, todos os dias.

### Passo 4 — Criar conta no Render
1. Acesse **render.com**
2. Clique em **Get Started for Free**
3. Recomendo fazer login **com sua conta do GitHub** (botão "GitHub") — já conecta os dois

### Passo 5 — Criar o serviço
1. No painel do Render, clique em **New +** (botão no canto superior direito)
2. Escolha **Web Service**
3. Na tela seguinte, clique em **Connect** ao lado do repositório `bling-automacao-girassol`
   *(se não aparecer, clique em "Configure account" e autorize o Render a ver seus repos)*
4. Preencha os campos:
   - **Name:** `bling-automacao-girassol`
   - **Region:** escolha **South America (São Paulo)** se disponível, ou **US East (Ohio)**
   - **Branch:** `main`
   - **Build Command:** `npm install`
   - **Start Command:** `node index.js`
5. Em **Instance Type**, selecione **Starter** (~$7/mês)
   ⚠️ *NÃO use Free — o serviço gratuito "dorme" e os crons param de funcionar*
6. Clique em **Create Web Service**

### Passo 6 — Adicionar disco para salvar os tokens
Os tokens de acesso ao Bling precisam ficar salvos em algum lugar. É o "disco" do serviço.

1. No painel do seu serviço recém-criado, clique na aba **Disks** (menu lateral esquerdo)
2. Clique em **Add Disk**
3. Preencha:
   - **Name:** `tokens-disk`
   - **Mount Path:** `/data`
   - **Size:** `1 GB`
4. Clique em **Save**

### Passo 7 — Configurar as variáveis secretas
Essas são as "chaves" que o sistema usa para se comunicar com o Bling.

1. No menu lateral, clique em **Environment**
2. Clique em **Add Environment Variable** para cada linha abaixo:

| Chave (Key) | Valor (Value) |
|---|---|
| `BLING_CLIENT_ID` | *seu client_id do Bling* |
| `BLING_CLIENT_SECRET` | *seu client_secret do Bling* |
| `BLING_REDIRECT_URI` | `https://bling-automacao-girassol.onrender.com/callback` |
| `TOKEN_FILE` | `/data/tokens.json` |
| `TZ` | `America/Sao_Paulo` |
| `SITUACAO_AGUARDANDO` | `7259` |
| `ME_LOJA_IDS` | `203584107` |

3. Clique em **Save Changes**

> 💡 **Onde achar o client_id e client_secret no Bling?**
> Bling → Configurações (engrenagem) → Integrações → API → sua integração → os dados estão lá

---

## PARTE 3 — Conectar o Bling (feito uma única vez)

### Passo 8 — Gerar o auth_code no Bling
O Bling precisa "autorizar" o sistema a mexer nos seus pedidos.

1. No Bling, vá em **Configurações → Integrações → API**
2. Clique na sua integração
3. Clique em **Gerar código de autorização** (ou similar)
4. Você será redirecionado para uma URL — copie o valor do parâmetro **code** da URL
   - A URL vai parecer com: `https://sua-url.onrender.com/callback?code=ABCDEF123...`
   - Copie só o `ABCDEF123...` (o que vem depois de `code=`)

### Passo 9 — Enviar o código para o sistema

Você vai usar o site **reqbin.com** (funciona no navegador, sem instalar nada):

1. Acesse **reqbin.com**
2. Mude o método de `GET` para `POST` (caixa de seleção no início)
3. No campo de URL, cole:
   ```
   https://bling-automacao-girassol.onrender.com/setup
   ```
4. Clique na aba **Content** (ou Body)
5. Selecione **JSON**
6. Cole o seguinte, substituindo o código:
   ```json
   {"auth_code":"COLE_SEU_CODIGO_AQUI"}
   ```
7. Clique em **Send**
8. A resposta deve ser:
   ```json
   {"ok": true, "message": "Tokens gerados e salvos ✓"}
   ```

✅ **Pronto! O sistema está no ar e funcionando.**

---

## Como verificar se está funcionando

Acesse no navegador:
```
https://bling-automacao-girassol.onrender.com/health
```

Deve aparecer:
```json
{"status": "ok", "service": "bling-automacao-girassol", "time": "..."}
```

Para ver os logs em tempo real:
1. No painel do Render, clique no serviço
2. Clique na aba **Logs**
3. Você verá as execuções acontecendo a cada 3 minutos

---

## Resumo dos horários automáticos

| Quando | O que faz |
|---|---|
| A cada 3 min (06h–23h59) | Remove da tela dos estoquistas pedidos ML sem etiqueta |
| 00h10 | Volta pra ATENDIDO os pedidos que ganharam etiqueta (ML libera à meia-noite) |
| 06h00 | Repescagem manhã |
| 06h30 | Reforço manhã |
| 07h00 | Abertura |

**Pedidos já verificados no dia não são consultados de novo** — se viu que não tem etiqueta de manhã, só olha de novo no dia seguinte após a meia-noite.

---

## Se precisar atualizar o código no futuro

1. Edite o arquivo no GitHub (clique no arquivo → ícone de lápis)
2. Salve (Commit changes)
3. O Render detecta a mudança e faz o deploy automaticamente em ~2 minutos

---

## Dúvidas frequentes

**O sistema vai parar se eu fechar o computador?**
Não! Ele roda no servidor do Render, independente do seu computador.

**Preciso renovar o token manualmente?**
Não! O sistema renova sozinho quando necessário.

**Como sei se deu algum erro?**
Pela aba **Logs** no Render. Erros aparecem em vermelho.

**E se o Render ficar fora do ar?**
Raramente acontece, mas o Render tem 99.9% de uptime. Se acontecer, os crons voltam automaticamente quando o serviço reinicia.
