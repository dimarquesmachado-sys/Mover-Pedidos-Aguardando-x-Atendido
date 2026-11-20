'use strict';
/* 20/11 — CONSERTO DA NF RECUSADA PELO ML: O BOTÃO no aviso do checkout (o conserto num clique).
   O dono pediu pra automatizar o que fazia à mão; as duas rotas (criar a nota nova; emitir + XML ao ML) já foram provadas
   com nota de verdade. Aqui se prova o painel — o trecho do HTML de produção, executado com navegador de mentira:
   · só o admin vê o botão, e só em nota recusada pelo ML (não na de "Consultar situação");
   · um clique: confirma → cria → emite/manda (esperando a SEFAZ) → diz o resultado; sem confirmar, nada sai;
   · criar falhou: NÃO tenta emitir, e diz o motivo que o servidor deu;
   · clicar duas vezes não dispara duas vezes; falha de rede libera pra clicar de novo;
   · o texto que vem do servidor entra como TEXTO (nunca como HTML). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'painel', 'painel-galpao.html'), 'utf8');

const i0 = html.indexOf('async function checarNFTravadas'), fim = 'setInterval(checarNFAntigas, 5*60000);\n', i1 = html.indexOf(fim);
assert.ok(i0 > 0 && i1 > i0, 'o trecho do aviso + botão não está no painel');
const trecho = html.slice(i0, i1 + fim.length).split('{{PREFIXO}}').join('/emp');

/* monta o trecho num "navegador": devolve as funções e o que foi observado */
function navegador(op) {
  op = op || {};
  const els = {}; const el = (id) => (els[id] || (els[id] = { id, style: { display: 'none' }, innerHTML: '', textContent: '' }));
  const obs = { buscas: [], toasts: [], confirma: [], esperas: [], antigas: [] };
  const fila = (op.respostas || []).slice();
  const fetchF = async (u) => {
    /* 20/11: a lista das notas antigas pendentes é outro aviso (provado em teste-nf-conserto-antigas) — aqui só se conta que foi pedida */
    if (/\/nf-conserto-antigas/.test(u)) { obs.antigas.push(u); return { json: async () => (op.antigas || { ok: true, total: 0, antigas: [] }) }; }
    obs.buscas.push(u);
    if (/\/nf-travadas$/.test(u)) return { json: async () => (op.travadas || { ok: true, total: 0, travadas: [] }) };
    const r = fila.shift();
    if (r === 'REDE') throw new Error('rede caiu');
    if (typeof r === 'function') return r();
    return { json: async () => r };
  };
  const f = new Function('document', 'fetch', 'setInterval', 'setTimeout', 'souAdmin', 'confirm', 'toast',
    trecho + '\nreturn { checarNFTravadas, botaoConsertoNF, consertarNF, _nfcMotivo, _nfConserto, nfcAoSaberQuemEAdmin, checarNFAntigas, resolverNFAntiga, _nfaHoras };')(
    { getElementById: (id) => (id === 'nfTravadas' || els[id] || op.criaEl ? el(id) : null) }, fetchF, () => {},
    (fn, ms) => { obs.esperas.push(ms); return setImmediate(fn); }, () => (op.papel ? op.papel.admin : op.admin !== false), (m) => { obs.confirma.push(m); return op.confirma !== false; }, (m, ms) => obs.toasts.push([m, ms]));
  return { f, obs, el };
}
const tique = async (n) => { for (let i = 0; i < (n || 6); i++) await new Promise((r) => setImmediate(r)); };
const OK_CRIAR = { ok: true, criou: true, nova: { id: '888', numero: '130800' } };
const NO_ML = { ok: true, etapa: 'no_ml', nova: { id: '888', numero: '130800' } };
const ESPERA = { ok: true, etapa: 'aguardando_sefaz' };

