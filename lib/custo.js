'use strict';
// ════════════════════════════════════════════════════════════════════════════════
//  CUSTO — código único, multi-empresa (22/08/2026)
// ════════════════════════════════════════════════════════════════════════════════
//  Escrito 3x em 21/08 (uma vez por empresa) e a GOOD ja tinha ficado sem 5 das 19
//  funcoes — o de-para inteiro. Metade dos erros daquele dia foi "corrigi numa e
//  esqueci da outra". Aqui vira UM lugar so; empresa nova e configuracao, nao copia.
//
//  ctx = { CACHE_DIR, path, fs, readJson, writeJson, blingGet, skuInfoCache }
//   . skuInfoCache e o objeto VIVO da empresa (passa por referencia: a lib limpa nele)
//   . blingGet so e usado pelo catalogo do de-para automatico
//
//  AS DECISOES SAO DO DIEGO, de 21/08:
//   . CUSTO MANUAL por planilha — "eu faco upload e pronto, resolve". So vale onde o
//     Bling NAO tem custo: "se o bling passar a ter custo, ai deixa mandar o Bling".
//   . VIGENCIA — o Bling guarda so o custo ATUAL ("eu subscrevo, apaga o antigo"), entao
//     quem anota "de tal dia ate tal dia valia X" e este lado. Venda ja gravada fica
//     CONGELADA: "isso do passado congelar e legal, eu prefiro assim".
//   . DE-PARA — automatico pelo produto_id (o Bling troca o codigo e mantem o id) e
//     manual pros casos sem id, como o "464" = "HC-464-220v".
const _hojeISO  = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
const _ontemISO = () => new Date(Date.now() - 3 * 3600000 - 86400000).toISOString().slice(0, 10);
function _diaAntes(iso) {
  const t = Date.parse(String(iso) + 'T12:00:00Z');
  if (!isFinite(t)) return null;
  return new Date(t - 86400000).toISOString().slice(0, 10);
}

/* ═══════════ 21/08 — CUSTO MANUAL POR PLANILHA ═══════════════════════════════════════════
   Pedido do Diego: "uma área de subida de sku x custo. eu faço upload e pronto, resolve" —
   como no Jodda e no MercadoTurbo. Nasceu de SKUs que venderam SEM custo no painel: o
   FL-1011-PRETO da AMB (53 un.) foi RENOMEADO no Bling para 3933398010054, então o código
   antigo não existe mais e o custo nunca é achado; na Girassol sobraram 2 casos parecidos.
   REGRA QUE ELE ESCOLHEU: "se o bling passar a ter custo, aí deixa mandar o Bling". Ou seja,
   o manual é PONTE, não substituto — vale enquanto o Bling não sabe, e sai de cena sozinho
   quando o cadastro passa a ter custo. Assim um preço digitado à mão nunca congela um custo
   que voltou a se atualizar sozinho.
   Guardado em _custos-manuais.json (arquivo próprio), pra um custo-sync nunca sobrescrever. */

/* ═══════════ 21/08 — LINHA DO TEMPO DO CUSTO (vigência) ═══════════════════════════════════
   O Diego: "se eu entro no cadastro do bling, em 1 produto, vou lá e mudo o custo, eu subscrevo,
   apaga o antigo e fica por isso, o novo existindo." Exatamente — o Bling guarda SÓ o custo
   atual. Então quem precisa registrar "de tal dia até tal dia valia X" é este lado, no momento
   em que percebe a mudança. Sem isso, cada dia que passa é histórico perdido para sempre.

   Regra que ele confirmou: venda JÁ GRAVADA fica congelada com o custo do dia dela. A vigência
   serve para as vendas novas e para quando ele mandar recalcular um período de propósito — o
   passado nunca muda sozinho, que é o que faz o Mês anterior continuar contando a mesma história.

   Formato (_custos-vigencia.json): { SKU: [ {custo, de:'AAAA-MM-DD', ate:null|'AAAA-MM-DD',
   origem:'bling'|'manual', em:ISO} ] } — `ate:null` = faixa aberta, valendo hoje.
   ⚠️ A linha do tempo começa VAZIA e se forma a partir da primeira mudança detectada: o que já
   passou não dá pra reconstruir, porque o Bling não guarda e nós não anotávamos. */
