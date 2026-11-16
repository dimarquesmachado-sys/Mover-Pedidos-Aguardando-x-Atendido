# Comentários históricos do `handle` de rotas das três empresas (até 16/11/2026)

Em 16/11 a fila de rotas das três empresas virou a peça `lib/checkout/rotas-empresa` (docs/NORTE-2026-11.md, item C). O `handle` escrito à mão em cada arquivo de entrada — e os ~1.400 linhas de comentário que explicavam cada rota e cada decisão de ordem — saiu dos três arquivos. **Nenhuma linha de código se perdeu** (as rotas que ainda eram do arquivo viraram funções próprias — `_rotaBackfillStatus`, `_rotaShopeeSemear`, `_rotaShopeeDevolucao`, `_rotaBackfillVendas`); o que sai são os comentários, preservados aqui na ordem em que estavam, por empresa. Boa parte fala de rotas que já tinham ido para peças (`lib/checkout/rotas-comuns`, `rotas-lote`, `fabrica-rotas-painel`, `historico`, `diagnostico-empresa`…) — a decisão viva mora no comentário da peça; este arquivo é a memória de como se chegou lá.

## Girassol — `girassol-backup-offline/gbo-app.js`

```js
    // ── IR PRO PEDIDO NA SHOPEE (b22) ────────────────────────────────────
    // O link ↗ dos cards apontava pra URL de BUSCA do Seller Center
    // (?searchKeyword=<order_sn>), que NÃO filtra nada: cai na lista inteira.
    // A URL que abre o pedido é /portal/sale/order/<id_interno_numerico>, e esse
    // id é snowflake — não sai do order_sn nem de nenhuma API oficial da Shopee.
    // Único lugar que faz o de-para é o endpoint que a caixa de busca do próprio
    // Seller Center usa. Ele responde a um GET simples, só exigindo o cookie de
    // sessão (env GIRABKP_SHOPEE_COOKIE), mesmo padrão do BLING_COOKIE.
    // O id de um pedido nunca muda, então guardamos em _shopee-ids.json: resolveu
    // uma vez, nunca mais consulta — e os links já resolvidos seguem funcionando
    // mesmo depois que o cookie vencer.
    // Falhou por qualquer motivo? Redireciona pra URL de busca (o comportamento
    // de hoje). Nunca fica pior do que já era. Com &diag=1 devolve o passo a passo.
    /* 01/09 — CAÇA DUPLICATA: agosto da AMB fecha R$ 259 mil no Bling contra R$ 208 mil no
       Jodda e R$ 207 mil no nosso dashboard. Os dois independentes concordam, então a sobra
       está no Bling — provavelmente venda importada duas vezes. Esta rota procura, do sinal
       mais forte pro mais fraco: mesmo número de venda do marketplace (duplicata quase
       certa), mesmo cliente+valor+data, e mesmo cliente+valor em até 2 dias. */
    /* 04/09 — NFs TRAVADAS: o ML recusa por erro que só mão humana resolve (CEP que o Bling
       importou errado, documento inválido). A F3 parou de retransmitir; aqui o checkout
       mostra quais precisam de intervenção, com o que fazer em cada uma. */
    /* 31/10 — as ROTAS COMUNS (as que as três empresas tinham escritas iguais aqui: arquivos, DANFE, etiqueta, XML,
       impressão, login, operadores, QZ, reenvio de documentos, faturamento do ML, cookies da Shopee, separação) viraram
       a peça única lib/checkout/rotas-comuns, chamada no lugar da primeira delas */

    // SAÚDE DA SESSÃO SHOPEE (b23) — admin. Diz se o cookie está vivo, de onde ele
    // veio (env ou renovado sozinho) e quando foi atualizado pela última vez.
    /* 27/08 (pedido de 13/08) — RECEBE OS COOKIES DA EXTENSÃO: mata o DevTools. A extensão do
       navegador captura os cookies da sessão LOGADA do Seller Center e manda pra cá; grava no
       _shopee-sessao.json com a SEMENTE da env preservada (assim o cookie novo prevalece sem a
       env 'mandar' de volta — a semente só dispara quando a PRÓPRIA env muda) e testa a sessão
       na hora com o keep-alive, devolvendo se ficou viva. A env do Render vira só a semente de
       emergência. */

    // ADMIN: ANEXAR ETIQUETA PDF na mão. Existe pro caso real em que o Bling fica SEM logística
    // no pedido (importou depois do envio já organizado no canal, ou a NF travou a edição) e a
    // etiqueta não vem nem pelo Bling nem pela API do canal. O admin baixa a etiqueta no painel do
    // marketplace, anexa aqui, e o pedido volta a ser processável pelo estoquista — que NÃO precisa
    // (nem deve) ter acesso ao seller center. Body: { id, pdf_base64 }.
    /* 30/10 — ETIQUETAS EM MASSA, a página de envio e as DANFEs em LOTE (peça única lib/checkout/rotas-lote) */

    // ── 09/08: ANEXAR A NOTA FISCAL (PDF ou XML) ────────────────────────────────
    // Irmã da etiqueta-anexar, pro caso oposto: o pedido tem etiqueta mas está SEM NF
    // no cache (nota emitida fora do Bling, ou o Bling ainda não devolveu o PDF).
    //  • PDF  → vira o `danfe.pdf` da pasta do pedido. Como o `tem_danfe` é medido pela
    //           EXISTÊNCIA do arquivo (ciclo.js:340), ele passa a valer sozinho, e a rota
    //           /danfe/{id} serve o arquivo anexado em vez de tentar baixar do Bling.
    //  • XML  → guarda como `nf.xml` E lê de dentro dele o número, a chave e a data de
    //           emissão, preenchendo o pedido. É o que destrava a conferência e o 🧾 hh:mm.
    //  • ZIP  → olha as entradas e pega o que achar (PDF tem prioridade sobre XML).

    // ADMIN (?k=): BACKFILL DE VALORES — busca no Bling o total dos pedidos JÁ FINALIZADOS
    // que não têm valor gravado (finalizados antes da atualização do faturamento) e preenche
    // retroativamente. Uso: /girassol-backup-offline/backfill-valores?k=ADMIN_KEY&dias=31
    // Roda em background (~400ms por pedido, respeitando o rate limit). Chame de novo p/ ver o progresso.

    // ADMIN (?k=): BACKFILL DE DETALHES — preenche UF + valor POR ITEM dos já finalizados
    // Uso: /girassol-backup-offline/backfill-detalhes?k=ADMIN_KEY&dias=31

    // DASHBOARD (sessão admin): saldo/preço/custo por SKU, cache 6h em disco — alimenta a projeção de estoque
    /* 20/10 (tela única): FOTOS DOS PRODUTOS — a Girassol não tinha a rota; a tela única mostra a foto de cada produto
       no ranking. É a peça única lib/checkout/rotas-painel-produto-fotos (a mesma da AMB e da GOOD), com as peças daqui. */
      deps: () => ({ CACHE_DIR, blingGet, primeiraImagem, readJson, writeJson }) });
    /* 07/11 (rotas comuns, passo 9a): /sku-info NIVELADO — a UNIÃO das duas versões, igual nas três: da Girassol/AMB, o NOME
       do produto (no cache e na resposta), a trava do KIT (custo de fornecedor não é custo de kit) e a proteção do custo
       conhecido no fim (b20); da GOOD, a busca que falha cai no custo do banco (Codex #186) MAS cadastro todo EXCLUÍDO não
       recupera custo velho (Codex #497 P1) — e isso agora vale também na proteção do fim. */

    // DASHBOARD — página (a tela única, gerada — 21/10)

    // ADMIN (?k=): BACKFILL-NF — 100% LOCAL (lê nf-simp.json do cache/arquivo; ZERO chamadas ao Bling).
    // Preenche vprod_nf (Σ itens da NOTA) nos finalizados → produtos EXATO + frete EXATO (valor − vprod_nf), retroativo.
    // Uso: /girassol-backup-offline/backfill-nf?k=ADMIN_KEY&dias=45   (roda em segundos)

    // DASHBOARD (sessão admin): CONFIG FISCAL — alíquota do Simples POR MÊS + taxa % por canal

    // ADMIN (?k=): PESCA de tarifas/frete REAIS do ML agora (também roda sozinha todo dia às 04:40)
    // Uso: /girassol-backup-offline/ml-sync-fees?k=ADMIN_KEY&dias=31 — chame de novo p/ ver o progresso

    // LIMPA toda a tabela (empresa girassol) — pra recomeçar o backfill do zero. Uso: /girassol-backup-offline/backfill-limpar

    // CONFERE o que foi gravado no Supabase — conta registros por MÊS e por CANAL. Uso: /girassol-backup-offline/backfill-conferir

    // DISPARA o backfill do ANO TODO — roda os meses de janeiro até 'ate' EM SEQUÊNCIA, sozinho. Uso: /girassol-backup-offline/backfill-ano  (ou &ate=07 pra parar em julho)
    /* BACKFILL DO ANO — 15/11 (rotas-cópia): vira PLANO em disco pela peça (como a GOOD já fazia): fatias de 10 dias, fora do
       horário do galpão, retoma sozinho se o serviço reiniciar. O ano em memória (`backfillAnoTodo`) saiu. */

    // DISPARA o backfill de um período (roda em BACKGROUND). Uso: /girassol-backup-offline/backfill?de=2026-01-01&ate=2026-01-31
    /* 05/09 — BACKFILL FATIADO. O container tem 512 MB e um MÊS da Girassol (~3.000 pedidos)
       estoura: 5 quedas com status 134, 3 delas já com o heap limitado pelo #329. O Bling
       não é o gargalo (zero erros até cair) — é tamanho de trabalho contra tamanho de
       container. Aqui o período longo vira fatias de 10 dias, rodadas uma por vez, com o
       progresso EM DISCO: se o processo cair, o boot retoma de onde parou, sozinho. */
    /* 11/11 (4e): a rota do plano em fatias é a da peça única (status | criar | parar | retentar) */

    // 🌻 ÍCONE E MANIFESTO — 15/11: a peça lib/checkout/rotas-pwa (a mesma da AMB; o ícone no manifesto agora é versionado)

    // 🧮 PLANO DE COMPRA — o motor. Junta ritmo de venda (histórico), saldo e imagem (Bling) e custo
    // (_custos.json) e devolve, por SKU: quanto comprar pra cobrir lead time + cobertura desejada,
    // o quanto isso custa e QUANTO LUCRO ESTÁ EM RISCO se faltar. Ordenado pelo risco, não pelo volume.
    // Uso: /girassol-backup-offline/plano-compra?lead=4&cob=5&seg=0.5&base=180&curva=A

    // 01/08 — faturamento do ML (billing oficial): dispara, status e resumo por período
    // resumo de um período, pros cards do dashboard
    // ── COMPLETAR TARIFA DO TIKTOK (18/08) ────────────────────────────────────────
    /* 29/08 — CUSTO DE DEVOLUÇÕES DO TIKTOK pro dashboard (linha própria no período, decisão
       do dono). Não abate na venda de propósito: no caso 584628284730475569, o custo veio de
       mandar o ITEM ERRADO (frete ida+volta + taxa = R$ 276,70) e o produto voltou pro
       estoque — abater no SKU faria o MP3G parecer ruim, quando o problema foi expedição. */
    /* 30/08 — CANCELAMENTOS DO MAGALU pro dashboard. Mesma decisão do TikTok: linha própria
       no período, não abatimento na venda. E aqui só entra o que CHEGOU a virar faturamento:
       pedido que o cliente não pagou nunca somou, então descontá-lo inventaria prejuízo —
       na Girassol isso seria R$ 10.496 de perda fictícia. */

    // ── CANÁRIO MARKETPLACE × BLING (16/08) ───────────────────────────────────────
    // Regra do Diego: "o Bling não é o rei; quem manda é o MARKETPLACE". Pega a lista de
    // vendas em cada marketplace e confere se TODAS chegaram ao Bling.
    // Caso real: o token Bling↔Shopee da Girassol venceu (dura ~365 dias, o Bling não avisa),
    // 28 pedidos não desceram, e o sintoma só apareceu como diferença de faturamento
    // (Jodda R$ 15 mil × nosso R$ 11 mil). A GOOD passou pelo mesmo em 11/08.
    // ⚠️ PRINCÍPIO (Codex, 8 apontamentos no #104): FALHA NUNCA VIRA "TUDO CERTO".
    // Se a consulta falhar, vier truncada, ou o Bling não responder, o canal fica NÃO
    // VERIFICADO e o veredito é INDETERMINADO — nunca ✅.
    /* 06/09 — RAIO-X DE UMA VENDA. O canário insistia em acusar a 2000018258015754 mesmo com
       ela no Bling (entregue, NF emitida), e passamos cinco rodadas de conserto no escuro
       porque eu só via o resultado da comparação, nunca os dois lados. Esta rota mostra o que
       o ML responde e o que o Bling tem, lado a lado — pra o próximo caso ser resolvido em
       minutos em vez de rodadas. */

    /* 23/10 (passo 2): /canario-estado (o aviso do painel, só admin) e /canario-marketplaces (conferência na mão) são as
       rotas da peça única lib/checkout/canario-empresa — as mesmas nas três empresas */

    // ── DEVOLUÇÕES DO ML (14/08) ──────────────────────────────────────────────────
    // Espelha o que a Shopee já tem. O card do ML mostrava só o total do faturamento
    // ("Devoluções R$ X") sem dizer O QUE voltou. A sonda confirmou que a API entrega:
    // pedido, item, quantidade devolvida vs comprada, status e se o dinheiro está retido.
    // Cuidado embutido: a busca do ML mistura `returns` com `mediations` e cancelamentos —
    // só `returns` é devolução (dos 12 abertos da Girassol, 5 eram). O SKU não vem do ML;
    // sai do nosso cache de bipados pelo número do pedido.

    /* 02/09 — O QUE SOBROU EM 'outros': depois de classificar 4 categorias novas, a AMB ainda
       tem -R$ 450 e a Girassol R$ 4.286 nesse balde. Como o valor da AMB é NEGATIVO, é crédito
       que o ML devolveu e o dashboard não mostra — dinheiro faltando a favor do dono. Esta rota
       lista as descrições que não casaram com nenhuma regra, agrupadas, pra fechar de vez em
       vez de adivinhar. Só lê o cache; não chama a API nem grava nada. */
    /* 02/09 — FATURA DO CARTÃO do ML, pelo ciclo do ML (13→12), com composição. Vem do campo
       debited_from_operation que a coleta passou a gravar; sem re-sincronizar, os registros
       antigos não têm a marca e aparecem em sem_marca. Só lê o cache. */

    /* 30/09 — RAIO-X DA FATURA DO CARTÃO. O painel da AMB mostrou R$ 6.455,32 num ciclo em
       que o cartão debitou R$ 5.928,23, com o dado FRESCO — então não é atraso. Duas
       categorias batiam byte a byte com a fatura oficial, o que aponta CLASSIFICAÇÃO, não
       coleta.
       Esta rota não corrige nada: abre o ciclo linha a linha com a marca que o ML mandou em
       cada tarifa, pra comparar com o relatório de Faturamento. Achar por dedução foi o que
       já custou caro aqui. Só leitura, e só admin. */

    // 02/08 - VENDAS DIRETO DO MERCADO LIVRE (o marketplace e a fonte; o Bling e espelho).
    // Decisao do Diego: se a venda ocorreu no dia, tem que aparecer no dia — mesmo que o ML ainda
    // nao tenha organizado o envio e o Bling nem saiba dela (envio agendado, Fulfillment, etc).
    // ESTE E O PASSO 1: so LE do ML e compara com o que temos. Nao muda nada em producao.

    /* 27/08 — CLASSIFICADOR das vendas 'faltando' do /ml-vendas-faltando: consulta o status REAL
       de cada uma na API do ML. Motivo: o billing pode lançar o ESTORNO da comissão noutra
       categoria, então venda CANCELADA fica no mapa com comissão cheia — indistinguível de venda
       perdida sem olhar o status. Separa: cancelada (ok, o histórico exclui de propósito) ×
       carrinho que o billing não mapeou (ok, está no nosso pelo número do pack) × PAGA-E-AUSENTE
       (o buraco real a importar). Máx 250 por chamada (~1min) — rode em fatias se precisar. */
    // 01/08 — varredura de cancelados: apaga do histórico quem foi cancelado no Bling

    // disparo manual: ?meses=2026-07,2026-08  (ou ?meses=todos p/ o ano inteiro)

    // STATUS NO MARKETPLACE: pergunta ao ML/Shopee se o pedido foi CANCELADO pelo cliente.
    // O Bling demora (ou não) pra refletir isso; o dashboard precisa mostrar cinza na hora.
    // Uso: /girassol-backup-offline/status-mkt?de=YYYY-MM-DD&ate=YYYY-MM-DD

    // COMPLETAR DETALHES do período que o dashboard está mostrando (SKU/qtd/taxas dos ainda não bipados).
    // Uso: /girassol-backup-offline/completar-detalhes?de=YYYY-MM-DD&ate=YYYY-MM-DD
    // Processa um lote curto e devolve quantos faltam — o dashboard chama em sequência até zerar.

    // STATUS do backfill em andamento. Uso: /girassol-backup-offline/backfill-status
    if (method === 'GET' && p === '/girassol-backup-offline/backfill-status') {

    // TESTE de conexão com o Supabase (histórico) — grava e apaga 1 registro. Confirma antes do backfill.
    // Uso: /girassol-backup-offline/backfill-teste

    // ADMIN (sessão ou ?k=): sincronizador de custos em background. ?status=1 mostra progresso.

    // ─── REAPLICAR CUSTO NO HISTÓRICO (19/08) ───────────────────────────────────
    // ?de=&ate= obrigatórios · &simular=1 mostra o que MUDARIA sem gravar (recomendado antes)
    // ?status=1 acompanha. Só admin.
    /* ═══ 21/08 — CUSTOS MANUAIS: tela + gravação (pedido do Diego) ═══════════════════════
    GET  /girassol-backup-offline/custos-manuais        → tela (colar do Excel ou subir CSV)
    POST /girassol-backup-offline/custos-manuais        → grava {texto} ou {itens}
    GET  /girassol-backup-offline/custos-manuais?lista=1 → o que está gravado hoje
    A regra é a que ele definiu: o manual só vale onde o BLING não tem custo. */
    /* ═══ 21/08 — ROTA DA LINHA DO TEMPO DO CUSTO (o card consome) ═══════════════════════
    GET  /girassol-backup-offline/custo-historico?sku=          → faixas do SKU + custo atual do Bling
    POST /girassol-backup-offline/custo-historico  {sku,custo,de}  → lança faixa manual (de = AAAA-MM-DD)
    POST /girassol-backup-offline/custo-historico  {sku,apagar:'AAAA-MM-DD'} → remove a faixa que começa nessa data
    Nasceu do desenho do Diego: "ter esse histórico fácil no card, e poder alterar manualmente,
    ou pedir importação do bling". */

    /* ═══ 21/08 — DE-PARA MANUAL: rota (o card consome) ═══════════════════════════════════
    GET  /girassol-backup-offline/sku-depara-manual            → lista os pares declarados
    GET  /girassol-backup-offline/sku-depara-manual?sugerir=464 → candidatos no catálogo (só sugestão)
    POST /girassol-backup-offline/sku-depara-manual {de,para}   → declara o par
    POST /girassol-backup-offline/sku-depara-manual {apagar}    → remove
    Pro caso do "464"/"465", que não têm produto_id e o Bling não consegue ligar sozinho. */
    /* 13/09 — fatia 8 da desduplicação: a rota do de-para de SKU (129 linhas) era igual nas
       duas empresas, mudando só o prefixo. Foi pra lib/checkout/rota-depara-sku.js, que
       guarda as travas aprendidas em revisão — apagar remove TODAS as variantes de grafia,
       e declarar um par recusa ciclo. Duas cópias dessas regras eram duas chances de uma
       divergir da outra. */

    // DE-PARA DE SKU RENOMEADO — conserto cirúrgico do rename no histórico do Supabase.
    // (23/08: portada da AMB. A Girassol MENCIONAVA esta rota na resposta do /sku-depara e não
    //  a tinha — quem seguisse a instrução batia num 404.)
    // ⚠️ Match EXATO de propósito: existe FL-1011-PRETO-2LAMPS, que é OUTRO produto e não pode
    // ser tocado (aviso do Diego). Nada de LIKE/prefixo aqui.
    // Uso:  GET /girassol-backup-offline/sku-repara?de=SKU_ANTIGO&para=SKU_NOVO&k=ADMIN_KEY
    //       (sem &aplicar=1 é SIMULAÇÃO: diz quantas linhas mudariam, sem gravar)

    // SKU ÓRFÃO (13/08) — MEDIÇÃO pro caso do rename de SKU no Bling (achado no app de
    // Devoluções: a venda antiga guarda o SKU velho e, depois do rename, ninguém acha o produto;
    // o histórico do dashboard parte em dois no dia do rename). Antes de trocar a chave de
    // agregação por produto_id, esta rota MEDE o tamanho do problema: quantos SKUs do histórico
    // não existem mais no catálogo, e quanto faturamento está preso neles.
    // Uso: GET /girassol-backup-offline/sku-orfaos?de=AAAA-MM-DD&ate=AAAA-MM-DD&k=ADMIN_KEY
    // Só leitura. O catálogo é varrido INTEIRO (o filtro ?codigo= do Bling não é confiável —
    // ora volta vazio pra produto que existe, ora ignora o filtro), montando codigo → id.
    /* ═══ 21/08 — DE-PARA AUTOMÁTICO DE SKU RENOMEADO ═══════════════════════════════════════
    Nasceu do FL-1011-PRETO: renomeado no Bling para 3933398010054, o código antigo deixou de
    existir e as 53 vendas antigas ficaram sem custo. O Diego resolveu à mão pela planilha, mas
    isso vai acontecer de novo a cada rename.
    COMO DESCOBRE: o Bling troca o CÓDIGO e mantém o `id` do produto. O cache de custos guarda
    `{ id, custo }` por SKU — inclusive dos que já foram renomeados. Então: id do SKU velho no
    cache × código que esse mesmo id tem HOJE no catálogo = o par antigo→novo. Funciona
    retroativamente, não só pra renames futuros.
    NÃO altera nada sozinho: devolve os pares e o Diego decide (o `sku-repara`, que já existe,
    é quem troca no histórico). */

    /* 12/09 — DISPARO MANUAL do custo diário. Antes só existia o relógio (23h, e a janela
       de recuperação até 6h), então não havia como TESTAR a rotina nem recuperar uma noite
       perdida sem esperar o dia seguinte. Dois cuidados: `dia` permite refazer um dia já
       carimbado (senão a rotina recusa na hora, que é o certo no automático), e a chamada
       avisa que vai consumir cota do Bling — a regra da casa é rotina pesada fora do
       horário do galpão. */

    // NÍVEL de desconto do frete Magalu (config do ⚙️). GET lê, POST salva.
    // Valida por SESSÃO admin (igual config-fiscal) — chamada pelo dashboard.

    // SONDA de dimensões de um produto — pra ver os nomes EXATOS dos campos (largura/altura/
    // profundidade/peso) que o cálculo de frete Magalu vai usar.
    // REMOVIDA por segurança após cumprir o diagnóstico (usava ?k= na query e expunha o
    // produto cru). As dimensões vêm de blingGet('/produtos/{id}').dimensoes, já confirmado.

    // salva a localização de um SKU no Bling (PATCH /produtos/{id}) + atualiza o cache + registra quem editou

    // auditoria: log de edições de localização (quem mudou o quê e quando). uso: /localizacoes-log

    // busca um produto por SKU ou EAN (telinha de consulta/edição de localização do estoquista)

    // ─── indexar catálogo inteiro (1x; deixa todo EAN achável na hora) — só admin ───

    // LISTA DE SEPARAÇÃO — agregado de itens a separar (do cache). ?mkt=ml|shopee|... ou vazio = todos

    // RESERVA um pedido p/ um operador (presença entre PCs — quadradinho colorido tipo Bling)

    // LIBERA a reserva (ao voltar pra lista / finalizar)

    // marca pedido como conferido offline (entra na fila p/ sync na Fase 3)

    // FASE 3 — força o sync da fila de conferidos → VERIFICADO (24). Botão "Sincronizar" / manual.

    // DEBUG: mostra a resposta crua do Bling pra entender como buscar pedido (filtro funciona? 116856 é numero ou numeroLoja?)
    // DEBUG 2: testa buscar NF por número e contato por nome (pra saber quais buscas a API permite)

    // DEBUG: acha pedidos no cache que parecem KIT/composição (p/ inspecionar a estrutura)

    // ─── HISTÓRICO E ANÁLISE (módulo historico.js). Conferido: nenhum prefixo declarado
    //     acima (/pedido/, /etiqueta/, /imprimir/ …) casa com estas rotas, então delegar
    //     aqui no fim não muda a ordem de casamento.

    // ─── PESCARIA de tarifas retroativas (módulo pescaria.js)

    // ─── CANÁRIO das integrações (módulo canario.js)

    // ─── PODA do bucket de expedição (módulo limpeza.js)

    // ─── ROTINA NOTURNA (módulo noturna.js): /noturna-status e /rodar-noturna
    if (_noturna.rotas(req, res, urlObj)) return true;

    // ─── SHOPEE API oficial (módulo gbo-shopee.js): /shopee/conectar, /callback, /status, /sonda

    // ─── VARREDURA dos fornecedores (só leitura) ──────────────────────────────

    // ─── SONDA GENÉRICA DO BLING (06/08) — perguntar pra API em vez de supor ──
    // Eu disse "a API do Bling devolve só o fornecedor padrão". Isso foi uma
    // conclusão minha a partir do /produtos/{id}, NÃO uma leitura da documentação —
    // e o Diego cobrou, com razão. O Bling tem um módulo de Produtos-Fornecedores
    // que provavelmente tem endpoint próprio. Em vez de eu chutar o caminho, esta
    // rota deixa PERGUNTAR pra própria API, sem precisar de deploy a cada tentativa.
    // Só GET, só admin, e o caminho tem que começar com / (nada de passagem livre).
    // Uso: /girassol-backup-offline/bling-cru?caminho=/produtos/fornecedores&q=idProduto=16433181895

    // ─── 06/08: SONDA DO PRODUTO NO BLING (só leitura) ────────────────────────
    // Nasceu do 50-AE-8F-180mm-KIT45: o fornecedor KaQi daquele SKU aponta pro
    // código de OUTRO produto (50-lisa-225mm-KIT29, custo 37,26) dentro de um kit
    // de 180mm. Hoje não estraga porque o padrão é outro fornecedor — mas se virar
    // padrão, o custo do kit passa a ser o de um produto diferente, e isso vai
    // direto pro histórico sem ninguém ver.
    // Antes de varrer o catálogo inteiro eu preciso saber se a API do Bling
    // devolve os fornecedores no detalhe do produto. Esta rota mostra o CRU.
    // Uso: /girassol-backup-offline/produto-cru?id=16433181895&k=ADMIN_KEY

    // ─── DIAGNÓSTICO (módulo diagnostico.js) — por último, pra não mudar a ordem
    //     de casamento das rotas que já existiam antes dele.

    /* ════════════════════════════════════════════════════════════════════════════════════════
       02/10 — A GIRASSOL PASSA A USAR A FÁBRICA, pelo caminho já provado na AMB hoje.

       ⚠️ MONTAGEM NO FIM DO HANDLER, de propósito: na AMB ela ficava no começo e peças
       declaradas mais abaixo NA MESMA FUNÇÃO ficavam em zona morta — "Cannot access 'FOTO_V'
       before initialization", e duas rotas pararam de responder. Aqui nasce no lugar certo.

       ⚠️ TODAS as 33 rotas que a Girassol já tem E a fábrica trata entram em `rotasProprias`: a
       dela vence. Ligar sem isso trocaria a resposta da empresa que MAIS FATURA pela versão da
       fábrica, que é menos rodada.

       ⚠️ E só passo peça declarada no NÍVEL DO ARQUIVO. Hoje me enganei duas vezes com isto
       (`responderCusto`, `garantirTokenML`): estar na linha 500 não quer dizer estar no escopo —
       se o require está dentro de uma função, a peça não existe no ponto da montagem.
       ════════════════════════════════════════════════════════════════════════════════════════ */
      } catch (e) {
        console.error('[GIRASSOL] falha ao montar as rotas compartilhadas:', e.message);

```

