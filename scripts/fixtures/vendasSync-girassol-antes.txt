/* venda do dia da Girassol ANTES da peça única (17/10/2026) — referência do teste de equivalência; não é carregado em produção */
async function vendasSync() {
  let _nfHoraOrc = 0;   // teto de consultas de hora da NF por rodada
  if (_vsy.rodando) return;
  // b35 (Codex PR#13, espelhado da AMB): os resultados por marketplace são DESTA rodada —
  // zerar aqui, senão o status mostra o número da rodada anterior enquanto a atual ainda nem
  // chegou na fase (ou pulou por falta de chave/token), fingindo um dado que não é.
  _vsy.ml_direto = null; _vsy.shopee_direto = null; _vsy.mg_direto = null;
  _vsy.rodada_em = new Date().toISOString();
  _vsy.rodando = true; _vsy.erro = null; _vsy.fase = 'listagem';
  try {
    const isoD = dt => dt.toISOString().slice(0, 10);
    const hoje = new Date();
    const ini = new Date(hoje); ini.setDate(ini.getDate() - 3);
    const fim = new Date(hoje); fim.setDate(fim.getDate() + 1);   // janela [hoje-3, hoje+1] — evita o bug do mesmo-dia do Bling
    const F = path.join(CACHE_DIR, '_vendas_dia.json');
    const MAG_EMPRESA = process.env.MAGALU_EMPRESA || 'girassol';   // qual empresa Magalu este serviço consulta (girassol/good/amb)
    const atual = readJson(F, {});
    let paginas = 0;
    for (let pg = 1; pg <= 20; pg++) {
      // 28/07: idem — antes o vendasSync trazia os mais recentes de QUALQUER data e só não quebrava
      // por causa do limite de páginas + filtro no frontend. Agora a janela vale de verdade.
      const r = await blingGet('/pedidos/vendas?dataInicial=' + isoD(ini) + '&dataFinal=' + isoD(fim) + '&pagina=' + pg + '&limite=100');
      const lista = (r && r.ok && r.data && r.data.data) || [];
      if (!lista.length) break;
      paginas++;
      for (const p of lista) {
        if (!p || p.id == null) continue;
        const nl = p.numeroPedidoLoja || p.numeroLoja || null;   // a LISTAGEM do Bling manda numeroLoja (o detalhe manda numeroPedidoLoja)
        const ljId = String((p.loja && p.loja.id) || '');
        // 🐛 27/07 — BUG GRAVE CORRIGIDO: aqui o registro era SUBSTITUÍDO inteiro a cada rodada (5 min),
        // apagando tudo que as fases seguintes tinham enriquecido: itens (it), flag det, tarifa/frete REAIS
        // do ML, hora da venda, dados da Shopee e a marca de cancelado no marketplace. Resultado: a cada
        // rodada quase tudo voltava à estaca zero e só ~120 pedidos eram reconstruídos — por isso os
        // pedidos ficavam eternamente sem detalhe/margem e o "cancelado" sumia sozinho.
        // Agora MESCLA: a listagem só atualiza os campos que ela realmente conhece.
        const _ant = atual[String(p.id)] || {};
        const _sitBling = (p.situacao && (p.situacao.valor || p.situacao.nome)) || null;
        atual[String(p.id)] = Object.assign({}, _ant, {
          id: p.id, numero: p.numero != null ? p.numero : null,
          numero_loja: nl || _ant.numero_loja || null,
          marketplace: LOJA_MKT[ljId] || _ant.marketplace || _inferCanal(nl),   // canal OFICIAL pela loja do Bling; formato do nº é só fallback
          data: (p.data || '').slice(0, 10) || _ant.data || null,
          total: (p.total != null && isFinite(Number(p.total))) ? Number(p.total) : (_ant.total != null ? _ant.total : null),
          cliente: (p.contato && p.contato.nome) || _ant.cliente || '',
          // se já sabemos que o MARKETPLACE cancelou, não deixa a situação do Bling apagar isso
          situacao: (_ant.cancelado_mkt && !/cancel/i.test(String(_sitBling || ''))) ? (_ant.situacao || _sitBling) : _sitBling,
          situacao_id: (p.situacao && p.situacao.id) || null,
          loja_id: (p.loja && p.loja.id) || null,
          atualizado_em: new Date().toISOString()
        });
        // b30/b31 (Codex P1, espelhado da AMB): o Bling FINALMENTE importou este pedido? A
        // entrada provisória que veio DIRETO do marketplace ('ml:'/'sh:'/'mg:' + id) cede o
        // lugar — sem duplicata. Sem isto, a provisória da Shopee/Magalu sobrevive até 6 dias
        // no arquivo mesmo depois do Bling ter o pedido, inflando contagem de status e
        // duplicando a venda no dashboard quando a renderização de provisórias for ligada.
        if (nl) { delete atual['ml:' + String(nl)]; delete atual['sh:' + String(nl)]; delete atual['mg:' + String(nl)]; }
      }
      if (lista.length < 100) break;
      await new Promise(r2 => setTimeout(r2, 450));
    }
    writeJson(F, atual);   // b12: grava JÁ após a fase 1 — o 🔄 do dashboard espera 6s e recarrega; antes, o arquivo só era gravado no fim da rodada (~1 min) e o botão sempre mostrava a rodada anterior
    /* 13/09 — FASE DIRETA DO MARKETPLACE, que a Girassol nunca teve. Nasceu na AMB em 02/08
       do princípio que o dono repete: "se dá pra pegar pela API do marketplace, é esse o
       caminho inicial; o Bling é conferência depois". Sem ela, o dia vive magro no painel —
       o Bling só enxerga a venda quando a nota desce. Achado medindo a duplicação: as cópias
       do vendasSync divergiram e este conserto (mais o diagnóstico rico de falha da Shopee,
       que mora dentro dele) ficou só de um lado. Agora é a MESMA lib nas duas. */
    try {
      await _faseDireta({ _vsy, atual, isoD, json, writeJson, F, hoje, fim, magEmpresa: MAG_EMPRESA });
    } catch (e) { console.log('[VENDAS-SYNC] fase direta falhou: ' + String(e && e.message || e).slice(0, 120)); }

    _vsy.fase = 'detalhes';
    // b21: esta fase virou a PRIMEIRA depois da listagem — é ela que dá MARGEM às vendas ainda não bipadas
    // (itens → custo/R$ produtos; taxas → tarifa). Estava por último atrás de NF/Shopee e pedido novo ficava
    // sem margem nenhuma até o fim da rodada (ou pra sempre, se a rodada não terminasse).
    // fase 2: DETALHE dos ainda não-bipados (itens → custo/R$ produtos; taxas → tarifa/frete) — margem antes da bipagem
    try {
      const confS = readJson(CONFERIDOS_FILE, {});
      const bipN = new Set(Object.values(confS).map(c => String(c && c.numero)));
      let _tkV=null; try{ const {garantirTokenML:_g2}=require('../girassol/mlTokenManager'); _tkV=await _g2(); }catch(e){}   // hora real do ML nas não-bipadas
      const alvosDet = Object.values(atual)
        .filter(v => v && !v.det && v.numero != null && !bipN.has(String(v.numero)) && !/cancel/i.test(String(v.situacao || '')))
        .sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')) || Number(b.numero || 0) - Number(a.numero || 0))   // b30: mais RECENTES primeiro. Com 800+ vendas na janela, os recentes (que o Diego abre pra ver) ficavam no FIM da fila de inserção e nunca ganhavam detalhe/margem — agora entram primeiro.
        .slice(0, 120);   // b30: 90→120 por rodada pra drenar o volume mais rápido
      let _detN = 0;
      for (const v of alvosDet) {
        const rd = await blingGet('/pedidos/vendas/' + v.id);
        const det = (rd && rd.ok && rd.data && rd.data.data) || null;
        if (det) {
          if (!v.numero_loja && det.numeroPedidoLoja) v.numero_loja = det.numeroPedidoLoja;   // detalhe traz numeroPedidoLoja
          if (!v.marketplace || v.marketplace === 'outro') { const lj2 = String((det.loja && det.loja.id) || ''); v.marketplace = LOJA_MKT[lj2] || _inferCanal(v.numero_loja); }
          v.it = (det.itens || []).map(i2 => ({ sku: (i2.codigo || (i2.produto && i2.produto.codigo) || '').trim() || null, d: (i2.descricao || (i2.produto && i2.produto.nome) || '').slice(0, 120) || null, qtd: Number(i2.quantidade || 1), vt: Math.round(Number(i2.valor || 0) * Number(i2.quantidade || 1) * 100) / 100 }));   // 28/07: +d = nome do produto, p/ o cartão do celular mostrar o título também nas vendas ainda não bipadas
          const tc = det.taxas && Number(det.taxas.taxaComissao); if (isFinite(tc) && tc > 0) v.taxa_mkt = Math.round(tc * 100) / 100;
          const cf = det.taxas && Number(det.taxas.custoFrete); if (isFinite(cf) && cf > 0) v.frete_mkt = Math.round(cf * 100) / 100;
          if (det.situacao && (det.situacao.valor || det.situacao.nome)) v.situacao = det.situacao.valor || det.situacao.nome;
          v.det = 1;
          if (_tkV && v.marketplace === 'ml' && v.numero_loja && !v.venda_em) {
            try {
              const nlm = String(v.numero_loja).replace(/\D/g, '');
              let rml = await fetch('https://api.mercadolibre.com/orders/' + nlm, { headers: { Authorization: 'Bearer ' + _tkV } });
              let dml = await rml.json().catch(() => null);
              if (!rml.ok) { rml = await fetch('https://api.mercadolibre.com/packs/' + nlm, { headers: { Authorization: 'Bearer ' + _tkV } }); const dp3 = await rml.json().catch(() => null); const o1 = dp3 && dp3.orders && dp3.orders[0]; if (rml.ok && o1) { rml = await fetch('https://api.mercadolibre.com/orders/' + (o1.id || o1), { headers: { Authorization: 'Bearer ' + _tkV } }); dml = await rml.json().catch(() => null); } }
              if (rml.ok && dml && dml.date_created) v.venda_em = dml.date_created;
            } catch (e) {}
          }
        }
        await new Promise(r3 => setTimeout(r3, 450));
        // b52: grava PARCIAL a cada 20 — antes só gravava no fim do lote, e qualquer deploy/reinício
        // no meio jogava fora o trabalho da rodada inteira (pedido ficava sem itens = sem unidade/custo).
        if ((++_detN % 20) === 0) { try { writeJson(F, atual); } catch (e) {} }
      }
      writeJson(F, atual);   // itens/taxas no disco JÁ — o dashboard enxerga a margem na hora
    } catch (e) {}
    _vsy.fase = 'ml_real';
    // fase ML REAL (b31): pros pedidos ML NÃO-bipados, pesca comissão + frete REAIS direto da API
    // do ML (fonte primária, mais confiável que o taxaComissao/custoFrete que o Bling importa).
    // A fase detalhes acima já deu SKU/custo/tarifa-do-Bling; esta SOBREPÕE com o dado real do ML.
    // Recentes primeiro, lote limitado (rate limit do ML). Quando o pedido é bipado, a mlSyncFees assume.
    try {
      const confR = readJson(CONFERIDOS_FILE, {});
      const bipR = new Set(Object.values(confR).map(c => String(c && c.numero)));
      let tkR = null;
      try { const { garantirTokenML: _g3 } = require('../girassol/mlTokenManager'); tkR = await _g3(); } catch (e) {}
      // ── HORA REAL DA VENDA NO TIKTOK (16/08) ──────────────────────────────────────
      // O Diego notou: "os tiktok tão tudo sem horário no dashboard". Motivo: `venda_em` só
      // era preenchido por ML e Shopee; sem ele o painel carimba MEIO-DIA e a venda aparece
      // fora de ordem no eixo do tempo. O dado já existe — o financeiro do TikTok guarda
      // `criado_em` (order_create_time) por pedido. Aqui é só transportar; custo zero de API.
      try {
        const _tkArqH = require('path').join(process.env.TIKTOK_CACHE_DIR || '/data', '_tiktok_financeiro_girassol.json');
        let _tkPedH = {};
        try { _tkPedH = (JSON.parse(require('fs').readFileSync(_tkArqH, 'utf8')) || {}).pedidos || {}; } catch (e) {}
        let _tkHoras = 0;
        const _faltam = [];
        for (const v of Object.values(atual)) {
          if (!v || v.marketplace !== 'tiktok' || !v.numero_loja || v.venda_em) continue;
          const reg = _tkPedH[String(v.numero_loja).trim()];
          const ts = reg && Number(reg.criado_em);
          if (ts && isFinite(ts)) { v.venda_em = new Date(ts * 1000).toISOString(); _tkHoras++; }
          else _faltam.push(v);
        }
        // Codex (#105): venda RECENTE ainda não tem extrato (a liquidação demora dias), então o
        // cache do financeiro não a conhece — e ela é justamente a que aparece no painel agora.
        // A API de PEDIDOS do TikTok já traz `create_time`: uma consulta por janela resolve.
        if (_faltam.length) {
          let tkH = null;
          try { tkH = require('../tiktok-oauth'); } catch (e) {}
          if (tkH && typeof tkH.chamar === 'function' && tkH.lerToken && tkH.lerToken('girassol')) {
            const mapa = {};
            const desdeH = Math.floor(Date.now() / 1000) - 10 * 86400;
            let tokenH = '';
            for (let v2 = 0; v2 < 40; v2++) {
              const rH = await tkH.chamar('/order/202309/orders/search',
                Object.assign({ page_size: '50' }, tokenH ? { page_token: tokenH } : {}),
                { metodo: 'POST', body: { create_time_ge: desdeH } }, 'girassol');
              if (!rH || !rH.ok || !rH.corpo || rH.corpo.code !== 0) break;
              const dH = rH.corpo.data || {};
              for (const o of (dH.orders || [])) if (o && o.id && o.create_time) mapa[String(o.id)] = Number(o.create_time);
              tokenH = dH.next_page_token || '';
              if (!tokenH) break;
              await new Promise(r5 => setTimeout(r5, 200));
            }
            for (const v of _faltam) {
              const ts2 = mapa[String(v.numero_loja).trim()];
              if (ts2 && isFinite(ts2)) { v.venda_em = new Date(ts2 * 1000).toISOString(); _tkHoras++; }
            }
          }
        }
        if (_tkHoras) console.log('[GIRABKP] hora real da venda preenchida em ' + _tkHoras + ' pedido(s) do TikTok');
      } catch (e) {}

      if (tkR) {
        const dormeR = ms => new Promise(r4 => setTimeout(r4, ms));
        const alvosR = Object.values(atual)
          .filter(v => v && (v.marketplace === 'ml' || v.marketplace === 'mercadolivre') && v.numero_loja && Number(v.ml_real || 0) < ML_REAL_V && !bipR.has(String(v.numero)) && !/cancel/i.test(String(v.situacao || '')))   // Codex PR#48: marcador VERSIONADO — linhas pescadas antes do gross_amount voltam pra fila uma vez
          .sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')) || Number(b.numero || 0) - Number(a.numero || 0))   // recentes primeiro
          .slice(0, 40);   // lote por rodada — o ML tem rate limit; 40 × ~3 chamadas cada
        let _mlN = 0;
        for (const v of alvosR) {
          try {
            const reg = await pescarDadosML(v.numero_loja, tkR, dormeR);
            if (reg) {
              if (reg.fee != null && reg.fee > 0) v.tarifa_ml = reg.fee;   // comissão REAL do ML (sobrepõe a do Bling)
              if (reg.frete != null) v.frete_ml = reg.frete;               // frete REAL do ML
              if (reg.venda) v.venda_em = reg.venda;                       // hora real da venda
              if (reg.credito != null) v.credito_ml = reg.credito;         // estorno/compensação
              if (reg.credito_fonte) v.credito_fonte = reg.credito_fonte;
              if (reg.logistica) v.logistica_ml = reg.logistica;
              if (reg.order) v.ml_order = reg.order;
              if (reg.pack) v.ml_pack = reg.pack;
              // Codex PR#48: se a leitura NOVA não trouxe crédito, o valor velho tem que sair ANTES
              // de marcar como processado — senão a linha fica excluída das próximas rodadas com
              // um crédito obsoleto (ex.: o /costs passou a cobrar frete do vendedor).
              if (reg.credito == null && reg.costs_ok) { delete v.credito_ml; delete v.credito_fonte; }
              // Codex PR#48: se a pesca NOVA não achou crédito, limpa o que ficou da versão
              // antiga ANTES de marcar como processado — senão o valor velho ficaria congelado
              if (reg.credito == null && reg.costs_ok) { delete v.credito_ml; delete v.credito_fonte; }
              // Codex PR#48: só sobe de versão se as chamadas que a regra NOVA exige completaram.
              // Falha transitória em /shipments ou /costs deixa a linha na fila da próxima rodada.
              v.ml_real = (reg.costs_ok && reg.ship_ok) ? ML_REAL_V : 1;   /* Codex PR#48: sem a classificacao do envio, 'nao e Flex' pode ser falso negativo */
            }
          } catch (e) {}
          await dormeR(350);
          if ((++_mlN % 10) === 0) { try { writeJson(F, atual); } catch (e) {} }   // 27/07: grava parcial — deploy no meio não joga a pesca fora
        }
        writeJson(F, atual);   // dado real do ML no disco — o dashboard já mostra "REAL"
      }
    } catch (e) {}
    _vsy.fase = 'devolucoes';
    // fase DEVOLUÇÕES (b39): busca as devoluções (type 'returns') recentes do ML e marca os pedidos
    // com o frete de retorno + status/destino. Roda leve (só as ~50 recentes de cada status, filtradas
    // por type returns). O prejuízo = perde a venda (reembolso) + frete de ida (já capturado) + este frete de retorno.
    try {
      let tkC = null;
      try { const { garantirTokenML: _g6 } = require('../girassol/mlTokenManager'); tkC = await _g6(); } catch (e) {}
      if (tkC) {
        const dormeC = ms => new Promise(r5 => setTimeout(r5, ms));
        const devs = await buscarDevolucoesML(tkC, dormeC);
        if (devs && Object.keys(devs).length) {
          for (const v of Object.values(atual)) {
            if (!v || (v.marketplace !== 'ml' && v.marketplace !== 'mercadolivre')) continue;
            const d = devs[String(v.numero_loja || '')] || devs[String(v.ml_order || '')] || devs[String(v.ml_pack || '')] || null;
            if (d) {
              v.devolucao = 1;
              v.dev_claim_id = d.claim_id;
              v.dev_frete_retorno = d.frete_retorno;   // frete de retorno pago pelo vendedor (0 quando volta pro galpão)
              v.dev_destino = d.destino;                // warehouse (foi pro ML) / seller_address (voltou pro galpão)
              v.dev_status = d.dev_status;              // label_generated / shipped / ...
              v.dev_aberta = d.aberta ? 1 : 0;          // ainda em aberto (disputa/claim) vs já fechada
              v.dev_data = d.data;
            }
          }
          writeJson(F, atual);   // devoluções marcadas no disco
        }
      }
    } catch (e) {}
    _vsy.fase = 'nf_emissao';
    // fase NF (rodava por último e NUNCA gravava: o processo morria no meio da rodada e o salvamento era só no fim —
    // b14: roda logo após a listagem e salva a cada 8, então mesmo rodada interrompida deixa progresso no disco)
    try {
      const confN = readJson(CONFERIDOS_FILE, {});
      const corteN = Date.now() - 4 * 86400000;
      const alvosN = Object.entries(confN)
        .filter(([idN, cN]) => cN && (cN.nf_emissao == null || cN.nf_emissao === '') && cN.nf_numero && cN.conferido_em && Date.parse(cN.conferido_em) >= corteN)   // b16: '' (sentinela antiga) volta pra fila
        .sort((a, b) => String(b[1].conferido_em || '').localeCompare(String(a[1].conferido_em || '')))   // mais NOVO primeiro
        .slice(0, 30);
      const pendN = {};
      const salvarN = () => {
        if (!Object.keys(pendN).length) return;
        const c9 = readJson(CONFERIDOS_FILE, {});   // relê antes de gravar — não atropela bipagem no meio
        let n9 = 0;
        let _pnf_ = 0;
        for (const [k9, v9] of Object.entries(pendN)) { if (c9[k9] && (c9[k9].nf_emissao == null || c9[k9].nf_emissao === '')) { c9[k9].nf_emissao = v9; if (v9) n9++; } }
        writeJson(CONFERIDOS_FILE, c9);
        for (const k9 of Object.keys(pendN)) delete pendN[k9];
        if (n9) console.log('[VENDAS-SYNC] nf_emissao preenchida em ' + n9 + ' conferido(s)');
      };
      let cN2 = 0;
      for (const [idN] of alvosN) {
        // b16: a pasta do pedido SAI do cache quando ele finaliza (raio-X provou: snapshot_existe=false),
        // então a fonte é o Bling PELO PEDIDO — nfDoPedido tenta /pedidos/vendas/{id}/nfe e cai pro detalhe se precisar.
        const snN = readJson(path.join(CACHE_DIR, String(idN), 'pedido.json'), null);
        let dtN = (snN && snN.nf && snN.nf.dataEmissao) || null;   // se o snapshot ainda viver e já tiver, aproveita de graça
        if (!dtN) {
          try {
            const nfO = await nfDoPedido(idN);
            if (nfO && nfO.dataEmissao) dtN = nfO.dataEmissao;
            else if (nfO && nfO.id) {   // NF achada mas a resposta veio sem a data → detalhe /nfe/{id}
              await new Promise(r4a => setTimeout(r4a, 450));
              const rN = await blingGet('/nfe/' + nfO.id);
              const dN = rN && rN.ok && rN.data && rN.data.data;
              if (dN && dN.dataEmissao) dtN = dN.dataEmissao;
            }
          } catch (e) {}
        }
        if (dtN) {
          pendN[idN] = dtN;
          if (snN && snN.nf) { snN.nf.dataEmissao = dtN; try { writeJson(path.join(CACHE_DIR, String(idN), 'pedido.json'), snN); } catch (e) {} }
        }
        cN2++; if (cN2 % 8 === 0) salvarN();
        await new Promise(r4 => setTimeout(r4, 450));
      }
      salvarN();
    } catch (e) { console.log('[VENDAS-SYNC] fase nf_emissao falhou: ' + String(e.message || e).slice(0, 120)); }
    _vsy.fase = 'shopee';
    // fase SHOPEE (b17): hora REAL da venda (create_time) + comissão REAL (escrow) direto do app da Shopee,
    // via a rota interna do serviço shopee-nf-sync (que guarda os tokens). Batch de até 20 order_sns por rodada.
    // Precisa da env SHOPEE_SYNC_KEY no Render DESTE serviço (mesma chave que abriu o teste C); URL opcional em SHOPEE_SYNC_URL.
    try {
      const SH_URL = process.env.SHOPEE_SYNC_URL || 'https://girassol-shopee-sync-organizar-envio.onrender.com';
      const SH_KEY = process.env.SHOPEE_SYNC_KEY || '';
      if (SH_KEY) {
        // b121 (06/08): `!v.tarifa_shopee_v2` entra na fila pra REPROCESSAR quem já tem
        // tarifa gravada pela fórmula antiga (net+net). Sem isso os pedidos antigos ficariam
        // com o valor subestimado pra sempre, porque o filtro só pegava tarifa_ml == null.
        /* 12/09 — O ESCROW PROVISÓRIO CONGELAVA. A fila só pegava pedido com campo VAZIO,
           então o primeiro retrato do escrow virava definitivo: o 4407 (07/09) tinha
           tarifa 43,63 gravada enquanto a final é 44,12 (faltava o seguro de envio de
           0,49, que a Shopee só lança depois), e o frete do vendedor nunca chegava —
           ficava eternamente 'aguardando' no painel. A Shopee leva dias pra consolidar.
           Agora o pedido continua na fila ENQUANTO o escrow não fechar: fechado é aquele
           cuja identidade bate (produtos + frete do comprador − tarifa − ads = repasse),
           o mesmo critério que o relatório usa. Marcado com escrow_final, sai da fila. */
        const _shSemLeitura = v => v.venda_em == null || v.tarifa_ml == null || !v.tarifa_shopee_v2;
        const _shAguardando = v => v.frete_recebido == null || v.renda_canal == null || v.ads_escrow == null || !v.escrow_final;
        /* Codex #389: o lote de 20 ordenado só por data (mais novo primeiro) deixava pedido
           AGUARDANDO fechamento (a Shopee leva dias) preso no topo pra sempre — e venda nova
           empurrava pra fora quem ainda nem tinha tido a PRIMEIRA leitura, faminto dos dois
           lados. Agora são duas filas com orçamento próprio: primeira leitura (mais novo
           primeiro, pra saber o valor logo) e reconsolidação (mais ANTIGO primeiro — FIFO,
           quem espera há mais tempo tem prioridade e sai da fila assim que fechar). */
        /* Codex (P2): pedido cancelado nunca ganha venda_em/tarifa_shopee_v2 (não há escrow a
           ler), então `_shSemLeitura` continuava true PARA SEMPRE mesmo com escrow_final=1 —
           ele consumia uma das 12 vagas de primeira leitura em toda passada, faminto pro resto
           da vida. `!v.cancelado_mkt` tira-o de vez da fila; a AMB tem o mesmo espelho. */
        const _shCandidatos = Object.values(atual).filter(v => v && v.marketplace === 'shopee' && v.numero_loja && !v.cancelado_mkt && (_shSemLeitura(v) || _shAguardando(v)));
        const _shSemLeituraLote = _shCandidatos.filter(_shSemLeitura)
          .sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')));
        const _shAguardandoLote = _shCandidatos.filter(v => !_shSemLeitura(v) && _shAguardando(v))
          .sort((a, b) => String(a.data || '').localeCompare(String(b.data || '')));
        const candS = _shSemLeituraLote.slice(0, 12).concat(_shAguardandoLote.slice(0, 8));
        if (candS.length) {
          const rS = await fetch(SH_URL + '/girassol/interno/margem-pedidos?k=' + encodeURIComponent(SH_KEY) + '&order_sns=' + encodeURIComponent(candS.map(v => v.numero_loja).join(',')), { timeout: 90000 });
          const jS = await rS.json().catch(() => null);
          if (jS && jS.ok && Array.isArray(jS.pedidos)) {
            const porSn = {}; jS.pedidos.forEach(pS => { if (pS && pS.order_sn) porSn[pS.order_sn] = pS; });
            let nS = 0;
            const cancelS = [];
            for (const v of candS) {
              const pS = porSn[v.numero_loja]; if (!pS) continue;
              /* 13/09 — PEDIDO CANCELADO NA SHOPEE CONTINUAVA CONTANDO COMO VENDA. Caso do
                 dono: o 4645 (260911PBX043JJ) foi cancelado porque o comprador não pagou —
                 está Cancelado no Bling, sem NF — e mesmo assim aparecia na Análise com
                 custo 36,00 e imposto 7,93, com tarifa/frete/M.C. em '—' pra sempre, já que
                 cancelado NUNCA gera escrow. O serviço já devolvia order_status aqui; a fila
                 só olhava o escrow e ignorava isso. Agora o cancelamento é gravado no índice
                 e a venda sai do faturamento, do imposto e da margem. */
              if (/cancel/i.test(String(pS.order_status || ''))) {
                if (!v.cancelado_mkt) { v.cancelado_mkt = 1; v.situacao = v.situacao || 'Cancelado na Shopee'; nS++; }
                v.escrow_final = 1;   /* não há escrow a esperar: sai da fila */
                /* Codex (P2): isto só marcava o cache CURTO (_vendas_dia.json, podado em 6 dias
                   pelo vendasSync). Sem eco no CONFERIDOS_FILE — onde o /status-mkt também grava —
                   um pedido já bipado voltava a contar receita/imposto/margem no histórico assim
                   que o cache expirasse, porque o endpoint de histórico zera `h.cancelado` quando
                   não acha mais o par no cache. */
                cancelS.push(v.numero);
                continue;
              }
              if (pS.create_time && v.venda_em == null) { v.venda_em = new Date(Number(pS.create_time) * 1000).toISOString(); nS++; }
              const es = pS.escrow || null;
              // ── b121 (06/08): A FÓRMULA CERTA DA SHOPEE ────────────────────────────
              // Estava net_commission + net_service — e SÓ. Faltavam o REBATE e o AFILIADO.
              // Era daqui que vinha a diferença que a gente mediu: no dia 05/08 a tela
              // mostrava R$ 592,63 de comissão de Shopee e o valor real era R$ 675,80.
              // O `net_*` vem DEPOIS do abatimento e a Shopee cobra a diferença de volta como
              // `seller_product_rebate` — que sai do bolso do vendedor. Prova aritmética:
              //   net_commission = commission − rebate.commission_fee_offset
              //   net_service    = service    − rebate.service_fee_offset
              //   rebate.amount  = os dois offsets somados
              // Logo net + net + rebate == comissão BRUTA + serviço BRUTO.
              // Fórmula conferida em 100 de 100 pedidos, sobra ZERO em todos.
              /* Codex #389: os 4 blocos abaixo checavam `!v.escrow_final` DEPOIS que o primeiro
                 já tinha acabado de gravá-lo — na passada em que o escrow FECHA pela primeira
                 vez, os 3 últimos viam escrow_final=1 (recém-setado) e pulavam a atualização,
                 deixando renda/frete/ads com o valor PROVISÓRIO ancorando a margem mesmo com a
                 tarifa já final. `wasFinal` congela o estado de ANTES desta passada. */
              const wasFinal = !!v.escrow_final;
              if (es && (v.tarifa_ml == null || !v.tarifa_shopee_v2 || !wasFinal)) {
                const nS2 = x => { const n = Number(x); return isFinite(n) ? n : 0; };
                const com = nS2(es.net_commission_fee != null ? es.net_commission_fee : es.commission_fee);
                const srv = nS2(es.net_service_fee != null ? es.net_service_fee : es.service_fee);
                const rbt = nS2(es.seller_product_rebate && es.seller_product_rebate.amount);
                const afi = nS2(es.order_ams_commission_fee);     // comissão de afiliado — custo do vendedor
                const cam = nS2(es.campaign_fee);
                const prc = nS2(es.seller_order_processing_fee);
                // b123 (06/08): seguro de envio do vendedor. Só apareceu quando olhei a AMB —
                // na Girassol vem sempre zero. Fica aqui porque quando o dashboard for pra
                // AMBTotal a conta já nasce certa.
                const seg = nS2(es.shipping_seller_protection_fee_amount);
                const tS = Math.round((com + srv + rbt + afi + seg + cam + prc) * 100) / 100;
                if (tS > 0) { v.tarifa_ml = tS; v.tarifa_shopee_v2 = 1; }   // o dashboard exibe pela mesma via da tarifa REAL do ML
                /* fechou? a identidade do escrow é o juiz (a mesma do relatório): produtos +
                   frete do comprador − tarifa − ads = repasse, com 2 centavos de folga.
                   Enquanto não fechar, o pedido VOLTA na próxima passada.
                   Codex #389: `produtos` e `repasse` têm que ser os MESMOS campos que
                   lib/shopee-escrow.js usa — senão a identidade nunca fecha (ou fecha errado)
                   num pedido com desconto ou com ajuste pós-escrow. */
                const _prod = nS2(es.order_discounted_price) || nS2(es.cost_of_goods_sold) || nS2(es.order_selling_price);
                const _frCo = nS2(es.buyer_paid_shipping_fee);
                const _ads  = nS2(es.ads_escrow_top_up_fee_or_technical_support_fee);
                const _fsf  = nS2(es.final_shipping_fee);
                const _esc  = nS2(es.escrow_amount_after_adjustment != null ? es.escrow_amount_after_adjustment : es.escrow_amount);
                const _sobra = Math.round((_prod + _frCo - tS - _ads + _fsf - _esc) * 100) / 100;
                v.escrow_final = (_esc > 0 && Math.abs(_sobra) <= 0.02) ? 1 : 0;
                v.escrow_sobra = _sobra;
              }
              if (es && (v.frete_recebido == null || !wasFinal)) {
                const frB = Number(es.buyer_paid_shipping_fee) || 0;   // b18: frete que o COMPRADOR pagou (extrato: "Subtotal estimado do frete") — crédito na M.C.
                v.frete_recebido = frB > 0 ? Math.round(frB * 100) / 100 : 0;   // 0 = confirmado sem frete do comprador (sai da fila)
                /* Codex #389: quando final_shipping_fee negativo não é totalmente coberto pelo
                   frete do comprador, sobra custo de frete REAL pro vendedor (mesma identidade
                   de lib/shopee-escrow.js: frete_liquido_vendedor = -(comprador + final)).
                   Sem isto o dashboard mostrava frete ZERO em todo pedido Shopee fechado sem
                   outra fonte de frete, subestimando custo. */
                const fsfFr = Number(es.final_shipping_fee) || 0;
                const freteLiquidoVendedor = Math.round(-(frB + fsfFr) * 100) / 100;
                v.frete_vendedor_shopee = freteLiquidoVendedor > 0 ? freteLiquidoVendedor : 0;
              }
              if (es && (v.renda_canal == null || !wasFinal)) {
                // b19: a RENDA OFICIAL do pedido (o que a Shopee deposita) — já liquida taxas, moedas Shopee,
                // cupons (dela e teus) e frete do comprador. É a âncora da M.C. no dashboard (caso das 170 moedas = R$ 1,70 que a Shopee banca).
                const ra = Number(es.escrow_amount_after_adjustment != null ? es.escrow_amount_after_adjustment : es.escrow_amount);
                if (isFinite(ra) && ra > 0) v.renda_canal = Math.round(ra * 100) / 100;
              }
              if (es && (v.ads_escrow == null || !wasFinal)) {
                /* 27/08 (aprovado pelo Diego) — Shopee Ads descontado NO REPASSE (top-up do saldo
                   de Ads pelo escrow, campo ads_escrow_top_up_fee_or_technical_support_fee): o
                   desembolso que se escondia como "recebi menos". Gravado POR PEDIDO pro resumo
                   somar a linha "Ads pago no repasse". 0 = confirmado sem ads no repasse (sai da
                   fila). Na Girassol vem sempre 0 (ela não paga Ads nessa modalidade). NÃO entra
                   na margem: o renda_canal já vem líquido dele — somar lá seria em dobro. */
                const ae = Number(es.ads_escrow_top_up_fee_or_technical_support_fee);
                v.ads_escrow = (isFinite(ae) && ae > 0) ? Math.round(ae * 100) / 100 : 0;
              }
            }
            if (nS) console.log('[VENDAS-SYNC] shopee: hora/comissão real em ' + nS + ' venda(s)');
            writeJson(F, atual);
            // eco no CONFERIDOS (pedidos já bipados) — mesmo padrão do /status-mkt: sem isto o
            // cancelamento some do histórico quando o vendasSync poda este cache em 6 dias.
            if (cancelS.length) {
              try {
                const confSh = readJson(CONFERIDOS_FILE, {});
                const alvoSh = new Set(cancelS.map(x => String(x)));
                let mexSh = 0;
                for (const k of Object.keys(confSh)) { const c = confSh[k]; if (c && alvoSh.has(String(c.numero))) { c.cancelado = 1; mexSh++; } }
                if (mexSh) writeJson(CONFERIDOS_FILE, confSh);
              } catch (e) {}
            }
          }
        }
      }
    } catch (e) { console.log('[VENDAS-SYNC] fase shopee falhou: ' + String(e.message || e).slice(0, 120)); }
    _vsy.fase = 'magalu';
    // fase MAGALU: valores REAIS da API de Análise Financeira (comissão serviço+tech, MDR,
    // tarifa fixa, coparticipação de frete, devolução) via a rota /magalu/financeiro-lote
    // no MESMO serviço. A Magalu manda PRÉVIA (comissão) e substitui pelo REAL (com frete)
    // quando o pedido é entregue/liquidado — igual o Jodda. Por isso re-consultamos os
    // provisórios até o frete aparecer (v.mag_fin='real'). Usa a ADMIN_KEY do próprio serviço.
    try {
      const ADM = process.env.ADMIN_KEY || '';
      const PORT = process.env.PORT || 3000;
      if (ADM) {
        // candidatos: pedidos magalu sem financeiro ainda (mag_fin ausente) OU provisórios
        // (mag_fin='prov' — comissão veio mas falta frete). Os 'real' saem da fila.
        const candM = Object.values(atual)
          .filter(v => v && v.marketplace === 'magalu' && v.numero_loja && v.mag_fin !== 'real')
          .sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')))
          .slice(0, 30);
        if (candM.length) {
          const codes = candM.map(v => String(v.numero_loja)).join(',');
          const urlM = 'http://127.0.0.1:' + PORT + '/magalu/financeiro-lote?empresa=' + MAG_EMPRESA +
            '&k=' + encodeURIComponent(ADM) + '&dias=45&codes=' + encodeURIComponent(codes);
          const rM = await fetch(urlM, { timeout: 90000 });
          const jM = await rM.json().catch(() => null);
          if (jM && jM.ok && jM.pedidos) {
            let nM = 0;
            for (const v of candM) {
              const fin = jM.pedidos[String(v.numero_loja)];
              if (!fin) {
                /* ═══ 20/08 — PEDIDO QUE A API DA MAGALU AINDA NÃO CONHECE ═══════════════════
                   O Diego: "sim, tem q botar o frete previsto, senão eu vou olhar e ficar
                   enganado". Ele estava certo: sem o registro financeiro, este pedido ficava SEM
                   frete nenhum e a margem aparecia inflada — justamente nas vendas mais recentes,
                   que são as que ele olha pra decidir preço. A TARIFA real depende da API mesmo e
                   continua esperando, mas o FRETE previsto NÃO: sai do banco por SKU (média do
                   frete real, auto-corretiva) ou da tabela por dimensão. Então entra agora, e o
                   real substitui quando o pedido aparece. */
                if (v.mag_frete_copart == null) {
                  const estSemApi = await magaluFreteProvisorio(v);
                  if (estSemApi != null) {
                    v.mag_frete_copart = Math.round(estSemApi * 100) / 100;
                    v.mag_frete_fonte = 'prov';
                  }
                }
                continue;   // segue na fila: a tarifa real ainda vai chegar
              }
              const liquidado = !!(fin.frete_debito && fin.frete_debito !== 0);
              // taxa base (sempre real): comissão(serviço+tech+frete-comissão) + MDR + tarifa fixa
              const taxaBase = Math.abs(fin.comissao) + Math.abs(fin.mdr) + Math.abs(fin.tarifa_fixa);
              let freteCopart, freteFonte;
              if (liquidado) {
                // LIQUIDADO: frete REAL da API + alimenta o banco por SKU (aprende pro futuro)
                freteCopart = Math.abs(fin.frete_debito); freteFonte = 'real';
                const it0 = (v.it || [])[0];
                if (it0 && it0.sku) magaluFreteSkuGravar(it0.sku, freteCopart);
              } else {
                // PROVISÓRIO: estima o frete (histórico do SKU, senão tabela pela dimensão)
                const est = await magaluFreteProvisorio(v);
                freteCopart = est != null ? est : 0; freteFonte = est != null ? 'prov' : 'sem';
              }
              // TARIFA = só a comissão da Magalu (serviço+tech+comissão-frete) + MDR + tarifa fixa.
              // O frete de coparticipação vai SEPARADO em mag_frete_copart (coluna FRETE VEND.),
              // pra não misturar comissão e frete na mesma coluna.
              const taxaBaseR = Math.round(taxaBase * 100) / 100;
              if (taxaBaseR > 0) { v.tarifa_ml = taxaBaseR; nM++; }
              v.mag_frete_copart = Math.round(freteCopart * 100) / 100;   // frete: exibido na coluna FRETE VEND.
              v.mag_frete_fonte = freteFonte;   // 'real' | 'prov' | 'sem'
              // devolução: estorno da venda (REFUND) quando houver
              if (fin.tem_devolucao) { v.mag_refund = Math.abs(fin.refund); v.devolvido = true; }
              // saldo líquido oficial da Magalu (a âncora, tipo renda_canal da Shopee) — só quando liquidado
              if (liquidado && isFinite(fin.saldo_liquido)) v.renda_canal = fin.saldo_liquido;
              // estável só quando o frete real apareceu (liquidado). Senão fica 'prov' e re-consulta.
              v.mag_fin = liquidado ? 'real' : 'prov';
            }
            if (nM) console.log('[VENDAS-SYNC] magalu: financeiro real em ' + nM + ' venda(s)');
            writeJson(F, atual);
          }
        }
      }
    } catch (e) { console.log('[VENDAS-SYNC] fase magalu falhou: ' + String(e.message || e).slice(0, 120)); }
    // poda: fora da janela de 6 dias sai do arquivo (o histórico de verdade vive nos conferidos)
    const corte = new Date(hoje); corte.setDate(corte.getDate() - 6);
    const corteS = isoD(corte);
    for (const [k, v] of Object.entries(atual)) { if (!v || !v.data || v.data < corteS) delete atual[k]; }
    writeJson(F, atual);
    _vsy.total = Object.keys(atual).length; _vsy.atualizado_em = new Date().toISOString(); _vsy.fase = 'fim';
    console.log('[VENDAS-SYNC] ok — ' + _vsy.total + ' venda(s) na janela (' + paginas + ' página(s))');
  } catch (e) { _vsy.erro = String(e.message || e).slice(0, 140); console.log('[VENDAS-SYNC] falhou: ' + _vsy.erro); }
  _vsy.rodando = false;
}