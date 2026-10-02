'use strict';
// Toolbox 2.1.5 — bloco ML Full (ct-mlfull.js) RODANDO DE VERDADE num navegador falso:
// DOM minimo, chrome.storage em memoria, fetch roteado (tela do importador do Bling,
// upload, processar, e as rotas do Mover-Pedidos). Exercita o arquivo de producao.
const fs = require('fs'); const path = require('path'); const vm = require('vm');
let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };
const CODIGO = fs.readFileSync(path.join(__dirname, '..', 'toolbox-extensao', 'ct-mlfull.js'), 'utf8');
const { resumirImportacaoBling } = require(path.join(__dirname, '..', 'toolbox-extensao', 'tb-importacao.js'));
const A = '35260727548456000147550020000500011144343275', B = '35260727548456000147550020000500021144343275';
const TELA = (unidades) => '<script>initForm(555)</script><select id="loja_xml"><option value="">Selecione</option><option value="203146903">Mercado Livre</option></select>' +
  '<select id="unidadeNegocio">' + unidades.map(([v, t]) => '<option value="' + v + '">' + t + '</option>').join('') + '</select>';

function navegador({ tbEmpresa = 'girassol', storage = {}, unidades = [['', 'Selecione'], ['11', 'MATRIZ'], ['777', 'FULL MERCADO LIVRE']], respostaBling = 'Nota 50001 importada com sucesso. Nota 50002 importada com sucesso.', arquivadas = 2, pendentesIniciais = 2 } = {}) {
  const loja = Object.assign({ tb_empresa: tbEmpresa, chave: 'K' }, storage);
  const chamadas = [];
  let pendentes = pendentesIniciais;
  const els = {};
  const el = () => ({
    _cls: new Set(), style: {}, textContent: '', value: '', checked: false, disabled: false,
    classList: null, addEventListener() {}, querySelector(sel) { return els[sel] || (els[sel] = el()); },
  });
  const mk = () => { const e = el(); e.classList = { add: (c) => e._cls.add(c), remove: (c) => e._cls.delete(c), toggle: (c) => (e._cls.has(c) ? e._cls.delete(c) : e._cls.add(c)), contains: (c) => e._cls.has(c) }; return e; };
  let painel = null;
  const resp = (status, corpo, headers = {}) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => headers[k] || headers[k.toLowerCase()] || null },
    text: async () => (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)),
    json: async () => (typeof corpo === 'string' ? JSON.parse(corpo) : corpo),
    blob: async () => ({ size: 1200 }),
  });
  const ctx = {
    console, setTimeout, clearTimeout, Date, JSON, String, Number, Math, Promise, Error, encodeURIComponent, FormData: class { append() {} },
    resumirImportacaoBling,
    window: {},
    document: {
      getElementById: (id) => (id === 'mlfull-painel' ? painel : null),
      createElement: () => { painel = mk(); painel.querySelector = (sel) => els[sel] || (els[sel] = mk()); return painel; },
      body: { appendChild() {} }, addEventListener() {},
    },
    chrome: { storage: { local: {
      get: (keys, cb) => { const out = {}; if (Array.isArray(keys)) keys.forEach((k) => { if (k in loja) out[k] = loja[k]; }); else Object.keys(keys).forEach((k) => { out[k] = (k in loja) ? loja[k] : keys[k]; }); cb(out); },
      set: (obj, cb) => { Object.assign(loja, obj); if (cb) cb(); },
    } } },
    fetch: async (url, opts = {}) => {
      chamadas.push({ url, opts });
      if (url === '/importador.notas.fiscais.lote.php') return resp(200, TELA(unidades));
      if (url.startsWith('/upload.restore.php')) return resp(200, { success: true, tmp: 'tmp1' });
      if (url.startsWith('/services/importador.notas.fiscais.lote.server.php')) return resp(200, respostaBling);
      if (url.includes('/ml-full/ext/estado')) return resp(200, { ok: true, empresa: 'girassol', saida: pendentes, entrada: 0, precisa: pendentes > 0, url_zip_saida: pendentes ? '/ml-full/zip?empresa=girassol&tipo=saida&max=100&k=K' : null, url_zip_entrada: null });
      if (url.includes('/ml-full/zip')) return resp(200, 'ZIP', { 'Content-Type': 'application/zip', 'X-Chaves': A + ',' + B });
      if (url.includes('/ml-full/ext/registrar')) { const b = JSON.parse(opts.body); if (arquivadas) pendentes = 0; return resp(200, { ok: true, arquivadas, nao_achadas: arquivadas ? [] : b.importadas }); }
      throw new Error('nao previsto: ' + url);
    },
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(CODIGO, ctx);
  return { chamadas, loja, msg: () => (els['#mlfull-msg'] || {}).textContent || '', painel: () => painel };
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  // 1) caminho feliz
  let n = navegador(); await esperar(300);
  const proc = n.chamadas.filter((c) => c.url.startsWith('/services/importador'));
  const args = proc[0] ? decodeURIComponent(proc[0].opts.body).split('&xajaxargs[]=').slice(1) : [];
  ok(proc.length === 1, '⚠️ abriu o Bling: importou o lote sozinho (1 processamento)');
  ok(args[1] === 'S' && args[2] === '203146903', '  tipo SAIDA na loja Mercado Livre (203146903)');
  ok(args[3] === '777', '⚠️ unidade: a "FULL MERCADO LIVRE" lida da propria tela do importador');
  ok(args[4] === 'false' && args[5] === 'false', '⚠️ Lancar CONTAS: NAO e ESTOQUE: NAO (espelha a nativa do Full)');
  const reg = n.chamadas.find((c) => c.url.includes('/ml-full/ext/registrar'));
  const corpoReg = reg ? JSON.parse(reg.opts.body) : {};
  ok(corpoReg.importadas && corpoReg.importadas.join() === A + ',' + B && corpoReg.idEmpresa === '555' && corpoReg.empresa === 'girassol', '⚠️ registrou exatamente as chaves do ZIP (X-Chaves), com a conta 555');
  ok(n.loja.mlf_vinculo_girassol === '555', '  a conta do Bling ficou vinculada a girassol');
  ok(/✅/.test(n.msg()) && /2 notas/.test(n.msg()), '  painel: "✅ ... 2 notas do ML Full importadas" (' + n.msg().slice(0, 60) + ')');
  // 2) nada pendente: invisivel, sem importar
  n = navegador({ pendentesIniciais: 0 }); await esperar(200);
  ok(!n.chamadas.some((c) => c.url.startsWith('/upload')) && !(n.painel() && n.painel()._cls.has('visivel')), '⚠️ nada pendente: nao importa e o painel fica INVISIVEL');
  // 3) outra conta do Bling no mesmo navegador
  n = navegador({ storage: { mlf_vinculo_girassol: '999' } }); await esperar(200);
  ok(!n.chamadas.some((c) => c.url.startsWith('/upload')) && /NÃO é a da Girassol/.test(n.msg()), '⚠️ conta errada (vinculo 999, sessao 555): recusa e nada sobe');
  // 4) o Bling recusa uma nota de verdade
  n = navegador({ respostaBling: 'XML não importado: erro de schema na nota 50001' }); await esperar(300);
  ok(!n.chamadas.some((c) => c.url.includes('/ext/registrar')) && /NÃO importou/.test(n.msg()), '⚠️ falha REAL no Bling: nada e registrado (tenta de novo na proxima)');
  // 5) duplicada = presenca confirmada: registra
  n = navegador({ respostaBling: 'XML não importado: a nota 50001 já está registrada. XML não importado: a nota 50002 já está registrada.' }); await esperar(300);
  ok(n.chamadas.some((c) => c.url.includes('/ext/registrar')) && /já estavam lá/.test(n.msg()), '  duplicada ("ja esta registrada") conta como presente e sai da fila');
  // 6) servidor nao tira nada da fila: nao reimporta em laco
  n = navegador({ arquivadas: 0 }); await esperar(400);
  ok(n.chamadas.filter((c) => c.url.startsWith('/services/importador')).length === 1 && /parei/.test(n.msg()), '⚠️ registrar sem efeito: PARA (nao reimporta o mesmo lote 20x)');
  // 7) unidade ambigua: nao chuta
  n = navegador({ unidades: [['1', 'FULL MERCADO LIVRE SP'], ['2', 'Full Mercado Livre MG']] }); await esperar(300);
  ok(!n.chamadas.some((c) => c.url.startsWith('/upload')) && /mais de uma unidade/.test(n.msg()), '  duas unidades "Full ML": nao chuta — para e avisa');
  // 8) sem unidade Full na conta: importa sem unidade
  n = navegador({ unidades: [['', 'Selecione'], ['11', 'MATRIZ']] }); await esperar(300);
  const p8 = n.chamadas.find((c) => c.url.startsWith('/services/importador'));
  ok(p8 && decodeURIComponent(p8.opts.body).split('&xajaxargs[]=')[4] === '', '  conta sem unidade "Full ML": importa sem unidade');
  // 9) outra instancia (AMB) nao acorda
  n = navegador({ tbEmpresa: 'amb' }); await esperar(150);
  ok(n.chamadas.length === 0 && !n.painel(), '  instancia da AMB/GOOD: o bloco nem monta');
  // 10) sem chave: pede configuracao e nao chama nada
  n = navegador({ storage: { chave: '' } }); await esperar(150);
  ok(!n.chamadas.some((c) => c.url.includes('/ml-full/')) && /ADMIN_KEY/.test(n.msg()), '  sem ADMIN_KEY: pede pra configurar (uma vez) e nao chama o servidor');
  // contrato com o servidor: as rotas que a extensao usa EXISTEM no ml-full.js
  const srv = fs.readFileSync(path.join(__dirname, '..', 'ml-full.js'), 'utf8');
  ok(["'/ml-full/ext/estado'", "'/ml-full/ext/registrar'", "'X-Chaves'", "'Access-Control-Expose-Headers'"].every((t) => srv.includes(t)), '⚠️ contrato: as rotas e o cabecalho que a extensao usa existem no servidor');
  const man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'toolbox-extensao', 'manifest.json'), 'utf8'));
  const cs = (man.content_scripts || []).find((c) => (c.js || []).includes('ct-mlfull.js'));
  ok(cs && cs.js.indexOf('tb-importacao.js') > -1 && cs.js.indexOf('tb-importacao.js') < cs.js.indexOf('ct-mlfull.js'), '  manifest: ct-mlfull.js carrega DEPOIS do tb-importacao.js (usa o resumo dele)');
  console.log('');
  console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.log('FALHA (excecao):', e && e.stack); process.exit(1); });
