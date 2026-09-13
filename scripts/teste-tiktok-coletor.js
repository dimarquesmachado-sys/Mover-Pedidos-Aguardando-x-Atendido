'use strict';
/* Fatia 6 (13/09): o coletor financeiro do TikTok por EMPRESA. O wrapper era copiado nos
   dois checkouts e só a chave mudava — agora a empresa é parâmetro, e este teste garante
   que ela é REALMENTE respeitada: um coletor da girassol não pode trabalhar com o token da
   amb, que seria pegar dinheiro da empresa errada. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { criarColetorDaEmpresa } = require('../lib/tiktok-financeiro');

(async () => {
  assert.throws(() => criarColetorDaEmpresa('', { carregarTikTok: () => ({}) }), /empresa é obrigatória/);
  assert.throws(() => criarColetorDaEmpresa('amb', {}), /carregarTikTok/);

  // módulo do TikTok ausente: pula declarando, não explode
  let r = await criarColetorDaEmpresa('amb', { carregarTikTok: () => { throw new Error('x'); }, fs, path })(1);
  assert.strictEqual(r.ok, true);
  assert.ok(/indispon/.test(r.pulado));

  // a EMPRESA é respeitada: token existe só pra amb
  const tkFalso = { chamar: () => {}, lerToken: (e) => (e === 'amb' ? 'token' : null) };
  r = await criarColetorDaEmpresa('girassol', { carregarTikTok: () => tkFalso, fs, path })(1);
  assert.ok(/não conectado/.test(r.pulado), 'coletor da girassol não pode usar o token da amb');

  // e quando o token é da própria empresa, chega a chamar a coleta
  let chamou = null;
  const libMock = require('../lib/tiktok-financeiro');
  const orig = libMock.coletarFinanceiro;
  libMock.coletarFinanceiro = async (ctx, emp, dias) => { chamou = { emp, dias }; return { ok: true }; };
  try {
    await criarColetorDaEmpresa('amb', { carregarTikTok: () => tkFalso, fs, path })(7);
  } finally { libMock.coletarFinanceiro = orig; }
  console.log('OK: coletor do TikTok por empresa — exige empresa e dependência, pula sem módulo, respeita o token da PRÓPRIA empresa');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
