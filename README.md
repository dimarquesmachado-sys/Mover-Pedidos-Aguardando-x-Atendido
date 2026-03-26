# Bling Automação GIRASSOL — v2.0

Serviço Node.js rodando no **Render** que automatiza a troca de status de pedidos no Bling, eliminando a dependência do Google Sheets.

---

## O problema que resolve

Pedidos do Mercado Livre entram como **ATENDIDO** no Bling (pela emissão automática de NF), mas sem etiqueta de envio ainda disponível. Isso polui a tela de checkout dos estoquistas — eles veem o pedido, separam o produto, mas a etiqueta não imprime porque o ML ainda não liberou.

### Solução

| Horário | Ação |
|---|---|
| **A cada 3 min** (06h–23h59) | ATENDIDO → AGUARDANDO (remove da tela dos estoquistas pedidos ML sem rastreio) |
| **00:10** | AGUARDANDO → ATENDIDO (ML libera etiquetas à meia-noite) + limpa memória |
| **06:00** | AGUARDANDO → ATENDIDO (repescagem antes de abrir) |
| **06:30** | AGUARDANDO → ATENDIDO (reforço) |
| **07:00** | AGUARDANDO → ATENDIDO (abertura) |

> ⚡ **3 minutos vs 30 minutos**: um pedido sem etiqueta fica no máximo ~3 min visível, ao invés de ~29 min como era no Google Sheets.

---

## Setup passo a passo

### 1. Criar repositório no GitHub

```bash
# Descompacte o zip, entre na pasta e:
git init
git add .
git commit -m "feat: bling automacao girassol v2"
git remote add origin https://github.com/SEU_USER/bling-automacao-girassol.git
git push -u origin main
```

### 2. Criar serviço no Render

1. Acesse [render.com](https://render.com) → **New → Web Service**
2. Conecte sua conta GitHub e selecione o repositório
3. Configure:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node index.js`
   - **Plan:** `Starter` ← **obrigatório** (Free hiberna e mata os crons)

### 3. Adicionar Persistent Disk

Painel do serviço → **Disks** → **Add Disk**
- **Name:** tokens-disk
- **Mount Path:** `/data`
- **Size:** 1 GB

### 4. Configurar variáveis de ambiente

Painel → **Environment** → adicione:

| Variável | Valor |
|---|---|
| `BLING_CLIENT_ID` | seu client_id |
| `BLING_CLIENT_SECRET` | seu client_secret |
| `BLING_REDIRECT_URI` | `https://sua-url.onrender.com/callback` |
| `TOKEN_FILE` | `/data/tokens.json` |
| `TZ` | `America/Sao_Paulo` |
| `SITUACAO_AGUARDANDO` | `7259` |
| `ME_LOJA_IDS` | `203584107` |

### 5. Gerar token inicial (uma única vez)

Após o deploy, obtenha o `auth_code` no Bling:
> Configurações → Integrações → sua app → **Gerar código de autorização**
> Copie o parâmetro `code` da URL de redirecionamento

Depois envie para o serviço:

```bash
curl -X POST https://sua-url.onrender.com/setup \
  -H "Content-Type: application/json" \
  -d '{"auth_code":"COLE_O_CODIGO_AQUI"}'
```

Resposta esperada:
```json
{ "ok": true, "message": "Tokens gerados e salvos ✓" }
```

A partir daí, o refresh é automático — nunca precisa repetir esse passo.

### 6. Configurar deploy automático via GitHub Actions (opcional)

No GitHub → Settings → Secrets → **New repository secret**:
- **Name:** `RENDER_DEPLOY_HOOK`
- **Value:** URL do deploy hook do Render (painel → Settings → Deploy Hook)

A partir daí, todo `git push main` faz um deploy automático no Render.

---

## Endpoints

| Método | URL | Descrição |
|---|---|---|
| GET | `/` ou `/health` | Status do serviço |
| POST | `/setup` | Gera token inicial `{"auth_code":"..."}` |
| POST | `/run/expedicao` | Dispara F1 manualmente (ATENDIDO→AGUARDANDO) |
| POST | `/run/virada` | Dispara rotina virada manualmente |
| POST | `/run/manha` | Dispara rotina manhã manualmente |

---

## Estrutura do projeto

```
bling-automacao/
├── index.js              # HTTP server + agendamento cron
├── fluxos.js             # Lógica dos fluxos F1 e F2
├── blingApi.js           # Wrapper da API Bling + rate-limit
├── tokenManager.js       # OAuth: geração, renovação, persistência
├── render.yaml           # Configuração declarativa do Render
├── .github/
│   └── workflows/
│       └── deploy.yml    # CI/CD: push → lint → deploy
├── package.json
├── .env.example
├── .gitignore
└── data/                 # Criado automaticamente
    └── tokens.json       # Gerado pelo /setup (não commitado)
```

---

## Detalhes técnicos

- **Rate limit:** espaçamento automático entre requisições (≥300ms GET, ≥700ms PATCH) com retry em 429
- **Concorrência:** guard interno impede duas execuções simultâneas do mesmo fluxo
- **Token renovado mid-flight:** se o token expirar durante uma execução, é renovado e a operação é retentada
- **Memória diária:** pedidos já processados no F1 não são reprocessados no mesmo dia (reset à meia-noite)
- **Sem banco de dados:** tokens em arquivo JSON em disco persistente; memória do dia em RAM
