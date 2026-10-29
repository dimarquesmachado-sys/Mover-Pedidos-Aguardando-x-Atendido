'use strict';
/* FIXTURE (29/10/2026): o bloco da caça de vendas da Magalu da AMB (amb-checkout-offline/index.js) ANTES de virar a peça
   lib/checkout/magalu-caca — o mesmo texto, embrulhado numa fábrica com as variáveis de fora como parâmetros, pra o teste
   rodar o antigo e o novo nos mesmos dados. Não é usado em produção. */
module.exports = function criarAntigo(dep) {
  const { fetch, path, readJson, CACHE_DIR, blingGet, supaReq, magaluFreteSkuLer, _histCache } = dep;
  const DEFAULT_ALIQ_BK = dep.DEFAULT_ALIQ_BK;
  let _reparoAtivo = false;
  const setReparo = (v) => { _reparoAtivo = v; };
// ─── 🛒 CAÇA DA MAGALU (11/08) ────────────────────────────────────────────────
// POR QUE EXISTE: em julho o Jodda tinha 235 pedidos Magalu (R$ 37.503) e o nosso
// histórico só 119 (R$ 17.469) — METADE do mês nunca chegou. Causa: no Magalu Full
// quem emite a NF é a Magalu, e o pedido só entra no Bling quando o XML é importado
// à mão. O que não desceu, não existe pro Bling — e some do faturamento.
// O QUE FAZ: pergunta À MAGALU o que ela vendeu no período, compara com o que já
// está no Supabase e grava SÓ o que falta. Não apaga nada: é aditivo, então rodar
// de novo não duplica (a checagem é pelo numero_loja).
let _mgc = { rodando: false, em: null, de: null, ate: null, na_magalu: 0, ja_tinha: 0, inseridos: 0, linhas: 0, removidos_cancelados: 0, erro: null, parcial: false };

// Busca os pedidos da Magalu do período e devolve LINHAS prontas pro vendas_historico.
// Usada em DOIS lugares (Codex PR#25 P1): pela caça horária e pelo backfillVendas — porque
// o backfill apaga o período e reconstrói, e sem isso ele apagaria justamente o que a caça
// recuperou (as vendas que o Bling não tem), recriando o buraco a cada rodada.
async function magaluLinhas(de, ate, empresa, jaTem) {
  const dorme2 = ms => new Promise(r => setTimeout(r, ms));
  const out = { linhas: [], pedidos: 0, na_magalu: 0, parcial: false, erro: null, cancelados: [], suspeitos: [] };
  const ADM = process.env.ADMIN_KEY || '';
  if (!ADM) { out.erro = 'sem ADMIN_KEY'; return out; }
  const PORT_L = process.env.PORT || 3000;
  const base = 'http://127.0.0.1:' + PORT_L + '/magalu/';
  const emp = encodeURIComponent(process.env.AMBBKP_MAGALU_EMPRESA || 'amb');
  const r = await fetch(base + 'pedidos-do-dia?empresa=' + emp + '&k=' + encodeURIComponent(ADM) +
                        '&desde=' + de + '&ate=' + ate + '&paginas=40', { timeout: 120000 });
  const j = await r.json().catch(() => null);
  if (!j || !j.ok || !Array.isArray(j.pedidos)) { out.erro = 'rota da Magalu: ' + ((j && j.erro) || ('HTTP ' + r.status)); return out; }
  out.parcial = Boolean(j.parcial || j.truncado);
  out.na_magalu = j.pedidos.length;

  const cfgF = readJson(path.join(CACHE_DIR, '_config-fiscal.json'), { aliquotas: {}, taxas: {} });
  const aliqDe2 = m => { const a = cfgF.aliquotas && cfgF.aliquotas[m];
    if (a != null && isFinite(Number(a)) && Number(a) > 0) return Number(a);   // 19/08: 0% salvo era campo em branco — cai no padrão
    return (DEFAULT_ALIQ_BK && DEFAULT_ALIQ_BK[m] != null) ? Number(DEFAULT_ALIQ_BK[m]) : 0; };
  const custos = readJson(path.join(CACHE_DIR, '_custos.json'), {});
  const cUn2 = sk => { const c = custos[String(sk || '').trim()]; return (c && c.custo != null && isFinite(Number(c.custo))) ? Number(c.custo) : null; };
  const pctMag = Number((cfgF.taxas && cfgF.taxas.magalu) || 0);

  // separa os que interessam: dentro da janela e não cancelados
  const vivos = [];
  for (const p of j.pedidos) {
    const cod = String(p.code || '').trim(); if (!cod) continue;
    const dv = String(p.purchased_at || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dv) || dv < de || dv > ate) continue;
    // (Codex P1) status é olhado ANTES do jaTem: pedido que cancelou DEPOIS de gravado
    // precisa sair do histórico, senão fica somando faturamento pra sempre.
    if (/cancel/i.test(String(p.status || ''))) { out.cancelados.push(cod); continue; }
    if (jaTem && jaTem.has(cod)) continue;
    // 11/08 GUARDA DE SANIDADE: um pedido acima de R$ 20.000 nesta operação é sinal de
    // formato mudado (foi o caso dos centavos, que jogaram julho pra R$ 1,87 milhão).
    // Melhor deixar a venda de fora e GRITAR do que gravar número absurdo no histórico.
    const totP = Number(p.total) || 0;
    if (totP > 20000) { out.suspeitos.push({ code: cod, total: totP, fonte: p.total_fonte || null }); continue; }
    vivos.push(Object.assign({}, p, { _dv: dv, _cod: cod, _uuid: String(p.id || '').trim() }));   // 13/08: o Bling grava o UUID (id) da Magalu no numeroPedidoLoja, não o code
  }

  // (Codex P1) FRETE de coparticipação: a Magalu cobra e isso é custo do vendedor. Vem da
  // mesma rota /magalu/financeiro-lote que o sync já usa. Sem isto a margem das vendas
  // recuperadas sairia inflada — justo as que este recurso existe pra corrigir.
  const freteDe = {}, comReal = {};
  for (let i0 = 0; i0 < vivos.length; i0 += 50) {
    const lote = vivos.slice(i0, i0 + 50).map(v => v._cod);
    try {
      const rf = await fetch(base + 'financeiro-lote?empresa=' + emp + '&k=' + encodeURIComponent(ADM) +
                             '&dias=180&codes=' + encodeURIComponent(lote.join(',')), { timeout: 90000 });
      const jf = await rf.json().catch(() => null);
      if (jf && jf.ok && jf.pedidos) {
        for (const [cod, fin] of Object.entries(jf.pedidos)) {
          if (!fin) continue;
          if (fin.frete_debito) freteDe[cod] = Math.abs(Number(fin.frete_debito) || 0);
          const tx = Math.abs(Number(fin.comissao) || 0) + Math.abs(Number(fin.mdr) || 0) + Math.abs(Number(fin.tarifa_fixa) || 0);
          if (tx > 0) comReal[cod] = Math.round(tx * 100) / 100;
        }
      }
    } catch (e) {}
    await dorme2(200);
  }

  // ── 13/08 (regra do Diego): "todos os produtos são cadastrados no Bling; só então
  // exportamos pros marketplaces. Se tem venda, tem o SKU cadastrado no Bling."
  // A caça lia os itens da API da MAGALU, que às vezes devolve o pedido sem itens ou sem
  // código — e a linha ia pro histórico com sku:null. Resultado medido em julho/2026: 116
  // unidades e R$ 16.390 sem SKU, portanto SEM custo e SEM margem, subestimando o lucro.
  // Agora, quando falta SKU, os itens vêm do BLING (mesma fonte que a Girassol usa): o
  // pedido é encontrado pelo numeroPedidoLoja dentro do dia da venda, e o item vira
  // codigo/descricao/quantidade/valor do Bling. Sem pedido no Bling, NÃO grava linha
  // fantasma: conta em `sem_no_bling` pra aparecer como pendência.
  const _diaCache = {};
  const _bgM = async (pth) => { for (let t = 0; t < 3; t++) { const r = await blingGet(pth); if (r && r.ok) return r; await dorme2(1200 + t * 600); } return await blingGet(pth); };
  async function itensDoBlingPorNumeroLoja(chaves, diaISO) {
    // 13/08 — MEDIDO: a 1ª rodada devolveu sem_no_bling 116 de 116. Motivo: o pedido da Magalu
    // tem DOIS identificadores — `code` numérico (que vira MG-<code> no histórico) e `id` UUID.
    // O Bling grava o UUID no numeroPedidoLoja (as NFs mostram "Origem MagaluOpenApi (uuid)").
    // Procurávamos pelo code, então nunca casava. Agora tenta as duas chaves, UUID primeiro.
    const lista = (Array.isArray(chaves) ? chaves : [chaves]).map(x => String(x || '').trim()).filter(Boolean);
    if (!lista.length || !/^\d{4}-\d{2}-\d{2}$/.test(String(diaISO || ''))) return null;
    if (!_diaCache[diaISO]) {
      const mapa = {};
      for (let pg = 1; pg <= 12; pg++) {
        const r = await _bgM('/pedidos/vendas?dataInicial=' + diaISO + '&dataFinal=' + diaISO + '&pagina=' + pg + '&limite=100');
        const lote = (r && r.ok && r.data && r.data.data) || [];
        for (const pd of lote) { const nl = String((pd && (pd.numeroLoja || pd.numeroPedidoLoja)) || '').trim(); if (nl && !mapa[nl]) mapa[nl] = pd.id; }
        if (lote.length < 100) break;
        await dorme2(350);
      }
      _diaCache[diaISO] = mapa;
    }
    let idBling = null;
    for (const ch of lista) { if (_diaCache[diaISO][ch]) { idBling = _diaCache[diaISO][ch]; break; } }
    if (!idBling) return null;
    const rd = await _bgM('/pedidos/vendas/' + idBling);
    const det = (rd && rd.ok && rd.data && rd.data.data) || null;
    if (!det || !Array.isArray(det.itens) || !det.itens.length) return null;
    return det.itens.map(i2 => ({
      sku: String((i2.codigo || (i2.produto && i2.produto.codigo) || '')).trim() || null,
      desc: String((i2.descricao || (i2.produto && i2.produto.nome) || '')).slice(0, 120) || null,
      qtd: Number(i2.quantidade) || 1,
      valor: Number(i2.valor) || 0
    })).filter(x => x.sku || x.valor);
  }

  out.enriquecidos_bling = 0; out.sem_no_bling = 0;
  for (const p of vivos) {
    const cod = p._cod, dv = p._dv;
    let its = Array.isArray(p.itens) && p.itens.length ? p.itens : [];
    if (!its.length || its.some(x => !x || !x.sku)) {
      let doBling = null;
      try { doBling = await itensDoBlingPorNumeroLoja([p._uuid, cod], dv); } catch (e) {}
      if (doBling && doBling.length) { its = doBling; out.enriquecidos_bling++; }
      else if (!its.length || its.every(x => !x || !x.sku)) { out.sem_no_bling++; continue; }
    }
    const soma = its.reduce((a, x) => a + (Number(x.valor) || 0) * (Number(x.qtd) || 1), 0);
    const totPed = Number(p.total) || soma;
    const aq = aliqDe2(dv.slice(0, 7));
    const comTot = comReal[cod] != null ? comReal[cod] : (pctMag > 0 ? Math.round(totPed * pctMag / 100 * 100) / 100 : 0);
    /* 20/08 — mesma correção de raiz: quando o financeiro da Magalu ainda não trouxe o frete
       real, grava o PREVISTO (média do frete real por SKU) em vez de zero. O real substitui
       quando o pedido liquida. */
    let freTot = freteDe[cod] != null ? freteDe[cod] : 0;
    if (!(freTot > 0)) {
      /* Acerto (Codex #226 final): a média é o PACOTE — um por pedido, decidido como no leitor
         (1º item por SKU com banco), em vez de somar media×qtd e persistir inflado. */
      const _bf = magaluFreteSkuLer();
      let _sp = 0;
      const _skOrd = its.map(x => String(x.sku || '').trim()).filter(Boolean).sort((a, b) => a.localeCompare(b));
      for (const sk of _skOrd) { const b = _bf[sk]; const m = b && Number(b.media); if (m > 0) { _sp = m; break; } }
      if (_sp > 0) freTot = Math.round(_sp * 100) / 100;
    }
    for (const x of its) {
      const q2 = Number(x.qtd) || 1;
      const vt = Math.round((Number(x.valor) || 0) * q2 * 100) / 100;
      const frac = soma > 0 ? (vt / soma) : (1 / Math.max(1, its.length));
      const vnota = Math.round(totPed * frac * 100) / 100;
      const cu = cUn2(x.sku);
      const custo = cu != null ? Math.round(cu * q2 * 100) / 100 : null;
      const com = Math.round(comTot * frac * 100) / 100;
      const fre = Math.round(freTot * frac * 100) / 100;
      const imp = Math.round(vnota * aq / 100 * 100) / 100;
      const mg = custo != null ? Math.round((vt - custo - com - fre - imp) * 100) / 100 : null;
      out.linhas.push({ empresa, numero_pedido: 'MG-' + cod, numero_loja: cod, canal: 'magalu',
        data_venda: dv, sku: x.sku || null, descricao: (x.desc || null),
        quantidade: q2, valor_produto: vt, valor_nota: vnota, custo,
        comissao: com, frete_vendedor: fre, imposto: imp, margem: mg });
    }
    out.pedidos++;
  }
  return out;
}

