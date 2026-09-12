'use strict';
/* ─── ESCRITO ANTES DA EXTRAÇÃO (11/09) ────────────────────────────────────────
   A condição que eu mesmo pus pra tocar nesta rotina: ela estreou em 10/09, roda
   às 23h e decide a margem do dia seguinte — só sai do arquivo com teste que
   descreva o que ela promete. Cada caso abaixo é uma promessa lida no código:

     1. dia já concluído não roda de novo (o carimbo sobrevive a restart)
     2. sync em curso adia, não atropela
     3. 1ª noite = semente em DUAS passadas (a 2ª recalcula os kits)
     4. semente com FALHAS não fecha o dia — até 3 tentativas
     5. na 3ª tentativa fecha, com as pendências declaradas
     6. dia só fecha quando o sync rodou LIMPO
   ──────────────────────────────────────────────────────────────────────────── */
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const criar = require('../lib/checkout/custo-diario').criar;

function ambiente(cacheInicial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custo-diario-'));
  const CUSTO_FILE = path.join(dir, '_custos.json');
  fs.writeFileSync(CUSTO_FILE, JSON.stringify(cacheInicial || {}));
  const chamadas = { sync: [], bling: 0 };
  const _cst = { rodando: false, falhas: 0, inicio: null };
  const api = criar({
    CUSTO_FILE,
    readJson: (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } },
    escrever: (p, o) => fs.writeFileSync(p, JSON.stringify(o)),
    estadoSync: () => _cst,
    custoSync: async (fresh) => { chamadas.sync.push(fresh); _cst.inicio = Date.now() + chamadas.sync.length; },
    blingGet: async () => { chamadas.bling++; return { ok: true, data: { data: [] } }; },
    registrarCustoVigente: () => {},
    lerVigenciaDe: () => null, gravarVigenciaDe: () => {},
  });
  return { api, chamadas, _cst, CUSTO_FILE, ler: () => JSON.parse(fs.readFileSync(CUSTO_FILE, 'utf8')) };
}

(async () => {
  // 1) dia já concluído: não roda de novo
  {
    const e = ambiente({ _sementeCompleta: 1, _custoDiarioDia: e0Dia() });
    await e.api.custoDiario();
    assert.strictEqual(e.chamadas.sync.length, 0, 'dia já carimbado não pode re-rodar');
  }
  // 2) sync em curso: adia
  {
    const e = ambiente({ _sementeCompleta: 1 });
    e._cst.rodando = true;
    await e.api.custoDiario();
    assert.strictEqual(e.chamadas.sync.length, 0, 'com custo-sync em curso tem que adiar');
    assert.ok(String(JSON.stringify(e.api.estado())).includes('adiado'), 'e declarar que adiou');
  }
  // 3) primeira noite: semente em DUAS passadas quando há kits
  {
    const e = ambiente({ K1: { id: 1, custo: 5, comps: ['id:2'], ts: 111 }, P2: { id: 2, custo: 2, ts: 111 } });
    await e.api.custoDiario();
    assert.deepStrictEqual(e.chamadas.sync, [true, false], '1ª noite: fresh completo e depois a passada dos kits');
    assert.strictEqual(e.ler().K1.ts, 0, 'o kit tem que ter sido marcado pra re-somar na 2ª passada');
    assert.ok(e.ler()._sementeCompleta, 'semente limpa fecha e carimba');
  }
  // 4) semente com falhas NÃO fecha, e re-tenta
  {
    const e = ambiente({ K1: { id: 1, custo: 5, comps: ['id:2'], ts: 1 } });
    e._cst.falhas = 2;
    await e.api.custoDiario();
    assert.ok(!e.ler()._sementeCompleta, 'com falhas a semente não pode fechar');
    assert.ok(!e.ler()._custoDiarioDia, 'e o dia não pode ser carimbado');
    assert.ok(String(JSON.stringify(e.api.estado())).includes('1/3'), 'declara a tentativa 1 de 3');
  }
  // 5) terceira tentativa fecha, com pendências declaradas
  {
    const e = ambiente({ K1: { id: 1, custo: 5, comps: ['id:2'], ts: 1 } });
    e._cst.falhas = 2;
    await e.api.custoDiario();
    await e.api.custoDiario();
    await e.api.custoDiario();
    assert.ok(e.ler()._sementeCompleta, 'na 3ª tentativa fecha (o TTL cobre o resto)');
    assert.ok(String(JSON.stringify(e.api.estado())).includes('pendência'), 'e declara as pendências');
  }
  // 6) incremental: dia fecha quando o sync roda limpo
  {
    const e = ambiente({ _sementeCompleta: 1, A1: { id: 9, custo: 3, ts: 1 } });
    await e.api.custoDiario();
    assert.ok(e.ler()._custoDiarioDia, 'sem falhas, o dia fecha');
  }
  console.log('OK: custo diário — não re-roda dia fechado, adia com sync em curso, semente em 2 passadas, falha não fecha, 3ª tentativa declara, dia limpo carimba');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });

function e0Dia() {
  const ag = new Date();
  return (ag.getHours() >= 23)
    ? new Date(ag.getTime() - ag.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
    : new Date(ag.getTime() - ag.getTimezoneOffset() * 60000 - 86400000).toISOString().slice(0, 10);
}
