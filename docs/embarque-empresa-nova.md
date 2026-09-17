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

## Um risco achado no caminho (15/09, fechado em 16/09)

O `ME_LOJA_IDS` — que diz ao F1 **quais canais de venda do Bling são do Mercado Livre** —
tinha um id **cravado como padrão** (`206017293`, da primeira empresa que existiu no serviço).
Qualquer empresa sem essa env usava o canal de OUTRA pra decidir o que era venda dela. Mesma
classe do CNPJ trocado na DANFE: funciona, e funciona errado.

- **15/09:** o padrão saiu pra **empresa nova** (`lib/fiscal/montar-empresa.js` recusa montar
  sem o canal próprio), mas ficou pras três já no ar — não dava pra ver o Render daqui, e
  removê-lo sem prova quebraria quem dependesse dele. O boot só **dizia a verdade** no log.
- **16/09:** a prova veio de produção — `/descobrir-ids` conferiu o canal de cada empresa
  contra a própria conta do ML e bateu com o Render (AMB `206017293`, Girassol `203146903`,
  GOOD `203296034`). Ninguém dependia do herdado, então ele **saiu de vez**
  (`lib/fiscal/bling-api.js`): as três empresas com pasta perdem o padrão herdado, igual quem
  nasce sem pasta. A recusa fica no **uso** (F1/F2/F3), não no boot — ver o aviso abaixo.
  `empresa.js validar` cobra `ME_LOJA_IDS` como **obrigatória** pra qualquer empresa com a
  capacidade fiscal — não existe mais o caso "sobe com o padrão herdado" passando no portão.

⚠️ **Se uma empresa subir sem a env do canal do ML, o servidor SOBE — e só ela fica parada.**
O comportamento mudou em 16/09: antes a ausência derrubava o boot inteiro, o que fazia uma
empresa mal configurada levar as outras duas junto. Agora a recusa está no ponto em que o
estrago aconteceria:

- a decisão "este pedido é do Mercado Livre?" **recusa** em vez de responder "não é" pra tudo
  (responder "não é" era o silêncio que o id herdado causava: o F1 ignorava tudo sem erro);
- o **F3** se recusa a rodar com a lista de canais vazia — senão o relatório diria "0 NFs
  enviadas", que parece dia fraco e não configuração faltando;
- a importação de pedido da Girassol confere **antes** de criar contato no Bling, pra não
  deixar lixo na conta do dono e falhar depois.

Em todos os casos o log traz a rota `/descobrir-ids` **daquela** empresa, que prova o canal
contra a conta do ML e devolve o valor pronto pra colar.

## O que ainda falta automatizar (fila, por retorno)

1. ✅ **Descobrir os ids do Bling** (15/09) — canais de venda, depósitos e situações:

   ```
   https://mover-pedidos-aguardando-x-atendido.onrender.com/amb-checkout-offline/descobrir-ids?k=SUA_ADMIN_KEY
   https://mover-pedidos-aguardando-x-atendido.onrender.com/girassol-backup-offline/descobrir-ids?k=SUA_ADMIN_KEY
   https://mover-pedidos-aguardando-x-atendido.onrender.com/good-checkout-offline/descobrir-ids?k=SUA_ADMIN_KEY
   ```

   Substitui o mapeamento no DevTools, tela por tela, que foi como as unidades e depósitos da
   AMB entraram no arquivo de referência.

   **O retorno CONFERE o que já está no Render** e separa em quatro: o que bate (nada a
   fazer), o que está com **valor diferente** (o caso perigoso — configurado errado e nada
   acusa), o que não existe mas cujo padrão do código já é o valor certo (criar não muda
   nada) e o que precisa mesmo ser criado. Antes disso, era o dono que comparava env por env.

   **E traz as envs prontas pra colar** —
   situações casadas pelo nome (Atendido, AGUARDANDO, DESPACHADOS, Verificado) e o canal do
   ML sugerido, marcado como palpite a confirmar.

   O que o Bling respondeu de verdade (AMB, 15/09), pra ninguém repetir o chute:
   `/depositos` funciona · `/situacoes/modulos` devolve MÓDULOS (Pedidos de Venda = 98310) e
   as situações vêm num 2º passo · `/canais-de-venda` e `/lojas` dão **404**, então os canais
   saem dos pedidos — que trazem `loja.id` mas **não** o nome, e o nome vem do cruzamento com
   os depósitos (`Shopee 206017368`, `Magalu 206018666`). A rota **diz quais caminhos tentou** quando um
   recurso não responde, em vez de reportar lista vazia — 404 tratado como "não tem nada"
   diria que a empresa não tem depósito, e essa mentira custa horas.

2. 🔄 **Identidade nos marketplaces** — **ML feito** (15/09): a mesma rota devolve `seller_id`,
   apelido e e-mail da conta autorizada. Isso confirma que o token é da **conta certa**, que é
   o erro caro do embarque: não é errar o id, é autorizar a conta de outra empresa e só
   descobrir depois. A GOOD não sabia o próprio seller id — agora sabe.
   Faltam **Shopee** e **Magalu**, que têm o mesmo padrão de "quem sou eu".
3. ✅ **Página de embarque** (15/09):

   ```
   https://mover-pedidos-aguardando-x-atendido.onrender.com/embarque?k=SUA_ADMIN_KEY
   ```

   Uma tela com cada empresa e cada conta (Bling, Bling NF, Mercado Livre), marcando ✅ o que
   já está autorizado e oferecendo o clique no que falta. Lê o token em **disco**: não gasta
   chamada de API nem dispara renovação de refresh só porque alguém abriu a página.

4. ~~Uma página de embarque~~ que mostre, numa tela: o que já autorizou (✓), o que falta, e o
   botão de cada autorização pendente — hoje é preciso abrir três URLs separadas.
4. **Gerar a entrada do contrato** por comando, escrevendo **nos dois repositórios**
   (o arquivo é espelhado byte a byte, e errar isso deixa a bateria vermelha dos dois lados).
5. **Checkout declarativo** — bloqueador nº 2 da auditoria. Enquanto não existir, a empresa
   nova ganha fiscal e histórico sem pasta, mas o checkout ainda precisa de uma.
6. **Painel por capacidades** — base pronta (`/api/contexto`); falta o shell comum.

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
