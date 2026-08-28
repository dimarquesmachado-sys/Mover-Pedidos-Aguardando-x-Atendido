# Shopee Sessão → Checkout (extensão)

Envia os cookies da sessão logada do Seller Center direto pro serviço — sem DevTools, sem Render.
Um navegador por empresa funciona perfeito: instale a extensão nos três.

## Girassol — Chrome
1. Baixe esta pasta (Code → Download ZIP do repositório) e extraia.
2. `chrome://extensions` → ligue o **Modo do desenvolvedor** → **Carregar sem compactação** → escolha a pasta `shopee-cookies-extensao`.

## GOOD — Edge
1. Mesma pasta baixada.
2. `edge://extensions` → ligue o **Modo de desenvolvedor** (menu à esquerda) → **Carregar sem pacote** → escolha a pasta.

## AMBTotal — Firefox
1. Mesma pasta baixada.
2. Digite `about:debugging` na barra → **Este Firefox** → **Carregar extensão temporária…** → escolha o arquivo `manifest.json` dentro da pasta.
3. No primeiro clique em Enviar, o Firefox pergunta se a extensão pode acessar os sites — **aceite** (sem isso ele não lê os cookies).
4. ⚠️ No Firefox a extensão carregada assim **some quando o navegador fecha** — se um dia a sessão morrer de novo, repita o passo 2 (30 segundos). Com o keep-alive de 3h isso deve ser raro.

## Usar (igual nos três)
1. Entre no `seller.shopee.com.br` com a conta da empresa daquele navegador.
2. Ícone da extensão → escolha a empresa → cole a ADMIN_KEY (só na primeira vez).
3. **Enviar sessão atual** → a resposta diz se a sessão ficou ✅ viva.
