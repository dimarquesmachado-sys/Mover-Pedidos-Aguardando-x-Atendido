'use strict';
/* 14/09 — capacidades declaradas no contrato (auditoria do Codex, P2). Antes,
   `temCapacidade()` devolvia null porque nenhuma empresa declarava o campo, e aí cada tela
   decidia sozinha o que a loja tem — o painel por capacidades (Fase 4) não teria base.
   As capacidades foram DERIVADAS do código, não supostas (a 1ª versão deste commit eu
   chutei e corrigi conferindo): ml-full atende as três (ml-full.js resolve o token de
   girassol, amb e good), tiktok é de quem usa criarColetorDaEmpresa, madeira-madeira é de
   quem tem pasta *-mm-etiquetas.
   O teste guarda duas coisas: que as capacidades batam com a realidade do repositório, e
   que capacidade FORA do vocabulário derrube o boot — erro de digitação ("shoppe") viraria
   recurso desligado em silêncio. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { carregar } = require('../lib/empresas/registro');

const r = carregar({ servico: 'mover-pedidos' });

/* derivação conferida contra o repositório, não contra memória */
const existe = (p) => fs.existsSync(path.join(__dirname, '..', p));
for (const [alias, pastaCheckout, pastaMM] of [
  ['amb', 'amb-checkout-offline', 'amb-mm-etiquetas'],
  ['girassol', 'girassol-backup-offline', 'girassol-mm-etiquetas'],
  ['good', 'good-checkout-offline', 'good-mm-etiquetas'],
]) {
  assert.strictEqual(r.temCapacidade(alias, 'checkout'), existe(pastaCheckout),
    alias + ': a capacidade "checkout" tem que refletir a existência da pasta');
  assert.strictEqual(r.temCapacidade(alias, 'madeira-madeira'), existe(pastaMM),
    alias + ': a capacidade "madeira-madeira" tem que refletir a existência da pasta');
  assert.strictEqual(r.temCapacidade(alias, 'fiscal'), true, alias + ': toda loja tem módulo fiscal hoje');
  assert.strictEqual(r.temCapacidade(alias, 'ml-full'), true,
    alias + ': ml-full.js resolve o token das TRÊS — se isso mudar, o contrato muda junto');
}

/* o tiktok é de quem realmente usa o coletor */
const usaTikTok = (p) => /criarColetorDaEmpresa/.test(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
assert.strictEqual(r.temCapacidade('amb', 'tiktok'), usaTikTok('amb-checkout-offline/index.js'));
assert.strictEqual(r.temCapacidade('girassol', 'tiktok'), usaTikTok('girassol-backup-offline/gbo-app.js'));
assert.strictEqual(r.temCapacidade('good', 'tiktok'), false, 'a GOOD não coleta TikTok hoje');

/* capacidade inventada derruba o boot */
const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cap-')), 'c.json');
fs.writeFileSync(arq, JSON.stringify({ empresas: { x: { id_canonico: 'x', capacidades: ['shoppe'] } } }));
assert.throws(() => carregar({ caminho: arq }), /capacidade desconhecida/,
  'digitação errada no contrato tem que FALHAR no boot, não desligar recurso em silêncio');

console.log('OK: capacidades — batem com o que existe no repositório, e capacidade fora do vocabulário derruba o boot');
