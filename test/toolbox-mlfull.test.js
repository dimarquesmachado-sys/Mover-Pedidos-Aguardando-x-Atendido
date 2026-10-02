'use strict';
// Toolbox 2.1.6 — bloco ML Full (ct-mlfull.js) RODANDO DE VERDADE num navegador falso:
// DOM minimo, chrome.storage em memoria, fetch roteado (tela do importador do Bling,
// upload, processar, e as rotas do Mover-Pedidos). Exercita o arquivo de producao.
const fs = require('fs'); const path = require('path'); const vm = require('vm');
let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };
const CODIGO = fs.readFileSync(path.join(__dirname, '..', 'toolbox-extensao', 'ct-mlfull.js'), 'utf8');
const { resumirImportacaoBling } = require(path.join(__dirname, '..', 'toolbox-extensao', 'tb-importacao.js'));
const A = '35260727548456000147550020000500011144343275', B = '35260727548456000147550020000500021144343275';
const LOJAS_PADRAO = [['', 'Selecione'], ['203146903', 'Mercado Livre'], ['203583169', 'Shopee']];
const TELA = (unidades, lojas) => '<script>initForm(555)</script><select id="loja_xml">' + lojas.map(([v, t]) => '<option value="' + v + '">' + t + '</option>').join('') + '</select>' +
  '<select id="unidadeNegocio">' + unidades.map(([v, t]) => '<option value="' + v + '">' + t + '</option>').join('') + '</select>';

