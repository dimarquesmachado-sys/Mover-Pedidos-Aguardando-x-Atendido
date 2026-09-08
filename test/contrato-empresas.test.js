'use strict';
/* Teste ESPELHO do contrato de empresas — etapa zero do plano multiempresa entre repos
   (Devoluções ↔ Mover-Pedidos). O MESMO contrato-empresas.json vive byte a byte nos dois
   repositórios e cada lado tem um teste como este: divergência entre repos vira teste
   vermelho aqui, em vez de dado na tabela errada em silêncio lá na produção.
   Confere: (a) o contrato é coerente consigo mesmo; (b) o registro LOCAL
   (lib/empresas.js) bate com o que o contrato declara sobre ESTE serviço;
   (c) dono_hoje diz a verdade sobre quem renova token aqui — amarrado a arquivos
   reais, não a fé. Rodar: node test/contrato-empresas.test.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contrato = require('../contrato-empresas.json');
const emp = require('../lib/empresas');

const SERVICO = 'mover-pedidos';
const es = contrato.empresas;

/* ── (a) coerência interna: nada colide entre empresas ── */
const ids = Object.keys(es);
assert.strictEqual(new Set(ids).size, ids.length, 'id_canonico não se repete');
const aliasDe = new Map(), sufixoDe = new Map(), slugDe = new Map(), envDe = new Map();
for (const [id, e] of Object.entries(es)) {
  assert.strictEqual(e.id_canonico, id, 'id_canonico bate com a chave do mapa');
  for (const a of e.aliases) {
    assert.ok(!aliasDe.has(a), 'alias "' + a + '" pertence a duas empresas: ' + aliasDe.get(a) + ' e ' + id);
    aliasDe.set(a, id);
  }
  assert.ok(!sufixoDe.has(e.sufixo_tabelas), 'sufixo_tabelas "' + e.sufixo_tabelas + '" compartilhado por ' + sufixoDe.get(e.sufixo_tabelas) + ' e ' + id);
  sufixoDe.set(e.sufixo_tabelas, id);
  assert.ok(!slugDe.has(e.slug_http), 'slug_http "' + e.slug_http + '" compartilhado');
  slugDe.set(e.slug_http, id);
  assert.ok(!envDe.has(e.prefixo_env), 'prefixo_env "' + e.prefixo_env + '" compartilhado');
  envDe.set(e.prefixo_env, id);
  for (const [integ, alvo] of Object.entries(e.dono_alvo)) {
    if (integ.startsWith('_')) continue;
    assert.ok(alvo === null || typeof alvo === 'string', 'dono_alvo.' + integ + ' de ' + id + ': decidido é UM serviço (string) ou null — nunca lista');
  }
  for (const [integ, donos] of Object.entries(e.dono_hoje)) {
    if (integ.startsWith('_')) continue;
    assert.ok(Array.isArray(donos) && donos.length >= 1, 'dono_hoje.' + integ + ' de ' + id + ' declara ao menos um serviço');
  }
}

/* ── (b) o registro local bate com o contrato ── */
for (const [id, e] of Object.entries(es)) {
  const local = e.aliases.find(a => emp.valida(a));
  assert.ok(local, 'empresa "' + id + '" do contrato não existe na lista local por nenhum alias — os repos divergiram');
  const prefixo = e.prefixo_env_historico[SERVICO];
  assert.strictEqual(typeof prefixo, 'string', id + ': prefixo_env_historico precisa declarar o serviço "' + SERVICO + '"');
  assert.strictEqual(emp.envBling(local), prefixo + 'BLING_CLIENT_ID',
    'envBling("' + local + '") diverge do prefixo histórico que o contrato declara pra este serviço');
}
assert.ok(es.ambtotal && es.ambtotal.aliases.includes('amb') && !es.amb,
  '"amb" é ALIAS de "ambtotal", nunca identidade própria — a inversão disso quebra o Devoluções');
assert.ok(emp.valida('amb'), 'o registro local conhece o alias "amb"');

/* ── (c) dono_hoje diz a verdade sobre ESTE serviço ── */
for (const [id, e] of Object.entries(es)) {
  for (const integ of ['bling', 'ml', 'magalu']) {
    assert.ok(e.dono_hoje[integ].includes(SERVICO),
      'dono_hoje.' + integ + ' de ' + id + ' omite "' + SERVICO + '" — mas este serviço renova essa conta (contrato mentindo é pior que contrato nenhum)');
  }
}
/* prova material: os renovadores existem por empresa neste repo */
for (const pasta of ['girassol', 'good', 'ambtotal']) {
  assert.ok(fs.existsSync(path.join(__dirname, '..', pasta, 'tokenManager.js')), pasta + '/tokenManager.js (Bling) existe');
  assert.ok(fs.existsSync(path.join(__dirname, '..', pasta, 'mlTokenManager.js')), pasta + '/mlTokenManager.js (ML) existe');
}

/* Pendências declaradas pra v3 do contrato (NÃO falham — contrato é versionado):
   1. eixo "bling_nfe": o nfTokenManager deste repo renova o app de NF-e das 3 empresas
      — a v2 não modela essa integração (o próprio autor pediu o acréscimo);
   2. conta_marketplace.tiktok = "nao_se_aplica" está ERRADO pra girassol e ambtotal:
      as duas têm TikTok Shop com tokens renovados POR ESTE serviço (tiktok-oauth);
   3. slug_http reflete o lado do Devoluções; aqui a inversão é a girassol sem prefixo
      de rota — se um dia o campo virar por-serviço, este teste passa a conferi-lo. */
console.log('OK: contrato v' + contrato.versao + ' coerente e espelhado — registro local bate, dono_hoje diz a verdade sobre este serviço');