async function cacaMagalu(de, ate, empresa, opts) {
  const dorme = ms => new Promise(r => setTimeout(r, ms));
  empresa = empresa || 'amb';
  if (_mgc.rodando) return _mgc;
  /* A caça também apaga e reinsere linhas do vendas_historico (ainda mais com ?refazer=1), então
     pode RECRIAR o SKU antigo por cima do PATCH do reparo. Aqui dentro pelo mesmo motivo do
     backfill: o cron horário chama esta função direto, sem passar por rota. */
  if (_reparoAtivo) {
    console.log('[MAGALU] adiada: reparo de SKU em andamento (mexe nas mesmas linhas)');
    return Object.assign({}, _mgc, { adiado: 'reparo de SKU em andamento' });
  }
  _mgc = { rodando: true, em: new Date().toISOString(), de, ate, na_magalu: 0, ja_tinha: 0, inseridos: 0, linhas: 0, removidos_cancelados: 0, erro: null, parcial: false };
  try {
    const jaTem = new Set();
    for (let pg = 0; pg < 20; pg++) {
      const q = 'vendas_historico?empresa=eq.' + encodeURIComponent(empresa) + '&canal=eq.magalu' +
                '&data_venda=gte.' + de + '&data_venda=lte.' + ate +
                '&select=numero_loja&limit=1000&offset=' + (pg * 1000);
      const rr = await supaReq(empresa, 'GET', q, null);
      if (!rr.ok) throw new Error('Supabase ' + rr.status);
      let arr = []; try { arr = JSON.parse(rr.body || '[]'); } catch (e) {}
      for (const l of arr) if (l && l.numero_loja) jaTem.add(String(l.numero_loja));
      if (arr.length < 1000) break;
    }
    _mgc.ja_tinha = jaTem.size;

    // ── 13/08 — REFAZER as linhas ruins (?refazer=1). A caça só grava pedido NOVO, então as
    // linhas de julho gravadas SEM SKU (canal magalu, sku nulo) eram puladas por já existirem.
    // Com ?refazer=1: acha no histórico os pedidos magalu SEM SKU do período, tira do jaTem
    // (pra serem reprocessados com os itens do Bling) e APAGA as linhas velhas antes de gravar
    // as novas — senão o pedido ficaria duplicado (a linha ruim + a boa).
    const refazer = Boolean(opts && opts.refazer);
    _mgc.refazendo = refazer; _mgc.refazer_alvos = 0;
    const paraRefazer = new Set();
    if (refazer) {
      for (let pg = 0; pg < 20; pg++) {
        const q = 'vendas_historico?empresa=eq.' + encodeURIComponent(empresa) + '&canal=eq.magalu' +
                  '&data_venda=gte.' + de + '&data_venda=lte.' + ate + '&or=(sku.is.null,sku.eq.)' +
                  '&select=numero_loja&limit=1000&offset=' + (pg * 1000);
        const rr = await supaReq(empresa, 'GET', q, null);
        if (!rr.ok) throw new Error('Supabase (refazer) ' + rr.status);
        let arr = []; try { arr = JSON.parse(rr.body || '[]'); } catch (e) {}
        for (const l of arr) if (l && l.numero_loja) { paraRefazer.add(String(l.numero_loja)); jaTem.delete(String(l.numero_loja)); }
        if (arr.length < 1000) break;
      }
      _mgc.refazer_alvos = paraRefazer.size;
    }

    const res2 = await magaluLinhas(de, ate, empresa, jaTem);
    if (res2.erro) throw new Error(res2.erro);
    _mgc.na_magalu = res2.na_magalu; _mgc.parcial = res2.parcial; _mgc.inseridos = res2.pedidos;
    if (res2.suspeitos && res2.suspeitos.length) {
      _mgc.suspeitos = res2.suspeitos.slice(0, 20);
      _mgc.aviso = res2.suspeitos.length + ' pedido(s) com valor absurdo (>R$20k) foram DEIXADOS DE FORA — confira o formato do valor na API';
      console.log('[CACA-MAGALU] ⚠️ ' + _mgc.aviso);
    }

    // (Codex P1) cancelado DEPOIS de gravado: apaga do histórico
    for (const cod of res2.cancelados) {
      // Codex PR#51: alvo de refazer saiu do jaTem, mas se foi CANCELADO na Magalu a receita
      // velha tem que sumir igual — senão o refazer deixaria no histórico o que a rodada
      // normal apagaria.
      if (!jaTem.has(cod) && !paraRefazer.has(cod)) continue;
      const del = await supaReq(empresa, 'DELETE', 'vendas_historico?empresa=eq.' + encodeURIComponent(empresa) + '&canal=eq.magalu&numero_loja=eq.' + encodeURIComponent(cod), null);
      if (del.ok) _mgc.removidos_cancelados++;
      await dorme(80);
    }
    // 13/08: mostra no status quantos pedidos tiveram os itens buscados no BLING (regra do
    // Diego: se tem venda, tem SKU no Bling) e quantos ficaram sem pedido no Bling — estes
    // NÃO viram linha, aparecem aqui como pendência pra investigar.
    _mgc.enriquecidos_bling = res2.enriquecidos_bling || 0;
    _mgc.sem_no_bling = res2.sem_no_bling || 0;
    // ── Codex PR#51: TROCA SEGURA, pedido a pedido ────────────────────────────────────
    // Antes: apagava tudo e depois inseria em lote. Se um POST falhasse no meio, o pedido
    // ficava SEM linha nenhuma no histórico (sumia do faturamento); e um DELETE que falhasse
    // em silêncio deixava linha velha + nova (duplicada).
    // Agora, para cada alvo: guarda as linhas antigas → apaga (só segue se o apagar deu certo)
    // → grava as novas → se a gravação falhar, RESTAURA as antigas e conta o erro.
    // E só é elegível o alvo cujas linhas novas têm TODAS o SKU preenchido — pedido que
    // voltaria com item sem SKU fica intocado e é reportado como pendência.
    const porPedido = {};
    for (const l of res2.linhas) { const k = String(l.numero_loja); (porPedido[k] = porPedido[k] || []).push(l); }
    const completas = c => c.length > 0 && c.every(l => String(l.sku || '').trim() !== '');
    _mgc.refazer_apagados = 0; _mgc.refazer_trocados = 0; _mgc.refazer_incompletos = 0; _mgc.refazer_falhas = 0;
    const jaGravados = new Set();

    if (refazer && paraRefazer.size) {
      for (const cod of paraRefazer) {
        const novas = porPedido[String(cod)];
        if (!novas || !novas.length) continue;                       // sem substituto: não mexe
        if (!completas(novas)) { _mgc.refazer_incompletos++; jaGravados.add(String(cod)); continue; }
        const qs = 'vendas_historico?empresa=eq.' + encodeURIComponent(empresa) + '&canal=eq.magalu&numero_loja=eq.' + encodeURIComponent(cod);
        // Codex PR#51 (2ª rodada): SEM cópia de segurança válida, não apaga. Se o GET falhar
        // ou vier corrompido, a restauração seria impossível e o pedido sumiria do histórico
        // pra sempre — o oposto do que este modo existe pra fazer.
        let antigas = null;
        try { const rOld = await supaReq(empresa, 'GET', qs + '&select=*', null); if (rOld.ok) { const j0 = JSON.parse(rOld.body || 'null'); if (Array.isArray(j0)) antigas = j0; } } catch (e) { antigas = null; }
        if (!antigas || !antigas.length) { _mgc.refazer_sem_backup = (_mgc.refazer_sem_backup || 0) + 1; jaGravados.add(String(cod)); continue; }
        const del = await supaReq(empresa, 'DELETE', qs, null);
        if (!del.ok) {
          // Codex PR#51 (3ª rodada): DELETE com resposta perdida (timeout/socket) volta ok:false
          // mesmo tendo apagado — sair aqui removeria o pedido do histórico pra sempre. Então
          // CONFERE o estado real antes de decidir: se as linhas sumiram, segue a troca; se
          // continuam lá, não apagou mesmo e o pedido fica intocado.
          // Codex PR#51 (4ª rodada): se a conferência TAMBÉM cair, o estado fica desconhecido —
          // e abandonar aí pode ter apagado o pedido pra sempre. Insiste algumas vezes antes de
          // desistir; sem resposta, o pedido entra em `refazer_indefinidos` com o snapshot em
          // memória registrado no log, pra conserto manual (restaurar às cegas duplicaria caso
          // o DELETE não tenha acontecido).
          let aindaTem = null;
          for (let tv = 0; tv < 6 && aindaTem === null; tv++) {
            if (tv) await dorme(1200 + tv * 800);
            try { const rChk = await supaReq(empresa, 'GET', qs + '&select=numero_loja', null); if (rChk.ok) { const j1 = JSON.parse(rChk.body || 'null'); if (Array.isArray(j1)) aindaTem = j1.length; } } catch (e) { aindaTem = null; }
          }
          if (aindaTem === null) {
            (_mgc.refazer_indefinidos = _mgc.refazer_indefinidos || []).push(String(cod));
            console.log('[CACA-MAGALU] ⚠️ estado indefinido no pedido ' + cod + ' — snapshot tinha ' + antigas.length + ' linha(s); conferir no histórico');
            jaGravados.add(String(cod)); continue;
          }
          if (aindaTem > 0) { _mgc.refazer_falhas++; jaGravados.add(String(cod)); continue; }
          _mgc.refazer_delete_ambiguo = (_mgc.refazer_delete_ambiguo || 0) + 1;   // apagou de fato: segue e grava as novas
        }
        _mgc.refazer_apagados++;
        const ins = await supaReq(empresa, 'POST', 'vendas_historico', novas);
        if (!ins.ok) {
          // Codex PR#51 (4ª rodada): o POST pode ter GRAVADO e só a resposta ter se perdido —
          // restaurar às cegas colocaria as linhas velhas AO LADO das novas (receita dobrada e
          // o SKU vazio de volta). Confere o que está no banco antes de decidir.
          let jaEntrou = null;
          for (let tv = 0; tv < 6 && jaEntrou === null; tv++) {
            if (tv) await dorme(1200 + tv * 800);
            try { const rChk2 = await supaReq(empresa, 'GET', qs + '&select=numero_loja', null); if (rChk2.ok) { const j2 = JSON.parse(rChk2.body || 'null'); if (Array.isArray(j2)) jaEntrou = j2.length; } } catch (e) { jaEntrou = null; }
          }
          if (jaEntrou !== null && jaEntrou > 0) { _mgc.linhas += novas.length; _mgc.refazer_trocados++; }   // gravou: nada a restaurar
          else if (jaEntrou === 0) {
            _mgc.refazer_falhas++;
            let voltou = false;
            try { const rb = await supaReq(empresa, 'POST', 'vendas_historico', antigas.map(x => { const y = Object.assign({}, x); delete y.id; return y; })); voltou = Boolean(rb && rb.ok); } catch (e) { voltou = false; }
            if (!voltou) { (_mgc.refazer_perdidos = _mgc.refazer_perdidos || []).push(String(cod)); }
          } else {
            _mgc.refazer_falhas++;
            (_mgc.refazer_indefinidos = _mgc.refazer_indefinidos || []).push(String(cod));
            console.log('[CACA-MAGALU] ⚠️ gravação indefinida no pedido ' + cod + ' — conferir no histórico antes de rodar de novo');
          }
        } else { _mgc.linhas += novas.length; _mgc.refazer_trocados++; }
        jaGravados.add(String(cod));
        await dorme(120);
      }
    }

    const restantes = res2.linhas.filter(l => !jaGravados.has(String(l.numero_loja)));
    for (let i0 = 0; i0 < restantes.length; i0 += 200) {
      const lote = restantes.slice(i0, i0 + 200);
      const ins = await supaReq(empresa, 'POST', 'vendas_historico', lote);
      if (!ins.ok) throw new Error('gravação: status ' + ins.status + ' ' + String(ins.body || '').slice(0, 120));
      _mgc.linhas += lote.length;
      await dorme(120);
    }
    try { for (const k of Object.keys(_histCache)) delete _histCache[k]; } catch (e) {}
    if (_mgc.inseridos || _mgc.removidos_cancelados) console.log('[CACA-MAGALU] +' + _mgc.inseridos + ' pedido(s) / ' + _mgc.linhas + ' linha(s), -' + _mgc.removidos_cancelados + ' cancelado(s) (' + de + ' a ' + ate + ')');
  } catch (e) {
    _mgc.erro = String(e.message || e).slice(0, 200);
    console.log('[CACA-MAGALU] falhou: ' + _mgc.erro);
  }
  _mgc.rodando = false;
  _mgc.fim = new Date().toISOString();
  return _mgc;
}

// roda de hora em hora: pega os últimos 3 dias (cobre o que a Magalu registrar com atraso)
async function cacaMagaluCron() {
  const isoD = dt => dt.toISOString().slice(0, 10);
  const hoje = new Date();
  const ini = new Date(hoje); ini.setDate(ini.getDate() - 3);
  return cacaMagalu(isoD(ini), isoD(hoje), 'amb');
}
  return { magaluLinhas, cacaMagalu, cacaMagaluCron, estado: () => _mgc, setReparo };
};
