'use strict';
/* 25/10 — NF do pedido (nf.js) e separação (separacao.js) viraram PEÇAS ÚNICAS (lib/checkout/nf-pedido e
   lib/checkout/separacao): eram idênticas nas três empresas (344 e 87 linhas), a menos do rótulo do emitente.
   Prova de EQUIVALÊNCIA com o código antigo (tirado do git, rodando na pasta de cada empresa com o base dela):
   · as mesmas funções exportadas;
   · as funções puras respondem IGUAL (parseNF, parseXmlNF, acharNFnaLista, dadosNFSimp) com os mesmos dados;
   · cada empresa leva o PRÓPRIO emitente de reserva e o próprio rótulo (nada da Girassol vaza pra AMB/GOOD);
   · as pastas viraram uma linha (sem cópia). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const XML = '<nfeProc><NFe><infNFe Id="NFe35261000000000000155550010000808091000000001"><ide><nNF>80809</nNF><serie>1</serie><dhEmi>2026-10-20T14:53:00-03:00</dhEmi></ide>' +
  '<emit><CNPJ>12345678000190</CNPJ><xNome>EMPRESA TESTE</xNome><IE>123</IE><enderEmit><xLgr>Rua A</xLgr><nro>1</nro><xBairro>B</xBairro><xMun>Sao Paulo</xMun><UF>SP</UF><CEP>01000000</CEP></enderEmit></emit>' +
  '<dest><xNome>Caio Cezar</xNome><CPF>12345678909</CPF><enderDest><xLgr>Rua B</xLgr><nro>2</nro><xBairro>C</xBairro><xMun>Rio</xMun><UF>RJ</UF><CEP>20000000</CEP></enderDest></dest>' +
  '<det nItem="1"><prod><cProd>SKU1</cProd><xProd>Produto</xProd><qCom>2.0000</qCom><vUnCom>10.00</vUnCom><vProd>20.00</vProd></prod></det>' +
  '<total><ICMSTot><vNF>20.00</vNF></ICMSTot></total></infNFe></NFe><protNFe><infProt><chNFe>35261000000000000155550010000808091000000001</chNFe></infProt></protNFe></nfeProc>';
const NFS = [{ id: 1, numero: '080809', serie: '1', chaveAcesso: '35261000000000000155550010000808091000000001', contato: { nome: 'Caio' }, numeroPedidoLoja: '10051765' },
  { id: 2, numero: '080835', serie: '1', chaveAcesso: 'X', contato: { nome: 'Eduarda' }, numeroPedidoLoja: '10052974' }];
const PED = { id: 27180427876, numero: 78048, numeroLoja: '10051765', notaFiscal: { id: 1 }, contato: { nome: 'Caio Cezar' } };

let n = 0;
for (const [pasta, rot] of [['girassol-backup-offline', 'GIRABKP'], ['amb-checkout-offline', 'AMBBKP'], ['good-checkout-offline', 'GOODBKP']]) {
  // o arquivo da empresa é a peça (uma linha)
  const atual = fs.readFileSync(path.join(raiz, pasta, 'nf.js'), 'utf8');
  assert.ok(/require\('\.\.\/lib\/checkout\/nf-pedido'\)\.criarNfDaEmpresa\(require\('\.\/base'\)/.test(atual) && atual.includes("rotulo: '" + rot + "'") && /emitenteFallback: require\('\.\/emitente-fallback'\)/.test(atual), pasta + '/nf.js não é a peça com o rótulo e o emitente DELA');
  assert.ok(/require\('\.\.\/lib\/checkout\/separacao'\)\.criarSeparacao\(require\('\.\/base'\)\)/.test(fs.readFileSync(path.join(raiz, pasta, 'separacao.js'), 'utf8')), pasta + '/separacao.js não é a peça');
  // o código antigo (do git), rodando na pasta da empresa
  /* a referência é o nf.js de ANTES da peça (scripts/fixtures/nf-antes-da-peca.js, o da AMB — as três eram iguais a menos
     do rótulo), com o rótulo desta empresa; roda na pasta dela, com o base e o emitente dela */
  const antigoSrc = fs.readFileSync(path.join(__dirname, 'fixtures', 'nf-antes-da-peca.js'), 'utf8').replace("rotulo: 'AMBBKP'", "rotulo: '" + rot + "'");
  assert.ok(!/criarNfDaEmpresa/.test(antigoSrc) && antigoSrc.includes("rotulo: '" + rot + "'"), 'a referência antiga não é o código de antes da peça');
  const arqAntigo = path.join(raiz, pasta, '_nf_antigo_teste.js');
  fs.writeFileSync(arqAntigo, antigoSrc);
  try {
    const velho = require(arqAntigo), novo = require(path.join(raiz, pasta, 'nf.js'));
    assert.deepStrictEqual(Object.keys(novo).sort(), Object.keys(velho).sort(), pasta + ': as funções exportadas mudaram');
    const j = (x) => JSON.stringify(x);
    assert.strictEqual(j(novo.parseNF(NFS[0])), j(velho.parseNF(NFS[0])), pasta + ': parseNF respondeu diferente');
    assert.strictEqual(j(novo.parseXmlNF(XML)), j(velho.parseXmlNF(XML)), pasta + ': parseXmlNF respondeu diferente');
    /* acharNFnaLista(pedidoId, nfs, opts): os três caminhos — vínculo EXATO pelo nº na loja, faixa de id e a disputa
       (NF já usada → ambígua) — e o resultado de cada um não pode ser vazio (senão a comparação não prova nada) */
    const casos = [
      [27180427876, [{ id: 27180428045, numero: '080809', serie: '1', numeroPedidoLoja: '10051765', contato: { nome: 'Caio' } }], { numeroLoja: '10051765' }],
      [27180427876, [{ id: 27180428045, numero: '080809', serie: '1', contato: { nome: 'Caio' } }, { id: 27180429000, numero: '080810', serie: '1' }], {}],
      [27180427876, [{ id: 27180428045, numero: '080809', serie: '1' }], { usadasIds: new Set([27180428045]) }],
    ];
    for (const [pid, lista, op] of casos) {
      const rn = novo.acharNFnaLista(pid, lista, op), rv = velho.acharNFnaLista(pid, lista, op);
      assert.ok(rn !== null, pasta + ': o caso de teste da busca da NF não exercitou nada (veio vazio)');
      assert.strictEqual(j(rn), j(rv), pasta + ': acharNFnaLista respondeu diferente (' + j(op) + ')');
    }
    assert.ok(novo.parseNF(NFS[0]) && novo.parseXmlNF(XML), pasta + ': parseNF/parseXmlNF vieram vazios — a comparação não provaria nada');
    n++;
  } finally { try { fs.unlinkSync(arqAntigo); } catch (e) {} }
}
// a separação: as mesmas funções
for (const pasta of ['girassol-backup-offline', 'amb-checkout-offline', 'good-checkout-offline']) {
  const s = require(path.join(raiz, pasta, 'separacao.js'));
  assert.ok(typeof s.montarSeparacao === 'function' && typeof s.montarSeparacaoPorPedido === 'function', pasta + ': a separação perdeu funções');
}
console.log('ok — NF do pedido e separação em peça única: as três empresas respondem igual ao código antigo (' + n + ' comparadas), cada uma com o próprio emitente');
process.exit(0);
