'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   FASE DIRETA DO MARKETPLACE (13/09/2026).

   Nasceu na AMB em 02/08, do princípio que o dono repete desde então: "se dá pra
   pegar pela API do marketplace, esse é o caminho inicial; o Bling é conferência
   depois". Sem ela, o dia vive magro no painel — o Bling só enxerga a venda
   quando a nota desce, e em canal Full isso demora (10/08: 35 pedidos nos
   marketplaces contra 4 no Bling).

   A Girassol nunca teve. Descobri medindo a duplicação entre os checkouts: as
   cópias do vendasSync divergiram (677 linhas contra 509) e junto foram-se
   consertos aplicados num lado só — este e o diagnóstico rico de falha da Shopee,
   que vive aqui dentro e por isso também faltava lá.

   Em vez de copiar pra Girassol (mais uma cópia pra divergir), a fase mora aqui
   com a empresa como parâmetro, e as duas empresas chamam a MESMA. Nada de rede
   é feito por conta própria: tudo entra por injeção.
   ──────────────────────────────────────────────────────────────────────────── */

function criarFaseDireta(cfg) {
  for (const nome of ['empresa', 'mlTokenManager', 'shopeeKey', 'shopeeUrlEnv', 'adminKey', 'porta', 'fetch']) {
    if (cfg == null || cfg[nome] == null) throw new Error('lib/checkout/fase-direta: falta ' + nome);
  }
  const { log = console.log, fetch: _fetch } = cfg;
  // Codex P2: fetch NÃO pode ser o global do Node — ele ignora o `timeout` não-padrão que
  // os 3 canais usam, e um canal travado prende o vendasSync além do previsto. Os
  // chamadores injetam o MESMO node-fetch que já usavam antes da extração.
  const SHOPEE_LOJA = cfg.shopeeLoja || cfg.empresa;

  return async function faseDireta(ctx) {
    /* tudo o que a fase toca vem do chamador: o estado da rodada, o índice em memória, o
       gravador, a janela de datas e a empresa do Magalu. O lint de órfãos ditou esta lista
       — cada nome aqui é um que a extração teria deixado solto. */
    const { _vsy, atual, isoD, json, writeJson, F, hoje, fim, magEmpresa } = ctx;
    const MAG_EMPRESA = magEmpresa;
      // ─── b30: VENDAS DO DIA DIRETO DO MERCADO LIVRE ─────────────────────────────
      // Princípio do Diego (02/08, cobrado de novo em 10/08): "a API tem que ser com o
      // marketplace; o Bling é só conferência depois". A AMB é Full nos três canais e o
      // Bling dela só vê a venda quando o XML desce — o dia vivia magro no dashboard
      // (10/08: 35 pedidos nos marketplaces × 4 no Bling). Esta fase pergunta AO ML
      // "o que você vendeu hoje?" e põe na tela na hora, como provisória; quando o
      // Bling importar o pedido, a listagem acima apaga a provisória (dedup pelo
      // order_id) e a venda segue o fluxo normal de NF/margem.
      _vsy.fase = 'ml_direto';
      try {
        let _tkD = null;
        try { const { garantirTokenML: _g3 } = cfg.mlTokenManager(); _tkD = await _g3(); } catch (e) {}
        if (_tkD) {
          const HD = { headers: { Authorization: 'Bearer ' + _tkD } };
          let sellerD = null;
          try { const rm = await _fetch('https://api.mercadolibre.com/users/me', HD); if (rm.ok) sellerD = (await rm.json()).id; } catch (e) {}
          if (sellerD) {
            // Codex #11 (pack): RECONCILIAÇÃO antes de criar — se o Bling já tem o pedido
            // (pelo order_id OU pelo pack_id do carrinho, que é o que o Bling grava em
            // numeroLoja), a provisória morre aqui. Cobre qualquer ordem de chegada.
            const blingSet = new Set();
            for (const [k5, v5] of Object.entries(atual)) {
              if (v5 && v5.numero_loja && !String(k5).startsWith('ml:')) blingSet.add(String(v5.numero_loja));
            }
            for (const [k5, v5] of Object.entries(atual)) {
              if (!String(k5).startsWith('ml:') || !v5) continue;
              if (blingSet.has(String(v5.numero_loja || '')) || (v5.pack_id && blingSet.has(String(v5.pack_id)))) delete atual[k5];
            }
            const jaTem = new Set();
            for (const v of Object.values(atual)) { if (v && v.numero_loja) jaTem.add(String(v.numero_loja)); }
            // b34 (Codex PR#12, vale pros 3 canais): a janela da consulta tem que cobrir a
            // RETENÇÃO do arquivo (6 dias), não só ontem+hoje. Provisória vive até 6 dias;
            // se a consulta só olha 36h, um cancelamento no 3º dia nunca é visto e a venda
            // morta segue somando no dashboard até a poda.
            const dIni = new Date(hoje); dIni.setDate(dIni.getDate() - 6);
            const fromD = isoD(dIni) + 'T00:00:00.000-03:00', toD = isoD(fim) + 'T23:59:59.999-03:00';
            const baseD = 'https://api.mercadolibre.com/orders/search?seller=' + sellerD +
                          '&order.date_created.from=' + encodeURIComponent(fromD) +
                          '&order.date_created.to=' + encodeURIComponent(toD) + '&sort=date_desc&limit=50';
            let novosML = 0, totalD = Infinity;
            const vistos = new Set();   // ids que ESTA varredura viu (pro passo dirigido lá embaixo)
            // b38 (Codex PR#14): com 6 dias de janela e sort=date_desc, o teto de 300 podia
            // deixar as provisórias mais VELHAS fora da varredura — justo as que precisam de
            // reconciliação. Teto sobe pra 1.000 e, ainda assim, quem não for visto passa
            // pelo passo dirigido (consulta 1 a 1) logo abaixo.
            for (let off = 0; off < 1000 && off < totalD; off += 50) {
              const r3 = await _fetch(baseD + '&offset=' + off, HD);
              if (!r3.ok) break;
              let d3 = null; try { d3 = await r3.json(); } catch (e) { break; }
              const arr3 = (d3 && d3.results) || [];
              if (d3 && d3.paging && isFinite(Number(d3.paging.total))) totalD = Number(d3.paging.total);
              for (const o3 of arr3) {
                if (!o3 || o3.id == null) continue;
                const oid = String(o3.id);
                const st3 = String(o3.status || '');
                // Codex #11 (cancelada depois): se o ML cancelou e a provisória existe, ela morre
                if (/cancell/i.test(st3)) { if (atual['ml:' + oid]) { delete atual['ml:' + oid]; } continue; }
                // Codex #11 (só pagas): mesmo critério do ingest histórico deste arquivo
                if (st3 !== 'paid') continue;
                vistos.add(oid);
                if (jaTem.has(oid)) continue;
                if (o3.pack_id && jaTem.has(String(o3.pack_id))) continue;   // carrinho: o Bling conhece pelo pack
                // Codex #11 (schema): itens no formato do cache — {sku, d, qtd, vt}
                const its = (o3.order_items || []).map(oi => ({
                  sku: (String((oi.item && (oi.item.seller_sku || oi.item.seller_custom_field)) || '').trim()) || null,
                  d: String((oi.item && oi.item.title) || '').slice(0, 120) || null,
                  qtd: Number(oi.quantity || 1),
                  vt: Math.round(Number(oi.unit_price || 0) * Number(oi.quantity || 1) * 100) / 100
                }));
                atual['ml:' + oid] = {
                  id: 'ml:' + oid, sem_bling: true, det: true,
                  numero: null, numero_loja: oid, pack_id: (o3.pack_id != null ? String(o3.pack_id) : null),
                  marketplace: 'mercadolivre',
                  data: String(o3.date_created || '').slice(0, 10),
                  venda_em: (o3.date_created || null),
                  total: Number(o3.paid_amount != null ? o3.paid_amount : (o3.total_amount || 0)),
                  cliente: (o3.buyer && (o3.buyer.nickname || '')) || '',
                  it: its.length ? its : undefined,
                  situacao: 'DIRETO DO ML (Bling ainda não importou)',
                  atualizado_em: new Date().toISOString()
                };
                jaTem.add(oid); novosML++;
              }
              if (arr3.length < 50) break;
              await new Promise(r4 => setTimeout(r4, 350));
            }
            // passo dirigido: provisória que a varredura não alcançou é conferida uma a uma
            let conferidas = 0, mortas = 0;
            // b41 (Codex PR#17): com teto de 40 e ordem fixa, as MESMAS 40 eram reconferidas
            // toda rodada e as provisórias do fim da fila nunca chegavam a ser checadas —
            // um cancelamento lá atrás só sumiria na poda. Agora há RODÍZIO: cada entrada
            // carimba quando foi conferida (`_conf_em`) e a fila é ordenada pela mais
            // ANTIGA primeiro (quem nunca foi conferida vem na frente).
            const fila9 = Object.entries(atual)
              .filter(([k9, v9]) => String(k9).startsWith('ml:') && v9 && String(v9.numero_loja || '').trim() && !vistos.has(String(v9.numero_loja).trim()))
              .sort((x, y) => String((x[1] && x[1]._conf_em) || '').localeCompare(String((y[1] && y[1]._conf_em) || '')));
            for (const [k9, v9] of fila9) {
              const oid9 = String(v9.numero_loja || '').trim();
              if (conferidas >= 40) break;                       // teto por rodada; o resto entra na próxima, pelo rodízio
              conferidas++;
              v9._conf_em = new Date().toISOString();            // carimbo do rodízio
              try {
                const r9 = await _fetch('https://api.mercadolibre.com/orders/' + encodeURIComponent(oid9), HD);
                if (!r9.ok) continue;                            // sumiu/sem permissão: não mexe
                const o9 = await r9.json();
                const st9 = String((o9 && o9.status) || '');
                if (/cancell/i.test(st9) || (st9 && st9 !== 'paid')) { delete atual[k9]; mortas++; }
              } catch (e) {}
              await new Promise(r10 => setTimeout(r10, 200));
            }
            if (conferidas || mortas) writeJson(F, atual);   // grava os carimbos do rodízio, mesmo sem remoção
            _vsy.ml_direto = { novos: novosML, conferidas_1a1: conferidas, removidas: mortas, em: new Date().toISOString() };
            if (novosML) { writeJson(F, atual); console.log('[VENDAS-SYNC] ml_direto: +' + novosML + ' venda(s) que o Bling ainda nao tem'); }
          }
        }
      } catch (e) { console.log('[VENDAS-SYNC] fase ml_direto falhou: ' + String(e.message || e).slice(0, 120)); }
      // ─── b31: VENDAS DO DIA DIRETO DA SHOPEE ────────────────────────────────────
      // Mesmo princípio da fase acima. O serviço shopee-nf-sync (dono do token) ganhou
      // a rota /:loja/interno/pedidos-do-dia — lista por create_time e devolve valor,
      // comprador e itens. Provisórias 'sh:<order_sn>'; o Bling apaga ao importar.
      _vsy.fase = 'shopee_direto';
      try {
        const SH_URLd = cfg.shopeeUrlEnv || 'https://girassol-shopee-sync-organizar-envio.onrender.com';
        const SH_KEYd = cfg.shopeeKey || '';
        if (SH_KEYd) {
          const jaTemS = new Set();
          for (const v of Object.values(atual)) { if (v && v.numero_loja) jaTemS.add(String(v.numero_loja)); }
          const rSd = await _fetch(SH_URLd + '/' + SHOPEE_LOJA + '/interno/pedidos-do-dia?horas=168&k=' + encodeURIComponent(SH_KEYd), { timeout: 90000 });   // b38: 168h = teto novo do serviço, cobre a retenção de 6 dias (Codex PR#14)
          if (!rSd.ok) {
            const corpoSd = await rSd.text().catch(() => '');
            _vsy.shopee_direto = { erro: 'HTTP ' + rSd.status + ' — ' + corpoSd.slice(0, 120), http: rSd.status, corpo: corpoSd.slice(0, 200), url: SH_URLd, detalhado: true, em: new Date().toISOString() };
            throw new Error('servico Shopee respondeu HTTP ' + rSd.status);
          }
          const jSd = await rSd.json().catch(() => null);
          if (jSd && jSd.ok && Array.isArray(jSd.pedidos)) {
            let novosS = 0;
            for (const pSd of jSd.pedidos) {
              if (!pSd || !pSd.order_sn) continue;
              const osn = String(pSd.order_sn);
              // b32 (mesmos 2 do Codex na fase ML): status ANTES do jaTem — cancelou
              // depois de entrar? a provisória morre. E UNPAID não é venda ainda.
              const stSd = String(pSd.order_status || '').toUpperCase();
              if (/CANCEL/.test(stSd)) { if (atual['sh:' + osn]) { delete atual['sh:' + osn]; } continue; }
              if (stSd === 'UNPAID') continue;
              if (jaTemS.has(osn)) continue;
              // Codex P2: create_time é epoch UTC — fatiar toISOString() direto joga venda
              // feita depois das 21h (horário de Brasília) pro dia SEGUINTE. O `data` (usado
              // pra agrupar por dia) precisa do fuso -03:00; hora_venda/venda_em continuam o
              // instante real, sem deslocar.
              const _dtSd = pSd.create_time ? new Date(Number(pSd.create_time) * 1000) : null;
              atual['sh:' + osn] = {
                id: 'sh:' + osn, sem_bling: true, det: true,
                numero: null, numero_loja: osn, marketplace: 'shopee',
                data: _dtSd ? new Date(_dtSd.getTime() - 3 * 3600000).toISOString().slice(0, 10) : null,
                hora_venda: _dtSd ? _dtSd.toISOString() : null,
                venda_em: _dtSd ? _dtSd.toISOString() : null,
                total: Number(pSd.total || 0),
                cliente: pSd.buyer || '',
                // Codex P2: o cache/dashboard leem item por `qtd`/`vt` (igual ML) — gravar em
                // `quantidade`/`valor` deixava a venda com 1 unidade e sem receita de item.
                it: (Array.isArray(pSd.itens) && pSd.itens.length) ? pSd.itens.map(x => ({ sku: x.sku, qtd: x.qtd, vt: x.valor })) : undefined,
                situacao: 'DIRETO DA SHOPEE (Bling ainda não importou)',
                atualizado_em: new Date().toISOString()
              };
              jaTemS.add(osn); novosS++;
            }
            _vsy.shopee_direto = { novos: novosS, listados: jSd.listados || jSd.pedidos.length, em: new Date().toISOString() };
            if (novosS) { writeJson(F, atual); console.log('[VENDAS-SYNC] shopee_direto: +' + novosS + ' venda(s) que o Bling ainda nao tem'); }
          } else if (jSd && jSd.erro) {
            _vsy.shopee_direto = { erro: String(jSd.erro).slice(0, 120), em: new Date().toISOString() };
          }
        }
      } catch (e) {
        // 11/08: falha da Shopee não pode virar SILÊNCIO — o status mostrava null e a
        // investigação ficava cega. O "Not Found" cru do Render (hostname inexistente)
        // quebrava no .json() e caía aqui sem deixar rastro.
        // b39 (Codex PR#16): se o bloco acima já guardou o diagnóstico RICO (status HTTP +
        // corpo da resposta + URL), este catch NÃO pode sobrescrever com a mensagem genérica
        // — o corpo é justamente o que identifica o hostname errado.
        if (!(_vsy.shopee_direto && _vsy.shopee_direto.detalhado)) {
          _vsy.shopee_direto = { erro: String(e.message || e).slice(0, 160), url: (cfg.shopeeUrlEnv || 'default no codigo'), em: new Date().toISOString() };
        }
        console.log('[VENDAS-SYNC] fase shopee_direto falhou: ' + String(e.message || e).slice(0, 120));
      }
      // ─── b31: VENDAS DO DIA DIRETO DA MAGALU ────────────────────────────────────
      // Via a rota local /magalu/pedidos-do-dia (módulo magalu-oauth, dono do token).
      // O campo do TOTAL é defensivo (estrutura não 100% mapeada) — se vier 0, a venda
      // aparece mesmo assim e o Bling completa o valor quando importar.
      _vsy.fase = 'mg_direto';
      try {
        const ADMd = process.env.ADMIN_KEY || '';
        const PORTd = process.env.PORT || 3000;
        if (ADMd) {
          const jaTemM = new Set();
          for (const v of Object.values(atual)) { if (v && v.numero_loja) jaTemM.add(String(v.numero_loja)); }
          const rMd = await _fetch('http://127.0.0.1:' + PORTd + '/magalu/pedidos-do-dia?empresa=' + MAG_EMPRESA + '&k=' + encodeURIComponent(ADMd) + '&desde=' + isoD(new Date(hoje.getTime() - 6 * 86400000)), { timeout: 90000 });   // b34: cobre a retenção de 6 dias
          const jMd = await rMd.json().catch(() => null);
          if (jMd && jMd.ok && Array.isArray(jMd.pedidos)) {
            let novosM2 = 0;
            for (const pMd of jMd.pedidos) {
              if (!pMd || !pMd.code) continue;
              const cod = String(pMd.code);
              const stMd = String(pMd.status || '').toLowerCase();
              if (/cancel/.test(stMd)) { if (atual['mg:' + cod]) { delete atual['mg:' + cod]; } continue; }
              if (jaTemM.has(cod)) continue;
              atual['mg:' + cod] = {
                id: 'mg:' + cod, sem_bling: true, det: true,
                numero: null, numero_loja: cod, marketplace: 'magalu',
                data: String(pMd.purchased_at || '').slice(0, 10) || null,
                hora_venda: pMd.purchased_at || null,
                total: Number(pMd.total || 0),
                cliente: pMd.cliente || '',
                // Codex P1: a rota local já manda os itens (sku/qtd/valor unitário) prontos
                // pro custeio; sem eles a venda direta da Magalu fica sem produto até o Bling
                // importar — o passo de detalhe não preenche (numero é null, mas det já é true).
                it: (Array.isArray(pMd.itens) && pMd.itens.length) ? pMd.itens.map(x => ({
                  sku: x.sku, d: x.desc || null, qtd: Number(x.qtd || 1),
                  vt: Math.round(Number(x.valor || 0) * Number(x.qtd || 1) * 100) / 100
                })) : undefined,
                situacao: 'DIRETO DA MAGALU (Bling ainda não importou)',
                atualizado_em: new Date().toISOString()
              };
              jaTemM.add(cod); novosM2++;
            }
            _vsy.mg_direto = { novos: novosM2, listados: jMd.total_listado || jMd.pedidos.length, em: new Date().toISOString() };
            if (novosM2) { writeJson(F, atual); console.log('[VENDAS-SYNC] mg_direto: +' + novosM2 + ' venda(s) que o Bling ainda nao tem'); }
          } else if (jMd && jMd.erro) {
            _vsy.mg_direto = { erro: String(jMd.erro).slice(0, 120), em: new Date().toISOString() };
          }
        }
      } catch (e) { console.log('[VENDAS-SYNC] fase mg_direto falhou: ' + String(e.message || e).slice(0, 120)); }
  };
}

module.exports = { criarFaseDireta };
