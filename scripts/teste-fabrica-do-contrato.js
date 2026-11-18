'use strict';
/* 17/11 — NORTE C, montarCheckout, passo 23: A FÁBRICA DO PAINEL TIRA O PREFIXO E O NOME DA EMPRESA DO CONTRATO.

   Cada arquivo de entrada escrevia à mão, na montagem da fábrica de rotas do painel, o prefixo das rotas e o nome de
   exibição da empresa (o título da tela de custo manual, os avisos do ML, o "backfill iniciado (só …)"). Agora o arquivo
   entrega a EMPRESA e a fábrica tira os dois de lib/checkout/config-empresa (o nome: `nomeEmpresa`, que é o do contrato —
   a GOOD declara o que o arquivo dela dava, "GOOD Import"); quem passar o seu fica com ele.
   Aqui: o nome de cada uma no contrato; RODANDO pelos três módulos reais, a tela de custo manual (servida pela fábrica)
   sai com o nome e o prefixo DELA; empresa fora do contrato sem prefixo derruba na montagem (dizendo por quê); e os três
   arquivos não escrevem mais nenhum dos dois. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const CE = require('../lib/checkout/config-empresa');
process.env.ADMIN_KEY = 'adm-fab';
const PASTAS = fs.mkdtempSync(path.join(os.tmpdir(), 'fab-contrato-'));
for (const [tag, e] of [['GIRABKP', 'girassol'], ['AMBBKP', 'amb'], ['GOODBKP', 'good']]) process.env[tag + '_CACHE_DIR'] = path.join(PASTAS, e);
process.on('exit', () => { try { fs.rmSync(PASTAS, { recursive: true, force: true }); } catch (e) {} });

const NOMES = { girassol: 'Magazine Girassol', amb: 'AMBTotal', good: 'GOOD Import' };
const EMP = [['girassol', 'girassol-backup-offline/gbo-app.js'], ['amb', 'amb-checkout-offline/index.js'], ['good', 'good-checkout-offline/index.js']];

(async () => {
  /* o nome de exibição no contrato (o que cada arquivo dava à fábrica) */
  for (const [emp] of EMP) assert.strictEqual(CE.configCheckout(emp).nomeEmpresa, NOMES[emp], emp + ': o nome de exibição do contrato não é o que o arquivo dela dava');

  /* empresa fora do contrato, sem prefixo: derruba na montagem, dizendo por quê (nunca monta rota sem prefixo) */
  const F = require('../lib/checkout/fabrica-rotas-painel');
  assert.throws(() => F.criarRotasPainel({ empresa: 'empresa-fora-do-contrato', pecas: {} }), /falta prefixo \(empresa fora do contrato: empresa-fora-do-contrato\)/);
  assert.throws(() => F.criarRotasPainel({ prefixo: '/x', pecas: {} }), /falta empresa/);

  /* RODANDO: a tela de custo manual, servida pela fábrica, com o nome e o prefixo de cada uma */
  const _l = console.log, _w = console.warn, _e = console.error; console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    for (const [emp, arq] of EMP) {
      const pref = CE.prefixoDe(emp);
      const h = require(path.join(raiz, arq)).routes(async () => ({}));
      const u = new URL('http://x' + pref + '/custos-manuais?k=adm-fab');
      const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
      await h({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u);
      assert.strictEqual(res._s, 200, emp + ': a tela de custo manual não abriu: ' + res._b.slice(0, 160));
      assert.ok(res._b.includes('<title>Custos manuais · ' + NOMES[emp] + '</title>'), emp + ': a tela não saiu com o nome dela: ' + (/<title>[^<]*<\/title>/.exec(res._b) || [''])[0]);
      assert.ok(res._b.includes("const MOD='" + pref + "'"), emp + ': a tela não saiu com o prefixo dela');
      for (const [outra] of EMP) if (outra !== emp) assert.ok(!res._b.includes(NOMES[outra] + '<') && !res._b.includes("const MOD='" + CE.prefixoDe(outra) + "'"), emp + ': a tela saiu com o nome ou o prefixo da ' + outra);
    }
  } finally { console.log = _l; console.warn = _w; console.error = _e; }

  /* os três arquivos entregam só a empresa à fábrica */
  for (const [emp, arq] of EMP) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    const i = s.indexOf("require('../lib/checkout/fabrica-rotas-painel').criarRotasPainel({");
    assert.ok(i > 0, arq + ': não monta a fábrica do painel');
    const cab = s.slice(i, s.indexOf('pecas:', i));
    assert.ok(new RegExp("\\bempresa: '" + emp + "',").test(cab), arq + ': não entrega a empresa dela à fábrica');
    assert.ok(!/\bprefixo:\s*'/.test(cab) && !/\bnomeEmpresa:\s*'/.test(cab), arq + ': voltou a escrever o prefixo ou o nome da empresa na montagem da fábrica');
  }
  console.log('ok — a fábrica do painel tira o prefixo e o nome da empresa do contrato (a tela de custo manual de cada uma sai com os dela); os arquivos só entregam a empresa');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
