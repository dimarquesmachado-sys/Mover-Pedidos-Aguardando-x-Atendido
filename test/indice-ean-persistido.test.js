'use strict';
// O INDICE EAN DO ESTOQUE-GIRASSOL (e do fragil) SOBREVIVE AO REINICIO.
// Medido 01/10: 9s apos cada boot, ~9.000 buscas de detalhe a 1/s na conta
// Bling da Girassol (2h30) so pra montar o indice EAN em memoria. Com a fila
// do Devolucoes, passava dos 3/s do Bling: 429 no bipe por 2h30 a cada deploy.

const fs = require('fs');
const os = require('os');
const path = require('path');
let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };

const disco = require('../lib/indice-ean-disco');
const tmp = path.join(os.tmpdir(), 'indice-ean-teste-' + process.pid, 'sub', 'indice-ean.json');

// ── a lib ──
{
  const v = disco.carregar(tmp);
  ok(v.eans.size === 0 && v.verificados.size === 0 && !v.erro, '  sem arquivo: vazio, sem erro (boot faz a carga inteira, como antes)');
  const eans = new Map([['7891234567890', '11'], ['7899999999999', '12']]);
  const verif = new Map([['11', Date.now()], ['12', Date.now()], ['13', Date.now()]]);   // 13: produto SEM ean, mas ja verificado
  const r = disco.salvar(tmp, eans, verif);
  ok(r.ok && r.eans === 2 && r.verificados === 3, '⚠️ salva (cria a pasta, atomico via tmp+rename)');
  ok(fs.existsSync(tmp) && !fs.existsSync(tmp + '.tmp'), '  o .tmp nao sobra');
  const c = disco.carregar(tmp);
  ok(c.eans.get('7891234567890') === '11' && c.verificados.has('13') && c.salvo_em, '  carrega de volta: EANs, ids verificados (inclusive o SEM ean) e a data');
  ok(typeof c.verificados.get('13') === 'number', '  verificados e id -> QUANDO (ms), nao lista');
  fs.writeFileSync(tmp, '{ corrompido');
  const cc = disco.carregar(tmp);
  ok(cc.eans.size === 0 && cc.erro, '  arquivo corrompido: vazio + erro (nunca lanca; o boot segue)');
  // arquivo antigo sem a lista de verificados: quem tem EAN conta como verificado
  fs.writeFileSync(tmp, JSON.stringify({ eans: { '7890000000000': '99' } }));
  ok(disco.carregar(tmp).verificados.has('99'), '  arquivo sem "verificados": todo id com EAN vale como verificado');
  // arquivo do formato ANTERIOR (lista): vale como "verificado agora"
  fs.writeFileSync(tmp, JSON.stringify({ eans: {}, verificados: ['5', '6'] }));
  ok(disco.carregar(tmp).verificados.get('5') > 0, '  arquivo com verificados em LISTA (formato anterior) ainda carrega');
  // Codex #559: a verificacao VENCE (20-40 dias, espalhado por id)
  const agora = Date.now(), D = 864e5;
  ok(disco.venceu('11', undefined), '  nunca verificado -> vencido (pendente)');
  ok(!disco.venceu('11', agora - 10 * D, agora), '⚠️ verificado ha 10 dias -> NAO vencido (nao refaz)');
  ok(disco.venceu('11', agora - 45 * D, agora), '  verificado ha 45 dias -> vencido (produto renomeado/EAN trocado/apagado e revisto)');
  {
    const ids = Array.from({ length: 2000 }, (_, i) => String(1000 + i));
    const venc = (dias) => ids.filter((id) => disco.venceu(id, agora - dias * D, agora)).length;
    ok(venc(19) === 0 && venc(41) === 2000, '  ninguem vence antes de 20 dias; todos ate 40');
    ok(venc(30) > 600 && venc(30) < 1400, `⚠️ no dia 30 vence cerca de metade (${venc(30)}/2000) — ESPALHADO, nao os 9.000 de uma vez`);
  }
  // Codex #559: teto de revisoes por boot — novos sempre entram, vencidos so ate o teto (mais antigos primeiro)
  {
    const ver = new Map();
    for (let i = 0; i < 1000; i++) ver.set(String(5000 + i), agora - (41 + (i % 10)) * D);   // 1000 vencidos
    ver.set('9001', agora);                                                                 // fresco
    const ids = [...ver.keys(), '9002'];                                                    // 9002 = nunca verificado
    const s = disco.selecionar(ids, ver, 300, agora);
    ok(s.novos.length === 1 && s.novos[0] === '9002', '⚠️ selecionar: produto NUNCA verificado entra sempre');
    ok(s.revisoes.length === 300 && s.adiadas === 700, '⚠️ selecionar: 1000 vencidos -> so 300 no boot, 700 adiados (nao recria as 2h30 de Bling)');
    ok(!s.revisoes.includes('9001'), '  selecionar: fresco nao entra');
    const ts = s.revisoes.map((id) => ver.get(id));
    ok(ts.every((t, i) => i === 0 || ts[i - 1] <= t), '  selecionar: os mais antigos primeiro');
  }
  // Codex #559: produto apagado some da listagem -> poda do indice, verificados e enxutos
  {
    const e = new Map([['7891', '1'], ['7892', '2']]), v = new Map([['1', 1], ['2', 1], ['3', 1]]), pr = new Map([['2', {}], ['3', {}]]);
    ok(disco.podar(new Set(['1']), e, v, pr) === 2, '⚠️ podar: ids que a listagem completa nao tem (2 e 3) saem');
    ok(e.size === 1 && e.get('7891') === '1' && v.size === 1 && v.has('1') && pr.size === 0, '  podar: EAN, verificado e enxuto do apagado somem; o vivo fica');
    ok(disco.podar(null, e, v, pr) === 0 && disco.podar(new Set(), e, v, pr) === 0 && v.has('1'), '  podar: listagem incompleta/vazia NAO poda nada');
  }
  ok(disco.salvar('', eans, verif).ok === false, '  sem caminho: ok:false, nao lanca');
  // Codex #559: produtos ENXUTOS (so o fragil persiste; o estoque-girassol nao)
  const enx = disco.enxugar({ id: 77, codigo: 'ABC', sku: 'ABC', nome: 'Lixa 7 pol', gtin: '7890000000001' }, 'https://x.com/i.jpg', '7890000000001');
  ok(enx.id === 77 && enx.nome === 'Lixa 7 pol' && enx.gtin === '7890000000001' && enx.imagem === 'https://x.com/i.jpg', '  enxugar: id, codigo, sku, nome, gtin, imagem (o que o fragil exibe)');
  disco.salvar(tmp, eans, verif, new Map([['77', enx]]));
  const c3 = disco.carregar(tmp);
  ok(c3.produtos.get('77') && c3.produtos.get('77').nome === 'Lixa 7 pol', '⚠️ os enxutos voltam do disco (o buscar() do fragil repovoa o cache com eles)');
  disco.salvar(tmp, eans, verif);
  ok(disco.carregar(tmp).produtos.size === 0, '  sem enxutos (estoque-girassol): produtos vazio, sem erro');
}
// o fragil repovoa o cache de detalhes; o estoque-girassol NAO (estoque/localizacao mudam, busca sob demanda)
{
  const fr = fs.readFileSync(path.join(__dirname, '..', 'fragil', 'blingProdutos.js'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  ok(/if \(!cacheDetalhes\.has\(id\)\) cacheDetalhes\.set\(id, pe\);/.test(fr), '⚠️ fragil: repovoa cacheDetalhes com os enxutos do disco (Codex #559)');
  ok(/produtosEnxutos\.set\(String\(p\.id\), eanDisco\.enxugar\(p, extractImage\(p\), getEans\(p\)/.test(fr), '  fragil: buscarDetalhe guarda o enxuto pra persistir');
  ok((fr.match(/eanDisco\.salvar\(INDICE_EAN_FILE, indiceEan, idsVerificados, produtosEnxutos\)/g) || []).length === 2, '  fragil: salva com os enxutos (fim e a cada 200)');
  const eg = fs.readFileSync(path.join(__dirname, '..', 'estoque-girassol', 'blingProdutos.js'), 'utf8');
  ok(!/produtosEnxutos/.test(eg), '  estoque-girassol: NAO persiste detalhes (estoque e localizacao mudam; busca sob demanda com o indice EAN)');
}

// ── os dois apps usam a lib e PULAM os verificados ──
for (const [p, env] of [['estoque-girassol/blingProdutos.js', 'ESTOQUE_GIRASSOL_INDICE_EAN_FILE'], ['fragil/blingProdutos.js', 'FRAGIL_INDICE_EAN_FILE']]) {
  const s = fs.readFileSync(path.join(__dirname, '..', p), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const nome = p.split('/')[0];
  ok(/require\('\.\.\/lib\/indice-ean-disco'\)/.test(s), `⚠️ ${nome}: usa a lib`);
  ok(new RegExp(`process\\.env\\.${env} \\|\\| '/data/${nome}/indice-ean\\.json'`).test(s), `  ${nome}: arquivo no disco persistente (/data/${nome}/), env ${env}`);
  ok(/const disco = eanDisco\.carregar\(INDICE_EAN_FILE\);/.test(s), `  ${nome}: carrega do disco ANTES de qualquer chamada ao Bling`);
  ok(/eanDisco\.selecionar\(\[\.\.\.new Set\(\[\.\.\.indiceSku\.values\(\)\]\)\], idsVerificados\)/.test(s) && /\[\.\.\.sel\.novos, \.\.\.sel\.revisoes\]/.test(s), `⚠️ ${nome}: so busca os NAO verificados ou VENCIDOS, com TETO de revisoes por boot (o 2o boot nao refaz as 9.000)`);
  ok(/eanDisco\.podar\(idsListados, indiceEan, idsVerificados/.test(s) && /carregarEansBackground\(listagemCompleta \? idsListados : null\)/.test(s), `⚠️ ${nome}: poda do disco o que a listagem COMPLETA nao tem mais (apagado); listagem incompleta nao poda`);
  ok((s.match(/listagemCompleta = true/g) || []).length === 2, `  ${nome}: listagem so e "completa" quando a ultima pagina veio normalmente`);
  ok(/idsVerificados\.set\(String\(p\.id\), Date\.now\(\)\);/.test(s), `  ${nome}: buscarDetalhe marca o id como verificado AGORA (com ou sem EAN)`);
  ok(/if \(!pDet && revisao && status === 404\) \{/.test(s) && /indiceEan\.delete\(e\)/.test(s), `⚠️ ${nome}: SO o 404 tira o id morto do indice (429/5xx/rede mantem o registro)`);
  ok(/if \(forcar\) for \(const \[e, idE\] of indiceEan\) if \(idE === String\(p\.id\)\) indiceEan\.delete\(e\);/.test(s), `  ${nome}: EANs antigos so sao soltos DEPOIS de o Bling responder (EAN trocado; falha nao apaga EAN de produto vivo)`);
  ok(/await buscarDetalheStatus\(id, revisao\);/.test(s), `⚠️ ${nome}: a revisao do vencido e busca FORCADA (o cache nao a pula)`);
  ok(/eanDisco\.salvar\(INDICE_EAN_FILE, indiceEan, idsVerificados[^)]*\)/.test(s), `  ${nome}: salva ao terminar`);
  ok(/desdeOUltimoSalvo >= 200/.test(s), `  ${nome}: e a cada 200 no meio (um reinicio em 2h nao perde tudo)`);
  ok(!/ultimoStatusDetalhe/.test(s) && /return \{ produto: null, status: response\.status \}/.test(s), `⚠️ ${nome}: o status do detalhe volta COM a resposta (sem global que outra busca sobrescreva)`);
  ok(/function invalidarIndice\(\)/.test(s) && /unlinkSync\(f\)/.test(s) && /if \(ger !== geracao\) return;/.test(s), `⚠️ ${nome}: reautorizar a conta descarta o indice (disco + memoria) e para o loop da conta antiga`);
  const ix = fs.readFileSync(path.join(__dirname, '..', nome, 'index.js'), 'utf8');
  ok(/gerarTokenInicial\(code\);\s*blingProdutos\.invalidarIndice\(\);/.test(ix), `  ${nome}: o callback do OAuth invalida o indice antes de recarregar`);
  // Regra 12: os nomes existem
  ok(/const idsVerificados = new Map\(\)/.test(s) && /const indiceEan\s+= new Map\(\)/.test(s), `  ${nome}: idsVerificados (Map id->ts) e indiceEan declarados`);
  ok(s.indexOf('const idsVerificados') < s.indexOf('async function buscarDetalhe'), `  ${nome}: declarado antes de buscarDetalhe usar (sem TDZ)`);
}

// ── simulacao do 2o boot: o que o filtro faz com o disco cheio ──
{
  const idsListagem = ['11', '12', '13', '14'];   // 14 e novo
  const d = disco.carregar(tmp);
  // reconstruo o disco cheio
  disco.salvar(tmp, new Map([['7891234567890', '11'], ['7899999999999', '12']]), new Map([['11', Date.now()], ['12', Date.now()], ['13', Date.now()]]));
  const d2 = disco.carregar(tmp);
  const pendentes = idsListagem.filter((id) => disco.venceu(id, d2.verificados.get(id)));
  ok(pendentes.length === 1 && pendentes[0] === '14', '⚠️ 2o boot: de 4 produtos, so o NOVO (14) vai ao Bling — nao os 9.000');
}
try { fs.rmSync(path.dirname(path.dirname(tmp)), { recursive: true, force: true }); } catch (e) {}

console.log('');
console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
process.exit(falhas ? 1 : 0);
