'use strict';
/* 15/09 — /api/contexto, base da Fase 4 (painel único por capacidades).
   O problema que ela existe pra resolver: os três painel.html têm ~2.000 linhas cada e,
   medindo com os nomes normalizados, diferem em 73 a 109 linhas — quase tudo MARCA (logo em
   base64, <title>, <h1>, versão da UI). São o mesmo painel, copiado três vezes por causa de
   um logo. Com esta rota, o HTML pergunta quem ele é em vez de saber.
   O teste guarda duas coisas:
     • a rota devolve a identidade e as capacidades DAQUELA empresa;
     • e NÃO devolve credencial, caminho de disco ou env — isto chega no navegador do galpão,
       e qualquer coisa aqui vira dado público na prática. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { criar } = require('../lib/checkout/contexto-api');
const { carregar } = require('../lib/empresas/registro');

const registro = carregar({ servico: 'mover-pedidos' });
assert.throws(() => criar({}), /falta empresa/);

function chama(empresa, modulo, rota) {
  let corpo = null, code = null;
  const handle = criar({ empresa, modulo, registro, json: (res, c, b) => { code = c; corpo = b; } });
  const res = {};
  const urlObj = { pathname: rota };
  return handle({ headers: {} }, res, urlObj).then(tratou => ({ tratou, code, corpo }));
}

(async () => {
  /* só responde na própria rota */
  const fora = await chama('amb', 'amb-checkout-offline', '/amb-checkout-offline/outra-coisa');
  assert.strictEqual(fora.tratou, false, 'não pode capturar rota que não é dela');

  for (const [emp, mod, nome] of [
    ['amb', 'amb-checkout-offline', 'AMBTotal'],
    ['girassol', 'girassol-backup-offline', 'Magazine Girassol'],
    ['good', 'good-checkout-offline', 'GOOD Import (GIMPO)'],
  ]) {
    const r = await chama(emp, mod, '/' + mod + '/api/contexto');
    assert.strictEqual(r.tratou, true, mod + ': não tratou a própria rota');
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.corpo.nome, nome, mod + ': nome errado');
    assert.ok(r.corpo.capacidades && r.corpo.capacidades.fiscal === true, mod + ': capacidades ausentes');

    /* nada de segredo: o corpo inteiro não pode conter env, caminho ou chave */
    const txt = JSON.stringify(r.corpo);
    for (const proibido of ['/data/', 'SUPABASE', 'CLIENT_SECRET', 'ADMIN_KEY', 'process.env', 'token']) {
      assert.ok(!txt.includes(proibido), mod + ': a resposta contém "' + proibido + '" — isto chega no navegador');
    }
  }

  /* as capacidades têm que refletir o contrato, não uma lista fixa no código da rota */
  const amb = (await chama('amb', 'amb-checkout-offline', '/amb-checkout-offline/api/contexto')).corpo;
  const good = (await chama('good', 'good-checkout-offline', '/good-checkout-offline/api/contexto')).corpo;
  assert.strictEqual(amb.capacidades.tiktok, true, 'a AMB coleta TikTok');
  assert.strictEqual(good.capacidades.tiktok, false, 'a GOOD não coleta TikTok — a rota não pode dizer que sim');
  assert.strictEqual(good.capacidades['madeira-madeira'], true);
  assert.strictEqual(amb.capacidades['madeira-madeira'], false);

  /* e a lib não pode ter nome de empresa cravado */
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'contexto-api.js'), 'utf8');
  const presos = fonte.split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .filter(l => /\b(AMBTotal|Magazine Girassol|GOOD Import|girassol|ambtotal)\b/.test(l));
  assert.deepStrictEqual(presos, [], 'a lib tem nome de empresa cravado: ' + presos.join(' | '));

  console.log('OK: /api/contexto — identidade e capacidades por empresa, vindas do contrato, e nenhum segredo na resposta');
})().catch(e => { console.error(e.message); process.exit(1); });
