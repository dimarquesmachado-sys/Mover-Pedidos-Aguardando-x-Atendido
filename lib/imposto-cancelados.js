// ════════════════════════════════════════════════════════════════════════════════════════
//  lib/imposto-cancelados.js — reaplicarImposto + varrerCancelados (25/08)
// ════════════════════════════════════════════════════════════════════════════════════════
//  As duas estavam escritas DUAS VEZES, byte a byte iguais entre
//  amb-checkout-offline/index.js e girassol-backup-offline/gbo-app.js. A única diferença
//  era a empresa padrão ('amb' × 'girassol') — agora vem por parâmetro, igual ao que a
//  lib/supabase.js fez no PR #188. São 120 linhas que deixam de existir em dobro.
//
//  ctx = { blingGet, readJson, log, garantirToken, garantirSitCancel, supaCfg,
//          path, CACHE_DIR, DEFAULT_ALIQ_BK, histCache }
//  (supaCfg vem de lib/supabase.js nos dois chamadores; a lib não o inventa)
//
//  A empresa é SEMPRE parâmetro explícito — sem padrão embutido, de propósito: um padrão
//  aqui dentro escolheria silenciosamente o Supabase de uma das empresas se o chamador
//  esquecesse de passar, e foi exatamente esse tipo de vazamento entre empresas que
//  apareceu no cache do catálogo em lib/custo.js.
// ════════════════════════════════════════════════════════════════════════════════════════

/* ⚠️ ESTADO POR EMPRESA. As duas funções tinham `let _reap` / `let _varre` no escopo do
   arquivo de cada empresa. Com uma variável só do módulo, AMB e Girassol dividiriam a
   mesma trava: reaplicar numa faria a outra responder "já rodando", e o painel de uma
   mostraria o progresso da outra. Não existia antes — é risco CRIADO pela extração, o
   mesmo do cache do catálogo em lib/custo.js e do _reapC/_varFor em lib/vendas-ops.js.
   O detector de órfãos do PR #190 apontou os 49 usos soltos aqui ANTES de eu abrir o PR. */
const _reapPorEmp  = new Map();
const _varrePorEmp = new Map();
const _reapVazio  = () => ({ rodando:false, meses:[], mesAtual:null, linhas:0, atualizadas:0, erros:0, inicio:null, fim:null, msg:'' });
const _varreVazio = () => ({ rodando:false, dias:0, encontrados:0, apagados:0, erros:0, inicio:null, fim:null, situacoes:[], msg:'' });
function estadoReaplicarImposto(empresa) {
  const k = String(empresa || '?');
  if (!_reapPorEmp.has(k)) _reapPorEmp.set(k, _reapVazio());
  return _reapPorEmp.get(k);
}
function estadoVarrerCancelados(empresa) {
  const k = String(empresa || '?');
  if (!_varrePorEmp.has(k)) _varrePorEmp.set(k, _varreVazio());
  return _varrePorEmp.get(k);
}

