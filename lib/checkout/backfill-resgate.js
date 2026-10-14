'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   RESGATE DO HISTÓRICO — pedido que nasce HOJE com data de venda ANTIGA (14/10/2026).

   O caso que revelou o buraco: venda ML 2000018908624178 (Girassol, pedido 123645).
   O comprador clicou em 10/10 e pagou o boleto em 13/10. O Bling cria o pedido só
   quando o pagamento aprova (13/10), mas copia do ML a data do clique como "Data da
   venda" (10/10) — e é essa data que o dono decidiu manter (14/10: "data bling").
   A noturna faz o backfill dos ÚLTIMOS 3 DIAS filtrando o Bling por data da venda:
   na madrugada de 14/10 ela olha 11→14 e o pedido "de 10/10" fica de fora PARA
   SEMPRE. Vale pra toda venda de boleto/Pix que demora mais de 3 dias, nas três.

   Esta peça NÃO reescreve o backfill (que apaga o período e regrava): ela só
   descobre QUAIS DIAS têm pedido no Bling que não está no histórico e manda o
   backfill DE PRODUÇÃO rodar aquele dia inteiro de novo — o mesmo caminho de
   detalhe, escrow, custo, imposto e gravação. Sem segundo caminho, sem duplicata.

   Dois modos de descobrir:
     • por: 'alteracao' — lista o Bling por data de ALTERAÇÃO (dataAlteracaoInicial/
       Final, filtro real da API v3) e considera só pedido com data de venda ANTERIOR
       à janela (os de dentro o backfill normal já cobriu). É o modo de toda noite.
     • por: 'data' — lista por data da venda num período largo e confere tudo. É a
       varredura de domingo (galpão parado), que pega quem já ficou de fora.

   TETO de dias por rodada: cada dia resgatado é um backfill daquele dia (~100
   detalhes na Girassol), então a noite resgata até `maxDias` e anota o resto.
   ──────────────────────────────────────────────────────────────────────────── */

const dorme = ms => new Promise(r => setTimeout(r, ms));
const _dia = s => String(s || '').slice(0, 10);

async function listarBling(blingGet, qs, maxPg) {
  const vistos = [];
  for (let pg = 1; pg <= maxPg; pg++) {
    let r = null;
    for (let t = 1; t <= 3; t++) {
      r = await blingGet('/pedidos/vendas?' + qs + '&pagina=' + pg + '&limite=100');
      if (r && r.ok) break;
      await dorme(t * 2000);
    }
    if (!r || !r.ok) return { ok: false, erro: 'Bling respondeu ' + (r && r.status) + ' na página ' + pg, parcial: vistos };
    const arr = (r.data && r.data.data) || [];
    for (const p of arr) {
      if (!p) continue;
      vistos.push({ numero: String(p.numero != null ? p.numero : p.id), data: _dia(p.data), situacao: (p.situacao && p.situacao.id != null) ? Number(p.situacao.id) : null, numeroLoja: String(p.numeroLoja || '').trim() || null });
    }
    if (arr.length < 100) break;
    if (pg === maxPg) return { ok: false, erro: 'lista do Bling passou de ' + maxPg + ' páginas — varredura TRUNCADA, nada decidido', parcial: vistos };
    await dorme(350);
  }
  return { ok: true, pedidos: vistos };
}

/* quais destes números NÃO têm linha no histórico */
async function faltandoNoHistorico(supaReq, empresa, numeros) {
  const tem = new Set();
  for (let i = 0; i < numeros.length; i += 80) {
    const lote = numeros.slice(i, i + 80);
    const q = 'vendas_historico?empresa=eq.' + encodeURIComponent(empresa) +
              '&numero_pedido=in.(' + lote.map(encodeURIComponent).join(',') + ')&select=numero_pedido&limit=4000';
    const rr = await supaReq(empresa, 'GET', q, null);
    if (!rr || !rr.ok) return { ok: false, erro: 'Supabase respondeu ' + (rr && rr.status) + (rr && rr.erro ? ' — ' + rr.erro : '') };
    let arr = [];
    try { arr = JSON.parse(rr.body || '[]'); } catch (e) { return { ok: false, erro: 'Supabase devolveu corpo inválido' }; }
    if (!Array.isArray(arr)) return { ok: false, erro: 'Supabase devolveu algo que não é lista' };
    for (const l of arr) if (l && l.numero_pedido != null) tem.add(String(l.numero_pedido));
  }
  return { ok: true, faltam: numeros.filter(n => !tem.has(n)) };
}

/* ctx = { empresa, blingGet, supaReq, backfillVendas, backfillEstado?, reservar?, liberar?, situacoesCanceladas?, canceladosMkt?, cacheDir? }
   opts = { de, ate, por: 'alteracao'|'data', maxDias (padrão 5), maxPg (padrão 120), somenteListar } */
