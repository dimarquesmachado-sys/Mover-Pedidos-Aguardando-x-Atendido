'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   COMPRAS — O QUE ESTÁ A CAMINHO (24/11/2026): os Pedidos de Compra em aberto no Bling, somados por SKU.

   O dono: "informar o estoque vindo. acho bem legal, e com alguma previsão de data da chegada". O Plano de Compra
   mandava comprar a necessidade inteira mesmo com um contêiner já pedido. O "a caminho" mora no Bling, como Pedido de
   Compra (a Sugestão de Compras do próprio Bling lê o mesmo dado); quando a mercadoria entra pela nota e o pedido é
   atendido, sai daqui sozinho.

   O formato foi LIDO do Bling da Girassol em 24/11 (pedido de teste nº 1), não suposto:
     lista    GET /pedidos/compras?pagina=&limite=   → data[]: { id, numero, data, dataPrevista, total, fornecedor:{id},
                                                        situacao:{ id, valor } }            (sem os itens)
     detalhe  GET /pedidos/compras/{id}             → data: { ..., itens[]: { quantidade, valor, produto:{ id, codigo },
                                                        notaFiscal:{ id, quantidade } } }
   `situacao.valor`: 0 Em aberto · 1 Atendido · 2 Cancelado · 3 Em andamento. A caminho = 0 e 3.
   `itens[].notaFiscal.quantidade` = o que já entrou por nota: o pendente do item é quantidade − isso.

   somarACaminho(pedidos, hoje) → { porSku, itensSemCodigo }          (pura: sem rede, sem relógio)
       porSku[sku] = { qtd, chega, atrasado, sem_data, pedidos:[numero] }
       `chega` é a data prevista MAIS PRÓXIMA entre os pedidos daquele SKU; `atrasado` quando ela já passou;
       `sem_data` quando algum pedido dele não tem data prevista.

   lerACaminho(blingGet, { hoje, maxPaginas, maxPedidos }) → Promise
       { ok:true, porSku, pedidos, incompleto, itens_sem_codigo }  ou  { ok:false, motivo }
       Qualquer falha (lista OU um detalhe) é "NÃO SEI" — nunca uma soma pela metade com cara de inteira: descontar
       menos do que está a caminho faria o plano mandar comprar de novo. `incompleto` avisa quando os tetos cortaram.
   ───────────────────────────────────────────────────────────────────────────── */

const SITUACOES_A_CAMINHO = [0, 3];
const POR_PAGINA = 100;
const PRAZO_MS = 45000;

function diaValido(t) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(t == null ? '' : t).trim());
  if (!m) return null;
  const d = m[1] + '-' + m[2] + '-' + m[3];
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return (Number(m[1]) >= 2000 && new Date(ms).toISOString().slice(0, 10) === d) ? d : null;
}

function aCaminho(situacao) {
  const v = situacao && situacao.valor;
  return typeof v === 'number' && SITUACOES_A_CAMINHO.includes(v);
}

/* o que ainda não chegou de um item: a quantidade pedida menos o que já entrou por nota */
function pendenteDoItem(it) {
  const q = Number(it && it.quantidade);
  if (!isFinite(q) || q <= 0) return 0;
  const nf = Number(it && it.notaFiscal && it.notaFiscal.quantidade);
  return Math.max(0, q - (isFinite(nf) && nf > 0 ? nf : 0));
}

function somarACaminho(pedidos, hoje) {
  const porSku = {};
  let itensSemCodigo = 0;
  const hj = diaValido(hoje);
  for (const p of (Array.isArray(pedidos) ? pedidos : [])) {
    if (!p || !aCaminho(p.situacao)) continue;
    const prev = diaValido(p.dataPrevista);
    for (const it of (Array.isArray(p.itens) ? p.itens : [])) {
      const qtd = pendenteDoItem(it);
      if (!(qtd > 0)) continue;
      const sku = String((it && it.produto && it.produto.codigo) == null ? '' : it.produto.codigo).trim();
      if (!sku) { itensSemCodigo++; continue; }
      const e = porSku[sku] || (porSku[sku] = { qtd: 0, chega: null, atrasado: false, sem_data: false, pedidos: [] });
      e.qtd += qtd;
      if (prev) { if (!e.chega || prev < e.chega) e.chega = prev; } else e.sem_data = true;
      if (p.numero != null && !e.pedidos.includes(p.numero)) e.pedidos.push(p.numero);
    }
  }
  for (const k of Object.keys(porSku)) porSku[k].atrasado = !!(hj && porSku[k].chega && porSku[k].chega < hj);
  return { porSku, itensSemCodigo };
}

