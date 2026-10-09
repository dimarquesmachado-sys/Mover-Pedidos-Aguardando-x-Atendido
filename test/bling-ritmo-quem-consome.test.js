'use strict';
// 09/10 (dono: 'descobre' quem consome a cota da Girassol): o porteiro conta por SERVICO e marca 429 com o porteiro folgado.
const fs = require('fs'); const os = require('os'); const path = require('path');
let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };
process.env.BLING_RITMO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-'));   // isolado: o modulo persiste estado em disco
const R = require('../bling-ritmo.js')._interno;
let agora = Date.parse('2026-10-09T15:00:00Z'); R._agoraRef.fn = () => agora;
const a = R.permissao('girassol', 'fundo', 'devolucoes');
R.permissao('girassol', 'operacao', 'expedicao');
R.permissao('girassol', 'operacao', 'expedicao');
agora += 5000;
R.aviso429('girassol', '', 'fundo', 'devolucoes');   // 429 com o porteiro folgado (0 fichas no segundo)
const e = R.estado('girassol');
ok(a && a.ok, '  permissao continua funcionando com o servico');
ok(e.por_servico.devolucoes && e.por_servico.devolucoes.permitidas === 1 && e.por_servico.devolucoes.avisos_429 === 1 && e.por_servico.expedicao.permitidas === 2, '⚠️ conta por servico: devolucoes 1 (+1 aviso 429), expedicao 2');
ok(e.avisos_429_com_porteiro_folgado === 1 && e.ultimos_429[0].porteiro_folgado === true && e.ultimos_429[0].servico === 'devolucoes', '⚠️ 429 com o porteiro folgado e marcado (sinal de consumo FORA do porteiro)');
R.permissao('girassol', 'fundo');
ok(R.estado('girassol').por_servico['sem-nome'], '  cliente antigo (sem ?servico) entra como sem-nome');
console.log('');
console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
process.exit(falhas ? 1 : 0);
