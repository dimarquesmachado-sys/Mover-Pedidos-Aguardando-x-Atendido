'use strict';
// ════════════════════════════════════════════════════════════════════════════════
//  OPERAÇÕES DE VENDA — código único, multi-empresa (22/08/2026)
// ════════════════════════════════════════════════════════════════════════════════
//  Estas três estavam BYTE-A-BYTE idênticas em amb-checkout-offline/index.js e
//  girassol-backup-offline/gbo-app.js — 223 linhas escritas duas vezes.
//
//  Continuação da redução dos arquivos gigantes (8.096 e 6.172 linhas). São as
//  primeiras da fila justamente por serem idênticas: risco zero de escolher a
//  versão errada, que foi o problema quando as 3 empresas tinham 3 versões dos
//  mesmos espelhos.
//
//  ctx = { blingGet, CACHE_DIR, path, readJson, custoVigenteEm }
//
//  A configuração do Supabase vem de lib/supabase.js, não do ctx: a empresa já chega
//  como parâmetro em reaplicarCusto, então não faz sentido cada index.js repassar a
//  própria. Envs de sempre: SUPABASE_URL_VENDAS_<EMPRESA> / SUPABASE_KEY_VENDAS_<EMPRESA>.
//   · buscarDevolucoesML não usa ctx (recebe token e a função de espera)
//   · varrerFornecedores usa só blingGet
//   · reaplicarCusto usa o cache e a vigência de custo

const { cfg: supaCfg } = require('./supabase');

async function buscarDevolucoesML(tokenML, dorme) {
  if (!tokenML) return {};
  const H = { headers: { Authorization: 'Bearer ' + tokenML } };
  let sellerId = null;
  try { const rm = await fetch('https://api.mercadolibre.com/users/me', H); const dm = await rm.json().catch(() => null); if (rm.ok && dm && dm.id) sellerId = dm.id; } catch (e) {}
  if (!sellerId) return {};
  const mapa = {};
  for (const st of ['opened', 'closed']) {
    try {
      const rc = await fetch('https://api.mercadolibre.com/post-purchase/v1/claims/search?players.user_id=' + sellerId + '&players.role=respondent&status=' + st + '&sort=date_created:desc&limit=50', H);
      const dc = await rc.json().catch(() => null);
      const data = (dc && dc.data) || [];
      for (const c of data) {
        if (!c || c.type !== 'returns' || c.resource !== 'order') continue;   // só devolução de pedido (resource_id = order_id)
        const oid = String(c.resource_id);
        if (mapa[oid]) continue;   // opened vem primeiro, tem prioridade
        mapa[oid] = { claim_id: c.id, stage: c.stage, aberta: (st === 'opened'), data: c.date_created, frete_retorno: null, destino: null, dev_status: null };
      }
    } catch (e) {}
    await dorme(200);
  }
  // pros claims de devolução, busca o custo do frete de retorno + status/destino da devolução
  for (const oid of Object.keys(mapa)) {
    const cid = mapa[oid].claim_id;
    try {
      const rr = await fetch('https://api.mercadolibre.com/post-purchase/v1/claims/' + cid + '/charges/return-cost', H);
      const dr = await rr.json().catch(() => null);
      if (rr.ok && dr && dr.amount != null) mapa[oid].frete_retorno = Number(dr.amount);   // frete de retorno pago pelo vendedor
    } catch (e) {}
    await dorme(150);
    try {
      const rt = await fetch('https://api.mercadolibre.com/post-purchase/v2/claims/' + cid + '/returns', H);
      const dt = await rt.json().catch(() => null);
      if (rt.ok && dt) {
        mapa[oid].dev_status = dt.status;   // label_generated / shipped / ...
        const sh = Array.isArray(dt.shipments) ? dt.shipments[0] : null;
        if (sh && sh.destination) mapa[oid].destino = sh.destination.name;   // warehouse / seller_address
      }
    } catch (e) {}
    await dorme(150);
  }
  return mapa;
}

