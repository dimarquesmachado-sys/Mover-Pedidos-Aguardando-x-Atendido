# Plano multiloja — passos, em ordem, com estado

**O que é este arquivo.** O norte da consolidação multiempresa: um passo por vez, na ordem,
com o estado de cada um. Nasceu da [auditoria de 13/09/2026](auditoria-multiloja-2026-09.md),
que o dono pediu ao Codex, e existe porque conversa não é memória: quem retomar isto daqui a
três semanas — o dono, o Codex ou eu — precisa saber onde paramos sem reconstruir o raciocínio.

**Regra de uso:** ao concluir um passo, marque aqui no mesmo PR. Plano que não acompanha a
realidade vira ficção e deixa de ser consultado.

**Critério final de sucesso** (definido pela auditoria): dado um quarto registro válido,
credenciais no ambiente e capacidades já existentes, o mesmo artefato implantado sobe rotas e
crons isolados, usa caches/tabelas próprios, autentica nas contas certas e expõe o painel —
**sem criar pasta e sem editar JavaScript**.

---

## Fase 0 — dono único do token do ML  ⏳ DEPENDE DE TERCEIRO

Risco operacional aberto: o refresh do ML é de uso único, e dois serviços renovando a mesma
conta formam corrida. A rota de leitura já existe aqui; falta o outro repositório consumir e
desligar a renovação local.

- [x] rota interna de leitura de token, autenticada só por header
- [ ] Devoluções consome a rota (cache de 5 min, invalidação em 401/403)
- [ ] observar 24-48h com métrica por empresa
- [ ] desligar o refresh do ML no consumidor; depois o do Bling
- [ ] atualizar `dono_hoje` no contrato **depois** do corte real

> Não é trabalho de código aqui dentro — é combinação entre os dois serviços. Fica no topo
> porque a auditoria pede que preceda uma quarta empresa.

## Fase 1 — uma fonte de verdade para empresas  ✅ FEITA (13/09, PR #404)

- [x] `lib/empresas/registro.js` lê o contrato, normaliza alias → id canônico, valida colisões
- [x] `lib/empresas.js` vira fachada, com retorno idêntico nas três empresas
- [x] `EMPRESAS` é filtro de ativação, nunca cadastro implícito
- [x] teste prova a quarta empresa sintética nascendo só de dado
- [x] `config/empresas.js` separa **lojas** de **aplicações**, com as lojas vindas do registro
      e **um único contrato de ativação** (`EMPRESAS` escolhe lojas, `SKIP_EMPRESAS` desliga
      qualquer módulo — os dois normalizados pelo registro) — PR #421
- [x] `valida()` aceita alias **ou** id canônico; `listaCanonica()` para código novo. `lista()`
      preservada de propósito: há estado gravado com esses nomes (o token do Magalu é o
      arquivo `/data/<empresa>.json`) — PR #421
