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
/* Codex #353→#354: EMPRESAS (env) é ativação, não registro — mas DELETÁ-LA voltava ao
   default de três e esconderia uma 4ª empresa embarcada por env (não existe registro
   independente por trás: lista() lê a env). O certo é a UNIÃO: preserva o que está
   configurado e acrescenta o que o contrato exige, só durante o teste. */
const contrato = require('../contrato-empresas.json');
const EMPRESAS_ORIG = process.env.EMPRESAS;
{
  /* união com o DEFAULT da lib (os aliases que ESTE repo usa) — injetar aliases do
     contrato que o repo não conhece ('ambtotal') fazia o envBling derivar env
     inventada (AMBTOTAL_...) e o teste acusar divergência falsa; provado ao rodar. */
  const atuais = String(EMPRESAS_ORIG || '').split(',').map(x => x.toLowerCase().trim()).filter(Boolean);
  const padrao = ['girassol', 'good', 'amb'];
  process.env.EMPRESAS = [...new Set([...padrao, ...atuais])].join(',');
}
process.on('exit', () => { if (EMPRESAS_ORIG !== undefined) process.env.EMPRESAS = EMPRESAS_ORIG; else delete process.env.EMPRESAS; });

const emp = require('../lib/empresas');

const SERVICO = 'mover-pedidos';
/* Codex #353 → v4: os serviços válidos saem DO PRÓPRIO CONTRATO (campo servicos,
   que a v4 trouxe com os repos nomeados) — dono com typo não passa, e o conjunto
   nunca mais diverge do dado. Sanity: este serviço precisa constar. */
assert.ok(contrato.servicos && Array.isArray(contrato.servicos.lista), 'v4+: campo servicos.lista existe');
const SERVICOS_VALIDOS = new Set(contrato.servicos.lista);
assert.ok(SERVICOS_VALIDOS.has('mover-pedidos'), 'este serviço consta em servicos.lista');
assert.ok(contrato.servicos.repos && contrato.servicos.repos['mover-pedidos'], 'repo deste serviço nomeado no contrato');
const es = contrato.empresas;

/* Codex #353: chave de empresa DUPLICADA no JSON é engolida pelo parser (a última
   vence) e a unicidade por Object.keys viraria teatro — conferida no texto CRU. */
const cru = fs.readFileSync(path.join(__dirname, '..', 'contrato-empresas.json'), 'utf8');
for (const id of Object.keys(es)) {
  /* Codex #354: JSON aceita espaço antes do dois-pontos — split literal não via
     '"good" : {'; a contagem virou regex com \s* entre nome e colon. */
  const ocorrencias = (cru.match(new RegExp('"' + id + '"\\s*:', 'g')) || []).length;
  assert.strictEqual(ocorrencias, 1, 'chave "' + id + '" aparece ' + ocorrencias + 'x no JSON cru — o parser engoliria a primeira');
}

