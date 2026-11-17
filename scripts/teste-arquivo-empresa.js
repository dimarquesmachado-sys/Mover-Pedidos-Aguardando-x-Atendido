'use strict';
/* 17/11 — NORTE C, montarCheckout, passo 14: O ARQUIVO DO CHECKOUT é a peça lib/checkout/arquivo-empresa.

   Era CÓPIA nas três pastas (`arquivo.js`, diferença só na tag do log). Aqui:
     1. a peça recusa sem empresa, sem base e com empresa fora do contrato;
     2. A PROVA DE QUE NADA MUDOU, pras três: o `arquivo.js` de antes de cada empresa (scripts/fixtures/arquivo-antes-*.js.txt)
        e a peça com a empresa dela rodam o MESMO cenário (purgar o cache, arquivar finalizados — com e sem os arquivos, com
        a pasta de destino quebrada —, podar o arquivo e os conferidos, nos dois formatos de etiqueta) e deixam o disco, o
        manifesto, as gravações e o log IGUAIS;
     3. o que o cenário espera, dito com todas as letras (pra quem ler saber o que a regra faz);
     4. pelos módulos reais: o `arquivo.js` de cada pasta é a fachada da peça com a empresa e o base DELA (as pastas que o
        base dela lê das envs dela), o ciclo da pasta usa o mesmo objeto, e a falha sai no log com a tag do contrato. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const raiz = path.join(__dirname, '..');
const PECA = require('../lib/checkout/arquivo-empresa');
const EMPRESAS = { girassol: 'girassol-backup-offline', amb: 'amb-checkout-offline', good: 'good-checkout-offline' };
const TAGS = { girassol: 'GIRABKP', amb: 'AMBBKP', good: 'GOODBKP' };
const DIA = 86400000;
const AGORA = Date.now();   /* as datas do cenário saem daqui (as duas rodadas têm que ter o mesmo disco) */

/* o arquivo.js de ANTES, carregado como módulo com o base de mentira no lugar do './base' da pasta */
function deAntes(emp, base) {
  const arq = path.join(__dirname, 'fixtures', 'arquivo-antes-' + emp + '.js.txt');
  const m = new Module(path.join(raiz, EMPRESAS[emp], 'arquivo.js'), module);
  m.filename = path.join(raiz, EMPRESAS[emp], 'arquivo.js');
  m.paths = Module._nodeModulePaths(path.join(raiz, EMPRESAS[emp]));
  m.require = (id) => (id === './base' ? base : require(id));
  m._compile(fs.readFileSync(arq, 'utf8'), m.filename);
  return m.exports;
}

function baseFalso(dir, fmt) {
  const gravou = [];
  const b = {
    CACHE_DIR: path.join(dir, 'cache'), ARQUIVO_DIR: path.join(dir, 'arquivo'), CONFERIDOS_FILE: path.join(dir, 'cache', 'conferidos.json'),
    RETENCAO_DIAS: 7, ARQUIVO_DIAS: 45, ETIQ_FORMATO: fmt,
    ensureDir: (d) => { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} },
    readJson: (f, p) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return p; } },
    writeJson: (f, v) => { gravou.push(path.relative(dir, f)); fs.writeFileSync(f, JSON.stringify(v, null, 2)); return true; },
  };
  return { b, gravou };
}

function escrever(f, txt) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); }
function envelhecer(f, dias) { const t = (AGORA - dias * DIA) / 1000; fs.utimesSync(f, t, t); }
function arvore(dir) {
  const out = {};
  (function anda(d) {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n), st = fs.statSync(p);
      if (st.isDirectory()) { out[path.relative(dir, p) + '/'] = ''; anda(p); }
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  })(dir);
  return out;
}

