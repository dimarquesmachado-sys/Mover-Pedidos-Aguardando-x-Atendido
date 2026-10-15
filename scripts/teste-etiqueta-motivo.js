'use strict';
/* 15/10 — o card de "sem etiqueta" mostra POR QUÊ. Prova: (1) a tradução do motivo do ML, de produção
   (recortada de cada ciclo.js), nos casos que importam; (2) nas três empresas, cada falha de fallback
   (ML e Shopee) grava o motivo, o motivo vai pro pedido (manifesto) e pra lista do painel, e o card usa. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
for (const [emp, ciclo, painel] of [['amb', 'amb-checkout-offline/ciclo.js', 'amb-checkout-offline/painel.html'],
                                    ['good', 'good-checkout-offline/ciclo.js', 'good-checkout-offline/painel.html'],
                                    ['girassol', 'girassol-backup-offline/ciclo.js', 'girassol-backup-offline/painel.html']]) {
  const src = fs.readFileSync(path.join(raiz, ciclo), 'utf8');
  const i = src.indexOf('function _motivoEtqML('); assert.ok(i > 0, emp + ': sem a tradução do motivo');
  const fn = new Function(src.slice(i, src.indexOf('\n}\n', i) + 2) + '\nreturn _motivoEtqML;')();
  assert.ok(/espera a nota fiscal/.test(fn(400, 'ready_to_ship/invoice_pending', '')), emp + ': invoice_pending');
  assert.ok(/cancelado/.test(fn(400, 'cancelled/x', '')), emp + ': cancelado');
  assert.ok(/já despachado/.test(fn(400, 'shipped/in_transit', '')), emp + ': despachado');
  assert.ok(/recusou o token/.test(fn(401, '', '')), emp + ': token');
  assert.ok(/HTTP 500/.test(fn(500, '', 'x')), emp + ': genérico');
  // cada saída de falha grava o motivo
  for (const re of [/resposta sem ZPL[^\n]*_motivoEtq = /, /shipment_labels HTTP[^\n]*\n\s*_motivoEtq = _motivoEtqML\(/, /fallback ML \$\{ped\.numero\}: \$\{String\(e\.message[^\n]*_motivoEtq = 'ML: '/,
                    /resposta sem etiqueta reconhecível[^\n]*_motivoEtq = /, /fallback Shopee \$\{ped\.numero\}: HTTP[^\n]*\n\s*_motivoEtq = /, /fallback Shopee \$\{ped\.numero\}: \$\{String\(e\.message[^\n]*_motivoEtq = 'Shopee: '/])
    assert.ok(re.test(src), emp + ': saída de falha sem motivo: ' + re);
  assert.ok(/etq_motivo: \(temEtiqueta \|\| etiquetaMM\) \? null : \(_motivoEtq \|\| null\)/.test(src), emp + ': motivo não vai pro pedido');
  assert.ok(/tem_etiqueta: snap\.tem_etiqueta, etq_motivo: snap\.etq_motivo \|\| null,/.test(src), emp + ': motivo não vai pra lista do painel');
  assert.ok(/p\.etq_motivo\?esc\(p\.etq_motivo\)/.test(fs.readFileSync(path.join(raiz, painel), 'utf8')), emp + ': o card não mostra o motivo');
}
console.log('ok — card sem etiqueta mostra o motivo da última tentativa (ML e Shopee), nas três empresas');
