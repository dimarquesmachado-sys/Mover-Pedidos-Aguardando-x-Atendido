'use strict';
/* 13/09 — a FASE DIRETA passou a valer nas duas empresas. O que este teste guarda não é o
   detalhe de cada marketplace (isso é rede), e sim o que o dono cravou como princípio: a
   fase existe, roda com a EMPRESA certa e, quando um canal falha, ela NÃO fica calada —
   porque foi exatamente isso que aconteceu na Shopee em 11/08, com o status em null e a
   investigação cega. Também exige as dependências: fase pela metade é pior que fase nenhuma. */
const assert = require('assert');
const { criarFaseDireta } = require('../lib/checkout/fase-direta');

(async () => {
  assert.throws(() => criarFaseDireta({}), /falta empresa/);
  assert.throws(() => criarFaseDireta({ empresa: 'amb' }), /falta /);

  // a empresa chega na chamada do serviço da Shopee (não pode consultar a loja errada)
  let urlVista = null;
  global.fetch = async (u) => { urlVista = String(u); throw new Error('rede fechada no teste'); };
  const _vsy = {};
  const fase = criarFaseDireta({
    empresa: 'girassol', mlTokenManager: () => ({ garantirTokenML: async () => null }),
    shopeeKey: 'K', shopeeUrlEnv: 'https://servico', adminKey: 'A', porta: 3000, log: () => {},
  });
  await fase({ _vsy, atual: {}, isoD: (d) => d.toISOString().slice(0, 10), json: () => {},
               writeJson: () => {}, F: '/tmp/x.json', hoje: new Date(), fim: new Date(), magEmpresa: 'girassol' });

  assert.ok(String(urlVista || '').includes('/girassol/'), 'a fase tem que consultar a loja da PRÓPRIA empresa: ' + urlVista);
  // falha de canal vira diagnóstico, não silêncio
  assert.ok(_vsy.shopee_direto && _vsy.shopee_direto.erro, 'falha da Shopee tem que deixar rastro no status: ' + JSON.stringify(_vsy));
  console.log('OK: fase direta — exige deps, consulta a loja da própria empresa e registra a falha em vez de silenciar');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