## AMBTotal — `amb-checkout-offline/index.js`

```js
    // ── SONDA DE UNIDADE DE NEGÓCIO (temporária, diagnóstico) ───────────
    // Objetivo: descobrir ONDE, no JSON do pedido da API do Bling, aparece a
    // unidade de negócio (Shopee FULL vs Matriz) — se vem na LISTA de pedidos
    // ou só no DETALHE. Sem isso, não dá pra escrever o filtro com segurança.

    // ── IR PRO PEDIDO NA SHOPEE (b17) ────────────────────────────────────
    // O link ↗ dos cards apontava pra URL de BUSCA do Seller Center
    // (?searchKeyword=<order_sn>), que NÃO filtra nada: cai na lista inteira.
    // A URL que abre o pedido é /portal/sale/order/<id_interno_numerico>, e esse
    // id é snowflake — não sai do order_sn nem de nenhuma API oficial da Shopee.
    // Único lugar que faz o de-para é o endpoint que a caixa de busca do próprio
    // Seller Center usa. Ele responde a um GET simples, só exigindo o cookie de
    // sessão (env AMBBKP_SHOPEE_COOKIE), mesmo padrão do BLING_COOKIE.
    // O id de um pedido nunca muda, então guardamos em _shopee-ids.json: resolveu
    // uma vez, nunca mais consulta — e os links já resolvidos seguem funcionando
    // mesmo depois que o cookie vencer.
    // Falhou por qualquer motivo? Redireciona pra URL de busca (o comportamento
    // de hoje). Nunca fica pior do que já era. Com &diag=1 devolve o passo a passo.
    /* 01/09 — CAÇA DUPLICATA: agosto da AMB fecha R$ 259 mil no Bling contra R$ 208 mil no
       Jodda e R$ 207 mil no nosso dashboard. Os dois independentes concordam, então a sobra
       está no Bling — provavelmente venda importada duas vezes. Esta rota procura, do sinal
       mais forte pro mais fraco: mesmo número de venda do marketplace (duplicata quase
       certa), mesmo cliente+valor+data, e mesmo cliente+valor em até 2 dias. */
    /* 04/09 — NFs TRAVADAS: o ML recusa por erro que só mão humana resolve (CEP que o Bling
       importou errado, documento inválido). A F3 parou de retransmitir; aqui o checkout
       mostra quais precisam de intervenção, com o que fazer em cada uma. */

    /* 23/10 (passo 2): as rotas do canário da peça única — a AMB ganha também o /canario-estado (o aviso no painel) */

    /* 31/10 — as ROTAS COMUNS (as que as três empresas tinham escritas iguais aqui: arquivos, DANFE, etiqueta, XML,
       impressão, login, operadores, QZ, reenvio de documentos, faturamento do ML, cookies da Shopee, separação) viraram
       a peça única lib/checkout/rotas-comuns, chamada no lugar da primeira delas */

    // ── SEMEAR SESSÃO SHOPEE (b22) — cola o cURL (ou só o trecho do
    // Cookie:) da chamada que FUNCIONA no seu navegador, e o servidor
    // extrai o cookie e grava no jar. Serve pros cookies HttpOnly
    // (SPC_ST etc.) que a captura manual pra env AMBBKP_SHOPEE_COOKIE
    // nao pega. Guarda: ?k=ADMIN_KEY. POST body {curl:"..."} OU {cookie:"..."}.
    if (method === 'POST' && p === '/amb-checkout-offline/shopee-semear') {

    // ── DEVOLUÇÃO SHOPEE: entregue? quando? (b20 — fase 2 do bloco ─────
    // vermelho do Devoluções da AMB). Lê o Seller Center com o MESMO
    // cookie/jar do ir-shopee: histórico da logística REVERSA
    // (/api/v1/return/reverse_logistics_tracking_history) — é onde mora
    // o "Pedido devolvido dd/mm hh:mm" da página da solicitação.
    // Aceita ?rid=<id_interno> (o número da URL do portal) OU
    // ?rsn=<numero_da_solicitacao> (tenta resolver o id via detail).
    // Guarda: ?k=ADMIN_KEY OU sessão de admin do checkout. &diag=1 = passos.
    // Entregue é terminal → cache permanente em _shopee-devolucoes.json.
    if (method === 'GET' && p === '/amb-checkout-offline/shopee-devolucao') {

    // SAÚDE DA SESSÃO SHOPEE (b18) — admin. Diz se o cookie está vivo, de onde ele
    // veio (env ou renovado sozinho) e quando foi atualizado pela última vez.
    /* 27/08 (pedido de 13/08) — RECEBE OS COOKIES DA EXTENSÃO: mata o DevTools. A extensão do
       navegador captura os cookies da sessão LOGADA do Seller Center e manda pra cá; grava no
       _shopee-sessao.json com a SEMENTE da env preservada (assim o cookie novo prevalece sem a
       env 'mandar' de volta — a semente só dispara quando a PRÓPRIA env muda) e testa a sessão
       na hora com o keep-alive, devolvendo se ficou viva. A env do Render vira só a semente de
       emergência. */

    // ADMIN: ANEXAR ETIQUETA PDF na mão. Existe pro caso real em que o Bling fica SEM logística
    // no pedido (importou depois do envio já organizado no canal, ou a NF travou a edição) e a
    // etiqueta não vem nem pelo Bling nem pela API do canal. O admin baixa a etiqueta no painel do
    // marketplace, anexa aqui, e o pedido volta a ser processável pelo estoquista — que NÃO precisa
    // (nem deve) ter acesso ao seller center. Body: { id, pdf_base64 }.
    /* 30/10 — ETIQUETAS EM MASSA, a página de envio e as DANFEs em LOTE (peça única lib/checkout/rotas-lote) */

    // ── 09/08: ANEXAR A NOTA FISCAL (PDF ou XML) ────────────────────────────────
    // Irmã da etiqueta-anexar, pro caso oposto: o pedido tem etiqueta mas está SEM NF
    // no cache (nota emitida fora do Bling, ou o Bling ainda não devolveu o PDF).
    //  • PDF  → vira o `danfe.pdf` da pasta do pedido. Como o `tem_danfe` é medido pela
    //           EXISTÊNCIA do arquivo (ciclo.js:340), ele passa a valer sozinho, e a rota
    //           /danfe/{id} serve o arquivo anexado em vez de tentar baixar do Bling.
    //  • XML  → guarda como `nf.xml` E lê de dentro dele o número, a chave e a data de
    //           emissão, preenchendo o pedido. É o que destrava a conferência e o 🧾 hh:mm.
    //  • ZIP  → olha as entradas e pega o que achar (PDF tem prioridade sobre XML).

    // ADMIN (?k=): BACKFILL DE VALORES — busca no Bling o total dos pedidos JÁ FINALIZADOS
    // que não têm valor gravado (finalizados antes da atualização do faturamento) e preenche
    // retroativamente. Uso: /amb-checkout-offline/backfill-valores?k=ADMIN_KEY&dias=31
    // Roda em background (~400ms por pedido, respeitando o rate limit). Chame de novo p/ ver o progresso.

    // ADMIN (?k=): BACKFILL DE DETALHES — preenche UF + valor POR ITEM dos já finalizados
    // Uso: /amb-checkout-offline/backfill-detalhes?k=ADMIN_KEY&dias=31

    // DASHBOARD (sessão admin): saldo/preço/custo por SKU, cache 6h em disco — alimenta a projeção de estoque
    /* 07/11 (rotas comuns, passo 9a): /sku-info NIVELADO — a UNIÃO das duas versões, igual nas três: da Girassol/AMB, o NOME
       do produto (no cache e na resposta), a trava do KIT (custo de fornecedor não é custo de kit) e a proteção do custo
       conhecido no fim (b20); da GOOD, a busca que falha cai no custo do banco (Codex #186) MAS cadastro todo EXCLUÍDO não
       recupera custo velho (Codex #497 P1) — e isso agora vale também na proteção do fim. */

    // DASHBOARD — página (amb-dashboard.html do módulo)
    /* 30/08 — CUSTO DE DEVOLUÇÕES DO TIKTOK (mesma lib da Girassol, empresa como parâmetro:
       lib/tiktok-custo-devolucoes.js não é cópia). Linha própria no período, não abatimento
       na venda — quando o custo vem de erro de expedição, abater no SKU culpa o produto. */
    /* 30/08 — CANCELAMENTOS DO MAGALU pro dashboard. Mesma decisão do TikTok: linha própria
       no período, não abatimento na venda. E aqui só entra o que CHEGOU a virar faturamento:
       pedido que o cliente não pagou nunca somou, então descontá-lo inventaria prejuízo —
       na Girassol isso seria R$ 8.549 de perda fictícia. */

    // ADMIN (?k=): BACKFILL-NF — 100% LOCAL (lê nf-simp.json do cache/arquivo; ZERO chamadas ao Bling).
    // Preenche vprod_nf (Σ itens da NOTA) nos finalizados → produtos EXATO + frete EXATO (valor − vprod_nf), retroativo.
    // Uso: /amb-checkout-offline/backfill-nf?k=ADMIN_KEY&dias=45   (roda em segundos)

    // DASHBOARD (sessão admin): CONFIG FISCAL — alíquota do Simples POR MÊS + taxa % por canal

    // ADMIN (?k=): PESCA de tarifas/frete REAIS do ML agora (também roda sozinha todo dia às 04:40)
    // Uso: /amb-checkout-offline/ml-sync-fees?k=ADMIN_KEY&dias=31 — chame de novo p/ ver o progresso

    // LIMPA toda a tabela (empresa amb) — pra recomeçar o backfill do zero. Uso: /amb-checkout-offline/backfill-limpar

    // ADMIN (?k= ou sessão): RAIO-X DO PEDIDO CRU do Bling — mostra TODAS as chaves e qualquer campo
    // com cara de data/hora, pra decidirmos com o payload real se o Bling guarda a hora da venda.
    // Uso: /amb-checkout-offline/debug-pedido?id=116063  (o nº que aparece na coluna Pedido)
    /* ═══ PEDIDOS MOVIDOS PRA DESPACHADOS POR ENGANO ══════════════════════════════════
       Rastro do incidente de 24/08: clonar pedido no Bling COPIA a unidade de negócio, então
       o clone de uma venda Full nascia com unidade Full mesmo saindo da matriz, e o ciclo o
       mandava pra DESPACHADOS. O ciclo olha 5 dias, então há mais afetados que os poucos que
       apareceram na tela.

       ⚠️ SÓ LISTA. NÃO ALTERA NADA. Tinha um modo `gravar=1` que devolvia os pedidos pra
       ATENDIDO em lote, e foi de onde vinham TODOS os riscos apontados na revisão — inclusive
       um P1: se o conferidos.json estivesse ausente ou truncado, readJson devolve {} em
       silêncio, todo pedido pareceria "nunca bipado" e centenas de pedidos legítimos seriam
       devolvidos de uma vez. Tirei o modo inteiro, porque ele não é mais necessário: com o
       PR #195 no ar, mover um pedido pra ATENDIDO na mão AGORA GRUDA — a trava da série
       impede o ciclo de levar de volta. A parte difícil é DESCOBRIR quais são, e é isso que
       esta rota faz.

       Uso: /amb-checkout-offline/despachados-por-engano?k=ADMIN_KEY[&dias=10] */
    /* ═══ SONDA TEMPORÁRIA (25/08): clones de garantia escondidos como Full ══════════════
       Pergunta pontual do dono: "quais NFs de agosto são SÉRIE 1 mas estão na unidade
       AMB - FULL MLivre?" — clones de reposição que nasceram carimbados como Full.
       SÓ LISTA, não altera nada. Remover quando não for mais útil.

       v2 (25/08, noite): a varredura passou pra 2º PLANO. A versão síncrona morria com a
       aba do navegador — quinzena tem ~1.500 pedidos e a leitura de série custa 2-3
       chamadas com pausa anti-429 por pedido Full: 15-30 min que browser nenhum espera, e
       fechar a aba matava tudo. Agora: &acao=iniciar dispara e responde NA HORA;
       &acao=status (o padrão) mostra andamento e, no fim, o resultado. O estado vive em
       memória e morre no restart do serviço — aceitável numa sonda descartável.
       Uso: ?k=ADMIN_KEY&acao=iniciar[&de=2026-08-01&ate=2026-08-15][&un=2839148]
            ?k=ADMIN_KEY               ← consulta o andamento/resultado */

    // DISPARA o backfill do ANO TODO — roda os meses de janeiro até 'ate' EM SEQUÊNCIA, sozinho. Uso: /amb-checkout-offline/backfill-ano  (ou &ate=07 pra parar em julho)
    /* BACKFILL DO ANO — 15/11 (rotas-cópia): vira PLANO em disco pela peça (como a GOOD já fazia): fatias de 10 dias, fora do
       horário do galpão, retoma sozinho se o serviço reiniciar. O ano em memória (`backfillAnoTodo`) saiu. */

    // DISPARA o backfill de um período (roda em BACKGROUND). Uso: /amb-checkout-offline/backfill?de=2026-01-01&ate=2026-01-31
    // 🌻 ÍCONE E MANIFESTO — pra a aba do navegador, o favorito (Ctrl+D) e principalmente o atalho
    // na tela de início do celular. Servidos pelo servidor (não embutidos) porque o Android só
    // aceita ícone de URL real no "adicionar à tela de início". Cache de 30 dias.
    // ÍCONE E MANIFESTO — 15/11: a peça lib/checkout/rotas-pwa (a mesma da Girassol)

    // 📸 FOTOS DOS PRODUTOS (TOP Produtos) — lê o cache do plano de compra e, se faltar,
    // busca no Bling um punhado por chamada. Nunca varre tudo de uma vez: o Bling satura
    // e a tela é secundária. O que não vier agora entra no cache e aparece na próxima.
    // FOTO_V: sobe quando a LEITURA da imagem muda (ex.: passar a ler a interna). Cache
    // gravado por versão anterior é ignorado, senão o conserto só apareceria 12h depois.

    // 🛒 CAÇA DA MAGALU — dispara pra um período (?de=&ate=) ou vê o status (?status=1)

    // 🧮 PLANO DE COMPRA — o motor. Junta ritmo de venda (histórico), saldo e imagem (Bling) e custo
    // (_custos.json) e devolve, por SKU: quanto comprar pra cobrir lead time + cobertura desejada,
    // o quanto isso custa e QUANTO LUCRO ESTÁ EM RISCO se faltar. Ordenado pelo risco, não pelo volume.
    // Uso: /amb-checkout-offline/plano-compra?lead=4&cob=5&seg=0.5&base=180&curva=A

    // 01/08 — faturamento do ML (billing oficial): dispara, status e resumo por período
    // resumo de um período, pros cards do dashboard
    // DE-PARA DE SKU RENOMEADO (14/08) — conserto cirúrgico do achado do rename. A medição
    // (/sku-orfaos) mostrou 1 órfão na AMB: FL-1011-PRETO (53 un, R$ 5.722,70, em 4 canais),
    // renomeado no Bling para 3933398010054 — o histórico ficou partido em dois produtos.
    // ⚠️ Match EXATO de propósito: existe FL-1011-PRETO-2LAMPS, que é OUTRO produto e não pode
    // ser tocado (aviso do Diego). Nada de LIKE/prefixo aqui.
    // Uso:  GET /amb-checkout-offline/sku-repara?de=SKU_ANTIGO&para=SKU_NOVO&k=ADMIN_KEY
    //       (sem &aplicar=1 é SIMULAÇÃO: diz quantas linhas mudariam, sem gravar)

    // SKU ÓRFÃO (13/08) — MEDIÇÃO pro caso do rename de SKU no Bling (achado no app de
    // Devoluções: a venda antiga guarda o SKU velho e, depois do rename, ninguém acha o produto;
    // o histórico do dashboard parte em dois no dia do rename). Antes de trocar a chave de
    // agregação por produto_id, esta rota MEDE o tamanho do problema: quantos SKUs do histórico
    // não existem mais no catálogo, e quanto faturamento está preso neles.
    // Uso: GET /amb-checkout-offline/sku-orfaos?de=AAAA-MM-DD&ate=AAAA-MM-DD&k=ADMIN_KEY
    // Só leitura. O catálogo é varrido INTEIRO (o filtro ?codigo= do Bling não é confiável —
    // ora volta vazio pra produto que existe, ora ignora o filtro), montando codigo → id.
    /* ═══ 21/08 — DE-PARA AUTOMÁTICO DE SKU RENOMEADO ═══════════════════════════════════════
    Nasceu do FL-1011-PRETO: renomeado no Bling para 3933398010054, o código antigo deixou de
    existir e as 53 vendas antigas ficaram sem custo. O Diego resolveu à mão pela planilha, mas
    isso vai acontecer de novo a cada rename.
    COMO DESCOBRE: o Bling troca o CÓDIGO e mantém o `id` do produto. O cache de custos guarda
    `{ id, custo }` por SKU — inclusive dos que já foram renomeados. Então: id do SKU velho no
    cache × código que esse mesmo id tem HOJE no catálogo = o par antigo→novo. Funciona
    retroativamente, não só pra renames futuros.
    NÃO altera nada sozinho: devolve os pares e o Diego decide (o `sku-repara`, que já existe,
    é quem troca no histórico). */

    // MAGALU-DEBUG (13/08) — a caça devolveu sem_no_bling 116/116 DUAS vezes (procurando pelo
    // `code` e depois pelo `id` UUID). Antes de chutar uma terceira chave, esta rota mostra o
    // que CADA LADO tem de verdade num dia: os pedidos da Magalu (code + id) e o que a listagem
    // do Bling devolve (quantos, que datas, e os numeroLoja crus). Só leitura.

    // FLEX-DEBUG (13/08) — o billing NAO tem o bonus de envio: a rodada de 01/08 a 13/08 achou
    // 504 creditos e ZERO bonus (so "Cancelamento de..."). Antes de escolher a fonte definitiva,
    // esta rota mostra, PARA UMA VENDA, o que cada fonte candidata responde de verdade:
    //   1) /shipments/{id}            → logistic_type, base_cost, list_cost/cost
    //   2) /shipments/{id}/costs      → senders[0].cost, compensation, compensations[]
    //   3) /orders/{id}               → payments[] (shipping_cost) e o que houver de credito
    //   4) o que existe no _ml_billing.json daquela venda (por order e por pack)
    // So leitura, nada e gravado.

    // CRÉDITOS FLEX — distribui os bônus de envio do billing no histórico (?de=&ate=; sem período = ano)

    // ── AUTORIZAÇÃO DO ML PELA AMB (14/08) ────────────────────────────────────────
    // O setup do ML vive no módulo `ambtotal`, que NÃO está respondendo neste serviço
    // (/amb/setup-ml devolve 404 do roteador raiz = nenhum módulo tratou). Como o
    // reconsentimento é obrigatório pra liberar as devoluções (o token atual não ganha o
    // escopo novo sozinho), a autorização passa a existir também aqui, no módulo que está
    // no ar. Usa o MESMO mlTokenManager da AMB — não cria credencial nova.
    //   1) /amb-checkout-offline/setup-ml?k=      → manda pro ML autorizar
    //   2) o ML volta pro redirect cadastrado com ?code=… (se aquele caminho der 404,
    //      basta copiar o code da barra de endereços)
    //   3) /amb-checkout-offline/ml-trocar-code?code=…&k=  → grava o token novo

    // ── COMPLETAR TARIFA DO TIKTOK (18/08) ────────────────────────────────────────

    // ── CANÁRIO MARKETPLACE × BLING na AMB (17/08) ────────────────────────────────
    // Portado da Girassol, onde pegou 38 pedidos da Shopee que não desceram ao Bling depois do
    // token da integração expirar em silêncio. Vem pra cá porque agosto da AMB fechou com 723
    // linhas (~43/dia contra ~54/dia em julho): sem conferir, não dá pra saber se é venda menor
    // ou pedido que não chegou. A lib é a mesma; só as fontes mudam de empresa.
    /* 06/09 — RAIO-X DE UMA VENDA. O canário insistia em acusar a 2000018258015754 mesmo com
       ela no Bling (entregue, NF emitida), e passamos cinco rodadas de conserto no escuro
       porque eu só via o resultado da comparação, nunca os dois lados. Esta rota mostra o que
       o ML responde e o que o Bling tem, lado a lado — pra o próximo caso ser resolvido em
       minutos em vez de rodadas. */

    /* 06/09 — O QUE O CANÁRIO ACHOU E O QUE FEZ. O dono perguntou por que a venda que o canário
       encontra não volta pro Bling sozinha; a resposta era que ninguém tinha feito. Agora: pouca
       falta é reimportada automaticamente (com reconferência antes de criar, pra não duplicar),
       e muita falta vira aviso na tela — porque aí é integração caída e só reautorizar no
       navegador resolve. Esta rota alimenta o aviso do checkout e do dashboard. */
    // ── DEVOLUÇÕES DO ML (14/08) — mesma lib da Girassol, empresa como parâmetro ──────
    // A busca do ML mistura devolução com reclamação e cancelamento; só `returns` conta.
    // SKU/valor vêm do PRÓPRIO pedido no ML (o histórico às vezes guarda o pack, não o order).

    /* 02/09 — O QUE SOBROU EM 'outros': depois de classificar 4 categorias novas, a AMB ainda
       tem -R$ 450 e a Girassol R$ 4.286 nesse balde. Como o valor da AMB é NEGATIVO, é crédito
       que o ML devolveu e o dashboard não mostra — dinheiro faltando a favor do dono. Esta rota
       lista as descrições que não casaram com nenhuma regra, agrupadas, pra fechar de vez em
       vez de adivinhar. Só lê o cache; não chama a API nem grava nada. */
    /* 02/09 — FATURA DO CARTÃO do ML, pelo ciclo do ML (13→12), com composição. Vem do campo
       debited_from_operation que a coleta passou a gravar; sem re-sincronizar, os registros
       antigos não têm a marca e aparecem em sem_marca. Só lê o cache. */

    /* 30/09 — RAIO-X DA FATURA DO CARTÃO. O painel da AMB mostrou R$ 6.455,32 num ciclo em
       que o cartão debitou R$ 5.928,23, com o dado FRESCO — então não é atraso. Duas
       categorias batiam byte a byte com a fatura oficial, o que aponta CLASSIFICAÇÃO, não
       coleta.
       Esta rota não corrige nada: abre o ciclo linha a linha com a marca que o ML mandou em
       cada tarifa, pra comparar com o relatório de Faturamento. Achar por dedução foi o que
       já custou caro aqui. Só leitura, e só admin. */

    // 02/08 - VENDAS DIRETO DO MERCADO LIVRE (o marketplace e a fonte; o Bling e espelho).
    // Decisao do Diego: se a venda ocorreu no dia, tem que aparecer no dia — mesmo que o ML ainda
    // nao tenha organizado o envio e o Bling nem saiba dela (envio agendado, Fulfillment, etc).
    // ESTE E O PASSO 1: so LE do ML e compara com o que temos. Nao muda nada em producao.

    // 01/08 — varredura de cancelados: apaga do histórico quem foi cancelado no Bling
    /* 27/08 — CLASSIFICADOR das vendas 'faltando' do /ml-vendas-faltando: consulta o status REAL
       de cada uma na API do ML. Motivo: o billing pode lançar o ESTORNO da comissão noutra
       categoria, então venda CANCELADA fica no mapa com comissão cheia — indistinguível de venda
       perdida sem olhar o status. Separa: cancelada (ok, o histórico exclui de propósito) ×
       carrinho que o billing não mapeou (ok, está no nosso pelo número do pack) × PAGA-E-AUSENTE
       (o buraco real a importar). Máx 250 por chamada (~1min) — rode em fatias se precisar. */
    // disparo manual: ?meses=2026-07,2026-08  (ou ?meses=todos p/ o ano inteiro)

    // STATUS NO MARKETPLACE: pergunta ao ML/Shopee se o pedido foi CANCELADO pelo cliente.
    // O Bling demora (ou não) pra refletir isso; o dashboard precisa mostrar cinza na hora.
    // Uso: /amb-checkout-offline/status-mkt?de=YYYY-MM-DD&ate=YYYY-MM-DD

    // COMPLETAR DETALHES do período que o dashboard está mostrando (SKU/qtd/taxas dos ainda não bipados).
    // Uso: /amb-checkout-offline/completar-detalhes?de=YYYY-MM-DD&ate=YYYY-MM-DD
    // Processa um lote curto e devolve quantos faltam — o dashboard chama em sequência até zerar.

    // STATUS do backfill em andamento. Uso: /amb-checkout-offline/backfill-status
    /* 11/11 (4e): o plano em fatias (peça única) — chave de admin na própria rota */
    if (method === 'GET' && p === '/amb-checkout-offline/backfill-status') {

    // TESTE de conexão com o Supabase (histórico) — grava e apaga 1 registro. Confirma antes do backfill.
    // Uso: /amb-checkout-offline/backfill-teste

    // ADMIN (sessão ou ?k=): sincronizador de custos em background. ?status=1 mostra progresso.

    // ─── REAPLICAR CUSTO NO HISTÓRICO (19/08) ───────────────────────────────────
    // ?de=&ate= obrigatórios · &simular=1 mostra o que MUDARIA sem gravar (recomendado antes)
    // ?status=1 acompanha. Só admin.
    /* ═══ 21/08 — CUSTOS MANUAIS: tela + gravação (pedido do Diego) ═══════════════════════
    GET  /amb-checkout-offline/custos-manuais        → tela (colar do Excel ou subir CSV)
    POST /amb-checkout-offline/custos-manuais        → grava {texto} ou {itens}
    GET  /amb-checkout-offline/custos-manuais?lista=1 → o que está gravado hoje
    A regra é a que ele definiu: o manual só vale onde o BLING não tem custo. */
    /* ═══ 21/08 — ROTA DA LINHA DO TEMPO DO CUSTO (o card consome) ═══════════════════════
    GET  /amb-checkout-offline/custo-historico?sku=          → faixas do SKU + custo atual do Bling
    POST /amb-checkout-offline/custo-historico  {sku,custo,de}  → lança faixa manual (de = AAAA-MM-DD)
    POST /amb-checkout-offline/custo-historico  {sku,apagar:'AAAA-MM-DD'} → remove a faixa que começa nessa data
    Nasceu do desenho do Diego: "ter esse histórico fácil no card, e poder alterar manualmente,
    ou pedir importação do bling". */

    /* ═══ 21/08 — DE-PARA MANUAL: rota (o card consome) ═══════════════════════════════════
    GET  /amb-checkout-offline/sku-depara-manual            → lista os pares declarados
    GET  /amb-checkout-offline/sku-depara-manual?sugerir=464 → candidatos no catálogo (só sugestão)
    POST /amb-checkout-offline/sku-depara-manual {de,para}   → declara o par
    POST /amb-checkout-offline/sku-depara-manual {apagar}    → remove
    Pro caso do "464"/"465", que não têm produto_id e o Bling não consegue ligar sozinho. */
    /* 13/09 — fatia 8 da desduplicação: a rota do de-para de SKU (129 linhas) era igual nas
       duas empresas, mudando só o prefixo. Foi pra lib/checkout/rota-depara-sku.js, que
       guarda as travas aprendidas em revisão — apagar remove TODAS as variantes de grafia,
       e declarar um par recusa ciclo. Duas cópias dessas regras eram duas chances de uma
       divergir da outra. */

    // NÍVEL de desconto do frete Magalu (config do ⚙️). GET lê, POST salva.
    // Valida por SESSÃO admin (igual config-fiscal) — chamada pelo dashboard.

    // SONDA de dimensões de um produto — pra ver os nomes EXATOS dos campos (largura/altura/
    // profundidade/peso) que o cálculo de frete Magalu vai usar.
    // REMOVIDA por segurança após cumprir o diagnóstico (usava ?k= na query e expunha o
    // produto cru). As dimensões vêm de blingGet('/produtos/{id}').dimensoes, já confirmado.

    // salva a localização de um SKU no Bling (PATCH /produtos/{id}) + atualiza o cache + registra quem editou

    // auditoria: log de edições de localização (quem mudou o quê e quando). uso: /localizacoes-log

    // busca um produto por SKU ou EAN (telinha de consulta/edição de localização do estoquista)

    // ─── indexar catálogo inteiro (1x; deixa todo EAN achável na hora) — só admin ───

    // LISTA DE SEPARAÇÃO — agregado de itens a separar (do cache). ?mkt=ml|shopee|... ou vazio = todos

    // HISTÓRICO — últimos pedidos finalizados (do conferidos.json), mais recentes primeiro
    // 11/08: a rota /historico INLINE foi REMOVIDA daqui.
    //   Ela era a herança do checkout (só os pedidos bipados) e, por vir ANTES da
    //   delegação, SOMBREAVA a do módulo amb-historico.js — que devolve `vendas_bling`
    //   (o _vendas_dia.json inteiro: vendas do Bling + as provisórias direto do
    //   marketplace) e traz o bugfix d45 da hora da NF. Sem isso o dashboard só
    //   enxergava, no Hoje/Ontem, o que o estoquista tinha bipado: 4 pedidos onde o
    //   marketplace tinha 50. Agora a rota do módulo assume.

    // RESERVA um pedido p/ um operador (presença entre PCs — quadradinho colorido tipo Bling)

    // LIBERA a reserva (ao voltar pra lista / finalizar)

    // marca pedido como conferido offline (entra na fila p/ sync na Fase 3)

    // FASE 3 — força o sync da fila de conferidos → VERIFICADO (24). Botão "Sincronizar" / manual.

    // BUSCAR PEDIDO por número (ou ID) em QUALQUER status — ao vivo no Bling.
    // Pra achar a NF de um pedido que não passou pelo Checkout Offline.
    // DEBUG: mostra a resposta crua do Bling pra entender como buscar pedido (filtro funciona? 116856 é numero ou numeroLoja?)
    // DEBUG 2: testa buscar NF por número e contato por nome (pra saber quais buscas a API permite)

    // DEBUG: acha pedidos no cache que parecem KIT/composição (p/ inspecionar a estrutura)

    // ─── HISTÓRICO E ANÁLISE (módulo historico.js). Conferido: nenhum prefixo declarado
    //     acima (/pedido/, /etiqueta/, /imprimir/ …) casa com estas rotas, então delegar
    //     aqui no fim não muda a ordem de casamento.

    // ─── PESCARIA de tarifas retroativas (módulo pescaria.js)

    // ─── CANÁRIO das integrações (módulo canario.js)

    // ─── PODA do bucket de expedição (módulo limpeza.js)

    // ─── ROTINA NOTURNA (módulo noturna.js): /noturna-status e /rodar-noturna
    if (_noturna.rotas(req, res, urlObj)) return true;

    // ─── SHOPEE API oficial (módulo gbo-shopee.js): /shopee/conectar, /callback, /status, /sonda

    // ─── VARREDURA dos fornecedores (só leitura) ──────────────────────────────
    // Codex #588: só o DISPARO fica aqui (vai ao Bling, cópia mantida); o `-status` é da fábrica.

    // ─── SONDA GENÉRICA DO BLING (06/08) — perguntar pra API em vez de supor ──
    // Eu disse "a API do Bling devolve só o fornecedor padrão". Isso foi uma
    // conclusão minha a partir do /produtos/{id}, NÃO uma leitura da documentação —
    // e o Diego cobrou, com razão. O Bling tem um módulo de Produtos-Fornecedores
    // que provavelmente tem endpoint próprio. Em vez de eu chutar o caminho, esta
    // rota deixa PERGUNTAR pra própria API, sem precisar de deploy a cada tentativa.
    // Só GET, só admin, e o caminho tem que começar com / (nada de passagem livre).
    // Uso: /amb-checkout-offline/bling-cru?caminho=/produtos/fornecedores&q=idProduto=16433181895

    // ─── 06/08: SONDA DO PRODUTO NO BLING (só leitura) ────────────────────────
    // Nasceu do 50-AE-8F-180mm-KIT45: o fornecedor KaQi daquele SKU aponta pro
    // código de OUTRO produto (50-lisa-225mm-KIT29, custo 37,26) dentro de um kit
    // de 180mm. Hoje não estraga porque o padrão é outro fornecedor — mas se virar
    // padrão, o custo do kit passa a ser o de um produto diferente, e isso vai
    // direto pro histórico sem ninguém ver.
    // Antes de varrer o catálogo inteiro eu preciso saber se a API do Bling
    // devolve os fornecedores no detalhe do produto. Esta rota mostra o CRU.
    // Uso: /amb-checkout-offline/produto-cru?id=16433181895&k=ADMIN_KEY

    /* ⚠️ 02/10 — A MONTAGEM FICA NO FIM DO HANDLER, DE PROPÓSITO. Ela estava no começo (linha
       ~960) e eu tentei passar peças que a AMB declara nas linhas 2230 e 5587 — MESMA FUNÇÃO,
       declaradas DEPOIS. Resultado no teste: "Cannot access 'FOTO_V' before initialization", e
       DUAS ROTAS da empresa que mais fatura pararam de responder. `node --check` não pega isso.
       Tentei resolver passando getter: errado também, porque a fábrica usa a maioria como VALOR
       (`FOTO_V`, `_mlb`) e chama outras direto (`supaReq(url)`) — getter devolveria a função em
       vez do resultado. A correção certa é montar AQUI, depois de tudo declarado.
       Efeito colateral bom: as rotas próprias da AMB são consultadas ANTES, então a dela vence
       por posição, não só por `rotasProprias`.

       02/10 — A AMB PASSA A USAR A FÁBRICA, mas SEM PERDER NADA: todas as rotas que ela já tem
       entram em `rotasProprias`, então a dela sempre vence. O que a fábrica acrescenta aqui e
       hoje são os SCRIPTS compartilhados do painel (plano de compra, ferramentas de custo) —
       as mesmas peças que a GOOD já usa.
       ⚠️ Nada de apagar cópia neste PR: ligar primeiro, provar que a rota da fábrica responde
       igual, e só então remover a duplicata. Apagar antes de provar é como eu quebraria a
       empresa que mais fatura. */
        console.error('[AMB] falha ao montar as rotas compartilhadas:', e.message);

    /* 31/10 — DIAGNÓSTICO (peça única) por ÚLTIMO, pra não mudar a ordem de casamento das rotas que já existiam: as de
       raio-X que a AMB já tinha neste arquivo continuam valendo; daqui vêm as que faltavam */

```