/* 21/08 (Diego: "tem como só aceitar tb pm1 ao invés de só PM1?") — o SKU é o mesmo produto
   escrito de outro jeito. Aqui eu descubro como ele está GRAVADO (no banco de custos ou na
   vigência) a partir do que foi digitado, para o card achar o produto e não criar uma segunda
   linha do tempo para "pm1" separada da de "PM1". */
function resolverNomeSku(ctx, digitado) {
  const d = String(digitado || '').trim();
  if (!d) return d;
  const alvo = d.toUpperCase();
  /* Codex (P2): a VIGÊNCIA vem primeiro. Se já existe histórico gravado como "pm1" e o Bling tem
     "PM1", resolver pela grafia do Bling ESCONDERIA o histórico do Diego e abriria uma segunda
     linha do tempo — e os lançamentos seguintes iriam pra essa nova, não pra dele. O que ele já
     gravou manda; a grafia do Bling só decide quando não há histórico nenhum. */
  try {
    const vg = lerVigencias(ctx);
    if (vg[d]) return d;
    for (const k of Object.keys(vg)) if (String(k).toUpperCase() === alvo) return k;
  } catch (e) {}
  try {
    const cc = ctx.readJson(ctx.path.join(ctx.CACHE_DIR, '_custos.json'), {}) || {};
    if (cc[d]) return d;
    for (const k of Object.keys(cc)) if (String(k).toUpperCase() === alvo) return k;
  } catch (e) {}
  return d;
}
function lerVigencias(ctx) {
  try { return ctx.readJson(ctx.path.join(ctx.CACHE_DIR, '_custos-vigencia.json'), {}) || {}; } catch (e) { return {}; }
}
function gravarVigencias(ctx, obj) { ctx.writeJson(ctx.path.join(ctx.CACHE_DIR, '_custos-vigencia.json'), obj || {}); }

/* Registra que o custo do SKU passou a ser `novo` HOJE. Fecha a faixa aberta em ontem e abre
   outra — a não ser que o valor seja o mesmo (nada a fazer) ou que a faixa aberta tenha começado
   HOJE, caso em que só corrige o valor dela (duas mudanças no mesmo dia não viram duas faixas). */
function registrarCustoVigente(ctx, sku, novo, origem) {
  const v = Number(novo);
  if (!(v > 0)) return null;
  const k = String(sku || '').trim();
  if (!k) return null;
  const todas = lerVigencias(ctx);
  const lista = Array.isArray(todas[k]) ? todas[k] : [];
  const aberta = lista.find(f => !f.ate);
  const hoje = _hojeISO();
  if (aberta) {
    if (Math.abs(Number(aberta.custo) - v) < 0.0001) return null;   // não mudou
    if (aberta.de === hoje) { aberta.custo = v; aberta.origem = origem || aberta.origem; aberta.em = new Date().toISOString(); }
    else {
      aberta.ate = _ontemISO();
      lista.push({ custo: v, de: hoje, ate: null, origem: origem || 'bling', em: new Date().toISOString() });
    }
  } else {
    lista.push({ custo: v, de: hoje, ate: null, origem: origem || 'bling', em: new Date().toISOString() });
  }
  lista.sort((a, b) => String(a.de).localeCompare(String(b.de)));
  todas[k] = lista;
  gravarVigencias(ctx, todas);
  return lista;
}

/* Custo que valia numa DATA (AAAA-MM-DD). Sem faixa que cubra a data, devolve null — quem chama
   decide o que fazer (hoje: cair no custo atual, como sempre foi). */
function custoVigenteEm(ctx, sku, data) {
  const vg = lerVigencias(ctx);
  const kk = String(sku || '').trim();
  const alvo = kk.toUpperCase();
  const lista = vg[kk] || vg[Object.keys(vg).find(k => String(k).toUpperCase() === alvo)];
  if (!Array.isArray(lista) || !lista.length) return null;
  const d = String(data || '').slice(0, 10);
  if (!d) return null;
  for (let i = lista.length - 1; i >= 0; i--) {
    const f = lista[i];
    if (String(f.de) <= d && (!f.ate || d <= String(f.ate))) { const c = Number(f.custo); if (c > 0) return c; }
  }
  return null;
}