/* o MESMO cenário pra quem for rodado (o de antes ou a peça): devolve tudo que dá pra observar */
function cenario(fabrica, fmt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arq-emp-'));
  const { b, gravou } = baseFalso(dir, fmt);
  const C = b.CACHE_DIR, A = b.ARQUIVO_DIR;
  const iso = (dias) => new Date(AGORA - dias * DIA).toISOString();
  /* purgar: velho (10 d), meio (20 d — passa da retenção do cache, não da do arquivo), novo, sem data e data ilegível */
  const man = { 101: { cacheado_em: iso(10) }, 102: { cacheado_em: iso(1) }, 103: {}, 104: { cacheado_em: 'ontem' }, 105: { cacheado_em: iso(20) } };
  for (const id of Object.keys(man)) escrever(path.join(C, id, 'pedido.json'), '{"id":' + id + '}');
  /* arquivar: o completo, o só com pedido, o que não existe e o de destino quebrado (um ARQUIVO no lugar da pasta) */
  for (const n of ['etiqueta.zpl', 'etiqueta.pdf', 'etiqueta-correios.zpl', 'pedido.json', 'nf-simp.json', 'outro.txt']) escrever(path.join(C, '201', n), n + ' do 201');
  escrever(path.join(C, '202', 'pedido.json'), 'só o pedido');
  escrever(path.join(C, '300', 'pedido.json'), 'destino quebrado');
  escrever(path.join(A, '300'), 'sou um arquivo, não uma pasta');
  /* podar o arquivo: velho (50 d), meio (20 d), novo, e um ARQUIVO velho solto (não é pasta: fica) */
  for (const [n, d] of [['velho', 50], ['meio', 20], ['novo', 1]]) { escrever(path.join(A, n, 'pedido.json'), n); envelhecer(path.join(A, n), d); }
  escrever(path.join(A, 'solto.txt'), 'solto'); envelhecer(path.join(A, 'solto.txt'), 50);
  /* conferidos: sincronizado e velho (sai), sincronizado de 15 d, não sincronizado velho, nulo, sem data */
  escrever(b.CONFERIDOS_FILE, JSON.stringify({ a: { sincronizado: true, conferido_em: iso(40) }, f: { sincronizado: true, conferido_em: iso(15) },
    c: { conferido_em: iso(40) }, d: null, e: { sincronizado: true } }));

  const log = [];
  const orig = console.log;
  console.log = (...a) => log.push(a.map(String).join(' ').split(dir).join('<DIR>'));
  let r;
  try {
    const M = fabrica(b);
    const manDepois = JSON.parse(JSON.stringify(man));
    M.purgar(manDepois);
    for (const id of ['201', '202', '999', '300']) M.arquivarFinalizado(id);
    for (const n of ['velho', 'meio', 'novo']) envelhecer(path.join(A, n), { velho: 50, meio: 20, novo: 1 }[n]);   /* o arquivar não mexe, mas garante */
    M.purgarArquivo();
    M.purgarConferidos();
    const gravouAntes = gravou.length;
    M.purgarConferidos();   /* nada mais pra tirar: não grava */
    /* sem a pasta do arquivo: não quebra */
    const dirSem = fs.mkdtempSync(path.join(os.tmpdir(), 'arq-emp-vazio-'));
    fabrica(baseFalso(dirSem, fmt).b).purgarArquivo();
    r = { man: Object.keys(manDepois).sort(), disco: arvore(dir), gravou: gravou.slice(), gravouDeNovo: gravou.length - gravouAntes, log: log.slice(), semPasta: arvore(dirSem) };
  } finally { console.log = orig; }
  return r;
}

