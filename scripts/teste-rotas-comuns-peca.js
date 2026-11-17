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
  /* 09/11: rotas que NASCERAM na peça (não existiam em nenhuma empresa — nada a comparar com o "antes"); cada uma tem
     que estar na peça e em NENHUM "antes". As outras 47 seguem rota por rota. */
  const NASCERAM = Object.keys(P).filter((k) => /\/ml-codigo-coleta$/.test(k));
  assert.strictEqual(NASCERAM.length, 1, 'a rota /ml-codigo-coleta (nasceu na peça em 09/11) sumiu ou duplicou: ' + NASCERAM.join(', '));
  for (const k of NASCERAM) assert.ok(!antes[k], emp + ': ' + k + ' está no "antes" — então não nasceu na peça');
  assert.strictEqual(Object.keys(P).length, 47 + NASCERAM.length, 'a peça não tem as 47 rotas (+ as que nasceram nela)');   /* 08/11: + /config-fiscal (passo 10b) */
//   /* 07/11: + /status (passo 6), + /dashboard (passo 7), + /custo-sync (passo 8); 08/11: + /sku-info (passo 9b) */
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
      .split("{ erro: 'painel: ' + e.message }").join(emp === 'girassol' || k !== 'GET /painel' ? "{ erro: 'painel: ' + e.message }" : "{ erro: 'painel.html: ' + e.message }")   /* 07/11: só a rota do painel tinha 'painel.html:' na AMB e na GOOD (o /dashboard das três usava 'painel:') */
      /* 17/11 (montarCheckout, passo 18): a orientação do de-para é UMA nas três (a GOOD tem o sku-repara desde o #915). NIVELAMENTO de
         propósito: na GOOD volta pro texto que ela tinha (mandava pro /sku-depara-manual, sem o sku-repara) */
      .replace(/        \/\* 17\/11 \(montarCheckout, passo 18\)[^]*?\*\/\n(        leia: )/, '$1')
      .split("leia: '" + _ol + ' });').join(emp === 'good' ? "leia: '" + _gl + ' });' : "leia: '" + _ol + ' });')
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
    /* 11/11 (dono: "jamais pode dar acesso ao dashboard pro estoquista... vai que um dia apaga" + auditoria do acesso do
       estoquista): /operadores avisa quando não há admin configurado (lista vazia = NINGUÉM é admin pelo login) e o
       /reaplicar-status passou a ser só de admin (antes qualquer operador logado alcançava) — trocas de propósito,
       revisadas linha a linha, nas três */
    const TROCAS_OPERADORES = [[['const _adm = lerAdmins();',
      "const _avisoAdm = _adm.length ? {} : { aviso_admin: 'nenhum admin configurado: ninguém é admin pelo login (só pela ADMIN_KEY) — preencha a variável de admins desta empresa no Render' };",
      'json(res, 200, Object.assign({ operadores: nomes, login_ativo: nomes.length > 0, admins: _adm }, _avisoAdm));'],
      ['json(res, 200, { operadores: nomes, login_ativo: nomes.length > 0, admins: lerAdmins() });']]];
    const TROCAS_REAPLICAR = [[["const kRS = lerChaveAdmin(req, urlObj), sRS = validarSessao(req.headers['cookie']);",
      "if (!((process.env.ADMIN_KEY && kRS === process.env.ADMIN_KEY) || (sRS && ehAdmin(sRS)))) { json(res, 404, { error: 'not found' }); return true; }",
      'json(res, 200, { ok: true, status: estadoImposto() }); return true;'],
      ['json(res, 200, { ok: true, status: estadoImposto() }); return true;']]];
    let r = codigo(como2);
    if (k === 'GET /reabrir/' && TROCAS_REABRIR[emp]) r = _trocar(r, TROCAS_REABRIR[emp]);
    if (k === 'GET /operadores') r = _trocar(r, TROCAS_OPERADORES);
    if (k === 'GET /reaplicar-status') r = _trocar(r, TROCAS_REAPLICAR);
    /* 12/11 (pedido do dono, caso KC3 da AMB): lançar/apagar faixa de custo passa a RECALCULAR as vendas daquele SKU dali em
       diante, e a consulta devolve o andamento (lib/checkout/custo-recalculo) — trocas de propósito, revisadas linha a
       linha, nas três */
    const TROCAS_CUSTO_HIST = [
      [['json(res, 200, { ok: true, sku, faixas,', 'recalculo: recalcCusto().estado(sku),', 'custo_atual_bling: doBling,'],
       ['json(res, 200, { ok: true, sku, faixas,', 'custo_atual_bling: doBling,']],
      [['const recA = (antes - lista.length) > 0 ? recalcCusto().pedir(sku, de) : recalcCusto().estado(sku);', 'json(res, 200, { ok: true, removidas: antes - lista.length, faixas: lista, recalculo: recA });'],
       ['json(res, 200, { ok: true, removidas: antes - lista.length, faixas: lista });']],
      [['const recL = recalcCusto().pedir(sku, de);', 'json(res, 200, { ok: true, faixas: lista, vigente_hoje: custoVigenteEm(sku, _hojeISO()), recalculo: recL, faixas_depois: b.substituir_seguintes === true ? 0 : _depois.length, substituidas: b.substituir_seguintes === true ? _depois.length : 0 });'],
       ['json(res, 200, { ok: true, faixas: lista, vigente_hoje: custoVigenteEm(sku, _hojeISO()) });']],
      /* 12/11 (caso KC6): o lançamento pode valer da data até hoje, substituindo as faixas mais novas */
      [['const _depois = lista.filter(f => String(f.de) > de);',
        'if (b.substituir_seguintes === true) lista = lista.filter(f => String(f.de) < de);',
        "lista.push({ custo: Math.round(custo * 10000) / 10000, de, ate: null, origem: 'manual', em: new Date().toISOString() });"],
       ["lista.push({ custo: Math.round(custo * 10000) / 10000, de, ate: null, origem: 'manual', em: new Date().toISOString() });"]]];
    if (k === '* /custo-historico') r = _trocar(r, TROCAS_CUSTO_HIST);
    /* 01/11 (auditoria Codex F10 e F06): o reabrir com a sessão só por POST e de dentro do sistema (a guarda), a trava
       também pelo id verdadeiro do pedido, e o "removido da fila" só quando a gravação deu certo -- as trocas de
       propósito, revisadas linha a linha, nas três */
    /* 07/11 (rotas comuns, passo 7): o /dashboard -- a tela da empresa chega por htmlDashboard (a configuração dela continua
       no arquivo dela); Girassol e AMB ganham o /dashboard-antigo da GOOD (leva pra tela única); a GOOD ganha a regra do dono
       "nunca estoquista" (só admin) que as outras duas já tinham. Trocas de propósito, revisadas linha a linha */
    /* 07/11: a /lista completa UMA vez o que o estoquista pega (pick/unidades/kits) dos pedidos que já estavam no cache —
       a troca de propósito, revisada linha a linha, nas três */
    /* 07/11 (rotas comuns, passo 8): o /custo-sync é a UNIÃO — o status ganhou a fila/retry da GOOD (Girassol, AMB) e o
       diário da Girassol/AMB (GOOD); o raio-X ?sku=&raw=1 da Girassol/AMB passa a existir na GOOD. Trocas revisadas */
    /* 08/11 (passo 9b): o /sku-info lê o cache DA EMPRESA pelo acesso dela (o mesmo objeto) — a única troca */
    /* 08/11 (passo 10b): o /config-fiscal — trocas de propósito revisadas (fixture) */
    if (k === 'GET /config-fiscal') r = _trocar(r, JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'rotas-comuns-config-fiscal-trocas.json'), 'utf8'))[emp]);
    if (k === 'POST /sku-info') r = _trocar(r, [[['let _skuInfoCache = lerSkuInfoCache();', 'if (!_skuInfoCache) { _skuInfoCache = readJson(CACHE_SKUINFO, {}); gravarSkuInfoCache(_skuInfoCache); }'],
      ['if (!_skuInfoCache) _skuInfoCache = readJson(CACHE_SKUINFO, {});']]]);
    if (k === 'GET /custo-sync') {
      const _T = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'rotas-comuns-custo-sync-trocas.json'), 'utf8'));
      if (emp === 'good') r = _trocar(r, [[_T.peca_status, _T.good_status], [_T.peca_raw, []]]);
      else r = _trocar(r, [[_T.peca_status, _T.gir_status]]);
    }
    if (k === 'GET /lista') r = _trocar(r, [
      [['if (m && m.pick === undefined) {', "const snapP = readJson(path.join(CACHE_DIR, String(i), 'pedido.json'), null);",
        "const _pk = snapP ? require('./pick-pedido').listaDoQuePegar(snapP.itens) : null;",
        'm.pick = _pk ? _pk.pick : null; m.unidades = _pk ? _pk.unidades : null; m.kits = _pk ? _pk.kits : [];', 'mexeu = true;', '}'], []]]);

    if (k === 'GET /dashboard') {
      const _tela = { girassol: "const htmlContent = require('../lib/checkout/painel/empresas').painelDaEmpresa('girassol', { defaultAliq: DEFAULT_ALIQ_BK });",
        amb: "const htmlContent = require('../lib/checkout/painel/empresas').painelDaEmpresa('ambtotal');" }[emp];
      const _ok200 = "res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(htmlContent);";
      if (emp === 'good') r = _trocar(r, [
        [["const sD = validarSessao(req.headers['cookie']);", 'const kD = lerChaveAdmin(req, urlObj);',
          "if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sD && ehAdmin(sD)))) { res.writeHead(302, { Location: '" + pref + "/painel' }); res.end(); return true; }"], []],
        [["if (p.endsWith('/dashboard-antigo')) {"], ["if (p === '" + pref + "/dashboard-antigo') {"]],
        [['const htmlContent = htmlDashboard();', _ok200],
         ["const _htmlNovo = require('../lib/checkout/painel/empresas').painelDaEmpresa('good', { defaultAliq: DEFAULT_ALIQ_BK_GOOD });", _ok200.replace('res.end(htmlContent)', 'res.end(_htmlNovo)')]]]);
      else r = _trocar(r, [
        [["if (method === 'GET' && (p === '" + pref + "/dashboard' || p === '" + pref + "/dashboard-antigo')) {"], ["if (method === 'GET' && p === '" + pref + "/dashboard') {"]],
        [["if (p.endsWith('/dashboard-antigo')) {", "res.writeHead(302, { Location: '" + pref + "/dashboard' + (urlObj.search || '') }); res.end();", 'return true;', '}'], []],
        [['const htmlContent = htmlDashboard();'], [_tela]]]);
    }
    if (k === 'GET /reabrir/') {
      const _tg = { amb: 'AMBBKP', good: 'GOODBKP', girassol: 'GIRABKP' }[emp];
      r = _trocar(r, [
        [["{ const _csrf = require('../lib/http/acao-segura').recusaCsrf(req, method);", 'if (_csrf) { json(res, 403, { ok: false, erro: _csrf }); return true; } }'], []],
        [['const _travasCanon = [];', "const _travarCanon = (cid) => { const k = '#canon:' + String(cid); if (_travasCanon.includes(k)) return true; if (_reabrindo.has(k)) return false; _reabrindo.add(k); _travasCanon.push(k); return true; };"], []],
        [["if (id && !_travarCanon(id)) { json(res, 200, { ok: false, arg, erro: 'ja estou reabrindo este pedido -- aguarde alguns segundos' }); return true; }"], []],
        [["if (!_travarCanon(achado.id)) { json(res, 200, { ok: false, arg, erro: 'ja estou reabrindo este pedido -- aguarde alguns segundos' }); return true; }"], []],
        [['if (writeJson(CONFERIDOS_FILE, confAtual) === false) {',
          'console.log(`[' + _tg + '] reabrir ${id}: NAO consegui gravar a fila de finalizados (Bling revertido=${revertido})`);',
          'json(res, 200, { ok: false, id, removido_da_fila: false, revertido_p_atendido: revertido,',
          "erro: 'nao consegui gravar a lista de finalizados (disco?) -- o pedido CONTINUA no historico' +",
          "(revertido ? ' (no Bling ele JA voltou pra ATENDIDO)' : '') + '. Tente de novo em alguns minutos.' });",
          'return true;', '}'], ['writeJson(CONFERIDOS_FILE, confAtual);']],
        [['} finally { _reabrindo.delete(arg); for (const k of _travasCanon) _reabrindo.delete(k); }'], ['} finally { _reabrindo.delete(arg); }']],
      ]);
    }
    /* 15/11 (auditoria do Codex, P2 nº 1 e nº 2): o id de pedido vindo de fora só com dígitos (14 rotas), o pertencimento no
       /etiqueta-anexar e o /qz-sign só logado e só pedido do QZ — trocas de propósito, revisadas linha a linha, iguais nas três
       (fixture rotas-comuns-id-pedido-trocas.json; {{TAG}} é o nome da empresa no log, {{PREF}} o prefixo). Antes das trocas do /pedido/ de 01/11 */
    { const _TI = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'rotas-comuns-id-pedido-trocas.json'), 'utf8'));
      const _tp = (l) => l.split('{{TAG}}').join(tag).split('{{PREF}}').join(pref);
      if (_TI[k]) r = _trocar(r, _TI[k].map(([novo, velho]) => [novo.map(_tp), velho.map(_tp)])); }
    if (k === 'GET /pedido/') r = _trocar(r, TROCAS_PEDIDO);
    /* 01/11 (auditoria Codex F02): o reenvio direto marca o pedido sobre a lista ATUAL de conferidos depois da espera do
       e-mail (antes regravava a lista lida antes do envio) — a troca de propósito, revisada, nas três */
    if (k === 'POST /pedir-reenvio/') r = _trocar(r, [[
      ["if (r.ok) require('./conferidos-atualizar').atualizarConferido(readJson, writeJson, CONFERIDOS_FILE, id, (e) => {", 'e.reenvios = (e.reenvios || 0) + 1;', 'e.ultimo_reenvio = { por: op, em: new Date().toISOString() };', '});'],
      ['if (r.ok && confR[id]) {', 'confR[id].reenvios = (confR[id].reenvios || 0) + 1;', 'confR[id].ultimo_reenvio = { por: op, em: new Date().toISOString() };', 'writeJson(CONFERIDOS_FILE, confR);', '}']]]);
    const a = codigo(antes[k]);
    if (JSON.stringify(a) !== JSON.stringify(r)) { const n = a.findIndex((x, i) => x !== r[i]); assert.fail(emp + ' ' + k + ': o código da peça não é o que a empresa tinha — linha ' + n + ':\n  antes: ' + String(a[n]).slice(0, 150) + '\n  agora: ' + String(r[n]).slice(0, 150)); }
  }
  const s = fs.readFileSync(path.join(raiz, pasta, arq), 'utf8');
  /* 17/11 (montarCheckout, passo 19): o arquivo entrega só a EMPRESA — o prefixo, a tag, o token do ML, o módulo da Madeira e o
     andamento do imposto saem do contrato (provado RODANDO logo abaixo, depois do laço) */
  const _ini = s.indexOf("require('../lib/checkout/rotas-comuns').criarRotasComuns({"), _bloco = s.slice(_ini, s.indexOf('\n  });', _ini));
  assert.ok(_ini > 0 && _bloco.includes("\n    empresa: '" + emp + "',") && s.includes('comuns: (req, res, urlObj, method, p) => _rotasComuns(readBody).handle(req, res, p, method, urlObj),'), emp + ': não monta/chama a peça com a empresa dela');
  assert.ok(!/\bprefixo:|\btag:|mmEtiquetas|mlTokenManager|estadoImposto/.test(_bloco), emp + ': voltou a escrever à mão o que é do contrato (prefixo, tag, Madeira, token do ML ou imposto)');
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
      o.lerChaveAdmin = () => 'adm'; o.rodarCiclo = async () => ({}); o.cicloMod = () => ({ zerarFreioShopee: () => 0 });
      o._resp = []; o.json = (res, code, body) => o._resp.push({ code, body }); return o; };
    const oA = mk('amb', 'amb-checkout-offline', 'AMBBKP'), oG = mk('good', 'good-checkout-offline', 'GOODBKP');
    const rA = criarRotasComuns(oA), rG = criarRotasComuns(oG);
    const bater = (r, pasta) => r.handle({ method: 'POST', headers: {} }, { writeHead() {}, end() {}, setHeader() {} }, '/' + pasta + '/ciclo-agora', 'POST', new URL('http://x/' + pasta + '/ciclo-agora?k=adm'));
    await bater(rA, 'amb-checkout-offline'); await bater(rA, 'amb-checkout-offline'); await bater(rG, 'good-checkout-offline');
    const txt = (o) => JSON.stringify(o._resp);
    assert.ok(/aguarde/.test(JSON.stringify(oA._resp[1])), 'o 2º "Bling agora" da AMB no mesmo minuto tinha que esperar: ' + txt(oA).slice(0, 200));
    assert.ok(oG._resp.length && !/aguarde/.test(JSON.stringify(oG._resp[0])), 'o "Bling agora" da GOOD foi travado pelo da AMB (a trava tem que ser por empresa): ' + txt(oG).slice(0, 200));
  }
  /* 17/11 (montarCheckout, passo 19): o que é da empresa SAI DO CONTRATO — RODANDO, montando a peça só com a empresa (sem prefixo,
     tag, token, Madeira nem imposto):
       · responde no prefixo do contrato (e não no de outra);
       · a tag é a do contrato: o e-mail do código da coleta lê a env <TAG>_EMAIL_CODIGO_COLETA DELA;
       · o token do ML é o do contrato (o mlTokenManager DELA, trocado por um falso no cache do require);
       · o andamento do imposto é o da loja dela (lib/imposto-cancelados);
       · a etiqueta da Madeira usa o módulo DELA (<loja>-mm-etiquetas, falso no cache do require); a AMB não tem — segue sem
         mapa, como sempre. */
  {
    process.env.ADMIN_KEY = 'adm';
    const CE = require('../lib/checkout/config-empresa');
    const imp = require('../lib/imposto-cancelados');
    for (const [emp, pasta] of EMP) {
      const cfg = CE.configCheckout(emp);
      const o = { empresa: emp }; for (const k of PECAS) o[k] = () => undefined;
      o.CACHE_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rc-contrato-'));
      o.readJson = (f, pdr) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return pdr; } };
      o.writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v));
      o.manifest = () => ({});
      o.lerChaveAdmin = () => 'adm'; o.validarSessao = () => null; o.ehAdmin = () => false;
      o.emailEmpresa = () => ({ EMAIL_DEST: 'estoque-padrao@x', EMAIL_USER: 'conta@x' });
      let auth = null; o.fetch = async (u, op) => { auth = op && op.headers && op.headers.Authorization; return { ok: true, status: 200, json: async () => ({ order_items: [{ quantity: 1, sale_fee: 7 }] }) }; };
      o.readBody = async () => ({ numeroLoja: '2000001' });
      const resp = []; o.json = (res, code, body) => resp.push({ code, body });
      const R = criarRotasComuns(o);
      const P = '/' + cfg.modulo;
      assert.strictEqual(P, '/' + pasta);
      const pedir = async (method, rota, qs) => { const u = new URL('http://x' + P + rota + (qs || '')); const tt = await R.handle({ method, headers: {} }, { writeHead() {}, setHeader() {}, end() {} }, P + rota, method, u); return { t: tt, r: resp[resp.length - 1] }; };
      /* a tag */
      process.env[cfg.tag + '_EMAIL_CODIGO_COLETA'] = 'coleta-' + emp + '@x';
      const cc = await pedir('GET', '/ml-codigo-coleta', '?k=adm');
      assert.ok(cc.t === true && cc.r.body.destino === 'coleta-' + emp + '@x', emp + ': a tag não é a do contrato (o código da coleta não leu a env dela): ' + JSON.stringify(cc.r && cc.r.body));
      delete process.env[cfg.tag + '_EMAIL_CODIGO_COLETA'];
      const outra = EMP.find((x) => x[0] !== emp)[1];
      assert.strictEqual(await R.handle({ method: 'GET', headers: {} }, {}, '/' + outra + '/ml-codigo-coleta', 'GET', new URL('http://x/' + outra + '/ml-codigo-coleta?k=adm')), false, emp + ': respondeu no prefixo da ' + outra);
      /* o token do ML */
      const arqTok = require.resolve(path.join(raiz, cfg.mlTokenManager));
      const tokAntes = require.cache[arqTok];
      require.cache[arqTok] = { id: arqTok, filename: arqTok, loaded: true, exports: { garantirTokenML: async () => 'tok-' + emp } };
      try {
        const fee = await pedir('POST', '/ml-fee');
        assert.ok(fee.t === true && fee.r.body.ok === true && fee.r.body.fee === 7 && auth === 'Bearer tok-' + emp, emp + ': a tarifa do ML não usou o token do contrato: ' + JSON.stringify(fee.r && fee.r.body) + ' ' + auth);
      } finally { if (tokAntes) require.cache[arqTok] = tokAntes; else delete require.cache[arqTok]; }
      /* o andamento do imposto */
      imp.estadoReaplicarImposto(cfg.loja).marca_teste = 'imp-' + emp;
      try {
        const st = await pedir('GET', '/reaplicar-status', '?k=adm');
        assert.ok(st.t === true && st.r.body.status && st.r.body.status.marca_teste === 'imp-' + emp, emp + ': o andamento do imposto não é o da loja dela');
      } finally { delete imp.estadoReaplicarImposto(cfg.loja).marca_teste; }
      /* a Madeira: o módulo DELA (a AMB não tem) */
      fs.mkdirSync(path.join(o.CACHE_DIR, '301'), { recursive: true });
      fs.writeFileSync(path.join(o.CACHE_DIR, '301', 'pedido.json'), JSON.stringify({ id: 301, numero_loja: 'MM-301' }));
      let arqMM = null, mmAntes = null;
      try { arqMM = require.resolve(path.join(raiz, cfg.loja + '-mm-etiquetas')); } catch (e) { arqMM = null; }
      assert.strictEqual(!!arqMM, emp !== 'amb', emp + ': o módulo da Madeira do contrato não é o que existe no repo');
      if (arqMM) { mmAntes = require.cache[arqMM]; require.cache[arqMM] = { id: arqMM, filename: arqMM, loaded: true, exports: { acharLote: (c) => (c === 'MM-301' ? { batch: 'B-' + emp } : null), zplPorBatch: async (b) => '^XA^FD' + b + '^FS^XZ' } }; }
      try { await pedir('GET', '/etiqueta-madeira-zpl/301'); } catch (e) { /* o resto da rota usa peças de mentira — aqui só importa o ZPL baixado */ }
      finally { if (arqMM) { if (mmAntes) require.cache[arqMM] = mmAntes; else delete require.cache[arqMM]; } }
      const zpl = path.join(o.CACHE_DIR, '301', 'etiqueta-correios.zpl');
      if (emp === 'amb') assert.ok(!fs.existsSync(zpl), 'amb: não vende no Madeira — não pode ter baixado etiqueta de mapa nenhum');
      else assert.strictEqual(fs.existsSync(zpl) ? fs.readFileSync(zpl, 'utf8') : null, '^XA^FDB-' + emp + '^FS^XZ', emp + ': a etiqueta da Madeira não veio do módulo DELA');
    }
  }
  /* 17/11 (montarCheckout, passo 18): o /sku-depara RODANDO nas três — o SKU renomeado sai como par e a orientação é a MESMA
     (usar o sku-repara, que troca o código no histórico). A GOOD dizia que não tinha o sku-repara nem o histórico no Supabase e
     mandava pro /sku-depara-manual — ela tem os dois desde o #915. */
  {
    process.env.ADMIN_KEY = 'adm';
    for (const [emp, pasta, tag] of EMP) {
      const o = { prefixo: '/' + pasta, tag, empresa: emp }; for (const k of PECAS) o[k] = () => undefined;
      o.CACHE_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'depara-'));
      fs.writeFileSync(path.join(o.CACHE_DIR, '_custos.json'), JSON.stringify({ 'SKU-VELHO': { id: 77, custo: 10 }, 'SKU-IGUAL': { id: 78, custo: 5 } }));
      o.readJson = (f, pdr) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return pdr; } };
      o.lerChaveAdmin = () => 'adm'; o.validarSessao = () => null;
      o.carregarCatalogoDePara = async () => ({ porCodigo: { 'SKU-NOVO': 77, 'SKU-IGUAL': 78 }, porId: { 77: 'SKU-NOVO', 78: 'SKU-IGUAL' } });
      const resp = []; o.json = (res, code, body) => resp.push({ code, body });
      const r = criarRotasComuns(o);
      const t2 = await r.handle({ method: 'GET', headers: {} }, {}, '/' + pasta + '/sku-depara', 'GET', new URL('http://x/' + pasta + '/sku-depara?k=adm'));
      const b2 = resp.length && resp[resp.length - 1].body;
      assert.ok(t2 === true && b2 && b2.ok === true && b2.renomeados === 1 && b2.pares[0].de === 'SKU-VELHO' && b2.pares[0].para === 'SKU-NOVO', emp + ': o /sku-depara não achou o renomeado: ' + JSON.stringify(b2).slice(0, 200));
      assert.strictEqual(b2.leia, 'de = codigo antigo (ainda no historico) · para = codigo de hoje. Nada foi alterado: use o sku-repara pra trocar no historico', emp + ': a orientação do de-para não é a mesma das outras');
    }
  }
  /* passo 5: a trava `_reabrindo` (um reabrir por vez por pedido) é estado DA EMPRESA — mora dentro da fábrica, uma por
     instância; no topo do módulo, as três empresas dividiriam a mesma (um pedido de mesmo número numa travaria a outra) */
  { const _src = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-comuns.js'), 'utf8');
    const _iF = _src.indexOf('function criarRotasComuns(o) {'), _iR = _src.indexOf('const _reabrindo = new Set();');
    assert.ok(_iF > 0 && _iR > _iF && _src.split('const _reabrindo = new Set();').length === 2, 'a trava _reabrindo tem que morar DENTRO da fábrica (uma por empresa)'); }
  let erro = null; try { criarRotasComuns({ prefixo: '/x' }); } catch (e) { erro = e.message; }
  assert.ok(erro && /falta peça da empresa/.test(erro), 'peça sem a configuração tinha que recusar');
  console.log('ok — rotas comuns em peça única: as 47 rotas, rota por rota, são o código que cada empresa tinha; as três chamam a peça; nada sobrou nos arquivos');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
