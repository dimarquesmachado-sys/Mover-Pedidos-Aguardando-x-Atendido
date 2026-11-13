'use strict';
/* 12/11 (Codex #854) — "ESTA nota está em Consultar situação?" pela data de emissão DELA (lib/fiscal/nf-bling-api,
   nfEstaEmConsulta). A lista "da janela" só cobre os últimos dias e tem teto de páginas; a ausência nela não prova nada
   sobre nota mais antiga. A função de PRODUÇÃO, com o Bling de mentira:
   · pergunta com o filtro situacao=10 numa janela FOLGADA em volta do dia de emissão (véspera → dois dias depois);
   · achou → true; o dia foi lido inteiro (página incompleta) e ela não está → false;
   · bateu no teto de páginas sem terminar, ou não há data → null ("não sei" nunca vira "não está"). */
const assert = require('assert');
const urls = []; let responder = () => [];
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true,
  exports: async (u) => { urls.push(String(u)); const data = responder(String(u)); return { ok: true, status: 200, json: async () => ({ data }), text: async () => JSON.stringify({ data }) }; } };
process.env.T_NF_PAUSA = '0';
const { criarNfBlingApi } = require('../lib/fiscal/nf-bling-api');
const fs = require('fs'), os = require('os'), path = require('path');
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-consulta-'));
const api = criarNfBlingApi({ rotulo: 'T', nfTokenManager: { garantirTokenNF: async () => 't', renovarTokenNF: async () => 't' }, envPausa: 'T_NF_PAUSA', envIntermediadorCnpj: 'T_IC', envIntermediadorNome: 'T_IN', intermediadorCnpj: '03007331000141', intermediadorNome: 'T', pastaCacheIE: pasta });
const cheia = (base) => Array.from({ length: 100 }, (_, i) => ({ id: base + i }));