async function reaplicarImposto(ctx, meses, empresa){
  if (!empresa) throw new Error('reaplicarImposto: empresa é obrigatória (ver o cabeçalho da lib)');
  const _k = String(empresa);
  let _reap = estadoReaplicarImposto(_k);
  const _setReap = (o) => { _reapPorEmp.set(_k, o); _reap = o; return o; };
  if (_reap.rodando) return _reap;
  const { url, key } = ctx.supaCfg(empresa);
  if (!url || !key) { _reap.msg = 'Supabase não configurado'; return _reap; }
  const H = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  const base = url.replace(/\/+$/, '') + '/rest/v1/vendas_historico';
  const cfg = ctx.readJson(ctx.path.join(ctx.CACHE_DIR, '_config-fiscal.json'), { aliquotas: {} });
  const aliqDe = m => { const a = cfg.aliquotas && cfg.aliquotas[m];
    if (a != null && isFinite(Number(a)) && Number(a) > 0) return Number(a);   // 19/08: 0% salvo era campo em branco — cai no padrão
    return (ctx.DEFAULT_ALIQ_BK && ctx.DEFAULT_ALIQ_BK[m] != null) ? Number(ctx.DEFAULT_ALIQ_BK[m]) : null; };

  _setReap({ rodando:true, meses:meses.slice(), mesAtual:null, linhas:0, atualizadas:0, erros:0,
            inicio:new Date().toISOString(), fim:null, msg:'' });
  console.log('[FISCAL] reaplicando imposto em: ' + meses.join(', '));
  try {
    for (const mes of meses) {
      _reap.mesAtual = mes;
      const aq = aliqDe(mes);
      if (aq == null) { console.log('[FISCAL] ' + mes + ': sem alíquota — pulando'); continue; }
      const ini = mes + '-01';
      const d2 = new Date(Number(mes.slice(0,4)), Number(mes.slice(5,7)), 0);
      const fim = mes + '-' + String(d2.getDate()).padStart(2,'0');
      let off = 0;
      while (off < 200000) {
        const rq = await fetch(base + '?empresa=eq.' + empresa + '&data_venda=gte.' + ini + '&data_venda=lte.' + fim +
          '&select=id,valor_nota,imposto,margem&order=data_venda.asc,numero_pedido.asc,sku.asc&limit=500&offset=' + off, { headers: H });
        if (!rq.ok) { _reap.erros++; break; }
        const ln = await rq.json().catch(() => []);
        if (!Array.isArray(ln) || !ln.length) break;
        _reap.linhas += ln.length;
        const mudar = [];
        for (const l of ln) {
          const vn = Number(l.valor_nota) || 0, im0 = Number(l.imposto) || 0;
          if (!(vn > 0)) continue;
          const novo = Math.round(vn * aq / 100 * 100) / 100;
          if (Math.abs(novo - im0) <= 0.005) continue;
          const mg = (l.margem == null) ? null : Math.round((Number(l.margem) - (novo - im0)) * 100) / 100;
          mudar.push({ id: l.id, imposto: novo, margem: mg });
        }
        // grava em paralelo, de 8 em 8 (PATCH por linha; o Supabase aguenta bem)
        for (let i = 0; i < mudar.length; i += 8) {
          const lote = mudar.slice(i, i + 8);
          await Promise.all(lote.map(async x => {
            try {
              const corpo = (x.margem == null) ? { imposto: x.imposto } : { imposto: x.imposto, margem: x.margem };
              const rp = await fetch(base + '?id=eq.' + x.id, { method: 'PATCH', headers: H, body: JSON.stringify(corpo) });
              if (rp.ok) _reap.atualizadas++; else _reap.erros++;
            } catch (e) { _reap.erros++; }
          }));
        }
        if (ln.length < 500) break;
        off += 500;
      }
      console.log('[FISCAL] ' + mes + ' (alíquota ' + aq + '%): ' + _reap.atualizadas + ' linha(s) atualizadas até agora');
    }
    // o agregado do Mês/Ano tem que refletir na hora
    try { for (const k of Object.keys(ctx.histCache)) delete ctx.histCache[k]; } catch (e) {}
    _reap.msg = 'concluído';
  } catch (e) { _reap.msg = 'erro: ' + (e.message || e); _reap.erros++; }
  _reap.rodando = false; _reap.fim = new Date().toISOString(); _reap.mesAtual = null;
  console.log('[FISCAL] reaplicar imposto CONCLUÍDO — ' + _reap.atualizadas + ' linha(s) de ' + _reap.linhas + ' | erros: ' + _reap.erros);
  return _reap;
}