/* ═══════════ 21/08 — DE-PARA MANUAL DE SKU ═══════════════════════════════════════════════
   O /sku-depara resolve por `produto_id` (o Bling prova que é o mesmo produto). Mas o Diego
   achou dois SKUs SEM id guardado: "464" e "465", que ele reconheceu na hora como
   "HC-464-220v" e "HC-465-110v". Aí a ligação é julgamento DELE — o sistema não tem como
   provar. Então fica declarado à mão e vale daí em diante.
   Melhor que lançar custo manual nesses casos: o custo continua vindo do Bling e se atualiza
   sozinho, e as vendas antigas se juntam ao produto certo nos relatórios por SKU.
   Formato (_sku-depara.json): { "464": { para: "HC-464-220v", em: ISO } } */
function lerDeParaSku(ctx) {
  try { return ctx.readJson(ctx.path.join(ctx.CACHE_DIR, '_sku-depara.json'), {}) || {}; } catch (e) { return {}; }
}
function gravarDeParaSku(ctx, o) { ctx.writeJson(ctx.path.join(ctx.CACHE_DIR, '_sku-depara.json'), o || {}); }
/* devolve o SKU de destino, ou o próprio quando não há de-para. Cadeia curta (A→B→C) é
   seguida até 5 saltos; ciclo (A→B→A) para e devolve o último válido, sem travar. */
/* Codex (#185): o de-para trata SKU sem diferenciar caixa em TODO lugar (grava, apaga, sugere),
   mas aqui a busca só testava 3 grafias — a exata, a MAIÚSCULA e a minúscula. Uma chave gravada
   como "Pm1" não era achada por "pm1", e o /sku-info voltava a consultar o código velho no Bling.
   Agora compara com as CHAVES guardadas, normalizando dos dois lados — que é o que o resto faz. */
function _acharChave(m, sku) {
  const alvo = String(sku || '').trim().toUpperCase();
  if (Object.prototype.hasOwnProperty.call(m, sku)) return m[sku];
  const k = Object.keys(m).find(x => String(x).trim().toUpperCase() === alvo);
  return k ? m[k] : null;
}
function resolverDeParaSku(ctx, sku) {
  const m = lerDeParaSku(ctx);
  let atual = String(sku || '').trim();
  const vistos = new Set([atual.toUpperCase()]);
  for (let i = 0; i < 5; i++) {
    const r = _acharChave(m, atual);
    const prox = r && String(r.para || '').trim();
    if (!prox || vistos.has(prox.toUpperCase())) break;
    vistos.add(prox.toUpperCase());
    atual = prox;
  }
  return atual;
}
/* sugestão por semelhança, só pra ELE conferir — nunca aplicada sozinha. "464" casa com
   "HC-464-220v" porque o código antigo aparece inteiro, cercado por limite de palavra. */
function sugerirDeParaSku(ctx, velho, codigos) {
  const v = String(velho || '').trim();
  if (!v || v.length < 2) return [];
  const alvo = v.toUpperCase();
  const re = new RegExp('(^|[^0-9A-Z])' + alvo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^0-9A-Z]|$)');
  const out = [];
  for (const c of codigos) {
    const C = String(c).toUpperCase();
    if (C === alvo) continue;
    if (re.test(C)) out.push(c);
    if (out.length >= 5) break;
  }
  return out;
}


/* Codex (revisão geral, 21/08): a varredura do catálogo é cara — 9.056 produtos na Girassol,
   ~90 chamadas ao Bling. Sem cache, cada clique refazia tudo; e dois cliques ao mesmo tempo
   disparavam DUAS varreduras completas, dobrando a pressão sobre o limite justo quando ele já
   estava perto de estourar (foi o que fez a página 14 falhar).
   Guarda 30 minutos e, principalmente, compartilha a mesma Promise entre chamadas simultâneas:
   quem chegar durante uma varredura em andamento espera a mesma, em vez de abrir outra.
   Resultado incompleto NUNCA é cacheado — o erro sobe e a próxima tentativa recomeça limpa. */
