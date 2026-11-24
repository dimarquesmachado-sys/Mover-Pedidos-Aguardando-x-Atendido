'use strict';
/* 24/11 — OAUTH DO BLING: O CÓDIGO DE AUTORIZAÇÃO VAI AO BLING UMA VEZ SÓ.
   O caso: o dono reautorizou o app da AMB pelo celular; o token nasceu e em minutos o Bling o recusava. A página do
   callback ficava com o código no endereço e o reenviava a cada carga (aba recarregada, botão voltar) — e código usado
   duas vezes faz o Bling revogar o token recém-criado.

   O que se prova (o código de produção):
   A. a peça (lib/fiscal/oauth-codigo-uma-vez): a 1ª vez troca; a mesma vez seguinte (durante a troca ou depois, certo ou
      errado) devolve o resultado da primeira sem trocar de novo; código diferente troca; recibo só de troca que deu
      certo; a memória é curta (expira e tem teto);
   B. as ROTAS de verdade (lib/fiscal/criar-modulo), com os três prefixos ('' da Girassol, /amb, /good): o callback com
      código redireciona pra um endereço SEM código; recarregar o endereço com código não chama o Bling de novo; a página
      de feito mostra o ✅ só com recibo de verdade; o erro não reenvia; /setup e /callback dividem a mesma memória; o
      app das NFs tem a sua. */
const assert = require('assert');
const { criarCodigoUmaVez } = require('../lib/fiscal/oauth-codigo-uma-vez');
const { criarModuloFiscal } = require('../lib/fiscal/criar-modulo');

process.exitCode = 1;
let terminou = false;
process.on('exit', () => { if (!terminou) { console.log('FALHOU: o teste não chegou ao fim (promessa presa)'); process.exitCode = 1; } });

