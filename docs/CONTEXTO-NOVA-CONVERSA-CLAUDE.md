# Contexto geral para uma nova conversa com o Claude

> **Objetivo deste documento:** permitir que uma conversa nova entenda o negócio, o sistema,
> os erros de método já cometidos e o padrão de trabalho esperado **antes de propor código**.
> Ele não é uma ordem para implementar todo o roadmap de uma vez. Cada mudança deve continuar
> pequena, observável, reversível e revisada.
>
> **Data do retrato:** 6 de setembro de 2026. Números, paridade e integrações precisam ser
> reconferidos no `HEAD` antes de serem citados no futuro.

---

## 1. Resumo executivo

Este repositório é a automação operacional multiempresa da **Girassol**, **AMBTotal** e
**GOOD Import**. O nome antigo (“mover pedidos de Aguardando para Atendido”) já não descreve
o tamanho real do produto. Hoje ele reúne, no mesmo processo Node.js:

- automações e OAuth do Bling;
- checkout, separação, etiquetas, DANFE e operação offline;
- coleta e conciliação de vendas, tarifas, fretes, anúncios, cancelamentos e devoluções;
- integrações com Mercado Livre, Shopee, Magalu e TikTok Shop;
- dashboards de margem, despesas, estoque, compras e saúde das integrações;
- ferramentas auxiliares: estoque, ponto, produtos frágeis, imagens, respostas rápidas,
  mensagens automáticas, conferência de marketplaces e backup.

O sistema entrega muito valor e contém várias travas aprendidas com casos reais. O principal
risco atual não é “falta de funcionalidade”; é a combinação de **aproximadamente 95 mil linhas
de JavaScript/HTML**, módulos grandes, pouca cobertura automatizada de comportamento,
persistência em arquivos JSON, muitos fluxos no mesmo processo e código ainda copiado entre
empresas. Nesse cenário, uma correção local pode quebrar outra empresa ou transformar uma
falha de API em dado financeiro aparentemente confiável.

### Regra de ouro

**Nunca inventar uma explicação quando o sistema pode mostrar a evidência.** Primeiro observar
os dois lados da integração, a paginação completa, o horário/fuso, a idade do cache e o HTTP
real; depois formar a hipótese; por último corrigir.

---

## 2. Mapa do projeto

### Núcleo e orquestração

| Área | Onde está | Papel |
|---|---|---|
| Processo principal | `index.js` | servidor HTTP, segurança central, handlers globais e crons — **inventário completo** do que sobe no processo (inclui Magalu, TikTok Shop/Ads, `ml-full` e coletores globais que não passam por `config/empresas.js`) |
| Módulos ativos | `config/empresas.js` | registro dos handlers/crons **por empresa**; não é o inventário completo — ver `index.js` |
| Cadastro lógico | `lib/empresas.js` | lista de empresas, nomes de env e compatibilidade histórica |
| Novo embarque | `lib/embarcar-empresa.js` | pré-checagem e orquestração inicial de coletores |
| Persistência analítica | `lib/supabase.js` | histórico multiempresa no Supabase |
| Integridade | `scripts/verifica.js` | sintaxe, espelhos, assinaturas de feature e identidade dos módulos |

### Operação por empresa

- `girassol/`, `ambtotal/` e `good/`: automações Bling e fiscais.
- `girassol-backup-offline/`, `amb-checkout-offline/` e
  `good-checkout-offline/`: checkout, cache offline e painéis.
- `lib/`: conciliações e serviços que começaram a ser extraídos das cópias por empresa.
- `magalu-oauth/`, `tiktok-oauth/` e `tiktok-ads/`: handlers globais dessas integrações.
- `auto-mensagens/`, `lixas-combinar/`, `estoque*`, `fragil/`, `ponto/` e demais pastas:
  produtos operacionais independentes, mas carregados pelo mesmo servidor.

### Situação de paridade conhecida

O levantamento existente em `docs/paridade-empresas.md` encontrou **129 rotas** no checkout
da Girassol, **129 na AMB** e **77 na GOOD**. A GOOD não tem ainda o mesmo bloco analítico das
outras duas. Esse número é um retrato, não um contrato: rode novamente um inventário antes de
planejar a próxima migração.

