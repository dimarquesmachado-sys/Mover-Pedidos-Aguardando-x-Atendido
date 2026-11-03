'use strict';
/* 01/11 — O REABRIR SEGURO (auditoria do Codex no SHA 208fdb7d, achados F10 e F06). Com a rota DE PRODUÇÃO (a peça comum
   lib/checkout/rotas-comuns, nas três empresas), dependências falsas e o Bling de mentira:
   F10 — o reabrir GRAVA (tira da fila e mexe no Bling) e aceitava GET: com o cookie de sessão (SameSite=Lax viaja numa
         navegação de outro site) um link disparava. Agora, com a sessão: GET → 403; POST vindo de outro site
         (Sec-Fetch-Site: cross-site) ou de outra origem → 403; POST de dentro do sistema → segue. Com a ADMIN_KEY (script)
         o GET segue como antes.
   F06 — (a) `writeJson` devolve false quando não grava e o retorno era ignorado: a resposta dizia "removido da fila" com o
         pedido AINDA no histórico. Agora: ok:false, removido_da_fila:false, e diz que o Bling já voltou pra ATENDIDO.
         (b) a trava era pelo TEXTO recebido: o mesmo pedido pedido pelo id e pelo número rodava duas vezes ao mesmo
         tempo. Agora o segundo recebe "ja estou reabrindo". */
const assert = require('assert');
const path = require('path');
const { criarRotasComuns, PECAS } = require('../lib/checkout/rotas-comuns');

const HOST = 'mover-pedidos.example';
function montar(emp, pasta, extra) {
  const o = { prefixo: '/' + pasta, tag: emp.toUpperCase(), empresa: emp };
  for (const k of PECAS) o[k] = () => undefined;
  const disco = { '/c/conf.json': { 1001: { numero: '5477', sincronizado: true } }, '/c/rsv.json': {} };
  const respostas = [];
  Object.assign(o, {
    CONFERIDOS_FILE: '/c/conf.json', RESERVAS_FILE: '/c/rsv.json', CACHE_DIR: '/c',
    SIT_ATENDIDO: 9, SIT_VERIFICADO: 24, SIT_DESPACHADOS: 0,
    json: (res, code, body) => respostas.push({ code, body }),
    readJson: (f, d) => (f in disco ? JSON.parse(JSON.stringify(disco[f])) : d),
    writeJson: (f, v) => { disco[f] = JSON.parse(JSON.stringify(v)); return true; },
    lerReservas: () => ({}),
    readBody: async () => ({}),
    ehAdmin: (n) => n === 'chefe',
    validarSessao: () => 'chefe',
    moverSituacao: async () => ({ ok: true }),
    blingGet: async () => ({ ok: true, data: { data: { situacao: { id: 24 } } } }),
    rodarCiclo: async () => {},
    souAdmin: require('../lib/http/admin-da-sessao').souAdmin,   /* a de produção: admin pela sessão ou pela ADMIN_KEY */
    _moverAtendidoDesandando: require('../lib/checkout/resgate-atendido').criarResgateAtendido({ tag: emp.toUpperCase() })._moverAtendidoDesandando,   /* a de produção */
    _detalheBling: require('../lib/checkout/resgate-atendido')._detalheBling,
  }, extra || {});
  return { r: criarRotasComuns(o), disco, respostas, o };
}
const chamar = (m, pasta, metodo, arg, headers, admKey) => {
  const req = { method: metodo, headers: Object.assign({ host: HOST }, headers || {}), _op: admKey ? 'admin-key' : 'chefe' };
  if (admKey) req._admKey = true;
  const u = new URL('http://' + HOST + '/' + pasta + '/reabrir/' + encodeURIComponent(arg) + '?op=chefe');
  return m.r.handle(req, {}, '/' + pasta + '/reabrir/' + encodeURIComponent(arg), metodo, u);
};
const ult = (m) => m.respostas[m.respostas.length - 1];

