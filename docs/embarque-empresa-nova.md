# Embarque de empresa nova — o que o sistema faz sozinho e o que sobra pra você

Consolida as **duas auditorias do Codex** (13 e 15/09) e a minha análise, com um objetivo
declarado pelo dono: *"clicar em menos coisas, integrar o máximo que der"*.

## O princípio

Toda informação que **já existe em algum lugar que o sistema alcança** deve ser buscada, não
digitada. Só sobra manual o que é: **segredo** (credencial), **decisão** (alíquota, política)
ou **externo** (criar app no Bling, autorizar no navegador).

A régua pra decidir: *se eu precisei perguntar um dado ao dono, e o sistema poderia tê-lo
buscado, isso é um bug de embarque.* Aconteceu em 14/09 — pedi razão, CNPJ, IE e endereço da
GOOD, e o dado estava no XML de toda NF-e autorizada.

## Estado por etapa

| etapa | quem faz hoje | o que já é automático |
|---|---|---|
| registrar a empresa | **você** (1 linha no contrato) | validação de colisões no boot |
| envs no Render | **você** (segredo, não tem como) | `empresa.js plano` lista pelo nome exato |
| criar app no Bling / ML | **você** (externo) | `plano` dá as URLs de callback prontas |
| autorizar (OAuth) | **você** (1 clique por conta) | callback grava o token sozinho |
| dados do emitente | ~~você~~ | ✅ **aprendido do XML da 1ª NF** (15/09) |
| rotas, crons, fiscal | — | ✅ montados do contrato (`montarEmpresa`) |
| capacidades | — | ✅ declaradas no contrato, validadas no boot |
| histórico / dashboard | — | ✅ lib única; a GOOD ganhou ligando 25 linhas |
| conferir se está pronto | — | ✅ `empresa.js validar` + `preflight-empresa` |

## O que ainda exige você — e por quê

1. **Credenciais.** Segredo não se descobre. O `plano` reduz ao mínimo: diz o nome exato de
   cada env, e o `validar`/`preflight` provam que funcionam antes do primeiro cron.
2. **Alíquota mensal do Simples.** É decisão fiscal e muda por faturamento; chutar seria
   inventar imposto. Fica no painel, e o padrão é 15% até você informar.
3. **Criar o aplicativo no Bling e no ML.** É fora do nosso alcance — mas o callback já volta
   pronto e grava o token sem ninguém copiar código.
4. **O primeiro OAuth de cada conta.** Um clique por conta, e só.

## Um risco achado no caminho (15/09)

O `ME_LOJA_IDS` — que diz ao F1 **quais canais de venda do Bling são do Mercado Livre** —
tinha um id **cravado como padrão** (`206017293`, da primeira empresa que existiu no serviço).
Qualquer empresa sem essa env usava o canal de OUTRA pra decidir o que era venda dela. Mesma
classe do CNPJ trocado na DANFE: funciona, e funciona errado.

- **empresa nova:** agora é **obrigatório** declarar o canal — sem ele, a montagem falha no
  boot em vez de a empresa ignorar todos os pedidos em silêncio;
- **empresas atuais:** o padrão continua, porque não dá para ver o Render daqui e removê-lo
  quebraria quem depende dele. Mas o boot agora **diz a verdade**: registra se a empresa está
  usando env própria ou o id herdado.

⚠️ **Vale conferir no log do Render** se alguma das três aparece com o aviso "usando o id
herdado". Se aparecer, o F1 dela está julgando os pedidos pelo canal de outra empresa.

## O que ainda falta automatizar (fila, por retorno)

1. **Descobrir o seller id de cada marketplace** depois do OAuth (ML, Shopee, Magalu). Hoje
   alguns são configurados à mão; os tokens já permitem perguntar "quem sou eu".
2. **Uma página de embarque** que mostre, numa tela: o que já autorizou (✓), o que falta, e o
   botão de cada autorização pendente — hoje é preciso abrir três URLs separadas.
3. **Gerar a entrada do contrato** por comando, escrevendo **nos dois repositórios**
   (o arquivo é espelhado byte a byte, e errar isso deixa a bateria vermelha dos dois lados).
4. **Checkout declarativo** — bloqueador nº 2 da auditoria. Enquanto não existir, a empresa
   nova ganha fiscal e histórico sem pasta, mas o checkout ainda precisa de uma.
5. **Painel por capacidades** — base pronta (`/api/contexto`); falta o shell comum.

## Sequência segura, quando for ligar de verdade

Da auditoria de prontidão, mantida na íntegra porque está certa:

1. contrato (registro) → `empresa.js validar` deve passar
2. envs no Render → `preflight-empresa <nova>` **no Render**, depois `--escrever` pra provar
   o isolamento do Supabase
3. autorizar Bling e ML → a primeira NF já ensina o emitente
4. **fiscal manual primeiro**, sem cron
5. leitura de histórico
6. um marketplace só
7. demais coletores
8. crons
9. painel

Cada etapa com rollback por `EMPRESAS` / `SKIP_EMPRESAS`, e observação por empresa.

> ⚠️ **Antes da quarta empresa:** a Fase 0 (dono único do refresh do ML) precisa estar
> fechada. Dois serviços renovando o mesmo token de uso único deixam um com token morto, e o
> sintoma aparece horas depois — é o único item da lista que não tem contorno.