/* ⚠️ 22/08 — O CACHE É POR EMPRESA, NÃO DO MÓDULO.
   Ao extrair este código pra cá, o cache virou global: como as 3 empresas carregam a MESMA
   lib, a Girassol receberia o catálogo que a AMB tinha carregado, e o de-para apontaria
   produtos da empresa errada. Isso não existia quando cada uma tinha sua cópia do arquivo.
   A chave é o CACHE_DIR, que é único por empresa. */
const _catalogoPorEmpresa = new Map();     // CACHE_DIR → { porCodigo, porId, em }
const _catalogoEmAndamento = new Map();    // CACHE_DIR → Promise
async function carregarCatalogoDePara(ctx) {
  const _chave = String(ctx.CACHE_DIR || '?');
  const _cache = _catalogoPorEmpresa.get(_chave);
  if (_cache && (Date.now() - _cache.em) < 30 * 60 * 1000) return _cache;
  if (_catalogoEmAndamento.has(_chave)) return _catalogoEmAndamento.get(_chave);
  const _p = (async () => {
    const porCodigo = {}; const porId = {};
    const TETO = 200;
    for (let pg = 1; pg <= TETO; pg++) {
      let rc = null;
      for (let tent = 1; tent <= 4; tent++) {
        rc = await ctx.blingGet('/produtos?pagina=' + pg + '&limite=100&criterio=2');
        if (rc && rc.ok) break;
        if (tent < 4) await new Promise(r => setTimeout(r, 1500 * tent));   // 1,5s · 3s · 4,5s
      }
      if (!rc || !rc.ok) throw new Error('catalogo incompleto: pagina ' + pg + ' falhou apos 4 tentativas');
      const lote = (rc.data && rc.data.data) || [];
      for (const pr of lote) {
        const cd = String(pr.codigo || '').trim();
        if (cd) { porCodigo[cd] = pr.id; porId[String(pr.id)] = cd; }
      }
      if (lote.length < 100) {
        const pronto = { porCodigo, porId, em: Date.now() };
        _catalogoPorEmpresa.set(_chave, pronto);
        return pronto;
      }
      await new Promise(r => setTimeout(r, 600));
    }
    throw new Error('catalogo maior que ' + (TETO * 100) + ' produtos — aumente o teto');
  })();
  _catalogoEmAndamento.set(_chave, _p);
  try { return await _p; }
  finally { _catalogoEmAndamento.delete(_chave); }
}

function lerCustosManuais(ctx) {
  try { return ctx.readJson(ctx.path.join(ctx.CACHE_DIR, '_custos-manuais.json'), {}) || {}; } catch (e) { return {}; }
}
function gravarCustosManuais(ctx, obj) {
  ctx.writeJson(ctx.path.join(ctx.CACHE_DIR, '_custos-manuais.json'), obj || {});
  /* Codex (P2): sem isto, apagar um custo manual mudava só o arquivo — o cache de 6h de SKU
     continuava servindo o valor antigo e, ao vencer, o fallback o copiava de volta. O custo
     apagado seguiria afetando a margem indefinidamente. Toda gravação derruba os dois caches. */
  try { if (typeof ctx.skuInfoCache === 'object' && ctx.skuInfoCache) { for (const k of Object.keys(ctx.skuInfoCache)) delete ctx.skuInfoCache[k]; } } catch (e) {}
  try { const f = ctx.path.join(ctx.CACHE_DIR, '_skus-info.json'); if (ctx.fs.existsSync(f)) ctx.fs.unlinkSync(f); } catch (e) {}
}
/* custo POR UNIDADE do SKU, ou null. `doBling` é o que o Bling já sabe: se ele tem custo,
   o manual não entra (regra do Diego). */
function custoManualDe(ctx, sku, doBling) {
  if (doBling != null && isFinite(Number(doBling)) && Number(doBling) > 0) return null;
  const r = lerCustosManuais(ctx)[String(sku || '').trim().toUpperCase()];
  const v = r && Number(r.custo);
  return (v > 0) ? v : null;
}
/* Sobrepõe o manual num mapa de custos do Bling, sem nunca vencer um custo que o Bling tem.
   Um lugar só: dashboards, histórico e plano de compra chamam esta função — foi a falta disso
   que deixou o plano de compra dizendo "sem custo" enquanto a tela já mostrava o corrigido. */