- [x] **capacidades declaradas no contrato** (v11) — derivadas do código, com vocabulário
      FECHADO: capacidade fora da lista derruba o boot, em vez de virar recurso desligado em
      silêncio. ⚠️ o contrato é espelhado byte a byte com o Devoluções: mudança aqui exige o
      PR gêmeo lá (Devoluções #283)
- [x] **fábrica de módulo fiscal** (PR #424): rotas, helpers e a forma do módulo saíram das
      três pastas para `lib/fiscal/criar-modulo.js` — o que sobra em cada pasta é fiação
      (quais peças entram) e os crons, que seguem por empresa porque o F3 é escalonado
- [x] **as peças nascem do registro** (`lib/fiscal/montar-empresa.js`, PR #429): loja que
      está no contrato e não tem pasta é **montada** — rotinas, rotas e crons —, com o F3 num
      minuto de cron livre pra não disputar cota com as existentes. O teste de aceitação da
      auditoria passa: uma quarta empresa nasce só de dado, sem pasta e sem editar JavaScript.
      As três atuais seguem com pasta de propósito — carregam história (caminho de token
      relativo, env sem prefixo, estratégia própria no F1) que o montador não deve adivinhar

## Fase 2 — fábrica fiscal  ✅ FILA CONCLUÍDA (13/09)

Ordem por medição (semelhança entre as pastas, medida em 13/09) — do mais fácil ao mais
arriscado. Cada linha é um PR.

| passo | peça | linhas | AMB×GOOD | AMB×GIR | estado |
|---|---|---:|---:|---:|---|
| 2.1 | `nfFluxos.js` | 324 | 100% | 100% | ✅ PR #405 — a diferença era **uma linha** (env do cooldown) |
| 2.2 | `nfBlingApi.js` | 340 | 89% | 88% | ✅ PR #407 — 54-58 linhas eram só RÓTULO; config real: cache de IE por empresa e nome do intermediador |
| 2.3 | `mlTokenManager.js` | 140 | 90% | 85% | ✅ PR #408 — só env/rótulo; teste guarda o ISOLAMENTO (token trocado fala com a conta errada em silêncio) |
| 2.4 | `nfeMlFluxo.js` | 227 | 92% | 83% | ✅ COMPLETO — capacidade portada (#414) e peça extraída pra `lib/fiscal/nfe-ml-fluxo.js` (#427); tetos seguem por empresa |
| 2.5 | `mlApi.js` | 119 | 88% | 81% | ✅ PR #411 — as TRÊS unificadas por UNIÃO (getShipmentRaw da Girassol pras outras; baixarXmlNFe exportado em todas) |
| 2.6 | `nfTokenManager.js` | 158 | 84% | 80% | ⬜ LIBERADO — ⚠️ a Girassol guarda o token em `<módulo>/data/nf_tokens.json`; preservar o caminho ou migrar o arquivo, nunca trocar em silêncio |
| 2.7 | `blingApi.js` | 202 | 90% | 78% | ✅ PR #415 — após os portes, só rótulo/env; pausas seguem POR EMPRESA (cota do Bling é da conta) |
| 2.8 | `tokenManager.js` | 148 | 88% | 74% | ✅ PR #416 — caminho do arquivo PRESERVADO por empresa (o da Girassol é relativo ao módulo) |
| 2.9 | `index.js` + `fluxos.js` | 534 | 78% | 54-60% | ✅ CLASSIFICADO (PRs #417, #418, #419) — 3 capacidades portadas; o que resta é nome de env sem prefixo, rótulo e caminho de rota |

### O que a Fase 2 entregou, em uma olhada

Sete peças viraram código único (`nfFluxos`, `nfBlingApi`, `mlTokenManager`, `mlApi`,
`nfTokenManager`, `blingApi`, `tokenManager`) e **seis capacidades foram portadas entre
empresas** pelo critério do dono ("uma tem, agora ambas têm"):

| capacidade | estava só em | foi para |
|---|---|---|
| `getShipmentRaw` | Girassol | AMB, GOOD |
| `baixarXmlNFe` exportado | AMB, GOOD | Girassol |
| renovação proativa do token (`expira_em`) | Girassol | AMB, GOOD |
| envio nativo Bling → marketplace (reenvio manual) | Girassol | AMB, GOOD |
| callback OAuth do Bling | AMB, GOOD | Girassol |
| prova do "desfeito pelo Bling" (dois horários) | Girassol | AMB, GOOD |
| conferência pós-move ("aceitou e não aplicou") | Girassol | AMB, GOOD |

**O que continua diferente de propósito** — e não é dívida:

- **pausas e cota** por empresa: a cota do Bling é da conta, não do código;
- **crons escalonados** (F3 nos minutos 0, 2 e 4): igualar recria a competição por cota;
- **caminho dos arquivos de token**: é estado vivo; trocar faz a empresa perder o token;
- **nomes de env sem prefixo na Girassol**: ela foi a primeira empresa do repositório, e o
  registro canônico já resolve isso sem mapa em código.

**Receita de cada passo** (a que funcionou no 2.1, para repetir sem improviso):

1. `diff` das três cópias **antes de qualquer coisa** — a diferença real costuma ser menor
   do que a semelhança sugere, e é ela que dita o parâmetro.
2. Classificar cada diferença: **configuração** (vira parâmetro), **capacidade** (vira flag),
   **bug** (conserta e porta) ou **regra empresarial real** (fica como estratégia injetada).
3. Extrair para `lib/fiscal/<peça>.js` como **fábrica**, com clientes por injeção.
4. As pastas viram **fachadas** que mantêm os `require()` antigos — sem isso o PR vira
   caça a importação quebrada.
5. Teste que prove: deps obrigatórias, contrato das fachadas inalterado, e a diferença
   por empresa continuando a valer (é o que a unificação mais arrisca perder).
6. Remover a peça de `.github/espelhos.json` quando ela deixar de ser cópia.

⚠️ **No 2.9 esperar achado, não só refactor.** Em 54-60% a diferença é de comportamento, e
foi exatamente assim que apareceu o conserto do TikTok que vivia só na Girassol (PR #402) e
a fase direta que a Girassol não tinha (PR #403). Classificar antes de unificar.

## Fase 3 — estrangular o checkout  ⬜

Maior dívida restante (os arquivos centrais somam ~18 mil linhas). Já saíram 8 fatias; o que
resta dentro do `vendasSync` **já divergiu** entre as empresas (677 × 509 linhas), então aqui
vale a mesma regra do 2.9: medir e classificar antes de fundir.

1. mover os arquivos ainda espelhados para import direto da lib — ✅ **feito** (#430, #432):
   `comum`, `produtos`, `etiquetas` e `email-docs` viraram libs. Sobra `nf.js`, que segue
   espelhado de propósito: os dados de cada empresa saíram dele para `emitente-fallback.js`
   (#431), então ele voltou a ser idêntico e não tem exceção nenhuma no verificador
2. extrair repositório de manifesto/cache e o ciclo base — 🔄 **funções do `base.js` feitas**
   (PR #433): as 20 funções e os caches em memória viraram `lib/checkout/base-funcoes.js`;
   a configuração da empresa (envs, `SIT_*`, janelas, pausas) ficou no `base.js`, que é onde
   ela deve estar. Falta o ciclo base
2b. `ciclo.js` **CLASSIFICADO** (PR #434, `docs/fase3-diferencas-ciclo.md`): é a peça mais
   divergente do repo (AMB 1.227, GOOD 1.112, Girassol 747 linhas). Três diferenças, e só uma
   é pergunta aberta — a alavanca `ESPERA_FULL_MS`, que a Girassol não tem. **Não extrair
   antes de decidir isso.**
3. extrair histórico/backfill/vendas-sync sobre um contexto de checkout explícito — 🔄 **começou (19/10)**:
   - a **venda do dia** virou peça única (`lib/checkout/vendas-dia.js`, #710 Girassol, #711 AMB, #714 GOOD — antes 2
     cópias de ~520 linhas e a GOOD sem nenhuma);
   - a **configuração do checkout por empresa** saiu das pastas pra `lib/checkout/config-empresa.js`: empresa NOVA segue
     a convenção (`<PREFIXO>BKP_X`; env **da empresa** nunca cai no nome sem prefixo — é da Girassol; env
     **compartilhada** do serviço da Shopee cai), as três antigas declaram só as exceções históricas, conferidas em
     4.096 combinações de env cada (`scripts/teste-config-empresa-checkout.js`). A venda do dia das três já é montada
     por ela (`criarVendasSyncDaEmpresa`); a pasta só entrega as peças do módulo (`deps`).
   - **regra daqui pra frente:** peça do checkout que precisa de dado da empresa lê de `config-empresa` — nada de
     configuração escrita à mão na pasta (o teste da venda do dia acusa se voltar).
   - **30/10 — o backfill do histórico é UM só** (#765–#770): as três rodam a mesma função
     (`girassol-backup-offline/gbo-app.js` → `backfillVendas(de, ate, empresa, ctx)`), cada uma com o
     **andamento dela** (`estado` no contexto ou `_estadoBackfill(empresa)`) e as fontes dela no contexto
     (Bling, Supabase, token do ML, alíquotas e reserva, custos, Shopee, TikTok, caça da Magalu,
     situações de cancelamento, regra de Flex). A cópia de 690 linhas da AMB saiu; a prova de que ela grava
     as mesmas linhas está em `scripts/teste-backfill-amb-compartilhado.js`.
   - **30/10 — o CICLO do checkout é UMA peça nas três** (`lib/checkout/ciclo-empresa.js`): AMB (#771), GOOD (#773) e
     Girassol (o `ciclo.js` de cada uma é só a configuração). Nivelado por cima: a Girassol ganhou a reconciliação da
     AMB (o 404 do Bling = pedido apagado, conferência um a um acima do limite) e o resto; as três ganharam o índice
     do catálogo da Girassol (foto, nome composto da variação). A prova de cada uma: linha nova só com origem
     conhecida, linha que sai só na lista revisada (`scripts/_ciclo-origem.js`). **Em aberto com o dono:** o filtro
     de Full pela UNIDADE na Girassol fica desligado (`fullAtivo: false`) até ele dizer se ela vende no Full e se
     quer o mesmo tratamento da AMB/GOOD — a venda que o próprio ML diz ser Full já sai da fila nas três.
4. consolidar rotas em registradores por capacidade — 📏 **MEDIDO** (15/09,
   `docs/fase3-rotas-por-capacidade.md`): dos 3 checkouts (121/98/80 rotas), **45 existem nas
   três** — e delas **18 têm corpo idêntico** e 6 quase. Esse é o grupo seguro pra começar; as
   21 divergentes são o próximo `ciclo.js` (classificar antes)
4b. **08/11 — rotas comuns: FEITO o grupo das três** (`lib/checkout/rotas-comuns.js`, **47 rotas**, PRs #787→#816).
   Cada passo uniu as versões (nunca interseção) e tirou as cópias: `/status`, `/dashboard` (só admin nas três),
   `/custo-sync` (status com fila/retry + diário), `/sku-info` (nome, trava do kit, cadastro excluído não ressuscita custo),
   `/config-fiscal` (ciência da alíquota herdada na GOOD; flex da GOOD nas outras; a reaplicação da GOOD foi pro nível do
   módulo). Prova de cada uma: `scripts/teste-rotas-comuns-peca.js` (rota por rota, trocas de propósito revisadas em
   fixtures). **Fica de fora DE PROPÓSITO:** `/backfill-status` e `/backfill-ano` — o contrato de resposta diverge porque o
   **motor** diverge (a GOOD tem o plano automático e a rotina diária próprios: `_bfGood`, `_motorPlanoGood`); juntam
   quando o motor do backfill for um só (`scripts/teste-medicao-rotas.js` trava isso em `PESADAS`).
4c. **FEITO (09/11, PRs #819 → #831) — a Girassol e a AMB não têm mais CÓPIA de rotas que a fábrica do painel serve** (eram 26 e 28, medidas em 08/11; `scripts/teste-fabrica-copias-fora.js` trava as 57 que saíram). Em todas a fábrica era igual ou MAIOR (varredura incompleta não vira "faltando", pack do ML, prazos, falha que conta como "não verificado"); o que só a cópia tinha foi pra fábrica (a trava do canário no backfill). Medição original abaixo, pra referência. A GOOD
   usa a fábrica (`lib/checkout/fabrica-rotas-painel.js` + `rotas-painel-ml.js`); a Girassol tem **26** dessas rotas no
   próprio arquivo e a AMB **28**. **Hoje quem atende nelas é a CÓPIA** — o roteador da empresa testa as rotas
   próprias antes de chamar a fábrica (Girassol `gbo-app.js` ~l. 2460, AMB `index.js` ~l. 3152) — e a versão da fábrica
   dessas rotas só a GOOD usa. Era o combinado de 02/10 ("ligar primeiro, provar que a rota da fábrica responde igual, e
   só então remover a duplicata"). Mesma receita das rotas comuns: por grupo de assunto, unir cópia × fábrica (o que cada
   lado tem a mais), tirar a cópia, provar rota por rota. Linhas de código (sem comentários) cópia × fábrica:

   | rota | Girassol (cópia × fábrica) | AMB (cópia × fábrica) |
   |---|---|---|
   | `raio-x-venda` | 70 × 110 (78 dif.) | 109 × 110 (27 dif.) |
   | `status-mkt` | 116 × 122 (62 dif.) | 116 × 122 (62 dif.) |
   | `plano-compra` | 119 × 129 (52 dif.) | 119 × 129 (52 dif.) |
   | `sku-repara` | 68 × 75 (51 dif.) | 68 × 75 (51 dif.) |
   | `ml-flex-debug` | — | 118 × 120 (42 dif.) |
   | `ml-vendas-do-dia` | 77 × 87 (36 dif.) | 77 × 87 (36 dif.) |
   | `sku-orfaos` | — | 65 × 70 (31 dif.) |
   | `despachados-por-engano` | — | 116 × 126 (28 dif.) |
   | `magalu-caca` | — | 22 × 27 (27 dif.) |
   | `ml-devolucoes` | 43 × 46 (25 dif.) | 43 × 46 (25 dif.) |
   | `ml-faltantes-classificar` | 73 × 77 (24 dif.) | 73 × 77 (24 dif.) |
   | `magalu-debug` | — | 46 × 49 (21 dif.) |
   | `completar-detalhes` | 54 × 56 (20 dif.) | 54 × 56 (20 dif.) |
   | `backfill` | 25 × 27 (18 dif.) | 24 × 27 (17 dif.) |
   | `reaplicar-custo` | 19 × 22 (17 dif.) | 19 × 22 (17 dif.) |
   | `backfill-conferir` | 26 × 28 (16 dif.) | — |
   | `custos-manuais` | 52 × 52 (16 dif.) | — |
   | `setup-ml` | — | 23 × 25 (16 dif.) |
   | `backfill-teste` | 20 × 23 (15 dif.) | 20 × 23 (15 dif.) |
   | `ml-vendas-faltando` | 51 × 54 (13 dif.) | 51 × 54 (13 dif.) |
   | `ml-creditos-flex` | — | 12 × 15 (11 dif.) |
   | `reaplicar-imposto` | 14 × 16 (10 dif.) | 14 × 16 (10 dif.) |
   | `varrer-fornecedores` | 12 × 15 (7 dif.) | 11 × 15 (10 dif.) |
   | `bling-cru` | 21 × 23 (10 dif.) | 21 × 23 (10 dif.) |
   | `ml-billing` | 13 × 16 (9 dif.) | 13 × 16 (9 dif.) |
   | `config-frete-magalu` | 14 × 15 (9 dif.) | 14 × 15 (9 dif.) |
   | `backfill-limpar` | 9 × 12 (7 dif.) | 9 × 12 (7 dif.) |
   | `custo-diario` | 23 × 26 (7 dif.) | — |
   | `vendas-sync` | 16 × 17 (7 dif.) | 16 × 17 (7 dif.) |
   | `varrer-cancelados` | 9 × 11 (6 dif.) | — |
   | `tiktok-completar-tarifa` | 8 × 10 (4 dif.) | 8 × 10 (4 dif.) |
   | `ml-billing-status` | 10 × 11 (3 dif.) | 10 × 11 (3 dif.) |
   | `varrer-cancelados-status` | 3 × 4 (3 dif.) | — |

   Grupos sugeridos (do menor risco pro maior): **backfill** (`backfill`, `-limpar`, `-teste`, `-conferir`) ·
   **custos** (`reaplicar-custo`, `custo-diario`, `custos-manuais`, `varrer-fornecedores`, `reaplicar-imposto`) ·
   **ML** (`ml-billing`, `-status`, `ml-devolucoes`, `ml-vendas-*`, `ml-faltantes-classificar`, `raio-x-venda`, `ml-flex-debug`,
   `ml-creditos-flex`, `setup-ml`) · **cancelados/sync** (`varrer-cancelados*`, `vendas-sync`, `completar-detalhes`,
   `tiktok-completar-tarifa`) · **diagnóstico** (`status-mkt`, `bling-cru`, `sku-repara`, `sku-orfaos`, `magalu-*`,
   `despachados-por-engano`) · **plano de compra**.
4d. **PRÓXIMO (medido em 09/11) — o que ainda mora no arquivo de cada empresa:**
   - Girassol (8): `backfill-ano`, `backfill-plano`, `backfill-status`, `ml-billing-outros`, `ml-fatura-auditoria`, `produto-cru`, `icone.png`, `manifest.webmanifest`;
   - AMB (10): `backfill-ano`, `backfill-status`, `buscar-pedido`, `ml-billing-outros`, `ml-fatura-auditoria`, `produto-cru`, `shopee-devolucao`, `shopee-semear`, `icone.png`, `manifest.webmanifest`;
   - GOOD (8): `backfill-ano`, `backfill-plano`, `backfill-status`, `backfill-vendas`, `buscar-pedido`, `custos-manuais`, `etiqueta-diag`, `sku-depara-manual`.
   Leitura: o **backfill** (`-ano`, `-plano`, `-status`, `-vendas`) espera o motor ser um só; `ml-billing-outros`, `ml-fatura-auditoria` e `produto-cru` existem na Girassol e na AMB e **faltam na GOOD** (união: peça comum e a GOOD ganha); `buscar-pedido` existe na AMB e na GOOD (a Girassol ganha); `shopee-devolucao`/`shopee-semear` só na AMB; `custos-manuais` da GOOD é cópia de uma rota que a fábrica tem; ícone e manifesto são da marca de cada uma (ficam).
4e. **EM CURSO (11/11) — o backfill do histórico, o que falta juntar.** O 4d fechou (#833→#838: outros/auditoria do ML,
   produto-cru, buscar-pedido, custos manuais e de-para da GOOD, etiqueta-diag — 75 rotas travadas em
   `scripts/teste-fabrica-copias-fora.js`). Medido em 11/11:
   - o **motor** (`backfillVendas(de, ate, empresa, ctx)`) já é UM — mora em `girassol-backup-offline/gbo-app.js` e a AMB e a
     GOOD o chamam com o contexto delas. Falta só tirá-lo de dentro do arquivo da Girassol (peça em `lib/checkout`);
   - o **backfill do ano**: a GOOD usa o plano fatiado em disco (`lib/backfill-fatiado` + `criarMotor`: espera o galpão
     fechar, refaz a fatia que falha, retoma depois de queda); a Girassol tem plano (`/backfill-plano`, `tocarPlano`) e
     também o ano mês a mês (`backfillAnoTodo`); a AMB só tem o mês a mês. **Feito em 11/11:** a regra do período (ano e
     mês padrão, validações) virou `lib/checkout/backfill-ano-periodo.js` e as três a usam — a Girassol e a AMB tinham o
     ano 2026 e o mês "07" FIXOS (em 2027 continuariam refazendo 2026). **Feito em 11/11 (2):** o plano em fatias virou peça por empresa
     (`lib/checkout/backfill-plano-empresa.js`: motor + rota `/backfill-plano`, união do motor da GOOD com o `acao=criar`
     da Girassol e a proteção contra clique duplo) e a **AMB ganhou** (rota + plano no `/backfill-status`).
     **Feito em 11/11 (3):** a Girassol trocou o `tocarPlano` pela peça (ganhou esperar o
     galpão, a trava completa e refazer sozinha) e a GOOD monta o motor dela pela peça (ganhou o `acao=criar`) — as
     três com o MESMO plano em fatias;
   - o **/backfill-status**: Girassol/AMB respondem `{ ok, status, ano }`; a GOOD responde o progresso do plano e da rotina
     diária. Juntar = união dos campos, depois que as três tiverem o plano.

5. deixar os entrypoints apenas compondo contexto e capacidades
   **EM CURSO (11/11).** Medido em 11/11, por bloco (função/declaração) do arquivo de entrada de cada empresa:
   Girassol 2.422 linhas, AMB 1.845, GOOD 1.729. Iguais nas três: ~150 linhas; o resto é "só dela" — mas quase tudo com
   o MESMO NOME e corpo parecido: `routes` (o tratador: 697/935/684 — trava de sessão + a ligação das peças),
   `custoSync` (236/236/185), `mlSyncFees` (151/152/98), `vendasSync`, `custoSyncTravado`, e o motor do backfill
   (790 linhas, só no arquivo da Girassol — a AMB e a GOOD o chamam com o contexto delas).
   - **Feito em 11/11:** `custoSync` da Girassol e da AMB virou peça (`lib/checkout/custo-sync.js`) — era igual linha a
     linha (só o nome da empresa mudava); o corpo é o de antes, byte a byte (`scripts/teste-custo-sync-peca.js`).
   - **Falta:** a GOOD entrar na peça do custo (a versão dela difere em ~96 linhas — nivelar por cima); `mlSyncFees`;
     `vendasSync`/`custoSyncTravado`; o motor do backfill sair do arquivo da Girassol (23 testes olham o texto dele lá);
     e, por fim, o `routes` virar montagem (a trava de sessão e a ligação das peças por configuração) — é o que falta pra
     uma empresa nova não precisar de pasta própria.

## Fase 4 — painel único orientado a capacidades  🔄 COMEÇOU

**Medido em 15/09 e o quadro é melhor do que parecia:** os três `painel.html` têm ~2.000
linhas cada e diferem em **73 a 109 linhas** com os nomes normalizados — quase tudo MARCA
(logo em base64, `<title>`, `<h1>`, versão da UI). São o mesmo painel copiado três vezes por
causa de um logo.

- [x] **`/api/contexto`** (PR #442): cada empresa responde com id, nome, slug e **capacidades
      vindas do contrato**. É o que permite o HTML perguntar quem ele é em vez de saber.
      Nada de credencial, caminho ou env na resposta — isto chega no navegador do galpão.
- [ ] shell comum consumindo `/api/contexto` (marca e recursos por capacidade)
- [ ] esconder recurso por **capacidade**, nunca por nome de empresa

## Fase 5 — onboarding declarativo  ✅ FEITA (14/09, PR #439)

`node scripts/empresa.js validar <empresa>` — **portão**: sai com código 1 se faltar registro,
capacidade ou env obrigatória, com o nome EXATO da env que falta no Render. Avisa também
quando a conta é renovada por outro serviço (o risco do refresh de uso único).

`node scripts/empresa.js plano <empresa>` — os passos de embarque: envs por nome, callbacks
com **URL completa**, autorização inicial, fatia do Supabase, diretório persistente, crons que
vão nascer (com o aviso do minuto escalonado do F3) e como ativar.

**Nenhum valor de segredo é impresso** — só o nome da env e se está presente. É regra, não
gosto: uma ferramenta de diagnóstico que vaza chave é pior que não ter ferramenta, e o teste
falha se algum valor aparecer na saída.

---

## Antes de ligar uma empresa nova — os dois comandos

```
node scripts/empresa.js validar <empresa>      # a env EXISTE?     (roda em qualquer lugar)
node scripts/empresa.js plano <empresa>        # os passos de embarque
node scripts/preflight-empresa.js <empresa>    # a env FUNCIONA?   (rodar NO RENDER)
node scripts/preflight-empresa.js <empresa> --escrever   # prova o isolamento do Supabase
```

A diferença entre `validar` e `preflight` é a que importa: env preenchida com valor errado
passa no primeiro e quebra no primeiro cron, de madrugada. Nenhum dos dois imprime valor de
credencial.

## Itens soltos da auditoria (não bloqueiam as fases)

- [ ] `npm test` apontando para `scripts/verifica.js` (hoje só existe o CI)
- [x] autenticação administrativa aceita **header** (`x-admin-key` ou `Bearer`), com a query
      mantida como compatibilidade — leituras migradas para `lib/http/chave-admin.js` (PR #426),
      incluindo a TRAVA CENTRAL e os endpoints globais do `index.js` raiz (diagnóstico,
      magalu, tiktok, embarcar, ml-full) e o gate de sessão do GOOD, que r2 do Codex pegou
      ainda lendo só `?k=` ou derrubando a chamada antes de a rota migrada avaliar a chave.
      A chave já tinha deixado de ser ecoada nas respostas (PR #399).
- [x] **canal do ML herdado REMOVIDO** (16/09, P1 da revisão): o padrão `206017293` era o
      canal da AMB, e empresa sem env própria julgava os pedidos dela pelo canal de outra, em
      silêncio. Saiu com evidência de produção — `/descobrir-ids` provou o canal de cada uma
      contra a conta do ML e conferiu contra o Render. A ausência da env **não derruba o boot**
      (mudou na 2ª rodada do mesmo dia, pra não levar as outras duas junto, e porque o CI não
      passa essas envs): o servidor sobe e só a empresa sem canal fica parada, com a mensagem
      — dizendo como obter o valor — no log a cada ciclo do F1/F2/F3. O `empresa.js validar`
      cobra a env ANTES do deploy, e é ele que substitui o boot como sinal de "pronta"
- [x] **`empresa.js validar` confere o FORMATO, não só a presença** (16/09): `ME_LOJA_IDS=abc`
      passava como "presente" e o validar dizia "pronta", enquanto em produção o F1 e o F3 se
      recusariam a rodar. Portão que aprova configuração quebrada é pior que não ter portão —
      é ele que dá a confirmação pra seguir pro deploy
- [ ] fechar a janela: medir o uso legado (`veioPorHeader`) e só então recusar `?k=`
- [x] README reescrito (15/09): descreve o serviço multiempresa, aponta para os documentos de
      embarque e de diferenças, e registra as regras da casa (PR #478)
- [ ] observabilidade por empresa/capacidade em disco (hoje o diagnóstico morre no restart)

## Pra verificar depois (registrado a pedido do dono em 30/10: "pra gente não esquecer")

**Pausado até fechar a consolidação (decisão do dono):**
- [ ] **pedido cancelado no marketplace ANTES da postagem.** A sonda só-leitura do TikTok está no ar
      (`/<empresa>/cancelados-antes-postagem`, #763). Falta: a sonda pegar ML, Shopee e Magalu; o card
      vermelho "NÃO EMBALAR" na fila do galpão; e depois a NF (cancelar dentro de 24h, senão NF de devolução)
      + o status Cancelado no Bling. **Regra do dono: só pedido NÃO postado** — o postado é do Devoluções.

**Conferir depois das rodadas:**
- [ ] a faixa do canário da AMB some na rodada da madrugada (as "faltando" eram Full: no Full entra a NF,
      não o pedido — #768);
- [ ] o faturamento da Girassol e da GOOD pode **subir** com a caça da Magalu e as vendas direto do ML no
      backfill (#766, #769) — é o número certo aparecendo; conferir os números. Pra trazer os meses
      passados da Magalu de uma vez: `/<empresa>/magalu-caca?de=AAAA-MM-DD&ate=AAAA-MM-DD&k=ADMIN_KEY`.

**Ações do dono (no Render/GitHub):**
- [ ] variáveis do depósito pra contagem lançar no Bling, no serviço `mover-pedidos`:
      `GIRABKP_DEPOSITO_GERAL=933846907`, `AMBBKP_DEPOSITO_GERAL=14888917703`, `GOODBKP_DEPOSITO_GERAL=4956031259`;
- [ ] apagar `SHOPEE_PARTNER_KEY` e `SHOPEE_PARTNER_ID` no `mover-pedidos` (sobra de agosto);
- [ ] renovar o token do GitHub (vence 31/10/2026).

**Portes futuros (nivelar por cima):**
- [ ] etiquetas em massa — só a GOOD tem o servidor → Girassol e AMB;
- [ ] `diagnostico.js` — só a Girassol tem → AMB e GOOD.

**Lição (29/10):** duas conversas fizeram o mesmo passo (#770) com o **mesmo nome de branch** e uma caiu por
cima da outra. Antes de subir: conferir os PRs abertos **e** se o nome da branch já existe; uma conversa por
frente.

## Regras que evitam a duplicação voltar

- Nome de empresa não entra em regra de negócio — entra no registro/contexto.
- Toda diferença é `config`, `capacidade` ou `strategy`, com teste.
- Idêntico em duas pastas → candidato a `lib/`; em três → **bloqueador para a quarta**.
- Lib não lê env global escondida quando o chamador pode injetar.
- Fábrica valida dependências no boot e falha alto; nada de recurso meio ligado.
- Cache/tabela/arquivo sempre com id canônico, e teste contra colisão.
- Alias só em HTTP e env legada; por dentro, id canônico.
- Token com dono único; consumidor lê, nunca compete pelo refresh.
