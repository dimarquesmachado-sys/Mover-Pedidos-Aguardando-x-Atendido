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
2. extrair repositório de manifesto/cache e o ciclo base
3. extrair histórico/backfill/vendas-sync sobre um contexto de checkout explícito
4. consolidar rotas em registradores por capacidade
5. deixar os entrypoints apenas compondo contexto e capacidades

## Fase 4 — painel único orientado a capacidades  ⬜

Os HTMLs ainda são aplicações inteiras por empresa. Shell comum, marca vinda de
`/api/contexto`, recurso escondido por **capacidade** e não por nome de empresa.

## Fase 5 — onboarding declarativo  ⬜

`node scripts/empresa.js validar <nova>` e `plano <nova>`: lista envs faltando, capacidades,
slugs, tabelas, donos de token, callbacks OAuth, crons e passos de embarque — sem mostrar
segredo.

---

## Itens soltos da auditoria (não bloqueiam as fases)

- [ ] `npm test` apontando para `scripts/verifica.js` (hoje só existe o CI)
- [x] autenticação administrativa aceita **header** (`x-admin-key` ou `Bearer`), com a query
      mantida como compatibilidade — leituras migradas para `lib/http/chave-admin.js` (PR #426),
      incluindo a TRAVA CENTRAL e os endpoints globais do `index.js` raiz (diagnóstico,
      magalu, tiktok, embarcar, ml-full) e o gate de sessão do GOOD, que r2 do Codex pegou
      ainda lendo só `?k=` ou derrubando a chamada antes de a rota migrada avaliar a chave.
      A chave já tinha deixado de ser ecoada nas respostas (PR #399).
- [ ] fechar a janela: medir o uso legado (`veioPorHeader`) e só então recusar `?k=`
- [ ] README ainda se apresenta como "Girassol v2.0", monoempresa
- [ ] observabilidade por empresa/capacidade em disco (hoje o diagnóstico morre no restart)

## Regras que evitam a duplicação voltar

- Nome de empresa não entra em regra de negócio — entra no registro/contexto.
- Toda diferença é `config`, `capacidade` ou `strategy`, com teste.
- Idêntico em duas pastas → candidato a `lib/`; em três → **bloqueador para a quarta**.
- Lib não lê env global escondida quando o chamador pode injetar.
- Fábrica valida dependências no boot e falha alto; nada de recurso meio ligado.
- Cache/tabela/arquivo sempre com id canônico, e teste contra colisão.
- Alias só em HTTP e env legada; por dentro, id canônico.
- Token com dono único; consumidor lê, nunca compete pelo refresh.