(async () => {
  /* ═══ 1. o botão ═══ */
  {
    const n = navegador({ admin: false });
    assert.strictEqual(n.f.botaoConsertoNF({ conserto: 'endereco', nfe_id: '777', numero: '130772' }), '', 'quem não é admin não vê o botão');
    const a = navegador();
    const h = a.f.botaoConsertoNF({ conserto: 'endereco', nfe_id: '777', numero: '130772' });
    assert.ok(/onclick="consertarNF\('777','130772'\)"/.test(h) && /id="nfc_777"/.test(h) && /Consertar/.test(h), 'o botão do admin: ' + h);
    for (const ruim of ['', 'abc', '77 7', "7');alert(1);('", null, undefined]) assert.strictEqual(a.f.botaoConsertoNF({ conserto: 'endereco', nfe_id: ruim, numero: '1' }), '', 'id que não é só dígito não vira botão: ' + JSON.stringify(ruim));
    const esq = a.f.botaoConsertoNF({ conserto: 'endereco', nfe_id: '777', numero: "13'0\"<b>772" });
    assert.ok(/consertarNF\('777','130b772'\)/.test(esq) && !/<b>772/.test(esq), 'o número entra limpo no onclick: ' + esq);
    assert.ok(/consertarNF\('777','777'\)/.test(a.f.botaoConsertoNF({ conserto: 'endereco', nfe_id: '777' })), 'sem número, mostra o id');
    a.f._nfConserto['777'] = { texto: 'parou: <img src=x onerror=1> & "x"' };
    const comTexto = a.f.botaoConsertoNF({ conserto: 'endereco', nfe_id: '777', numero: '130772' });
    assert.ok(/&lt;img src=x onerror=1&gt; &amp; &quot;x&quot;/.test(comTexto) && !/<img/.test(comTexto), 'o andamento guardado é redesenhado como TEXTO: ' + comTexto);
    /* no aviso: botão na recusada pelo ML, não na de "Consultar situação"; não-admin vê o aviso sem botão */
    const trav = { ok: true, total: 4, travadas: [{ nfe_id: '777', numero: '130772', pedido_ml: '2000', motivo: 'CEP', como_resolver: 'c', conserto: 'endereco' }, { nfe_id: '555', numero: '130555', pedido_ml: '2001', motivo: 'CNPJ/CPF do destinatário inválido', como_resolver: 'c', conserto: null }, { nfe_id: '444', numero: '130444', motivo: 'm', como_resolver: 'c' }, { tipo: 'consultar_situacao', nfe_id: '9', numero: '130428', motivo: 'm', como_resolver: 'c' }] };
    const av = navegador({ travadas: trav }); await tique();
    const hA = av.el('nfTravadas').innerHTML;
    assert.ok(av.el('nfTravadas').style.display === '' && /consertarNF\('777','130772'\)/.test(hA) && !/consertarNF\('9'/.test(hA) && (hA.match(/consertarNF\(/g) || []).length === 1, 'o aviso do admin tem UM botão, na nota recusada pelo ML por ENDEREÇO: ' + hA.slice(0, 400));
    assert.ok(hA.indexOf('NF 130772') < hA.indexOf('consertarNF(') && hA.indexOf('consertarNF(') < hA.indexOf('NF 130428'), 'o botão fica junto da nota dele');
    /* Codex #958: este conserto troca o ENDEREÇO — nota recusada por documento (ou sem o motivo dito pelo servidor) não ganha botão */
    assert.ok(/NF 130555/.test(hA) && /NF 130444/.test(hA) && !/consertarNF\('555'/.test(hA) && !/consertarNF\('444'/.test(hA), 'nota recusada por outro motivo aparece no aviso, sem o botão');
    for (const outro of [null, undefined, '', 'documento', 'ENDERECO']) assert.strictEqual(av.f.botaoConsertoNF({ nfe_id: '777', numero: '1', conserto: outro }), '', 'conserto ' + JSON.stringify(outro) + ' não vira botão');
    assert.strictEqual(av.f.botaoConsertoNF(null), ''); assert.strictEqual(av.f.botaoConsertoNF(undefined), '');
    /* Codex #958: o aviso é desenhado ao abrir, quando o painel pode ainda não saber quem é admin — ao saber (ou ao trocar de
       operador), redesenha; sem mudança, não busca de novo */
    const papel = { admin: false }; const tr = navegador({ travadas: trav, papel }); await tique();
    assert.ok(!/consertarNF/.test(tr.el('nfTravadas').innerHTML) && tr.obs.buscas.length === 1, 'abriu sem saber quem é admin: aviso sem botão');
    tr.f.nfcAoSaberQuemEAdmin(); await tique();
    assert.strictEqual(tr.obs.buscas.length, 1, 'continua não-admin: não busca de novo');
    papel.admin = true; tr.f.nfcAoSaberQuemEAdmin(); await tique();
    assert.ok(/consertarNF\('777'/.test(tr.el('nfTravadas').innerHTML) && tr.obs.buscas.length === 2, 'soube que é admin: o aviso é redesenhado COM o botão');
    tr.f.nfcAoSaberQuemEAdmin(); tr.f.nfcAoSaberQuemEAdmin(); await tique();
    assert.strictEqual(tr.obs.buscas.length, 2, 'sem mudança de papel, cada atualização da lista NÃO refaz a busca');
    papel.admin = false; tr.f.nfcAoSaberQuemEAdmin(); await tique();
    assert.ok(!/consertarNF/.test(tr.el('nfTravadas').innerHTML) && tr.obs.buscas.length === 3, 'trocou pra estoquista: o botão some');
    const jaAdm = navegador({ travadas: trav }); await tique(); jaAdm.f.nfcAoSaberQuemEAdmin(); await tique();
    assert.ok(/consertarNF\('777'/.test(jaAdm.el('nfTravadas').innerHTML) && jaAdm.obs.buscas.length === 2, 'admin desde o começo: uma conferência ao saber, e o botão está lá');
    const avN = navegador({ travadas: trav, admin: false }); await tique();
    assert.ok(/NF 130772/.test(avN.el('nfTravadas').innerHTML) && !/consertarNF/.test(avN.el('nfTravadas').innerHTML), 'o estoquista vê o aviso, sem o botão');
  }

  /* ═══ 2. um clique: cria → emite/manda → diz ═══ */
  {
    const n = navegador({ criaEl: true, respostas: [OK_CRIAR, NO_ML] });
    await n.f.consertarNF('777', '130772');
    assert.deepStrictEqual(n.obs.buscas.slice(1), ['/emp/nf-conserto-criar?nf=777&confirma=sim', '/emp/nf-conserto-enviar?nf=777&confirma=sim'], 'cria e depois emite, na nota certa, com confirma=sim');
    assert.ok(n.obs.confirma.length === 1 && /Consertar a NF 130772\?/.test(n.obs.confirma[0]) && /NÃO é cancelada nem devolvida/.test(n.obs.confirma[0]), 'pede confirmação dizendo o que faz e o que NÃO faz');
    const t = n.el('nfc_777').textContent;
    assert.ok(/^✓ nota nova 130800 autorizada e ACEITA pelo Mercado Livre/.test(t) && /NF 130772 \(recusada\) continua no Bling: cancelar ou devolver/.test(t), 'o resultado: ' + t);
    assert.deepStrictEqual([n.obs.toasts.length, n.f._nfConserto['777'].rodando, n.f._nfConserto['777'].texto === t, n.obs.esperas.length], [1, false, true, 0]);
    assert.deepStrictEqual(n.obs.antigas, ['/emp/nf-conserto-antigas'], 'conserto feito: a nota recusada entra na lista das antigas pendentes na hora (a lista é consultada)');
    /* nota nova que já existia (clique repetido depois): segue pra emissão */
    const j = navegador({ criaEl: true, respostas: [{ ok: true, criou: false, ja_existia: true, nova: { id: '888', numero: '130800' } }, ESPERA, NO_ML] });
    const visto = []; const elJ = j.el('nfc_777'); Object.defineProperty(elJ, 'textContent', { set(v) { visto.push(v); }, get() { return visto[visto.length - 1] || ''; } });
    await j.f.consertarNF('777', '130772');
    assert.ok(/já existia/.test(visto[1]) && /esperando a SEFAZ… \(1\)/.test(visto[2]) && /^✓/.test(visto[3]), 'o andamento aparece passo a passo: ' + JSON.stringify(visto));
  }

  /* ═══ 3. sem confirmar / sem ser admin: nada sai ═══ */
  {
    const n = navegador({ criaEl: true, confirma: false, respostas: [OK_CRIAR, NO_ML] });
    await n.f.consertarNF('777', '130772');
    assert.deepStrictEqual([n.obs.buscas.length, n.el('nfc_777').textContent, !!(n.f._nfConserto['777'] || {}).rodando], [1, '', false], 'cancelou a confirmação: nenhuma chamada');
    await n.f.consertarNF('777', '130772'); assert.strictEqual(n.obs.confirma.length, 2, 'e pode clicar de novo depois');
    const s = navegador({ criaEl: true, admin: false, respostas: [OK_CRIAR, NO_ML] });
    await s.f.consertarNF('777', '130772');
    assert.deepStrictEqual([s.obs.buscas.length, s.obs.confirma.length], [1, 0], 'não-admin chamando a função direto não dispara nada');
  }

  /* ═══ 4. criar falhou: NÃO emite, e diz o motivo ═══ */
  for (const [resp, re] of [
    [{ ok: false, etapa: 'plano', erro: 'o conserto não está pronto pra essa nota', pendencias: ['o envio da venda no ML já está "shipped"', 'outra'] }, /não criei a nota nova: o envio da venda no ML já está "shipped"; outra$/],
    [{ ok: false, etapa: 'bling_recusou', erro: 'o Bling recusou a nota — nada foi criado', campos: [{ campo: 'contato.endereco.cep', motivo: 'CEP inválido' }, { campo: '', motivo: 'Data inválida' }] }, /o Bling recusou a nota — nada foi criado \(contato\.endereco\.cep: CEP inválido; Data inválida\)$/],
    [{ ok: false, etapa: 'incerta', erro: 'NÃO SEI se a nota nova foi criada' }, /NÃO SEI se a nota nova foi criada$/],
    [{ ok: false, etapa: 'registro' }, /não criei a nota nova: registro$/], [{ ok: false }, /motivo não informado$/], [null, /sem resposta do servidor$/]]) {
    const n = navegador({ criaEl: true, respostas: [resp, NO_ML] });
    await n.f.consertarNF('777', '130772');
    assert.strictEqual(n.obs.buscas.filter((u) => /nf-conserto-enviar/.test(u)).length, 0, 'criar falhou e a emissão foi chamada: ' + JSON.stringify(resp));
    assert.ok(/^✗/.test(n.el('nfc_777').textContent) && re.test(n.el('nfc_777').textContent), 'o motivo: ' + n.el('nfc_777').textContent);
    assert.strictEqual(n.f._nfConserto['777'].rodando, false);
  }

  /* ═══ 5. a emissão: espera a SEFAZ; para no que não é espera ═══ */
  {
    const n = navegador({ criaEl: true, respostas: [OK_CRIAR, ESPERA, { ok: false, etapa: 'aguardando_sefaz', erro: 'não sei se chegou' }, { ok: true, etapa: 'aguardando_xml' }, NO_ML] });
    await n.f.consertarNF('777', '130772');
    assert.deepStrictEqual([n.obs.buscas.filter((u) => /criar/.test(u)).length, n.obs.buscas.filter((u) => /enviar/.test(u)).length, n.obs.esperas, /^✓/.test(n.el('nfc_777').textContent)], [1, 4, [20000, 20000, 20000], true], 'espera (com ok ou sem) e tenta de novo, 20 s entre uma e outra; a nota é criada UMA vez');
    const sempre = navegador({ criaEl: true, respostas: [OK_CRIAR].concat(Array(20).fill(ESPERA)) });
    await sempre.f.consertarNF('777', '130772');
    assert.deepStrictEqual([sempre.obs.buscas.filter((u) => /enviar/.test(u)).length, sempre.obs.buscas.filter((u) => /criar/.test(u)).length], [8, 1], 'não fica esperando pra sempre');
    assert.ok(/SEFAZ ainda não respondeu sobre a nota nova 130800/.test(sempre.el('nfc_777').textContent) && /não cria outra nota/.test(sempre.el('nfc_777').textContent) && sempre.f._nfConserto['777'].rodando === false);
    for (const [resp, re] of [[{ ok: false, etapa: 'ml_recusou', erro: 'o ML RECUSOU a nota nova: CEP da NF diferente' }, /nota nova 130800 criada, mas parou: o ML RECUSOU a nota nova: CEP da NF diferente$/],
      [{ ok: false, etapa: 'sefaz_rejeitou', erro: 'a SEFAZ REJEITOU a nota nova' }, /parou: a SEFAZ REJEITOU a nota nova$/], [{ ok: false, etapa: 'nota_de_teste', erro: 'nota de teste não é emitida' }, /parou: nota de teste/], [null, /parou: sem resposta do servidor$/],
      [{ ok: true, etapa: 'outra_coisa' }, /parou: outra_coisa$/]]) {
      const x = navegador({ criaEl: true, respostas: [OK_CRIAR, resp, NO_ML] });
      await x.f.consertarNF('777', '130772');
      assert.ok(x.obs.buscas.filter((u) => /enviar/.test(u)).length === 1 && /^✗/.test(x.el('nfc_777').textContent) && re.test(x.el('nfc_777').textContent) && x.obs.toasts.length === 0, 'o que não é espera para e diz: ' + x.el('nfc_777').textContent);
    }
    /* o texto do servidor entra como texto */
    const xss = navegador({ criaEl: true, respostas: [{ ok: false, erro: '<img src=x onerror=alert(1)>' }] });
    await xss.f.consertarNF('777', '130772');
    assert.ok(/<img src=x/.test(xss.el('nfc_777').textContent) && xss.el('nfc_777').innerHTML === '', 'o motivo vai por textContent, nunca por innerHTML');
  }

  /* ═══ 6. dois cliques e falha de rede ═══ */
  {
    let soltar = null;
    const n = navegador({ criaEl: true, respostas: [() => new Promise((ok) => { soltar = () => ok({ json: async () => OK_CRIAR }); }), NO_ML] });
    const p1 = n.f.consertarNF('777', '130772'); await tique();
    await n.f.consertarNF('777', '130772');
    assert.deepStrictEqual([n.obs.confirma.length, n.obs.buscas.filter((u) => /criar/.test(u)).length], [1, 1], 'o segundo clique, com o primeiro em andamento, não faz nada');
    const outra = n.f.consertarNF('555', '130001'); await tique();
    assert.strictEqual(n.obs.confirma.length, 2, 'outra nota não fica presa pela primeira');
    soltar(); await p1; await outra;
    const r = navegador({ criaEl: true, respostas: ['REDE', OK_CRIAR, 'REDE', OK_CRIAR, NO_ML] });
    await r.f.consertarNF('777', '130772');
    assert.ok(/falha de comunicação/.test(r.el('nfc_777').textContent) && r.f._nfConserto['777'].rodando === false, 'rede caiu no criar: diz e libera');
    await r.f.consertarNF('777', '130772');
    assert.ok(/falha de comunicação/.test(r.el('nfc_777').textContent) && r.f._nfConserto['777'].rodando === false, 'rede caiu no emitir: diz e libera');
    await r.f.consertarNF('777', '130772');
    assert.ok(/^✓/.test(r.el('nfc_777').textContent), 'e o clique seguinte termina o serviço');
    /* o elemento sumiu da tela (o aviso foi redesenhado): não estoura, e o texto fica guardado */
    const semEl = navegador({ respostas: [OK_CRIAR, NO_ML] });
    await semEl.f.consertarNF('777', '130772');
    assert.ok(/^✓/.test(semEl.f._nfConserto['777'].texto));
  }
  console.log('ok — conserto da NF, o botão no aviso do checkout: só admin e só em nota recusada pelo ML; um clique confirma, cria, emite (esperando a SEFAZ) e diz o resultado; criar falhou não emite; clique duplo e rede caída não bagunçam; texto do servidor entra como texto');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
