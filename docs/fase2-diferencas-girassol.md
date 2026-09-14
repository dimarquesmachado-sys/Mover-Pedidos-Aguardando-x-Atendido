# Fase 2 — o que a Girassol faz diferente no fiscal (medido em 13/09/2026)

## Por que este documento existe

O plano manda classificar cada diferença antes de unificar. Ao chegar nos passos 2.4 a 2.8,
a medição mudou o quadro e a unificação cega teria apagado comportamento:

| peça | AMB × GOOD | AMB × GIRASSOL |
|---|---:|---:|
| `nfeMlFluxo.js` | **0** | 84 |
| `mlApi.js` | 2 | 48 |
| `nfTokenManager.js` | 20 | 65 |
| `blingApi.js` | 16 | 94 |
| `tokenManager.js` | 11 | 87 |

*(linhas realmente diferentes, com os nomes de empresa normalizados — sem isso o diff
desalinha e infla a contagem)*

**AMB e GOOD são gêmeas.** A Girassol divergiu: ela é a empresa mais antiga do repositório e
o fiscal dela seguiu outro caminho. Isso não é "código velho" por definição — em pelo menos um
ponto, o caminho dela é o **mais correto**.

## Achado principal: o envio MANUAL da Girassol usa o caminho nativo do Bling

