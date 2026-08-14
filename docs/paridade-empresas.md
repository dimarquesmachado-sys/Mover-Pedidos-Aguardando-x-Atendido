# Paridade entre as empresas — levantamento de 14/08/2026

Feito porque as diferenças vinham sendo descobertas por acidente (um conserto entrava numa
empresa e a outra ficava para trás). Aqui está o mapa, gerado a partir das rotas realmente
declaradas em cada módulo no `main`.

| empresa | módulo | arquivos | rotas |
|---|---|---|---|
| Girassol | `girassol-backup-offline` | 22 | 128 |
| AMBTotal | `amb-checkout-offline` | 20 | 129 |
| GOOD | `good-checkout-offline` | 13 | 77 |

**Leitura honesta:** Girassol e AMB estão próximas (as diferenças são quase todas sondas de
diagnóstico e recursos ainda em construção). A **GOOD é a que está mais atrás** — falta
praticamente todo o bloco de inteligência de vendas: ela não tem dashboard de margem, nem
histórico, nem os coletores da Shopee.

### Só na Girassol (falta na AMB)

- `debug-custo`
- `debug-custo-pedido`
- `debug-nf-emissao`
- `debug-vendas-raw`
- `diag-pedido`
- `diag-venda-ml`
- `sonda-bling-pedido`
- `sonda-ml-claims`
- `sonda-ml-pagamento`
- `sonda-mp`

### Só na AMB (falta na Girassol)

- `magalu-caca`
- `magalu-debug`
- `ml-creditos-flex`
- `ml-flex-debug`
- `produto-fotos`
- `shopee-devolucao`
- `shopee-semear`
- `shopee/conciliar`
- `sku-orfaos`
- `sku-repara`
- `sonda-un`

### Nas duas (Girassol e AMB) e ausente na GOOD

- `auditoria-ml`
- `backfill`
- `backfill-ano`
- `backfill-conferir`
- `backfill-limpar`
- `backfill-status`
- `backfill-teste`
- `bling-cru`
- `completar-detalhes`
- `config-frete-magalu`
- `historico-linhas`
- `historico-longo`
- `limpar-expedicao`
- `ml-billing`
- `ml-billing-resumo`
- `ml-billing-status`
- `ml-vendas-do-dia`
- `ml-vendas-faltando`
- `noturna-status`
- `pescar-tarifas`
- `pescar-tarifas-status`
- `plano-compra`
- `previsao-vendas`
- `produto-cru`
- `reaplicar-imposto`
- `reaplicar-status`
- `rodar-noturna`
- `saude-integracoes`
- `shopee/api`
- `shopee/coletar-ads`
- `shopee/coletar-carteira`
- `shopee/coletar-devolucoes`
- `shopee/conferir`
- `shopee/lote`
- `shopee/resumo`
- `shopee/sonda`
- `shopee/status`
- `shopee/tarifa-por-sku`
- `status-mkt`
- `varrer-cancelados`
- `varrer-cancelados-status`
- `varrer-fornecedores`
- `varrer-fornecedores-status`
- `vendas-sync`

## O que já foi unificado (código único, empresa como parâmetro)

- `lib/shopee-ads.js` — coleta e resumo de Shopee Ads, na régua do painel (ROAS/ACOS/CAC/CTR)
- `lib/shopee-conciliar.js` — conciliação carteira × escrow

Cada peça que sai da cópia para a lib reduz o "porte 3×". A ordem sugerida das próximas,
da que mais dói para a que menos dói:

1. **escrow / contasDoEscrow** — a fórmula da Shopee vive em 3 cópias e já mordeu antes
   (o campo `shipping_seller_protection_fee_amount` existia na AMB e não na Girassol)
2. **devoluções e carteira da Shopee** — mesmos coletores, 3 vezes
3. **pesca do ML (`mlSyncFees` / `pescarDadosML`)** — hoje são DUAS cópias dentro do mesmo
   arquivo em cada empresa; foi a origem do bug do bônus Flex, corrigido só numa delas
4. **histórico / backfill** — o maior, e o que mais se beneficia
5. **dashboard** — por último: é HTML e depende dos anteriores

## Devoluções detalhadas: por que a Shopee tem e o ML não

Na Shopee o endpoint de returns entrega SKU, motivo e texto do comprador, e isso já vira o
card de devoluções por SKU. No ML pegamos o **custo** (a categoria "devolução" do faturamento,
que já entra no card de despesas), mas não a lista. A sonda `sonda-ml-claims` existe na
Girassol e é o caminho: falta habilitar a permissão de pós-venda no app do ML e escrever o
coletor equivalente ao da Shopee.