/* ── (a) coerência interna: nada colide entre empresas ── */
const ids = Object.keys(es);
assert.strictEqual(new Set(ids).size, ids.length, 'id_canonico não se repete');
const aliasDe = new Map(), sufixoDe = new Map(), slugDe = new Map(), envDe = new Map();
for (const [id, e] of Object.entries(es)) {
  assert.strictEqual(e.id_canonico, id, 'id_canonico bate com a chave do mapa');
  for (const a of e.aliases) {
    /* Codex #353: a lib normaliza com toLowerCase().trim() — colisão só de caixa
       ('AMB' × 'amb') passava aqui e colidia em runtime; normalizamos igual. */
    const an = String(a).toLowerCase().trim();
    assert.ok(!aliasDe.has(an), 'alias "' + a + '" (normalizado "' + an + '") pertence a duas empresas: ' + aliasDe.get(an) + ' e ' + id);
    aliasDe.set(an, id);
  }
  assert.ok(!sufixoDe.has(e.sufixo_tabelas), 'sufixo_tabelas "' + e.sufixo_tabelas + '" compartilhado por ' + sufixoDe.get(e.sufixo_tabelas) + ' e ' + id);
  sufixoDe.set(e.sufixo_tabelas, id);
  assert.ok(!slugDe.has(e.slug_http), 'slug_http "' + e.slug_http + '" compartilhado');
  slugDe.set(e.slug_http, id);
  assert.ok(!envDe.has(e.prefixo_env), 'prefixo_env "' + e.prefixo_env + '" compartilhado');
  envDe.set(e.prefixo_env, id);
  for (const [integ, alvo] of Object.entries(e.dono_alvo)) {
    if (integ.startsWith('_')) continue;
    assert.ok(alvo === null || SERVICOS_VALIDOS.has(alvo), 'dono_alvo.' + integ + ' de ' + id + ' = "' + alvo + '" não é serviço conhecido (' + [...SERVICOS_VALIDOS].join(', ') + ')');
  }
  for (const [integ, donos] of Object.entries(e.dono_hoje)) {
    if (integ.startsWith('_')) continue;
    assert.ok(Array.isArray(donos) && donos.length >= 1, 'dono_hoje.' + integ + ' de ' + id + ' declara ao menos um serviço');
    for (const d of donos) assert.ok(SERVICOS_VALIDOS.has(d), 'dono_hoje.' + integ + ' de ' + id + ' inclui "' + d + '" — serviço desconhecido');
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

/* ── (c) dono_hoje diz a verdade sobre ESTE serviço — inclusive nos eixos da v3 ── */
for (const [id, e] of Object.entries(es)) {
  for (const integ of ['bling', 'ml', 'magalu', 'bling_nfe']) {
    assert.ok(e.dono_hoje[integ] && e.dono_hoje[integ].includes(SERVICO),
      'dono_hoje.' + integ + ' de ' + id + ' omite "' + SERVICO + '" — mas este serviço renova essa conta (contrato mentindo é pior que contrato nenhum)');
  }
  /* v3: TikTok medido dos DOIS lados — só a GOOD não tem; nas outras, quem renova é este serviço */
  const tt = e.conta_marketplace.tiktok;
  if (id === 'good') assert.strictEqual(tt, 'nao_se_aplica', 'GOOD não tem TikTok');
  else {
    assert.strictEqual(tt, 'propria', id + ' TEM TikTok (a v2 dizia nao_se_aplica e estava errada)');
    assert.ok(e.dono_hoje.tiktok.includes(SERVICO), 'dono_hoje.tiktok de ' + id + ' declara este serviço');
  }
}
/* prova material DERIVADA DO CONTRATO (Codex #353: hardcode das 3 pastas deixaria a
   4ª empresa entrar sem renovador e o teste calado — embarcar CNPJ novo é o propósito
   disto tudo): pra cada empresa cujo dono_hoje declara este serviço, os módulos têm
   que existir na pasta do id_canonico. */
const MODULO_DE = { bling: 'tokenManager.js', ml: 'mlTokenManager.js', bling_nfe: 'nfTokenManager.js' };
for (const [id, e] of Object.entries(es)) {
  for (const [integ, arq] of Object.entries(MODULO_DE)) {
    if ((e.dono_hoje[integ] || []).includes(SERVICO)) {
      assert.ok(fs.existsSync(path.join(__dirname, '..', id, arq)), id + '/' + arq + ' não existe — mas o contrato diz que este serviço renova ' + integ + ' da ' + id);
    }
  }
}
assert.ok(fs.existsSync(path.join(__dirname, '..', 'tiktok-oauth')), 'tiktok-oauth/ existe — a renovação do TikTok mora aqui');

/* v3: a ELEIÇÃO está registrada como acordo, não como feito — o teste confere a forma,
   nunca "obedece": ninguém desliga renovação até o desenho do passo 2 estar pronto. */
const ele = contrato.passo_2_eleicao;
assert.ok(ele && ele.dono_eleito, 'eleição registrada');
for (const [integ, dono] of Object.entries(ele.dono_eleito)) {
  assert.ok(SERVICOS_VALIDOS.has(dono), 'dono eleito de ' + integ + ' = "' + dono + '" não é serviço conhecido');
}
assert.strictEqual(ele.dono_eleito.ml, 'mover-pedidos', 'no ML o dono único é obrigação (refresh de uso único)');

/* Pendência remanescente (não falha): slug_http reflete o lado do Devoluções; aqui a
   inversão é a girassol sem prefixo de rota — se o campo virar por-serviço, conferimos. */
console.log('OK: contrato v' + contrato.versao + ' coerente e espelhado — registro local bate, dono_hoje diz a verdade sobre este serviço');