A extração da Shopee (escrow, carteira e devoluções) **já está concluída** em
`lib/shopee-escrow.js` e `lib/shopee-devolucoes.js`, consumidas por Girassol e AMB; a GOOD não
tem hoje integração financeira Shopee (a lacuna é decidir se/quando embarcá-la, não reextrair).
Continuam como dívida importante:

1. unificar a coleta de faturamento e tarifas do Mercado Livre;
2. extrair histórico/backfill;
3. só então criar componentes comuns do dashboard.

Migrar o HTML primeiro seria inverter a dependência: a tela comum ficaria apoiada em dados e
regras ainda divergentes.

---

## 3. O que já melhorou e deve ser preservado

### Segurança e operação

- rotas administrativas relevantes usam `ADMIN_KEY` ou sessão e respondem como não existentes
  quando o acesso não é autorizado;
- callbacks OAuth são tratados separadamente para não bloquear o retorno do provedor;
- alertas administrativos não devem aparecer para estoquistas;
- crons têm identificação por empresa e várias rotinas têm lock/watchdog;
- o canário de integrações tenta distinguir falha real, ausência de dado e coleta incompleta;
- diagnósticos recentes passaram a exibir a evidência do marketplace e do Bling em vez de dar
  apenas um veredito.

### Confiabilidade de dados

- paginação incompleta não deve concluir “não existe”;
- falha de rede não pode virar zero, lista vazia nem sucesso;
- caches mostram (ou devem mostrar) quando foram atualizados;
- backfills destrutivos ganharam spool, validação antes do `DELETE` e proteção contra rodadas
  concorrentes;
- fuso de `America/Sao_Paulo` e folga nas janelas passaram a ser considerados em comparações;
- várias conciliações diferenciam valor observado, cobertura, pendência e veredito indeterminado.

### Processo de revisão

Existem três guardrails úteis:

1. `ai-pr-checks.yml`: valida a sintaxe de todos os `.js` e do maior `<script>` dos painéis;
2. `verifica.yml` + `scripts/verifica.js`: procura cópia divergente, feature apagada e arquivo
   da empresa errada;
3. `orfaos.yml`: usa ESLint para achar identificadores órfãos.

O loop Claude ↔ Codex também passou a:

- ignorar revisão de commit antigo;
- pedir correção na mesma branch;
- limitar rodadas automáticas;
- exigir revisão humana quando o limite é atingido;
- conferir se o “OK” do Codex pertence ao `HEAD` atual;
- impedir automerge de mudança em `.github/workflows/` e `scripts/verifica.js` (atenção: `.github/espelhos.json` e `.github/eslint-orfaos.mjs` ainda **não** são cobertos — mudança neles pode passar pelo automerge);
- aguardar o check `ai-safety` antes do merge.

Esses controles devem ser mantidos. O que precisa melhorar é a qualidade **antes** de enviar
cada nova rodada ao Codex.

---

## 4. Onde o Claude errou muito nas revisões

O histórico local registra **64 commits explicitamente rotulados como correções do Codex,
agrupados em 22 PRs**. Entre esses grupos, houve nove com três commits de correção, dois com
quatro, um com cinco e um com seis. O número não mede todo o trabalho nem prova sozinho demora,
mas mostra objetivamente retrabalho serial. Os casos mais instrutivos são:

| PR | Sinal no histórico | Falha de método |
|---|---|---|
| `#335` | cinco correções Codex | cada remendo do orçamento/cache abriu outra saída: cache contado como chamada, endpoint incompatível com o caminho real, retorno objeto usado como string, suposição falsa sobre cache de token e erro HTTP não cacheado |
| `#309` | seis commits de correção | só se tratou o “caminho feliz”; `undefined`, recusa, concorrência, mesmo período duplicado, placeholder e motivo de adiamento foram descobertos um por vez |
| `#322` | quatro correções | o conceito correto era **frescor do dado**, mas foram acrescentadas guardas locais sucessivas para cache vazio, dado antigo e sincronização parada |
| `#325` | segunda rodada encontrou três problemas adicionais | comentários inline foram filtrados pelo fuso errado e threads foram marcadas como resolvidas sem leitura; havia `for...of` sobre async generator e risco de apagar/regravar mês incompleto |
| `#300` | três correções, começando com oito apontamentos | estruturas da API Magalu foram inferidas de uma amostra; arrays, múltiplas entregas, limites e identificadores não foram tratados como matriz de casos |
| `#272`, `#254`, `#269`, `#287` | três rodadas cada | correções criaram novas corridas, perda/silêncio de dados ou furos na própria regra que tentavam proteger |