function comCustosManuais(ctx, mapaDoBling) {
  const b = mapaDoBling || {};
  /* 21/08 — o DE-PARA MANUAL entra aqui: SKU antigo declarado (ex.: "464" → "HC-464-220v")
     herda o custo do destino. Assim o custo continua vindo do Bling e se atualizando sozinho,
     em vez de congelar num valor digitado à mão. */
  try {
    const dp = lerDeParaSku(ctx);
    for (const velho of Object.keys(dp)) {
      if (b[velho] && Number(b[velho].custo) > 0) continue;         // já tem custo próprio
      const destino = resolverDeParaSku(ctx, velho);
      const alvo = b[destino] || b[String(destino).toUpperCase()] ||
                   b[Object.keys(b).find(k => String(k).toUpperCase() === String(destino).toUpperCase())];
      /* Codex (#185, P1): faltava o `ts`. O /sku-info só aceita registro com carimbo recente —
         sem ele, o de-para era ignorado e o Bling era consultado pelo código VELHO, que não
         existe mais. Ou seja: gravava o par e não surtia efeito. Herda o carimbo do destino
         (ou marca agora), porque o dado É o do destino, lido no mesmo momento. */
      if (alvo && Number(alvo.custo) > 0) b[velho] = { custo: Number(alvo.custo), id: alvo.id, depara_de: destino, ts: alvo.ts || Date.now() };
    }
  } catch (e) {}
  const man = lerCustosManuais(ctx);
  const temNoBling = k => { const c = b[k] || b[String(k).toLowerCase()]; return c && Number(c.custo) > 0; };
  for (const K of Object.keys(man)) {
    const v = Number(man[K].custo);
    if (!(v > 0)) continue;
    const nome = man[K].sku || K;
    if (!temNoBling(K) && !temNoBling(nome)) b[nome] = { custo: v, manual: true };
  }
  return b;
}

/* Aceita planilha colada do Excel (SKU<TAB>custo), CSV com ; ou , e linhas soltas.
   ⚠️ O SEPARADOR É DECIDIDO POR LINHA, e a vírgula é a ÚLTIMA opção: em planilha brasileira
   a vírgula é DECIMAL, e tratá-la como separador de coluna transforma "33,82" em 82 — um
   custo errado sem nenhum aviso na tela é pior que custo faltando. Tab e ponto-e-vírgula
   têm prioridade justamente por isso.
   Devolve {itens, ignoradas} pra tela poder mostrar o que entrou e o que não. */

/* Tela do custo manual: colar do Excel ou subir CSV. Sem framework, no mesmo estilo escuro
   dos outros painéis. A lista do que já está gravado vem junto, com botão de apagar. */