/* rede de segurança: se algo travar, o teste FALHA (o processo não pode sair calado com sucesso) */
const _guarda = setTimeout(() => { console.error('FALHOU: o teste travou (promessa nunca resolvida)'); process.exit(1); }, 30000);
(async () => {
  for (const [emp, pasta] of [['amb', 'amb-checkout-offline'], ['good', 'good-checkout-offline'], ['girassol', 'girassol-backup-offline']]) {
    /* F10 */
    let m = montar(emp, pasta);
    await chamar(m, pasta, 'GET', '1001', {});
    assert.ok(ult(m).code === 403 && /POST/.test(ult(m).body.erro) && m.disco['/c/conf.json'][1001], emp + ': GET com a sessão ainda reabre (CSRF por link): ' + JSON.stringify(ult(m)));
    await chamar(m, pasta, 'POST', '1001', { 'sec-fetch-site': 'cross-site' });
    assert.ok(ult(m).code === 403 && m.disco['/c/conf.json'][1001], emp + ': POST de outro site (Sec-Fetch-Site) passou');
    await chamar(m, pasta, 'POST', '1001', { origin: 'https://outro-site.example' });
    assert.ok(ult(m).code === 403 && m.disco['/c/conf.json'][1001], emp + ': POST de outra origem passou');
    await chamar(m, pasta, 'POST', '1001', { origin: 'https://' + HOST, 'sec-fetch-site': 'same-origin' });
    assert.ok(ult(m).body && ult(m).body.ok === true && ult(m).body.removido_da_fila === true && !m.disco['/c/conf.json'][1001], emp + ': o POST de dentro do sistema não reabriu: ' + JSON.stringify(ult(m)));
    m = montar(emp, pasta);
    await chamar(m, pasta, 'GET', '1001', {}, true);
    assert.ok(ult(m).body && ult(m).body.ok === true, emp + ': com a ADMIN_KEY (script) o GET tinha que seguir funcionando: ' + JSON.stringify(ult(m)));
    /* F06 (a): a gravação falha */
    m = montar(emp, pasta, { writeJson: (f, v) => (f === '/c/conf.json' ? false : true) });
    await chamar(m, pasta, 'POST', '1001', { origin: 'https://' + HOST });
    const b = ult(m).body || {};
    assert.ok(b.ok === false && b.removido_da_fila === false && b.revertido_p_atendido === true && /JA voltou pra ATENDIDO/.test(b.erro || ''), emp + ': a gravação falhou e a resposta não disse (ou disse que tirou da fila): ' + JSON.stringify(b));
    assert.ok(m.disco['/c/conf.json'][1001], emp + ': o pedido tinha que continuar no histórico');
    /* F06 (b): o mesmo pedido pelo id e pelo número ao mesmo tempo — os dois são DISPARADOS antes de o Bling responder
       (esperar o segundo antes de soltar o Bling travaria o teste no código antigo, que deixava os dois entrarem) */
    let soltar; const espera = new Promise((s2) => { soltar = s2; });
    let movidas = 0;
    m = montar(emp, pasta, { moverSituacao: async () => { movidas++; await espera; return { ok: true }; } });
    const p1 = chamar(m, pasta, 'POST', '1001', { origin: 'https://' + HOST });
    await new Promise((s2) => setTimeout(s2, 20));
    const p2 = chamar(m, pasta, 'POST', '5477', { origin: 'https://' + HOST });
    await new Promise((s2) => setTimeout(s2, 20));
    const noMeio = movidas;
    soltar(); await Promise.all([p1, p2]);
    assert.strictEqual(noMeio, 1, emp + ': o mesmo pedido pelo id e pelo número entrou ' + noMeio + ' vezes no Bling ao mesmo tempo');
    assert.ok(m.respostas.some((x) => x.body && x.body.ok === false && /ja estou reabrindo/.test(x.body.erro || '')), emp + ': o segundo pedido do mesmo pedido não recebeu "ja estou reabrindo"');
    /* e no fim as travas são soltas: o mesmo pedido volta a poder ser reaberto */
    m.disco['/c/conf.json'] = { 1001: { numero: '5477', sincronizado: true } };
    m.o.moverSituacao = async () => ({ ok: true });
  }
  console.log('ok — reabrir seguro nas três: com a sessão só POST de dentro do sistema (GET, outro site e outra origem recusados; ADMIN_KEY segue), só confirma o que gravou, e o mesmo pedido pelo id e pelo número não roda duas vezes');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
