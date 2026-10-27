'use strict';
/* 17/10 — venda do ML com PRAZO DE DISPONIBILIDADE (envio pending/manufacturing: "Aguardando disponibilidade de
   estoque"; a etiqueta só sai depois de "Já estou com o produto"). O dono vende assim de propósito, pra faturar no mês
   seguinte. O checkout tratava como "sem etiqueta" (problema do galpão). Prova, nas três empresas:
   (1) o ciclo de produção reconhece o envio pending/manufacturing na mesma consulta do Full, NÃO pede etiqueta, grava
       aguardando_disp no pedido e no manifesto, e o resumo do topo não conta como sem etiqueta;
   (2) a /lista de produção tira esses pedidos da fila de sem etiqueta e devolve à parte;
   (3) o painel mostra o aviso. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
for (const [emp, ciclo, painel] of [['AMB', 'amb-checkout-offline/ciclo.js', 'amb-checkout-offline/painel.html'], ['GOOD', 'good-checkout-offline/ciclo.js', 'good-checkout-offline/painel.html'], ['Girassol', 'girassol-backup-offline/ciclo.js', 'girassol-backup-offline/painel.html']]) {
  const src = fs.readFileSync(path.join(raiz, ciclo), 'utf8');
  assert.ok(/_stML = \(jS && jS\.status\) \|\| null; _subML = \(jS && jS\.substatus\) \|\| null;/.test(src), emp + ': o status do envio não é lido na consulta do Full');
  /* o ML usa o substatus manufacturing tanto em pending quanto em handling — a decisão não pode exigir 'pending' */
  const iD = src.indexOf("} else if (_stOk ? /manufacturing|buffered/i.test(String(_subML || '')) : _dispAntes) {");
  /* envio programado (buffered) também espera o ML; consulta que falhou mantém a marca anterior (Codex #706) */
  assert.ok(/const _dispAntes = \(\(\) => \{ try \{ const ps = JSON\.parse\(fs\.readFileSync\(path\.join\(dir, 'pedido\.json'\)[^\n]*ps\.aguardando_disp/.test(src) && /let _aguardaDispML = _dispAntes;/.test(src), emp + ': a marca da rodada anterior não é lida (ML fora devolveria o pedido à fila)');
  assert.ok(/_subML = \(jS && jS\.substatus\) \|\| null; _stOk = true;/.test(src), emp + ': não registra que a consulta respondeu');
  assert.ok(/\} else \{\n      if \(_stOk\) _aguardaDispML = false;/.test(src), emp + ': liberado no ML não volta ao normal');
  assert.ok(src.includes("if (/manufacturing|buffered/i.test(String(st.substatus || ''))) _aguardaDispML = true;"), emp + ': a consulta de reforço bem-sucedida não classifica o pedido como aguardando');
  assert.ok(!/_stML === 'pending' &&\/manufacturing\//.test(src), emp + ': ainda exige status pending (handling/manufacturing escaparia)');
  const iL = src.indexOf('https://api.mercadolibre.com/shipment_labels', src.indexOf('let _logiML'));
  assert.ok(iD > 0 && iL > iD, emp + ': o "aguardando disponibilidade" tem que ser decidido ANTES de pedir a etiqueta');
  assert.ok(/_aguardaDispML = true;/.test(src.slice(iD, iL)), emp + ': não marca o pedido');
  assert.ok(/aguardando_disp: !!_aguardaDispML && !\(temEtiqueta \|\| etiquetaMM\),/.test(src) && /aguardando_disp: !!snap\.aguardando_disp,/.test(src), emp + ': a marca não vai pro pedido/manifesto');
  assert.ok(/semEtiqueta: ids\.filter\(i => !man\[i\]\.tem_etiqueta && !man\[i\]\.full_ml && !man\[i\]\.aguardando_disp\)\.length/.test(src), emp + ': o resumo do topo ainda conta como sem etiqueta');
  const pn = require('./_fonte-painel').ler(raiz, painel);   /* 27/10: o painel servido (peça única) */
  assert.ok(/function _avisoDispML\(d\)/.test(pn) && /\+ _avisoFullML\(d\) \+ _avisoDispML\(d\);/.test(pn), emp + ': o painel não mostra o aviso');
}
let _fim = false;
process.on('beforeExit', () => { if (!_fim) { console.error('FALHOU: o teste terminou sem chegar ao fim'); process.exitCode = 1; } });
(async () => {
  process.env.ADMIN_KEY = 'chave-teste';
  require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async () => { throw new Error('sem rede'); } };
  for (const [emp, arq, pref, envDir] of [['AMB', 'amb-checkout-offline/index.js', '/amb-checkout-offline', 'AMBBKP_CACHE_DIR'],
                                           ['GOOD', 'good-checkout-offline/index.js', '/good-checkout-offline', 'GOODBKP_CACHE_DIR'],
                                           ['Girassol', 'girassol-backup-offline/gbo-app.js', '/girassol-backup-offline', 'GIRABKP_CACHE_DIR']]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disp-' + emp + '-')); process.env[envDir] = dir;
    const base = { cliente: 'X', nf_emissao: '2026-10-16', nf_id: 1, marketplace: 'ml', tem_etiqueta: false };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      '777': Object.assign({ numero: 123800, nf_numero: '129500', etq_motivo: 'o ML ainda não liberou a etiqueta' }, base),
      '888': Object.assign({ numero: 123867, nf_numero: '129528', aguardando_disp: true, etq_motivo: 'aguardando disponibilidade de estoque no ML' }, base) }));
    const mod = require(path.join(raiz, arq));
    const h = mod.routes(async () => ({}));
    const u = new URL('http://x' + pref + '/lista?k=chave-teste');
    const res = { _s: 0, _b: '', writeHead(st) { this._s = st; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
    await h({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u);
    const o = JSON.parse(res._b);
    assert.deepStrictEqual(o.sem_etiqueta_pedidos.map(x => String(x.numero)), ['123800'], emp + ': o pedido aguardando disponibilidade continua na fila de sem etiqueta');
    assert.strictEqual(o.sem_etiqueta, 1, emp + ': a contagem de sem etiqueta ainda inclui o aguardando disponibilidade');
    assert.deepStrictEqual((o.aguardando_disp_pedidos || []).map(x => String(x.numero)), ['123867'], emp + ': o aguardando disponibilidade não veio à parte pro aviso');
  }
  _fim = true;
  console.log('ok — venda do ML aguardando disponibilidade sai da fila de sem etiqueta e aparece num aviso, nas três empresas');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
