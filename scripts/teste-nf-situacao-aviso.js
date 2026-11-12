'use strict';
/* 12/11 — AVISO NO CHECKOUT DO ADMIN quando a nota em "Consultar situação" NÃO destrava.
   Pedido do dono: "em 99% dos casos clicar em Consultar situação já resolve. Aí sim, se der erro e não resolver, vale a
   pena vir um alerta no checkout do admin, igual a gente fez pro CEP das NFs."
   Prova:
   1) lib/nf-travadas — o aviso de outro tipo entra na MESMA lista do checkout com chave própria: a F3 não deixa de mandar
      nota por causa dele (`estaTravada` só vale pras recusadas do ML), o texto é limpo, e some quando resolvido;
   2) lib/fiscal/situacao-vigia — nota recém-parada não avisa; passou de 30 min sem ninguém consultar → avisa; consulta
      que tentou e não destravou → avisa NA HORA com o que a SEFAZ disse; "não logado" e "não deu pra confirmar" não são
      falha da nota; nota que saiu da lista → some da memória e do checkout; erro ao listar não mexe em nada; a idade
      conta da EMISSÃO (hora de Brasília), não de quando o servidor a viu;
   3) o módulo fiscal de verdade — a lista pedida pela Toolbox já atualiza a vigia; a rota do resultado recebe e avisa; a
      rotina de 5 em 5 min chama a vigia sem que uma falha dela derrube a correção; as três empresas apontam a pasta certa;
   4) o contrato com a Toolbox — cada resposta que ela manda tem tratamento aqui;
   5) a tela do admin mostra os dois tipos, cada um com o seu título. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const nfT = require('../lib/nf-travadas');
const { criar: criarVigia } = require('../lib/fiscal/situacao-vigia');
const { criarModuloFiscal } = require('../lib/fiscal/criar-modulo');
const pasta = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sit-aviso-'));
const brt = (ms) => new Date(ms - 3 * 3600000).toISOString().slice(0, 19).replace('T', ' ');   /* a emissão como o Bling manda */

