'use strict';
/* 24/10 — "quando ligasse a empresa, isso fosse buscado logo de cara" (o dono, depois de uma semana de GOOD). Prova, com
   a peça de produção (lib/checkout/saude-dados-empresa) e um Supabase de mentira no formato real:
   · BANCO: sem a troca segura → pendência com o script a rodar; com ela → ok; sem resposta → NÃO SEI (nunca "ok");
   · HISTÓRICO: ano vazio / parado há mais de 3 dias / sem o começo do ano → pendência com o que fazer; em dia → ok;
   · ROTINA DIÁRIA desligada → pendência com a variável; TIKTOK conectado sem coleta recente → pendência;
   · PREPARAR SOZINHA: histórico do ano vazio e sem plano → cria o plano de 1º de janeiro até hoje; com vendas, com plano
     ou sem resposta do banco → não cria (e diz por quê);
   · a rota /embarque/dados percorre as empresas da configuração única; a GOOD se prepara sozinha na subida. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const sd = require('../lib/checkout/saude-dados-empresa');

const AGORA = new Date('2026-10-24T15:00:00Z');   /* 24/10 em SP */
function supaFake(o) {
  return { req: async (e, metodo, caminho) => {
    if (o.cair) throw new Error('rede');
    if (/vendas_historico_rascunho/.test(caminho)) return o.semBanco ? { ok: false, status: 404, body: '' } : { ok: true, status: 200, body: '[]' };
    if (/rpc\/trocar_periodo_historico/.test(caminho)) return { ok: false, status: 400, body: '{"message":"recusada"}' };
    if (/order=data_venda\.desc/.test(caminho)) return { ok: true, status: 200, body: JSON.stringify(o.ultima ? [{ data_venda: o.ultima }] : []) };
    if (/order=data_venda\.asc/.test(caminho)) return { ok: true, status: 200, body: JSON.stringify(o.primeira ? [{ data_venda: o.primeira }] : []) };
    return { ok: false, status: 500, body: '' };
  } };
}
const item = (r, id) => r.itens.find((i) => i.id === id);

