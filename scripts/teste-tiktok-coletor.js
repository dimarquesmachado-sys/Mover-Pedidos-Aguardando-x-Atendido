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

  // com token da própria empresa, a coleta recebe a EMPRESA certa (prova de verdade agora:
  // a versão anterior trocava o export e não interceptava nada — o Codex pegou)
  let visto = null;
  const r2 = await criarColetorDaEmpresa('amb', {
    carregarTikTok: () => tkFalso, fs, path,
    coletar: async (ctx, emp, dias) => { visto = { emp, dias }; return { ok: true, marcador: 1 }; },
  })(7);
  assert.deepStrictEqual(visto, { emp: 'amb', dias: 7 }, 'a empresa e o período têm que chegar na coleta');
  assert.strictEqual(r2.marcador, 1, 'o resultado da coleta é repassado a quem chamou');

  console.log('OK: coletor do TikTok por empresa — exige empresa e dependência, pula sem módulo, respeita o token da PRÓPRIA empresa e repassa empresa/período pra coleta');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