async function resgatar(ctx, opts) {
  const o = opts || {};
  const empresa = ctx && ctx.empresa;
  if (!empresa || !ctx.blingGet || !ctx.supaReq || !ctx.backfillVendas) return { ok: false, erro: 'contexto incompleto (empresa, blingGet, supaReq, backfillVendas)' };
  const de = _dia(o.de), ate = _dia(o.ate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate) || de > ate) return { ok: false, erro: 'período inválido: ' + de + ' a ' + ate };
  const por = o.por === 'data' ? 'data' : 'alteracao';
  const maxDias = Math.max(1, Math.min(30, Number(o.maxDias) || 5));
  /* Codex #683 (P1): dataAlteracaoInicial/Final sao DATA-HORA no contrato da API v3 (ao contrario
     de dataInicial/Final, que sao so data) — mandar so a data dava 400 e desligava o modo de
     toda noite. */
  const qs = por === 'alteracao'
    ? 'dataAlteracaoInicial=' + encodeURIComponent(de + ' 00:00:00') + '&dataAlteracaoFinal=' + encodeURIComponent(ate + ' 23:59:59')
    : 'dataInicial=' + de + '&dataFinal=' + ate;

  /* Codex #683 (P1): conferir se ha backfill em curso ANTES de encostar no Bling — a varredura
     de domingo sao ate 120 paginas, e rodar isso em cima de um mes de historico em andamento
     e exatamente o que a trava de exclusao existe pra evitar. */
  if (typeof ctx.backfillEstado === 'function') {
    const est0 = ctx.backfillEstado();
    if (est0 && est0.rodando) return { ok: false, erro: 'backfill em curso (' + (est0.de || '') + ' a ' + (est0.ate || '') + ') — não atropelo', por, de, ate, resgatados: [], adiados: [] };
  }
  /* Codex #683 r2 (P1): so OLHAR o estado deixa a corrida aberta — um backfill manual que começa
     durante a listagem (ate 120 paginas) disputaria a cota. Se a empresa oferece reserva da
     exclusao (ctx.reservar/ctx.liberar = o mesmo `_backfill.rodando` do backfill), a listagem
     roda RESERVADA; libero antes de chamar backfillVendas (que precisa da vaga) e no finally. */
  let reservado = false;
  if (typeof ctx.reservar === 'function') {
    reservado = !!ctx.reservar('resgate: listando o Bling (' + por + ' ' + de + ' a ' + ate + ')');
    if (!reservado) return { ok: false, erro: 'backfill em curso — não consegui reservar a vez', por, de, ate, resgatados: [], adiados: [] };
  }
  const liberar = () => { if (reservado && typeof ctx.liberar === 'function') { try { ctx.liberar(); } catch (e) {} reservado = false; } };
  try {
    return await _resgatarReservado(ctx, o, { empresa, de, ate, por, maxDias, qs, liberar });
  } finally { liberar(); }
}