(async () => {
  /* ═══ A. a peça ═══ */
  {
    assert.throws(() => criarCodigoUmaVez({}), /falta `trocar`/);
    const idas = []; let soltar = null, falhar = null;
    const u = criarCodigoUmaVez({ trocar: (c) => { idas.push(c); if (falhar) return Promise.reject(new Error(falhar)); return new Promise((ok) => { soltar = ok; }); } });
    /* duas cargas da mesma página AO MESMO TEMPO: uma troca só */
    const p1 = u.tratar('cod-1'), p2 = u.tratar('cod-1');
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(idas, ['cod-1'], 'a segunda carga não vai ao Bling enquanto a primeira troca');
    soltar();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.deepStrictEqual([r1.ok, r1.repetido, r1.erro, r2.ok, r2.repetido, r2.recibo === r1.recibo, /^[0-9a-f]{18}$/.test(r1.recibo)], [true, false, null, true, true, true, true], JSON.stringify([r1, r2]));
    /* a página recarregada depois: o mesmo resultado, sem trocar */
    const r3 = await u.tratar('cod-1');
    assert.deepStrictEqual([idas.length, r3.ok, r3.repetido, r3.recibo], [1, true, true, r1.recibo]);
    assert.ok(u.recibo(r1.recibo) && !u.recibo('outro') && !u.recibo('') && !u.recibo(null) && !u.recibo(undefined), 'recibo só o da troca que deu certo');
    assert.ok(!JSON.stringify([r1, r3]).includes('cod-1'), 'o código não volta no resultado');
    /* código que FALHOU também não é reenviado */
    falhar = 'Bling recusou';
    const f1 = await u.tratar('cod-2'), f2 = await u.tratar('cod-2');
    assert.deepStrictEqual([idas, f1.ok, f1.erro, f1.recibo, f1.repetido, f2.ok, f2.erro, f2.repetido], [['cod-1', 'cod-2'], false, 'Bling recusou', null, false, false, 'Bling recusou', true]);
    /* `trocar` que lança na hora (não devolve promessa) vira erro, não derruba */
    const u2 = criarCodigoUmaVez({ trocar: () => { throw new Error('caiu'); } });
    assert.deepStrictEqual(await u2.tratar('x'), { ok: false, recibo: null, erro: 'caiu', repetido: false });
    /* sem código: erro, sem chamar */
    for (const v of ['', null, undefined]) assert.deepStrictEqual([(await u.tratar(v)).ok, idas.length], [false, 2]);
    /* código novo troca de novo */
    falhar = null; const p4 = u.tratar('cod-3'); await new Promise((r) => setImmediate(r)); soltar(); const r4 = await p4;
    assert.deepStrictEqual([idas.length, r4.ok, r4.recibo !== r1.recibo], [3, true, true]);
    /* a memória é curta: passa a validade, o recibo deixa de valer; e há teto de códigos guardados */
    let t = 1000; const idas3 = [];
    const u3 = criarCodigoUmaVez({ trocar: async (c) => { idas3.push(c); }, agora: () => t, validadeMs: 100, maximo: 3 });
    const a = await u3.tratar('a'); t += 100; assert.strictEqual(u3.recibo(a.recibo), true, 'no limite da validade ainda vale');
    t += 1; assert.strictEqual(u3.recibo(a.recibo), false, 'passou a validade');
    const rs = []; for (const c of ['b', 'c', 'd', 'e']) rs.push(await u3.tratar(c));
    assert.deepStrictEqual([u3.recibo(rs[0].recibo), u3.recibo(rs[1].recibo), u3.recibo(rs[3].recibo)], [false, true, true], 'o teto tira o mais antigo');
    await u3.tratar('e'); assert.deepStrictEqual(idas3, ['a', 'b', 'c', 'd', 'e'], 'dentro da memória, o repetido não troca');
  }

  /* ═══ B. as rotas de verdade ═══ */
  const PECAS = ['rotinaExpediente', 'rotinaVirada', 'rotinaManha', 'corrigirNFsPendentes', 'retryNFManual', 'getEstadoRetrySEFAZ', 'garantirToken', 'gerarTokenInicial', 'gerarTokenInicialNF',
    'garantirTokenNF', 'garantirTokenML', 'trocarCodigoPorToken', 'gerarUrlAutorizacao', 'getPedidoDetalhe', 'rotinaNFeML', 'enviarNFeUnica'];
  for (const [id, prefixo, rotulo] of [['girassol', '', 'Girassol'], ['amb', '/amb', 'AMB'], ['good', '/good', 'GOOD']]) {
    const idas = { bling: [], nf: [] }; let erro = null;
    const pecas = Object.fromEntries(PECAS.map((p) => [p, async () => {}]));
    pecas.gerarTokenInicial = async (c) => { idas.bling.push(c); if (erro) throw new Error(erro); return { ok: true }; };
    pecas.gerarTokenInicialNF = async (c) => { idas.nf.push(c); if (erro) throw new Error(erro); return { ok: true }; };
    const mod = criarModuloFiscal({ id, nome: rotulo, prefixo, rotulo, crons: {}, pecas });
    let corpo = {};
    const rota = mod.routes(async () => corpo);
    const pedir = async (metodo, caminho) => {
      const u = new URL('http://h' + caminho); const saida = { code: null, cab: {}, body: '' };
      const res = { writeHead(c, h) { saida.code = c; saida.cab = h || {}; }, end(b) { saida.body = String(b == null ? '' : b); } };
      const t = await rota({ method: metodo, headers: {} }, res, u);
      assert.strictEqual(t, true, metodo + ' ' + caminho + ' tem que ser tratado');
      return saida;
    };
    for (const [sufixo, chave, nomeTela] of [['', 'bling', 'Token Bling obtido'], ['-nf', 'nf', 'Token Bling NF obtido']]) {
      const cb = prefixo + '/callback' + sufixo, lista = idas[chave];
      /* a volta do Bling: troca UMA vez e redireciona pra um endereço SEM código */
      const r1 = await pedir('GET', cb + '?code=COD-' + id + sufixo + '&state=1');
      assert.deepStrictEqual([r1.code, lista, /^[^?]+\?feito=[0-9a-f]{18}$/.test(r1.cab.Location), r1.cab.Location.startsWith(cb + '?feito='), /COD-/.test(r1.cab.Location + r1.body)], [302, ['COD-' + id + sufixo], true, true, false], id + sufixo + ': ' + JSON.stringify(r1));
      /* a aba recarregada / o botão voltar: o MESMO endereço com código não vai ao Bling de novo */
      const r2 = await pedir('GET', cb + '?code=COD-' + id + sufixo + '&state=1');
      assert.deepStrictEqual([r2.code, r2.cab.Location, lista.length], [302, r1.cab.Location, 1], id + sufixo + ': recarregar não reenvia o código');
      /* a página de feito: o ✅ só com recibo de verdade; pode recarregar à vontade */
      for (let n = 0; n < 2; n++) { const rf = await pedir('GET', r1.cab.Location); assert.ok(rf.code === 200 && rf.body.includes('✅ ' + rotulo + ': ' + nomeTela + '. Pode fechar.') && lista.length === 1, id + sufixo + ': ' + rf.body); }
      for (const falso of ['abc', '', r1.cab.Location.split('=')[1].slice(0, 17)]) { const rx = await pedir('GET', cb + '?feito=' + falso); assert.ok(rx.code === 200 && !/✅|obtido/.test(rx.body) && /nenhuma autorização recente/.test(rx.body) && lista.length === 1, id + sufixo + ': recibo falso não mostra ✅: ' + rx.body); }
      /* /setup com o MESMO código (colado à mão) também não reenvia; e responde o resultado da primeira */
      corpo = { auth_code: 'COD-' + id + sufixo };
      const rs = await pedir('POST', prefixo + '/setup' + sufixo);
      assert.deepStrictEqual([rs.code, JSON.parse(rs.body).ok, lista.length], [200, true, 1], id + sufixo + ': /setup e /callback dividem a memória');
      corpo = { auth_code: 'NOVO-' + id + sufixo };
      const rn = await pedir('POST', prefixo + '/setup' + sufixo);
      assert.deepStrictEqual([rn.code, JSON.parse(rn.body), lista], [200, { ok: true, message: rotulo + (sufixo ? ': Tokens Bling NF gerados ✓' : ': Tokens Bling gerados ✓') }, ['COD-' + id + sufixo, 'NOVO-' + id + sufixo]]);
      for (const vazio of [{}, null, { auth_code: '' }]) { corpo = vazio; const rv = await pedir('POST', prefixo + '/setup' + sufixo); assert.deepStrictEqual([rv.code, JSON.parse(rv.body), lista.length], [400, { ok: false, error: 'auth_code obrigatório' }, 2]); }
      /* o erro: mostra a mensagem (sem pedaço de credencial) e NÃO reenvia o código na recarga */
      erro = 'OAuth HTTP 400 {"access_token":"SEGREDO123456"}';
      const e1 = await pedir('GET', cb + '?code=RUIM-' + id + sufixo), e2 = await pedir('GET', cb + '?code=RUIM-' + id + sufixo);
      assert.deepStrictEqual([e1.code, e2.code, lista.length, e1.body === e2.body, /SEGREDO123456|RUIM-/.test(e1.body), /❌ /.test(e1.body) && /Erro: OAuth HTTP 400/.test(e1.body) && /não é enviado de novo/.test(e1.body)], [500, 500, 3, true, false, true], id + sufixo + ': ' + e1.body);
      corpo = { auth_code: 'RUIM-' + id + sufixo };
      const es = await pedir('POST', prefixo + '/setup' + sufixo);
      assert.deepStrictEqual([es.code, JSON.parse(es.body).ok, lista.length], [400, false, 3]);
      erro = null;
      /* sem código e sem recibo: como sempre */
      const r0 = await pedir('GET', cb);
      assert.ok(r0.code === 400 && /Código não encontrado/.test(r0.body) && lista.length === 3);
    }
    /* os dois apps (pedidos e NFs) não dividem memória: o mesmo texto de código troca em cada um */
    const antes = [idas.bling.length, idas.nf.length];
    await pedir('GET', prefixo + '/callback?code=IGUAL'); await pedir('GET', prefixo + '/callback-nf?code=IGUAL');
    assert.deepStrictEqual([idas.bling.length, idas.nf.length], [antes[0] + 1, antes[1] + 1], id + ': cada app com a sua memória');
    /* o recibo de um não vale no outro */
    const rb = await pedir('GET', prefixo + '/callback?code=IGUAL');
    const rcruz = await pedir('GET', prefixo + '/callback-nf?feito=' + rb.cab.Location.split('=')[1]);
    assert.ok(!/✅/.test(rcruz.body), id + ': recibo dos pedidos não vale na página das NFs');
  }
  terminou = true; process.exitCode = 0;
  console.log('ok — OAuth do Bling, o código de autorização vai ao Bling uma vez só: carga dupla, aba recarregada e botão voltar não reenviam o código; o sucesso redireciona pra endereço sem código; o ✅ só com recibo de verdade; o erro não reenvia; /setup e /callback dividem a memória; pedidos e NFs separados — nas três empresas');
})().catch((e) => { console.log('FALHOU: ' + (e && e.stack || e)); terminou = true; process.exitCode = 1; });