(async () => {
  // em dia
  let r = await sd.verificar('good', { supa: supaFake({ primeira: '2026-01-01', ultima: '2026-10-23' }), agora: AGORA });
  assert.ok(item(r, 'banco').ok === true && item(r, 'historico').ok === true && r.pendencias === 0, 'em dia virou pendência: ' + JSON.stringify(r));
  // sem a troca segura
  r = await sd.verificar('good', { supa: supaFake({ semBanco: true, primeira: '2026-01-01', ultima: '2026-10-23' }), agora: AGORA });
  assert.ok(item(r, 'banco').ok === false && /historico-troca-segura\.sql/.test(item(r, 'banco').o_que_fazer) && /SUPABASE_URL_VENDAS_GOOD/.test(item(r, 'banco').o_que_fazer), 'banco sem troca segura não virou pendência com o script');
  // ano vazio
  r = await sd.verificar('good', { supa: supaFake({ ultima: '2025-12-30' }), agora: AGORA });
  assert.ok(item(r, 'historico').ok === false && /nenhuma venda de 2026/.test(item(r, 'historico').detalhe), 'ano vazio: ' + JSON.stringify(item(r, 'historico')));
  // parado (a Girassol e a AMB de 19/10)
  r = await sd.verificar('girassol', { supa: supaFake({ primeira: '2026-01-01', ultima: '2026-10-18' }), agora: AGORA });
  assert.ok(item(r, 'historico').ok === false && /parou em 2026-10-18/.test(item(r, 'historico').o_que_fazer), 'histórico parado não virou pendência');
  // sem o começo do ano
  r = await sd.verificar('amb', { supa: supaFake({ primeira: '2026-05-21', ultima: '2026-10-23' }), agora: AGORA });
  assert.ok(item(r, 'historico').ok === false && /falta o começo do ano/.test(item(r, 'historico').o_que_fazer), 'ano sem começo não virou pendência');
  // banco não respondeu → NÃO SEI, nunca "ok"
  r = await sd.verificar('good', { supa: supaFake({ cair: true }), agora: AGORA });
  assert.ok(item(r, 'banco').ok === null && item(r, 'historico').ok === null && r.pendencias === 0, 'sem resposta virou "ok" ou "quebrado": ' + JSON.stringify(r));
  // rotina diária e TikTok
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-'));
  const arq = path.join(dir, '_tiktok_financeiro_good.json');
  r = await sd.verificar('good', { supa: supaFake({ primeira: '2026-01-01', ultima: '2026-10-23' }), agora: AGORA,
    diarioDesligado: () => true, comoLigarDiario: 'apagar GOOD_DIARIO_HISTORICO', tiktokConectado: () => true, arquivoTikTok: arq });
  assert.ok(item(r, 'rotina_diaria').ok === false && /GOOD_DIARIO_HISTORICO/.test(item(r, 'rotina_diaria').o_que_fazer), 'rotina diária desligada não virou pendência');
  assert.ok(item(r, 'tiktok').ok === false && /nunca foi coletado/.test(item(r, 'tiktok').detalhe), 'TikTok sem coleta não virou pendência');
  fs.writeFileSync(arq, '{}');
  r = await sd.verificar('good', { supa: supaFake({ primeira: '2026-01-01', ultima: '2026-10-23' }), agora: AGORA, tiktokConectado: () => true, arquivoTikTok: arq });
  assert.ok(item(r, 'tiktok').ok === true && !item(r, 'rotina_diaria'), 'TikTok coletado agora / sem chave de rotina');
  r = await sd.verificar('amb', { supa: supaFake({ primeira: '2026-01-01', ultima: '2026-10-23' }), agora: AGORA, tiktokConectado: () => false });
  assert.ok(!item(r, 'tiktok'), 'empresa sem TikTok conectado não pode ganhar pendência de TikTok');
  fs.rmSync(dir, { recursive: true, force: true });

  // preparar sozinha
  let criou = null;
  const base = (o, extra) => Object.assign({ supa: supaFake(o), agora: AGORA, planoExiste: () => false, criarPlanoAno: async (de, ate) => { criou = [de, ate]; return { ok: true }; } }, extra || {});
  let p = await sd.prepararSozinha('good', base({}));
  assert.ok(p.feito === true && criou && criou[0] === '2026-01-01' && criou[1] === '2026-10-24', 'ano vazio sem plano: não criou o plano de 1º de janeiro até hoje: ' + JSON.stringify(p) + ' ' + JSON.stringify(criou));
  criou = null; p = await sd.prepararSozinha('good', base({ primeira: '2026-01-02', ultima: '2026-10-23' }));
  assert.ok(p.feito === false && criou === null, 'criou plano com o ano já gravado');
  criou = null; p = await sd.prepararSozinha('good', base({}, { planoExiste: () => true }));
  assert.ok(p.feito === false && criou === null, 'criou plano por cima de um que já existe');
  criou = null; p = await sd.prepararSozinha('good', base({ cair: true }));
  assert.ok(p.feito === false && criou === null && /não sei/.test(p.motivo), 'sem resposta do banco criou plano às cegas');

  // a rota percorre a configuração única; a GOOD se prepara na subida
  const idx = fs.readFileSync(path.join(raiz, 'index.js'), 'utf8');
  assert.ok(/path === '\/embarque\/dados' && method === 'GET'/.test(idx) && /for \(const chave of Object\.keys\(cfgE\.HISTORICO\)\)/.test(idx), 'a rota /embarque/dados não percorre a configuração única');
  const gs = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
  assert.ok(/saude-dados-empresa'\)\.prepararSozinha\('good', \{/.test(gs), 'a GOOD não se prepara sozinha na subida');
  console.log('ok — saúde dos dados: banco, histórico do ano, rotina diária e TikTok com o que fazer; "não sei" nunca vira ok; a empresa sem histórico ganha o plano do ano sozinha');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
