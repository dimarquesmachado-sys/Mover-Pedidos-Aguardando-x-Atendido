# 🧰 Toolbox — Girassol · GOOD · AMB (extensão única)

UMA extensão, instalada nos 3 navegadores. Na primeira vez que abrir o popup, escolha a
EMPRESA daquela instalação — os módulos passam a agir por ela.

| Navegador | Empresa | Instalação |
|---|---|---|
| Chrome | Girassol | `chrome://extensions` → Modo do desenvolvedor → **Carregar sem compactação** |
| Edge | GOOD | `edge://extensions` → Modo de desenvolvedor → **Carregar sem pacote** |
| Firefox | AMBTotal | `about:debugging` → Este Firefox → **Carregar extensão temporária** (manifest.json) — some ao fechar o navegador; recarregar leva 30s |

Pasta a carregar: `toolbox-extensao` (baixe o repositório em Code → Download ZIP).

## Módulos por empresa
- **Todas**: Respostas Rápidas ML · Sessão Shopee · Alerta Frágil (config nas opções) · NF-e Fulfillment Magalu+Shopee (config dentro do Bling — Ctrl+Alt+S força o cartão da Shopee) · Devoluções Bridge
- **Girassol e GOOD**: Etiquetas Madeira Madeira (a rota segue a empresa escolhida)
- **Só Girassol**: Cookie Bling → importador. (A Esteira do Bling entra na próxima versão.)

## Configurar (1x por navegador — nada migra sozinho)
Popup → cada cartão pede a própria chave: MM (…_MM_SYNC_KEY da empresa), Respostas
(RESPOSTAS_API_KEY + loja), Sessão Shopee (ADMIN_KEY), Frágil (URL do servidor). Os NF-e:
botão **Configurar** nos cartões dentro do Bling.

## Migrando da GOOD Toolbox (Edge)
A `good-toolbox-extensao` virou esta. No Edge: instale a Toolbox, escolha GOOD, reconfigure
as chaves, desative a GOOD Toolbox antiga, teste os fluxos e remova a antiga.

## Roteiro de teste (antes de aposentar extensões antigas do navegador)
Com a Toolbox instalada e as antigas DESATIVADAS (não removidas), um fluxo de cada módulo
da empresa. Tudo ok → remove as antigas. Estranho → reativa a antiga daquele módulo e avisa.
