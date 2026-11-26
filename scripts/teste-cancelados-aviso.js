'use strict';
/* 26/11 — O AVISO NO CHECKOUT DAS VENDAS CANCELADAS NO MARKETPLACE ANTES DA POSTAGEM (painel-galpao.html, bloco CANCMKT).
   Pedido do dono: "me mostra a notificaçãozinha lá igual qdo no problema do endereço, e me deixa gerar cancelamento se
   menos 24h da emissão da NF ou devolução se for mais q isso", e "depois mover ele pra status cancelado dentro do bling".

   O que se prova, rodando o trecho de produção do painel num navegador de mentira:
   A. só o admin vê; a lista diz o que cabe a cada pedido (cancelar / devolução / sem nota / não sei a data) com os botões
      certos; resposta "não ok" (marketplace fora) NÃO esconde o que já está na tela; lista vazia esconde;
   B. "já cancelei" / "já gerei a devolução": pede confirmação, chama o servidor e mostra o que ele respondeu (o servidor
      é quem confere e move) — sem clique em dobro;
   C. "Gerar devolução (Toolbox)": sem a Toolbox não chama nada; o servidor prepara (confere as pontas e a nota) e só então
      a Toolbox é chamada, com a nota e a loja que o servidor deu; só devolução EMITIDA resolve (com o id e o número dela);
      "já existe", rascunho, sem resposta e não logado NÃO resolvem;
   D. o painel de cada empresa leva o aviso, com o prefixo e a empresa DELA, e a versão do painel subiu. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const html = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'painel', 'painel-galpao.html'), 'utf8');
const INI = '/* ══ CANCMKT-INICIO ══', FIM = '/* ══ CANCMKT-FIM ══ */\n';
const i0 = html.indexOf(INI), i1 = html.indexOf(FIM);
assert.ok(i0 > 0 && i1 > i0, 'o bloco do aviso dos cancelados não está no painel');
assert.ok(/<div id="cancMkt" style="display:none/.test(html), 'a caixa do aviso não está no painel (escondida até ter o que mostrar)');
const AJUDA = ['function _nfaLimpo(v){', 'function _nfaHoras(h){'].map((ini) => { const i = html.indexOf(ini); assert.ok(i > 0, 'falta ' + ini); return html.slice(i, html.indexOf('\n', i) + 1); }).join('');
const BLOCO = AJUDA + html.slice(i0, i1 + FIM.length).split('{{PREFIXO}}').join('/emp').split('{{EMPRESA}}').join('empresa-x');

function nav(op) {
  op = op || {};
  const el = { style: { display: 'none' }, innerHTML: '' };
  const obs = { buscas: [], toasts: [], confirma: [], intervalos: [], ponte: [], vivas: 0 };
  const cx = { el, obs, admin: op.admin !== false, lista: op.lista, resolver: op.resolver === undefined ? { ok: true } : op.resolver, preparar: op.preparar, confirma: op.confirma !== false,
    viva: op.viva !== false, ponte: op.ponte, rede: false, segura: null };
  const f = new Function('document', 'fetch', 'setInterval', 'souAdmin', 'confirm', 'toast', '_nfaPonteViva', '_nfaPedirDevolucao',
    BLOCO + '\nreturn { checarCancMkt, resolverCancMkt, gerarDevolucaoCancMkt };')(
    { getElementById: (id) => (id === 'cancMkt' && !op.semEl ? el : null) },
    async (u, o) => {
      obs.buscas.push(u); assert.deepStrictEqual(o, /resolver=/.test(u) ? { method: 'POST', credentials: 'same-origin' } : { credentials: 'same-origin' });   /* Codex #993: quem grava é POST */
      if (cx.rede) throw new Error('rede');
      if (cx.segura && /resolver=/.test(u)) await cx.segura;
      const resp = /resolver=/.test(u) ? cx.resolver : (/preparar=/.test(u) ? cx.preparar : cx.lista);
      return { json: async () => { if (resp === 'TORTO') throw new Error('json'); return resp; } };
    },
    (fn, ms) => obs.intervalos.push(ms), () => cx.admin, (m) => { obs.confirma.push(m); return cx.confirma; }, (m, ms) => obs.toasts.push([m, ms]),
    async () => { obs.vivas++; return cx.viva; }, async (payload) => { obs.ponte.push(payload); return typeof cx.ponte === 'function' ? cx.ponte(payload) : cx.ponte; });
  cx.f = f;
  return cx;
}
const P = (extra) => Object.assign({ pedido_id: '27496395555', numero: 125464, numero_loja: '583000000000000001', marketplace: 'tiktok', nf_numero: '131074', nfe_id: '27496395841', horas_desde_a_emissao: 6, acao: 'cancelar' }, extra || {});
const LISTA = { ok: true, total: 4, pendentes: [P(), P({ pedido_id: '22', numero: 2002, nf_numero: '131000', nfe_id: '9011', horas_desde_a_emissao: 53.4, acao: 'devolucao' }),
  P({ pedido_id: '33', numero: 2003, nf_numero: null, nfe_id: null, horas_desde_a_emissao: null, acao: 'sem_nf' }), P({ pedido_id: '44', numero: 2004, nf_numero: '131013', nfe_id: null, horas_desde_a_emissao: null, acao: null })] };

let _chegou = false;
process.on('exit', (c) => { if (c === 0 && !_chegou) { console.error('o teste parou no meio (promessa que nunca resolveu)'); process.exitCode = 1; } });
(async () => {
  /* ═══ A. a lista ═══ */
  let n = nav({ lista: LISTA });
  assert.deepStrictEqual(n.obs.intervalos, [5 * 60000], 'a lista é reconsultada de 5 em 5 minutos');
  await n.f.checarCancMkt();
  let h = n.el.innerHTML;
  assert.deepStrictEqual([n.el.style.display, n.obs.buscas], ['', ['/emp/cancelados-tratar']]);
  assert.ok(h.indexOf('<b>🚫 4 vendas canceladas no marketplace ANTES da postagem</b> — o pedido nem saiu do galpão, mas a nota continua valendo no Bling até você tratar:') === 0, h.slice(0, 200));
  const linhas = h.split('<div style="margin-top:6px">').slice(1);
  assert.strictEqual(linhas.length, 4, 'quatro pedidos');
  /* menos de 24 h: cancelar no Bling e avisar — sem botão de devolução */
  assert.ok(linhas[0].indexOf('• <a href="https://www.bling.com.br/vendas.php#edit/27496395555" target="_blank" rel="noopener" style="color:#fecaca"><b>Pedido 125464</b></a> · TikTok 583000000000000001 · <a href="https://www.bling.com.br/notas.fiscais.php#edit/27496395841" target="_blank" rel="noopener" style="color:#fecaca"><b>NF 131074</b></a>: <b>CANCELAR a nota</b> no Bling (emitida há 6 h — até 24 h ainda cancela) e depois tocar aqui<br>') === 0, linhas[0]);
  assert.deepStrictEqual([/onclick="resolverCancMkt\('27496395555','125464','cancelada'\)">✓ já cancelei a NF<\/button>/.test(linhas[0]), /gerarDevolucaoCancMkt|devolvida/.test(linhas[0])], [true, false], 'até 24 h: só "já cancelei"');
  /* passou das 24 h: gerar a devolução, e os dois "já tratei" */
  assert.ok(/<b>NF de DEVOLUÇÃO<\/b> \(emitida há 2 dias — passou das 24 h do cancelamento\)<br>/.test(linhas[1]), linhas[1]);
  assert.deepStrictEqual([/onclick="gerarDevolucaoCancMkt\('22','2002','131000'\)">🧾 Gerar devolução \(Toolbox\)<\/button>/.test(linhas[1]), /onclick="resolverCancMkt\('22','2002','devolvida'\)">✓ já gerei a devolução<\/button>/.test(linhas[1]), /onclick="resolverCancMkt\('22','2002','cancelada'\)"/.test(linhas[1])], [true, true, true]);
  /* sem nota: nenhum botão, só o que fazer */
  assert.deepStrictEqual([/<b>Pedido 2003<\/b><\/a> · TikTok 583000000000000001: sem nota fiscal — é só <b>cancelar o pedido<\/b> no Bling<\/div>$/.test(linhas[2]), /button|NF /.test(linhas[2])], [true, false], linhas[2]);
  /* nota sem data e sem o id: número sem link, os dois "já tratei", sem Toolbox */
  assert.deepStrictEqual([/ · <b>NF 131013<\/b>: cancelar a nota \(até 24 h da emissão\) ou devolver — não sei quando foi emitida<br>/.test(linhas[3]), /notas\.fiscais/.test(linhas[3]), /'cancelada'/.test(linhas[3]), /'devolvida'/.test(linhas[3]), /gerarDevolucaoCancMkt/.test(linhas[3])], [true, false, true, true, false], linhas[3]);
  assert.ok(/Tratada a nota, o pedido vai pra Cancelado no Bling e sai da fila na próxima atualização\.<\/div>$/.test(h));
  /* um só: singular */
  n = nav({ lista: { ok: true, pendentes: [P()] } }); await n.f.checarCancMkt();
  assert.ok(n.el.innerHTML.indexOf('<b>🚫 1 venda cancelada no marketplace ANTES da postagem</b>') === 0);
  /* mais de 8: mostra 8 e diz quantos faltam */
  n = nav({ lista: { ok: true, pendentes: Array.from({ length: 11 }, (_, i) => P({ pedido_id: String(100 + i), numero: 100 + i })) } }); await n.f.checarCancMkt();
  assert.deepStrictEqual([n.el.innerHTML.split('• <a href').length - 1, /… e mais 3\.<\/div>/.test(n.el.innerHTML), /Pedido 107<|Pedido 108</.test(n.el.innerHTML).toString() + /Pedido 108</.test(n.el.innerHTML)], [8, true, 'truefalse']);
  /* o que vem do servidor não vira HTML */
  n = nav({ lista: { ok: true, pendentes: [P({ pedido_id: '1"><img src=x>', numero: '<b>9</b>', numero_loja: "5'); alert(1);//", nf_numero: '1<i>', nfe_id: '2"x', marketplace: '<u>ml</u>' })] } }); await n.f.checarCancMkt();
  assert.ok(!/<img|<i>|<u>|alert\(1\);|"x/.test(n.el.innerHTML.replace(/<a href="[^"]*" target="_blank" rel="noopener" style="color:#fecaca">/g, '')) && /vendas\.php#edit\/1img srcx"/.test(n.el.innerHTML) && !n.el.innerHTML.includes('<b>9</b>') && n.el.innerHTML.includes('<b>Pedido b9/b</b>'), n.el.innerHTML);
  /* quem não é admin: nada, e nem pergunta ao servidor */
  n = nav({ lista: LISTA, admin: false }); n.el.innerHTML = 'velho'; n.el.style.display = '';
  await n.f.checarCancMkt(); assert.deepStrictEqual([n.el.style.display, n.el.innerHTML, n.obs.buscas.length], ['none', '', 0]);
  /* deixou de ser admin enquanto a resposta vinha */
  n = nav({ lista: LISTA }); const _f = n.f.checarCancMkt(); n.admin = false; await _f; assert.deepStrictEqual([n.el.style.display, n.el.innerHTML], ['none', '']);
  /* lista vazia esconde; "não ok", resposta torta e rede caída NÃO escondem o que já está na tela */
  n = nav({ lista: LISTA }); await n.f.checarCancMkt(); const antes = n.el.innerHTML;
  for (const ruim of [{ ok: false, total: 0, pendentes: [], erro: 'TikTok não respondeu' }, { ok: true }, { ok: 'sim', pendentes: [] }, null, 'TORTO']) { n.lista = ruim; await n.f.checarCancMkt(); assert.deepStrictEqual([n.el.style.display, n.el.innerHTML === antes], ['', true], 'não esconde: ' + JSON.stringify(ruim)); }
  n.rede = true; await n.f.checarCancMkt(); assert.strictEqual(n.el.innerHTML, antes); n.rede = false;
  n.lista = { ok: true, total: 0, pendentes: [] }; await n.f.checarCancMkt(); assert.deepStrictEqual([n.el.style.display, n.el.innerHTML], ['none', '']);
  n = nav({ lista: LISTA, semEl: true }); await n.f.checarCancMkt(); assert.strictEqual(n.obs.buscas.length, 0, 'sem a caixa na página, nem consulta');

  /* ═══ B. "já cancelei" / "já gerei a devolução" ═══ */
  for (const [como, palavra] of [['cancelada', 'CANCELADA'], ['devolvida', 'DEVOLVIDA (NF de devolução emitida)']]) {
    n = nav({ lista: LISTA });
    await n.f.resolverCancMkt('22', '2002', como);
    assert.deepStrictEqual(n.obs.confirma, ['Pedido 2002: a nota já foi ' + palavra + ' no Bling?\n\nConfirmando, o pedido é movido pra CANCELADO no Bling e sai da fila do galpão. Isto não cancela nem devolve a nota.']);
    assert.deepStrictEqual([n.obs.buscas, n.obs.toasts], [['/emp/cancelados-tratar?resolver=22&como=' + como + '&confirma=sim', '/emp/cancelados-tratar'], [['✓ pedido 2002 movido pra Cancelado no Bling — sai da fila na próxima atualização', 7000]]], como + ': chama o servidor, avisa e relê a lista');
  }
  /* não confirmou / não é admin: nada */
  n = nav({ confirma: false }); await n.f.resolverCancMkt('22', '2002', 'cancelada'); assert.deepStrictEqual([n.obs.buscas.length, n.obs.toasts.length], [0, 0]);
  n = nav({ admin: false }); await n.f.resolverCancMkt('22', '2002', 'cancelada'); assert.deepStrictEqual([n.obs.confirma.length, n.obs.buscas.length], [0, 0]);
  /* o servidor recusou (a nota ainda não está cancelada, o pedido foi postado…): mostra o motivo DELE */
  n = nav({ lista: LISTA, resolver: { ok: false, etapa: 'nao_cancelada', erro: 'a nota 131000 ainda NÃO aparece cancelada no Bling — cancele por lá e toque de novo' } });
  await n.f.resolverCancMkt('22', '2002', 'cancelada');
  assert.deepStrictEqual(n.obs.toasts, [['⚠️ pedido 2002: a nota 131000 ainda NÃO aparece cancelada no Bling — cancele por lá e toque de novo', 12000]]);
  for (const [resp, msg] of [[null, 'sem resposta'], ['TORTO', 'sem resposta'], [{ ok: 'true' }, 'sem resposta'], [{}, 'sem resposta']]) { n = nav({ resolver: resp }); await n.f.resolverCancMkt('22', '2002', 'cancelada'); assert.deepStrictEqual(n.obs.toasts, [['⚠️ pedido 2002: ' + msg, 12000]], JSON.stringify(resp)); }
  n = nav(); n.rede = true; await n.f.resolverCancMkt('22', '2002', 'cancelada'); assert.deepStrictEqual(n.obs.toasts, [['⚠️ pedido 2002: falha de comunicação — tente de novo', 12000]]);
  /* clique em dobro: o segundo não faz nada enquanto o primeiro não volta — e depois volta a valer */
  n = nav(); let solta; n.segura = new Promise((r) => { solta = r; });
  const um = n.f.resolverCancMkt('22', '2002', 'cancelada'); await new Promise((r) => setImmediate(r));
  const dois = n.f.resolverCancMkt('22', '2002', 'cancelada'), tres = n.f.gerarDevolucaoCancMkt('22', '2002', '131000'); await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual([n.obs.confirma.length, n.obs.buscas.filter((u) => /resolver=/.test(u)).length, n.obs.vivas], [1, 1, 0], 'o mesmo pedido não é tratado duas vezes ao mesmo tempo');
  const outro = n.f.resolverCancMkt('33', '2003', 'cancelada'); await new Promise((r) => setImmediate(r)); assert.strictEqual(n.obs.confirma.length, 2, 'outro pedido segue livre');
  solta(); await um; await outro; await dois; await tres; n.segura = null; await n.f.resolverCancMkt('22', '2002', 'cancelada'); assert.strictEqual(n.obs.buscas.filter((u) => /resolver=22/.test(u)).length, 2);

  /* ═══ C. gerar a devolução pela Toolbox ═══ */
  const PREP = { ok: true, pedido_id: '22', nfe_id: '9011', numero: '131000', id_loja: '205' };
  const EMITIDA = { ok: true, resultado: { idNotaDevolucao: 5550001, numero: '131200', emitida: true } };
  n = nav({ lista: LISTA, preparar: PREP, ponte: EMITIDA });
  await n.f.gerarDevolucaoCancMkt('22', '2002', '131000');
  assert.deepStrictEqual(n.obs.confirma, ['Gerar e EMITIR a NF de devolução da NF 131000 (pedido 2002) no Bling, pela Toolbox?\n\nPrecisa: estar no computador, no navegador DESTA empresa, com a Toolbox atualizada e o Bling aberto e logado nesta empresa. Pode levar até 1 minuto. Dando certo, o pedido é movido pra Cancelado.']);
  assert.deepStrictEqual([n.obs.vivas, n.obs.ponte, n.obs.buscas], [1, [{ idNFOriginal: '9011', idLoja: '205', emitir: true, empresa: 'empresa-x' }],
    ['/emp/cancelados-tratar?preparar=22', '/emp/cancelados-tratar?resolver=22&como=devolvida&confirma=sim&devolucao_id=5550001&devolucao_numero=131200', '/emp/cancelados-tratar']], 'a ordem: Toolbox viva → o servidor prepara → a Toolbox gera → o servidor move → relê');
  assert.deepStrictEqual(n.obs.toasts[n.obs.toasts.length - 1], ['✓ NF de devolução 131200 emitida — pedido 2002 movido pra Cancelado no Bling', 12000]);
  /* a loja que o servidor não soube vai null; a devolução emitida e o pedido que NÃO moveu: diz, e manda tocar no "já gerei" */
  n = nav({ preparar: Object.assign({}, PREP, { id_loja: null }), ponte: EMITIDA, resolver: { ok: false, erro: 'o Bling não moveu o pedido pra Cancelado (resposta 400)' } });
  await n.f.gerarDevolucaoCancMkt('22', '2002', '131000');
  assert.deepStrictEqual([n.obs.ponte[0].idLoja, n.obs.toasts[n.obs.toasts.length - 1]], [null, ['✓ devolução 131200 emitida, mas o pedido 2002 não foi movido (o Bling não moveu o pedido pra Cancelado (resposta 400)) — toque em "já gerei a devolução"', 12000]]);
  /* sem a Toolbox: nem o servidor é chamado */
  n = nav({ viva: false, preparar: PREP, ponte: EMITIDA }); await n.f.gerarDevolucaoCancMkt('22', '2002', '131000');
  assert.deepStrictEqual([n.obs.buscas, n.obs.ponte.length, /^⚠️ Toolbox não encontrada nesta página/.test(n.obs.toasts[0][0])], [['/emp/cancelados-tratar'], 0, true]);
  n = nav({ confirma: false, preparar: PREP }); await n.f.gerarDevolucaoCancMkt('22', '2002', '131000'); assert.deepStrictEqual([n.obs.vivas, n.obs.buscas.length], [0, 0]);
  n = nav({ admin: false, preparar: PREP }); await n.f.gerarDevolucaoCancMkt('22', '2002', '131000'); assert.deepStrictEqual([n.obs.confirma.length, n.obs.vivas], [0, 0]);
  /* o servidor não preparou (postado, menos de 24 h, nota cancelada, fora do ar…): a Toolbox NÃO é chamada */
  for (const [prep, msg] of [[{ ok: false, etapa: 'postado', erro: 'o TikTok mostra sinal de ENVIO nesse pedido — é caso do Devoluções, não trato por aqui' }, 'o TikTok mostra sinal de ENVIO nesse pedido — é caso do Devoluções, não trato por aqui'],
    [{ ok: false, etapa: 'ainda_cancela', erro: 'emitida há menos de 24 h' }, 'emitida há menos de 24 h'], [null, 'sem resposta do servidor — tente de novo'], ['TORTO', 'sem resposta do servidor — tente de novo'],
    [{ ok: 'true', nfe_id: '9011' }, 'sem resposta do servidor — tente de novo'], [{ ok: true }, 'sem resposta do servidor — tente de novo'], [{ ok: true, nfe_id: '' }, 'sem resposta do servidor — tente de novo']]) {
    n = nav({ preparar: prep, ponte: EMITIDA }); await n.f.gerarDevolucaoCancMkt('22', '2002', '131000');
    assert.deepStrictEqual([n.obs.ponte.length, n.obs.buscas.filter((u) => /resolver=/.test(u)).length, n.obs.toasts[n.obs.toasts.length - 1]], [0, 0, ['⚠️ não gerei: ' + msg, 12000]], JSON.stringify(prep));
  }
  n = nav({ preparar: PREP, ponte: EMITIDA }); n.rede = true; await n.f.gerarDevolucaoCancMkt('22', '2002', '131000'); assert.strictEqual(n.obs.ponte.length, 0, 'rede caída no preparar: a Toolbox não é chamada');
  /* só a devolução EMITIDA resolve — o resto avisa e NÃO move o pedido */
  for (const [resp, re] of [[{ ok: false, codigo: 'JA_EXISTE', idNotaDevolucao: 1 }, /^⚠️ o Bling já tem uma devolução da NF 131000 \(nada foi criado agora\)/],
    [{ ok: false, codigo: 'RASCUNHO_CRIADO', idNotaDevolucao: 77, erro: 'SEFAZ recusou' }, /^⚠️ a NF de devolução 77 foi CRIADA no Bling mas não emitiu .* SEFAZ recusou$/],
    [{ ok: true, resultado: { idNotaDevolucao: 78, numero: '9', emitida: false } }, /^⚠️ a NF de devolução 9 foi CRIADA no Bling mas não emitiu/],
    [{ ok: false, codigo: 'TIMEOUT', erro: 'x' }, /^⚠️ a Toolbox não respondeu a tempo — a devolução PODE ter sido criada/],
    [{ ok: false, codigo: 'NAO_LOGADO' }, /^⚠️ o Bling não está logado neste navegador/],
    [{ ok: false, erro: 'empresa errada' }, /^⚠️ não gerei a devolução: empresa errada$/], [null, /^⚠️ não gerei a devolução: erro desconhecido$/]]) {
    n = nav({ preparar: PREP, ponte: resp }); await n.f.gerarDevolucaoCancMkt('22', '2002', '131000');
    assert.deepStrictEqual([n.obs.ponte.length, n.obs.buscas.filter((u) => /resolver=/.test(u)).length, re.test(n.obs.toasts[n.obs.toasts.length - 1][0])], [1, 0, true], JSON.stringify(resp) + ' → ' + n.obs.toasts[n.obs.toasts.length - 1][0]);
  }
  /* emitida sem o campo `emitida` (Toolbox antiga responde só ok): vale; e a trava solta no fim */
  n = nav({ preparar: PREP, ponte: { ok: true, resultado: { idNotaDevolucao: 80, numero: '10' } } }); await n.f.gerarDevolucaoCancMkt('22', '2002', '131000');
  assert.ok(n.obs.buscas.includes('/emp/cancelados-tratar?resolver=22&como=devolvida&confirma=sim&devolucao_id=80&devolucao_numero=10'));
  await n.f.gerarDevolucaoCancMkt('22', '2002', '131000'); assert.strictEqual(n.obs.ponte.length, 2, 'terminou: pode tentar de novo');

  /* ═══ D. o painel de cada empresa ═══ */
  const Pn = require('../lib/checkout/painel/painel-galpao');
  const VERSOES = { 'girassol-backup-offline': 'b163', 'amb-checkout-offline': 'b155', 'good-checkout-offline': 'b93' };
  for (const pasta of Object.keys(VERSOES)) {
    const mk = require(path.join(raiz, pasta, 'painel-marca.js'));
    assert.strictEqual(mk.UI_BUILD, VERSOES[pasta], pasta + ': a versão do painel sobe quando o painel muda (navegador com o painel velho em cache)');
    const pg = Pn.renderizar(mk);
    assert.ok(pg.includes("fetch('" + mk.PREFIXO + "/cancelados-tratar', {credentials:'same-origin'})") && pg.includes("fetch('" + mk.PREFIXO + "/cancelados-tratar?preparar='") && pg.includes("fetch('" + mk.PREFIXO + "/cancelados-tratar?resolver='"), pasta + ': o aviso chama a rota DESTA empresa');
    assert.ok(pg.includes("empresa: '" + mk.EMPRESA + "', emitir: true });\n    const res = (tb && tb.resultado) || {};") && pg.includes('<div id="cancMkt" style="display:none') && pg.includes('  checarCancMkt();   /* 26/11'), pasta + ': a caixa, a chamada ao saber quem é admin e a empresa certa na ponte');
  }
  _chegou = true;
  console.log('ok — aviso das vendas canceladas antes da postagem (checkout): só o admin vê; cancelar até 24 h, devolução depois; "já tratei" passa pelo servidor; a Toolbox só é chamada depois de o servidor conferir, e só devolução emitida move o pedido; nas três empresas');
})().catch((e) => { console.error(e); process.exit(1); });