(async () => {
  /* 1. a peça recusa o que não tem */
  assert.throws(() => PECA.criar(), /falta empresa/);
  assert.throws(() => PECA.criar({ base: {} }), /falta empresa/);
  assert.throws(() => PECA.criar({ empresa: 'amb' }), /falta base/);
  assert.throws(() => PECA.criar({ empresa: 'amb', base: 'x' }), /falta base/);
  assert.throws(() => PECA.criar({ empresa: 'empresa-que-nao-existe', base: {} }), /empresa desconhecida no contrato/);

  /* 2 e 3. o de antes × a peça, as três, nos dois formatos de etiqueta */
  for (const emp of Object.keys(EMPRESAS)) {
    for (const fmt of ['ZPL', 'PDF']) {
      const antes = cenario((b) => deAntes(emp, b), fmt);
      const agora = cenario((b) => PECA.criar({ empresa: emp, base: b }), fmt);
      assert.deepStrictEqual(agora, antes, emp + '/' + fmt + ': a peça não faz o mesmo que o arquivo.js de antes da empresa');

      /* o que a regra faz (o mesmo pros dois — já provado igual acima) */
      /* (o pedido SEM data sai: `Date.parse(0)` lê "0" como o ano 2000 — é o comportamento de sempre, mantido; data ilegível fica) */
      assert.deepStrictEqual(agora.man, ['102', '104'], emp + ': o purgar tirou do manifesto o que não devia (ou deixou o velho)');
      for (const id of ['101', '103', '105']) assert.ok(!(('cache/' + id + '/') in agora.disco), emp + ': o purgar deixou a pasta do ' + id);
      for (const id of ['102', '104']) assert.ok(('cache/' + id + '/') in agora.disco, emp + ': o purgar apagou a pasta do ' + id);
      const no201 = Object.keys(agora.disco).filter((k) => k.startsWith('arquivo/201/') && k !== 'arquivo/201/').sort();
      const etq = 'arquivo/201/etiqueta.' + fmt.toLowerCase();
      assert.deepStrictEqual(no201, [...new Set([etq, 'arquivo/201/etiqueta.pdf', 'arquivo/201/etiqueta-correios.zpl', 'arquivo/201/nf-simp.json', 'arquivo/201/pedido.json'])].sort(),
        emp + '/' + fmt + ': o arquivar finalizado não guardou exatamente a etiqueta, o PDF, o ZPL do Madeira, o pedido e a NF');
      assert.strictEqual(agora.disco['arquivo/201/etiqueta-correios.zpl'], 'etiqueta-correios.zpl do 201');
      assert.deepStrictEqual(Object.keys(agora.disco).filter((k) => k.startsWith('arquivo/202/')).sort(), ['arquivo/202/', 'arquivo/202/pedido.json']);
      assert.ok(('arquivo/999/') in agora.disco && !Object.keys(agora.disco).some((k) => k.startsWith('arquivo/999/') && k !== 'arquivo/999/'), emp + ': pedido sem pasta no cache');
      assert.strictEqual(agora.log.length, 1, emp + ': o destino quebrado tinha que dar UMA linha de log: ' + JSON.stringify(agora.log));
      assert.ok(agora.log[0].startsWith('[' + TAGS[emp] + '] falha ao arquivar 300 '), emp + ': a falha não saiu com a tag da empresa: ' + agora.log[0]);
      assert.ok(!('arquivo/velho/' in agora.disco) && 'arquivo/meio/' in agora.disco && 'arquivo/novo/' in agora.disco && 'arquivo/solto.txt' in agora.disco,
        emp + ': o podar do arquivo tirou o que não devia (ou deixou o velho): ' + Object.keys(agora.disco).filter((k) => /^arquivo\/[^/]+\/?$/.test(k)).join(','));
      assert.deepStrictEqual(Object.keys(JSON.parse(agora.disco['cache/conferidos.json'])).sort(), ['c', 'd', 'f'], emp + ': o podar dos conferidos');   /* o sincronizado sem data sai (o mesmo `Date.parse(0)`) */
      assert.deepStrictEqual([agora.gravou, agora.gravouDeNovo], [['cache/conferidos.json'], 0], emp + ': os conferidos só são gravados quando algo sai');
      assert.deepStrictEqual(agora.semPasta, {}, emp + ': sem a pasta do arquivo, o podar não pode criar nada');
    }
  }

  /* 4. pelos módulos reais: cada pasta é a fachada da peça com a empresa e o base DELA */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arq-emp-real-'));
  for (const [emp, pasta] of Object.entries(EMPRESAS)) {
    process.env[TAGS[emp] + '_CACHE_DIR'] = path.join(tmp, emp, 'cache');
    process.env[TAGS[emp] + '_ARQUIVO_DIR'] = path.join(tmp, emp, 'arquivo');
    const s = fs.readFileSync(path.join(raiz, pasta, 'arquivo.js'), 'utf8');
    assert.strictEqual(s.split("require('../lib/checkout/arquivo-empresa').criar({ empresa: '" + emp + "', base: require('./base') })").length, 2,
      pasta + '/arquivo.js: não é a fachada da peça com a empresa dela e o base dela (exatamente uma vez)');
    assert.ok(!/\bfunction\b|=>/.test(s.replace(/\/\*[\s\S]*?\*\//g, '')), pasta + '/arquivo.js: sobrou regra na fachada');
    assert.ok(!/\bfunction (purgar|arquivarFinalizado|purgarArquivo|purgarConferidos)\b/.test(fs.readFileSync(path.join(raiz, pasta, 'ciclo.js'), 'utf8')), pasta + ': o ciclo voltou a ter cópia');
  }
  for (const [emp, pasta] of Object.entries(EMPRESAS)) {
    const M = require(path.join(raiz, pasta, 'arquivo.js'));
    const base = require(path.join(raiz, pasta, 'base.js'));
    assert.strictEqual(base.ARQUIVO_DIR, path.join(tmp, emp, 'arquivo'), emp + ': o teste não conseguiu apontar o base pra pasta temporária');
    escrever(path.join(base.CACHE_DIR, '501', 'pedido.json'), emp);
    M.arquivarFinalizado('501');
    const f501 = path.join(tmp, emp, 'arquivo', '501', 'pedido.json');
    assert.strictEqual(fs.existsSync(f501) ? fs.readFileSync(f501, 'utf8') : null, emp, emp + ': o arquivar não usou as pastas do base DELA');
    /* a falha sai com a tag do contrato */
    escrever(path.join(base.CACHE_DIR, '502', 'pedido.json'), 'x'); escrever(path.join(base.ARQUIVO_DIR, '502'), 'arquivo no lugar da pasta');
    const log = []; const orig = console.log; console.log = (...a) => log.push(a.map(String).join(' '));
    try { M.arquivarFinalizado('502'); } finally { console.log = orig; }
    assert.ok(log.length === 1 && log[0].startsWith('[' + TAGS[emp] + '] falha ao arquivar 502 '), emp + ': a falha não saiu com a tag dela: ' + JSON.stringify(log));
    /* o ciclo da pasta usa o MESMO objeto (o require dela) */
    const ciclo = fs.readFileSync(path.join(raiz, pasta, 'ciclo.js'), 'utf8');
    assert.ok(/arquivo: require\('\.\/arquivo'\)/.test(ciclo), pasta + ': o ciclo deixou de usar o arquivo da pasta');
  }
  /* cada uma na pasta DELA (nenhuma escreveu na de outra — as três rodaram o mesmo pedido, em sequência) */
  for (const emp of Object.keys(EMPRESAS)) assert.strictEqual(fs.readFileSync(path.join(tmp, emp, 'arquivo', '501', 'pedido.json'), 'utf8'), emp, emp + ': outra empresa escreveu no arquivo dela');

  console.log('ok — o arquivo do checkout é a peça lib/checkout/arquivo-empresa: igual ao de antes nas três (ZPL e PDF), fachadas com a empresa e o base de cada uma');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
