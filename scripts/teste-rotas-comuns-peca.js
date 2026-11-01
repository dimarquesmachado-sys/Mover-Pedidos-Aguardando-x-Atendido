'use strict';
/* 31/10 — ROTAS COMUNS em peça única (lib/checkout/rotas-comuns): as 26 rotas que as TRÊS empresas tinham escritas iguais no
   arquivo delas (arquivos, DANFE, etiqueta, XML, impressão, login, operadores, QZ, reenvio de documentos, faturamento do ML,
   cookies da Shopee, separação) — ~560 linhas fora de cada um dos três arquivos. Prova:
   · rota por rota, o código da peça COMO CADA EMPRESA O RODA (prefixo — inclusive o do cookie da sessão —, nome no log e a
     chave dela no lugar) é o código que a empresa tinha (fixtures);
   · as três montam a peça com a configuração delas e chamam no lugar da primeira dessas rotas; nenhuma delas sobrou no
     arquivo de nenhuma empresa;
   · a peça atende de verdade (o certificado do QZ) no prefixo de cada empresa e passa adiante o que não é dela. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const codigo = require('./_codigo-ciclo');
const peca = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-comuns.js'), 'utf8');
const corpo = peca.slice(peca.indexOf('  async function handle(req, res, p, method, urlObj) {\n'), peca.indexOf('\n    return false;\n  }\n\n  return { handle };'));
function blocos(texto) {
  const L = texto.split('\n'), out = {};
  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    if (!/^\s*(if|else if)\s*\(/.test(l)) continue;
    const m = /\bp(?: ===|\.startsWith\() ?\(?'(\/[A-Za-z0-9_.-]*\/?)'/.exec(l.replace(/PREFIXO \+ '/g, "'"));
    if (!m) continue;
    const mm = /method === '([A-Z]+)'/.exec(l), k = (mm ? mm[1] : '*') + ' ' + m[1];
    const ind = l.length - l.trimStart().length; let j = i + 1;
    while (j < L.length && !(L[j].startsWith(' '.repeat(ind) + '}') && L[j].length - L[j].trimStart().length === ind)) j++;
    out[k] = L.slice(i, j + 1).join('\n');
  }
  return out;
}
const P = blocos(corpo);
const EMP = [['amb', 'amb-checkout-offline', 'AMBBKP', 'index.js'], ['good', 'good-checkout-offline', 'GOODBKP', 'index.js'], ['girassol', 'girassol-backup-offline', 'GIRABKP', 'gbo-app.js']];
for (const [emp, pasta, tag, arq] of EMP) {
  const pref = '/' + pasta;
  const antes = require('./fixtures/rotas-comuns-' + emp + '-antes.json').rotas;
  assert.strictEqual(Object.keys(P).length, 42, 'a peça não tem as 42 rotas');
  for (const k of Object.keys(antes)) {
    assert.ok(P[k], emp + ': a rota ' + k + ' não está na peça');
    /* passo 3 (as 6 quase iguais): o que é da empresa volta pro texto dela antes de comparar */
    const _gl = 'de = codigo antigo · para = codigo de hoje. Nada foi alterado. Na GOOD o conserto e\' +\n          \' pelo /sku-depara-manual (declara o par); o sku-repara das outras empresas troca o codigo\' +\n          \' NO HISTORICO do Supabase, que a GOOD ainda nao tem.\'';
    const _ol = 'de = codigo antigo (ainda no historico) · para = codigo de hoje. Nada foi alterado: use o sku-repara pra trocar no historico\'';
    /* passo 4: o que é da empresa nas 5 que divergiam (o arquivo/seller da Magalu, o módulo da Madeira, o token do ML, a
       empresa no aviso ao Devoluções) volta pro texto dela; e o que é NIVELAMENTO de propósito volta pro que ela tinha: a
       Girassol e a GOOD exigiam o módulo da Madeira (agora tolerante, como a AMB) e a GOOD lia o ZIP por uma variável dela */
    const _dirML = { amb: 'ambtotal', good: 'good', girassol: 'girassol' }[emp];
    let _p = P[k].split("'cancelados-' + EMPRESA + '.json'").join("'cancelados-" + emp + ".json'").split('sellerMagalu(EMPRESA)').join("sellerMagalu('" + emp + "')")
      .split("(EMPRESA, 'etiqueta_anexada'").join("('" + emp + "', 'etiqueta_anexada'")
      .split('const { garantirTokenML } = mlTokenManager();').join("const { garantirTokenML } = require('../" + _dirML + "/mlTokenManager');");
    if (emp === 'amb') _p = _p.split('mmEtq = mmEtiquetas();').join("mmEtq = require('../amb-mm-etiquetas');");
    else _p = _p.replace(/let mmEtq = null;\n[ \t]*try \{ mmEtq = mmEtiquetas\(\); \} catch \(e\) \{ mmEtq = null; \}[^\n]*/, "const mmEtq = require('../" + emp + "-mm-etiquetas');").split('if (mmEtq) for (const c of').join('for (const c of');
    /* a GOOD: lia o ZIP por uma variável dela; e na lista a data de emissão da NF vinha DEPOIS do numero_loja (só a ordem
       dos campos — o mesmo dado) */
    if (emp === 'good') _p = _p.split("const _zipEntradas = require('./zip-etiquetas').lerZipEntradas;").join('const _zipEntradas = lerZipEntradas;')
      .split(' nf_emissao: man[i].nf_emissao || null,').join('').split('numero_loja: man[i].numero_loja || null,').join('numero_loja: man[i].numero_loja || null, nf_emissao: man[i].nf_emissao || null,');
    _p = _p.split("require('./zip-etiquetas')").join("require('../checkout/zip-etiquetas')");   /* a troca geral logo abaixo põe o ../lib/ */
    const como = _p.split('<a href="\' + PREFIXO + \'/').join('<a href="' + pref + '/')
      .split("'sem cookie: env ' + TAG + '_SHOPEE_COOKIE").join("'sem cookie: env " + tag + '_SHOPEE_COOKIE')
      .split("avisos.push(TAG + '_SYNC_ON desligado").join("avisos.push('" + tag + '_SYNC_ON desligado')
      .split('cicloMod()').join("require('./ciclo')").split('painelMarca()').join("require('./painel-marca')")
      .split("require('./painel/painel-galpao')").join("require('../checkout/painel/painel-galpao')")   /* a troca geral logo abaixo põe o ../lib/ */
      .split("{ erro: 'painel: ' + e.message }").join(emp === 'girassol' ? "{ erro: 'painel: ' + e.message }" : "{ erro: 'painel.html: ' + e.message }")
      .replace(/leia: skuReparaNoHistorico === false\n[^\n]*\n\s*\? '([^]*?)\n\s*: '([^\n]*)' \}\);/, (x, g, o) => (emp === 'good' ? "leia: '" + g + ' });' : "leia: '" + o + "' });"))   /* o texto da GOOD já termina com a aspa */
      .split("'; Path=' + PREFIXO + '; HttpOnly").join("'; Path=" + pref + "; HttpOnly").split('p === PREFIXO ||').join("p === '" + pref + "' ||").split("PREFIXO + '/").join("'" + pref + '/')
      .split('`[${TAG}]').join('`[' + tag + ']').split('.includes(EMPRESA);').join(".includes('" + emp + "');").split('{ loja: EMPRESA, ').join("{ loja: '" + emp + "', ")
      /* Codex #781: os requires DENTRO das rotas vivem agora em lib/checkout ('../x'); na pasta da empresa eram '../lib/x' */
      .split("require('../").join("require('../lib/");
    /* os requires da empresa (token do ML, módulo da Madeira) são relativos à pasta DELA — desfaz o ../lib/ da troca geral */
    let _p5 = como;
    /* passo 5 (reabrir): o nome da empresa no aviso dos degraus; a situação DESPACHADOS que a Girassol e a GOOD liam do base */
    _p5 = _p5.split("degrau de ' + TAG + '_SIT_DEGRAUS'").join('degrau de ' + tag + "_SIT_DEGRAUS'");
    if (k === 'GET /reabrir/' && emp !== 'amb') _p5 = _p5.replace(/\bSIT_DESPACHADOS\b/g, "(require('./base').SIT_DESPACHADOS || 0)");
    const como2 = _p5.split("require('../lib/" + _dirML + "/mlTokenManager')").join("require('../" + _dirML + "/mlTokenManager')")
      .split("require('../lib/" + emp + "-mm-etiquetas')").join("require('../" + emp + "-mm-etiquetas')");
    /* passo 5 (reabrir): diferenças REVISADAS, linha a linha (o que a peça tem → o que a empresa tinha). Na GOOD e na Girassol,
       o mesmo log escrito de outro jeito (e a Girassol marcava "[GBO]" no lugar do nome dela); e o GANHO da Girassol: o prazo
       de 30s na leitura da situação no Bling (6 linhas da AMB/GOOD no lugar da 1 linha dela, sem prazo). Qualquer OUTRA
       diferença derruba a comparação. */
    const _RECUSA = (t) => [`console.log(\`[${t}] reabrir \${id} RECUSADO: o Bling nao aceitou voltar pra ATENDIDO\`);`];
    const TROCAS_REABRIR = {
      good: [[_RECUSA('GOODBKP'), ["console.log('[GOODBKP] reabrir ' + id + ' RECUSADO: o Bling nao aceitou voltar pra ATENDIDO');"]]],
      girassol: [
        [['console.log(`[GIRABKP] RESGATE: ${arg} (bling ${achado.id}) estava fora da fila e pos-checkout -> ATENDIDO`);'], ['console.log(`[GBO] RESGATE: ${arg} (bling ${achado.id}) estava fora da fila e pos-checkout -> ATENDIDO`);']],
        [['lerSituacao: async () => {', 'const _ac = new AbortController();', 'const _tm = setTimeout(() => _ac.abort(), 30000);', 'let r;', "try { r = await blingGet('/pedidos/vendas/' + encodeURIComponent(id), 3, _ac.signal); }", 'finally { clearTimeout(_tm); }'],
         ["lerSituacao: async () => { const r = await blingGet('/pedidos/vendas/' + encodeURIComponent(id), 3);"]],
        [_RECUSA('GIRABKP'), ["console.log('[GBO] reabrir ' + id + ' RECUSADO: o Bling nao aceitou voltar pra ATENDIDO');"]],
      ],
    };
    const _trocar = (linhas, trocas) => { let out = linhas.slice(); for (const [novo, velho] of trocas) { const n = out.findIndex((x, ix) => novo.every((y, d) => out[ix + d] === y)); assert.ok(n >= 0, emp + ' reabrir: a troca revisada não está na peça: ' + novo[0].slice(0, 80)); out = out.slice(0, n).concat(velho, out.slice(n + novo.length)); } return out; };
    /* 01/11 (auditoria Codex F01): a rota do pedido aceita UM pedaço só depois de /pedido/ (antes, o último pedaço de
       qualquer caminho) — a troca de propósito, revisada, nas três */
    const TROCAS_PEDIDO = [[["const _seg = p.slice(('/" + pasta + "/pedido/').length);", "if (!/^[^/]+$/.test(_seg)) { json(res, 404, { erro: 'pedido não cacheado' }); return true; }", 'const id = _seg;'],
      ["const id = p.split('/').filter(Boolean).pop();"]]];
    let r = codigo(como2);
    if (k === 'GET /reabrir/' && TROCAS_REABRIR[emp]) r = _trocar(r, TROCAS_REABRIR[emp]);
    if (k === 'GET /pedido/') r = _trocar(r, TROCAS_PEDIDO);
    const a = codigo(antes[k]);
    if (JSON.stringify(a) !== JSON.stringify(r)) { const n = a.findIndex((x, i) => x !== r[i]); assert.fail(emp + ' ' + k + ': o código da peça não é o que a empresa tinha — linha ' + n + ':\n  antes: ' + String(a[n]).slice(0, 150) + '\n  agora: ' + String(r[n]).slice(0, 150)); }
  }
  const s = fs.readFileSync(path.join(raiz, pasta, arq), 'utf8');
  assert.ok(s.includes("prefixo: '" + pref + "', tag: '" + tag + "', empresa: '" + emp + "',") && s.includes('if (await _rotasComuns(readBody).handle(req, res, p, method, urlObj)) return true;'), emp + ': não monta/chama a peça');
  /* passo 4: o módulo da Madeira e o token do ML que a empresa entrega são OS DELA (a AMB não vende no Madeira: o require
     dela falha e a rota segue sem mapa, como já era) */
  const _dir = { amb: 'ambtotal', good: 'good', girassol: 'girassol' }[emp];
  assert.ok(s.includes("mmEtiquetas: () => require('../" + emp + "-mm-etiquetas'), mlTokenManager: () => require('../" + _dir + "/mlTokenManager'),"), emp + ': a peça não recebe o módulo da Madeira / o token do ML DELA');
  if (emp !== 'amb') assert.ok(fs.existsSync(path.join(raiz, emp + '-mm-etiquetas')), emp + ': o módulo da Madeira dela sumiu');
  for (const k of Object.keys(antes)) {
    const rota = k.split(' ')[1];
    const re = new RegExp("\\bp(?: ===|\\.startsWith\\() ?\\(?'" + (pref + rota).replace(/[/.*+?^${}()|[\]\\-]/g, '\\$&') + "'");
    /* só BLOCO de rota conta (linha que abre com if/else if) — a lista do porteiro de sessão também cita o caminho, e fica */
    assert.ok(!s.split('\n').some((l) => /^\s*(if|else if)\s*\(/.test(l) && re.test(l)), emp + ': sobrou a rota ' + k + ' no arquivo');
  }
}
/* 31/10 (passo 2): QUEM RESPONDE. A fábrica do painel também atende /custo-historico e /tiktok-custo-devolucoes, e em
   empresa onde ela é chamada ANTES da peça comum (a GOOD), a rota só chega na peça comum se estiver na lista de rotas
   PRÓPRIAS da empresa (a fábrica pula as próprias). Toda rota que as duas atendem tem que estar nessa lista, nas três —
   senão a resposta troca de dona em silêncio. */
{
  const fab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');
  const daFabrica = new Set([...fab.matchAll(/^\s*(?:if|else if)\s*\([^\n]*\bp === \(?PREFIXO \+ '\/([A-Za-z0-9_.-]+)'/gm)].map((m) => m[1]));
  const comuns = new Set(Object.keys(P).map((k) => k.split(' ')[1].replace(/^\//, '').replace(/\/$/, '')));
  const asDuas = [...daFabrica].filter((r) => comuns.has(r));
  assert.ok(asDuas.includes('custo-historico') && asDuas.includes('tiktok-custo-devolucoes'), 'a conferência não achou as rotas que as duas atendem: ' + JSON.stringify(asDuas));
  for (const [emp, pasta, , arq] of EMP) {
    const s2 = fs.readFileSync(path.join(raiz, pasta, arq), 'utf8');
    const m = /rotasProprias:\s*\[([^\]]*)\]/.exec(s2);
    const proprias = new Set(m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []);
    for (const r of asDuas) assert.ok(proprias.has(r), emp + ': /' + r + ' é atendida pela fábrica E pela peça comum, mas não está nas rotas PRÓPRIAS da empresa — a fábrica responderia no lugar');
  }
}
(async () => {
  const { criarRotasComuns, PECAS } = require('../lib/checkout/rotas-comuns');
  for (const [emp, pasta, tag] of EMP) {
    const o = { prefixo: '/' + pasta, tag, empresa: emp };
    for (const k of PECAS) o[k] = () => undefined;
    o.QZ_CERT = 'CERT-' + emp;
    const r = criarRotasComuns(o);
    let corpoResp = '';
    const res = { writeHead() {}, setHeader() {}, end(b) { corpoResp += String(b || ''); } };
    const t = await r.handle({ method: 'GET', headers: {} }, res, '/' + pasta + '/qz-cert', 'GET', new URL('http://x/' + pasta + '/qz-cert'));
    assert.ok(t === true && corpoResp.includes('CERT-' + emp), emp + ': o certificado do QZ não saiu no prefixo da empresa');
    assert.strictEqual(await r.handle({ method: 'GET', headers: {} }, res, '/' + pasta + '/nao-existe', 'GET', new URL('http://x/')), false, emp + ': rota que não é dela tinha que passar adiante');
  }
  /* Codex #781: as rotas que carregam um módulo da lib DENTRO delas (NFs travadas) funcionam de verdade, nas três — antes do
     conserto o require apontava pra lib/lib/… e a rota dava 500 "Cannot find module" */
  const os = require('os');
  for (const [emp, pasta, tag] of EMP) {
    const o = { prefixo: '/' + pasta, tag, empresa: emp };
    for (const k of PECAS) o[k] = () => undefined;
    o.CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trav-'));
    const respostas = [];
    o.json = (res, code, body) => respostas.push({ code, body });
    o.lerChaveAdmin = () => null;
    const r = criarRotasComuns(o);
    await r.handle({ method: 'GET', headers: {} }, {}, '/' + pasta + '/nf-travadas', 'GET', new URL('http://x/' + pasta + '/nf-travadas'));
    const ult = respostas[respostas.length - 1];
    assert.ok(ult && ult.code === 200 && !/Cannot find module/.test(JSON.stringify(ult.body)), emp + ': /nf-travadas não respondeu (o módulo da lib não carregou?): ' + JSON.stringify(ult).slice(0, 200));
  }
  /* passo 3: a trava do "Bling agora" (1 disparo por minuto) mora na peça, UMA POR EMPRESA — era uma variável no arquivo de
     cada uma; se a peça dividisse a trava, o botão de uma empresa bloquearia o das outras */
  {
    process.env.ADMIN_KEY = 'adm';
    const mk = (emp, pasta, tag) => { const o = { prefixo: '/' + pasta, tag, empresa: emp }; for (const k of PECAS) o[k] = () => undefined;
      o.lerChaveAdmin = () => 'adm'; o.rodarCiclo = async () => ({}); o.cicloMod = () => ({ zerarFreioShopee: () => 0 }); o.skuReparaNoHistorico = true;
      o._resp = []; o.json = (res, code, body) => o._resp.push({ code, body }); return o; };
    const oA = mk('amb', 'amb-checkout-offline', 'AMBBKP'), oG = mk('good', 'good-checkout-offline', 'GOODBKP');
    const rA = criarRotasComuns(oA), rG = criarRotasComuns(oG);
    const bater = (r, pasta) => r.handle({ method: 'POST', headers: {} }, { writeHead() {}, end() {}, setHeader() {} }, '/' + pasta + '/ciclo-agora', 'POST', new URL('http://x/' + pasta + '/ciclo-agora?k=adm'));
    await bater(rA, 'amb-checkout-offline'); await bater(rA, 'amb-checkout-offline'); await bater(rG, 'good-checkout-offline');
    const txt = (o) => JSON.stringify(o._resp);
    assert.ok(/aguarde/.test(JSON.stringify(oA._resp[1])), 'o 2º "Bling agora" da AMB no mesmo minuto tinha que esperar: ' + txt(oA).slice(0, 200));
    assert.ok(oG._resp.length && !/aguarde/.test(JSON.stringify(oG._resp[0])), 'o "Bling agora" da GOOD foi travado pelo da AMB (a trava tem que ser por empresa): ' + txt(oG).slice(0, 200));
  }
  /* passo 5: a trava `_reabrindo` (um reabrir por vez por pedido) é estado DA EMPRESA — mora dentro da fábrica, uma por
     instância; no topo do módulo, as três empresas dividiriam a mesma (um pedido de mesmo número numa travaria a outra) */
  { const _src = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-comuns.js'), 'utf8');
    const _iF = _src.indexOf('function criarRotasComuns(o) {'), _iR = _src.indexOf('const _reabrindo = new Set();');
    assert.ok(_iF > 0 && _iR > _iF && _src.split('const _reabrindo = new Set();').length === 2, 'a trava _reabrindo tem que morar DENTRO da fábrica (uma por empresa)'); }
  let erro = null; try { criarRotasComuns({ prefixo: '/x' }); } catch (e) { erro = e.message; }
  assert.ok(erro && /falta peça da empresa/.test(erro), 'peça sem a configuração tinha que recusar');
  console.log('ok — rotas comuns em peça única: as 42 rotas, rota por rota, são o código que cada empresa tinha; as três chamam a peça; nada sobrou nos arquivos');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
