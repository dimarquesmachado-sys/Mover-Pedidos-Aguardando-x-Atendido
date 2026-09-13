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

## Achado principal: o F3 da Girassol usa o envio NATIVO do Bling

No `nfeMlFluxo.js` da Girassol, a primeira tentativa de mandar a NF-e ao Mercado Livre é
`enviarNFeParaLojaVirtual` — o envio nativo Bling → marketplace. O push de XML cru é só a
reserva. O comentário no código explica a razão:

> o Bling é integrador oficial do ML e faz o handshake fiscal que o push cru de XML não faz —
> é o caminho correto.

**AMB e GOOD não têm essa função** (`enviarNFeParaLojaVirtual` não existe no `blingApi.js`
delas). Ou seja: nas duas, o F3 vai direto pelo caminho reserva.

### O que isso significa na prática

Não é um bug silencioso — as NFs chegam ao ML nas três empresas. Mas é assimetria fiscal:
a Girassol tenta primeiro o caminho oficial e cai no alternativo; as outras duas só têm o
alternativo. Se o push de XML falhar por algo que o handshake nativo resolveria, na Girassol
a NF passa e nas outras não.

### Decisão que cabe ao dono

1. **Portar o caminho nativo para AMB e GOOD** (recomendado se ele funciona bem na Girassol —
   é o mesmo princípio do "API do marketplace primeiro"), ou
2. **Manter como está** se houver razão fiscal para a AMB/GOOD não usarem o envio nativo
   (contrato com o marketplace, regime, natureza da operação).

Enquanto essa decisão não existe, **as peças 2.4 a 2.8 não devem ser unificadas com a
Girassol** — unificar apagaria o caminho nativo ou o imporia às outras sem decisão.

## Caminho seguro enquanto isso

AMB e GOOD podem ser unificadas **entre si** agora (0 a 20 linhas de diferença), com a
Girassol permanecendo na própria implementação e entrando na lib quando a decisão acima for
tomada. É menos bonito que "uma lib para as três", mas é honesto: metade da duplicação some
sem arriscar comportamento que ninguém decidiu mudar.

## Demais diferenças (classificação rápida)

- `mlApi.js`, `blingApi.js`, `tokenManager.js`, `nfTokenManager.js`: o grosso é **nome de env
  sem prefixo** (a Girassol nasceu antes do padrão) e **rótulo de log**. O registro canônico
  já resolve os nomes; o rótulo já é parâmetro nas peças unificadas.
- `tokenManager.js` da Girassol guarda tokens em `data/tokens.json` **relativo ao módulo**,
  enquanto AMB/GOOD usam `/data/<empresa>/`. Isso é caminho de disco, não regra — mas mexer
  nele sem migrar o arquivo existente derrubaria a autenticação da empresa mais antiga.
