'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   ÍNDICE DAS NOTAS DE DEVOLUÇÃO: QUAL NOTA DE VENDA CADA UMA DEVOLVE (27/11/2026 — peça única, as três empresas)

   O dono, vendo no aviso um pedido cuja devolução ele já tinha feito à mão: "Vc não consegue mm confrontar com o Bling?".
   A sonda (lib/checkout/sonda-devolucao-nf, caso real: devolução 131176 da NF 131099, Girassol) respondeu:
     · nos CAMPOS da nota a API não diz de qual nota a devolução é;
     · no XML dela, sim: a tag <refNFe> traz a chave de acesso da nota de venda — e o servidor consegue ler o XML.

   Esta peça monta e guarda esse de-para: lista as notas de ENTRADA autorizadas do período (tipo=0, uma situação por vez —
   é assim que o resto do sistema lista notas), e de cada nota que ainda não conhece lê o detalhe (o link do XML) e o XML
   (as chaves referenciadas). CADA NOTA É LIDA UMA VEZ: o que foi lido fica no arquivo. Só leitura no Bling.

   O que NÃO vira resposta: lista que não veio, detalhe que não veio, XML que não é uma NF-e inteira (página de login,
   corpo vazio), redirecionamento (não é seguido). Nesses casos a nota fica SEM registro e é tentada de novo na rodada
   seguinte — até TENTATIVAS_MAX; depois disso é deixada de lado (com o motivo), pra não gastar cota pra sempre.
   Nada de gente é guardado: id e número da nota de entrada, e as chaves que ela referencia.

   criar({ cacheDir, fetch?, agora? }) → { atualizar({ desde, ler, leituras }), devolucaoDe(chave), ler(), ARQ }
     `ler(caminho)` = uma ida ao Bling já com prazo (a vigia passa a dela); devolve o que o blingGet devolve.
   ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');

const ARQ = 'devolucoes-indice.json';
const SITUACOES = [5, 6, 7];      /* autorizada, emitida DANFE, registrada — as que valem */
const PAGINAS_MAX = 5;            /* por situação */
const TENTATIVAS_MAX = 5;         /* nota cujo XML não se deixa ler */
const GUARDA_DIAS = 200;

const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');

/* as chaves em <refNFe> de um XML de NF-e. → { refs } ou { falhou: motivo } (falha nunca é "sem referência") */
async function refsDoXml(link, busca) {
  let host = null;
  try { const u = new URL(String(link)); host = u.protocol === 'https:' ? u.host : null; } catch (e) { host = null; }
  if (!host || !/(^|\.)bling\.com\.br$/.test(host)) return { falhou: 'link_de_fora' };
  let r = null;
  try { r = await busca(String(link), { timeout: 15000, redirect: 'manual' }); } catch (e) { return { falhou: 'rede' }; }
  if (!r || !r.ok) return { falhou: 'http_' + ((r && r.status) || 0) };
  let txt = '';
  try { txt = String(await r.text()); } catch (e) { return { falhou: 'corpo' }; }
  if (!/<infNFe[\s>]/.test(txt) || !/<\/infNFe>/.test(txt)) return { falhou: 'nao_e_nfe' };
  return { refs: [...new Set([...txt.matchAll(/<refNFe>\s*(\d{44})\s*<\/refNFe>/g)].map((m) => m[1]))].slice(0, 20) };
}

