'use strict';
// A Toolbox, quando o Bling responde 401 "nao autenticado" em TODAS as
// tentativas, diz na PRIMEIRA linha que o usuario nao esta logado — em vez
// da mensagem tecnica com 4 tentativas, 19 cabecalhos e 4 causas possiveis.
// Dono, 01/10: "apareceu essa mensagem toda, mas eu so nao tava logado".

const fs = require('fs');
const path = require('path');
let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };

const src = fs.readFileSync(path.join(__dirname, '..', 'toolbox-extensao', 'bg-devolucoes.js'), 'utf8');
const semCom = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

ok(/const todas401 = falhas\.length > 0 && falhas\.every\(\(f\) => \/=HTTP 401\$\/\.test\(f\)\);/.test(semCom),
   '⚠️ detecta "todas as tentativas deram 401"');
ok(/UNAUTHENTICATED\|n\[a.\]o autenticad/.test(semCom), '  e o corpo com UNAUTHENTICATED / "nao autenticado"');
ok(/VOCE NAO ESTA LOGADO NO BLING NESTE NAVEGADOR/.test(semCom), '  a primeira linha diz a causa');
ok(/codigo: 'NAO_LOGADO'/.test(semCom), '  e usa o CODIGO estavel NAO_LOGADO (viaja ate o painel; um campo novo morreria no 1o embrulho)');
ok(!/nao_logado: true/.test(semCom), '  (sem o campo nao_logado da 1a versao)');
ok(/NAO_LOGADO \(2\.1\.4/.test(src), '  e o contrato de codigos documenta NAO_LOGADO');
// Codex P2: le o corpo de TODAS as recusas, nao so da 1a
ok(/if \(\/UNAUTHENTICATED\|n\[a.\]o autenticad\/i\.test\(corpo\)\) viuNaoAutenticado = true;/.test(semCom),
   '⚠️ o flag acumula de QUALQUER recusa (a 1a pode ser generica e so a 3a dizer UNAUTHENTICATED)');
ok(/if \(todas401 && viuNaoAutenticado\)/.test(semCom), '  e a decisao usa o flag acumulado, nao so o diag da 1a');
// a regra em si, com as entradas reais do dono (01/10)
const todas401 = (falhas) => falhas.length > 0 && falhas.every((f) => /=HTTP 401$/.test(f));
const disse = (diag) => /UNAUTHENTICATED|n[aã]o autenticad/i.test(diag || '');
ok(todas401(['revisao=HTTP 401', 'espelho=HTTP 401', 'ajax=HTTP 401', 'simples=HTTP 401'])
   && disse(' | 1a recusa: [application/json] {"error":{"type":"UNAUTHENTICATED","message":"Usu\\u00e1rio n\\u00e3o autenticado"'),
   '⚠️ o caso real do dono (4x 401 + UNAUTHENTICATED) -> nao logado');
// 1a recusa generica (HTML), 3a com UNAUTHENTICATED: o acumulado pega
{
  let viu = false;
  for (const corpo of ['<html>Bling</html>', '', '{"error":{"type":"UNAUTHENTICATED"}}', '']) if (/UNAUTHENTICATED|n[aã]o autenticad/i.test(corpo)) viu = true;
  ok(viu, '  1a recusa generica + 3a com UNAUTHENTICATED -> acumulado = nao logado');
}
ok(!todas401(['revisao=HTTP 401', 'espelho=HTTP 403']), '  401 + 403 misturados NAO e "nao logado" (segue a mensagem tecnica)');
ok(!todas401([]), '  sem tentativas NAO e "nao logado"');
ok(!disse(' | 1a recusa: [text/html] <html>Cloudflare'), '  401 sem UNAUTHENTICATED no corpo NAO e "nao logado"');
// a mensagem tecnica continua existindo pra quando nao for isso
ok(/Bling recusou o obter-dados em/.test(semCom) && /Possiveis|Nem copiando os cabecalhos/.test(semCom), '  a mensagem tecnica de antes continua pro resto');
ok(/"version": "2\.1\.4"/.test(fs.readFileSync(path.join(__dirname, '..', 'toolbox-extensao', 'manifest.json'), 'utf8')), '  manifest 2.1.4');

console.log('');
console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
process.exit(falhas ? 1 : 0);