(async () => {
  /* ── 1) a lista do checkout ── */
  let d = pasta();
  let r = nfT.registrarAviso(d, { tipo: 'consultar_situacao', nfeId: '27382395982', numero: '130428', motivo: 'a SEFAZ respondeu <b>217</b>', comoResolver: 'faça X', detalhe: 'emitida em 2026-11-11 21:35:03' });
  assert.ok(r.nova && r.gravou);
  assert.strictEqual(nfT.estaTravada(d, '27382395982'), false, 'o aviso do "Consultar situação" NÃO pode fazer a F3 deixar de mandar a nota ao ML');
  let l = nfT.lista(d);
  assert.ok(l.length === 1 && l[0].tipo === 'consultar_situacao' && l[0].numero === '130428' && !/[<>]/.test(l[0].motivo) && l[0].como_resolver === 'faça X', JSON.stringify(l));
  assert.strictEqual(nfT.resolverPorPedido(d, '2000012345', null), 0, 'a limpeza por pedido do ML passa reto por este tipo');
  const desde = l[0].desde; await new Promise((ok) => setTimeout(ok, 5));
  r = nfT.registrarAviso(d, { tipo: 'consultar_situacao', nfeId: '27382395982', numero: '130428', motivo: 'outro motivo', comoResolver: 'faça X' });
  assert.ok(!r.nova && nfT.lista(d)[0].desde === desde && nfT.lista(d)[0].motivo === 'outro motivo', 'regravar atualiza o texto e mantém desde quando');
  assert.ok(nfT.resolverAviso(d, 'consultar_situacao', '27382395982') && nfT.lista(d).length === 0 && !nfT.resolverAviso(d, 'consultar_situacao', '27382395982'));

  /* ── 2) a vigia ── */
  d = pasta(); let agora = Date.parse('2026-11-12T15:00:00Z'), listou = 0, listaAgora = [], erroLista = null;
  /* a conferência individual (Codex #856): true = segue parada (fora da janela da lista), false = saiu mesmo, null = não sei */
  const seguemParadas = new Set(), naoSei = new Set(), conferiu = [];
  const V = criarVigia({ dirTravadas: d, agora: () => agora, maxConfirmar: 3, listar: async () => { listou++; if (erroLista) throw new Error(erroLista); return listaAgora; },
    confirmar: async (id, emissao) => { conferiu.push([id, emissao]); if (naoSei.has(id)) return null; return seguemParadas.has(id); } });
  const nf = (id, numero, minAtras) => ({ id, numero, dataEmissao: brt(agora - minAtras * 60000) });
  listaAgora = [nf(1, '130428', 5)];
  let x = await V.reconciliar(listaAgora);
  assert.ok(x.total === 1 && x.avisadas === 0 && nfT.lista(d).length === 0, 'nota parada há 5 min: ainda não avisa (a Toolbox tem tempo de passar)');
  agora += 31 * 60000; x = await V.reconciliar(listaAgora);
  l = nfT.lista(d);
  assert.ok(x.avisadas === 1 && l.length === 1 && l[0].numero === '130428' && /há 36 min/.test(l[0].motivo) && /nenhuma consulta automática/.test(l[0].motivo) && /Toolbox/.test(l[0].motivo) && /3 pontinhos/.test(l[0].como_resolver), 'passou de 30 min sem consulta: avisa dizendo há quanto tempo e o que falta: ' + JSON.stringify(l));
  /* a consulta tentou e a SEFAZ respondeu outra coisa: avisa na hora, com a resposta */
  listaAgora.push(nf(2, '130431', 2)); await V.reconciliar(listaAgora);
  assert.strictEqual(nfT.lista(d).length, 1, 'a nota nova (2 min) ainda não avisa');
  V.receberResultados([{ id: 2, numero: '130431', via: 'nao_autorizada', cStat: '217', xMotivo: 'Rejeicao: NF-e nao consta na base de dados da SEFAZ' }], 'toolbox');
  l = nfT.lista(d).filter((t) => t.nfe_id === '2');
  assert.ok(l.length === 1 && /a SEFAZ respondeu 217/.test(l[0].motivo) && /nao consta/.test(l[0].motivo), 'falha da consulta vira aviso NA HORA, com o que a SEFAZ disse: ' + JSON.stringify(l));
  /* "não logado" não é resposta da nota; "gravada"/"validada"/"sem_confirmacao" não são falha */
  listaAgora.push(nf(3, '130440', 1), nf(4, '130441', 1), nf(5, '130442', 1)); await V.reconciliar(listaAgora);
  V.receberResultados([{ id: 3, via: 'nao_logado' }, { id: 4, via: 'gravada', cStat: '100' }, { id: 5, via: 'sem_confirmacao', erro: 'x' }], 'toolbox');
  assert.strictEqual(nfT.lista(d).length, 2, '"não logado", "gravada" e "sem confirmação" não geram aviso por si');
  assert.ok(V.estado().nfs['3'].tentativas === 0 && V.estado().nfs['4'].tentativas === 1, '"não logado" não conta como tentativa na nota');
  agora += 35 * 60000; await V.reconciliar(listaAgora);
  l = nfT.lista(d).filter((t) => t.nfe_id === '3');
  assert.ok(l.length === 1 && /não estava logado/.test(l[0].motivo), 'depois do limite, a nota que só teve "não logado" avisa dizendo isso: ' + JSON.stringify(l));
  /* outras falhas: o Bling não gravou / não devolveu a resposta / gravou e continua parada */
  V.receberResultados([{ id: 4, via: 'nao_confirmada', erro: 'o Bling aceitou a gravação, mas a nota continua em "Consultar situação"' }], 'toolbox');
  assert.ok(/continua em/.test(nfT.lista(d).find((t) => t.nfe_id === '4').motivo));
  /* a nota destravou (saiu da lista): some da memória e do checkout */
  listaAgora = listaAgora.filter((n) => n.id !== 2 && n.id !== 4); x = await V.reconciliar(listaAgora);
  assert.ok(x.saiu === 2 && !nfT.lista(d).some((t) => t.nfe_id === '2' || t.nfe_id === '4') && !V.estado().nfs['2'], 'nota que saiu de "Consultar situação" tem que sumir do aviso: ' + JSON.stringify(nfT.lista(d).map((t) => t.nfe_id)));
  assert.ok(conferiu.some((c2) => c2[0] === '2' && /^\d{4}-\d{2}-\d{2} /.test(c2[1])), 'antes de tirar o aviso, a nota que sumiu é conferida no dia de emissão dela');
  /* Codex #856: sumir da lista NÃO basta — a lista só cobre os últimos dias. Nota que sumiu mas a conferência diz que SEGUE
     parada (mais antiga que a janela) mantém a memória e o aviso; "não sei" também mantém; só o "saiu mesmo" tira */
  await V.reconciliar(listaAgora.concat([nf(20, '120001', 45), nf(21, '120002', 45), nf(22, '120003', 45)]));
  assert.ok(['20', '21', '22'].every((id) => nfT.lista(d).some((t) => t.nfe_id === id)));
  seguemParadas.add('20'); naoSei.add('21');
  x = await V.reconciliar(listaAgora);   /* as três sumiram da lista */
  assert.ok(nfT.lista(d).some((t) => t.nfe_id === '20') && V.estado().nfs['20'], 'nota fora da janela que SEGUE parada: o aviso fica');
  assert.ok(nfT.lista(d).some((t) => t.nfe_id === '21') && V.estado().nfs['21'], '"não deu pra saber": o aviso fica');
  assert.ok(!nfT.lista(d).some((t) => t.nfe_id === '22') && !V.estado().nfs['22'] && x.saiu === 1, 'só a que a conferência disse que saiu é tirada: ' + JSON.stringify(x));
  seguemParadas.delete('20'); naoSei.delete('21'); await V.reconciliar(listaAgora);
  assert.ok(!nfT.lista(d).some((t) => t.nfe_id === '20' || t.nfe_id === '21'), 'quando a conferência confirma que saíram, os avisos saem');
  /* teto de conferências por rodada (cota do Bling): com 5 sumidas e teto 3, duas ficam pra próxima — sem perder o aviso */
  await V.reconciliar(listaAgora.concat([31, 32, 33, 34, 35].map((id) => nf(id, 'x' + id, 45))));
  conferiu.length = 0; x = await V.reconciliar(listaAgora);
  assert.ok(conferiu.length === 3 && x.saiu === 3 && nfT.lista(d).filter((t) => Number(t.nfe_id) >= 31 && Number(t.nfe_id) <= 35).length === 2, 'no máximo 3 conferências por rodada; as outras duas seguem com aviso: ' + JSON.stringify([conferiu.length, x]));
  await V.reconciliar(listaAgora); assert.ok(!nfT.lista(d).some((t) => Number(t.nfe_id) >= 31 && Number(t.nfe_id) <= 35), 'na rodada seguinte as restantes são conferidas e saem');
  /* aviso órfão (memória perdida) também sai quando a nota não está mais parada */
  nfT.registrarAviso(d, { tipo: 'consultar_situacao', nfeId: '999', numero: '1', motivo: 'm', comoResolver: 'c' });   /* sem a data de emissão: não há como conferir nunca → sai */
  nfT.registrarAviso(d, { tipo: 'consultar_situacao', nfeId: '998', numero: '2', motivo: 'm', comoResolver: 'c', detalhe: 'emitida em 2026-10-01 10:00:00' }); seguemParadas.add('998');
  await V.reconciliar(listaAgora); assert.ok(!nfT.lista(d).some((t) => t.nfe_id === '999') && nfT.lista(d).some((t) => t.nfe_id === '998'), 'aviso órfão COM data é conferido (e fica se a nota segue parada); sem data, sai');
  seguemParadas.delete('998'); await V.reconciliar(listaAgora); assert.ok(!nfT.lista(d).some((t) => t.nfe_id === '998'));
  /* a idade conta da EMISSÃO (Brasília): nota emitida há 50 min, vista agora pela 1ª vez → já avisa */
  listaAgora.push(nf(7, '130500', 50)); await V.reconciliar(listaAgora);
  assert.ok(/há 50 min/.test(nfT.lista(d).find((t) => t.nfe_id === '7').motivo), 'a idade é a da emissão, não a de quando o servidor viu');
  /* a conferência periódica: uma listagem a cada 15 min, e erro ao listar não tira aviso nenhum */
  const antes = nfT.lista(d).length; listou = 0;
  await V.vigiarSeDevido(); await V.vigiarSeDevido(); assert.strictEqual(listou, 1, 'no máximo uma listagem por intervalo');
  agora += 16 * 60000; erroLista = 'Bling fora';
  await assert.rejects(() => V.vigiarSeDevido(), /Bling fora/); assert.strictEqual(nfT.lista(d).length, antes, 'erro ao listar ("não sei") não tira aviso');
  erroLista = null; listaAgora = []; await V.vigiarSeDevido();
  for (let i = 0; i < 4 && nfT.lista(d).length; i++) await V.reconciliar([]);   /* o teto de conferências por rodada: sai aos poucos */
  assert.strictEqual(nfT.lista(d).length, 0, 'lista vazia de verdade (e a conferência confirmando): todos os avisos deste tipo saem');
  /* avisos do Mercado Livre na mesma pasta NÃO são tocados pela vigia */
  fs.writeFileSync(path.join(d, '_nf_travadas.json'), JSON.stringify({ '555': { nfe_id: '555', numero: '9', pedido_ml: '2000', motivo: 'CEP', como_resolver: 'x', ultima: 'z' } }));
  await V.reconciliar([]); assert.ok(nfT.estaTravada(d, '555') && nfT.lista(d).length === 1, 'a vigia só mexe nos avisos do tipo dela');

  /* ── 3) o módulo fiscal de verdade ── */
  const nada = async () => ({});
  function modulo(dir, o) {
    o = o || {};
    return criarModuloFiscal(Object.assign({ id: 'teste', nome: 'Teste', prefixo: '/t', rotulo: 'TESTE', crons: {},
      pecas: { rotinaExpediente: nada, rotinaVirada: nada, rotinaManha: nada, corrigirNFsPendentes: async () => { o.corrigiu = (o.corrigiu || 0) + 1; return 'feito'; }, retryNFManual: nada, getEstadoRetrySEFAZ: () => ({}),
        garantirToken: async () => 't', gerarTokenInicial: nada, gerarTokenInicialNF: nada, garantirTokenNF: async () => 'tnf', garantirTokenML: async () => 'tml', trocarCodigoPorToken: nada, gerarUrlAutorizacao: () => 'http://x',
        getPedidoDetalhe: nada, rotinaNFeML: nada, enviarNFeUnica: nada, getNFDetalhe: nada, nfEstaEmConsulta: async () => false,
        getNFsSituacaoConsulta: async () => { o.listou = (o.listou || 0) + 1; if (o.erroLista) throw new Error('caiu'); return o.lista || []; } } }, dir ? { dirTravadas: dir } : {}));
  }
  async function chamar(mod, metodo, caminho, corpo) {
    const u = new URL('http://x' + caminho); let st = 0, txt = '';
    const res = { writeHead: (c) => { st = c; }, end: (b) => { txt = String(b || ''); }, setHeader: () => {} };
    await mod.routes(async () => corpo)({ method: metodo, headers: {}, url: caminho }, res, u);
    return { st, j: txt ? JSON.parse(txt) : null };
  }
  d = pasta(); const o = { lista: [{ id: 27382450057, numero: '130431', dataEmissao: brt(Date.now() - 3 * 60000) }] };
  let m = modulo(d, o);
  let c = await chamar(m, 'GET', '/t/robo/nfs-consultar-situacao');
  await new Promise((ok) => setTimeout(ok, 30));   /* a vigia roda em fundo, sem segurar a resposta da lista */
  assert.ok(c.j.total === 1 && fs.existsSync(path.join(d, '_nf_consultar_situacao.json')) && nfT.lista(d).length === 0, 'a lista pedida pela Toolbox já alimenta a vigia (nota nova: sem aviso ainda)');
  c = await chamar(m, 'POST', '/t/robo/nfs-consultar-situacao/resultado', { origem: 'toolbox', versao: '2.1.18', resultados: [{ id: 27382450057, numero: '130431', via: 'nao_autorizada', cStat: '204', xMotivo: 'Duplicidade de NF-e' }] });
  assert.ok(c.st === 200 && c.j.ok && c.j.recebidos === 1 && /a SEFAZ respondeu 204/.test(nfT.lista(d)[0].motivo), 'a rota do resultado recebe o que a Toolbox manda e avisa: ' + JSON.stringify([c, nfT.lista(d)]));
  c = await chamar(m, 'POST', '/t/robo/nfs-consultar-situacao/resultado', { resultados: 'x' }); assert.strictEqual(c.st, 400);
  /* a rotina de 5 em 5 min: corrige e chama a vigia; falha da vigia não derruba a correção */
  o.listou = 0; assert.strictEqual(await m.rotinas.corrigirNFs(), 'feito'); assert.ok(o.corrigiu === 1 && o.listou === 1, 'a rotina tem que conferir a lista pela vigia');
  const o2 = { erroLista: true }; const m2 = modulo(pasta(), o2);
  assert.strictEqual(await m2.rotinas.corrigirNFs(), 'feito', 'a vigia quebrando não pode derrubar a correção das notas');
  /* empresa sem a pasta informada: sem vigia, e a rota diz isso */
  const m3 = modulo(null, {}); c = await chamar(m3, 'POST', '/t/robo/nfs-consultar-situacao/resultado', { resultados: [] });
  assert.ok(c.j.ok === false && /vigia/.test(c.j.erro)); assert.strictEqual(await m3.rotinas.corrigirNFs(), 'feito');
  /* as três empresas informam a MESMA pasta que a F3 usa pro aviso do checkout */
  for (const emp of ['girassol', 'ambtotal', 'good']) {
    const idx = fs.readFileSync(path.join(raiz, emp, 'index.js'), 'utf8'), f3 = fs.readFileSync(path.join(raiz, emp, 'nfeMlFluxo.js'), 'utf8');
    const a = (/dirTravadas: ([^\n]+),\n/.exec(idx) || [])[1], b = (/dirTravadas: ([^\n]+),\n/.exec(f3) || [])[1];
    assert.ok(a && a === b, emp + ': a pasta do aviso tem que ser a mesma da F3 (' + a + ' × ' + b + ')');
  }

  /* ── 4) o contrato com a Toolbox: toda resposta que ela manda tem tratamento ── */
  const tb = fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'ct-situacao.js'), 'utf8') + fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'bg-situacao.js'), 'utf8');
  const vias = Array.from(new Set((tb.match(/via(?: =|:) '([a-z_]+)'/g) || []).map((s2) => /'([a-z_]+)'/.exec(s2)[1])));
  for (const v of ['nao_logado', 'sem_resposta', 'nao_autorizada', 'gravada', 'erro', 'validada', 'nao_confirmada', 'sem_confirmacao']) assert.ok(vias.indexOf(v) !== -1, 'a Toolbox deixou de mandar "' + v + '"? (o teste lê os dois arquivos dela): ' + vias.join());
  d = pasta(); const V2 = criarVigia({ dirTravadas: d, listar: async () => [] });
  await V2.reconciliar(vias.map((v, i) => ({ id: 1000 + i, numero: String(i), dataEmissao: brt(Date.now() - 60000) })));
  V2.receberResultados(vias.map((v, i) => ({ id: 1000 + i, via: v, cStat: '217', xMotivo: 'm', erro: 'e' })), 'toolbox');
  const avisou = nfT.lista(d).map((t) => vias[Number(t.nfe_id) - 1000]).sort().join();
  assert.strictEqual(avisou, vias.filter((v) => ['validada', 'gravada', 'sem_confirmacao', 'nao_logado'].indexOf(v) === -1).sort().join(), 'falha = tudo o que não é "deu certo", "não sei" ou "não logado": ' + avisou);
  assert.ok(/\/robo\/nfs-consultar-situacao\/resultado/.test(tb) && /resultados: res/.test(tb) && /origem: 'toolbox'/.test(tb), 'a Toolbox manda { origem, versao, resultados } pra rota do resultado');

  /* ── 5) a tela do admin ── */
  const html = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'painel', 'painel-galpao.html'), 'utf8');
  const i0 = html.indexOf('async function checarNFTravadas'), i1 = html.indexOf('setInterval(checarNFTravadas');
  const el = { style: { display: 'none' }, innerHTML: '' };
  const fn = new Function('document', 'fetch', html.slice(i0, i1).replace('{{PREFIXO}}', '/x') + '\nreturn checarNFTravadas;')({ getElementById: () => el },
    async () => ({ json: async () => ({ ok: true, total: 2, travadas: [
      { nfe_id: '555', numero: '130031', pedido_ml: '2000012', motivo: 'CEP inválido', como_resolver: 'cancele e reemita' },
      { tipo: 'consultar_situacao', nfe_id: '1', numero: '130428', detalhe: 'emitida em 2026-11-11 21:35:03', motivo: 'a SEFAZ respondeu 217 <script>', como_resolver: 'No Bling: 3 pontinhos' }] }) }));
  await fn();
  assert.ok(el.style.display === '' && /1 nota fiscal travada \u2014 o Mercado Livre recusou/.test(el.innerHTML) && /NF 130031/.test(el.innerHTML) && /1 nota parada em \u201cConsultar situa\u00e7\u00e3o\u201d no Bling/.test(el.innerHTML) && /NF 130428/.test(el.innerHTML) && /&lt;script&gt;/.test(el.innerHTML) && !/<script>/.test(el.innerHTML), 'a tela do admin tem que mostrar os dois tipos, cada um com o seu título, e o texto escapado: ' + el.innerHTML.slice(0, 400));
  console.log('ok — "Consultar situação" que não destrava vira aviso no checkout do admin (na hora, com o que a SEFAZ disse; ou depois de 30 min sem consulta) e some sozinho quando a nota destrava — nas três empresas');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && e.message); process.exit(1); });
