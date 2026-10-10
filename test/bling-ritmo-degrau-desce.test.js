'use strict';
// 10/10 — Girassol com degrau 4 (pausa de fundo de 5 min a cada 429) PRA SEMPRE: o degrau so zerava com aviso-ok COM ficha.
// Agora desce 1 a cada 10 min sem 429, sem mexer no ts429 que o aviso-ok usa.
const fs = require('fs'); const os = require('os'); const path = require('path');
let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };
process.env.BLING_RITMO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-'));
const R = require('../bling-ritmo.js')._interno;
let agora = Date.parse('2026-10-10T12:00:00Z'); R._agoraRef.fn = () => agora;
for (let i = 0; i < 6; i++) { R.aviso429('girassol', '', 'fundo'); agora += 1000; }
ok(R.estado('girassol').degrau === 4, '  6 avisos de 429 seguidos: degrau no maximo (4)');
const ts429 = R._contas.get('girassol').ts429;
agora += 25 * 60 * 1000;
ok(R.estado('girassol').degrau === 2, '⚠️ 25 min sem 429: desceu 2 degraus (de 4 pra 2) — antes ficava no 4 pra sempre');
ok(R._contas.get('girassol').ts429 === ts429, '  o ts429 (que o aviso-ok usa) nao mexe');
agora += 60 * 60 * 1000;
ok(R.estado('girassol').degrau === 0, '  mais 1 h sem 429: degrau 0');
R.aviso429('girassol', '', 'fundo');
const pausa = R.estado('girassol').pausa_fundo_s;
ok(pausa > 0 && pausa <= 15, '⚠️ o 429 seguinte volta a pausa CURTA do primeiro degrau (' + pausa + ' s), nao a de 5 min');
// Codex #666: reinicio no meio — o relogio da descida volta do disco e nao desconta de novo o tempo ja contado
for (let i = 0; i < 6; i++) { R.aviso429('girassol', '', 'fundo'); agora += 1000; }
agora += 15 * 60 * 1000;
ok(R.estado('girassol').degrau === 3, '  15 min sem 429: degrau 3');
R._contas.clear(); R._carregar();
ok(R.estado('girassol').degrau === 3, '⚠️ depois do reinicio continua no 3 (nao desconta de novo os 10 min ja contados) (Codex #666)');
console.log('');
console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
process.exit(falhas ? 1 : 0);