async function _resgatarReservado(ctx, o, p) {
  const { empresa, de, ate, por, maxDias, qs, liberar } = p;
  /* Codex #683 (P1): o backfill de producao PULA pedido cancelado (situacao cancelada do Bling e
     cancelado no marketplace). Sem o mesmo filtro aqui, todo cancelado ficaria "faltando" pra
     sempre, o dia dele rodaria todo domingo e, com o teto de 5, os cancelados antigos
     engoliriam a fila e os pedidos de verdade nunca chegariam. Mesmas duas fontes do backfill. */
  let sitCanc = [];
  try { if (typeof ctx.situacoesCanceladas === 'function') sitCanc = (await ctx.situacoesCanceladas()) || []; } catch (e) { sitCanc = []; }
  const cancMkt = (typeof ctx.canceladosMkt === 'function') ? (ctx.canceladosMkt() || new Set()) : new Set();
  const ignorados = lerIgnorados(ctx);

  const lst = await listarBling(ctx.blingGet, qs, Number(o.maxPg) || 120);
  if (!lst.ok) return { ok: false, erro: lst.erro, por, de, ate };
  /* no modo alteração só interessa quem tem data de venda ANTES da janela: os de dentro o
     backfill normal (mesma janela, logo antes) já cobriu. Data vazia não dá pra situar — fica de fora, contada */
  let semData = 0, cancelados = 0, jaIgnorados = 0;
  const candidatos = lst.pedidos.filter(p => {
    if (!p.data) { semData++; return false; }
    if ((p.situacao != null && sitCanc.indexOf(Number(p.situacao)) >= 0) || (p.numeroLoja && cancMkt.has(p.numeroLoja))) { cancelados++; return false; }
    /* Codex #683 r2 (P1): ignorado so vale na varredura por DATA (domingo) e por 30 dias. No modo
       alteracao o pedido so aparece porque FOI alterado depois — tem que ser reconferido (o
       backfill pula pedido cujo detalhe veio sem itens e marca a rodada como limpa; se o Bling
       completar depois, a alteracao e a chance dele) */
    if (por === 'data' && ignorados[p.numero] && Date.parse(ignorados[p.numero].quando || 0) > Date.now() - 30 * 864e5) { jaIgnorados++; return false; }
    return por === 'alteracao' ? p.data < de : true;
  });
  const numeros = Array.from(new Set(candidatos.map(p => p.numero)));
  const base = { ok: true, por, de, ate, listados: lst.pedidos.length, candidatos: numeros.length, sem_data: semData, cancelados, ja_ignorados: jaIgnorados };

  const f = numeros.length ? await faltandoNoHistorico(ctx.supaReq, empresa, numeros) : { ok: true, faltam: [] };
  if (!f.ok) return Object.assign(base, { ok: false, erro: f.erro });
  const faltam = new Set(f.faltam);
  const porDia = {};
  for (const p of candidatos) if (faltam.has(p.numero)) (porDia[p.data] = porDia[p.data] || []).push(p.numero);
  /* Codex #683 r2 (P2): dia adiado pelo teto numa noite nao pode depender de o pedido ser
     alterado de novo pra reaparecer — fica em disco (_resgate_adiados.json) e entra na fila da
     proxima rodada, na frente */
  const adiadosAntes = lerAdiados(ctx);
  let vindosDoMemo = 0;
  for (const d of Object.keys(adiadosAntes)) {
    const nums = Array.isArray(adiadosAntes[d]) ? adiadosAntes[d].map(String) : [];
    if (!nums.length) continue;
    vindosDoMemo++;
    porDia[d] = Array.from(new Set((porDia[d] || []).concat(nums)));
  }
  const dias = Object.keys(porDia).sort();
  base.adiados_do_memo = vindosDoMemo;
  Object.assign(base, { faltando: f.faltam.length, dias: dias.map(d => ({ dia: d, pedidos: porDia[d] })) });
  if (o.somenteListar || !dias.length) return Object.assign(base, { resgatados: [], adiados: dias });
  liberar();   /* o backfill de cada dia precisa da vaga */

  const resgatados = [], adiados = [];
  let tentativas = 0, errosSeguidos = 0;
  for (let i = 0; i < dias.length; i++) {
    const d = dias[i];
    /* Codex #683 (P2): o teto conta TENTATIVAS, nao sucessos — falha generica repetida nao pode
       virar 60 backfills numa noite; e duas falhas seguidas param a rodada */
    if (tentativas >= maxDias) { adiados.push(d); continue; }
    tentativas++;
    let r = null;
    try { r = await ctx.backfillVendas(d, d, empresa); } catch (e) { r = { ok: false, msg: String(e.message || e) }; }
    /* só CONCLUSÃO conta como resgate (ok ou com_erros); adiado/abortado/erro deixa o dia na fila
       da próxima noite. Bling limitado ou backfill ocupado: parar a rodada, o resto fica adiado */
    /* Girassol/GOOD devolvem { ok, desfecho }; a AMB não devolve nada e deixa o resultado em
       backfillEstado().fase (concluido / concluido_com_erros / erro / abortado) — leio os dois.
       `adiado` sem ok:false é a AMB cedendo ao reparo de SKU. */
    let desf = r && r.desfecho;
    if (r === undefined && typeof ctx.backfillEstado === 'function') {
      const est = ctx.backfillEstado() || {};
      const meu = est.de === d && est.ate === d && !est.rodando;
      desf = !meu ? 'ja_rodando' : (est.fase === 'concluido' ? 'ok' : est.fase === 'concluido_com_erros' ? 'com_erros' : (est.fase || 'erro'));
      r = { ok: desf === 'ok' || desf === 'com_erros', desfecho: desf, msg: est.msg };
    }
    if (r && r.adiado && !desf) desf = 'adiado';
    if (r && r.ok !== false && desf !== 'abortado' && desf !== 'adiado' && desf !== 'ja_rodando' && desf !== 'erro') {
      /* Codex #683 (P1): "backfill do dia terminou" nao prova que O PEDIDO entrou — reconfere no
         Supabase. Ainda faltando depois de rodada LIMPA = o backfill o pulou de proposito (cancelado
         por outra regra, sem itens…): vai pro memo de ignorados e nao volta a ocupar a fila. Faltando
         depois de rodada COM ERROS = pode ter sido ele que falhou: dia fica adiado. */
      const re = await faltandoNoHistorico(ctx.supaReq, empresa, porDia[d]);
      if (!re.ok) { adiados.push(d); base.ultimo_erro = re.erro; errosSeguidos++; if (errosSeguidos >= 2) { adiados.push(...dias.slice(i + 1)); break; } await dorme(1500); continue; }
      if (!re.faltam.length) { resgatados.push(d); errosSeguidos = 0; await dorme(1500); continue; }
      if (desf === 'com_erros') { adiados.push(d); base.ultimo_erro = 'dia ' + d + ' rodou com erros e ' + re.faltam.length + ' pedido(s) seguem faltando'; errosSeguidos++; if (errosSeguidos >= 2) { adiados.push(...dias.slice(i + 1)); break; } await dorme(1500); continue; }
      anotarIgnorados(ctx, re.faltam, d);
      (base.ignorados_agora = base.ignorados_agora || []).push(...re.faltam);
      resgatados.push(d); errosSeguidos = 0; await dorme(1500); continue;
    }
    adiados.push(d);
    base.ultimo_erro = (r && (r.msg || r.erro || r.adiado || desf)) || 'sem resposta';
    errosSeguidos++;
    if (!r || desf === 'adiado' || desf === 'ja_rodando' || desf === 'abortado' || errosSeguidos >= 2) { adiados.push(...dias.slice(i + 1)); break; }
    await dorme(1500);
  }
  const memoNovo = {};
  for (const d of adiados) memoNovo[d] = porDia[d] || [];
  gravarAdiados(ctx, memoNovo);
  return Object.assign(base, { resgatados, adiados });
}

