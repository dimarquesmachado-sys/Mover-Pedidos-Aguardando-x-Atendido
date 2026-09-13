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
  const _fetchFake = async (u) => { urlVista = String(u); throw new Error('rede fechada no teste'); };
  const _vsy = {};
  const fase = criarFaseDireta({
    empresa: 'girassol', mlTokenManager: () => ({ garantirTokenML: async () => null }),
    shopeeKey: 'K', shopeeUrlEnv: 'https://servico', adminKey: 'A', porta: 3000, fetch: _fetchFake, log: () => {},
  });
  await fase({ _vsy, atual: {}, isoD: (d) => d.toISOString().slice(0, 10), json: () => {},
               writeJson: () => {}, F: '/tmp/x.json', hoje: new Date(), fim: new Date(), magEmpresa: 'girassol' });

  assert.ok(String(urlVista || '').includes('/girassol/'), 'a fase tem que consultar a loja da PRÓPRIA empresa: ' + urlVista);
  // falha de canal vira diagnóstico, não silêncio
  assert.ok(_vsy.shopee_direto && _vsy.shopee_direto.erro, 'falha da Shopee tem que deixar rastro no status: ' + JSON.stringify(_vsy));

  // Codex P1: quando a loja da Shopee é configurada separado da empresa (caso da AMB, que
  // roda como 'amb' mas a loja no serviço pode ter outro slug), a URL usa a LOJA — não o nome
  // interno da empresa.
  let urlVista2 = null;
  const fase2 = criarFaseDireta({
    empresa: 'amb', mlTokenManager: () => ({ garantirTokenML: async () => null }),
    shopeeKey: 'K', shopeeUrlEnv: 'https://servico', shopeeLoja: 'loja-diferente',
    adminKey: 'A', porta: 3000, fetch: async (u) => { urlVista2 = String(u); throw new Error('rede fechada no teste'); }, log: () => {},
  });
  await fase2({ _vsy: {}, atual: {}, isoD: (d) => d.toISOString().slice(0, 10), json: () => {},
                writeJson: () => {}, F: '/tmp/x.json', hoje: new Date(), fim: new Date(), magEmpresa: 'amb' });
  assert.ok(String(urlVista2 || '').includes('/loja-diferente/'), 'shopeeLoja tem que valer sobre o nome da empresa: ' + urlVista2);

  console.log('OK: fase direta — exige deps, consulta a loja da própria empresa (ou a LOJA configurada) e registra a falha em vez de silenciar');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
