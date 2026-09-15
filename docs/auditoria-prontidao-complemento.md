# Complemento à auditoria de prontidão (15/09/2026)

Este documento não contesta o veredito da auditoria — **concordo que não é hora de ligar a
quarta empresa completa**. Ele refina uma das evidências e corrige uma afirmação minha.

## Correção do que EU disse antes

Ao entregar `lib/fiscal/montar-empresa.js` eu escrevi que "o critério de aceitação da
auditoria passa: empresa nova nasce só do contrato". Isso está **incompleto e induz ao erro**:
o que o teste prova é que o **módulo fiscal** nasce sem pasta — rotas, cinco rotinas e crons.
Checkout, painel, histórico completo e coletores **não** nascem. A auditoria está certa em
separar as duas coisas, e a frase certa é "o fiscal é declarativo; o resto ainda não".

## Refinamento: as rotas exclusivas não pesam igual

A auditoria aponta ~10 rotas exclusivas de cada lado como prova de que Girassol e AMB não são
100% iguais. A contagem confere (medido em 15/09: 12 só na AMB, 13 só na Girassol). Mas elas
se dividem em duas naturezas muito diferentes, e só uma delas bloqueia:

| natureza | quantas | exemplo | bloqueia uma empresa nova? |
|---|---:|---|---|
| diagnóstico / manual (aberta por URL quando algo dá errado) | **23** | `/debug-custo`, `/sonda-ml-claims`, `/magalu-debug`, `/sku-orfaos`, `/shopee-semear` | **não** — são ferramentas de investigação, criadas conforme cada empresa teve cada problema |
| usada pelo dashboard (operação depende) | **2** | `/canario-estado` (Girassol), `/produto-fotos` (AMB) | sim, se a empresa nova precisar dela |

Conferido lendo o `painel.html`/`dashboard.html` de cada empresa: das 25 rotas exclusivas,
**duas** aparecem em chamadas automáticas do front — `/canario-estado`, que o painel da
Girassol consulta, e `/produto-fotos`, que o dashboard da AMB busca sozinho sempre que um SKU
visível na tela ainda não tem foto em cache (`amb-dashboard.html:2569`). As outras 23 ninguém
chama no dia a dia — existem porque alguém investigou um problema naquela empresa e deixou a
ferramenta pronta.

**O que isso muda:** a maior parte da assimetria de rotas (23 das 25) é sintoma de história,
não de funcionalidade faltando, e não deve entrar na conta de "o que falta pra ligar a quarta
empresa". As duas exceções — `/canario-estado` e `/produto-fotos` — são dependência real do
dashboard de quem já as tem; se a peça de dashboard for reaproveitada tal como está para uma
empresa nova, ela herda a chamada e precisa da rota correspondente (ou de uma tela sem essa
chamada). Pela regra do dono ("uma tem, agora ambas têm"), o caminho natural pras 23
ferramentas de diagnóstico é portar quando alguém precisar delas, não antes; as duas rotas
operacionais não podem esperar por essa regra porque já são chamadas a cada carregamento da
tela, não sob demanda.

**O que NÃO muda:** os bloqueadores reais da auditoria seguem de pé, e são outros — checkout
declarativo, painel por capacidades, dono único do token, paridade de números e preflight
remoto do Supabase. Nenhum deles é resolvido por rota de debug.

## Concordância com as correções preventivas

As três mudanças da auditoria são boas e valem por si:

- **colisão de prefixo efetivo de env** — duas empresas lendo a mesma credencial é o pior tipo
  de bug: funciona, e funciona com a conta errada;
- **sufixo de tabela vazio reservado** — a tabela sem sufixo é um destino real;
- **boot aborta quando a montagem falha** — é a correção mais importante das três. Antes, o
  erro era registrado e o servidor subia saudável com uma loja inteira sem rotas nem crons.
  Ninguém descobriria até faltar nota fiscal.

Esta última corrige código que eu escrevi ontem, e o diagnóstico está certo: eu tratei falha
de montagem como aviso quando ela é falha de boot.