function motivoDaFalha(r, oque) {
  const st = r && Number.isFinite(Number(r.status)) ? Number(r.status) : null;
  if (st === 403) return 'falta a permissão de Pedidos de Compra no app desta empresa no Bling';
  if (st === 429) return 'limite do Bling ao ler ' + oque + ' — tente de novo daqui a pouco';
  if (st === 401) return 'token do Bling recusado ao ler ' + oque;
  return 'o Bling não respondeu ' + oque + (st == null ? '' : ' (' + st + ')');
}

async function lerACaminho(blingGet, opcoes) {
  if (typeof blingGet !== 'function') return { ok: false, motivo: 'sem acesso ao Bling nesta empresa' };
  const o = opcoes || {};
  const maxPaginas = Number(o.maxPaginas) > 0 ? Number(o.maxPaginas) : 10;
  const maxPedidos = Number(o.maxPedidos) > 0 ? Number(o.maxPedidos) : 40;
  /* Codex #978: a leitura inteira (lista + detalhes) tem um PRAZO; estourou → aborta o fetch em andamento e vira
     "não sei". Sem isso um Bling que aceita a conexão e não responde prendia _caminhoEmVoo pra sempre. */
  const prazoMs = Number(o.prazoMs) > 0 ? Number(o.prazoMs) : PRAZO_MS;
  const ctl = new AbortController();
  const ESTOUROU = { estourou: true };
  let timer = null;
  const prazo = new Promise((ok) => { timer = setTimeout(() => { ctl.abort(); ok(ESTOUROU); }, prazoMs); });
  const pedir = async (caminho) => {
    if (ctl.signal.aborted) return ESTOUROU;
    try { return await Promise.race([Promise.resolve().then(() => blingGet(caminho, 3, ctl.signal)), prazo]); } catch (e) { return null; }
  };
  const falha = (r, oque) => r === ESTOUROU
    ? { ok: false, motivo: 'o Bling não respondeu em ' + Math.round(prazoMs / 1000) + ' s ao ler ' + oque + ' — tente de novo' }
    : { ok: false, motivo: motivoDaFalha(r, oque) };
  try { return await _ler(pedir, falha, o, maxPaginas, maxPedidos); }
  finally { clearTimeout(timer); }
}

async function _ler(pedir, falha, o, maxPaginas, maxPedidos) {
  let abertos = [], incompleto = false;
  for (let pg = 1; ; pg++) {
    const r = await pedir('/pedidos/compras?pagina=' + pg + '&limite=' + POR_PAGINA);
    const lista = r && r.ok && r.status === 200 && r.data && Array.isArray(r.data.data) ? r.data.data : null;
    if (!lista) return falha(r, 'a lista de pedidos de compra');
    abertos = abertos.concat(lista.filter((p) => p && p.id != null && aCaminho(p.situacao)));
    if (lista.length < POR_PAGINA) break;
    if (pg >= maxPaginas) { incompleto = true; break; }
  }
  if (abertos.length > maxPedidos) { abertos = abertos.slice(0, maxPedidos); incompleto = true; }
  const detalhes = [];
  for (const p of abertos) {
    const r = await pedir('/pedidos/compras/' + encodeURIComponent(p.id));
    const d = r && r.ok && r.status === 200 && r.data && r.data.data && typeof r.data.data === 'object' && !Array.isArray(r.data.data) ? r.data.data : null;
    if (!d || !Array.isArray(d.itens)) return falha(r, 'um pedido de compra');
    detalhes.push(d);
  }
  const s = somarACaminho(detalhes, o.hoje);
  return { ok: true, porSku: s.porSku, pedidos: detalhes.filter((d) => aCaminho(d.situacao)).length, incompleto, itens_sem_codigo: s.itensSemCodigo };
}

/* quantos dias faltam de `hoje` até `dia` (os dois AAAA-MM-DD); data torta → null; já passou → 0 */
function diasAte(hoje, dia) {
  const a = diaValido(hoje), b = diaValido(dia);
  if (!a || !b) return null;
  return Math.max(0, Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000));
}

module.exports = { somarACaminho, lerACaminho, pendenteDoItem, diaValido, diasAte, SITUACOES_A_CAMINHO, POR_PAGINA, PRAZO_MS };
