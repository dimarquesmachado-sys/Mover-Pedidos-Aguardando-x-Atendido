'use strict';
/* 09/11 — CÓDIGO DA COLETA DO ML → E-MAIL DO ESTOQUE. Prova as duas pontas:
   1) lib/checkout/ml-codigo-coleta.receber (a função DE PRODUÇÃO): cada saída com o motivo — código inválido, sem
      e-mail do estoque, sem conta que envia, enviado (pra quem, com o código e a empresa no assunto), o MESMO código
      no mesmo dia não manda de novo, falha do e-mail NÃO marca (a próxima tentativa manda), teto de 3 códigos
      diferentes por dia, o dia de Brasília (vira à meia-noite de lá, não do fuso do navegador) e o e-mail próprio
      (<TAG>_EMAIL_CODIGO_COLETA) passando na frente do e-mail do estoque do checkout;
   2) toolbox-extensao/bg-coleta.js (o fundo da extensão, num chrome de mentira): às 7h de Brasília abre a página de
      vendas numa aba de FUNDO; o código lido vai pra rota da empresa DESTA instalação com a chave; o sucesso marca o
      dia e fecha a aba; o mesmo código de novo não chama o servidor; fora do horário, sem chave ou já entregue hoje
      não abre aba; falha do servidor fica na telinha com o motivo e não marca o dia;
   e as amarras: o leitor está nas páginas de vendas, o fundo nos dois navegadores, o cartão no menu das três. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const raiz = path.join(__dirname, '..');
const cc = require('../lib/checkout/ml-codigo-coleta');

(async () => {
  /* ── 1) a função de produção ── */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coleta-'));
  const arq = path.join(dir, 'st.json');
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
  const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o));
  const enviados = []; let falhar = false;
  const enviarEmail = async (m) => { if (falhar) throw new Error('SMTP fora'); enviados.push(m); };
  const email = { SMTP_HOST: 'h', SMTP_PORT: 465, EMAIL_USER: 'u@x', EMAIL_PASS: 'p', EMAIL_DEST: 'estoque@x.com.br' };
  let agora = Date.parse('2026-11-10T10:30:00Z');   // 07h30 em Brasília
  const d = (o) => Object.assign({ arquivo: arq, readJson, writeJson, enviarEmail, email, tag: 'GIRABKP', nomeEmpresa: 'Magazine Girassol', agora: () => agora }, o || {});

  let r = await cc.receber({ codigo: 'ab-12' }, d());
  assert.strictEqual(r.via, 'codigo_invalido'); assert.strictEqual(enviados.length, 0);
  r = await cc.receber({ codigo: 'AB12CD34' }, d({ email: Object.assign({}, email, { EMAIL_DEST: '' }) }));
  assert.ok(r.via === 'sem_destino' && /GIRABKP_EMAIL_CODIGO_COLETA/.test(r.erro) && /GIRABKP_EMAIL_DEST/.test(r.erro), 'sem destino tinha que dizer as duas envs: ' + JSON.stringify(r));
  r = await cc.receber({ codigo: 'AB12CD34' }, d({ email: Object.assign({}, email, { EMAIL_PASS: '' }) }));
  assert.ok(r.via === 'email_nao_configurado' && /GIRABKP_EMAIL_USER/.test(r.erro), JSON.stringify(r));
  falhar = true;
  r = await cc.receber({ codigo: 'ab12cd34' }, d());
  assert.ok(r.via === 'falha_envio' && !r.ok, 'falha do SMTP tinha que voltar falha_envio: ' + JSON.stringify(r));
  assert.deepStrictEqual(readJson(arq, {}), {}, 'falha do e-mail NÃO pode marcar como enviado');
  falhar = false;
  r = await cc.receber({ codigo: 'ab12cd34', origem: 'pagina_vendas' }, d());
  assert.ok(r.ok && r.via === 'enviado' && r.para === 'estoque@x.com.br' && r.dia === '2026-11-10', JSON.stringify(r));
  assert.ok(enviados.length === 1 && enviados[0].to === 'estoque@x.com.br' && /AB12CD34/.test(enviados[0].text) && /Magazine Girassol/.test(enviados[0].subject) && /10\/11/.test(enviados[0].subject), 'o e-mail tinha que ir pro estoque com o código e a empresa: ' + JSON.stringify(enviados[0]));
  r = await cc.receber({ codigo: 'AB12CD34' }, d());
  assert.ok(r.ok && r.via === 'ja_enviado' && enviados.length === 1, 'o MESMO código no mesmo dia não pode mandar de novo');
  r = await cc.receber({ codigo: 'ZZ99YY88' }, d()); assert.strictEqual(r.via, 'enviado');
  r = await cc.receber({ codigo: 'QQ77WW66' }, d()); assert.strictEqual(r.via, 'enviado');
  r = await cc.receber({ codigo: 'PP55OO44' }, d());
  assert.ok(r.via === 'limite_dia' && enviados.length === 3, 'o 4º código diferente do dia tinha que ser recusado: ' + JSON.stringify(r));
  /* o dia é o de Brasília: 02h50 UTC do dia 11 ainda é dia 10 lá (23h50) — continua no teto */
  agora = Date.parse('2026-11-11T02:50:00Z');
  r = await cc.receber({ codigo: 'PP55OO44' }, d()); assert.strictEqual(r.via, 'limite_dia', 'às 23h50 de Brasília ainda é o dia 10');
  agora = Date.parse('2026-11-11T03:10:00Z');   /* 00h10 do dia 11 em Brasília: dia novo */
  r = await cc.receber({ codigo: 'PP55OO44' }, d()); assert.ok(r.via === 'enviado' && r.dia === '2026-11-11', 'virou o dia em Brasília: ' + JSON.stringify(r));
  /* Codex #824: duas chegadas AO MESMO TEMPO com o mesmo código (página aberta na mão + aba das 7h) → UM e-mail; e 5
     códigos diferentes ao mesmo tempo não furam o teto de 3 */
  { const arq2 = path.join(os.tmpdir(), 'coleta-conc-' + process.pid + '.json'); try { fs.unlinkSync(arq2); } catch (e) {}
    const env2 = []; const lento = async (m) => { await new Promise((ok) => setTimeout(ok, 30)); env2.push(m); };
    const dd = d({ arquivo: arq2, enviarEmail: lento });
    const rr = await Promise.all([cc.receber({ codigo: 'AB12CD34' }, dd), cc.receber({ codigo: 'AB12CD34' }, dd)]);
    assert.ok(env2.length === 1 && rr.map((x) => x.via).sort().join() === 'enviado,ja_enviado', 'duas chegadas juntas do mesmo código mandaram ' + env2.length + ' e-mails: ' + JSON.stringify(rr));
    const r5 = await Promise.all(['C1C1C1C1', 'C2C2C2C2', 'C3C3C3C3', 'C4C4C4C4'].map((k) => cc.receber({ codigo: k }, dd)));
    assert.ok(env2.length === 3 && r5.filter((x) => x.via === 'limite_dia').length === 2, 'códigos simultâneos furaram o teto: ' + env2.length + ' e-mails');
    fs.unlinkSync(arq2); }
  /* e-mail próprio na frente do estoque do checkout */
  process.env.GIRABKP_EMAIL_CODIGO_COLETA = 'outro@x.com.br';
  assert.strictEqual(cc.destinoDe(email, 'GIRABKP'), 'outro@x.com.br');
  delete process.env.GIRABKP_EMAIL_CODIGO_COLETA;
  assert.strictEqual(cc.destinoDe(email, 'GIRABKP'), 'estoque@x.com.br');
  fs.rmSync(dir, { recursive: true, force: true });

  /* ── 2) o fundo da extensão, num chrome de mentira ── */
  const BG = fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'bg-coleta.js'), 'utf8');
  function montar(storageIni, horaUTC, alarmesExistentes) {
    const st = Object.assign({}, storageIni); const abertas = []; const fechadas = []; const chamadas = []; let ouvinte = null, alarme = null; let proxId = 100;
    const criados = []; const existentes = new Set(alarmesExistentes || []);
    let resposta = { ok: true, via: 'enviado', para: 'estoque@x.com.br' };
    const DataFixa = class extends Date { constructor(...a) { super(...(a.length ? a : [horaUTC])); } static now() { return Date.parse(horaUTC); } };
    const chrome = {
      storage: { local: { get: async (ks) => { const o = {}; for (const k of ks) if (k in st) o[k] = st[k]; return o; }, set: async (o) => Object.assign(st, o), remove: async (k) => { delete st[k]; } } },
      tabs: { create: async (o) => { const t = { id: ++proxId, url: o.url, active: o.active }; abertas.push(t); return t; }, remove: async (id) => { fechadas.push(id); } },
      alarms: { create: (n) => { criados.push(n); existentes.add(n); }, get: (n, cb) => cb(existentes.has(n) ? { name: n } : undefined), onAlarm: { addListener: (f) => { alarme = f; } } },
      runtime: { onMessage: { addListener: (f) => { ouvinte = f; } } },
    };
    const fetch = async (url, o) => { chamadas.push({ url, o }); return { status: 200, text: async () => JSON.stringify(resposta) }; };
    const ctx = vm.createContext({ chrome, fetch, Date: DataFixa, Intl, AbortController, setTimeout, clearTimeout, console, JSON, String, Number, Object });
    vm.runInContext(BG, ctx);
    const msg = (m, tabId) => new Promise((ok) => ouvinte(m, { tab: tabId ? { id: tabId } : null }, ok));
    return { st, abertas, fechadas, chamadas, criados, msg, alarme: (n) => alarme({ name: n }), setResposta: (x) => { resposta = x; } };
  }
  const espera = () => new Promise((s) => setTimeout(s, 30));
  /* 7h30 de Brasília, com empresa e chave: abre a aba de FUNDO, recebe o código, manda pra rota da empresa, marca e fecha */
  let x = montar({ tb_empresa: 'amb', coleta_key: 'kk' }, '2026-11-10T10:30:00Z');
  await espera(); x.alarme('tb-coleta'); await espera();   /* a acordada já abre; o alarme, dentro dos 25 min, não abre outra */
  assert.ok(x.criados.filter((n) => n === 'tb-coleta').length === 1, 'sem alarme existente, tinha que criar UM tb-coleta');
  assert.ok(x.abertas.length === 1 && x.abertas[0].active === false && /vendedores\.mercadolivre\.com\.br\/vendas\/omni\/lista/.test(x.abertas[0].url), 'às 7h30 tinha que abrir a página de vendas numa aba de fundo: ' + JSON.stringify(x.abertas));
  await x.msg({ tipo: 'COLETA_CODIGO', codigo: 'AB12CD34', url: x.abertas[0].url }, x.abertas[0].id);
  assert.ok(x.chamadas.length === 1 && /\/amb-checkout-offline\/ml-codigo-coleta$/.test(x.chamadas[0].url) && x.chamadas[0].o.headers['X-Toolbox-Key'] === 'kk' && JSON.parse(x.chamadas[0].o.body).codigo === 'AB12CD34', 'tinha que mandar pra rota DA EMPRESA com a chave: ' + JSON.stringify(x.chamadas));
  assert.ok(x.st.coleta_ok && x.st.coleta_ok.dia === '2026-11-10' && x.st.coleta_ok.empresa === 'amb' && x.st.coleta_status.ok && x.fechadas.includes(x.abertas[0].id), 'o sucesso tinha que marcar o dia DA EMPRESA e fechar a aba que ela abriu');
  await x.msg({ tipo: 'COLETA_CODIGO', codigo: 'AB12CD34', url: 'https://vendedores.mercadolivre.com.br/vendas/x' }, 999);
  assert.strictEqual(x.chamadas.length, 1, 'o mesmo código no mesmo dia não pode chamar o servidor de novo');
  assert.ok(!x.fechadas.includes(999), 'não pode fechar aba que a Toolbox não abriu');
  await x.msg({ tipo: 'COLETA_SEM_CODIGO', motivo: 'x' }, 1); x.st.coleta_tentativa = 0;   /* sem o espaço de 25 min no caminho */
  x.alarme('tb-coleta'); await espera();
  assert.strictEqual(x.abertas.length, 1, 'já entregue hoje: não abre aba de novo');
  /* Codex #824: trocar a empresa da instalação não pode calar a nova (o "já foi" é por empresa) */
  x.st.tb_empresa = 'good';
  x.alarme('tb-coleta'); await espera();
  assert.strictEqual(x.abertas.length, 2, 'trocou pra GOOD: tinha que tentar pra ela no mesmo dia');
  /* Codex #824 (P1): alarme que já existe NÃO é recriado a cada acordada do fundo (recriar empurrava o disparo pra sempre) */
  const y = montar({ tb_empresa: 'amb', coleta_key: 'kk' }, '2026-11-10T08:00:00Z', ['tb-coleta']); await espera();
  assert.strictEqual(y.criados.filter((n) => n === 'tb-coleta').length, 0, 'o alarme já existia e foi recriado — ele nunca tocaria');
  /* Codex #824 (2ª rodada): a acordada do fundo e o alarme JUNTOS (sem esperar entre eles) abrem UMA aba só */
  { const z = montar({ tb_empresa: 'amb', coleta_key: 'kk' }, '2026-11-10T10:30:00Z'); z.alarme('tb-coleta'); z.alarme('tb-coleta'); await espera();
    assert.strictEqual(z.abertas.length, 1, 'a acordada e o alarme juntos abriram ' + z.abertas.length + ' abas'); }
  /* fora do horário (5h de Brasília), sem chave: não abre */
  x = montar({ tb_empresa: 'good', coleta_key: 'kk' }, '2026-11-10T08:00:00Z'); await espera(); x.alarme('tb-coleta'); await espera();
  assert.strictEqual(x.abertas.length, 0, 'às 5h de Brasília não pode abrir');
  x = montar({ tb_empresa: 'good' }, '2026-11-10T12:00:00Z'); await espera(); x.alarme('tb-coleta'); await espera();
  assert.strictEqual(x.abertas.length, 0, 'sem a chave não pode abrir');
  /* falha do servidor: fica na telinha com o motivo e NÃO marca o dia (tenta de novo) */
  x = montar({ tb_empresa: 'girassol', coleta_key: 'kk' }, '2026-11-10T12:00:00Z'); await espera();
  x.setResposta({ ok: false, via: 'sem_destino', erro: 'sem e-mail do estoque' });
  await x.msg({ tipo: 'COLETA_CODIGO', codigo: 'AB12CD34', url: 'https://vendedores.mercadolivre.com.br/vendas/x' }, 5);
  assert.ok(/\/girassol-backup-offline\/ml-codigo-coleta$/.test(x.chamadas[0].url) && !x.st.coleta_ok && x.st.coleta_status.ok === false && /sem e-mail/.test(x.st.coleta_status.msg), 'a falha tinha que ficar na telinha sem marcar o dia: ' + JSON.stringify(x.st));

  /* ── as amarras ── */
  const man = JSON.parse(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'manifest.json'), 'utf8'));
  assert.ok(man.content_scripts.some((c) => c.js.includes('ct-coleta.js') && c.matches.some((m) => /vendedores\.mercadolivre\.com\.br\/vendas/.test(m))), 'o leitor não está nas páginas de vendas do ML');
  assert.ok(man.background.scripts.includes('bg-coleta.js'), 'o fundo não está no Firefox (background.scripts)');
  assert.ok(/importScripts\([^)]*'bg-coleta\.js'/.test(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'bg-toolbox.js'), 'utf8')), 'o fundo não está no Chrome/Edge (importScripts)');
  const ct = fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'ct-coleta.js'), 'utf8');
  const RE = new RegExp(/var RE = \/(.*)\/;/.exec(ct)[1]);
  assert.strictEqual((RE.exec('Detalhes  Código de autorização para hoje: AB12CD34  Detalhes das coletas') || [])[1], 'AB12CD34', 'o leitor não acha o código no texto da página');
  assert.ok(/coleta\.html/.test(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'popup.js'), 'utf8').split('\n').find((l) => /coleta\.html/.test(l)) || '') && /emp: \['girassol', 'good', 'amb'\], html: '<a class="mod" href="coleta\.html"/.test(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'popup.js'), 'utf8')), 'o cartão do código da coleta não está no menu das três');
  for (const [emp, pref] of Object.entries({ girassol: '/girassol-backup-offline', good: '/good-checkout-offline', amb: '/amb-checkout-offline' })) assert.ok(BG.includes(emp + ": '" + pref + "'"), 'o fundo não manda a ' + emp + ' pro checkout dela');
  assert.ok(/p === PREFIXO \+ '\/ml-codigo-coleta'/.test(fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-comuns.js'), 'utf8')), 'a rota não está na peça comum');
  /* a trava de sessão do checkout deixa passar SÓ esse caminho (a rota tem chave própria) — nas três */
  const rp = require('../lib/http/rotas-protegidas');
  assert.ok(rp.ehRotaChaveToolbox('/amb-checkout-offline/ml-codigo-coleta') && !rp.ehRotaChaveToolbox('/amb-checkout-offline/ml-codigo-coleta/x') && !rp.ehRotaChaveToolbox('/amb-checkout-offline/dashboard'), 'a exceção da trava tem que ser só o caminho exato');
  for (const arq of ['girassol-backup-offline/gbo-app.js', 'amb-checkout-offline/index.js', 'good-checkout-offline/index.js']) assert.ok(/ehRotaChaveToolbox\(p\)/.test(fs.readFileSync(path.join(raiz, arq), 'utf8')), arq + ': a trava de sessão barraria o POST da Toolbox');
  console.log('ok — código da coleta: a função manda uma vez por dia (de Brasília) pro estoque certo e diz o motivo de cada saída; a Toolbox abre a página às 7h numa aba de fundo, manda pra rota da empresa com a chave, marca e fecha só a aba dela');
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
