'use strict';
/* 01/11 — DESLIGAR UMA EMPRESA DESLIGA TUDO DELA (auditoria do Codex no SHA 208fdb7d, achado F03). EMPRESAS/SKIP_EMPRESAS
   filtravam as lojas fiscais, mas as aplicações DA empresa (o checkout, os módulos da Madeira, o drive de imagens…)
   continuavam montadas, com bootstrap e crons; a agenda das NFs da Magalu tinha lista própria (padrão good,amb) que
   ignorava o desligamento; e a Girassol agendava o plano do backfill no CARREGAMENTO do arquivo. Prova DE VERDADE: o
   registro (config/empresas) carregado em processo separado com cada combinação de env, a agenda da Magalu e o
   carregamento da Girassol com a empresa desligada. */
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const raiz = path.join(__dirname, '..');
const os = require('os');
const tmp = require('fs').mkdtempSync(path.join(os.tmpdir(), 'desl-'));
const base = Object.assign({}, process.env, { GIRABKP_CACHE_DIR: path.join(tmp, 'g'), AMBBKP_CACHE_DIR: path.join(tmp, 'a'), GOODBKP_CACHE_DIR: path.join(tmp, 'o') });
delete base.EMPRESAS; delete base.SKIP_EMPRESAS;
function rodar(env, codigo) {
  const r = spawnSync(process.execPath, ['-e', codigo], { cwd: raiz, env: Object.assign({}, base, env), encoding: 'utf8', timeout: 120000 });
  const linha = String(r.stdout || '').split('\n').filter((l) => l.startsWith('@@')).pop();
  assert.ok(linha, 'o processo de prova não respondeu (' + JSON.stringify(env) + '): ' + String(r.stderr || '').slice(-300));
  return JSON.parse(linha.slice(2));
}
const APPS = "const c=require('./config/empresas'); console.log('@@'+JSON.stringify({ lojas: c.lojas.map(l=>l.id), apps: c.aplicacoes.map(a=>a.id), donos: c.DONO_DA_APLICACAO })); process.exit(0);";
const DE = { girassol: ['girassol-backup-offline', 'girassol-mm-etiquetas', 'estoque-girassol', 'auto-mensagens', 'lixas-combinar' /* 15/11 (Codex P1 nº 8): operam a Girassol — caem com ela */], good: ['good-checkout-offline', 'good-mm-diag', 'good-mm-etiquetas', 'good-drive-imagens'], ambtotal: ['amb-checkout-offline', 'amb-drive-imagens'] };
const casos = [
  [{}, ['girassol', 'good', 'ambtotal']],
  [{ EMPRESAS: 'good' }, ['good']],
  [{ SKIP_EMPRESAS: 'good' }, ['girassol', 'ambtotal']],
  [{ SKIP_EMPRESAS: 'amb' }, ['girassol', 'good']],          /* alias */
  [{ EMPRESAS: 'girassol,amb' }, ['girassol', 'ambtotal']],
];
for (const [env, ligadas] of casos) {
  const r = rodar(env, APPS);
  for (const [emp, apps] of Object.entries(DE)) for (const a of apps) {
    const deveSubir = ligadas.includes(emp);
    assert.strictEqual(r.apps.includes(a), deveSubir, JSON.stringify(env) + ': a aplicação ' + a + ' (de ' + emp + ') ' + (deveSubir ? 'tinha que SUBIR' : 'NÃO podia subir — a empresa está desligada'));
  }
  assert.ok(r.apps.includes('fragil') && r.apps.includes('ponto'), JSON.stringify(env) + ': ferramenta de várias empresas não pode cair junto');
  for (const a of Object.keys(r.donos || {})) assert.ok(Object.values(DE).some((l) => l.includes(a)), 'aplicação com dono que o teste não conhece: ' + a);
}
/* Codex #789: no MODO ANTIGO (contrato ilegível → registro nulo) o apelido histórico da AMB continua valendo — o
   checkout e o drive da AMB sobem com a loja fiscal dela (que no modo antigo se chama 'amb') */
/* (o modo antigo é simulado só no registro (config/empresas) — a 1ª leitura do contrato falha; os módulos das empresas,
   que releem o registro, carregam normalmente, como no cenário do Codex) */
const APPS_SEM_CONTRATO = "const reg=require('./lib/empresas/registro'); const orig=reg.carregar; let n=0; reg.carregar=function(){ if (n++===0) throw new Error('contrato ilegivel (simulado)'); return orig.apply(this, arguments); }; " + APPS;
{ const semContrato = rodar({}, APPS_SEM_CONTRATO);
  assert.ok(semContrato.lojas.includes('amb'), 'o modo antigo não subiu a loja fiscal da AMB (a prova não está no modo antigo?)');
  for (const a of ['amb-checkout-offline', 'amb-drive-imagens', 'good-checkout-offline', 'girassol-backup-offline']) assert.ok(semContrato.apps.includes(a), 'no modo antigo (sem contrato) a aplicação ' + a + ' caiu com a empresa LIGADA'); }
