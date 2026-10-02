'use strict';
// O motor do ML Full ignora as notas que o PROPRIO BLING emitiu (serie 1, subidas
// ao ML pelo vendedor) — elas ja estao no Bling por definicao, e conferi-las
// gastava a cota a toa (Girassol, 25/09-01/10: 201 "Autorizadas", quase todas
// serie 1; teto de 60 → 179 nao conferidas, a varredura nunca fechava).
const fs = require('fs');
const path = require('path');
let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };

const src = fs.readFileSync(path.join(__dirname, '..', 'ml-full.js'), 'utf8');
// exercito as funcoes de producao: extraio-as do modulo pelo texto (o modulo
// inteiro exige tokens/rede no require), mesma assinatura e corpo
const pegar = (nome) => {
  const i = src.indexOf('function ' + nome + '(');
  const j = src.indexOf('\n}\n', i);
  return new Function('return ' + src.slice(i, j + 2))();
};
const emitidaPeloML = pegar('emitidaPeloML');
const serieDaChave = pegar('serieDaChave');

// o XML real da devolucao Full da Girassol (49304, serie 2) que o dono trouxe em 01/10
const xmlML = '<nfeProc><NFe><infNFe Id="NFe35260827548456000147550020000493041158076413"><ide><serie>2</serie><nNF>49304</nNF><tpNF>0</tpNF><verProc>mercadolivre.invoice</verProc></ide></infNFe></NFe></nfeProc>';
const xmlBling = '<nfeProc><NFe><infNFe Id="NFe35260927548456000147550010001280031684283580"><ide><serie>1</serie><nNF>128003</nNF><tpNF>1</tpNF><verProc>Bling v3.1</verProc></ide></infNFe></NFe></nfeProc>';
const xmlSemVerProc = '<nfeProc><NFe><infNFe><ide><serie>1</serie><tpNF>1</tpNF></ide></infNFe></NFe></nfeProc>';

ok(emitidaPeloML(xmlML) === true, '⚠️ verProc mercadolivre.invoice -> emitida pelo ML (confere no Bling)');
ok(emitidaPeloML(xmlBling) === false, '⚠️ verProc do Bling -> NAO e do ML (ignorada: ja esta no Bling por definicao)');
ok(emitidaPeloML(xmlSemVerProc) === null, '  XML sem verProc -> null ("nao sei" != "nao e do ML"; segue o caminho antigo e confere)');
ok(emitidaPeloML('<verProc>MercadoLibre Invoice 2.0</verProc>') === true, '  maiusculas / mercadolibre tambem casam');
ok(serieDaChave('35260827548456000147550020000493041158076413') === '2', '  serie da chave: 49304 e serie 2 (posicoes 22-25)');
ok(serieDaChave('35260927548456000147550010001280031684283580') === '1', '  serie da chave: 128003 e serie 1');
ok(serieDaChave('123') === null, '  chave que nao tem 44 digitos -> null');

// o motor usa: pula ANTES de virar candidata (antes de qualquer consulta ao Bling), conta e expoe no JSON
const sem = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const iPulo = sem.indexOf('if (emitidaPeloML(xml) === false) { ignoradasDoBling++; continue; }');
const iCand = sem.indexOf('candidatas.push({ c, xml, tipo });');
ok(iPulo > 0 && iPulo < iCand, '⚠️ o pulo vem ANTES de virar candidata — zero consultas ao Bling pra nota do Bling');
ok(/ignoradas_emitidas_pelo_bling: ignoradasDoBling/.test(sem), '  contador no JSON (ignoradas_emitidas_pelo_bling)');
ok(/censo_series: censoSeries/.test(sem), '  censo por serie no JSON (quantas sao do Full na janela)');
ok(/=== false\) \{ ignoradasDoBling\+\+/.test(sem) && !/!emitidaPeloML\(xml\)/.test(sem), '  compara com === false, nunca com ! (null nao pode virar "ignorada")');
ok(/ml-full b4/.test(src), '  versao b4');

console.log('');
console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
process.exit(falhas ? 1 : 0);
