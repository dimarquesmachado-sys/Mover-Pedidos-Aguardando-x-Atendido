/* 02/10 — BUSCAR PELO NÚMERO DA NF no histórico do checkout, nas TRÊS empresas.

   Pedido do dono, com o diagnóstico já pronto: "pelo nome acha, pelo número do pedido acha hj
   também. pela nota não."

   O dado JÁ vinha no item (`h.nf_numero` — é o que o resumo mostra como "NF 004622"); só não
   entrava no filtro. Então não foi preciso campo novo, rota nova nem chamada ao Bling.

   ⚠️ O ZERO À ESQUERDA É O PONTO QUE FARIA PARECER QUEBRADO: a tela mostra `004622` e o dono
   digita `4622`, que é como a NF sai no Bling e no e-mail. Sem comparar também sem os zeros, a
   busca pelo número que ele tem na mão não acharia nada. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TELAS = [
  ['AMB',      'amb-checkout-offline/painel.html'],
  ['Girassol', 'girassol-backup-offline/painel.html'],
  ['GOOD',     'good-checkout-offline/painel.html'],
];

for (const [empresa, arq] of TELAS) {
  const s = fs.readFileSync(path.join(__dirname, '..', arq), 'utf8');

  /* ⚠️ O PRODUTOR PRIMEIRO: se o item não trouxesse `nf_numero`, o filtro compararia contra
     undefined e a busca falharia em silêncio — o erro que a regra da casa nomeia. */
  assert.ok(/h\.nf_numero/.test(s),
    empresa + ': o item do histórico não tem `nf_numero` — o filtro compararia contra nada');

  assert.ok(/nf\.replace\(\/\^0\+\/, ''\)/.test(s),
    empresa + ': a busca por NF parou de ignorar os zeros à esquerda — a tela mostra 004622, o ' +
    'dono digita 4622 (como sai no Bling) e não acharia nada');

  assert.ok(/nº do pedido, NF ou cliente/.test(s),
    empresa + ': o campo não avisa que dá pra buscar por NF — recurso que ninguém descobre é ' +
    'recurso que não existe');
}

/* e o comportamento, com a mesma lógica que está nas três telas */
const filtro = (h, q) => {
  const nf = String(h.nf_numero || '');
  const alvo = (String(h.numero || h.id) + ' ' + (h.cliente || '') + ' ' + nf + ' ' + nf.replace(/^0+/, '')).toLowerCase();
  return alvo.includes(q);
};
const ped = { numero: 5323, cliente: 'PEDRO RICARDO VIRTUOZO', nf_numero: '004622' };
assert.ok(filtro(ped, '5323'),   'perdeu a busca pelo número do pedido, que já funcionava');
assert.ok(filtro(ped, 'pedro'),  'perdeu a busca pelo cliente, que já funcionava');
assert.ok(filtro(ped, '004622'), 'não acha pela NF como ela aparece na tela');
assert.ok(filtro(ped, '4622'),   'não acha pela NF SEM os zeros — é assim que o dono a tem em mãos');
assert.ok(!filtro(ped, '9999'),  'acha qualquer coisa — o filtro deixou de filtrar');
assert.ok(filtro({ numero: 77, cliente: 'ANA' }, '77'),
  'pedido SEM NF parou de ser achado pelo número — a busca antiga quebrou pra quem não tem nota');

console.log('OK: historico busca por NF (com e sem zeros a esquerda) nas tres empresas');