/* memo em disco (CACHE_DIR/_resgate_ignorados.json): pedido que o backfill limpo deixou de fora
   DE PROPOSITO. Sem ctx.cacheDir o memo nao existe e nada e lembrado (teste). */
function _arqIgn(ctx) { return (ctx && ctx.cacheDir) ? require('path').join(ctx.cacheDir, '_resgate_ignorados.json') : null; }
function lerIgnorados(ctx) {
  const a = _arqIgn(ctx); if (!a) return {};
  try { const j = JSON.parse(require('fs').readFileSync(a, 'utf8')); return (j && typeof j === 'object') ? j : {}; } catch (e) { return {}; }
}
function _arqAdi(ctx) { return (ctx && ctx.cacheDir) ? require('path').join(ctx.cacheDir, '_resgate_adiados.json') : null; }
function lerAdiados(ctx) {
  const a = _arqAdi(ctx); if (!a) return {};
  try { const j = JSON.parse(require('fs').readFileSync(a, 'utf8')); return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {}; } catch (e) { return {}; }
}
function gravarAdiados(ctx, memo) {
  const a = _arqAdi(ctx); if (!a) return;
  try { require('fs').writeFileSync(a, JSON.stringify(memo || {})); } catch (e) {}
}
function anotarIgnorados(ctx, numeros, dia) {
  const a = _arqIgn(ctx); if (!a || !numeros.length) return;
  try {
    const j = lerIgnorados(ctx);
    for (const n of numeros) j[n] = { dia, quando: new Date().toISOString() };
    require('fs').writeFileSync(a, JSON.stringify(j));
  } catch (e) {}
}

/* 3 dias por ALTERAÇÃO toda noite; no DOMINGO (fuso de SP, galpão parado) 60 dias por data
   da venda, que pega quem já ficou de fora. Envs opcionais: RESGATE_DIAS_NOTURNA (3),
   RESGATE_DIAS_SEMANAL (60), RESGATE_MAX_DIAS (5) */
function planoDaNoturna(agoraMs) {
  const _n = (v, pad, teto) => { const x = Math.floor(Number(v)); return (isFinite(x) && x >= 1) ? Math.min(teto, x) : pad; };
  const ms = (agoraMs == null || !isFinite(Number(agoraMs))) ? Date.now() : Number(agoraMs);
  /* Codex #683 r2 (P2): o calendario e UM so — o de Sao Paulo. Dia da semana E as datas do
     periodo saem do mesmo relogio deslocado (−3h), senao as 23h de domingo o periodo pulava um dia */
  const msSP = ms - 3 * 3600 * 1000;
  const domingoSP = new Date(msSP).getUTCDay() === 0;
  const iso = d => new Date(msSP - d * 864e5).toISOString().slice(0, 10);
  const maxDias = _n(process.env.RESGATE_MAX_DIAS, 5, 30);
  if (domingoSP) { const n = _n(process.env.RESGATE_DIAS_SEMANAL, 60, 120); return { por: 'data', de: iso(n), ate: iso(0), maxDias, rotulo: n + ' dias por data da venda' }; }
  const n = _n(process.env.RESGATE_DIAS_NOTURNA, 3, 30);
  return { por: 'alteracao', de: iso(n), ate: iso(0), maxDias, rotulo: n + ' dias por alteração' };
}

module.exports = { resgatar, listarBling, faltandoNoHistorico, planoDaNoturna };