/* a agenda das NFs da Magalu: só empresa ativa (alias e id canônico) */
const MAG = "const m=require('./magalu-oauth'); console.log('@@'+JSON.stringify({ padrao: m.nfEmpresasDaRodada(), pedido: m.nfEmpresasDaRodada(['good','amb']) })); process.exit(0);";
let r = rodar({}, MAG);
assert.deepStrictEqual(r.padrao, ['good', 'amb'], 'com as três ligadas, a agenda da Magalu segue com a lista dela');
r = rodar({ SKIP_EMPRESAS: 'good' }, MAG);
assert.deepStrictEqual(r.padrao, ['amb'], 'com a GOOD desligada, a agenda da Magalu ainda a selecionou: ' + JSON.stringify(r.padrao));
r = rodar({ EMPRESAS: 'girassol' }, MAG);
assert.deepStrictEqual(r.padrao, [], 'com GOOD e AMB fora de EMPRESAS, a agenda da Magalu ainda selecionou alguém: ' + JSON.stringify(r.padrao));
r = rodar({ SKIP_EMPRESAS: 'ambtotal' }, MAG);
assert.deepStrictEqual(r.pedido, ['good'], 'o id canônico (ambtotal) tinha que desligar a "amb" da agenda');
/* 15/11 (auditoria do Codex, P2 nº 7): as LOJAS DO TIKTOK — a env TIKTOK_LOJAS explícita era lida crua pelo tiktok-oauth, pelo
   tiktok-ads e pelo embarque: `SKIP_EMPRESAS=girassol` com `TIKTOK_LOJAS=girassol,good,amb` seguia renovando o token e
   coletando pela Girassol. Agora a env é filtro sobre as ATIVAS, numa função só (lib/empresas.lojasTikTok). */
const TK = "const e=require('./lib/empresas'); const o=require('./tiktok-oauth'); const a=require('./tiktok-ads'); console.log('@@'+JSON.stringify({ fn: e.lojasTikTok(), oauth: o.LOJAS, ads: a.LOJAS, padrao: o.LOJA_PADRAO })); process.exit(0);";
r = rodar({ TIKTOK_LOJAS: 'girassol,good,amb' }, TK);
assert.deepStrictEqual([r.fn, r.oauth, r.ads], [['girassol', 'good', 'amb'], ['girassol', 'good', 'amb'], ['girassol', 'good', 'amb']], 'com as três ligadas a lista explícita vale inteira');
r = rodar({ TIKTOK_LOJAS: 'girassol,good,amb', SKIP_EMPRESAS: 'girassol' }, TK);
assert.deepStrictEqual([r.fn, r.oauth, r.ads, r.padrao], [['good', 'amb'], ['good', 'amb'], ['good', 'amb'], 'good'], 'a Girassol SUSPENSA continuou na lista do TikTok: ' + JSON.stringify(r));
r = rodar({ TIKTOK_LOJAS: 'girassol,good,amb', SKIP_EMPRESAS: 'ambtotal' }, TK);
assert.deepStrictEqual(r.oauth, ['girassol', 'good'], 'o id canônico (ambtotal) tinha que tirar a "amb" da lista do TikTok: ' + JSON.stringify(r.oauth));
r = rodar({ TIKTOK_LOJAS: 'good,amb,good,xpto', EMPRESAS: 'girassol,good' }, TK);
assert.deepStrictEqual(r.oauth, ['good'], 'fora de EMPRESAS (amb), repetida (good) e desconhecida (xpto) não entram: ' + JSON.stringify(r.oauth));
r = rodar({ SKIP_EMPRESAS: 'good' }, TK);
assert.deepStrictEqual(r.oauth, ['girassol', 'amb'], 'sem a env: as ativas');
r = rodar({ TIKTOK_LOJAS: 'ambtotal,good' }, TK);
assert.deepStrictEqual(r.oauth, ['ambtotal', 'good'], 'a env pode usar o id canônico (ambtotal) da loja que EMPRESAS chama de amb: ' + JSON.stringify(r.oauth));
/* o embarque diz "falta TikTok" pra empresa que está na env mas DESLIGADA — ela não está nas lojas do TikTok de verdade */
r = rodar({ TIKTOK_LOJAS: 'girassol,good,amb', EMPRESAS: 'good' }, "const e=require('./lib/embarcar-empresa'); const c=e.conferir('good'); const g=(Array.isArray(c)?c:(c.itens||[])).find(x=>x.nome==='TikTok'); console.log('@@'+JSON.stringify({ ok: g ? g.ok : null })); process.exit(0);");
assert.strictEqual(r.ok, true, 'a GOOD ligada e na env aparece com TikTok ok no embarque: ' + JSON.stringify(r));
/* a Girassol SUSPENSA: auto-mensagens não sobe (nem rota, nem cron) */
r = rodar({ SKIP_EMPRESAS: 'girassol' }, APPS);
assert.ok(!r.apps.includes('auto-mensagens') && !r.apps.includes('lixas-combinar'), 'com a Girassol suspensa, auto-mensagens/lixas-combinar subiram: ' + JSON.stringify(r.apps));
assert.ok(r.apps.includes('ponto') && r.apps.includes('good-checkout-offline'), 'as outras ficam');
/* a Girassol desligada não agenda o plano do backfill no carregamento do arquivo */
const GIR = "const t=global.setTimeout; let n=0; global.setTimeout=(f,ms,...a)=>{ if (ms===180000) n++; return t(()=>{},0); }; require('./girassol-backup-offline/gbo-app'); console.log('@@'+JSON.stringify({ n })); process.exit(0);";
assert.strictEqual(rodar({ EMPRESAS: 'good' }, GIR).n, 0, 'com a Girassol desligada, o carregamento ainda agendou o plano do backfill dela');
assert.strictEqual(rodar({}, GIR).n, 1, 'com a Girassol ligada, o plano do backfill tinha que continuar agendado');
console.log('ok — desligar uma empresa desliga as aplicações dela (EMPRESAS e SKIP, alias e canônico) — inclusive auto-mensagens e lixas-combinar da Girassol —, a agenda da Magalu, as lojas do TikTok (TIKTOK_LOJAS é filtro sobre as ativas) e o plano da Girassol; as outras e as ferramentas comuns seguem');