function criar(o) {
  if (!o || !o.cacheDir) throw new Error('lib/checkout/devolucoes-indice: falta cacheDir');
  const arq = path.join(String(o.cacheDir), ARQ);
  const agora = o.agora || (() => Date.now());
  const dia = (t) => new Date(t).toISOString().slice(0, 10);

  function ler() {
    try { const d = JSON.parse(fs.readFileSync(arq, 'utf8')); return d && typeof d === 'object' && !Array.isArray(d) && d.notas && typeof d.notas === 'object' && !Array.isArray(d.notas) ? d : { notas: {} }; }
    catch (e) { if (e && e.code === 'ENOENT') return { notas: {} }; throw e; }
  }
  function gravar(d) { const tmp = arq + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(d)); fs.renameSync(tmp, arq); }

  /* atualizar({ desde: 'AAAA-MM-DD', ler, leituras }) → resumo. `leituras` = teto de DETALHES de nota lidos nesta rodada. */
  async function atualizar(op) {
    const desde = op && /^\d{4}-\d{2}-\d{2}$/.test(String(op.desde || '')) ? String(op.desde) : null;
    const resumo = { ok: true, listadas: 0, novas: 0, lidas: 0, com_referencia: 0, sem_ler: 0, ficaram_pra_proxima: 0 };
    if (!desde || !op || typeof op.ler !== 'function') return { ok: false, etapa: 'parametros' };
    const _t = Math.floor(Number(op.leituras)); const teto = _t >= 1 ? Math.min(200, _t) : 20;
    const t0 = agora();
    const ate = dia(t0 + 864e5);   /* até amanhã: com dataFinal = hoje o Bling omite o que é do dia */
    const idx = ler();
    const corte = t0 - GUARDA_DIAS * 864e5;
    for (const k of Object.keys(idx.notas)) { const t = Date.parse(idx.notas[k] && idx.notas[k].visto_em); if (!(t >= corte)) delete idx.notas[k]; }
    const achadas = new Map();
    let parou = false;
    for (const sit of SITUACOES) {
      if (parou) break;
      for (let pag = 1; pag <= PAGINAS_MAX; pag++) {
        let r = null; try { r = await op.ler('/nfe?tipo=0&situacao=' + sit + '&dataEmissaoInicial=' + desde + '&dataEmissaoFinal=' + ate + '&limite=100&pagina=' + pag); } catch (e) { r = null; }
        if (!r || !r.ok || !r.data || !Array.isArray(r.data.data)) { resumo.lista_incompleta = 'situação ' + sit + ', página ' + pag + ' (' + (r && r.prazo ? 'passou do prazo' : ((r && r.status) || 'sem resposta')) + ')'; if (r && r.prazo) parou = true; break; }
        for (const n of r.data.data) { const id = n && n.id != null && /^\d{1,20}$/.test(String(n.id)) ? String(n.id) : null; if (id) achadas.set(id, n); }
        if (r.data.data.length < 100) break;
      }
    }
    resumo.listadas = achadas.size;
    let gastas = 0;
    for (const [id, n] of achadas) {
      const ant = idx.notas[id];
      if (ant && (Array.isArray(ant.refs) || ant.tentativas >= TENTATIVAS_MAX)) continue;   /* já lida (ou deixada de lado) */
      resumo.novas++;
      if (parou || gastas >= teto) { resumo.ficaram_pra_proxima++; continue; }
      gastas++;
      const base = { numero: n.numero != null ? String(n.numero).slice(0, 20) : null, visto_em: new Date(t0).toISOString() };
      const falhou = (motivo) => { idx.notas[id] = Object.assign(base, { tentativas: ((ant && ant.tentativas) || 0) + 1, motivo }); resumo.sem_ler++; };
      let d = null; try { d = await op.ler('/nfe/' + id); } catch (e) { d = null; }
      if (d && d.prazo) { parou = true; falhou('detalhe_prazo'); continue; }
      const det = d && d.ok && d.data && d.data.data && typeof d.data.data === 'object' ? d.data.data : null;
      if (!det || String(det.id) !== id) { falhou('detalhe_http_' + ((d && d.status) || 0)); continue; }
      const x = await refsDoXml(det.xml, o.fetch || require('node-fetch'));
      if (!x.refs) { falhou('xml_' + x.falhou); continue; }
      idx.notas[id] = Object.assign(base, { refs: x.refs });
      resumo.lidas++; if (x.refs.length) resumo.com_referencia++;
    }
    if (parou) resumo.parou_no_prazo = true;
    idx.atualizado_em = new Date(t0).toISOString();
    gravar(idx);
    return resumo;
  }

  /* a nota de entrada que referencia esta chave (a de venda), ou null. Lê do arquivo; arquivo ilegível = não sei = null. */
  function devolucaoDe(chave) {
    const k = soDig(chave);
    if (k.length !== 44) return null;
    let idx = null; try { idx = ler(); } catch (e) { return null; }
    for (const id of Object.keys(idx.notas)) { const n = idx.notas[id]; if (n && Array.isArray(n.refs) && n.refs.includes(k)) return { id, numero: n.numero || null }; }
    return null;
  }

  return { atualizar, devolucaoDe, ler, ARQ };
}

module.exports = { criar, refsDoXml, ARQ, SITUACOES, TENTATIVAS_MAX };