### Padrões recorrentes

1. **Corrigir o sintoma, não a invariável.** Exemplo: perguntar “qual guarda falta?” em vez de
   “em que condições este dado pode ser considerado atual e completo?”.
2. **Ler só o trecho alterado.** O chamador, os retornos antecipados, o módulo irmão e o estado
   global frequentemente contradiziam a suposição local.
3. **Supor contratos.** Houve afirmação de que uma função tinha cache sem abrir sua implementação,
   endpoint escolhido só pela documentação sem comparar com o endpoint comprovado no projeto e
   formatos de resposta deduzidos de um caso.
4. **Testar somente sintaxe.** `node --check` não detecta função inexistente, `undefined` no caminho
   feliz, uso errado de async generator, corrida nem cálculo financeiro incorreto.
5. **Não testar as bordas do lote.** Primeiro item, item 25/26, página final, página vazia, teto
   exato, cache hit/miss, HTTP 429 e retomada seguinte precisam entrar juntos.
6. **Falha silenciosa.** `catch` tolerante demais, retorno seco e fallback vazio fizeram coleta
   parcial parecer sucesso.
7. **Editar cópias sem matriz de paridade.** Uma empresa recebia o conserto e a irmã ficava com
   o defeito, ou uma extração comum perdia configuração específica.
8. **Resolver thread sem verificar.** “Marcar como resolvida” não substitui ler todos os comentários
   ativos no `HEAD` e demonstrar qual teste cobre cada um.
9. **Ampliar escopo durante correção.** Um ajuste novo no meio da rodada cria superfícies que o
   revisor anterior nunca avaliou.
10. **Comunicação categórica com prova parcial.** “Não existe”, “integração caiu” e zero financeiro
    exigem cobertura; sem ela, o estado correto é `indeterminado`/`desatualizado`.

---

## 5. Como o Claude deve trabalhar daqui para frente

### Antes de escrever código

1. Leia `README.md`, `docs/paridade-empresas.md`, `scripts/verifica.js`, o módulo alterado e **todos
   os seus chamadores**.
2. Faça `git status`, identifique o `HEAD` e não sobrescreva trabalho existente.
3. Abra todos os apontamentos ativos do PR, inclusive inline, sem filtro improvisado por data.
4. Escreva a invariável em uma frase. Exemplos:
   - “nenhum período é apagado antes de o spool completo ser validado”;
   - “cache velho nunca aparece como zero atual”;
   - “uma consulta só consome orçamento quando houve ida real ao provedor”.
5. Monte uma tabela de cenários antes do patch: feliz, vazio, ausente, velho, parcial, duplicado,
   concorrente, timeout, 401, 404, 429, 5xx, limite de página e retomada.
6. Confira o contrato em três fontes, nessa ordem:
   - resposta real/fixture anonimizada do caso;
   - caminho que já funciona no repositório;
   - documentação oficial vigente.
7. Se as três divergirem, não escolher silenciosamente: criar sonda somente leitura, registrar
   a divergência e pedir decisão humana quando houver risco operacional.

### Durante a implementação

- Corrija a causa comum de uma vez; não faça uma sequência de `if`s para exemplos individuais.
- Separe estados `ok`, `sem_dado`, `parcial`, `desatualizado`, `nao_rodou`, `falhou` e
  `indeterminado`. Não comprima tudo em booleano.
- Em mutações, use idempotência, lock com dono/geração, escrita atômica e retomada segura.
- Em paginação, persista cursor/checkpoint e publique `completo`, itens/páginas lidos e motivo da
  interrupção.
