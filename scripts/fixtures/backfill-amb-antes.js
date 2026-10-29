'use strict';
/* FIXTURE (29/10/2026): o backfillVendas da AMB (amb-checkout-offline/index.js) ANTES de a AMB passar a usar o backfill
   compartilhado (passo 3b-2) — o mesmo texto, numa fábrica com as variáveis de fora como parâmetros, pra o teste rodar o
   antigo e o novo nos mesmos dados. Não é usado em produção. Os require('../…') do original viraram '../../…' (a fixture
   mora em scripts/fixtures, um nível abaixo). */
module.exports = function criarAntigo(dep) {
  const { fs, path, fetch, CACHE_DIR, readJson, DEFAULT_ALIQ_BK, blingGet, supaReq, servicoDoPedido, magaluLinhas, magaluFreteSkuLer,
    garantirSitCancel, escrowEmLote, escrowDoPedido, ehFlex, custoVigenteEm, contasDoEscrow, _mlBilling, _mapasBilling, _inferCanal,
    _feeMLLeve, LOJA_MKT, SHOPEE_TODOS } = dep;
  const _canario = dep._canario || { rodando: false };
  let _reparoAtivo = false;
  let _sitCancel = dep._sitCancel || { ids: [] };
  let _backfill = { rodando:false, empresa:null, de:null, ate:null, pagina:0, pedidos:0, itens:0, gravados:0, erros:0, fase:'parado', inicio:null, fim:null, msg:'' };
async function backfillVendas(de, ate, empresa){
  /* O guarda mora AQUI, não em cada rota: a noturna e o /backfill-ano chamam esta função direto.
     Mesmo lugar da trava do canário logo abaixo, pelo mesmo motivo. */
  if (_reparoAtivo) {
    console.log('[BACKFILL] adiado: reparo de SKU em andamento (mexe nas mesmas linhas)');
    return Object.assign({}, _backfill, { adiado: 'reparo de SKU em andamento' });
  }
  // Codex (#119): a trava só impedia o CANÁRIO quando havia backfill rodando. Se o canário
  // começa primeiro e alguém dispara backfill — ou a noturna chama esta função direto —, os
  // dois consultam o Bling juntos e o 429 volta. Exclusão nos DOIS sentidos.
  if (typeof _canario !== 'undefined' && _canario && _canario.rodando) {
    console.log('[BACKFILL] adiado: o canário está conferindo o Bling (desde ' + _canario.desde + ')');
    return { ok: false, msg: 'canário conferindo o Bling agora — backfill adiado' };
  }
  if(_backfill.rodando) return;
  let _arqEstoqueAtual = null;   /* 03/09: caminho do temporário, visível na limpeza do fim */
  let _spoolFalhou = null;       /* Codex #325: falha de gravação do temporário é fatal */
  const _limparSpool = () => { try { if (_arqEstoqueAtual) fs.unlinkSync(_arqEstoqueAtual); } catch (e) {} };
  _backfill = { rodando:true, empresa, de, ate, pagina:0, pedidos:0, itens:0, gravados:0, erros:0, fase:'preparando', inicio:new Date().toISOString(), fim:null, msg:'' };
  /* 23/10: o banco tem a TROCA SEGURA (tabela de rascunho + função)? Pergunta ANTES de gastar o Bling — o ano da GOOD
     queimou 5 fatias de cota e parou no fim de cada uma por falta do script no Supabase dela. Não preparado é conclusivo:
     aborta já, com a mesma mensagem, e o plano (lib/backfill-fatiado) pausa sozinho. "Não sei" (rede/5xx) segue. */
  try {
    const _pp = await require('../../lib/checkout/troca-periodo-historico').bancoPreparado({ empresa: (empresa || 'amb'), supaReq: supaReq });
    if (_pp && _pp.nao_preparado) {
      _backfill.fase = 'abortado'; _backfill.erros++; _backfill.msg = _pp.msg;
      _backfill.rodando = false; _backfill.fim = new Date().toISOString();
      console.log('[BACKFILL] ' + _pp.msg);
      return Object.assign({}, _backfill, { desfecho: 'abortado', ok: false, transitorio: false, nao_preparado: true });
    }
  } catch (e) { /* não sei: segue — a troca no fim confere de novo */ }
  try { await garantirSitCancel(async p2 => await blingGet(p2)); } catch (e) {}
  const jaNoBling = new Set();   // 02/08: números de venda que o Bling JÁ trouxe — impede duplicar quando o ML entrar depois   // 01/08: IDs de cancelamento p/ o filtro abaixo
  /* Codex #391 (2ª leitura, P1): tombstone da varredura de cancelados (lib/imposto-cancelados)
     — pedidos que a SHOPEE já cancelou e o Bling, por ser espelho, pode não ter acompanhado.
     Sem consultar isso aqui, o backfill reconstrói o período só pela situação do Bling e traz
     de volta a venda fantasma (faturamento + imposto), inclusive fora da janela de 45 dias
     que a varredura cobre. */
  const canceladosMkt = new Set(Object.keys(readJson(path.join(CACHE_DIR, '_cancelados_shopee.json'), {})));
  const dorme = ms => new Promise(r=>setTimeout(r,ms));
  try {
    const custos = readJson(path.join(CACHE_DIR,'_custos.json'), {});
    const cfg = readJson(path.join(CACHE_DIR,'_config-fiscal.json'), {aliquotas:{}});
    // cascata da comissao: mapa do faturamento oficial (de graca, ja esta no disco) + token do ML
    const { com: comBill, fre: freBill } = await _mapasBilling();
    // 05/08: o token do ML vale ~6h e a rodada do ano leva ~6h — pegar UMA vez no começo
    // fazia o fim da varredura rodar com token vencido e o _feeMLLeve devolver 0 CALADO.
    // Agora renova a cada 2h (o garantirTokenML já cuida do refresh de verdade).
    let tkFee = null, tkFeeEm = 0;
    const tokenFee = async () => {
      if (tkFee && (Date.now() - tkFeeEm) < 2 * 3600 * 1000) return tkFee;
      try { const { garantirTokenML: _gF } = require('../../ambtotal/mlTokenManager'); tkFee = await _gF(); tkFeeEm = Date.now(); }
      catch (e) { console.log('[BACKFILL] token do ML indisponível: ' + e.message); }
      return tkFee;
    };
    await tokenFee();
    _backfill.comissao = { bling: 0, billing: 0, sale_fee: 0, zero: 0, billing_no_mapa: Object.keys(comBill).length, token_ml: tkFee ? 'ok' : 'sem token' };
    _backfill.frete = { bling: 0, billing: 0, escrow: 0, zero: 0, billing_no_mapa: Object.keys(freBill).length };
    // ── TIKTOK (16/08): mesma cascata da Girassol, agora na AMB ────────────────────
    // Medido na Girassol: o Bling informava R$ 18.248 de tarifa no ano e a real é R$ 47.831
    // (R$ 29.583 de custo invisível). A conta do TikTok é R$ 2,00 fixo + 12%, e boa parte do
    // que falta é comissão de afiliado (creators), que nunca chega ao Bling.
    // Arquivo populado por /tiktok/financeiro-coletar?loja=amb (a lib é a mesma).
    // Enquanto a AMB não autorizar o TikTok, o arquivo não existe e nada muda: cai no Bling.
    const _tkArqA = require('path').join(process.env.TIKTOK_CACHE_DIR || '/data', '_tiktok_financeiro_amb.json');
    let _tkPedidosA = {};
    try { _tkPedidosA = (JSON.parse(require('fs').readFileSync(_tkArqA, 'utf8')) || {}).pedidos || {}; } catch (e) { _tkPedidosA = {}; }
    _backfill.tiktok = { pedidos_no_arquivo: Object.keys(_tkPedidosA).length, usados: 0, sem_dado: 0,
      tarifa_que_o_bling_dava: 0, tarifa_somada: 0, frete_liquido_visto: 0 };
    _backfill.shopee = { escrow_fechou: 0, escrow_com_sobra: 0, escrow_sem_resposta: 0, escrow_erro: 0,
                         sem_repasse_por_dia: {},   /* 27/10: os dias com pedido da Shopee SEM repasse — a madrugada refaz (lib/checkout/repasse-pendente) */
                         comissao_somada: 0, comissao_que_o_bling_dava: 0, frete_liquido_visto: 0,
                         modo: SHOPEE_TODOS ? 'todos os pedidos' : 'so quando o Bling nao trouxe taxa' };
    const aliqBk = mes => ((cfg.aliquotas && Number(cfg.aliquotas[mes]) > 0) ? Number(cfg.aliquotas[mes]) : (DEFAULT_ALIQ_BK[mes]!=null?DEFAULT_ALIQ_BK[mes]:14.1));   // 19/08: escapou da minha varredura por ter forma diferente — o backfill das 03:45 gravaria imposto ZERO e margem inflada
    // 10/08 (Codex P1): NADA é apagado antes da coleta terminar. A versão antiga
    // deletava o período aqui e gravava página a página — uma queda do Bling no meio
    // deixava o histórico MEIO VAZIO (e a noturna roda isto sozinha às 03:45).
    // Agora a varredura ACUMULA tudo em memória; o DELETE + gravação só acontecem
    // no final, com a coleta completa em mãos. Falhou no meio? Aborta sem apagar.
    _backfill.fase = 'varrendo';
    let buffer = [];
    /* 03/09: estoque em DISCO, não em memória — ver o comentário no gbo-app.js. A AMB é
       menor, mas cresce (agosto já teve 1.473 pedidos) e o serviço é um só. */
    /* Codex #325: rodada que MORREU (queda do processo) não passa por nenhum return — o
       spool dela fica. Varre e apaga os órfãos antes de começar, pra não acumular no cache. */
    try { for (const f of fs.readdirSync(CACHE_DIR)) if (/^_backfill_estoque_/.test(f)) { try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch (e) {} } } catch (e) {}
    const arqEstoque = _arqEstoqueAtual = path.join(CACHE_DIR, '_backfill_estoque_' + empresa + '_' + de + '.jsonl');
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(arqEstoque, ''); } catch (e) {}
    let coletados = 0;
    const flush = async () => {
      if(!buffer.length) return;
      /* Codex #325: se o append falhar (disco cheio), NÃO pode ser engolido pelo catch de
         marketplace e seguir pro DELETE com o spool incompleto. Marca fatal e aborta. */
      try { fs.appendFileSync(arqEstoque, buffer.map(it => JSON.stringify(it)).join('\n') + '\n'); }
      catch (e) { _spoolFalhou = 'não deu pra gravar o temporário em disco: ' + String(e.message || e).slice(0, 120); throw e; }
      coletados += buffer.length;
      _backfill.coletados = coletados;
      buffer = [];
    };
    /* Codex #325: ler em STREAM, linha a linha — a versão anterior fazia readFileSync do
       arquivo inteiro numa string, então o pico de memória continuava crescendo com o mês, e
       o PR existe justamente pra parar o status 134. Também VALIDA cada linha: uma linha
       truncada (disco cheio, queda no meio do append) é erro declarado, não JSON.parse
       explodindo depois do DELETE. */
    const lerLotes = async function* (tamanho) {
      const rlmod = require('readline');
      const rl = rlmod.createInterface({ input: fs.createReadStream(arqEstoque, { encoding: 'utf8' }), crlfDelay: Infinity });
      let lote = [], n = 0;
      for await (const linha of rl) {
        if (!linha) continue;
        n++;
        let obj;
        try { obj = JSON.parse(linha); } catch (e) { throw new Error('spool corrompido na linha ' + n + ' — nada foi apagado'); }
        lote.push(obj);
        if (lote.length >= tamanho) { yield lote; lote = []; }
      }
      if (lote.length) yield lote;
    };
    /* Codex #325: conferir o spool INTEIRO antes de apagar o período — se uma linha estiver
       truncada, descobrir depois do DELETE deixaria o mês vazio. */
    const validarSpool = async () => {
      let n = 0;
      for await (const lote of lerLotes(500)) n += lote.length;
      return n;
    };
    let foraDoPeriodo = 0;
    for(let pg=1; pg<=500; pg++){
      _backfill.pagina = pg;
      // 03/08 — A RODADA DA MADRUGADA PAROU NA PÁGINA 48 e "concluiu" como se tivesse acabado:
      // uma falha do Bling (429/instabilidade) devolvia lista vazia e o break entendia como fim.
      // Como o DELETE já tinha apagado o período, 5.813 pedidos sumiram do histórico.
      // AGORA: a MESMA página é tentada até 6x com esperas crescentes; se esgotar, a rodada vira
      // ERRO EXPLÍCITO (fase='erro') em vez de fingir sucesso — aí é só rodar de novo.
      let lista = null;
      /* 03/09: mesmo tratamento de rate limit da Girassol (ver comentário lá) */
      let esperas429 = 0;
      for (let tent = 1; tent <= 6; tent++) {
        const r = await blingGet('/pedidos/vendas?dataInicial='+de+'&dataFinal='+ate+'&pagina='+pg+'&limite=100');
        if (r && r.ok) { lista = (r.data && r.data.data) || []; break; }
        /* 23/09 (retomada do #324): só espera 2/4/8 min quando é limite REAL do Bling. Antes
           bastava o status 429, que a função também devolvia pra rede caída — e aí uma queda
           de rede custava ~14 min por página sem ajudar. `limite` vem do blingGet; resposta
           sem o campo (chamador antigo) mantém o comportamento de antes. */
        const ehLimite = r && (r.status === 429) && (r.limite !== false);
        if (ehLimite && esperas429 < 3) {
          esperas429++;
          const esperaL = [120, 240, 480][esperas429 - 1] * 1000;
          _backfill.msg = 'página ' + pg + ': limite do Bling, aguardando ' + (esperaL/60000) + ' min (' + esperas429 + '/3)';
          await dorme(esperaL);
          tent--;
          continue;
        }
        const espera = [5, 10, 20, 40, 60, 60][tent - 1] * 1000;
        console.log('[BACKFILL] página ' + pg + ' falhou (HTTP ' + (r && r.status) + ') — tentativa ' + tent + '/6, aguardando ' + (espera/1000) + 's');
        _backfill.msg = 'página ' + pg + ': tentativa ' + tent + '/6 após HTTP ' + (r && r.status);
        await dorme(espera);
      }
      if (lista === null) {
        _backfill.fase = 'erro';
        _backfill.msg = 'a página ' + pg + ' falhou 6 vezes seguidas — rodada ABORTADA e NADA foi apagado: o histórico antigo do período continua inteiro. Rode de novo mais tarde.';
        console.log('[BACKFILL] ✗ abortado na página ' + pg + ' — histórico do período ficou incompleto, rode de novo');
        _backfill.rodando = false; _backfill.fim = new Date().toISOString();
        _limparSpool(); return;   /* Codex #325 r2: limpa o spool ao esgotar as tentativas */
      }
      if(!lista.length) break;
      // ── b122 (06/08): ESCROW EM LOTE, POR PÁGINA ────────────────────────────────
      // Antes era 1 chamada por pedido de Shopee: no ano dá ~6 mil chamadas e umas 2h a
      // mais na rodada. A LISTAGEM do Bling já traz o numeroLoja, então dá pra pedir o
      // escrow de até 50 de uma vez ANTES do laço e depois só consultar o mapa.
      // Como reconheço a Shopee sem ter o detalhe ainda: o order_sn dela é alfanumérico
      // (260806KAS5H5JM) — ML, TikTok e Magalu são só dígitos, e Amazon tem hífen.
      // Se algum não for Shopee a API não devolve nada e o pedido cai no caminho antigo,
      // de um em um. Nada quebra; no pior caso fica lento como era.
      let escrowPg = {};
      try {
        const snsPg = lista.map(x => String((x && x.numeroLoja) || '').trim())
          .filter(sn => sn && sn.length >= 10 && sn.length <= 20 && /^[0-9A-Za-z]+$/.test(sn) && !/^\d+$/.test(sn));
        for (let i = 0; i < snsPg.length; i += 50) {
          const parte = await escrowEmLote(snsPg.slice(i, i + 50));
          Object.assign(escrowPg, parte || {});
          if (snsPg.length > 50) await dorme(400);
        }
        if (Object.keys(escrowPg).length && _backfill.shopee) {
          _backfill.shopee.pelo_lote = (_backfill.shopee.pelo_lote || 0) + Object.keys(escrowPg).length;
        }
      } catch (e) { console.log('[BACKFILL] escrow em lote falhou nesta página (segue 1-a-1): ' + e.message); }
      for(const p of lista){
        if(!p || p.id==null) continue;
        const dtP = String(p.data||'').slice(0,10);
        // 03/08 — REGISTRA A VENDA AQUI, ANTES de qualquer descarte. O laço pula pedido em 4
        // casos (fora do período, cancelado, sem detalhe, sem itens) e nenhum deles chegava ao
        // jaNoBling. Resultado: pedido CANCELADO no Bling era pulado, o ML ainda o dava como
        // "paid", e a parte do marketplace o trazia de volta — desfazendo a limpeza de cancelados.
        // Agora basta o Bling CONHECER a venda pra que o ML não a acrescente.
        const nl0 = String((p && p.numeroLoja) || '').trim();
        if (nl0) jaNoBling.add(nl0);
        if(dtP && (dtP < de || dtP > ate)){ foraDoPeriodo++; continue; }   // TRAVA: só o período pedido (caso o filtro do Bling falhe)
        // 01/08 — CONSERTADO: o teste antigo era /cancel/i em situacao.valor, mas o Bling manda
        // valor NUMÉRICO (0/1) e não manda nome na listagem — nunca dava true, e cancelado entrava
        // no histórico somando faturamento e lucro. Agora compara com os IDs descobertos no Bling.
        if (_sitCancel.ids.length && _sitCancel.ids.indexOf(Number(p.situacao && p.situacao.id)) >= 0) { _backfill.cancelados = (_backfill.cancelados||0) + 1; continue; }
        // Codex #391 (2ª leitura, P1): o Bling é espelho — se a Shopee já cancelou e o Bling
        // não acompanhou, a checagem acima não pega. O tombstone gravado pela varredura de
        // cancelados (marcarCanceladoMkt) é a segunda checagem, pela fonte da verdade.
        if (nl0 && canceladosMkt.has(nl0)) { _backfill.cancelados = (_backfill.cancelados||0) + 1; continue; }
        _backfill.pedidos++;
        // ── 05/08: RETRY NO DETALHE (o buraco que faltava) ────────────────────────────
        // A LISTAGEM já era tentada 6x desde o b104, mas o DETALHE de cada pedido era uma
        // tentativa só: um 429 ou 504 do Bling e o pedido era PULADO CALADO (erros++ e segue),
        // ficando de fora do histórico numa rodada que termina "concluido". Numa varredura do
        // ano são ~20 mil detalhes a 2,3 req/s durante 6h — dava pra perder dezenas assim.
        // (Foi o que produziu o `erros: 1` da rodada de 10/02.)
        /* 23/09 (retomada do #324 — esta é a parte GRAVE): a listagem ganhou 2/4/8 MINUTOS no
           limite do Bling, mas o detalhe seguia com 3/8/20/40 SEGUNDOS. Se o limite pegasse
           aqui, as 4 tentativas queimavam em ~71s, o pedido virava `sem_detalhe` — e a rodada
           SEGUIA até o DELETE, trocando o histórico antigo por um novo COM BURACOS.
           Agora o limite REAL aqui espera igual à listagem. */
        let det=null;
        let esperas429det = 0;
        for (let td = 1; td <= 4; td++) {
          let _rdet = null;
          try { const rd = await blingGet('/pedidos/vendas/'+p.id); _rdet = rd; det = (rd&&rd.ok&&rd.data&&rd.data.data)||null; } catch(e){}
          if (det) break;
          if (_rdet && _rdet.status === 429 && _rdet.limite !== false && esperas429det < 3) {
            esperas429det++;
            const espL = [120, 240, 480][esperas429det - 1] * 1000;
            console.log('[BACKFILL] detalhe do pedido ' + p.id + ': limite do Bling — aguardando ' + (espL/60000) + ' min');
            _backfill.msg = 'detalhe do pedido ' + p.id + ': limite do Bling, aguardando ' + (espL/60000) + ' min';
            await dorme(espL);
            td--;
            continue;
          }
          const espD = [3, 8, 20, 40][td - 1] * 1000;
          console.log('[BACKFILL] detalhe do pedido ' + p.id + ' falhou — tentativa ' + td + '/4, aguardando ' + (espD/1000) + 's');
          _backfill.msg = 'detalhe do pedido ' + p.id + ': tentativa ' + td + '/4';
          await dorme(espD);
        }
        await dorme(430);   // rate limit do Bling (~2,3 req/s)
        if(!det){
          // Codex #516 (P1): esgotar as 3 esperas longas E AINDA ASSIM continuar 429/limite
          // é o Bling seguindo limitado por mais de ~14 min — não um pedido isolado com
          // problema. Deixar a rodada seguir até o DELETE reproduziria o BURACO que este PR
          // existe pra evitar. Aborta como a listagem já faz: nada é apagado, roda de novo.
          if (esperas429det >= 3) {
            _backfill.fase = 'erro';
            _backfill.msg = 'detalhe do pedido ' + p.id + ': limite do Bling persistente (>14 min) — rodada ABORTADA e NADA foi apagado: o histórico antigo do período continua inteiro. Rode de novo mais tarde.';
            console.log('[BACKFILL] ✗ abortado no detalhe do pedido ' + p.id + ' — limite do Bling persistente, histórico do período ficou incompleto, rode de novo');
            _backfill.rodando = false; _backfill.fim = new Date().toISOString();
            _limparSpool(); return;
          }
          _backfill.erros++;
          if (!_backfill.sem_detalhe) _backfill.sem_detalhe = [];
          if (_backfill.sem_detalhe.length < 30) _backfill.sem_detalhe.push(p.id);   // quais pedidos ficaram de fora
          console.log('[BACKFILL] ✗ pedido ' + p.id + ' ficou SEM DETALHE depois de 4 tentativas — fora do histórico');
          continue;
        }
        const itens = (det.itens||[]).map(i=>({ sku:((i.codigo||(i.produto&&i.produto.codigo)||'')+'').trim()||null, desc:((i.descricao||(i.produto&&i.produto.nome)||'')+'').slice(0,180), qtd:Number(i.quantidade||1), vt: Math.round(Number(i.valor||0)*Number(i.quantidade||1)*100)/100 }));
        if(!itens.length) continue;
        const somaProd = itens.reduce((s,i)=>s+i.vt,0) || 1;
        // 01/08 — pedido com det.total ZERADO no Bling (visto no 100705, Shopee 28/02: a NF existe
        // e vale 29,90, mas o total do PEDIDO veio 0). Como o imposto é % sobre esse total, ele saía
        // zero e o pedido aparecia eternamente como "sem alíquota". Nesses casos usamos a soma dos
        // ITENS, que é o valor real da venda. Re-rodar o backfill não resolvia: relia o mesmo zero.
        let total = Number(det.total)||0;
        if (!(total > 0)) {
          const somaItens = itens.reduce((s2,i2)=>s2+(Number(i2.vt)||0),0);
          if (somaItens > 0) { total = Math.round(somaItens*100)/100;
            console.log('[BACKFILL] pedido '+(det.numero||det.id)+': total do Bling veio 0 — usando a soma dos itens ('+total+')'); }
        }
        let comissao = Number((det.taxas&&det.taxas.taxaComissao)||0);
        let frete = Number((det.taxas&&det.taxas.custoFrete)||0);
        const dataV = (String(det.dataEmissao||det.data||p.data||'').slice(0,10)) || null;
        const imposto = total * aliqBk((dataV||'').slice(0,7))/100;
        const ljId = String((det.loja&&det.loja.id)||(p.loja&&p.loja.id)||'');
        const nl = det.numeroPedidoLoja || p.numeroLoja || null;
        /* 22/10: a AMB nunca vendeu pela OLIST (o dono) — a configuração dela não tem Olist, então o "ORD" no começo do
           número não vira canal Olist aqui (antes herdava a regra e a loja da Girassol) */
        const _olistCfgA = require('../../lib/checkout/config-empresa').configCheckout('amb').olist;
        const ehOlist = !!_olistCfgA && ((_olistCfgA.lojaBling && ljId === _olistCfgA.lojaBling) || /^ORD/i.test(String(nl||'')));
        const canal = ehOlist ? 'olist' : (LOJA_MKT[ljId] || _inferCanal(nl));
        // 17/08 — mesma gravação da Girassol: a UF alimenta o card "Vendas por Estado", que
        // até aqui lia só o cache do checkout (~6 dias) e distorcia Mês/Ano.
        // 17/08 — INSTRUMENTAÇÃO: a UF continua chegando vazia no histórico mesmo com o
        // caminho confirmado pela sonda (det.transporte.etiqueta.uf = "SP"). Em vez de seguir
        // deduzindo, o status passa a mostrar quantos pedidos tiveram UF, quantos não, e o
        // ESQUELETO do transporte do primeiro que falhou — aí o motivo aparece de uma vez.
        if (!_backfill.uf) _backfill.uf = { com: 0, sem: 0, exemplo_sem: null };
        const ufPed = (function(){
          // 17/08 — MEDIDO: `transporte.etiqueta.uf` só existe depois que a etiqueta é gerada,
          // e o backfill varre TODOS os pedidos (inclusive os de hoje, ainda sem etiqueta) —
          // por isso os 26 pedidos do primeiro teste vieram sem estado. O endereço de entrega
          // e o do cliente já estão no mesmo detalhe: servem de reserva, nessa ordem.
          const t = det.transporte || {};
          const cand = (t.etiqueta && t.etiqueta.uf)
            || (t.endereco && t.endereco.uf)
            || (det.contato && det.contato.endereco && (det.contato.endereco.uf || det.contato.endereco.estado))
            || (det.cliente && det.cliente.uf) || '';
          // duas letras não bastam: "Brasil" viraria "BR". Só passa sigla de estado de verdade.
          const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];
          const s = String(cand || '').trim().toUpperCase().slice(0, 2);
          const achou = UFS.indexOf(s) >= 0 ? s : null;
          if (achou) _backfill.uf.com++;
          else {
            _backfill.uf.sem++;
            if (!_backfill.uf.exemplo_sem) {
              _backfill.uf.exemplo_sem = {
                pedido: det.numero || det.id || null,
                tem_transporte: !!det.transporte,
                chaves_transporte: det.transporte ? Object.keys(det.transporte) : null,
                tem_etiqueta: !!(det.transporte && det.transporte.etiqueta),
                chaves_etiqueta: (det.transporte && det.transporte.etiqueta) ? Object.keys(det.transporte.etiqueta) : null,
                valor_bruto: String((t.etiqueta && t.etiqueta.uf) || '') || null
              };
            }
          }
          return achou;
        })();
        // ── CASCATA (04/08): billing → sale_fee → o zero do Bling ──────────────────────
        let comFonte = (comissao > 0) ? 'bling' : 'zero';
        let freteShopee = null;
        /* 04/09 — BILLING ANTES DO BLING (decisão do dono). Até aqui o billing só entrava
           quando a comissão estava zerada, então em abril/2026, com o Bling tendo trazido
           1.909 comissões, só 3 pedidos usaram o valor real: o resto ficou na ESTIMATIVA.
           O billing é o que o ML COBROU de fato — mesma régua que já usamos na Shopee (escrow)
           e no TikTok (extrato), onde o marketplace manda e o Bling é o palpite. Sem dado no
           billing, a cascata segue igual: sale_fee e depois o que o Bling deu. */
        if (canal === 'ml' && nl) {
          const cB = Number(comBill[String(nl).trim()] || 0);
          if (cB > 0) { comissao = cB; comFonte = 'billing'; }
          else if (!comissao || comissao <= 0) {
            const tkAgora = await tokenFee();
            const f = tkAgora ? await _feeMLLeve(nl, tkAgora) : 0;
            if (f > 0) { comissao = f; comFonte = 'sale_fee'; await dorme(120); }
          }
        }
        // ── CASCATA DA SHOPEE (06/08) — a identidade validada em 100 de 100 pedidos ────
        // Ao contrario do ML, aqui NAO existe billing de periodo: o escrow ja vem por
        // pedido e fechado. A conta, conferida ao centavo:
        //   tarifa = net_commission_fee + net_service_fee + seller_product_rebate
        //          + order_ams_commission_fee (afiliado) + campaign_fee + processamento
        //   frete do vendedor = max(0, -final_shipping_fee)   (negativo = custo dele)
        // O escrow vem do servico que e dono do token (nao duplicamos credencial).
        let shopFonte = null;
        // ── CASCATA DO TIKTOK — o marketplace manda (mesma lógica da Girassol) ────────
        let freteTiktokA = null;   // null = canal não é TikTok / sem dado do pedido
        if (canal === 'tiktok' && nl) {
          const tkA = _tkPedidosA[String(nl).trim()];
          if (tkA && Number(tkA.tarifa) > 0) {
            _backfill.tiktok.tarifa_que_o_bling_dava = Math.round((_backfill.tiktok.tarifa_que_o_bling_dava + Number(comissao || 0)) * 100) / 100;
            _backfill.tiktok.tarifa_somada = Math.round((_backfill.tiktok.tarifa_somada + Number(tkA.tarifa)) * 100) / 100;
            _backfill.tiktok.frete_liquido_visto = Math.round((_backfill.tiktok.frete_liquido_visto + Number(tkA.frete_liquido || 0)) * 100) / 100;
            _backfill.tiktok.usados++;
            comissao = Number(tkA.tarifa);
            comFonte = 'tiktok';
            // Codex (P2): frete líquido POSITIVO é dinheiro que sobrou pra loja (subsídio maior
            // que o custo). Zerar jogava esse crédito fora e subestimava a margem. A Shopee já
            // grava o líquido podendo ficar negativo — aqui igual: crédito entra como frete
            // negativo, que a margem soma de volta.
            const fLiqA = Number(tkA.frete_liquido || 0);
            freteTiktokA = Math.round(-fLiqA * 100) / 100;
          } else { _backfill.tiktok.sem_dado++; }
        }
        if (canal === 'shopee' && nl && (SHOPEE_TODOS || !comissao || comissao <= 0)) {
          try {
            let cEsc = escrowPg[String(nl).trim()] || null;   // já veio no lote da página?
            if (!cEsc) {
              const rEsc = await escrowDoPedido(nl);
              cEsc = (rEsc && rEsc.ok && rEsc.dados) ? contasDoEscrow(rEsc.dados.resposta) : null;
            }
            if (cEsc && cEsc.tarifa > 0) {
              // quanto o escrow acrescenta em cima do que o Bling dava — a medida do buraco
              _backfill.shopee.comissao_que_o_bling_dava = Math.round((_backfill.shopee.comissao_que_o_bling_dava + Number(comissao || 0)) * 100) / 100;
              _backfill.shopee.comissao_somada = Math.round((_backfill.shopee.comissao_somada + cEsc.tarifa) * 100) / 100;
              comissao = cEsc.tarifa;
              comFonte = 'escrow';
              shopFonte = (Math.abs(cEsc.sobra) <= 0.02) ? 'escrow_fechou' : 'escrow_com_sobra';
              // ── 09/08: AS DUAS PONTAS DO FRETE DA SHOPEE, finalmente ────────────────
              // No b120 eu deixei o frete de fora de proposito, porque sobrescrever com o
              // liquido do escrow fazia o pedido FLEX perder o motoboy. A regra que faltava:
              //   frete do vendedor = MOTOBOY (so no flex, vem da config) + LIQUIDO do escrow
              // O liquido ja vem com o sinal certo do `contasDoEscrow`: positivo = saiu do
              // bolso, negativo = sobrou dinheiro de frete pra loja (subsidio da Shopee).
              // Caso real que provou a regra — 260805JQ6X1DUT: motoboy 9,00 e liquido -8,00.
              // O certo e 1,00. Antes do b120 dava -8,00 (errado) e no b120 ficou 9,00 (tambem
              // errado, ignorava o subsidio). Agora fecha.
              // Nunca fica negativo: se o subsidio for maior que o motoboy, o frete e ZERO e
              // o que sobrou ja esta na receita do pedido (o escrow paga isso por dentro).
              const _liqSh = Number(cEsc.frete_liquido_vendedor || 0) || 0;
              _backfill.shopee.frete_liquido_visto = Math.round(((_backfill.shopee.frete_liquido_visto || 0) + _liqSh) * 100) / 100;
              let _motoboy = 0;
              try {
                if (ehFlex(servicoDoPedido(det))) {
                  const _cfgSh = readJson(path.join(CACHE_DIR, '_config-fiscal.json'), {});
                  const _fx = (_cfgSh && _cfgSh.flex) || {};
                  // P1 do Codex (09/08): eu caía pra ZERO quando a config nunca foi salva,
                  // mas o dashboard usa DEFAULT_FLEX = { ml:12, shopee:9, outros:9 }. Na Girassol
                  // não mordia (a config existe — o contador mostrou 8.442 de motoboy no ano),
                  // mas MORDERIA no porte pra AMB e GOOD, que nascem com config vazia: todo
                  // pedido Flex entraria com motoboy 0 e margem inflada. Agora o padrão é o mesmo.
                  const _v = (_fx.shopee != null) ? Number(_fx.shopee)
                           : ((_fx.geral != null) ? Number(_fx.geral) : 9);   // 9 = DEFAULT_FLEX.shopee
                  if (isFinite(_v) && _v > 0) _motoboy = _v;
                }
              } catch (e) {}
              // P2 do Codex (09/08): o `Math.max(0, ...)` jogava fora o que sobrava quando o
              // subsídio da Shopee era MAIOR que o motoboy. Eu tinha escrito que "o excedente já
              // está na receita" — ESTAVA ERRADO: a margem parte do valor dos PRODUTOS, e o frete
              // do comprador não entra em lugar nenhum. Medido no ano: R$ 224 descartados
              // (motoboy 8.442 − líquido 7.529 = 912,86 algébrico, mas gravou 1.136,86).
              // Agora o frete pode ficar NEGATIVO — é um crédito, e o dashboard subtrai frete da
              // margem, então crédito aumenta a margem, que é o certo. Conferido que nenhum ponto
              // do índice nem do dashboard assume frete >= 0.
              freteShopee = Math.round((_motoboy + _liqSh) * 100) / 100;
              if (_backfill.shopee) {
                _backfill.shopee.frete_motoboy_somado = Math.round(((_backfill.shopee.frete_motoboy_somado || 0) + _motoboy) * 100) / 100;
                _backfill.shopee.frete_gravado = Math.round(((_backfill.shopee.frete_gravado || 0) + freteShopee) * 100) / 100;
              }
            } else shopFonte = 'escrow_sem_resposta';
          } catch (e) { shopFonte = 'escrow_erro'; }
          if (_backfill.shopee) _backfill.shopee[shopFonte] = (_backfill.shopee[shopFonte] || 0) + 1;
          if (_backfill.shopee && (shopFonte === 'escrow_sem_resposta' || shopFonte === 'escrow_erro') && dtP) {
            _backfill.shopee.sem_repasse_por_dia[dtP] = (_backfill.shopee.sem_repasse_por_dia[dtP] || 0) + 1;
          }
          if (!escrowPg[String(nl).trim()]) await dorme(160);   // só espera quando foi de um em um
        }
        if (_backfill.comissao) _backfill.comissao[comFonte] = (_backfill.comissao[comFonte] || 0) + 1;
        // ── CASCATA DO FRETE (05/08): mesmo remedio, mesmo buraco ──────────────────────
        // A auditoria mostrou o tamanho: o ML debitou R$ 235.065,95 de frete em jan-jul e o
        // nosso historico tinha R$ 167.768,75 — em JANEIRO eram R$ 501,78 contra R$ 19.040,27.
        // O billing tem o frete por numero de venda; o Bling so as vezes traz.
        // (FLEX nao entra por aqui: o ML nao cobra frete nesses, quem paga o motoboy e a loja.)
        // o frete que o escrow apurou manda no da Shopee — e o liquido real do pedido
        if (freteShopee != null) { frete = freteShopee; }
        // TikTok entra ANTES do Bling na escolha do frete (dado do próprio marketplace)
        if (freteTiktokA != null) frete = freteTiktokA;
        let freFonte = (freteTiktokA != null) ? 'tiktok' : (freteShopee != null) ? 'escrow' : ((frete > 0) ? 'bling' : 'zero');
        /* 04/09: mesma inversão da comissão — o frete cobrado no faturamento do ML vale mais
           que o previsto do Bling. O escrow da Shopee e o extrato do TikTok já tinham essa
           precedência; o ML estava atrás. */
        if (canal === 'ml' && nl) {
          const fB = Number(freBill[String(nl).trim()] || 0);
          if (fB > 0) { frete = fB; freFonte = 'billing'; }
        }
        if (_backfill.frete) _backfill.frete[freFonte] = (_backfill.frete[freFonte] || 0) + 1;
        if(ehOlist && (!comissao || comissao<=0)) comissao = Math.round(somaProd * _olistCfgA.taxaPct / 100 * 100)/100;
        if(ehOlist && (!frete || frete<=0)) frete = _olistCfgA.freteReais;
        /* ═══ 20/08 — CORREÇÃO DE RAIZ: o frete PREVISTO também vai pro banco ═══════════════
           O Diego achou 106 pedidos Magalu da AMB com frete "—" no Mês e a margem inflada. A
           exibição já foi corrigida (o histórico completa na leitura), mas quem lê a margem CRUA
           do Supabase — /previsao-vendas e /plano-compra — continuava sem o frete. A raiz é esta:
           o backfill gravava 0 quando o Bling não tinha o frete, em vez de usar o previsto que o
           cache já usa. Regra dele: "tem que ser a mais próxima do real, e chegando os fechamentos
           por API, tem que ser a real real" — então o previsto entra agora e o real substitui
           quando o pedido liquida (o banco por SKU é a média do frete REAL, auto-corretiva). */
        if ((!frete || frete <= 0) && canal === 'magalu') {
          /* Acerto (Codex #226 final): a média do banco é o freteCopart do PEDIDO — um PACOTE.
             Antes somava media×qtd por item e o provisório persistia multiplicado; como fica >0,
             o completar da leitura nunca o substituía e a margem gravada saía inflada. Agora o
             pedido leva UM pacote, decidido como no leitor: 1º item (por SKU) com banco. */
          const _bancoFr = (typeof magaluFreteSkuLer === 'function') ? magaluFreteSkuLer() : {};
          let _pacotePrev = 0;
          const _skuOrd = itens.map(it => String(it.sku || '').trim()).filter(Boolean).sort((a, b) => a.localeCompare(b));
          for (const sk of _skuOrd) { const b = _bancoFr[sk]; const m = b && Number(b.media); if (m > 0) { _pacotePrev = m; break; } }
          if (_pacotePrev > 0) { frete = Math.round(_pacotePrev * 100) / 100; freFonte = 'previsto'; }
        }
        const numPed = String(det.numero!=null?det.numero:(p.numero!=null?p.numero:p.id));
        for(const it of itens){
          const frac = it.vt/somaProd;
          /* ═══ 21/08 — O CUSTO É O QUE VALIA NA DATA DA VENDA ═══════════════════════════
             Sem isto, um backfill rodado hoje carimba o custo de HOJE sobre venda de janeiro — e
             o Mês anterior passa a mostrar um lucro que nunca existiu. A linha do tempo responde
             quanto valia naquele dia; sem faixa que cubra a data (produto novo, ou período
             anterior ao primeiro registro), cai no custo atual, como sempre foi. */
          let cU = null;
          try { cU = custoVigenteEm(it.sku, String(dataV || '').slice(0, 10)); } catch (e) { cU = null; }
          if (cU == null) cU = (custos[it.sku] && custos[it.sku].custo != null) ? Number(custos[it.sku].custo) : null;
          const custoItem = cU!=null ? Math.round(cU*it.qtd*100)/100 : null;
          const comItem = Math.round(comissao*frac*100)/100;
          const freteItem = Math.round(frete*frac*100)/100;
          const impItem = Math.round(imposto*frac*100)/100;
          const margem = custoItem!=null ? Math.round((it.vt - custoItem - comItem - freteItem - impItem)*100)/100 : null;
          if (nl) jaNoBling.add(String(nl).trim());   // 02/08: marca que o Bling já tem esta venda
        buffer.push({ empresa, numero_pedido:numPed, numero_loja:nl, canal, data_venda:dataV, sku:it.sku, descricao:it.desc, quantidade:it.qtd, valor_produto:it.vt, valor_nota:Math.round(total*frac*100)/100, custo:custoItem, comissao:comItem, frete_vendedor:freteItem, imposto:impItem, margem, uf: ufPed });
          _backfill.itens++;
        }
        if(buffer.length >= 200) await flush();
      }
      if(lista.length < 100) break;
      await dorme(300);
    }
    await flush();

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 02/08 - O MARKETPLACE E A FONTE. Decisao do Diego: "se a venda ocorreu no dia, tem que
    // aparecer no dia". O Bling e ESPELHO — ele nao inventa valor, so replica o que o canal
    // manda — e demora a receber venda de envio agendado, Fulfillment ou pagamento em analise.
    // Entao, DEPOIS de varrer o Bling, perguntamos ao ML quais vendas existem no periodo e
    // acrescentamos as que o Bling ainda nao tem.
    // POR QUE AQUI DENTRO e nao numa rotina separada: o backfill APAGA o periodo antes de
    // regravar. Rotina de fora seria apagada na proxima rodada, ou geraria DUAS linhas pra
    // mesma venda (uma do ML, outra do Bling) e o faturamento dobraria. Escritor unico resolve.
    // Quando o Bling receber a venda, ela passa a vir da varredura normal e esta parte a ignora.
    try {
      if (empresa === 'amb') {
        const { garantirTokenML } = require('../../ambtotal/mlTokenManager');
        const tk = await garantirTokenML();
        /* Codex #343 r3: meu replace de timeout da rodada anterior atingiu ESTE objeto, que é
           REUSADO em todas as páginas do backfill — um único AbortSignal de 15s abortaria a
           paginação inteira no meio, e o catch de fora registraria erro e deixaria o backfill
           "concluir" sem os dados. Efeito colateral fora do escopo do PR: aqui fica só o header,
           como era. Timeout por requisição é responsabilidade de quem chama, não do objeto. */
        const HML = { headers: { Authorization: 'Bearer ' + tk } };
        const rme = await fetch('https://api.mercadolibre.com/users/me', HML);
        const me = rme.ok ? await rme.json().catch(() => null) : null;
        const seller = me && me.id;
        if (seller) {
          const cfgF = readJson(path.join(CACHE_DIR, '_config-fiscal.json'), { aliquotas: {} });
          const aliqDe = m => { const a = cfgF.aliquotas && cfgF.aliquotas[m];
            if (a != null && isFinite(Number(a)) && Number(a) > 0) return Number(a);   // 19/08: 0% salvo era campo em branco — cai no padrão
            return (DEFAULT_ALIQ_BK && DEFAULT_ALIQ_BK[m] != null) ? Number(DEFAULT_ALIQ_BK[m]) : 0; };
          const custos = readJson(path.join(CACHE_DIR, '_custos.json'), {});
          const cUn = sk => { const c = custos[String(sk || '').trim()]; return (c && c.custo != null && isFinite(Number(c.custo))) ? Number(c.custo) : null; };
          // comissao REAL do faturamento do ML, quando ja existir pra essa venda
          const bill = readJson(path.join(CACHE_DIR, '_ml_billing.json'), { tarifas: {} });
          const comDe = {}, freDe = {};
          for (const t of Object.values(bill.tarifas || {})) {
            if (!t.o) continue;
            if (t.c === 'comissao' || t.c === 'mp' || t.c === 'parcelamento' || t.c === 'antecipacao') comDe[t.o] = Math.round(((comDe[t.o] || 0) + t.v) * 100) / 100;   // 05/08: parcelamento e custo DA VENDA (doc do ML), entra junto
            if (t.c === 'frete') freDe[t.o] = Math.round(((freDe[t.o] || 0) + t.v) * 100) / 100;
          }
          // 03/08 \u2014 o /orders/search do ML tem TETO de 1.000 resultados (offset+limit). Junho teve
          // mais de 2.000 vendas, entao varrer o mes inteiro de uma vez PERDERIA o excedente em
          // silencio. Solucao: quebrar o periodo em JANELAS DE 5 DIAS e varrer cada uma.
          const diasJan = [];
          { const d1 = new Date(de + 'T12:00:00'), d2 = new Date(ate + 'T12:00:00');
            for (let c = new Date(d1); c <= d2; c.setDate(c.getDate() + 5)) {
              const ini = new Date(c), fim = new Date(c); fim.setDate(fim.getDate() + 4);
              if (fim > d2) fim.setTime(d2.getTime());
              diasJan.push([ini.toISOString().slice(0,10), fim.toISOString().slice(0,10)]);
            } }
          let addLinhas = 0, addVendas = 0, janelasCheias = 0;
          for (const [jDe, jAte] of diasJan) {
          const base = 'https://api.mercadolibre.com/orders/search?seller=' + seller +
                       '&order.date_created.from=' + encodeURIComponent(jDe + 'T00:00:00.000-03:00') +
                       '&order.date_created.to=' + encodeURIComponent(jAte + 'T23:59:59.999-03:00') +
                       '&sort=date_asc&limit=50';
          let totalML = Infinity;
          for (let off = 0; off < 1000 && off < totalML; off += 50) {
            const r = await fetch(base + '&offset=' + off, HML);
            if (!r.ok) break;
            const d = await r.json().catch(() => null);
            const arr = (d && d.results) || [];
            for (const o2 of arr) {
              if (String(o2.status || '') !== 'paid') continue;                 // cancelada nao entra
              const oid = String(o2.id), pk = o2.pack_id ? String(o2.pack_id) : null;
              if (jaNoBling.has(oid) || (pk && jaNoBling.has(pk))) continue;     // o Bling ja tem
              const dv = String(o2.date_created || '').slice(0, 10);
              if (dv < de || dv > ate) continue;
              const itens2 = o2.order_items || [];
              const somaML = itens2.reduce((a, x) => a + (Number(x.unit_price) || 0) * (Number(x.quantity) || 1), 0);
              const totOrd = Number(o2.total_amount) || somaML;
              const aq = aliqDe(dv.slice(0, 7));
              const comTot = comDe[oid] != null ? comDe[oid] : null;
              const freTot = freDe[oid] != null ? freDe[oid] : 0;
              for (const x of itens2) {
                const q2 = Number(x.quantity) || 1;
                const vt = Math.round((Number(x.unit_price) || 0) * q2 * 100) / 100;
                const frac2 = somaML > 0 ? (vt / somaML) : (1 / Math.max(1, itens2.length));
                const sku2 = (x.item && (x.item.seller_sku || x.item.seller_custom_field)) || null;
                const cu2 = cUn(sku2);
                const custo2 = cu2 != null ? Math.round(cu2 * q2 * 100) / 100 : null;
                const vnota2 = Math.round(totOrd * frac2 * 100) / 100;
                const imp2 = Math.round(vnota2 * aq / 100 * 100) / 100;
                const com2 = comTot != null ? Math.round(comTot * frac2 * 100) / 100 : 0;
                const fre2 = Math.round(freTot * frac2 * 100) / 100;
                const mg2 = custo2 != null ? Math.round((vt - custo2 - com2 - fre2 - imp2) * 100) / 100 : null;
                buffer.push({ empresa, numero_pedido: 'ML-' + oid, numero_loja: (pk || oid), canal: 'ml',
                  data_venda: dv, sku: sku2, descricao: (x.item && String(x.item.title || '').slice(0, 120)) || null,
                  quantidade: q2, valor_produto: vt, valor_nota: vnota2, custo: custo2,
                  comissao: com2, frete_vendedor: fre2, imposto: imp2, margem: mg2 });
                addLinhas++; _backfill.itens++;
              }
              addVendas++;
              if (buffer.length >= 200) await flush();
            }
            const tt = Number(d && d.paging && d.paging.total);
            totalML = isFinite(tt) ? tt : 0;
            if (totalML > 1000) janelasCheias++;   // avisa se ainda assim estourou o teto
            if (arr.length < 50) break;
            await dorme(300);
          }
          await flush();
          await dorme(250);
          }
          _backfill.do_marketplace = { vendas: addVendas, linhas: addLinhas, janelas: diasJan.length };
          _backfill.do_marketplace.magalu_incluida = true;
          if (janelasCheias) _backfill.do_marketplace.aviso = janelasCheias + ' janela(s) passaram de 1.000 vendas \u2014 pode ter ficado venda de fora';
          if (addVendas) console.log('[BACKFILL] + ' + addVendas + ' venda(s) vieram DIRETO do Mercado Livre (o Bling ainda nao tinha)');
        }
      }
    } catch (e) { _backfill.msg_ml = String(e.message || e).slice(0, 160); console.log('[BACKFILL] ML: ' + (e.message || e)); }

    // 11/08 (Codex PR#25 P1): a MAGALU também entra na reconstrução. O backfill apaga o
    // período e regrava do zero — se a caça horária fosse o único escritor das vendas que
    // o Bling não tem, um backfill de julho apagaria tudo que ela recuperou e o buraco
    // voltaria. Aqui é o MESMO escritor: as linhas da Magalu entram no `estoque` antes da
    // gravação final, junto com Bling e ML.
    try {
      if (empresa === 'amb') {
        /* 03/09: o estoque agora vive em disco — os numero_loja já gravados vêm do arquivo,
           e as linhas do Magalu são APENDADAS nele (o lint 'orfaos' pegou o array antigo
           sobrando aqui; teria quebrado em produção com 'estoque is not defined'). */
        const jaBl = new Set();
        /* Codex #325 r2: lerLotes é async generator — 'for...of' síncrono lança TypeError na
           hora, o catch do Magalu engolia, e o backfill seguia pro DELETE SEM as vendas do
           Magalu. Bug real, teria acontecido em produção. */
        for await (const lote of lerLotes(500)) for (const l of lote) if (l && l.canal === 'magalu' && l.numero_loja) jaBl.add(String(l.numero_loja));
        const resMg = await magaluLinhas(de, ate, empresa, jaBl);
        if (resMg.erro) { _backfill.msg_magalu = resMg.erro; }
        else {
          /* Codex #325 r2: o append do Magalu passa pelo MESMO caminho fatal do flush — se
             falhar, marca _spoolFalhou e o portão antes do DELETE aborta. Antes o catch do
             Magalu engolia e o mês era regravado sem essas vendas. */
          if (resMg.linhas.length) {
            try { fs.appendFileSync(arqEstoque, resMg.linhas.map(l => JSON.stringify(l)).join('\n') + '\n'); }
            catch (e) { _spoolFalhou = 'não deu pra gravar as vendas do Magalu no temporário: ' + String(e.message || e).slice(0, 120); throw e; }
            coletados += resMg.linhas.length; _backfill.itens += resMg.linhas.length;
          }
          _backfill.do_magalu = { vendas: resMg.pedidos, linhas: resMg.linhas.length, parcial: resMg.parcial, na_magalu: resMg.na_magalu };
          if (resMg.pedidos) console.log('[BACKFILL] + ' + resMg.pedidos + ' venda(s) vieram DIRETO da Magalu (o Bling ainda nao tinha)');
        }
      }
    } catch (e) { _backfill.msg_magalu = String(e.message || e).slice(0, 160); console.log('[BACKFILL] Magalu: ' + (e.message || e)); }

    // coleta completa — só AGORA o período antigo dá lugar ao novo
    _backfill.fase = 'gravando';
    /* Codex #325: dois portões ANTES de apagar — o spool gravou tudo? e está íntegro? Um
       'não' em qualquer um aborta com o período intacto. */
    if (_spoolFalhou) {
      _backfill.fase = 'abortado'; _backfill.erros++; _backfill.msg = 'ABORTADO: ' + _spoolFalhou + ' — nada foi apagado';
      _backfill.rodando = false; _backfill.fim = new Date().toISOString();
      _limparSpool(); return Object.assign({}, _backfill, { desfecho: 'abortado', ok: false });
    }
    try {
      const nSpool = await validarSpool();
      if (nSpool !== coletados) throw new Error('spool tem ' + nSpool + ' linha(s) mas foram coletadas ' + coletados);
    } catch (e) {
      _backfill.fase = 'abortado'; _backfill.erros++; _backfill.msg = 'ABORTADO: temporário em disco inválido (' + String(e.message || e).slice(0, 120) + ') — nada foi apagado';
      _backfill.rodando = false; _backfill.fim = new Date().toISOString();
      _limparSpool(); return Object.assign({}, _backfill, { desfecho: 'abortado', ok: false });
    }
    /* 14/10 (parecer do Codex, 6.3) - TROCA SEGURA DO PERIODO. Antes: DELETE do periodo e depois os
       lotes direto no historico — DELETE recusado ja abortava (#684), mas com o DELETE aceito, um lote que
       falhava (ou um reinicio no meio) deixava o periodo SEM as linhas antigas e so com parte das novas,
       e a rodada terminava 'com_erros' com ok:true. A tabela nao tem chave unica por venda: nada no
       banco segurava. Agora a versao nova vai pro RASCUNHO e uma funcao do banco troca o periodo inteiro
       de uma vez (lib/checkout/troca-periodo-historico.js + sql/historico-troca-segura.sql): ou troca
       tudo, ou o historico fica exatamente como estava. Sem o script rodado no banco, ABORTA (nunca cai
       no jeito antigo). */
    const _tr = await require('../../lib/checkout/troca-periodo-historico').trocarPeriodoHistorico({
      empresa, de, ate, supaReq: supaReq, lerLotes, esperadas: coletados, dorme });
    if (!_tr.ok) {
      _backfill.fase = 'abortado'; _backfill.erros++; _backfill.msg = _tr.msg;
      _backfill.rodando = false; _backfill.fim = new Date().toISOString();
      _limparSpool();
      return Object.assign({}, _backfill, { desfecho: 'abortado', ok: false, transitorio: !!_tr.transitorio,
        incerto: !!_tr.incerto, nao_preparado: !!_tr.nao_preparado });
    }
    _backfill.gravados = _tr.gravadas;
    _backfill.troca = { apagadas: _tr.apagadas == null ? null : _tr.apagadas, inseridas: _tr.inseridas == null ? null : _tr.inseridas,
      confirmado_por: _tr.confirmado_por || 'resposta da troca' };
    _backfill.fora = foraDoPeriodo;
    // 17/08: rodada com linha perdida NÃO é "concluido" — antes o status dizia concluído com
    // 112 erros no meio e o histórico ficava incompleto sem ninguém perceber.
    _backfill.fase = _backfill.erros ? 'concluido_com_erros' : 'concluido';
    /* 27/10: com a troca feita, os dias da Shopee sem repasse ficam anotados pra madrugada refazer; os completos saem da lista */
    try { require('../../lib/checkout/repasse-pendente').anotarRodada(CACHE_DIR, de, ate, (_backfill.shopee && _backfill.shopee.sem_repasse_por_dia) || {}, { completo: !_backfill.erros });   /* Codex #755: com erros, só ACRESCENTA — não limpa */ } catch (e) { console.error('[BACKFILL] repasse pendente:', e.message); }
    // Codex PR#33: a reconstrução apaga+reinsere sem credito_ml — redistribui os bônus do período
    try { _mlBilling.aplicarCreditosFlexNaFila(de, ate).catch(() => {}); } catch (e9) {}
  } catch(e){ _backfill.fase='erro'; _backfill.msg = String(e.message||e); }
  _limparSpool();   /* 03/09: temporário em disco some ao terminar */
  _backfill.rodando = false; _backfill.fim = new Date().toISOString();
  /* 27/10 (Codex #755): o fim normal DEVOLVE o desfecho, como o backfill compartilhado — sem isto, quem usa a resposta
     (a madrugada ao refazer os dias da Shopee sem repasse, o ano, o resgate) recebia undefined: o refazer contava
     sucesso como falha, e o ano seguia depois de um mês que deu erro */
  return Object.assign({}, _backfill, {
    desfecho: (_backfill.fase === 'erro') ? 'erro' : (_backfill.fase === 'abortado') ? 'abortado' : (_backfill.erros ? 'com_erros' : 'ok'),
    ok: _backfill.fase !== 'erro' && _backfill.fase !== 'abortado',
  });
}
  return { backfillVendas, estado: () => _backfill };
};