async function varrerCancelados(ctx, dias, empresa) {
  if (!empresa) throw new Error('varrerCancelados: empresa é obrigatória (ver o cabeçalho da lib)');
  const _kv = String(empresa);
  let _varre = estadoVarrerCancelados(_kv);
  const _setVarre = (o) => { _varrePorEmp.set(_kv, o); _varre = o; return o; };
  if (_varre.rodando) return _varre;
  dias = Math.min(400, Math.max(1, Number(dias) || 45));
  const token = await ctx.garantirToken();
  // 04/08 CONSERTO: 'dorme' nunca existiu neste escopo (o base exporta 'sleep'). Toda vez que uma
  // pagina do Bling voltava CHEIA (100 itens) o await abaixo estourava ReferenceError, caia no catch
  // la embaixo e a varredura morria calada com encontrados=0 — parecia "nao tem cancelado nenhum".
  const dorme = ms => new Promise(r => setTimeout(r, ms));
  const bg = async pth => { for (let t = 0; t < 4; t++) { const r = await ctx.blingGet(pth); if (r.ok || r.status === 404) return r; await dorme(1400 + t * 600); } return await ctx.blingGet(pth); };
  const sc = await ctx.garantirSitCancel(bg);
  _setVarre({ rodando:true, dias, encontrados:0, apagados:0, erros:0, inicio:new Date().toISOString(), fim:null,
             situacoes: sc.nomes.slice(), msg: sc.ids.length ? '' : ('sem IDs de cancelamento: ' + (sc.erro || '?')) });
  if (!sc.ids.length) { _varre.rodando = false; _varre.fim = new Date().toISOString(); return _varre; }

  const hoje = new Date();
  const ate = hoje.toISOString().slice(0, 10);
  const de = new Date(hoje.getTime() - dias * 86400000).toISOString().slice(0, 10);
  const nums = new Set();
  try {
    for (const sid of sc.ids) {
      for (let pag = 1; pag <= 60; pag++) {
        const r = await bg('/pedidos/vendas?idsSituacoes=' + sid + '&dataInicial=' + de + '&dataFinal=' + ate + '&limite=100&pagina=' + pag);
        const lista = (r.ok && r.data && r.data.data) || [];
        if (!lista.length) break;
        for (const p of lista) { const n = String(p.numero || '').trim(); if (n) nums.add(n); }
        if (lista.length < 100) break;
        await dorme(420);
      }
    }
    _varre.encontrados = nums.size;
    console.log('[CANCEL] ' + nums.size + ' pedido(s) cancelado(s) no Bling nos últimos ' + dias + ' dias');

    if (nums.size) {
      const { url, key } = ctx.supaCfg(empresa);
      if (url && key) {
        const H = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'count=exact' };
        const base = url.replace(/\/+$/, '') + '/rest/v1/vendas_historico';
        const arr = Array.from(nums);
        for (let i = 0; i < arr.length; i += 80) {
          const lote = arr.slice(i, i + 80).map(x => '"' + x + '"').join(',');
          try {
            const rd = await fetch(base + '?empresa=eq.' + empresa + '&numero_pedido=in.(' + encodeURIComponent(lote) + ')', { method: 'DELETE', headers: H });
            if (rd.ok) { const cr = rd.headers.get('content-range') || ''; const n2 = Number((cr.split('/')[0] || '').split('-').pop()) ; _varre.apagados += (isFinite(n2) ? n2 + 1 : 0) || 0; }
            else _varre.erros++;
          } catch (e) { _varre.erros++; }
        }
      }
      try { for (const k of Object.keys(ctx.histCache)) delete ctx.histCache[k]; } catch (e) {}
    }
    _varre.msg = 'concluído';
  } catch (e) { _varre.msg = 'erro: ' + (e.message || e); _varre.erros++; }
  _varre.rodando = false; _varre.fim = new Date().toISOString();
  console.log('[CANCEL] varredura concluída — ' + _varre.encontrados + ' cancelado(s), linhas removidas do histórico | erros: ' + _varre.erros);
  return _varre;
}

module.exports = { reaplicarImposto, varrerCancelados,
                   estadoReaplicarImposto, estadoVarrerCancelados };