- Em cache, guarde `coletado_em`, janela coberta, fonte, versão do schema e erro da última coleta.
- Nunca faça `catch {}` em um caminho que pode alterar estoque, NF, status ou histórico financeiro.
- Não exponha `ADMIN_KEY` em links/respostas/logs; preferir sessão administrativa ou header.
- Não incluir segredo em query string; query aparece em histórico, analytics e logs.
- Ao tocar uma empresa, procurar o mesmo código nas outras e decidir explicitamente entre
  extrair, portar ou documentar a diferença legítima.

### Antes do push

Para cada apontamento do Codex, produzir uma pequena tabela no PR:

| Apontamento | Causa raiz | Arquivo/linha | Teste que falhava | Resultado depois |
|---|---|---|---|---|

Depois executar, no mínimo (o ESLint e seus plugins não estão no `package.json`; instalar
primeiro com o comando pinado do cabeçalho de `.github/eslint-orfaos.mjs`, o mesmo que o CI usa):

```bash
npm install --no-save eslint@9.39.5 eslint-plugin-html@8.1.4 globals@17.11.0
node scripts/verifica.js
npx eslint --no-config-lookup -c .github/eslint-orfaos.mjs .
```

Além disso, criar/executar um teste comportamental focado na mudança. Só `node --check` é uma
barreira de sintaxe, não evidência de correção. Quando houver dashboard, extrair e validar o
JavaScript embutido e testar as respostas da rota que alimenta o card. Quando houver fluxo real,
subir o servidor com integrações mockadas e provar autenticação, retorno e efeito colateral.

### Disciplina para revisão do Codex

1. Ler **todas** as threads, agrupar por causa raiz e responder em lote.
2. Não resolver thread antes de o commit e o teste correspondente estarem no remoto.
3. Após corrigir, reler o diff inteiro como adversário — especialmente linhas adicionadas pela
   própria correção.
4. Comparar `reviewed SHA` com `HEAD SHA`.
5. Pedir uma única nova revisão depois de passar na matriz local, não uma revisão por remendo.
6. Se o mesmo conceito aparecer pela segunda rodada, parar de remendar, redesenhar a invariável e
   adicionar teste de regressão.
7. Na terceira rodada do mesmo tema, chamar humano mesmo que a automação permita cinco; custo e
   risco já indicam que falta entendimento do domínio.
8. Nunca dar merge. O responsável humano decide, especialmente em estoque, fiscal, financeiro,
   autenticação e guardrails.

---

## 6. Melhorias técnicas prioritárias do projeto inteiro

### P0 — confiança e segurança

1. **Testes comportamentais determinísticos.** Adotar `node:test` (já vem no Node) e começar pelos
   bugs históricos: paginação truncada, cache velho, retorno `undefined`, concorrência, 429,
   backfill antes/depois do delete, packs e múltiplas entregas.
2. **HTTP compartilhado de verdade.** Centralizar timeout, retry com `Retry-After` + jitter,
   classificação de erro, limite por provedor, correlation ID e métricas em `lib/http-client.js`.
   Hoje há wrappers e políticas duplicadas.
3. **Segredos fora da URL.** Migrar gradualmente `?k=ADMIN_KEY` para sessão/cookie `HttpOnly`, ou
   header em chamadas de máquina, com rotação e auditoria.
4. **Escrita atômica e locks robustos.** JSON em disco deve usar arquivo temporário + `fsync` +
   rename, lock com lease/owner e recuperação após reinício. Para histórico e jobs críticos,
   preferir banco/fila.
5. **Contrato de resultado único para jobs.** Todo job retorna estrutura versionada com `estado`,
   `inicio`, `fim`, `empresa`, `fonte`, `janela`, `cobertura`, contadores, `checkpoint`, erros e
   próximo passo. Nunca inferir sucesso de `undefined`.

### P1 — arquitetura e escala

1. **Separar conectores de regra de negócio.** Interface por canal:

   ```text
   authorize / refresh
   pullOrders / pullSettlements / pullReturns / pullAds
   normalize
   health
   backfill(checkpoint)
   ```

   Cada provedor traduz seu formato para modelos canônicos (`Order`, `OrderItem`, `Shipment`,
   `SettlementEntry`, `Return`, `AdSpend`). Dashboard e conciliação não conhecem JSON bruto.