/* Estado da varredura de fornecedores — mesma história do _reapC. Cada index.js tinha o seu
   `let _varFor`; ao extrair a função ele ficou órfão, e como a lib usava o nome livre, TODA
   chamada estourava ReferenceError enquanto a rota de status seguia lendo o objeto do arquivo,
   parado em 'parado' pra sempre. Agora mora aqui, uma vez POR EMPRESA. */
const _varPorEmpresa = new Map();
const _varVazio = () => ({ rodando: false, fase: 'parado', vistos: 0, sem_fornecedor: 0, divergentes: 0, erros: 0,
                           recuperados_por_componente: 0, sem_custo_mesmo: 0, inicio: null, fim: null, lista: [], sem_custo: [] });
function estadoVarrerFornecedores(empresa) {
  const k = String(empresa || 'girassol');
  if (!_varPorEmpresa.has(k)) _varPorEmpresa.set(k, _varVazio());
  return _varPorEmpresa.get(k);
}

async function varrerFornecedores(ctx, max) {
  const _kv = String((ctx && ctx.empresa) || 'girassol');
  let _varFor = estadoVarrerFornecedores(_kv);
  const _setVar = (o) => { _varPorEmpresa.set(_kv, o); _varFor = o; return o; };
  if (_varFor.rodando) return _varFor;
  const teto = Math.min(20000, Math.max(1, Number(max) || 5000));
  _setVar({ rodando: true, fase: 'baixando vinculos', vistos: 0, vinculos: 0, sem_fornecedor: 0, divergentes: 0, erros: 0,
            sem_padrao: 0, custo_so_no_secundario: 0, recuperados_por_componente: 0, sem_custo_mesmo: 0,
            inicio: new Date().toISOString(), fim: null, lista: [], sem_custo: [] });
  const dorme = ms => new Promise(r => setTimeout(r, ms));
  try {
    // ── 1) TODOS os vínculos de fornecedor, de uma vez ────────────────────────
    // `/produtos/fornecedores` aceita paginação SEM idProduto — o Diego duvidou da
    // minha afirmação de que a API só dava o padrão, mandou eu conferir, e estava
    // certo. Com isso a varredura deixa de ser 1 chamada por produto.
    const porProduto = new Map();
    for (let pag = 1; pag <= 200; pag++) {
      let lote = null;
      for (let tt = 1; tt <= 3 && !lote; tt++) {
        try { const r = await ctx.blingGet('/produtos/fornecedores?pagina=' + pag + '&limite=100'); lote = (r && r.ok && r.data && r.data.data) || null; } catch (e) {}
        if (!lote) await dorme(2500 * tt);
      }
      if (!Array.isArray(lote) || !lote.length) break;
      for (const v of lote) {
        const idp = v && v.produto && v.produto.id;
        if (!idp) continue;
        _varFor.vinculos++;
        if (!porProduto.has(idp)) porProduto.set(idp, []);
        porProduto.get(idp).push({ codigo: String(v.codigo || '').trim(), custo: Number(v.precoCusto || 0) || 0, padrao: !!v.padrao });
      }
      await dorme(430);
    }

    // ── 2) os produtos, pra saber o SKU de cada id ────────────────────────────
    _varFor.fase = 'cruzando com os produtos';
    for (let pag = 1; pag <= 200 && _varFor.vistos < teto; pag++) {
      let lista = null;
      for (let tt = 1; tt <= 3 && !lista; tt++) {
        try { const r = await ctx.blingGet('/produtos?pagina=' + pag + '&limite=100&criterio=2'); lista = (r && r.ok && r.data && r.data.data) || null; } catch (e) {}
        if (!lista) await dorme(2500 * tt);
      }
      if (!Array.isArray(lista) || !lista.length) break;
      for (const p0 of lista) {
        if (!p0 || p0.id == null) continue;
        if (_varFor.vistos >= teto) break;
        _varFor.vistos++;
        const sku = String(p0.codigo || '').trim();
        const vins = porProduto.get(p0.id) || [];
        const padrao = vins.find(x => x.padrao) || null;
        const comCusto = vins.filter(x => x.custo > 0);

        // (a) nenhum vínculo: sem custo mesmo por essa via
        if (!vins.length) {
          _varFor.sem_fornecedor++; _varFor.sem_custo_mesmo++;
          if (_varFor.sem_custo.length < 400) _varFor.sem_custo.push({ id: p0.id, sku, nome: String(p0.nome || '').slice(0, 60), motivo: 'sem nenhum fornecedor' });
          continue;
        }
        // (b) tem vínculo com custo, mas NENHUM marcado como padrão.
        // Isto importa: o /produtos/{id} só devolve o padrão, então esses produtos
        // apareciam como "sem custo" na varredura antiga — e não estão.
        if (!padrao || padrao.custo <= 0) {
          _varFor.sem_padrao++;
          if (comCusto.length) {
            _varFor.custo_so_no_secundario++;
            if (_varFor.sem_custo.length < 400) _varFor.sem_custo.push({
              id: p0.id, sku, nome: String(p0.nome || '').slice(0, 60),
              motivo: padrao ? 'o fornecedor padrão está com custo zero' : 'tem custo, mas nenhum fornecedor está marcado como PADRÃO',
              custo_disponivel: comCusto[0].custo, codigo_desse: comCusto[0].codigo, quantos_fornecedores: vins.length
            });
          } else {
            _varFor.sem_custo_mesmo++;
            if (_varFor.sem_custo.length < 400) _varFor.sem_custo.push({ id: p0.id, sku, nome: String(p0.nome || '').slice(0, 60), motivo: 'tem fornecedor, mas todos com custo zero', quantos_fornecedores: vins.length });
          }
        }
        // (c) divergência de código — agora em TODOS os vínculos, não só no padrão
        for (const v of vins) {
          if (!sku || !v.codigo) continue;
          if (sku.toLowerCase() === v.codigo.toLowerCase()) continue;
          _varFor.divergentes++;
          if (_varFor.lista.length < 400) _varFor.lista.push({
            id: p0.id, sku, codigo_no_fornecedor: v.codigo, padrao: v.padrao,
            custo: v.custo, nome: String(p0.nome || '').slice(0, 60)
          });
        }
      }
      await dorme(430);
    }
    _varFor.fase = 'concluido';
  } catch (e) { _varFor.fase = 'erro'; _varFor.msg = String((e && e.message) || e); }
  _varFor.rodando = false; _varFor.fim = new Date().toISOString();
  console.log('[FORNECEDORES] ' + _varFor.vistos + ' produtos · ' + _varFor.vinculos + ' vinculos · ' + _varFor.divergentes + ' divergencias · ' + _varFor.custo_so_no_secundario + ' com custo so no secundario');
  return _varFor;
}