function navegador(o = {}) {
  const { tbEmpresa = 'girassol', storage = {}, unidades = [['', 'Selecione'], ['11', 'MATRIZ'], ['777', 'FULL MERCADO LIVRE']], lojasTela = LOJAS_PADRAO,
    respostaBling = 'Nota 50001 importada com sucesso. Nota 50002 importada com sucesso.', arquivadas = 2, pendentesIniciais = 2,
    habilitada = true, lojasML = ['203146903'], tamanhoZip = () => 1200, redirectNoProcessar = false, vinculoPendente = false, contaErrada = false } = o;
  const loja = Object.assign({ tb_empresa: tbEmpresa, chave: 'K' }, storage);
  const chamadas = [];
  let pendentes = pendentesIniciais, pendenteVinculo = vinculoPendente;
  const els = {};
  const mk = (tag) => {
    const e = { tag, _cls: new Set(), _h: {}, filhos: [], style: {}, textContent: '', value: '', checked: false, disabled: false, className: '', _html: '' };
    e.classList = { add: (c) => e._cls.add(c), remove: (c) => e._cls.delete(c), toggle: (c) => (e._cls.has(c) ? e._cls.delete(c) : e._cls.add(c)), contains: (c) => e._cls.has(c) };
    e.addEventListener = (t, f) => { e._h[t] = f; };
    e.appendChild = (c) => { e.filhos.push(c); };
    Object.defineProperty(e, 'innerHTML', { get: () => e._html, set: (v) => { e._html = v; if (v === '') e.filhos = []; } });
    e.querySelector = (sel) => els[sel] || (els[sel] = mk('x'));
    return e;
  };
  let painel = null;
  const resp = (status, corpo, headers = {}) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => headers[k] || headers[k.toLowerCase()] || null },
    text: async () => (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)),
    json: async () => (typeof corpo === 'string' ? JSON.parse(corpo) : corpo),
    blob: async () => ({ size: headers.__tam || 1200 }),
    redirected: !!headers.__redir, url: headers.__url || '',
  });
  const ctx = {
    console, setTimeout, clearTimeout, Date, JSON, String, Number, Math, Promise, Error, Map, Set, encodeURIComponent, FormData: class { append() {} },
    resumirImportacaoBling,
    document: {
      getElementById: (id) => (id === 'mlfull-painel' ? painel : null),
      createElement: (tag) => { const e = mk(tag); if (tag === 'div' && !painel) painel = e; return e; },
      body: { appendChild() {} }, addEventListener() {},
    },
    chrome: { storage: { local: {
      get: (keys, cb) => { const out = {}; if (Array.isArray(keys)) keys.forEach((k) => { if (k in loja) out[k] = loja[k]; }); else Object.keys(keys).forEach((k) => { out[k] = (k in loja) ? loja[k] : keys[k]; }); cb(out); },
      set: (obj, cb) => { Object.assign(loja, obj); if (cb) cb(); },
    } } },
    fetch: async (url, opts = {}) => {
      chamadas.push({ url, opts });
      if (url === '/importador.notas.fiscais.lote.php') return resp(200, TELA(unidades, lojasTela));
      if (url.startsWith('/upload.restore.php')) return resp(200, { success: true, tmp: 'tmp1' });
      if (url.startsWith('/services/importador.notas.fiscais.lote.server.php')) return redirectNoProcessar ? resp(200, '<html><form><input type="password" name="senha"></form></html>', { __redir: true, __url: 'https://www.bling.com.br/login' }) : resp(200, respostaBling);
      if (url.includes('/ml-full/ext/estado')) {
        if (contaErrada) return resp(409, { ok: false, erro: 'conta_errada', mensagem: 'Esta sessão do Bling (conta 555) NÃO é a da Magazine Girassol (conta 999). Nada foi importado.' });
        if (!habilitada) return resp(200, { ok: true, empresa: tbEmpresa, habilitada: false, precisa: false });
        return resp(200, { ok: true, empresa: tbEmpresa, habilitada: true, nome: 'Magazine Girassol', lojas_ml: lojasML, vinculo_pendente: pendenteVinculo, saida: pendentes, entrada: 0, precisa: pendentes > 0, url_zip_saida: (pendentes && !pendenteVinculo) ? '/ml-full/zip?empresa=' + tbEmpresa + '&tipo=saida&max=100&k=K' : null, url_zip_entrada: null });
      }
      if (url.includes('/ml-full/ext/vincular')) { pendenteVinculo = false; return resp(200, { ok: true, vinculada: true }); }
      if (url.includes('/ml-full/zip')) { const mx = parseInt((/[?&]max=(\d+)/.exec(url) || [])[1] || '0', 10); return resp(200, 'ZIP', { 'Content-Type': 'application/zip', 'X-Chaves': A + ',' + B, __tam: tamanhoZip(mx) }); }
      if (url.includes('/ml-full/ext/registrar')) { const b = JSON.parse(opts.body); if (arquivadas) pendentes = 0; return resp(200, { ok: true, arquivadas, nao_achadas: arquivadas ? [] : b.importadas }); }
      throw new Error('nao previsto: ' + url);
    },
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(CODIGO, ctx);
  const proc = () => chamadas.filter((c) => c.url.startsWith('/services/importador'));
  const args = (i = 0) => { const p = proc()[i]; return p ? decodeURIComponent(p.opts.body).split('&xajaxargs[]=').slice(1) : []; };
  return { chamadas, loja, els, proc, args, msg: () => (els['#mlfull-msg'] || {}).textContent || '', btn: () => els['#mlfull-btn'] || {}, painel: () => painel };
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  // 1) caminho feliz (conta ja confirmada)
  let n = navegador(); await esperar(300);
  ok(n.proc().length === 1, '⚠️ abriu o Bling: importou o lote sozinho (1 processamento)');
  ok(n.args()[1] === 'S' && n.args()[2] === '203146903', '  tipo SAIDA na loja Mercado Livre (203146903)');
  ok(n.args()[3] === '777', '⚠️ unidade: a "FULL MERCADO LIVRE" lida da propria tela do importador');
  ok(n.args()[4] === 'false' && n.args()[5] === 'false', '⚠️ Lancar CONTAS: NAO e ESTOQUE: NAO (espelha a nativa do Full)');
  const reg = n.chamadas.find((c) => c.url.includes('/ml-full/ext/registrar'));
  const corpoReg = reg ? JSON.parse(reg.opts.body) : {};
  ok(corpoReg.importadas && corpoReg.importadas.join() === A + ',' + B && corpoReg.idEmpresa === '555' && corpoReg.empresa === 'girassol', '⚠️ registrou exatamente as chaves do ZIP (X-Chaves), com a conta 555');
  ok(/✅/.test(n.msg()) && /2 notas/.test(n.msg()) && /Magazine Girassol/.test(n.msg()), '  painel: "✅ Magazine Girassol: 2 notas do ML Full importadas" (nome vem do servidor)');
  // 2) PRIMEIRA VEZ: a conta precisa ser confirmada pelo dono (Codex #578 P1)
  n = navegador({ vinculoPendente: true }); await esperar(250);
  ok(n.proc().length === 0 && !n.chamadas.some((c) => c.url.includes('/ml-full/zip')), '⚠️ 1a vez nesta conta do Bling: NADA sobe antes da confirmacao do dono');
  ok(/Sim, esta conta é da Magazine Girassol/.test(n.btn().textContent || '') && n.btn().disabled === false && /nº 555/.test(n.msg()), '  ... o painel pergunta "esta conta (nº 555) é da Magazine Girassol?" com o botao de confirmar');
  n.btn()._h.click(); await esperar(350);
  const vinc = n.chamadas.find((c) => c.url.includes('/ml-full/ext/vincular'));
  ok(vinc && JSON.parse(vinc.opts.body).idEmpresa === '555' && n.proc().length === 1, '⚠️ o dono confirmou: o servidor grava a conta e a importacao que esperava ACONTECE');
  // 3) nada pendente: invisivel
  n = navegador({ pendentesIniciais: 0 }); await esperar(200);
  ok(!n.chamadas.some((c) => c.url.startsWith('/upload')) && !(n.painel() && n.painel()._cls.has('visivel')), '⚠️ nada pendente: nao importa e o painel fica INVISIVEL');
  // 4) outra conta do Bling (o servidor recusa)
  n = navegador({ contaErrada: true }); await esperar(200);
  ok(!n.chamadas.some((c) => c.url.startsWith('/upload')) && /NÃO é a da/.test(n.msg()), '⚠️ conta errada: o servidor recusa e nada sobe');
  // 5) falha REAL do Bling
  n = navegador({ respostaBling: 'XML não importado: erro de schema na nota 50001' }); await esperar(300);
  ok(!n.chamadas.some((c) => c.url.includes('/ext/registrar')) && /NÃO importou/.test(n.msg()), '⚠️ falha REAL no Bling: nada e registrado (tenta de novo na proxima)');
  // 6) duplicada = presenca confirmada
  n = navegador({ respostaBling: 'XML não importado: a nota 50001 já está registrada. XML não importado: a nota 50002 já está registrada.' }); await esperar(300);
  ok(n.chamadas.some((c) => c.url.includes('/ext/registrar')) && /já estavam lá/.test(n.msg()), '  duplicada ("ja esta registrada") conta como presente e sai da fila');
  // 7) registrar sem efeito: para
  n = navegador({ arquivadas: 0 }); await esperar(400);
  ok(n.proc().length === 1 && /parei/.test(n.msg()), '⚠️ registrar sem efeito: PARA (nao reimporta o mesmo lote 20x)');
  // 8) unidade ambigua: o dono escolhe UMA vez (Codex #578 P2: a escolha persiste)
  n = navegador({ unidades: [['1', 'FULL MERCADO LIVRE SP'], ['2', 'Full Mercado Livre MG']] }); await esperar(300);
  const opU = (n.els['#mlfull-opcoes'] || { filhos: [] }).filhos;
  ok(n.proc().length === 0 && opU.length === 2 && /unidade/i.test(n.msg()), '  duas unidades "Full ML": nao chuta — oferece as duas pra escolher');
  opU[1]._h.click(); await esperar(350);
  ok(n.loja.mlf_unidade === '2' && n.proc().length === 1 && n.args()[3] === '2', '⚠️ escolheu a 2: grava na config e importa com ela (e as proximas tambem)');
  // 9) sem unidade Full: importa sem unidade
  n = navegador({ unidades: [['', 'Selecione'], ['11', 'MATRIZ']] }); await esperar(300);
  ok(n.proc().length === 1 && n.args()[3] === '', '  conta sem unidade "Full ML": importa sem unidade');
  // 10) MULTILOJA
  n = navegador({ tbEmpresa: 'amb', habilitada: false }); await esperar(200);
  ok(!n.chamadas.some((c) => c.url.startsWith('/upload')) && !(n.painel() && n.painel()._cls.has('visivel')), '⚠️ multiloja: empresa sem a capacidade ml-full fica quieta (nada sobe, painel escondido)');
  n = navegador({ tbEmpresa: 'novacnpj' }); await esperar(300);
  ok(n.proc().length === 1 && n.chamadas.some((c) => c.url.includes('empresa=novacnpj')), '⚠️ multiloja: CNPJ NOVO habilitado no servidor ja importa (nenhuma empresa fixa na extensao)');
  n = navegador({ lojasML: [] }); await esperar(300);
  ok(n.proc().length === 1 && n.args()[2] === '203146903', '  sem loja no servidor: acha a "Mercado Livre" pelo nome na tela');
  // 11) loja ambigua vinda do servidor: o dono escolhe (Codex #578 P2)
  n = navegador({ lojasML: ['203146903', '203999999'], lojasTela: LOJAS_PADRAO.concat([['203999999', 'Mercado Livre 2']]) }); await esperar(300);
  const opL = (n.els['#mlfull-opcoes'] || { filhos: [] }).filhos;
  ok(n.proc().length === 0 && opL.length === 2, '⚠️ dois canais ML do servidor na tela: NAO escolhe o primeiro — oferece os dois');
  opL[1]._h.click(); await esperar(350);
  ok(n.loja.mlf_loja === '203999999' && n.args()[2] === '203999999', '  escolheu o segundo: grava e importa nele');
  // 12) ZIP grande: lote menor
  n = navegador({ tamanhoZip: (mx) => (mx > 50 ? 4000000 : 1200) }); await esperar(400);
  ok(n.chamadas.some((c) => /max=50/.test(c.url)) && n.proc().length === 1, '⚠️ ZIP de 4 MB no lote de 100: baixa de novo com 50 e importa (a fila nao trava)');
  // 13) sessao caiu no meio
  n = navegador({ redirectNoProcessar: true }); await esperar(300);
  ok(!n.chamadas.some((c) => c.url.includes('/ext/registrar')) && /sessão do Bling caiu/i.test(n.msg()), '⚠️ login no meio do processamento: nada e registrado (as notas nao saem da fila)');
  // 14) automatico DESLIGADO: abrir/salvar so mostra (Codex #578 P2)
  n = navegador({ storage: { mlf_automatico: false } }); await esperar(250);
  ok(n.proc().length === 0 && /Importar agora/.test(n.btn().textContent || ''), '⚠️ automatico desligado: so MOSTRA o que falta (botao Importar agora), nao importa sozinho');
  n.els['#mlfull-salvar']._h.click(); await esperar(300);
  ok(n.proc().length === 0, '  ... e salvar a configuracao tambem nao importa');
  n.btn()._h.click(); await esperar(350);
  ok(n.proc().length === 1, '  o clique em "Importar agora" importa');
  // 15) sem chave: pede no maximo 1x por dia
  n = navegador({ storage: { chave: '' } }); await esperar(150);
  ok(!n.chamadas.some((c) => c.url.includes('/ml-full/')) && /ADMIN_KEY/.test(n.msg()), '  sem ADMIN_KEY: pede pra configurar e nao chama o servidor');
  n = navegador({ storage: { chave: '', mlf_pediu_chave_em: new Date().toISOString().slice(0, 10) } }); await esperar(150);
  ok(!/ADMIN_KEY/.test(n.msg()), '  ... e no maximo 1x por dia (instancia que nao usa o Full nao fica sendo cobrada)');
  // estaticos: posicao do painel, contrato com o servidor, manifest
  ok(/#mlfull-painel\{position:fixed;left:322px;bottom:16px/.test(CODIGO), '  painel em left:322px — fora do caminho do Shopee (left:16/bottom:16) e do Magalu (bottom:360) (Codex #578 P2)');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'ml-full.js'), 'utf8');
  ok(["'/ml-full/ext/estado'", "'/ml-full/ext/registrar'", "'/ml-full/ext/vincular'", "'X-Chaves'", "'Access-Control-Expose-Headers'"].every((t) => srv.includes(t)), '⚠️ contrato: as rotas e o cabecalho que a extensao usa existem no servidor');
  const man = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'toolbox-extensao', 'manifest.json'), 'utf8'));
  const cs = (man.content_scripts || []).find((c) => (c.js || []).includes('ct-mlfull.js'));
  ok(cs && cs.js.indexOf('tb-importacao.js') > -1 && cs.js.indexOf('tb-importacao.js') < cs.js.indexOf('ct-mlfull.js'), '  manifest: ct-mlfull.js carrega DEPOIS do tb-importacao.js (usa o resumo dele)');
  console.log('');
  console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.log('FALHA (excecao):', e && e.stack); process.exit(1); });
