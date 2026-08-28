# 🧰 GOOD Toolbox — todas as extensões da GOOD numa só

Módulos dentro (cada um é o código ORIGINAL da extensão que você já usava, sem mudança):
- ⚠️ **Alerta Frágil** (checkout do Bling) — automático; config no menu do popup
- 🧾 **NF-e Fulfillment Magalu + Shopee** (Bling) — automático
- 📦 **Etiquetas Madeira Madeira** — painel no popup
- 💬 **Respostas Rápidas ML** — painel no popup
- 🔁 **Devoluções Bridge** (app de Devoluções) — automático
- 🍪 **Sessão Shopee** (novo) — painel no popup, envia os cookies sem DevTools

A antiga "Localização Estoque" ficou de fora de propósito: o checkout offline já cobre (pesquisa por SKU/EAN, edição e impressão do código de barras).

## Instalar no Edge (GOOD)
1. Baixe o repositório (Code → Download ZIP) e extraia; a pasta é `good-toolbox-extensao`.
2. `edge://extensions` → **Modo de desenvolvedor** → **Carregar sem pacote** → escolha a pasta.
3. As configurações das extensões antigas NÃO migram sozinhas (cada uma guardava a sua). Reconfigure TODOS os módulos (uns 3 minutos, uma vez só):
   - **Madeira Madeira** (popup → Madeira Madeira): URL do Render + GOOD_MM_SYNC_KEY.
   - **Respostas Rápidas** (popup → Respostas): URL do serviço + RESPOSTAS_API_KEY + loja.
   - **Sessão Shopee** (popup → Sessão Shopee): ADMIN_KEY.
   - **Alerta Frágil** (popup → Alerta Frágil, abre as opções): URL do servidor — sem ela o alerta NÃO sincroniza os SKUs.
   - **NF-e Fulfillment Magalu** e **Shopee Full**: a config é no PRÓPRIO painel que a extensão mostra dentro do Bling. ⚠️ Numa instalação nova, o cartão da **Shopee NÃO aparece sozinho** (sem chave ele fica mudo de propósito): com o Bling aberto, aperte **Ctrl+Alt+S** pra forçar o cartão e clique em **Configurar**; o da Magalu aparece sozinho quando há trabalho, e a config é pelo mesmo botão. Sem isso, nota do Full deixa de entrar no Bling.

## Roteiro de teste antes de aposentar as antigas
Com a Toolbox instalada e as antigas AINDA ativas, DESATIVE as 5 antigas (não desinstale) em `edge://extensions` e confira um fluxo de cada:
1. Checkout do Bling com SKU frágil → o alerta aparece.
2. Página de NF no Bling → a importação Magalu/Shopee segue rodando.
3. Painel MM aberto → popup → Madeira Madeira → Sincronizar agora.
4. Uma venda no ML → as respostas rápidas aparecem.
5. App de Devoluções → o bridge segue preenchendo.
6. Popup → Sessão Shopee → Enviar (logado no Seller Center da GOOD).
Tudo ok? Aí sim remova as 5 antigas. Algo estranho? Reative a antiga daquele módulo e me avise.