function telaCustosManuais(nomeEmpresa, mod) {
  return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Custos manuais · ${nomeEmpresa}</title><style>
*{box-sizing:border-box} body{margin:0;background:#0b1220;color:#e5e7eb;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:18px}
.wrap{max-width:980px;margin:0 auto} h1{font-size:19px;margin:0 0 4px} .dim{color:#94a3b8;font-size:12px}
.card{background:#111a2e;border:1px solid #1f2b45;border-radius:12px;padding:16px;margin:14px 0}
textarea{width:100%;min-height:180px;background:#0b1220;color:#e5e7eb;border:1px solid #1f2b45;border-radius:8px;padding:10px;font:13px ui-monospace,Menlo,Consolas,monospace}
button{background:#4f46e5;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-weight:700;cursor:pointer}
button.sec{background:#1f2b45}
table{width:100%;border-collapse:collapse;margin-top:8px} th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #1f2b45;font-size:13px}
th{color:#94a3b8;font-weight:600;font-size:11px;text-transform:uppercase}
.ok{color:#34d399} .warn{color:#fbbf24} .bad{color:#f87171} code{background:#0b1220;padding:1px 5px;border-radius:4px}
</style></head><body><div class="wrap">
<h1>💰 Custos manuais · ${nomeEmpresa}</h1>
<div class="dim">O custo daqui <b>só vale onde o Bling não tem custo</b> para o SKU. Se o Bling passar a ter, ele volta a mandar — o manual é ponte, não substituto.</div>

<div class="card">
  <div style="margin-bottom:8px"><b>Colar do Excel</b> <span class="dim">— duas colunas: SKU e custo POR UNIDADE. Aceita tab, ponto-e-vírgula, vírgula, R$ e decimal brasileiro.</span></div>
  <textarea id="txt" placeholder="FL-1011-PRETO&#9;33,82&#10;465;12,50&#10;10xE14-5W-3000K-BIV&#9;34,00"></textarea>
  <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <button onclick="salvar()">Salvar custos</button>
    <button class="sec" onclick="document.getElementById('arq').click()">Subir CSV</button>
    <input type="file" id="arq" accept=".csv,.txt,.tsv" style="display:none" onchange="lerArq(this)">
    <span id="msg" class="dim"></span>
  </div>
</div>

<div class="card">
  <div style="display:flex;justify-content:space-between;align-items:center">
    <b>Gravados</b>
    <button class="sec" onclick="carregar()">atualizar</button>
  </div>
  <div id="lista" class="dim" style="margin-top:8px">carregando…</div>
</div>

<div class="dim">Dica: no dashboard, o card <b>SKUs que venderam SEM custo</b> tem o botão <i>copiar a lista de SKUs</i> — cole aqui, preencha os custos e salve.</div>

<script>
const MOD='${mod}';
const K=new URLSearchParams(location.search).get('k')||'';
const qs=K?('?k='+encodeURIComponent(K)):'';
function lerArq(el){ const f=el.files&&el.files[0]; if(!f) return;
  const r=new FileReader(); r.onload=()=>{ document.getElementById('txt').value=r.result; msg('arquivo carregado — confira e clique em Salvar','warn'); }; r.readAsText(f,'utf-8'); }
function msg(t,cls){ const m=document.getElementById('msg'); m.textContent=t; m.className=cls||'dim'; }
async function salvar(){
  const texto=document.getElementById('txt').value.trim();
  if(!texto){ msg('cole alguma coisa primeiro','warn'); return; }
  msg('salvando…');
  try{
    const r=await fetch(MOD+'/custos-manuais'+qs,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({texto})});
    const j=await r.json();
    if(!j.ok){ msg('✗ '+(j.erro||'falhou')+(j.ignoradas&&j.ignoradas.length?(' · ignoradas: '+j.ignoradas.length):''),'bad'); return; }
    msg('✓ '+j.gravados+' custo(s) gravado(s)'+(j.ignoradas&&j.ignoradas.length?(' · '+j.ignoradas.length+' linha(s) ignorada(s)'):''),'ok');
    document.getElementById('txt').value='';
    carregar();
  }catch(e){ msg('✗ '+e.message,'bad'); }
}
async function apagar(sku){
  if(!confirm('Apagar o custo manual de '+sku+'?')) return;
  await fetch(MOD+'/custos-manuais'+qs,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apagar:sku})});
  carregar();
}
async function carregar(){
  const el=document.getElementById('lista');
  try{
    const r=await fetch(MOD+'/custos-manuais'+(qs?qs+'&':'?')+'lista=1');
    const j=await r.json();
    if(!j.ok||!j.total){ el.innerHTML='<span class="dim">nenhum custo manual gravado</span>'; return; }
    /* Codex (P2): o SKU ia para dentro de um onclick com só as aspas escapadas. O navegador
       DECODIFICA entidades HTML antes de rodar o JS, então uma planilha com um SKU forjado
       executaria script na sessão de admin — e planilha vem de fora. Agora o valor viaja em
       data-attribute (que nunca é interpretado como código) e o clique é ligado por listener. */
    el.innerHTML='<table><tr><th>SKU</th><th>Custo/un.</th><th>Quando</th><th></th></tr>'+
      j.itens.map(i=>'<tr><td><code>'+esc(i.sku)+'</code></td><td>R$ '+Number(i.custo).toFixed(2).replace('.',',')+
      '</td><td class="dim">'+(i.em?String(i.em).slice(0,10).split('-').reverse().join('/'):'—')+
      '</td><td><button class="sec del" style="padding:3px 8px;font-size:11px" data-sku="'+esc(i.sku)+'">apagar</button></td></tr>').join('')+
      '</table><div class="dim" style="margin-top:6px">'+j.total+' SKU(s)</div>';
    el.querySelectorAll('button.del').forEach(b=>b.addEventListener('click',()=>apagar(b.getAttribute('data-sku'))));
  }catch(e){ el.innerHTML='<span class="bad">erro: '+e.message+'</span>'; }
}
function esc(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
carregar();
</script></div></body></html>`;
}

function parsearCustosColados(txt) {
  const linhas = String(txt || '').split(/\r?\n/);
  const itens = {}; const ignoradas = [];
  const limpa = x => String(x || '').trim().replace(/^["']|["']$/g, '');
  const paraNumero = s => {
    let b = String(s || '').replace(/[R$\s]/gi, '');
    if (!b) return NaN;
    const temVirg = b.indexOf(',') >= 0, temPonto = b.indexOf('.') >= 0;
    if (temVirg && temPonto) b = (b.lastIndexOf(',') > b.lastIndexOf('.'))
        ? b.replace(/\./g, '').replace(',', '.')     // 1.234,56 → 1234.56
        : b.replace(/,/g, '');                       // 1,234.56 → 1234.56
    else if (temVirg) b = b.replace(',', '.');       // 33,82 → 33.82
    return Number(b);
  };
  for (const ln of linhas) {
    let l = ln.trim();
    if (!l) continue;
    /* Codex (P2): CSV com aspas — "FL-1011-PRETO","33.82" — é o que o Excel exporta por PADRÃO,
       e a linha inteira era rejeitada porque o número não terminava a linha (a aspa final
       atrapalhava o casamento). A tela oferece "subir CSV", então o formato mais comum tem que
       passar: tiro as aspas de cada campo antes de decidir o separador. */
    if (l.indexOf('"') >= 0 || l.indexOf("'") >= 0) {
      const campos = l.match(/"[^"]*"|'[^']*'|[^,;\t]+/g);
      if (campos && campos.length >= 2) l = campos.map(c => c.trim().replace(/^["']|["']$/g, '')).join('\t');
    }
    let partes;
    if (l.indexOf('\t') >= 0) partes = l.split('\t');
    else if (l.indexOf(';') >= 0) partes = l.split(';');
    else {
      /* Sem tab nem ';', o valor é o ÚLTIMO CAMPO NUMÉRICO da linha e o SKU é todo o resto.
         Achar isso cortando na última vírgula não funciona: em "R$ 8,90" a última vírgula está
         DENTRO do número, e o corte devolvia custo 90. Então eu casco o número pelo FIM da linha
         — aceitando R$, espaço, milhar e decimal — e o que sobra na frente é o SKU, mesmo que
         tenha vírgulas ("KIT 10x LED, 3000K, 5W"). */
      const m = l.match(/^(.*?)[\s,;]*(?:R\$\s*)?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s*$/i);
      if (m && m[1] && m[1].trim()) partes = [m[1], m[2]];
      else partes = [l];   // sem número no fim: linha ignorada logo abaixo
    }
    partes = (partes || []).map(limpa).filter(x => x !== '');
    if (partes.length < 2) { ignoradas.push(l.slice(0, 60)); continue; }
    const sku = String(partes[0]).replace(/[\s,;]+$/, '');
    const custo = paraNumero(partes[partes.length - 1]);
    if (!sku || sku.toLowerCase() === 'sku' || !isFinite(custo) || custo <= 0) { ignoradas.push(l.slice(0, 60)); continue; }
    /* Codex (P2): a planilha pode vir 'abc-1' e a venda 'ABC-1'. Guardo a chave normalizada
       (e o sku original pra exibir), e a leitura normaliza igual — senão o custo nunca aplica. */
    itens[sku.toUpperCase()] = { custo: Math.round(custo * 10000) / 10000, sku: sku, em: new Date().toISOString() };
  }
  return { itens, ignoradas };
}


module.exports = { _acharChave, carregarCatalogoDePara, parsearCustosColados, telaCustosManuais, comCustosManuais, custoManualDe, custoVigenteEm, gravarCustosManuais, gravarDeParaSku, gravarVigencias, lerCustosManuais, lerDeParaSku, lerVigencias, registrarCustoVigente, resolverDeParaSku, resolverNomeSku, sugerirDeParaSku, _hojeISO, _ontemISO, _diaAntes };