2. **Configuração declarativa por tenant.** Uma empresa deve ser dado, não pasta copiada:
   `empresa`, canais ativos, seller/shop/account IDs, timezone, status Bling, unidades de negócio,
   feature flags e referências de segredo. Manter adaptadores apenas quando o comportamento for
   realmente diferente.
3. **Job queue e workers.** Tirar backfill/coletas longas do request HTTP e do mesmo event loop do
   checkout. Fila persistente com idempotency key, tentativas, dead-letter, prioridade e progresso.
4. **Banco como fonte da verdade analítica.** Guardar eventos brutos imutáveis e tabelas
   normalizadas/upserts no Supabase/Postgres; arquivo local pode continuar como cache operacional,
   não como única prova financeira.
5. **Dividir módulos gigantes.** Rotas, coletores, domínio, armazenamento e apresentação devem
   ter arquivos próprios. Isso permite testes e reduz substituições textuais perigosas.
6. **Schema e migração.** Versionar payloads/cache e validar na borda (por exemplo, JSON Schema ou
   validador leve). Campo ausente vira erro conhecido, não `0` por coerção.

### P2 — observabilidade e operação

- logs JSON com `request_id`, `job_id`, `empresa`, `canal`, `endpoint`, tentativa e duração;
- métricas de latência, 429/401/5xx, atraso de sincronização, páginas, itens, fila e cobertura;
- alertas por SLO e impacto, não por exceção isolada;
- endpoint de saúde por conector, sem segredo e sem dado comercial;
- trilha de auditoria para ações manuais e mutações automáticas;
- replay seguro a partir do evento bruto/checkpoint;
- runbooks curtos: token vencido, rate limit, marketplace fora, cache velho, spool órfão e
  divergência financeira.

---

## 7. Melhorias específicas por marketplace

As referências oficiais abaixo são os portais que devem ser reabertos na hora da implementação,
porque contratos, permissões e limites mudam. Parte da documentação da Shopee e do TikTok exige
login de parceiro. **Não codificar nome de endpoint, campo ou limite lembrado de cabeça.** Neste
ambiente, o acesso externo aos portais retornou bloqueio de rede; portanto as recomendações desta
seção são arquiteturais e precisam de validação contra a versão oficial vigente e uma resposta
real anonimizada antes do código.

### Mercado Livre

