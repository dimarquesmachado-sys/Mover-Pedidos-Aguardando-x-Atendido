'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   COMPRAS — A SONDA DOS FORNECEDORES NO BLING (26/11/2026).

   Pra lançar o Pedido de Compra pelo Plano de Compra, a tela vai precisar achar o FORNECEDOR no cadastro de contatos do
   Bling. Antes de escrever essa tela, falta saber — do Bling de verdade, não de suposição — três coisas:
     1. quais TIPOS de contato a empresa tem (e qual é o de fornecedor);
     2. se a lista de contatos aceita o filtro por tipo (`idTipoContato`);
     3. se aceita a busca por texto (`pesquisa`).
   O dono não conseguiu rodar o comando no Shell do Render; esta peça faz as mesmas perguntas por uma rota.

   sondarFornecedores(blingGet, { q, prazoMs }) → Promise
     { tipos: { status, lista:[{ id, descricao }] | null },
       sem_filtro: { status, n },                                  // 1ª página (até 100), sem filtro
       por_tipo: { status, n, tipo:{ id, descricao } } | null,     // filtrado pelo tipo cujo nome tem "fornecedor"
       pesquisa: { status, n, com_o_texto } | null,                // só quando veio `q`
       motivo: texto | null }                                      // preenchido quando parou no meio (prazo, sem acesso)
   `n` = quantos contatos vieram na página; `com_o_texto` = em quantos deles o nome contém o que foi buscado.

   ⚠️ Nunca devolve dado de gente: nem nome, nem documento, nem telefone de contato — só CONTAGENS, códigos HTTP e os
   tipos de contato (nome de categoria: "Fornecedor", "Cliente"…), aparados. O texto buscado não volta na resposta.
   Tem PRAZO (30 s no total, com cancelamento): o blingGet de produção não tem prazo próprio. As perguntas vão uma de
   cada vez (o limite do Bling é por segundo). É sonda, não rotina: uma tentativa de cada; o que falhar sai com o código.
   ───────────────────────────────────────────────────────────────────────── */

const PRAZO_MS = 30000;
const POR_PAGINA = 100;
const LISTA = '/contatos?pagina=1&limite=' + POR_PAGINA;

function semAcento(t) { return String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
function statusDe(r) { return (r && typeof r === 'object' && Number.isFinite(Number(r.status))) ? Number(r.status) : null; }
function listaDe(r) { return (r && typeof r === 'object' && r.ok && r.data && Array.isArray(r.data.data)) ? r.data.data : null; }
/* o nome de um tipo de contato é nome de categoria; ainda assim sai aparado e sem nada além de letras, números e pontuação simples */
function tipoLimpo(t) {
  if (!t || typeof t !== 'object' || t.id == null || !/^\d{1,20}$/.test(String(t.id))) return null;
  const d = String(t.descricao == null ? '' : t.descricao).replace(/[^\p{L}\p{N} .\-\/()]/gu, '').trim().slice(0, 40);
  return { id: String(t.id), descricao: d };
}

async function sondarFornecedores(blingGet, opcoes) {
  const o = opcoes || {};
  const saida = { tipos: { status: null, lista: null }, sem_filtro: { status: null, n: null }, por_tipo: null, pesquisa: null, motivo: null };
  if (typeof blingGet !== 'function') { saida.motivo = 'sem acesso ao Bling nesta empresa'; return saida; }
  const prazoMs = Number(o.prazoMs) > 0 ? Number(o.prazoMs) : PRAZO_MS;
  const q = String(o.q == null ? '' : o.q).trim().slice(0, 60);
  const ctl = new AbortController();
  const ESTOUROU = {};
  let timer = null;
  const prazo = new Promise((ok) => { timer = setTimeout(() => { ctl.abort(); ok(ESTOUROU); }, prazoMs); });
  const perguntar = async (caminho) => {
    let r;
    try { r = await Promise.race([Promise.resolve().then(() => blingGet(caminho, 1, ctl.signal)), prazo]); } catch (e) { r = null; }
    if (r === ESTOUROU) throw ESTOUROU;
    return r;
  };
  try {
    const rt = await perguntar('/contatos/tipos');
    const tipos = listaDe(rt);
    saida.tipos = { status: statusDe(rt), lista: tipos ? tipos.map(tipoLimpo).filter(Boolean) : null };

    const rs = await perguntar(LISTA);
    const todos = listaDe(rs);
    saida.sem_filtro = { status: statusDe(rs), n: todos ? todos.length : null };

    const tipoForn = (saida.tipos.lista || []).filter((t) => semAcento(t.descricao).includes('fornecedor'))[0] || null;
    if (tipoForn) {
      const rp = await perguntar(LISTA + '&idTipoContato=' + encodeURIComponent(tipoForn.id));
      const doTipo = listaDe(rp);
      saida.por_tipo = { status: statusDe(rp), n: doTipo ? doTipo.length : null, tipo: tipoForn };
    }
    if (q) {
      const rq = await perguntar(LISTA + '&pesquisa=' + encodeURIComponent(q));
      const achados = listaDe(rq);
      const alvo = semAcento(q);
      saida.pesquisa = { status: statusDe(rq), n: achados ? achados.length : null,
        com_o_texto: achados ? achados.filter((c) => c && semAcento(c.nome).includes(alvo)).length : null };
    }
  } catch (e) {
    if (e !== ESTOUROU) throw e;
    saida.motivo = 'o Bling não respondeu em ' + Math.round(prazoMs / 1000) + ' s — o que já tinha vindo está acima; tente de novo';
  } finally { clearTimeout(timer); }
  return saida;
}

module.exports = { sondarFornecedores, PRAZO_MS, LISTA };
