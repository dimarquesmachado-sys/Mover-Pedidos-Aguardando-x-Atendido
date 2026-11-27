'use strict';
/* 27/11 — O AVISO NO CHECKOUT DO PEDIDO QUE O BLING JÁ CANCELOU COM A NOTA VALENDO (painel-galpao.html, trecho CANCBLG).
   O dono: "no bling tao canceladas sim, logo nao tao no checkout. mas aih q mora o perigo, as nf foram geradas e tao lá",
   e "se nao der cancelar 24h da emissao, gera a nf devolução".

   O que se prova, rodando o trecho de produção do painel num navegador de mentira:
   A. só o admin vê; cada pedido diz o que cabe (cancelar / devolução / não sei a data) com os botões certos; resposta
      "não ok" não esconde o que está na tela; lista vazia esconde; a consulta acompanha a do aviso de cima;
   B. "já cancelei": confirma, chama o servidor (POST) e mostra o que ele respondeu; sem clique em dobro;
   C. "NÃO FOI ENVIADO": no TikTok o servidor confere (a tela não pergunta e não manda conferi); nos outros a tela PERGUNTA,
      e só com o sim do admin manda &conferi=sim — no preparar E no resolver; sem o sim, nada é chamado;
   D. "Gerar devolução (Toolbox)": sem a Toolbox não chama nada; o servidor prepara e só então a Toolbox é chamada, com o
      que o servidor deu; só devolução EMITIDA dá baixa; "já existe", rascunho, sem resposta e não logado NÃO dão;
   E. o painel de cada empresa leva o aviso, com o prefixo e a empresa DELA. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const html = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'painel', 'painel-galpao.html'), 'utf8');
const INI = '/* ══ CANCMKT-INICIO ══', MEIO = '/* ── CANCBLG ──', FIM = '/* ══ CANCMKT-FIM ══ */\n';
const i0 = html.indexOf(INI), iM = html.indexOf(MEIO), i1 = html.indexOf(FIM);
assert.ok(i0 > 0 && iM > i0 && i1 > iM, 'o trecho do aviso dos cancelados no Bling não está no painel (dentro do bloco dos cancelados)');
assert.ok(/<div id="cancBling" style="display:none/.test(html), 'a caixa do aviso não está no painel (escondida até ter o que mostrar)');
const DICA = (() => { const i = html.indexOf('function _nfaDicaSessao(erro){'); assert.ok(i > 0, 'falta a dica da sessão'); return html.slice(i, html.indexOf('\n}\n', i) + 3); })();
const AJUDA = DICA + ['function _nfaLimpo(v){', 'function _nfaHoras(h){'].map((ini) => { const i = html.indexOf(ini); assert.ok(i > 0, 'falta ' + ini); return html.slice(i, html.indexOf('\n', i) + 1); }).join('');
const BLOCO = AJUDA + html.slice(i0, i1 + FIM.length).split('{{PREFIXO}}').join('/emp').split('{{EMPRESA}}').join('empresa-x');

function nav(op) {
  op = op || {};
  const el = { style: { display: 'none' }, innerHTML: '' };
  const obs = { buscas: [], toasts: [], confirma: [], intervalos: [], ponte: [], vivas: 0 };
  const cx = { el, obs, admin: op.admin !== false, lista: op.lista, resolver: op.resolver === undefined ? { ok: true } : op.resolver, preparar: op.preparar,
    confirma: op.confirma === undefined ? () => true : op.confirma, viva: op.viva !== false, ponte: op.ponte, rede: false, segura: null };
  const f = new Function('document', 'fetch', 'setInterval', 'souAdmin', 'confirm', 'toast', '_nfaPonteViva', '_nfaPedirDevolucao', 'carregarLista',
    BLOCO + '\nreturn { checarCancMkt, checarCancBling, resolverCancBling, gerarDevolucaoCancBling };')(
    { getElementById: (id) => (id === 'cancBling' && !op.semEl ? el : null) },   /* a caixa do aviso de cima não existe aqui: ele não consulta nada */
    async (u, o) => {
      obs.buscas.push(u); assert.deepStrictEqual(o, /resolver=/.test(u) ? { method: 'POST', credentials: 'same-origin' } : { credentials: 'same-origin' }, 'quem grava é POST: ' + u);
      if (cx.rede) throw new Error('rede');
      if (cx.segura && /resolver=/.test(u)) await cx.segura;
      const resp = /resolver=/.test(u) ? cx.resolver : (/preparar=/.test(u) ? cx.preparar : cx.lista);
      return { json: async () => { if (resp === 'TORTO') throw new Error('json'); return resp; } };
    },
    (fn, ms) => obs.intervalos.push(ms), () => cx.admin, (m) => { obs.confirma.push(m); return cx.confirma(m); }, (m, ms) => obs.toasts.push([m, ms]),
    async () => { obs.vivas++; return cx.viva; }, async (payload) => { obs.ponte.push(payload); return typeof cx.ponte === 'function' ? cx.ponte(payload) : cx.ponte; }, async () => { throw new Error('este aviso não mexe na fila'); });
  cx.f = f;
  return cx;
}
const P = (extra) => Object.assign({ pedido_id: '27521125832', numero: 125573, numero_loja: '2000019794674158', marketplace: 'ml', marketplace_nome: 'Mercado Livre', data: '2026-11-26', nf_numero: '131189', nfe_id: '27521126164', horas_desde_a_emissao: 18.9, acao: 'cancelar', prova_local: true, confirmacao: 'admin' }, extra || {});
const LISTA = { ok: true, total: 4, pendentes: [P(),
  P({ pedido_id: '22', numero: 2002, numero_loja: '2000016244737117', nf_numero: '131099', nfe_id: '9022', horas_desde_a_emissao: 58.9, acao: 'devolucao' }),
  P({ pedido_id: '33', numero: 2003, numero_loja: 'TK-33', marketplace: 'tiktok', marketplace_nome: 'TikTok', nf_numero: '131000', nfe_id: '9033', horas_desde_a_emissao: 200, acao: 'devolucao', confirmacao: 'tiktok' }),
  P({ pedido_id: '44', numero: 2004, numero_loja: 'SH44', marketplace: 'shopee', marketplace_nome: 'Shopee', nf_numero: '130500', nfe_id: null, horas_desde_a_emissao: null, acao: null, prova_local: false })] };
const tique = () => new Promise((r) => setImmediate(r));

let _chegou = false;
process.on('exit', (c) => { if (c === 0 && !_chegou) { console.error('o teste parou no meio (promessa que nunca resolveu)'); process.exitCode = 1; } });
(async () => {
  /* ═══ A. a lista ═══ */
  let n = nav({ lista: LISTA });
  assert.deepStrictEqual(n.obs.intervalos, [5 * 60000], 'um relógio só: a consulta acompanha a do aviso de cima');
  await n.f.checarCancMkt(); await tique();
  assert.deepStrictEqual([n.el.style.display, n.obs.buscas], ['', ['/emp/cancelados-bling']], 'o aviso de cima chama este junto');
  n = nav({ lista: LISTA }); await n.f.checarCancBling();
  const h = n.el.innerHTML, linhas = h.split('<div style="margin-top:6px">').slice(1);
  assert.ok(/^<b>🚫 4 pedidos que o Bling já CANCELOU com a nota de venda ainda VALENDO<\/b> — não estão mais na fila/.test(h));
  assert.strictEqual(linhas.length, 4);
  /* cancelar (até 24 h): só "já cancelei" */
  assert.ok(linhas[0].includes('href="https://www.bling.com.br/vendas.php#edit/27521125832"') && linhas[0].includes('<b>Pedido 125573</b>') && linhas[0].includes('href="https://www.bling.com.br/notas.fiscais.php#edit/27521126164"') && linhas[0].includes('<b>NF 131189</b>'));
  assert.ok(linhas[0].includes('Mercado Livre <a href="https://vendedores.mercadolivre.com.br/vendas/2000019794674158/detalhe"') && linhas[0].includes('<b>CANCELAR a nota</b> no Bling (emitida há 18,9 h'));
  assert.deepStrictEqual((linhas[0].match(/onclick="[^"]+"/g) || []), ['onclick="resolverCancBling(\'27521125832\',\'125573\',\'cancelada\')"']);
  /* devolução (passou das 24 h): gerar, já gerei, já cancelei */
  assert.ok(linhas[1].includes('<b>NF de DEVOLUÇÃO</b> (emitida há 2 dias') && linhas[1].includes('confira no Mercado Livre que a venda foi cancelada <b>sem envio</b>'));
  assert.deepStrictEqual((linhas[1].match(/onclick="[^"]+"/g) || []), ['onclick="gerarDevolucaoCancBling(\'22\',\'2002\',\'131099\')"', 'onclick="resolverCancBling(\'22\',\'2002\',\'devolvida\')"', 'onclick="resolverCancBling(\'22\',\'2002\',\'cancelada\')"']);
  /* TikTok: o servidor confere — a tela não manda conferir; o número da venda não vira link */
  assert.ok(linhas[2].includes(' · TikTok TK-33 · ') && !/sem envio/.test(linhas[2]) && !/mercadolivre/.test(linhas[2]));
  /* sem data: os dois manuais; sem id da nota: sem link; pedido antigo: avisa */
  assert.ok(linhas[3].includes('não sei quando foi emitida') && linhas[3].includes(': cancelar') && linhas[3].includes('<b>NF 130500</b>') && !/notas\.fiscais/.test(linhas[3]) && linhas[3].includes('pedido antigo: não tenho mais o registro de bipagem'));
  assert.deepStrictEqual((linhas[3].match(/onclick="[^"]+"/g) || []).map((x) => /Canc\w+\('44','2004','(\w+)'/.exec(x)[1]), ['cancelada', 'devolvida']);
  assert.ok(!/pedido antigo/.test(linhas[0]) && /Se a devolução dessa nota já foi feita por fora/.test(h));
  /* um só: singular */
  n = nav({ lista: { ok: true, pendentes: [P()] } }); await n.f.checarCancBling(); assert.ok(/^<b>🚫 1 pedido que o Bling já CANCELOU com a nota de venda ainda VALENDO<\/b> — não está mais na fila/.test(n.el.innerHTML));
  /* mais de 10: mostra 10 e diz quantos faltam */
  n = nav({ lista: { ok: true, pendentes: Array.from({ length: 13 }, (_, i) => P({ pedido_id: String(100 + i), numero: 100 + i })) } }); await n.f.checarCancBling();
  assert.deepStrictEqual([n.el.innerHTML.split('<b>Pedido ').length - 1, /… e mais 3\./.test(n.el.innerHTML)], [10, true]);
  /* texto do servidor entra limpo */
  n = nav({ lista: { ok: true, pendentes: [P({ numero: '1<img src=x onerror=alert(1)>', nf_numero: '"><script>', numero_loja: "5');alert('x", marketplace_nome: '<b>X</b>', pedido_id: "9');alert('1" })] } }); await n.f.checarCancBling();
  assert.ok(!/<img|<script|alert\('|<b>X/.test(n.el.innerHTML), 'nada do servidor vira HTML nem código');
  /* estoquista: nem consulta, e a caixa some */
  n = nav({ lista: LISTA, admin: false }); n.el.style.display = ''; n.el.innerHTML = 'x'; await n.f.checarCancBling(); assert.deepStrictEqual([n.el.style.display, n.el.innerHTML, n.obs.buscas], ['none', '', []]);
  /* deixou de ser admin enquanto a consulta ia */
  n = nav({ lista: LISTA }); const pa = n.f.checarCancBling(); n.admin = false; await pa; assert.strictEqual(n.el.style.display, 'none');
  /* lista vazia esconde; "não ok", torta e rede caída NÃO escondem o que está na tela */
  n = nav({ lista: LISTA }); await n.f.checarCancBling(); n.lista = { ok: true, pendentes: [] }; await n.f.checarCancBling(); assert.deepStrictEqual([n.el.style.display, n.el.innerHTML], ['none', '']);
  for (const ruim of [{ ok: false, etapa: 'registro', pendentes: [] }, { ok: true }, null, 'TORTO', { ok: true, pendentes: 'x' }]) { n = nav({ lista: LISTA }); await n.f.checarCancBling(); const antes = n.el.innerHTML; n.lista = ruim; await n.f.checarCancBling(); assert.deepStrictEqual([n.el.style.display, n.el.innerHTML === antes], ['', true], JSON.stringify(ruim)); }
  n = nav({ lista: LISTA }); await n.f.checarCancBling(); n.rede = true; await n.f.checarCancBling(); assert.strictEqual(n.el.style.display, '');
  n = nav({ lista: LISTA, semEl: true }); await n.f.checarCancBling(); assert.deepStrictEqual(n.obs.buscas, [], 'sem a caixa na página, não consulta');

  /* ═══ B. "já cancelei" ═══ */
  n = nav({ lista: LISTA }); await n.f.checarCancBling(); n.obs.buscas.length = 0;
  await n.f.resolverCancBling('27521125832', '125573', 'cancelada');
  assert.deepStrictEqual([n.obs.confirma.length, /a nota já foi CANCELADA no Bling\?/.test(n.obs.confirma[0]), /sai deste aviso/.test(n.obs.confirma[0])], [1, true, true], 'cancelada não pergunta do marketplace');
  assert.deepStrictEqual([n.obs.buscas, n.obs.toasts], [['/emp/cancelados-bling?resolver=27521125832&como=cancelada&confirma=sim', '/emp/cancelados-bling'], [['✓ pedido 125573: nota tratada — saiu do aviso', 7000]]]);
  /* o servidor recusa: mostra o motivo dele */
  n = nav({ lista: LISTA, resolver: { ok: false, etapa: 'nao_cancelada', erro: 'a nota 131189 ainda NÃO aparece cancelada no Bling' } }); await n.f.checarCancBling(); await n.f.resolverCancBling('27521125832', '125573', 'cancelada');
  assert.deepStrictEqual(n.obs.toasts, [['⚠️ pedido 125573: a nota 131189 ainda NÃO aparece cancelada no Bling', 12000]]);
  for (const [resp, msg] of [[null, 'sem resposta do servidor — tente de novo'], ['TORTO', 'sem resposta do servidor — tente de novo'], [{ ok: false }, 'sem resposta'], [{ ok: 'sim' }, 'sem resposta']]) { n = nav({ lista: LISTA, resolver: resp }); await n.f.resolverCancBling('1', '10', 'cancelada'); assert.deepStrictEqual(n.obs.toasts, [['⚠️ pedido 10: ' + msg, 12000]], JSON.stringify(resp)); }
  n = nav({ lista: LISTA }); n.rede = true; await n.f.resolverCancBling('1', '10', 'cancelada'); assert.deepStrictEqual(n.obs.toasts, [['⚠️ pedido 10: falha de comunicação — tente de novo', 12000]]);
  /* não confirmou / estoquista: nada */
  n = nav({ lista: LISTA, confirma: () => false }); await n.f.resolverCancBling('1', '10', 'cancelada'); assert.deepStrictEqual([n.obs.buscas, n.obs.toasts], [[], []]);
  n = nav({ lista: LISTA, admin: false }); await n.f.resolverCancBling('1', '10', 'cancelada'); assert.deepStrictEqual([n.obs.buscas, n.obs.confirma], [[], []]);
  /* clique em dobro: um só vai */
  { n = nav({ lista: LISTA }); let solta; n.segura = new Promise((ok) => { solta = ok; }); const a1 = n.f.resolverCancBling('1', '10', 'cancelada'); await tique(); const a2 = n.f.resolverCancBling('1', '10', 'cancelada'); for (let i = 0; i < 4; i++) await tique();
    assert.strictEqual(n.obs.buscas.filter((u) => /resolver=/.test(u)).length, 1); solta(); await a1; await a2; await n.f.resolverCancBling('1', '10', 'cancelada'); assert.strictEqual(n.obs.buscas.filter((u) => /resolver=/.test(u)).length, 2, 'depois de terminar, volta a aceitar'); }

  /* ═══ C. "não foi enviado" ═══ */
  /* TikTok (o servidor confere): "já gerei a devolução" não pergunta do marketplace e não manda conferi */
  n = nav({ lista: LISTA }); await n.f.checarCancBling(); n.obs.buscas.length = 0; await n.f.resolverCancBling('33', '2003', 'devolvida');
  assert.deepStrictEqual([n.obs.confirma.length, /DEVOLVIDA \(NF de devolução emitida\)/.test(n.obs.confirma[0]), n.obs.buscas[0]], [1, true, '/emp/cancelados-bling?resolver=33&como=devolvida&confirma=sim']);
  /* ML (quem confere é o admin): pergunta, e só com o sim manda conferi */
  n = nav({ lista: LISTA }); await n.f.checarCancBling(); n.obs.buscas.length = 0; await n.f.resolverCancBling('22', '2002', 'devolvida');
  assert.deepStrictEqual([n.obs.confirma.length, /você CONFERIU no Mercado Livre que essa venda foi cancelada SEM ENVIO/.test(n.obs.confirma[1]), /caso do Devoluções/.test(n.obs.confirma[1]), n.obs.buscas[0]], [2, true, true, '/emp/cancelados-bling?resolver=22&como=devolvida&confirma=sim&conferi=sim']);
  n = nav({ lista: LISTA, confirma: (m) => !/CONFERIU/.test(m) }); await n.f.checarCancBling(); n.obs.buscas.length = 0; await n.f.resolverCancBling('22', '2002', 'devolvida');
  assert.deepStrictEqual([n.obs.confirma.length, n.obs.buscas, n.obs.toasts], [2, [], []], 'sem o sim do admin, nada é chamado');
  /* pedido que a tela não conhece (lista ainda não carregou): trata como "o admin confere" */
  n = nav({ lista: LISTA }); await n.f.resolverCancBling('777', '7', 'devolvida'); assert.deepStrictEqual([n.obs.confirma.length, /no marketplace que/.test(n.obs.confirma[1]), /conferi=sim/.test(n.obs.buscas[0])], [2, true, true]);

  /* ═══ D. gerar a devolução pela Toolbox ═══ */
  const PREP = { ok: true, pedido_id: '22', nfe_id: '9022', numero: '131099', id_loja: '204', confirmacao: 'admin', ids_fiscais: { idEmpresaControl: '1', idNaturezaDevolucaoEntrada: '2' } };
  const OKTB = { ok: true, resultado: { idNotaDevolucao: 5550001, numero: '131700', emitida: true } };
  n = nav({ lista: LISTA, preparar: PREP, ponte: OKTB }); await n.f.checarCancBling(); n.obs.buscas.length = 0;
  await n.f.gerarDevolucaoCancBling('22', '2002', '131099');
  assert.deepStrictEqual([n.obs.confirma.length, /Gerar e EMITIR a NF de devolução da NF 131099 \(pedido 2002, já cancelado no Bling\)/.test(n.obs.confirma[0]), /CONFERIU no Mercado Livre/.test(n.obs.confirma[1])], [2, true, true]);
  assert.deepStrictEqual(n.obs.buscas, ['/emp/cancelados-bling?preparar=22&conferi=sim', '/emp/cancelados-bling?resolver=22&como=devolvida&confirma=sim&conferi=sim&devolucao_id=5550001&devolucao_numero=131700', '/emp/cancelados-bling']);
  assert.deepStrictEqual(n.obs.ponte, [{ empresa: 'empresa-x', idNFOriginal: '9022', idLoja: '204', idsFiscais: { idEmpresaControl: '1', idNaturezaDevolucaoEntrada: '2' }, emitir: true }]);
  assert.deepStrictEqual(n.obs.toasts[n.obs.toasts.length - 1], ['✓ NF de devolução 131700 emitida — pedido 2002 saiu do aviso', 12000]);
  /* TikTok: sem pergunta e sem conferi; sem loja e sem ids fiscais vai null */
  n = nav({ lista: LISTA, preparar: { ok: true, nfe_id: 9033 }, ponte: OKTB }); await n.f.checarCancBling(); n.obs.buscas.length = 0; await n.f.gerarDevolucaoCancBling('33', '2003', '131000');
  assert.deepStrictEqual([n.obs.confirma.length, n.obs.buscas[0], n.obs.buscas[1], n.obs.ponte[0]], [1, '/emp/cancelados-bling?preparar=33', '/emp/cancelados-bling?resolver=33&como=devolvida&confirma=sim&devolucao_id=5550001&devolucao_numero=131700', { empresa: 'empresa-x', idNFOriginal: '9033', idLoja: null, idsFiscais: null, emitir: true }]);
  /* o admin não confirmou o marketplace: nada */
  n = nav({ lista: LISTA, preparar: PREP, ponte: OKTB, confirma: (m) => !/CONFERIU/.test(m) }); await n.f.checarCancBling(); n.obs.buscas.length = 0; await n.f.gerarDevolucaoCancBling('22', '2002', '131099'); assert.deepStrictEqual([n.obs.buscas, n.obs.ponte, n.obs.vivas], [[], [], 0]);
  n = nav({ lista: LISTA, preparar: PREP, ponte: OKTB, confirma: () => false }); await n.f.gerarDevolucaoCancBling('22', '2002', '131099'); assert.deepStrictEqual([n.obs.confirma.length, n.obs.buscas, n.obs.ponte], [1, [], []]);
  n = nav({ lista: LISTA, preparar: PREP, ponte: OKTB, admin: false }); await n.f.gerarDevolucaoCancBling('22', '2002', '131099'); assert.deepStrictEqual([n.obs.confirma, n.obs.buscas], [[], []]);
  /* sem a Toolbox: não prepara nem chama */
  n = nav({ lista: LISTA, preparar: PREP, ponte: OKTB, viva: false }); await n.f.checarCancBling(); n.obs.buscas.length = 0; await n.f.gerarDevolucaoCancBling('33', '2003', '131000');
  assert.deepStrictEqual([n.obs.buscas, n.obs.ponte, /^⚠️ Toolbox não encontrada nesta página/.test(n.obs.toasts[0][0])], [['/emp/cancelados-bling'], [], true]);
  /* o servidor não preparou: a Toolbox não é chamada, e o motivo aparece */
  for (const [prep, msg] of [[{ ok: false, etapa: 'postado', erro: 'o TikTok mostra sinal de ENVIO' }, 'o TikTok mostra sinal de ENVIO'], [{ ok: true }, 'sem resposta do servidor — tente de novo'], [null, 'sem resposta do servidor — tente de novo'], ['TORTO', 'sem resposta do servidor — tente de novo']]) {
    n = nav({ lista: LISTA, preparar: prep, ponte: OKTB }); await n.f.checarCancBling(); await n.f.gerarDevolucaoCancBling('33', '2003', '131000');
    assert.deepStrictEqual([n.obs.ponte, n.obs.toasts[n.obs.toasts.length - 1], n.obs.buscas.some((u) => /resolver=/.test(u))], [[], ['⚠️ não gerei: ' + msg, 12000], false], JSON.stringify(prep)); }
  /* a devolução saiu mas a baixa falhou: diz, e manda tocar em "já gerei" */
  n = nav({ lista: LISTA, preparar: PREP, ponte: OKTB, resolver: { ok: false, erro: 'registro' } }); await n.f.checarCancBling(); await n.f.gerarDevolucaoCancBling('33', '2003', '131000');
  assert.deepStrictEqual(n.obs.toasts[n.obs.toasts.length - 1], ['✓ devolução 131700 emitida, mas não consegui dar baixa no aviso (registro) — toque em "já gerei a devolução"', 12000]);
  /* o que NÃO dá baixa */
  for (const [tb, re, ms] of [
    [{ ok: false, codigo: 'JA_EXISTE', idNotaDevolucao: 7, numero: '9' }, /^⚠️ NF 131000: o Bling já tem uma devolução dessa nota/, 20000],
    [{ ok: false, codigo: 'RASCUNHO_CRIADO', idNotaDevolucao: 7, numero: '131701', erro: 'SEFAZ fora' }, /^⚠️ a NF de devolução 131701 foi CRIADA no Bling mas não emitiu.*SEFAZ fora$/, 20000],
    [{ ok: true, resultado: { idNotaDevolucao: 8, numero: '', emitida: false } }, /^⚠️ a NF de devolução 8 foi CRIADA no Bling mas não emitiu/, 20000],
    [{ ok: false, codigo: 'TIMEOUT' }, /^⚠️ NF 131000: a Toolbox não respondeu a tempo — a devolução PODE ter sido criada/, 20000],
    [{ ok: false, codigo: 'NAO_LOGADO' }, /^⚠️ NF 131000: o Bling não está logado neste navegador/, 12000],
    [{ ok: false, erro: 'Nao consegui os IDs fiscais da empresa: sessao invalida ou expirada' }, /^⚠️ não gerei a devolução da NF 131000: Nao consegui os IDs fiscais.*DEVOLUÇÕES/, 20000],
    [{ ok: false, codigo: 'OUTRO' }, /^⚠️ não gerei a devolução da NF 131000: erro desconhecido$/, 20000],
    [null, /^⚠️ não gerei a devolução da NF 131000: erro desconhecido$/, 20000]]) {
    n = nav({ lista: LISTA, preparar: PREP, ponte: tb }); await n.f.checarCancBling(); await n.f.gerarDevolucaoCancBling('33', '2003', '131000');
    const ult = n.obs.toasts[n.obs.toasts.length - 1];
    assert.ok(re.test(ult[0]) && ult[1] === ms, JSON.stringify(tb) + ' → ' + JSON.stringify(ult));
    assert.strictEqual(n.obs.buscas.some((u) => /resolver=/.test(u)), false, 'não dá baixa: ' + JSON.stringify(tb));
  }
  /* clique em dobro no gerar: uma ida à Toolbox */
  { let solta; n = nav({ lista: LISTA, preparar: PREP, ponte: () => new Promise((ok) => { solta = () => ok(OKTB); }) }); await n.f.checarCancBling(); const g1 = n.f.gerarDevolucaoCancBling('33', '2003', '131000'); for (let i = 0; i < 6; i++) await tique();
    const g2 = n.f.gerarDevolucaoCancBling('33', '2003', '131000'), g3 = n.f.resolverCancBling('33', '2003', 'cancelada'); for (let i = 0; i < 6; i++) await tique();
    assert.deepStrictEqual([n.obs.ponte.length, n.obs.confirma.length], [1, 1]); const soltar = solta; soltar(); await g1; await g2; await g3; }
  /* a trava deste aviso não prende o de cima (mesmo id nos dois) */
  assert.ok(html.slice(iM, i1).includes("const trava = 'bling:' + pid;"));

  /* ═══ E. o painel de cada empresa ═══ */
  const Pn = require('../lib/checkout/painel/painel-galpao');
  for (const pasta of ['girassol-backup-offline', 'amb-checkout-offline', 'good-checkout-offline']) {
    const mk = require(path.join(raiz, pasta, 'painel-marca.js'));
    const pg = Pn.renderizar(mk);
    assert.ok(pg.includes("fetch('" + mk.PREFIXO + "/cancelados-bling', {credentials:'same-origin'})") && pg.includes("fetch('" + mk.PREFIXO + "/cancelados-bling?' + qs,"), pasta + ': o aviso chama a rota DESTA empresa');
    assert.ok(pg.includes("_nfaPedirDevolucao({ empresa: '" + mk.EMPRESA + "', idNFOriginal: String(pronto.nfe_id)") && pg.includes('<div id="cancBling" style="display:none') && pg.includes('  checarCancBling();   /* 27/11'), pasta + ': a caixa, a chamada e a empresa certa na ponte');
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(pg.slice(pg.indexOf(MEIO), pg.indexOf(FIM))), pasta + ': sobrou marcador sem trocar');
  }
  assert.ok(html.split('\n').length < 3000, 'o painel passou do teto de ~3.000 linhas — modularizar antes de crescer');
  _chegou = true;
  console.log('ok — aviso do pedido cancelado no Bling com a NF valendo (checkout): só o admin vê; cancelar até 24 h, devolução depois; onde o servidor não lê o marketplace a tela pergunta ao admin se não foi enviado; a Toolbox só é chamada depois de o servidor conferir, e só devolução emitida dá baixa; nas três empresas');
})().catch((e) => { console.error(e); process.exit(1); });
