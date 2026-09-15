'use strict';
/* 15/09 — a página de embarque. O objetivo declarado pelo dono é "clicar em menos coisas":
   antes disso, ligar uma empresa era abrir TRÊS URLs por empresa, de memória, sem jeito de
   saber o que já estava autorizado a não ser tentando.
   O teste guarda três coisas, e as duas últimas são as que mais importam:
     · token ausente NÃO pode aparecer como autorizado (o pior erro possível nesta tela);
     · a presença é vista pelo ARQUIVO, nunca usando o token — uma tela de diagnóstico não
       pode disparar renovação de refresh de uso único só porque alguém a abriu;
     · nenhum valor de token aparece na página. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { criar } = require('../lib/fiscal/painel-embarque');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-'));
const comToken = path.join(dir, 'tem.json');
const vazio = path.join(dir, 'vazio.json');
const semRefresh = path.join(dir, 'sem.json');
fs.writeFileSync(comToken, JSON.stringify({ refresh_token: 'SEGREDO-REFRESH', access_token: 'SEGREDO-ACCESS' }));
fs.writeFileSync(vazio, '');
fs.writeFileSync(semRefresh, JSON.stringify({}));

const painel = criar({
  base: 'https://exemplo.invalido', html: true,
  empresas: [{ id: 'x', nome: 'Empresa X', slug: '/x',
    arquivoBling: comToken, arquivoBlingNF: vazio, arquivoML: path.join(dir, 'nao-existe.json') }],
});
const est = painel.estado()[0];

assert.strictEqual(est.contas[0].ok, true, 'arquivo com refresh = autorizado');
assert.strictEqual(est.contas[1].ok, false, 'arquivo VAZIO não é autorização — dizer que sim é o pior erro da tela');
assert.strictEqual(est.contas[2].ok, false, 'arquivo inexistente também não');

const semRef = criar({ base: 'https://x', html: true, empresas: [{ id: 'y', nome: 'Y', slug: '/y', arquivoBling: semRefresh, arquivoBlingNF: semRefresh, arquivoML: semRefresh }] });
assert.strictEqual(semRef.estado()[0].contas[0].ok, false, 'JSON sem token nenhum não conta como autorizado');

/* a conta pendente tem que trazer o link — a tela existe pra isso */
assert.ok(/\/x\/callback-ml$/.test(est.contas[2].autorizar), 'faltou o link de autorizar do ML');

const pag = painel.pagina();
for (const proibido of ['SEGREDO-REFRESH', 'SEGREDO-ACCESS', 'refresh_token', 'access_token']) {
  assert.ok(!pag.includes(proibido), 'a página vazou "' + proibido + '" — ela é servida ao navegador');
}
assert.ok(/autorizar agora/.test(pag), 'a página tem que oferecer o clique, não só listar');

/* e não pode chamar os gerenciadores de token: abrir a tela não pode renovar nada */
const fonte = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fiscal', 'painel-embarque.js'), 'utf8');
assert.ok(!/garantirToken|renovarToken|fetch\(/.test(fonte),
  'a tela lê ARQUIVO; usar o token poderia disparar renovação de refresh de uso único só por alguém ter aberto a página');

console.log('OK: página de embarque — token ausente nunca aparece autorizado, nada é renovado ao abrir e nenhum valor vaza');