> **Correção (Codex, revisão do PR #409).** A primeira versão deste documento dizia que "o
> F3 da Girassol" usava o caminho nativo. Está errado e a diferença importa para a decisão:
> o caminho nativo vive em `enviarNFeUnica` (linha 219 — o envio **manual**, disparado por
> rota). A rotina agendada é `rotinaNFeML`, que o cron chama a cada 10 min, e ela manda com
> `enviarNFeParaML` — o push direto, igual às outras duas empresas. Conferido no código antes
> de aceitar o apontamento.

No envio manual da Girassol, a primeira tentativa é `enviarNFeParaLojaVirtual` — o envio
nativo Bling → marketplace. O push de XML cru é só a reserva. O comentário no código explica:

> o Bling é integrador oficial do ML e faz o handshake fiscal que o push cru de XML não faz —
> é o caminho correto.

**AMB e GOOD não têm essa função** (`enviarNFeParaLojaVirtual` não existe no `blingApi.js`
delas), embora tenham o `enviarNFeUnica`. Ou seja: no envio manual, a Girassol tenta o caminho
oficial antes; as outras duas só têm o push direto. **Na rotina automática, as três se
comportam igual.**

### O que isso significa na prática

Não é um bug silencioso — as NFs chegam ao ML nas três empresas, e a rotina automática é
idêntica nas três. A assimetria aparece **quando alguém reenvia uma NF à mão**, que costuma
ser justamente o caso em que o envio automático já falhou: aí a Girassol ainda tem uma
segunda via (o handshake oficial do Bling) e a AMB/GOOD não têm — repetem o mesmo push que
já não funcionou.

### Decisão que cabe ao dono

1. **Portar o caminho nativo para AMB e GOOD** (recomendado se ele funciona bem na Girassol —
   é o mesmo princípio do "API do marketplace primeiro"), ou
2. **Manter como está** se houver razão fiscal para a AMB/GOOD não usarem o envio nativo
   (contrato com o marketplace, regime, natureza da operação).

Enquanto essa decisão não existe, **`nfeMlFluxo.js` (2.4) e `blingApi.js` (2.7) não devem ser
unificados com a Girassol** — só esses dois têm código ligado ao caminho nativo; unificar
apagaria o caminho nativo ou o imporia às outras sem decisão. `mlApi.js` (2.5) e
`nfTokenManager.js` (2.6) já foram liberados no plano — nenhum dos dois tem código ligado a
essa escolha (ver "Demais diferenças" abaixo). `tokenManager.js` (2.8) segue à parte, por
conta do vencimento do token (ver abaixo).

## Caminho seguro enquanto isso

`mlApi.js` (2.5) e `nfTokenManager.js` (2.6) já podem ser unificados **nas três empresas** —
liberados no plano, sem código ligado à decisão pendente. Para `nfeMlFluxo.js` (2.4) e
`blingApi.js` (2.7), AMB e GOOD podem ser unificadas **entre si** (0 a 20 linhas de
diferença), com a Girassol permanecendo na própria implementação e entrando na lib quando a
decisão acima for tomada. É menos bonito que "uma lib para as três de uma vez", mas é
honesto: a duplicação some onde não há comportamento em disputa, sem arriscar o que ninguém
decidiu mudar.

## ✅ DECISÃO DO DONO (13/09): união, não interseção

> "uma tem outra não, agora ambas tem. e vai turbinando e melhorando."

O critério vale para todas as diferenças listadas neste documento: **capacidade que existe
numa empresa é portada para as outras**, em vez de apagada ou deixada de lado. O objetivo
declarado: empresa nova (ou o dashboard da GOOD) entrar sem redundância, sem quebrar e sem
faltar peça.

Aplicado até agora:

- **`mlApi.js` (passo 2.5)** — `getShipmentRaw`, que era só da Girassol, passou às três; o
  `baixarXmlNFe`, que existia nas três mas a Girassol não exportava, passou a ser exportado
  por todas. ✅ feito.
- **envio nativo do Bling no reenvio manual** — ✅ portado para AMB e GOOD (PR #414): elas
  repetiam no reenvio o mesmo push que já havia falhado; agora tentam o caminho oficial antes.
- **`expira_em` (renovação proativa do token)** — ✅ portado para AMB e GOOD (PR #413): elas
  gastavam uma chamada de sonda no Bling a cada operação para descobrir o que o campo já diz.
- **caminho do arquivo de token da Girassol** — não é capacidade, é estado: preservar, não unificar.

## Achado do passo 2.5: cada lado tem uma função que falta no outro

No `mlApi.js`, medido em 13/09:

- a **Girassol** tem `getShipmentRaw` (devolve o shipment cru) e retorna o `status` do envio
  além do substatus — a AMB e a GOOD não têm nem uma coisa nem outra;
- a **AMB e a GOOD** exportam `baixarXmlNFe`; a Girassol **tem a função, mas não exportava**
  (correção: a primeira versão deste parágrafo dizia que ela não tinha — conferido depois no
  código, e a diferença era só o export).

Não é hierarquia de "mais moderna": as três seguiram caminhos diferentes e cada uma ganhou
uma peça que as outras não ganharam. Unificar sem decidir apagaria uma das duas pontas.

## Achado do passo 2.9: a Girassol não tinha o callback do Bling

Medido em 13/09, comparando as rotas dos três `index.js`:

| rota | AMB | GOOD | Girassol |
|---|:-:|:-:|:-:|
| callback do Bling | ✅ | ✅ | ❌ → ✅ portado (PR #417) |
| callback do Bling NF | ✅ | ✅ | ✅ |
| callback do ML | ✅ | ✅ | ✅ |

Sem essa rota, reautorizar o Bling na Girassol exigia **copiar o `code` da barra de endereços
e postar à mão** em `/setup` — no meio de uma situação que já é urgente (token caiu, nota
parada). Portado.

Os **crons** são a exceção que continua diferente de propósito: o F3 roda nos minutos 0, 2 e
4 de cada dezena (Girassol, AMB, GOOD). É escalonamento para as três não competirem pela
cota do Bling ao mesmo tempo — igualar seria criar o problema que o escalonamento evita.

## Achado do passo 2.9 (2º): a prova do "desfeito pelo Bling"

A Girassol guardava **a que horas nós movemos** cada pedido e, quando ele reaparecia em
ATENDIDO, registrava os dois horários no log — é o que permite abrir ticket no Bling dizendo
"movemos às X e vocês desfizeram Y minutos depois". AMB e GOOD percebiam o retorno (o
contador de re-move), mas sem a prova; o ticket viraria discussão de opinião.

Portado para as três (PR #418), com o contador aparecendo no resumo do F1 só quando acontece.

## Achado do passo 2.9 (3º): "o Bling aceitou mas não aplicou"

A Girassol **relê o pedido depois de mover** e só considera feito se a situação mudou de
verdade. AMB e GOOD confiavam no `200 OK` — e o Bling responde 200 sem aplicar de vez em
quando. Resultado nas duas: pedido dormindo em ATENDIDO, invisível.

Portado (PR #419), com os três desfechos tratados — aplicou, não deu pra conferir (não vira
sucesso nem falha) e aceitou-e-não-aplicou — e o contador no resumo do F1.

**Custo consciente:** uma leitura a mais por pedido movido. É cota do Bling gasta de
propósito, bem mais barata que um pedido parado que ninguém vê.

## Achado do F1/F2 (14/09): estratégia de retentativa diferente, não dívida

Medido por **conjunto de linhas** (o diff posicional mentia por causa de ordem): AMB e GOOD
são **idênticas** no `fluxos.js`. A Girassol difere porque usa outra estratégia:

- ela **marca o pedido como feito** assim que o move é confirmado, e por isso precisa de
  `destravado` para reabri-lo quando o Bling desfaz — sem isso o pedido ficaria preso;
- AMB e GOOD **não marcam no sucesso** (dependem de o pedido sair da lista de ATENDIDO),
  então não têm o que destravar.

As duas funcionam, e nenhuma tem capacidade que a outra não tenha. Unificar aqui seria
**escolher uma estratégia para todas** — decisão de operação, não de refatoração, e sem
sintoma que a justifique hoje. Por isso as gêmeas foram para `lib/fiscal/fluxos-pedidos.js`
e a Girassol ficou com a implementação dela, registrada aqui para ninguém "consertar" depois.

## Demais diferenças (classificação rápida)

- `mlApi.js`: diff é só **rótulo de log** (`[mlApi]` vs `[AMB mlApi]`) e a lista de exports (a
  Girassol expõe `getShipmentRaw`, de rota de debug). Não toca `enviarNFeParaLojaVirtual` nem
  nada ligado ao achado principal — por isso já liberado (2.5).
- `nfTokenManager.js`: não tem relação com `nfeMlFluxo.js` — nenhuma das três o importa; ele
  serve o fluxo separado de Corrigir-NFs (`nfFluxos.js` → `nfBlingApi.js`) e rotas de setup.
  Por isso já liberado (2.6).
- `blingApi.js`, `tokenManager.js`: o grosso é **nome de env sem prefixo** (a Girassol nasceu
  antes do padrão) e **rótulo de log**. O registro canônico já resolve os nomes; o rótulo já é
  parâmetro nas peças unificadas.
- `tokenManager.js` da Girassol guarda tokens em `data/tokens.json` **relativo ao módulo**,
  enquanto AMB/GOOD usam `/data/<empresa>/`. Isso é caminho de disco, não regra — mas mexer
  nele sem migrar o arquivo existente derrubaria a autenticação da empresa mais antiga.
- **(Codex #409, 2ª rodada)** o `nfTokenManager.js` da Girassol grava o token fiscal em
  `<módulo>/data/nf_tokens.json` — caminho **relativo ao código** —, enquanto AMB e GOOD usam
  `/data/<empresa>/nf-tokens.json`. Isso é estado vivo, não organização: trocar o caminho na
  extração faria a empresa "perder" o token e exigir nova autorização no Bling no meio do
  expediente. Ou o caminho vira parâmetro e permanece, ou há migração explícita do arquivo —
  nunca troca silenciosa.
- **(Codex #409)** o `tokenManager.js` da Girassol também **persiste o vencimento do token**
  (`expira_em`, gravado a partir de `expires_in`) para renovar de forma proativa sem gastar
  uma chamada-teste a cada uso. AMB e GOOD não guardam isso. É comportamento real, não
  rótulo: ao extrair o passo 2.8, ou o campo vira parte da lib (e as outras passam a
  aproveitá-lo) ou ele se perde em silêncio.