/* O estado da reaplicação vive AQUI, uma vez por empresa. Antes cada index.js tinha o seu
   `let _reapC`; ao extrair a função, o estado ficou órfão nos dois lados — a rota de status lia
   um objeto que ninguém atualizava. Agora há uma fonte só, e `estadoReaplicar(empresa)` devolve
   ela pra rota.
   ⚠️ A CHAVE É A EMPRESA. Uma variável só do módulo seria compartilhada pelas três: a trava
   "já está rodando" de uma barraria as outras, e o painel da Girassol mostraria o progresso da
   AMB. Isso não existia quando cada uma tinha sua cópia da função — é risco criado pela
   extração, o mesmo que apareceu no cache do catálogo em lib/custo.js. */
const _reapPorEmpresa = new Map();
const _reapVazio = () => ({ rodando:false, de:null, ate:null, linhas:0, atualizadas:0, sem_custo:0,
                            erros:0, inicio:null, fim:null, msg:'', maiores:[] });
function estadoReaplicar(empresa) {
  const k = String(empresa || 'girassol');
  if (!_reapPorEmpresa.has(k)) _reapPorEmpresa.set(k, _reapVazio());
  return _reapPorEmpresa.get(k);
}

async function reaplicarCusto(ctx, de, ate, empresa, opts){
  empresa = empresa || 'girassol';          // default ANTES da chave, senão o estado iria pra '?'
  const _k = String(empresa);
  let _reapC = estadoReaplicar(_k);
  const _set = (o) => { _reapPorEmpresa.set(_k, o); _reapC = o; return o; };  // troca objeto E mapa
  if (_reapC.rodando) return _reapC;
  const simular = !!(opts && opts.simular);
  const { url, key } = supaCfg(empresa);
  if (!url || !key) { _reapC.msg = 'Supabase não configurado'; return _reapC; }
  const H = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  const base = url.replace(/\/+$/, '') + '/rest/v1/vendas_historico';
  const cc = ctx.readJson(ctx.path.join(ctx.CACHE_DIR, '_custos.json'), {});
  /* 21/08 — o reaplicar passa a respeitar a DATA da venda: se existe faixa de vigência que
     cubra aquele dia, é ela que vale. Sem isso, reaplicar o ano depois de uma alteração de preço
     carimbaria o custo de hoje sobre janeiro — que é justamente o que o Diego não quer
     ("isso do passado congelar é legal"). Sem faixa pra data, cai no custo atual, como antes. */
  const custoDe = (sk, dataVenda) => {
    if (dataVenda) { try { const v = ctx.custoVigenteEm(sk, String(dataVenda).slice(0, 10)); if (v > 0) return v; } catch (e) {} }
    const c = cc[String(sk || '').trim()];
    return (c && c.custo != null && isFinite(Number(c.custo)) && Number(c.custo) > 0) ? Number(c.custo) : null;
  };

  _set({ rodando:true, de, ate, empresa, simulacao:simular, linhas:0, atualizadas:0, sem_custo:0, erros:0,
         linhas_ganhando_custo:0, custo_que_entra:0, linhas_com_custo_corrigido:0, efeito_real_na_margem:0,
         inicio:new Date().toISOString(), fim:null, msg:'', maiores:[] });
  const _porSku = {};
  console.log('[CUSTO-REAP] ' + (simular ? 'SIMULANDO' : 'reaplicando') + ' custo de ' + de + ' a ' + ate + ' (' + empresa + ')');
  let dif_total = 0;
  try {
    let off = 0;
    while (off < 300000) {
      const rq = await fetch(base + '?empresa=eq.' + empresa + '&data_venda=gte.' + de + '&data_venda=lte.' + ate +
        '&select=id,sku,quantidade,custo,margem,data_venda,numero_pedido&order=data_venda.asc,numero_pedido.asc,sku.asc&limit=500&offset=' + off, { headers: H });
      if (!rq.ok) { _reapC.erros++; break; }
      const ln = await rq.json().catch(() => []);
      if (!Array.isArray(ln) || !ln.length) break;
      _reapC.linhas += ln.length;
      const mudar = [];
      for (const l of ln) {
        const cu = custoDe(l.sku, l.data_venda);
        if (cu == null) { _reapC.sem_custo++; continue; }        // sem custo conhecido: não mexe
        const q = Number(l.quantidade) || 0;
        if (!(q > 0)) continue;
        const novo = Math.round(cu * q * 100) / 100;
        const c0 = (l.custo == null) ? null : Number(l.custo);
        if (c0 != null && Math.abs(novo - c0) <= 0.005) continue;  // já está certo
        // margem acompanha: custo maior derruba margem na mesma medida
        const mg = (l.margem == null || c0 == null) ? null : Math.round((Number(l.margem) - (novo - c0)) * 100) / 100;
        // 19/08 — DOIS CASOS DIFERENTES, que eu vinha somando no mesmo balde e enganavam o Diego:
        //   (a) custo ERA nulo → a linha ganha custo, mas a margem NÃO muda (não há de onde tirar)
        //   (b) custo estava ERRADO → a margem cai exatamente o que o custo sobe
        // O "efeito na margem" só pode contar (b), senão promete um impacto que não acontece.
        const _dif = novo - (c0 || 0);
        dif_total += _dif;
        if (c0 == null) { _reapC.linhas_ganhando_custo++; _reapC.custo_que_entra += _dif; }
        else { _reapC.linhas_com_custo_corrigido++; _reapC.efeito_real_na_margem -= _dif; }
        // agrupado por SKU: 20 linhas idênticas do mesmo produto não dizem nada; o que importa é
        // QUAIS produtos mudam e quanto no total
        const _g = _porSku[l.sku] || (_porSku[l.sku] = { sku: l.sku, linhas: 0, custo_antes: c0, custo_agora: novo, diferenca_total: 0, muda_margem: c0 != null });
        _g.linhas++; _g.diferenca_total = Math.round((_g.diferenca_total + _dif) * 100) / 100;
        mudar.push({ id: l.id, custo: novo, margem: mg });
      }
      if (!simular) {
        for (let i = 0; i < mudar.length; i += 8) {
          const lote = mudar.slice(i, i + 8);
          await Promise.all(lote.map(async x => {
            try {
              const corpo = (x.margem == null) ? { custo: x.custo } : { custo: x.custo, margem: x.margem };
              const rp = await fetch(base + '?id=eq.' + x.id, { method: 'PATCH', headers: H, body: JSON.stringify(corpo) });
              if (rp.ok) _reapC.atualizadas++; else _reapC.erros++;
            } catch (e) { _reapC.erros++; }
          }));
        }
      } else { _reapC.atualizadas += mudar.length; }
      if (ln.length < 500) break;
      off += 500;
    }
    _reapC.diferenca_total_de_custo = Math.round(dif_total * 100) / 100;
    _reapC.custo_que_entra = Math.round(_reapC.custo_que_entra * 100) / 100;
    _reapC.efeito_real_na_margem = Math.round(_reapC.efeito_real_na_margem * 100) / 100;
    // o campo antigo somava os dois casos e superestimava o impacto — fica só como referência crua
    _reapC.efeito_na_margem_BRUTO_nao_use = Math.round(-dif_total * 100) / 100;
    _reapC.leia = 'efeito_real_na_margem é o que a margem MUDA de fato; custo_que_entra são linhas que estavam sem custo e ganham um (a margem delas fica como está)';
    _reapC.por_sku = Object.values(_porSku).sort((a, b) => Math.abs(b.diferenca_total) - Math.abs(a.diferenca_total)).slice(0, 40);
    _reapC.skus_afetados = Object.keys(_porSku).length;
    delete _reapC.maiores;   // substituído pelo agrupamento por SKU
    /* o cache de agregados vive nos index.js (10 min). Antes da extração isso era um objeto
       no escopo; agora vem pelo ctx. Sem ele o dashboard mostraria o número velho até o cache
       vencer sozinho — e o catch vazio escondia o ReferenceError. */
    if (!simular && ctx.histCache) { try { for (const k of Object.keys(ctx.histCache)) delete ctx.histCache[k]; } catch (e) {} }
    _reapC.msg = simular ? 'simulação concluída — NADA foi gravado' : 'concluído';
  } catch (e) { _reapC.msg = 'erro: ' + (e.message || e); _reapC.erros++; }
  _reapC.rodando = false; _reapC.fim = new Date().toISOString();
  console.log('[CUSTO-REAP] fim — ' + _reapC.atualizadas + ' de ' + _reapC.linhas + ' linha(s) | sem custo: ' + _reapC.sem_custo + ' | erros: ' + _reapC.erros);
  return _reapC;
}

module.exports = { buscarDevolucoesML, varrerFornecedores, reaplicarCusto,
                   estadoReaplicar, estadoVarrerFornecedores };