Referências: [portal de developers](https://developers.mercadolivre.com.br/),
[notificações](https://developers.mercadolivre.com.br/pt_br/notificacoes),
[gerenciamento de vendas](https://developers.mercadolivre.com.br/pt_br/gerenciamento-de-vendas)
e [autenticação/autorização](https://developers.mercadolivre.com.br/pt_br/autenticacao-e-autorizacao).

Melhorias recomendadas:

- receber notificações como gatilho e responder rápido; processar de forma assíncrona, deduplicada
  e idempotente, buscando depois o recurso oficial pelo ID;
- manter reconciliação periódica por janela sobreposta, porque webhook não substitui conferência;
- persistir relações `order_id`, `pack_id`, ordens irmãs, `shipment_id`, pagamento e número gravado
  no Bling, evitando redescobrir packs a cada canário;
- centralizar OAuth por conta e eliminar validação `/users/me` por candidato; refresh coordenado
  para impedir tempestade de renovação;
- separar eventos de venda das entradas de faturamento/settlement: comissão, frete, anúncios,
  parcelamento, antecipação, créditos, estornos e devoluções não devem depender de uma fórmula
  inferida apenas de `sale_fee`;
- avançar a coleta de claims/devoluções para obter causa, SKU e desfecho, mantendo custo financeiro
  e evento operacional relacionados, mas não confundidos;
- usar cache positivo e negativo com TTL diferente, orçamento por chamada **real**, retry que
  respeite a resposta do provedor e estado indeterminado quando a cobertura não terminou.

Ganho esperado: menos chamadas repetidas, menos falso “fora do Bling”, melhor explicação da margem
e detecção de venda perdida com latência menor.

### Shopee

Referência: [Shopee Open Platform](https://open.shopee.com/).

Hoje parte relevante do projeto chama um serviço intermediário de sincronização. Antes de escalar,
documentar formalmente quem é a fonte, SLA, autenticação, paginação, retenção e versão desse
contrato. Se possível, usar o conector oficial como fronteira única e deixar o intermediário atrás
da mesma interface.

Melhorias recomendadas:

- estender a biblioteca multiempresa já extraída (`lib/shopee-escrow.js`, `lib/shopee-devolucoes.js`)
  — as lacunas reais são a GOOD (sem Shopee financeira hoje) e os componentes comuns de dashboard;
- implementar ingestão incremental com cursor/checkpoint e reconciliação sobreposta;
- guardar ledger financeiro por entrada, pedido e SKU, preservando sinal/moeda/tipo original antes
  de calcular comissão, frete, proteção do vendedor, ajuste, anúncio e reembolso;
- tratar cancelamento/devolução parcial por item e quantidade, não somente por pedido;
- validar timestamp e assinatura de push/webhook conforme a documentação vigente, deduplicando o
  identificador do evento;
- monitorar vencimento de credencial/Partner Key com antecedência e provar em ambiente controlado
  que a renovação não interrompe as três empresas.

Ganho esperado: uma única correção beneficia todas as empresas, conciliação por SKU mais fiel e
menos dependência de coleta integral noturna.

### Magalu

Referência: [Magalu Developers](https://developers.magalu.com/) e o catálogo oficial autenticado
da API de Seller.

Melhorias recomendadas:

- transformar pedidos, entregas, invoices, returns, reverse logistics e financial analysis em
  recursos normalizados e relacionados por IDs estáveis;
- suportar explicitamente múltiplas `deliveries`, múltiplos itens, devolução parcial e ausência de
  campos; nunca inferir o pedido inteiro da primeira entrega;
- tratar paginação/teto como cobertura incompleta e persistir checkpoint;
- separar `cancelled_at`, estorno financeiro, saída física, entrega e retorno: são eventos distintos
  e produzem ações opostas sobre NF, estoque e contestação;
- adotar cache de capacidades por versão/conta para endpoints que variam, em vez de sondas 404 em
  cada execução;
- automatizar a fila de casos acionáveis (`nf_sem_saida`, `saiu_e_nao_entregou`,
  `entregue_apos_estorno`) com prazo, responsável, evidências e resultado da contestação.

Ganho esperado: menos classificação errada de prejuízo, backfill retomável e operação de exceções
orientada a ação.

### TikTok Shop

Referências: [TikTok Shop Partner Center](https://partner.tiktokshop.com/) e
[TikTok for Business API](https://business-api.tiktok.com/portal/docs).

O projeto corretamente já separa Shop API de Ads API, mas isso precisa aparecer também no modelo
de credenciais, saúde, limites e dados.

Melhorias recomendadas:

- separar `shop_id`/seller, advertiser e credenciais por empresa sem fallback ambíguo;
- usar webhooks assinados para mudanças de pedido/return e manter reconciliação incremental;
- preservar a linha do tempo da devolução (pedido, postagem, recebimento, decisão, timeout/revelia,
  reembolso e lançamento financeiro) para medir prazo e causa real do prejuízo;
- ligar gasto de Ads à venda somente com regra de atribuição explícita (janela, timezone, moeda e
  nível campanha/produto), mostrando orgânico, pago e “não atribuível” separadamente;
- fazer backfill financeiro por janela fechada e reabrir janelas recentes, pois ajustes chegam
  depois do pedido;
- rate-limit e refresh coordenados por app/loja, com checkpoint independente para uma loja não
  bloquear as demais.

Ganho esperado: CAC/ROAS menos enganoso, devoluções por revelia acionáveis e onboarding sem misturar
contas de Shop e Ads.

---

## 8. Como melhorar o dashboard

O dashboard não deve ser apenas uma soma bonita; precisa dizer **se o número merece confiança**.

### Camada de confiança obrigatória

Todo card financeiro deve exibir:

- período e timezone;
- “atualizado há X”; fonte(s) e versão da fórmula;
- cobertura: pedidos/itens/páginas esperados versus lidos;
- estados `completo`, `parcial`, `desatualizado`, `indeterminado` ou `sem dado`;
- possibilidade de abrir o cálculo até pedido/SKU/lançamento;
- diferenças entre estimado, observado pelo marketplace e conciliado no extrato.

**Nunca mostrar `R$ 0,00` quando a coleta falhou ou não existe.** Zero é um dado; ausência é outro.

### Visões que trazem performance operacional

1. **Cockpit executivo:** GMV, receita líquida, margem de contribuição, pedidos, ticket, CAC/ACOS,
   cancelamento, devolução, atraso e capital em estoque, comparados ao período anterior.
2. **Rentabilidade por SKU/canal/empresa:** preço, custo, imposto, comissão, frete, ads, devoluções,
   margem em reais/percentual e cobertura do custo.
3. **Fila de exceções acionáveis:** venda fora do Bling, NF sem saída, entregue após estorno,
   devolução sem desfecho, token a vencer, cache velho e divergência financeira — com dono, prazo,
   valor em risco e ação sugerida.
4. **Funil operacional:** aprovado → Bling → NF → etiqueta → separado → enviado → entregue, com
   quantidade, valor e idade em cada etapa.
5. **Saúde das integrações:** última coleta boa, atraso, taxa de erro/429, checkpoint, backlog e
   circuit breaker por marketplace/empresa.
6. **Previsão e compras:** velocidade ponderada, dias de cobertura, lead time do fornecedor,
   sazonalidade, margem e risco de ruptura/excesso; sempre separar previsão de fato observado.

### Performance técnica da tela

- APIs agregadas por seção, com filtros no servidor; não mandar todo o histórico ao navegador;
- materialized views/agregações diárias para períodos longos;
- cache HTTP/ETag para leitura e invalidação após coleta;
- carregamento progressivo: resumo primeiro, drill-down sob demanda;
- paginação/virtualização de tabelas grandes;
- componentes JS/CSS comuns depois da unificação das regras;
- orçamento mensurável: p95 de API, tamanho do payload, tempo até primeiro card e memória no
  navegador.

---

## 9. Embarcar novas empresas com rapidez e segurança

O `lib/embarcar-empresa.js` foi um bom primeiro passo, mas hoje ele próprio reconhece uma limitação:
empresa nova ainda precisa de módulo Bling próprio. O objetivo correto é sair de “copiar uma pasta”
para **registrar um tenant e conectar canais**.

### Experiência-alvo

1. Admin cria a empresa (`slug`, nome, timezone, CNPJ e feature flags).
2. Wizard mostra canais opcionais: Bling, ML, Shopee, Magalu, TikTok Shop e TikTok Ads.
3. Cada botão OAuth guarda credenciais no cofre e descobre seller/shop/account IDs.
4. Uma pré-checagem testa permissões, relógio, paginação, webhook, escrita segura e acesso ao
   Supabase sem fazer mutação comercial.
5. O sistema roda backfill assíncrono, retomável e idempotente, com progresso por canal.
6. Reconciliação compara uma amostra com os portais e pede aceite humano.
7. Só então ativa crons/webhooks; rollback desativa a empresa sem apagar seus dados.

### Manifesto sugerido

```json
{
  "id": "novaempresa",
  "nome": "Nova Empresa",
  "timezone": "America/Sao_Paulo",
  "canais": {
    "bling": { "ativo": true, "contaRef": "secret://...", "situacoes": {} },
    "mercadoLivre": { "ativo": true, "sellerRef": "..." },
    "shopee": { "ativo": false },
    "magalu": { "ativo": true, "seller": "..." },
    "tiktokShop": { "ativo": true, "shopRef": "..." },
    "tiktokAds": { "ativo": false }
  },
  "features": { "checkout": true, "dashboard": true, "fiscal": true }
}
```

O manifesto não contém segredo; apenas referências. Deve ter schema, versionamento, validação de
unicidade e migração.

### Definition of Done do onboarding

- credenciais ausentes/expiradas detectadas;
- webhook assinado ou polling incremental configurado;
- uma página e a paginação completa testadas;
- IDs de loja/seller descobertos e confirmados;
- tabelas/policies/migrações prontas;
- backfill com checkpoint, cobertura e reconciliação;
- dashboard mostra empresa sem código novo;
- crons/jobs aparecem na saúde e podem ser desativados isoladamente;
- teste prova que dados e tokens não vazam entre empresas;
- runbook e rollback gerados automaticamente.

---

## 10. Roadmap pragmático de 90 dias

### Semanas 1–2: parar o retrabalho

- criar suíte `node:test` com os 15–20 bugs históricos de maior impacto;
- padronizar resultado de job e estados de cobertura/frescor;
- acrescentar check de teste ao PR;
- exigir tabela apontamento → causa → teste nas correções do Codex;
- reduzir para revisão humana na terceira repetição conceitual.

### Semanas 3–5: fundação de integrações

- HTTP/OAuth/rate limit compartilhados;
- storage atômico e checkpoints;
- modelo canônico e adaptador de um canal (começar pelo fluxo financeiro mais doloroso);
- logs/métricas por empresa e canal.

### Semanas 6–8: eliminar cópias caras

- concluir Shopee compartilhada;
- unificar pesca/billing ML;
- extrair histórico/backfill;
- testes de contrato com fixtures anonimizadas de cada provedor.

### Semanas 9–10: dashboard confiável

- camada única de frescor/cobertura;
- agregações no servidor/banco;
- fila de exceções com valor em risco;
- metas de performance e medição p95.

### Semanas 11–12: onboarding real

- manifesto/schema de tenant;
- wizard de pré-checagem/OAuth;
- backfill em fila com progresso;
- embarcar uma empresa fictícia em staging sem criar pasta nem alterar código;
- documentar tempo, falhas e rollback antes da primeira empresa real.

---

## 11. Pedido inicial sugerido para a nova conversa

Copie este documento para o Claude e use algo próximo disto:

> Leia este contexto e o código citado antes de agir. Primeiro me devolva: (1) o que você entendeu
> do negócio; (2) riscos/invariantes da área que vamos alterar; (3) evidências que ainda faltam;
> (4) matriz de testes incluindo falha/parcial/concorrência; e (5) um plano pequeno e reversível.
> Não escreva código antes disso. Não suponha contrato de API, não transforme ausência em zero,
> não marque thread do Codex sem ler e provar a correção, não copie solução entre empresas sem
> conferir diferenças, não amplie o escopo e nunca faça merge. Quando eu aprovar o plano, trabalhe
> na mesma branch do PR, rode os checks e relacione cada apontamento ao teste que o impede de voltar.

### Perguntas que ele deve responder antes de cada tarefa

1. Qual decisão de negócio esta mudança automatiza?
2. Qual é a fonte de verdade e quão fresca/completa ela está?
3. O que acontece com 0, ausente, parcial, duplicado, atrasado e fora de ordem?
4. Há mais de uma entrega, item, pagamento, estorno, empresa ou rodada concorrente?
5. A ação é idempotente? Como retoma após morrer no meio?
6. Qual empresa irmã tem o mesmo código? A diferença é intencional?
7. Que teste falharia antes do patch e passa depois?
8. Como o operador percebe erro sem olhar log bruto?
9. Como desfazer sem perder histórico, NF, estoque ou dinheiro?
10. O Codex revisou exatamente o `HEAD` atual e todas as threads foram realmente lidas?

---

## 12. Conclusão honesta

O projeto não precisa de mais velocidade de digitação; precisa de **menos rodadas de suposição**.
Claude e Codex funcionam bem como pares quando o Claude traz domínio, evidência e testes, e o Codex
atua como adversário. Funcionam mal quando o primeiro manda um patch baseado em amostra, o segundo
acha uma borda, e a borda é remendada sem redesenhar a regra.

O melhor investimento agora é transformar os aprendizados já escritos nos commits em contratos,
fixtures e testes. Depois, extrair conectores multiempresa e tornar empresa/configuração um dado.
Isso melhora ao mesmo tempo a confiabilidade, a performance do dashboard, o custo das APIs e a
velocidade de embarcar a quarta, quinta e décima empresa.