## GOOD Import — `good-checkout-offline/index.js`

```js
    // ── IR PRO PEDIDO NA SHOPEE (b12) ────────────────────────────────────
    // O link ↗ dos cards apontava pra URL de BUSCA do Seller Center
    // (?searchKeyword=<order_sn>), que NÃO filtra nada: cai na lista inteira.
    // A URL que abre o pedido é /portal/sale/order/<id_interno_numerico>, e esse
    // id é snowflake — não sai do order_sn nem de nenhuma API oficial da Shopee.
    // Único lugar que faz o de-para é o endpoint que a caixa de busca do próprio
    // Seller Center usa. Ele responde a um GET simples, só exigindo o cookie de
    // sessão (env GOODBKP_SHOPEE_COOKIE), mesmo padrão do BLING_COOKIE.
    // O id de um pedido nunca muda, então guardamos em _shopee-ids.json: resolveu
    // uma vez, nunca mais consulta — e os links já resolvidos seguem funcionando
    // mesmo depois que o cookie vencer.
    // Falhou por qualquer motivo? Redireciona pra URL de busca (o comportamento
    // de hoje). Nunca fica pior do que já era. Com &diag=1 devolve o passo a passo.
    /* 30/08 — BACKFILL DE VENDAS DA GOOD: é o que falta pra ela ter dashboard de margem.
       Reusa a função da Girassol (já testada em produção há meses) injetando o CONTEXTO da
       GOOD: o blingGet dela (token próprio), o cache dela e o supaReq dela. Sem o ctx, a
       função lia os pedidos da GIRASSOL e gravava rotulados como GOOD — o parâmetro empresa
       só mandava no rótulo. Nada aqui reimplementa o backfill. */
    /* 01/09 — CAÇA DUPLICATA: agosto da AMB fecha R$ 259 mil no Bling contra R$ 208 mil no
       Jodda e R$ 207 mil no nosso dashboard. Os dois independentes concordam, então a sobra
       está no Bling — provavelmente venda importada duas vezes. Esta rota procura, do sinal
       mais forte pro mais fraco: mesmo número de venda do marketplace (duplicata quase
       certa), mesmo cliente+valor+data, e mesmo cliente+valor em até 2 dias. */
    /* 04/09 — NFs TRAVADAS: o ML recusa por erro que só mão humana resolve (CEP que o Bling
       importou errado, documento inválido). A F3 parou de retransmitir; aqui o checkout
       mostra quais precisam de intervenção, com o que fazer em cada uma. */
    /* 02/10 — AS ROTAS COMPARTILHADAS, da fábrica (#568). O dono quer a GOOD igual à AMB e à
       Girassol, e o alvo é "embarcar novos CNPJs com o menos de dor possível": estas rotas
       eram IDÊNTICAS entre AMB e Girassol, então vêm de UM código só, com a empresa como
       parâmetro — em vez da terceira cópia.
       Entra ANTES das rotas próprias e devolve `true` quando tratou; `false` deixa seguir.
       As peças que a GOOD ainda não tem (`vendasSync`, `responderCusto`, o custo diário) não
       são fingidas: a rota recusa explicando, e passa a funcionar no dia em que existirem. */
    /* 02/10 — monta na PRIMEIRA chamada, não no topo nem no `bootstrap`. ⚠️ Descobri os dois
       no caminho: as peças são declaradas DEPOIS deste ponto no arquivo (o `custoSyncTravado`
       está ~2.800 linhas abaixo), então montar no topo passaria `undefined`; e o `bootstrap`
       desta pasta NÃO É CHAMADO por ninguém — não está no `module.exports`, é código morto, e
       a montagem lá dentro nunca aconteceria. O boot real provou: a linha de log não saiu.
       Aqui, na primeira requisição, tudo já existe. */
        console.error('[GOOD] falha ao montar as rotas compartilhadas:', e.message);
    /* 27/10: /pescar-tarifas, /pescar-tarifas-status e /auditoria-ml (só admin) — a pescaria retroativa de tarifas do ML
       da peça única (lib/checkout/pescaria-empresa; a GOOD não tinha). Criada na 1ª chamada: o pescarDadosML nasce mais
       abaixo neste arquivo. Supabase e histórico com a chave da GOOD. */
      supaCfg: (e) => require('../lib/supabase').cfg(e), supaReq: (e, m, pq, b) => require('../lib/supabase').para('good').req(e, m, pq, b), pescarDadosML });
    /* 27/10: /shopee/* — o módulo da Shopee da peça única (status, resumo, devoluções, carteira, Ads, conciliação, tarifa por SKU) */
    /* 27/10: /noturna-status e /rodar-noturna (só admin) — a madrugada única */
    /* 26/10: /saude-integracoes (só admin) — o canário das integrações da peça única */

    /* 31/10 — as ROTAS COMUNS (as que as três empresas tinham escritas iguais aqui: arquivos, DANFE, etiqueta, XML,
       impressão, login, operadores, QZ, reenvio de documentos, faturamento do ML, cookies da Shopee, separação) viraram
       a peça única lib/checkout/rotas-comuns, chamada no lugar da primeira delas */

    if (method === 'GET' && p === '/good-checkout-offline/backfill-status') {

    /* 01/10 — DISPARA O ANO TODO, mês a mês, sozinho. Paridade com a AMB e a Girassol, que
       têm isto desde agosto. Uso: ...backfill-ano?ate=07  (default: até o mês passado) */
    /* 15/10 — o plano do backfill da GOOD, como o da Girassol: ?acao=status (padrão) | parar | retentar */
    /* 23/10: rotas do canário da peça única — /canario-estado (aviso do painel, só admin) e /canario-marketplaces */

    /* 11/11 (4e): a rota do plano em fatias é a da peça única — a GOOD ganha o `acao=criar` (período livre) */

    /* BACKFILL DO ANO — 15/11 (rotas-cópia): a rota é a da peça (lib/checkout/backfill-plano-empresa.rotaAno), a mesma das três —
       nasceu desta (o plano em disco da GOOD, 15/10) */

       cards, isso tem q ser iguais nelas".
       Medi antes de copiar: das 18 que eu achava que faltavam, 5 já respondiam pelas libs
       comuns que a GOOD monta — sobraram 11 de verdade. Estas quatro são as que dependem só
       de lib multiempresa (ml-fatura-cartao, tiktok-custo-devolucoes, magalu-cancelados), e
       por isso entram sem arrastar nada da AMB junto.
       As outras sete dependem de peças que só existem no arquivo da AMB e vêm em seguida,
       uma leva por vez — não num PR só. */

    if ((method === 'GET' || method === 'POST') && p === '/good-checkout-offline/backfill-vendas') {

    // SAÚDE DA SESSÃO SHOPEE (b13) — admin. Diz se o cookie está vivo, de onde ele
    // veio (env ou renovado sozinho) e quando foi atualizado pela última vez.
    /* 27/08 (pedido de 13/08) — RECEBE OS COOKIES DA EXTENSÃO: mata o DevTools. A extensão do
       navegador captura os cookies da sessão LOGADA do Seller Center e manda pra cá; grava no
       _shopee-sessao.json com a SEMENTE da env preservada (assim o cookie novo prevalece sem a
       env 'mandar' de volta — a semente só dispara quando a PRÓPRIA env muda) e testa a sessão
       na hora com o keep-alive, devolvendo se ficou viva. A env do Render vira só a semente de
       emergência. */

    // ADMIN: ANEXAR ETIQUETA PDF na mão. Existe pro caso real em que o Bling fica SEM logística
    // no pedido (importou depois do envio já organizado no canal, ou a NF travou a edição) e a
    // etiqueta não vem nem pelo Bling nem pela API do canal. O admin baixa a etiqueta no painel do
    // marketplace, anexa aqui, e o pedido volta a ser processável pelo estoquista — que NÃO precisa
    // (nem deve) ter acesso ao seller center. Body: { id, pdf_base64 }.
    // ── 09/08: ANEXAR A NOTA FISCAL (PDF ou XML) ────────────────────────────────
    // Irmã da etiqueta-anexar, pro caso oposto: o pedido tem etiqueta mas está SEM NF
    // no cache (nota emitida fora do Bling, ou o Bling ainda não devolveu o PDF).
    //  • PDF  → vira o `danfe.pdf` da pasta do pedido. Como o `tem_danfe` é medido pela
    //           EXISTÊNCIA do arquivo (ciclo.js:340), ele passa a valer sozinho, e a rota
    //           /danfe/{id} serve o arquivo anexado em vez de tentar baixar do Bling.
    //  • XML  → guarda como `nf.xml` E lê de dentro dele o número, a chave e a data de
    //           emissão, preenchendo o pedido. É o que destrava a conferência e o 🧾 hh:mm.
    //  • ZIP  → olha as entradas e pega o que achar (PDF tem prioridade sobre XML).

    // ─── ETIQUETAS EM MASSA (11/08, b17) — o lote da Shopee de uma vez só ─────────────────
    // Caso real que motivou: o token Bling↔Shopee venceu (365d, sem alerta), 31 pedidos do dia
    // ficaram sem etiqueta no checkout, e o Diego baixou o ZPL agregado direto da Shopee. As
    // etiquetas são 100% raster (imagem GRF, sem ^FD nem barcode ZPL) — a identificação vem
    // dos códigos DENTRO da imagem (chave da NF-e no CODE128 da DANFE + tracking BR no QR),
    // decodificados FORA daqui. Esta rota recebe o resultado já identificado:
    //   POST { etiquetas: [{ nf: 77412, tracking: 'BR26…', zpl_base64: '…' }] }
    // e casa cada uma pelo nf_numero do manifesto. Grava IDÊNTICO ao anexo individual
    // (grava-primeiro, carimbos no manifesto + snapshot, ev1 pro Devoluções).
    /* 30/10 — as ROTAS DE LOTE (etiquetas em massa, a página de envio e as DANFEs em lote) viraram a peça única
       lib/checkout/rotas-lote (eram só daqui; a AMB e a Girassol ganham no passo seguinte) */

    // ADMIN (?k=): BACKFILL DE VALORES — busca no Bling o total dos pedidos JÁ FINALIZADOS
    // que não têm valor gravado (finalizados antes da atualização do faturamento) e preenche
    // retroativamente. Uso: /good-checkout-offline/backfill-valores?k=ADMIN_KEY&dias=31
    // Roda em background (~400ms por pedido, respeitando o rate limit). Chame de novo p/ ver o progresso.

    // ADMIN (?k=): BACKFILL DE DETALHES — preenche UF + valor POR ITEM dos já finalizados
    // Uso: /good-checkout-offline/backfill-detalhes?k=ADMIN_KEY&dias=31

    // DASHBOARD (sessão admin): saldo/preço/custo por SKU, cache 6h em disco — alimenta a projeção de estoque
    /* 07/11 (rotas comuns, passo 9a): /sku-info NIVELADO — a UNIÃO das duas versões, igual nas três: da Girassol/AMB, o NOME
       do produto (no cache e na resposta), a trava do KIT (custo de fornecedor não é custo de kit) e a proteção do custo
       conhecido no fim (b20); da GOOD, a busca que falha cai no custo do banco (Codex #186) MAS cadastro todo EXCLUÍDO não
       recupera custo velho (Codex #497 P1) — e isso agora vale também na proteção do fim. */

    // DASHBOARD — a TELA ÚNICA (a mesma da Girassol e da AMB, pelo gerador lib/checkout/painel/empresas.js)

    // ADMIN (?k=): BACKFILL-NF — 100% LOCAL (lê nf-simp.json do cache/arquivo; ZERO chamadas ao Bling).
    // Preenche vprod_nf (Σ itens da NOTA) nos finalizados → produtos EXATO + frete EXATO (valor − vprod_nf), retroativo.
    // Uso: /good-checkout-offline/backfill-nf?k=ADMIN_KEY&dias=45   (roda em segundos)

    // DASHBOARD (sessão admin): CONFIG FISCAL — alíquota do Simples POR MÊS + taxa % por canal

    // ADMIN (?k=): PESCA de tarifas/frete REAIS do ML agora (também roda sozinha todo dia às 04:40)
    // Uso: /good-checkout-offline/ml-sync-fees?k=ADMIN_KEY&dias=31 — chame de novo p/ ver o progresso

    // ADMIN (sessão ou ?k=): sincronizador de custos em background. ?status=1 mostra progresso.
    /* ═══ 21/08 — CUSTOS MANUAIS: tela + gravação (pedido do Diego) ═══════════════════════
    GET  /good-checkout-offline/custos-manuais        → tela (colar do Excel ou subir CSV)
    POST /good-checkout-offline/custos-manuais        → grava {texto} ou {itens}
    GET  /good-checkout-offline/custos-manuais?lista=1 → o que está gravado hoje
    A regra é a que ele definiu: o manual só vale onde o BLING não tem custo. */
    /* ═══ 21/08 — ROTA DA LINHA DO TEMPO DO CUSTO (o card consome) ═══════════════════════
    GET  /good-checkout-offline/custo-historico?sku=          → faixas do SKU + custo atual do Bling
    POST /good-checkout-offline/custo-historico  {sku,custo,de}  → lança faixa manual (de = AAAA-MM-DD)
    POST /good-checkout-offline/custo-historico  {sku,apagar:'AAAA-MM-DD'} → remove a faixa que começa nessa data
    Nasceu do desenho do Diego: "ter esse histórico fácil no card, e poder alterar manualmente,
    ou pedir importação do bling". */

    /* ═══ 21/08 — DE-PARA MANUAL: rota (o card consome) ═══════════════════════════════════
    GET  /good-checkout-offline/sku-depara-manual            → lista os pares declarados
    GET  /good-checkout-offline/sku-depara-manual?sugerir=464 → candidatos no catálogo (só sugestão)
    POST /good-checkout-offline/sku-depara-manual {de,para}   → declara o par
    POST /good-checkout-offline/sku-depara-manual {apagar}    → remove
    Pro caso do "464"/"465", que não têm produto_id e o Bling não consegue ligar sozinho. */
    /* 10/11 (plano, Fase 3 4d): o de-para manual era CÓPIA (linha a linha) da peça comum lib/checkout/rota-depara-sku.js, que
       a Girassol e a AMB já usam — agora a GOOD também (as travas do apagar todas as grafias e do ciclo ficam num lugar só). */

    /* ═══ 21/08 — DE-PARA AUTOMÁTICO DE SKU RENOMEADO ═══════════════════════════════════════
    Nasceu do FL-1011-PRETO: renomeado no Bling para 3933398010054, o código antigo deixou de
    existir e as 53 vendas antigas ficaram sem custo. O Diego resolveu à mão pela planilha, mas
    isso vai acontecer de novo a cada rename.
    COMO DESCOBRE: o Bling troca o CÓDIGO e mantém o `id` do produto. O cache de custos guarda
    `{ id, custo }` por SKU — inclusive dos que já foram renomeados. Então: id do SKU velho no
    cache × código que esse mesmo id tem HOJE no catálogo = o par antigo→novo. Funciona
    retroativamente, não só pra renames futuros.
    NÃO altera nada sozinho: devolve os pares e o Diego decide (o `sku-repara`, que já existe,
    é quem troca no histórico). */

    // salva a localização de um SKU no Bling (PATCH /produtos/{id}) + atualiza o cache + registra quem editou

    // auditoria: log de edições de localização (quem mudou o quê e quando). uso: /localizacoes-log

    // busca um produto por SKU ou EAN (telinha de consulta/edição de localização do estoquista)

    // ─── indexar catálogo inteiro (1x; deixa todo EAN achável na hora) — só admin ───

    // LISTA DE SEPARAÇÃO — agregado de itens a separar (do cache). ?mkt=ml|shopee|... ou vazio = todos

    /* Codex #695 r3: o /historico daqui (sem custo, sem cancelado, sem trava de sessão) saiu — ele
       casava ANTES da delegação `hist` e escondia a rota compartilhada, que entrega o custo pronto
       por item, o cancelado e a camada do estoquista. */

    // RESERVA um pedido p/ um operador (presença entre PCs — quadradinho colorido tipo Bling)

    // LIBERA a reserva (ao voltar pra lista / finalizar)

    // marca pedido como conferido offline (entra na fila p/ sync na Fase 3)

    // FASE 3 — força o sync da fila de conferidos → VERIFICADO (24). Botão "Sincronizar" / manual.

// ── DIAGNÓSTICO DE ETIQUETA (14/08) ────────────────────────────────────────────
    // Caso real: pedido da AMAZON (Bling 26599886380, NF 077663) ficou "sem etiqueta" no
    // checkout, mas a etiqueta EXISTE e o Diego conseguiu baixá-la pelo Bling. O ciclo já
    // trata Amazon (link ZPL vem nulo → tenta o PDF), e reprocessa todo pedido sem etiqueta
    // a cada rodada — então a suspeita é que a API `/logisticas/etiquetas` não devolve o
    // link, mesmo a tela do Bling imprimindo. Esta rota mostra a RESPOSTA CRUA da API nos
    // dois formatos, pra decidir com dado em vez de suposição. Só leitura.
    // Uso: GET /good-checkout-offline/etiqueta-diag?id=<idBling>&k=ADMIN_KEY

    // BUSCAR PEDIDO por número (ou ID) em QUALQUER status — ao vivo no Bling.
    // Pra achar a NF de um pedido que não passou pelo Checkout Offline.
    // DEBUG: mostra a resposta crua do Bling pra entender como buscar pedido (filtro funciona? 116856 é numero ou numeroLoja?)
    // DEBUG 2: testa buscar NF por número e contato por nome (pra saber quais buscas a API permite)

    // DEBUG: acha pedidos no cache que parecem KIT/composição (p/ inspecionar a estrutura)

    /* 14/09 — histórico da GOOD. A delegação fica no FIM, logo antes do return false, na
       mesma posição que a Girassol usa: nenhuma rota declarada antes (/pedido/, /etiqueta/,
       /imprimir/…) casa com as seis do histórico, então a ordem de casamento não muda. */

    /* 31/10 — DIAGNÓSTICO (peça única) por ÚLTIMO, pra não mudar a ordem de casamento das rotas que já existiam: as de
       raio-X que a GOOD já tinha neste arquivo continuam valendo; daqui vêm as que faltavam */

```
