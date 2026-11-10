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
  const d = (o) => Object.assign({ arquivo: arq, readJson, writeJson, enviarEmail, email, tag: 'GIRABKP', nomeEmpresa: 'Magazine Girassol', nomeAssunto: 'GIRASSOL', agora: () => agora }, o || {});

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
  assert.ok(enviados.length === 1 && enviados[0].to === 'estoque@x.com.br' && /AB12CD34/.test(enviados[0].text) && enviados[0].subject === 'Código Coleta MLIVRE — GIRASSOL — 10/11/2026 (terça-feira)' && /\(Magazine Girassol\)/.test(enviados[0].text), 'o e-mail tinha que ir pro estoque com o código e a empresa: ' + JSON.stringify(enviados[0]));
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
  /* 2.1.11: os DETALHES vão no e-mail; sem motorista o e-mail diz que chega outro; quando motorista e placa aparecem,
     UM segundo e-mail (atualizado); depois disso, ja_enviado */
  { const arq3 = path.join(os.tmpdir(), 'coleta-det-' + process.pid + '.json'); try { fs.unlinkSync(arq3); } catch (e) {}
    const env3 = []; const dd = d({ arquivo: arq3, enviarEmail: async (m) => { env3.push(m); } });
    let q = await cc.receber({ codigo: 'DE12FG34', detalhes: { horario: '15 h - 17 h', status: 'PROGRAMADA', deposito: 'Depósito Magazine Girassol' } }, dd);
    assert.ok(q.via === 'enviado' && q.completo === false && /Coleta: 15h - 17h \(PROGRAMADA\)/.test(env3[0].text) && /ainda não definidos/.test(env3[0].text) && /Depósito Magazine Girassol/.test(env3[0].text), 'o 1º e-mail tinha que levar horário e depósito e dizer que o motorista vem depois: ' + JSON.stringify(env3[0]));
    q = await cc.receber({ codigo: 'DE12FG34', detalhes: { horario: '15 h - 17 h' } }, dd);
    assert.ok(q.via === 'ja_enviado' && env3.length === 1, 'sem motorista novo, não manda de novo');
    q = await cc.receber({ codigo: 'DE12FG34', detalhes: { horario: '15 h - 17 h', status: 'A CAMINHO', motorista: 'Fulano de Tal', placa: 'abc1d23' } }, dd);
    assert.ok(q.via === 'atualizado' && q.completo && env3.length === 2 && /Motorista: Fulano de Tal/.test(env3[1].text) && /Placa: ABC1D23/.test(env3[1].text) && /DE12FG34/.test(env3[1].text) && env3[1].subject === 'Código Coleta MLIVRE — GIRASSOL — 11/11/2026 (quarta-feira) — motorista e placa'   /* (neste ponto do teste o relógio já virou pro dia 11) */, 'motorista e placa apareceram: tinha que mandar UM segundo e-mail com eles e o código: ' + JSON.stringify(env3[1]));
    q = await cc.receber({ codigo: 'DE12FG34', detalhes: { motorista: 'Outro', placa: 'XYZ9W87' } }, dd);
    assert.ok(q.via === 'ja_enviado' && env3.length === 2, 'depois do completo, não manda mais');
    /* código novo já com tudo: um e-mail só, completo */
    q = await cc.receber({ codigo: 'HI56JK78', detalhes: { horario: '15:00 h - 17:00 h', motorista: 'Beltrano', placa: 'DEF4G56' } }, dd);
    assert.ok(q.via === 'enviado' && q.completo && /Motorista: Beltrano/.test(env3[2].text) && !/ainda não definidos/.test(env3[2].text), JSON.stringify(env3[2]));
    /* Codex #825: o disco falha (writeJson devolve false): o e-mail foi, a resposta diz persistido:false, e a próxima
       chegada do MESMO código não manda de novo (o estado ficou na memória) */
    { const arq4 = path.join(os.tmpdir(), 'coleta-disco-' + process.pid + '.json'); const env4 = [];
      const d4 = d({ arquivo: arq4, enviarEmail: async (m) => { env4.push(m); }, writeJson: () => false });
      const p1 = await cc.receber({ codigo: 'MN90PQ12', detalhes: { horario: '15 h - 17 h' } }, d4);
      const p2 = await cc.receber({ codigo: 'MN90PQ12', detalhes: { horario: '15 h - 17 h' } }, d4);
      assert.ok(p1.via === 'enviado' && p1.persistido === false && p2.via === 'ja_enviado' && env4.length === 1, 'com o disco falhando, o mesmo código mandou ' + env4.length + ' e-mails: ' + JSON.stringify([p1, p2]));
      const p3 = await cc.receber({ codigo: 'MN90PQ12', detalhes: { motorista: 'Fulano', placa: 'ABC1D23' } }, d4);
      const p4 = await cc.receber({ codigo: 'MN90PQ12', detalhes: { motorista: 'Fulano', placa: 'ABC1D23' } }, d4);
      assert.ok(p3.via === 'atualizado' && p4.via === 'ja_enviado' && env4.length === 2, 'com o disco falhando, o e-mail do motorista repetiu: ' + env4.length); }
    /* 09/11 (pedido do dono): o HTML — o código sozinho, em negrito e ~3× maior; e o que veio da página é ESCAPADO */
    /* 09/11 (layout novo): o código na caixa grande e em negrito; motorista em negrito e a placa em destaque; o cabeçalho
       com a empresa e o dia da semana; o aviso de motorista ainda não definido no 1º e-mail */
    assert.ok(/font-size:44px;font-weight:bold[^>]*>DE12FG34<\/div>/.test(env3[0].html) && /ainda não definido pelo Mercado Livre/.test(env3[0].html) && /Magazine Girassol<\/div>/.test(env3[0].html) && /(terça|quarta)-feira, 1[01]\/11\/2026/.test(env3[0].html), 'o HTML tinha que ter o código grande em negrito, o cabeçalho e o aviso do motorista: ' + env3[0].html.slice(0, 300));
    /* 09/11 (pedido do dono, na prévia): embaixo do código o dia por extenso; horário "15h - 17h"; o "chega outro e-mail"
       na linha de baixo */
    assert.ok(/vale só hoje — (terça|quarta)-feira, 1[01]\/11\/2026<\/div>/.test(env3[0].html) && /vale só hoje — (terça|quarta)-feira, 1[01]\/11\/2026/.test(env3[0].text), 'embaixo do código tinha que vir o dia por extenso e a data');
    assert.ok(/<b>15h - 17h<\/b>/.test(env3[0].html) && /ainda não definido pelo Mercado Livre<\/span><br><span[^>]*>chega outro e-mail quando aparecer/.test(env3[0].html), 'horário "15h - 17h" e o aviso do motorista em duas linhas');
    assert.strictEqual(cc.horarioBonito('15:00 h - 17:30 h'), '15h - 17h30', 'minutos: "17:30 h" vira "17h30"');
    assert.ok(/<b>Fulano de Tal<\/b>/.test(env3[1].html) && /letter-spacing:2px[^>]*>ABC1D23<\/span>/.test(env3[1].html) && /definiu o motorista/.test(env3[1].html), 'o e-mail do motorista tinha que ter o motorista em negrito e a placa em destaque');
    const hx = cc.montarHtml('2026-11-10', 'AB12CD34', { motorista: '<script>x</script>', placa: 'ABC1D23', deposito: 'Dep & "Cia"' }, 'X', false);
    assert.ok(!/<script>/.test(hx) && /&lt;script&gt;/.test(hx) && /Dep &amp; &quot;Cia&quot;/.test(hx), 'o HTML tem que escapar o que veio da página');
    assert.ok(/\):\nDE12FG34\n/.test(env3[0].text), 'no texto puro o código também fica sozinho na linha');
    /* 09/11 (pedido do dono): o "Mandar agora" REENVIA o código já enviado — até 3 vezes; sem forcar, segue não repetindo */
    { const arq5 = path.join(os.tmpdir(), 'coleta-reenvio-' + process.pid + '.json'); try { fs.unlinkSync(arq5); } catch (e) {}
      const env5 = []; const d5 = d({ arquivo: arq5, enviarEmail: async (m) => { env5.push(m); } });
      await cc.receber({ codigo: 'RS34TU56', detalhes: { horario: '15 h - 17 h' } }, d5);
      let w = await cc.receber({ codigo: 'RS34TU56' }, d5);
      assert.ok(w.via === 'ja_enviado' && env5.length === 1, 'sem forcar não pode reenviar');
      w = await cc.receber({ codigo: 'RS34TU56', forcar: true, detalhes: { status: 'CONCLUÍDA' } }, d5);
      assert.ok(w.via === 'reenviado' && env5.length === 2 && / — reenvio$/.test(env5[1].subject) && /RS34TU56/.test(env5[1].text) && /Coleta: 15h - 17h/.test(env5[1].text), 'o forcar tinha que reenviar com o código e o horário já conhecido: ' + JSON.stringify(env5[1]));
      await cc.receber({ codigo: 'RS34TU56', forcar: true }, d5); await cc.receber({ codigo: 'RS34TU56', forcar: true }, d5);
      w = await cc.receber({ codigo: 'RS34TU56', forcar: true }, d5);
      assert.ok(w.via === 'limite_reenvio' && env5.length === 4, 'o 4º reenvio do dia tinha que ser recusado: ' + env5.length);
      fs.unlinkSync(arq5); }
    /* Codex #830: no reenvio, o que a leitura nova trouxe (horário, status) substitui o velho, e o par motorista/placa
       guardado fica quando a leitura nova vem sem ele; no e-mail do motorista, o horário já conhecido não some */
    { const arq6 = path.join(os.tmpdir(), 'coleta-junta-' + process.pid + '.json'); try { fs.unlinkSync(arq6); } catch (e) {}
      const env6 = []; const d6 = d({ arquivo: arq6, enviarEmail: async (m) => { env6.push(m); } });
      await cc.receber({ codigo: 'VW78XY90', detalhes: { horario: '15 h - 17 h', status: 'PENDENTE' } }, d6);
      await cc.receber({ codigo: 'VW78XY90', detalhes: { motorista: 'Fulano', placa: 'ABC1D23' } }, d6);
      assert.ok(/Coleta: 15h - 17h/.test(env6[1].text) && /Motorista: Fulano/.test(env6[1].text), 'o e-mail do motorista perdeu o horário já conhecido: ' + env6[1].text);
      await cc.receber({ codigo: 'VW78XY90', forcar: true, detalhes: { horario: '16 h - 18 h', status: 'CONCLUÍDA' } }, d6);
      assert.ok(/Coleta: 16h - 18h \(CONCLUÍDA\)/.test(env6[2].text) && /Motorista: Fulano/.test(env6[2].text) && /Placa: ABC1D23/.test(env6[2].text), 'o reenvio tinha que levar o horário/status NOVOS e o motorista guardado: ' + env6[2].text);
      assert.deepStrictEqual(cc.juntarDetalhes({ motorista: 'A', placa: 'P1' }, { motorista: 'B' }), { motorista: 'A', placa: 'P1' }, 'motorista e placa andam em par');
      fs.unlinkSync(arq6); }
    assert.deepStrictEqual(cc.limparDetalhes({ motorista: '  A  B  ', placa: 'x', lixo: 'y', horario: 5 }), { motorista: 'A B', placa: 'X', horario: '5' }, 'limpar detalhes: só os campos conhecidos, aparados');
    fs.unlinkSync(arq3); }
  /* e-mail próprio na frente do estoque do checkout */
  process.env.GIRABKP_EMAIL_CODIGO_COLETA = 'outro@x.com.br';
  assert.strictEqual(cc.destinoDe(email, 'GIRABKP'), 'outro@x.com.br');
  delete process.env.GIRABKP_EMAIL_CODIGO_COLETA;
  assert.strictEqual(cc.destinoDe(email, 'GIRABKP'), 'estoque@x.com.br');
  fs.rmSync(dir, { recursive: true, force: true });

  /* ── 2) o fundo da extensão (MODO PASSIVO, 2.1.13), num chrome de mentira ──
     Cláusula 12 dos Termos do ML: a Toolbox NÃO abre página, NÃO clica, NÃO tem alarme e NÃO fecha aba. Ela só manda o
     que o leitor viu na página que uma PESSOA abriu; o "Mandar agora" pede à página de vendas JÁ ABERTA que releia. */
  const BG = fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'bg-coleta.js'), 'utf8');
  function montar(storageIni, horaUTC, abasVendas) {
    const st = Object.assign({}, storageIni); const chamadas = []; const proibido = []; const limpos = []; const relidas = []; let ouvinte = null;
    let resposta = { ok: true, via: 'enviado', para: 'estoque@x.com.br', completo: true };
    const DataFixa = class extends Date { constructor(...a) { super(...(a.length ? a : [horaUTC])); } static now() { return Date.parse(horaUTC); } };
    const chrome = {
      storage: { local: { get: async (ks) => { const o = {}; for (const k of ks) if (k in st) o[k] = st[k]; return o; }, set: async (o) => Object.assign(st, o), remove: async (k) => { for (const x of [].concat(k)) delete st[x]; } } },
      tabs: { create: async () => { proibido.push('tabs.create'); return { id: 1 }; }, remove: async () => { proibido.push('tabs.remove'); },
        query: async (q) => (/vendedores\.mercadolivre\.com\.br\/vendas/.test(q.url) ? (abasVendas || []) : []),
        sendMessage: async (id, m) => { relidas.push([id, m.tipo]); return { ok: true }; } },
      alarms: { create: (n) => { proibido.push('alarms.create:' + n); }, get: (n, cb) => cb && cb(undefined), clear: (n) => { limpos.push(n); }, onAlarm: { addListener: () => { proibido.push('alarms.onAlarm'); } } },
      runtime: { onMessage: { addListener: (f) => { ouvinte = f; } } },
    };
    const fetch = async (url, o) => { chamadas.push({ url, o }); return { status: 200, text: async () => JSON.stringify(resposta) }; };
    const ctx = vm.createContext({ chrome, fetch, Date: DataFixa, Intl, AbortController, setTimeout, clearTimeout, console, JSON, String, Number, Object });
    vm.runInContext(BG, ctx);
    const msg = (m, tabId) => new Promise((ok) => ouvinte(m, { tab: tabId ? { id: tabId } : null }, ok));
    return { st, chamadas, proibido, limpos, relidas, msg, setResposta: (x) => { resposta = x; } };
  }
  const espera = () => new Promise((s) => setTimeout(s, 30));
  /* ao carregar: apaga os alarmes da 2.1.12 e não cria nenhum; nunca abre/fecha aba */
  let x = montar({ tb_empresa: 'amb', coleta_key: 'kk', coleta_aba: 77, coleta_tentativa: 1 }, '2026-11-10T10:30:00Z'); await espera();
  assert.ok(x.limpos.includes('tb-coleta') && x.limpos.includes('tb-coleta-fechar') && !('coleta_aba' in x.st) && !('coleta_tentativa' in x.st), 'na troca da 2.1.12 os alarmes e restos da versão automática tinham que sair: ' + JSON.stringify(x.limpos));
  assert.deepStrictEqual(x.proibido, [], 'o fundo não pode abrir/fechar aba nem criar alarme: ' + JSON.stringify(x.proibido));
  /* a página que a PESSOA abriu manda o código: vai pra rota da empresa, com a chave e os detalhes; nada de fechar aba */
  x.setResposta({ ok: true, via: 'enviado', para: 'e@x', completo: false });
  await x.msg({ tipo: 'COLETA_CODIGO', codigo: 'AB12CD34', detalhes: { horario: '15 h - 17 h' }, url: 'https://vendedores.mercadolivre.com.br/vendas/omni/lista' }, 5);
  assert.ok(x.chamadas.length === 1 && /\/amb-checkout-offline\/ml-codigo-coleta$/.test(x.chamadas[0].url) && x.chamadas[0].o.headers['X-Toolbox-Key'] === 'kk' && JSON.parse(x.chamadas[0].o.body).detalhes.horario === '15 h - 17 h' && JSON.parse(x.chamadas[0].o.body).forcar === false, 'tinha que mandar pra rota DA EMPRESA com a chave e os detalhes: ' + JSON.stringify(x.chamadas[0]));
  assert.ok(x.st.coleta_ok && x.st.coleta_ok.empresa === 'amb' && x.st.coleta_ok.dia === '2026-11-10' && x.st.coleta_ok.completo === false && /Detalhes das coletas/.test(x.st.coleta_status.msg), 'tinha que marcar o dia da empresa e dizer que o motorista vai quando alguém abrir o painel: ' + JSON.stringify(x.st));
  /* a mesma página de novo (sem motorista): não manda; a tela diz que já foi */
  await x.msg({ tipo: 'COLETA_CODIGO', codigo: 'AB12CD34', detalhes: {}, url: 'x' }, 5);
  assert.ok(x.chamadas.length === 1 && x.st.coleta_status.via === 'ja_foi_hoje', 'o mesmo código sem novidade não chama o servidor (e a tela explica)');
  /* a pessoa abriu "Detalhes das coletas" e o ML mostrou o motorista: o leitor manda; vai o segundo e-mail */
  x.setResposta({ ok: true, via: 'atualizado', para: 'e@x', completo: true });
  await x.msg({ tipo: 'COLETA_CODIGO', codigo: 'AB12CD34', detalhes: { motorista: 'Fulano', placa: 'ABC1D23' }, url: 'x' }, 5);
  assert.ok(x.chamadas.length === 2 && x.st.coleta_ok.completo === true && /motorista e placa enviados/.test(x.st.coleta_status.msg), 'o motorista visto na tela da pessoa tinha que ir');
  await x.msg({ tipo: 'COLETA_CODIGO', codigo: 'AB12CD34', detalhes: { motorista: 'Fulano', placa: 'ABC1D23' }, url: 'x' }, 5);
  assert.strictEqual(x.chamadas.length, 2, 'completo: não chama mais');
  /* Codex #824: trocar a empresa da instalação no mesmo dia não pode calar a nova */
  x.st.tb_empresa = 'good';
  await x.msg({ tipo: 'COLETA_CODIGO', codigo: 'AB12CD34', detalhes: {}, url: 'x' }, 5);
  assert.ok(x.chamadas.length === 3 && /\/good-checkout-offline\/ml-codigo-coleta$/.test(x.chamadas[2].url), 'trocou pra GOOD: tinha que mandar pra GOOD');
  /* "Mandar agora" SEM página de vendas aberta: não abre nada — a tela pede pra abrir */
  x = montar({ tb_empresa: 'amb', coleta_key: 'kk', coleta_ok: { empresa: 'amb', dia: '2026-11-10', codigo: 'AB12CD34', completo: true } }, '2026-11-10T20:00:00Z', []); await espera();
  await x.msg({ tipo: 'COLETA_AGORA' }, null);
  assert.ok(x.proibido.length === 0 && x.relidas.length === 0 && x.st.coleta_status.via === 'sem_pagina_aberta' && !x.st.coleta_forcar, 'sem página aberta: nada de abrir aba; a tela pede pra abrir: ' + JSON.stringify(x.st.coleta_status));
  /* "Mandar agora" COM a página aberta: pede pra ELA reler; a leitura que chega em seguida reenvia (forcar) e limpa a marca */
  x = montar({ tb_empresa: 'amb', coleta_key: 'kk', coleta_ok: { empresa: 'amb', dia: '2026-11-10', codigo: 'AB12CD34', completo: true } }, '2026-11-10T20:00:00Z', [{ id: 31 }]); await espera();
  x.setResposta({ ok: true, via: 'reenviado', para: 'e@x', completo: true });
  await x.msg({ tipo: 'COLETA_AGORA' }, null);
  assert.ok(x.relidas.length === 1 && x.relidas[0][0] === 31 && x.relidas[0][1] === 'COLETA_RELER' && x.st.coleta_forcar && x.proibido.length === 0, 'tinha que pedir à página aberta que relesse: ' + JSON.stringify(x.relidas));
  await x.msg({ tipo: 'COLETA_CODIGO', codigo: 'AB12CD34', detalhes: { status: 'CONCLUÍDA' }, url: 'x' }, 31);
  assert.ok(x.chamadas.length === 1 && JSON.parse(x.chamadas[0].o.body).forcar === true && x.st.coleta_status.via === 'reenviado' && !x.st.coleta_forcar, 'a releitura pedida pelo botão tinha que reenviar (forcar) e limpar a marca');
  /* a marca do botão vence em 4 min: leitura depois disso não reenvia */
  x = montar({ tb_empresa: 'amb', coleta_key: 'kk', coleta_ok: { empresa: 'amb', dia: '2026-11-10', codigo: 'AB12CD34', completo: true }, coleta_forcar: { em: Date.parse('2026-11-10T19:50:00Z') } }, '2026-11-10T20:00:00Z'); await espera();
  await x.msg({ tipo: 'COLETA_CODIGO', codigo: 'AB12CD34', detalhes: {}, url: 'x' }, 9);
  assert.strictEqual(x.chamadas.length, 0, 'marca do botão com mais de 4 min não pode reenviar');
  /* falha do servidor: fica na telinha com o motivo e NÃO marca o dia */
  x = montar({ tb_empresa: 'girassol', coleta_key: 'kk' }, '2026-11-10T12:00:00Z'); await espera();
  x.setResposta({ ok: false, via: 'sem_destino', erro: 'sem e-mail do estoque' });
  await x.msg({ tipo: 'COLETA_CODIGO', codigo: 'AB12CD34', detalhes: {}, url: 'x' }, 5);
  assert.ok(/\/girassol-backup-offline\/ml-codigo-coleta$/.test(x.chamadas[0].url) && !x.st.coleta_ok && x.st.coleta_status.ok === false && /sem e-mail/.test(x.st.coleta_status.msg), 'a falha tinha que ficar na telinha sem marcar o dia');
  /* o texto do fundo não pode ter nada de automação: abrir/fechar aba, alarme do código, endereço da página */
  for (const proib of ['tabs.create', 'tabs.remove', "alarms.create('tb-coleta'", 'COLETA_URL', 'COLETA_QUEM_ABRIU']) assert.ok(!BG.includes(proib), 'o fundo voltou a ter automação: ' + proib);

  /* ── as amarras ── */
  const man = JSON.parse(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'manifest.json'), 'utf8'));
  assert.ok(man.content_scripts.some((c) => c.js.includes('ct-coleta.js') && c.js.indexOf('coleta-ler.js') >= 0 && c.js.indexOf('coleta-ler.js') < c.js.indexOf('ct-coleta.js') && c.matches.some((m) => /vendedores\.mercadolivre\.com\.br\/vendas/.test(m))), 'o leitor (com o coleta-ler.js ANTES) não está nas páginas de vendas do ML');
  assert.ok(man.background.scripts.includes('bg-coleta.js'), 'o fundo não está no Firefox (background.scripts)');
  assert.ok(/importScripts\([^)]*'bg-coleta\.js'/.test(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'bg-toolbox.js'), 'utf8')), 'o fundo não está no Chrome/Edge (importScripts)');
  const lerCtx = {}; vm.runInNewContext(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'coleta-ler.js'), 'utf8'), lerCtx);
  const LER = lerCtx.tbColetaLer;
  const PAINEL = 'Detalhes das coletas\nÚltima atualização: 9 de novembro às 14h23\nAgrupar pacotes pelo app\nNOVO\nDepósito Magazine Girassol\nAvisos\n1\nColeta especial na sexta-feira, 20 de novembro\nPróximo envio\nA CAMINHO\nColeta | 15 h - 17 h\nO motorista está a caminho. Use o código de autorização do dia para enviar os pacotes.\nMotorista: Fulano de Tal Silva\nPlaca: ABC1D23\nRequer o código de autorização\nCódigo de autorização para hoje: AB12CD34  Detalhes das coletas';
  assert.strictEqual(LER.lerCodigo(PAINEL), 'AB12CD34', 'o leitor não acha o código no texto da página');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(LER.lerDetalhes(PAINEL))), { horario: '15 h - 17 h', status: 'A CAMINHO', motorista: 'Fulano de Tal Silva', placa: 'ABC1D23', deposito: 'Depósito Magazine Girassol' }, 'o leitor não tirou os detalhes do painel');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(LER.lerDetalhes('A CAMINHO\nColeta | 15:00 h - 17:00 h\nAtrasadas. Enviar'))), { horario: '15:00 h - 17:00 h', status: 'A CAMINHO' }, 'sem o painel: só o que está no cartão, sem inventar motorista');
  const ct = fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'ct-coleta.js'), 'utf8');
  /* 2.1.13 (modo passivo): o leitor NÃO clica em nada; lê a tela da pessoa e atende à releitura pedida pelo botão */
  assert.ok(!/\.click\(/.test(ct) && !/COLETA_QUEM_ABRIU/.test(ct) && !/dispatchEvent/.test(ct), 'o leitor voltou a clicar/interagir com a página do ML');
  assert.ok(/msg\.tipo !== 'COLETA_RELER'/.test(ct) && /vigiarMotorista\(codigo\)/.test(ct), 'o leitor tinha que atender à releitura e perceber o motorista quando a pessoa abre o painel');
  assert.ok(/coleta\.html/.test(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'popup.js'), 'utf8').split('\n').find((l) => /coleta\.html/.test(l)) || '') && /emp: \['girassol', 'good', 'amb'\], html: '<a class="mod" href="coleta\.html"/.test(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'popup.js'), 'utf8')), 'o cartão do código da coleta não está no menu das três');
  for (const [emp, pref] of Object.entries({ girassol: '/girassol-backup-offline', good: '/good-checkout-offline', amb: '/amb-checkout-offline' })) assert.ok(BG.includes(emp + ": '" + pref + "'"), 'o fundo não manda a ' + emp + ' pro checkout dela');
  assert.ok(/p === PREFIXO \+ '\/ml-codigo-coleta'/.test(fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-comuns.js'), 'utf8')), 'a rota não está na peça comum');
  /* a trava de sessão do checkout deixa passar SÓ esse caminho (a rota tem chave própria) — nas três */
  const rp = require('../lib/http/rotas-protegidas');
  assert.ok(rp.ehRotaChaveToolbox('/amb-checkout-offline/ml-codigo-coleta') && !rp.ehRotaChaveToolbox('/amb-checkout-offline/ml-codigo-coleta/x') && !rp.ehRotaChaveToolbox('/amb-checkout-offline/dashboard'), 'a exceção da trava tem que ser só o caminho exato');
  for (const arq of ['girassol-backup-offline/gbo-app.js', 'amb-checkout-offline/index.js', 'good-checkout-offline/index.js']) assert.ok(/ehRotaChaveToolbox\(p\)/.test(fs.readFileSync(path.join(raiz, arq), 'utf8')), arq + ': a trava de sessão barraria o POST da Toolbox');
  console.log('ok — código da coleta: a função manda uma vez por dia (de Brasília) pro estoque certo e diz o motivo de cada saída; a Toolbox (modo passivo) só manda o que a pessoa viu na página que abriu — sem abrir aba, clicar ou alarme');
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
