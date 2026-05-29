# Módulo Respostas Rápidas

Sistema multi-loja (AMBTOTAL, GIRASSOL, GIMPO) de respostas rápidas para Mercado Livre.
Painel web para CRUD + API consumida por extensão Chrome.

## Estrutura

```
respostas-rapidas/
  ├── index.js              # Router Express (módulo principal)
  ├── painel/
  │   └── index.html        # Painel web com login JWT
  └── README.md
```

## Integração no server.js do Mover-Pedidos

No `server.js` principal, adicione:

```js
// === MÓDULO: Respostas Rápidas ML ===
const respostasRapidas = require('./respostas-rapidas');
app.use('/respostas-rapidas', respostasRapidas);
```

Coloque essa linha **antes** de qualquer `app.get('/*', ...)` catch-all que você tenha.

## Dependências (já existentes no Mover-Pedidos)

- `express` ✅
- `jsonwebtoken` (se não tiver: `npm install jsonwebtoken`)
- `bcryptjs` (se não tiver: `npm install bcryptjs`)

Verificar no `package.json` se já estão. O módulo de estoque já usa JWT, então `jsonwebtoken` deve estar. Confirme `bcryptjs`.

## Variáveis de ambiente (adicionar no Render)

| Variável | Valor sugerido | Obrigatória? |
|----------|----------------|--------------|
| `RESPOSTAS_API_KEY` | string aleatória 32+ caracteres (gerar com `openssl rand -hex 32`) | ✅ SIM |
| `RESPOSTAS_JWT_SECRET` | outra string aleatória (opcional, usa JWT_SECRET geral como fallback) | ❌ opcional |
| `RESPOSTAS_DATA_DIR` | default `/data/respostas-rapidas` | ❌ opcional |

## Disco persistente

Os arquivos `respostas.json` e `users.json` ficam em `/data/respostas-rapidas/`.
O disco `/data` do Mover-Pedidos já está montado — o módulo apenas cria a subpasta automaticamente.

## Acessos após deploy

- **Painel web:** `https://mover-pedidos-aguardando-x-atendido.onrender.com/respostas-rapidas/painel/`
- **Login inicial:** `admin` / `admin123` (TROCAR NO PRIMEIRO ACESSO)
- **Healthcheck:** `https://mover-pedidos-aguardando-x-atendido.onrender.com/respostas-rapidas/healthz`
- **API extensão:** `GET /respostas-rapidas/api/respostas?loja=AMBTOTAL&categoria=mensagens`
  - Header: `X-API-Key: <RESPOSTAS_API_KEY>`

## Estrutura de dados (`/data/respostas-rapidas/respostas.json`)

```json
{
  "respostas": [
    {
      "id": "1716987654321",
      "loja": "AMBTOTAL",
      "categoria": "mensagens",
      "titulo": "Lâmpada não inclusa",
      "texto": "Olá! Conforme descrito no anúncio...",
      "ordem": 0,
      "criadoEm": "2026-05-29T19:00:00.000Z"
    }
  ]
}
```

Lojas válidas: `AMBTOTAL`, `GIRASSOL`, `GIMPO`
Categorias válidas: `mensagens`, `reclamacoes`, `pos-venda`, `geral`

Resposta com categoria `geral` aparece em **todas** as páginas (junto com as específicas).