(async () => {
  /* achou na 1ª página */
  responder = () => [{ id: 111 }, { id: 27382395982 }];
  assert.strictEqual(await api.nfEstaEmConsulta('t', '27382395982', '2026-11-11 21:35:03'), true);
  /* 12/11 (caso real: notas de 11/11 às 21h NÃO achadas com inicial = final = 11/11): a janela vai FOLGADA — da véspera até
     dois dias depois — porque não sei como o Bling lê uma data final sem hora nem em que fuso compara; quem decide é o id */
  assert.ok(urls.length === 1 && /situacao=10/.test(urls[0]) && /dataEmissaoInicial=2026-11-10&dataEmissaoFinal=2026-11-13/.test(urls[0]) && /pagina=1/.test(urls[0]), 'a busca é o filtro 10 numa janela folgada em volta do dia de emissão: ' + urls[0]);
  /* a busca "só no dia" continua existindo, pedida de propósito, pro diagnóstico do teste do reenvio */
  urls.length = 0; assert.strictEqual(await api.nfEstaEmConsulta('t', '27382395982', '2026-11-11 21:35:03', { diaExato: true }), true);
  assert.ok(/dataEmissaoInicial=2026-11-11&dataEmissaoFinal=2026-11-11/.test(urls[0]), urls[0]);
  /* virada de mês e de ano na folga */
  urls.length = 0; await api.nfEstaEmConsulta('t', '27382395982', '2026-12-31 23:10:00');
  assert.ok(/dataEmissaoInicial=2026-12-30&dataEmissaoFinal=2027-01-02/.test(urls[0]), urls[0]);
  /* nota ANTIGA (fora de qualquer janela): a busca é no dia dela */
  urls.length = 0; responder = () => [{ id: 5 }];
  assert.strictEqual(await api.nfEstaEmConsulta('t', 5, '2026-06-10 13:25:50'), true);
  assert.ok(/dataEmissaoInicial=2026-06-09&dataEmissaoFinal=2026-06-12/.test(urls[0]), 'nota de meses atrás é procurada em volta do dia dela: ' + urls[0]);
  /* o dia foi lido inteiro e ela não está */
  urls.length = 0; responder = () => [{ id: 1 }, { id: 2 }];
  assert.strictEqual(await api.nfEstaEmConsulta('t', 999, '2026-11-11'), false);
  /* está na 2ª página */
  urls.length = 0; responder = (u) => (/pagina=1(&|$)/.test(u) ? cheia(1000) : [{ id: 777 }]);
  assert.strictEqual(await api.nfEstaEmConsulta('t', 777, '2026-11-11'), true); assert.strictEqual(urls.length, 2);
  /* todas as páginas cheias até o teto, sem achar: NÃO SEI (não "não está") */
  urls.length = 0; responder = (u) => cheia(Number((/pagina=(\d+)/.exec(u) || [])[1]) * 1000);
  assert.strictEqual(await api.nfEstaEmConsulta('t', 5, '2026-11-11'), null, 'bateu no teto de páginas sem terminar: não dá pra afirmar que a nota não está');
  assert.ok(urls.length >= 2, 'tinha que ter lido várias páginas antes de desistir');
  /* sem data: não sei, e nem chama o Bling */
  urls.length = 0;
  assert.strictEqual(await api.nfEstaEmConsulta('t', 5, null), null); assert.strictEqual(await api.nfEstaEmConsulta('t', 5, 'ontem'), null); assert.strictEqual(await api.nfEstaEmConsulta('t', 5, '0000-00-00 00:00:00'), null, 'data impossível: não sei (e não estoura)'); assert.strictEqual(urls.length, 0);
  /* ── a MEDIÇÃO de como o Bling lê a data do filtro (medirFiltroDeData): três perguntas de leitura, e uma conclusão que só
     afirma o que os números mostram ── */
  { const agoraMs = Date.parse('2026-11-13T15:00:00Z');   /* 12:00 de 13/11 em Brasília */
    const nota = (quando) => ({ id: 1, dataEmissao: quando });
    const final = (u) => (/dataEmissaoFinal=(\d{4}-\d{2}-\d{2})/.exec(u) || [])[1], inicial = (u) => (/dataEmissaoInicial=(\d{4}-\d{2}-\d{2})/.exec(u) || [])[1];
    /* o Bling que NÃO devolve o dia da data final (final sem hora = meia-noite do começo do dia) */
    urls.length = 0; responder = (u) => [nota('2026-11-12 09:00:00'), nota('2026-11-12 22:10:00'), nota('2026-11-13 08:30:00'), nota('2026-11-13 11:45:00')].filter((n) => n.dataEmissao >= inicial(u) + ' 00:00:00' && n.dataEmissao <= final(u) + ' 00:00:00');
    let md = await api.medirFiltroDeData('t', agoraMs);
    assert.ok(urls.length === 3 && urls.every((u) => /situacao=5/.test(u) && /pagina=1/.test(u)) && md.hoje_em_brasilia === '2026-11-13', 'três perguntas de leitura sobre as autorizadas: ' + JSON.stringify(urls));
    assert.ok(md.so_hoje.de_hoje === 0 && md.hoje_ate_amanha.de_hoje === 2 && md.ontem_ate_hoje.de_hoje === 0 && md.ontem_ate_hoje.emissao_mais_nova === '2026-11-12 22:10:00' && /^CONFIRMADO/.test(md.leia), 'com esse Bling a medição tem que CONFIRMAR que "final = hoje" não traz as notas de hoje: ' + JSON.stringify(md));
    /* o Bling que devolve o dia inteiro da data final */
    responder = (u) => [nota('2026-11-12 22:10:00'), nota('2026-11-13 08:30:00')].filter((n) => n.dataEmissao >= inicial(u) + ' 00:00:00' && n.dataEmissao <= final(u) + ' 23:59:59');
    md = await api.medirFiltroDeData('t', agoraMs);
    assert.ok(md.so_hoje.de_hoje === 1 && md.ontem_ate_hoje.de_hoje === 1 && /devolve as notas de hoje/.test(md.leia) && !/^CONFIRMADO/.test(md.leia), JSON.stringify(md));
    /* ainda sem nota hoje: não conclui nada */
    responder = (u) => [nota('2026-11-12 22:10:00')].filter((n) => n.dataEmissao >= inicial(u) + ' 00:00:00' && n.dataEmissao <= final(u) + ' 23:59:59');
    md = await api.medirFiltroDeData('t', agoraMs);
    assert.ok(/ainda não há nota autorizada hoje/.test(md.leia), md.leia); }
  console.log('ok — nfEstaEmConsulta: procura a nota no dia de emissão dela (filtro 10), e só diz "não está" quando leu o dia inteiro');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && e.message); process.exit(1); });
