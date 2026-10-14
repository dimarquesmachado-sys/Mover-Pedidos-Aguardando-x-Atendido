'use strict';
/* 14/10 — parecer do Codex (6.3): o backfill ignorava o resultado do DELETE do período e inseria
   por cima; com o Supabase recusando, terminava "ok" com linha velha + nova. Exercita o TRECHO DE
   PRODUÇÃO das duas cópias (Girassol — que também serve a GOOD — e AMB), recortado do arquivo:
   do DELETE até o laço de inserção. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

function trecho(arq, fn) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const marca = "await " + fn + "(empresa, 'DELETE', 'vendas_historico?empresa=eq.'+encodeURIComponent(empresa)+'&data_venda=gte.'+de+'&data_venda=lte.'+ate, null);";
  const i = s.indexOf(marca);
  assert.ok(i > 0, arq + ': DELETE do período não encontrado');
  const ini = s.lastIndexOf('\n', s.lastIndexOf('let _delP = null;', i)) + 1;
  const fim = s.indexOf('for await (const lote of lerLotes(200))', i);
  assert.ok(fim > i, arq + ': laço de inserção não encontrado depois do DELETE');
  return s.slice(ini, fim).replace("_delPausa = 1500", "_delPausa = 0");
}
(async () => {
  for (const [arq, fn] of [['girassol-backup-offline/gbo-app.js', '_supaReq'], ['amb-checkout-offline/index.js', 'supaReq']]) {
    const corpo = trecho(arq, fn);
    const roda = new Function(fn, 'empresa', 'de', 'ate', '_backfill', '_limparSpool',
      'return (async () => {\n' + corpo + '\nreturn "SEGUIU_PRA_INSERCAO";\n})();');
    for (const [resp, transEsperado] of [[{ ok: false, status: 503, body: 'x' }, true], [{ ok: false, status: 401 }, false], [{ ok: false, status: 0, erro: 'ENOTFOUND' }, true], [null, true]]) {
      const bf = { rodando: true, erros: 0, fase: 'gravando', msg: '' }; let limpou = 0; const chamadas = [];
      const r = await roda(async (e, m, q) => { chamadas.push(m + ' ' + q); return resp; }, 'good', '2026-10-01', '2026-10-13', bf, () => { limpou++; });
      assert.notStrictEqual(r, 'SEGUIU_PRA_INSERCAO', arq + ': DELETE recusado (' + JSON.stringify(resp) + ') seguiu pra inserção');
      assert.strictEqual(r.ok, false); assert.strictEqual(r.desfecho, 'abortado'); assert.strictEqual(r.transitorio, transEsperado, arq + ' transitorio p/ ' + JSON.stringify(resp));
      assert.strictEqual(bf.rodando, false); assert.strictEqual(bf.fase, 'abortado'); assert.ok(/nada foi gravado/.test(bf.msg)); assert.strictEqual(limpou, 1);
      const un = 'DELETE vendas_historico?empresa=eq.good&data_venda=gte.2026-10-01&data_venda=lte.2026-10-13';
      assert.deepStrictEqual(chamadas, transEsperado ? [un, un, un] : [un]);   // ambiguo repete 3x; 401 nao repete
    }
    // Codex #684 P1: resposta perdida (status 0) e a repeticao passa -> segue pra insercao
    { const bf = { rodando: true, erros: 0, fase: 'gravando', msg: '' }; let n = 0;
      const r = await roda(async () => (++n < 2 ? { ok: false, status: 0, erro: 'timeout' } : { ok: true, status: 204 }), 'amb', '2026-10-01', '2026-10-13', bf, () => { throw new Error('nao era pra limpar'); });
      assert.strictEqual(r, 'SEGUIU_PRA_INSERCAO'); assert.strictEqual(n, 2); }
    // DELETE aceito: segue pra inserção sem mexer no estado
    const bf = { rodando: true, erros: 0, fase: 'gravando', msg: '' };
    const r = await roda(async () => ({ ok: true, status: 204, body: '' }), 'amb', '2026-10-01', '2026-10-13', bf, () => { throw new Error('não era pra limpar'); });
    assert.strictEqual(r, 'SEGUIU_PRA_INSERCAO'); assert.strictEqual(bf.rodando, true); assert.strictEqual(bf.erros, 0);
  }
  console.log('ok — DELETE recusado aborta sem inserir (Girassol/GOOD e AMB); aceito segue');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
