'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   DECISÃO DE CUSTO DE UM PRODUTO — extraída do checkout em 11/09/2026.

   Por que existe: o custo do kit levou QUATRO PRs pra ficar certo (10/09) porque
   a lógica vivia solta dentro de um arquivo de 9 mil linhas e não havia como
   testá-la sem subir o serviço e falar com o Bling. Os bugs eram todos da mesma
   família — quem decide o custo quando há mais de uma fonte:

     · o endpoint de fornecedores rodava ANTES da composição e a soma nunca
       acontecia (kit nenhum absorvia mudança de custo de componente);
     · o retrato embutido na estrutura ganhava do nosso banco;
     · o banco só era consultado por SKU, e a estrutura traz só o ID;
     · composição truncada no teto virava custo bom;
     · componente que é kit tinha o custo tirado do fornecedor DELE.

   A regra, agora em um lugar só e coberta por teste:
     1. produto SEM composição → campos do próprio produto, senão fornecedor;
     2. produto COM composição → a COMPOSIÇÃO MANDA; fornecedor é RESERVA e só
        entra quando ela não fecha;
     3. componente resolve nesta ordem: nosso banco (por SKU ou por ID) → memo
        da varredura → consulta ao produto → retrato embutido na estrutura;
     4. componente que é kit: soma a composição DELE antes de aceitar o
        fornecedor dele (uma camada, sem chamada nova);
     5. composição acima do teto NÃO vira custo — declara incompleta.

   Nada aqui fala com a rede: quem consulta é o chamador, por injeção
   (`consultarProduto`), o que deixa o teste exercitar a função de produção.
   ──────────────────────────────────────────────────────────────────────────── */

const TETO_COMPONENTES = 30;

function _num(v) { const n = Number(v); return isFinite(n) && n > 0 ? n : null; }

function _primeiro(lista) {
  for (const v of lista) { const n = _num(v); if (n != null) return n; }
  return null;
}

function componentesDe(prod) {
  if (!prod) return null;
  const c = (prod.estrutura && (prod.estrutura.componentes || prod.estrutura.itens))
         || prod.composicao || prod.componentes || null;
  return Array.isArray(c) && c.length ? c : null;
}

function _idDe(cp) { return (cp.produto && cp.produto.id) || cp.idProduto || cp.id || null; }
function _skuDe(cp) { return String((cp.produto && cp.produto.codigo) || cp.codigo || '').trim(); }
function _qtdDe(cp) { return Number(cp.quantidade != null ? cp.quantidade : (cp.qtd != null ? cp.qtd : 1)) || 1; }
function _embutido(cp) {
  return _primeiro([cp.precoCusto, cp.custo, cp.valorCusto,
                    cp.produto && cp.produto.precoCusto, cp.produto && cp.produto.custo]);
}

/* nosso banco, por SKU ou por ID — o ID importa porque a estrutura do Bling
   normalmente não traz o código do componente */
function custoDoBanco(banco, sku, id) {
  if (!banco) return null;
  if (sku && banco[sku] && _num(banco[sku].custo) != null) return _num(banco[sku].custo);
  if (id != null) {
    for (const k of Object.keys(banco)) {
      if (k.startsWith('_')) continue;
      const v = banco[k];
      if (v && String(v.id) === String(id) && _num(v.custo) != null) return _num(v.custo);
    }
  }
  return null;
}

/* soma uma composição SEM rede: só banco, memo e retrato embutido.
   Usada para a camada aninhada (kit dentro de kit). */
function somarComposicaoOffline(comps, ctx) {
  if (!Array.isArray(comps) || !comps.length || comps.length > TETO_COMPONENTES) return null;
  let soma = 0;
  for (const cp of comps) {
    const id = _idDe(cp);
    let cu = custoDoBanco(ctx.banco, _skuDe(cp), id);
    if (cu == null && id != null && ctx.memo && ctx.memo.has(String(id))) cu = _num(ctx.memo.get(String(id)));
    if (cu == null) cu = _embutido(cp);
    if (cu == null) return null;         // não fecha: quem chamou decide a reserva
    soma += cu * _qtdDe(cp);
  }
  return soma > 0 ? Math.round(soma * 10000) / 10000 : null;
}

/* custo de UM componente do kit de cima — pode gastar uma consulta */
async function custoDeComponente(cp, ctx) {
  const id = _idDe(cp);
  const sku = _skuDe(cp);

  let cu = custoDoBanco(ctx.banco, sku, id);
  if (cu != null) return { custo: cu, via: 'banco' };

  if (id != null && ctx.memo && ctx.memo.has(String(id))) {
    const m = _num(ctx.memo.get(String(id)));
    if (m != null) return { custo: m, via: 'memo' };
  }

  if (id != null && typeof ctx.consultarProduto === 'function') {
    const r = await ctx.consultarProduto(id);
    if (!r || !r.ok) {
      const emb0 = _embutido(cp);
      return emb0 != null
        ? { custo: emb0, via: 'embutido', falhaConsulta: true }
        : { custo: null, via: 'consulta-falhou', falhaConsulta: true };
    }
    const pc = r.produto || null;
    if (pc) {
      const aninhados = componentesDe(pc);
      if (aninhados) {
        const somaN = somarComposicaoOffline(aninhados, ctx);
        if (somaN != null) {
          if (id != null && ctx.memo) ctx.memo.set(String(id), somaN);
          return { custo: somaN, via: 'composicao-aninhada' };
        }
      }
      const f = pc.fornecedor || {};
      const doProduto = _primeiro([f.precoCusto, f.precoCompra, pc.precoCusto, pc.custo]);
      if (doProduto != null) {
        if (id != null && ctx.memo) ctx.memo.set(String(id), doProduto);
        return { custo: doProduto, via: 'consulta' };
      }
    }
  }

  const emb = _embutido(cp);
  if (emb != null) return { custo: emb, via: 'embutido' };
  return { custo: null, via: 'sem-custo' };
}

/* a decisão inteira de um produto */
async function decidirCustoDoProduto(prod, ctx) {
  const comps = componentesDe(prod);
  const camposDoProduto = () => _primeiro([
    (prod.fornecedor || {}).precoCusto, (prod.fornecedor || {}).precoCompra,
    (prod.fornecedor || {}).preco, (prod.fornecedor || {}).custo,
    prod.precoCusto, prod.custo, prod.precoCompra,
  ]);

  if (!comps) {
    const c = camposDoProduto();
    if (c != null) return { custo: c, via: 'campos-do-produto', completo: true };
    if (typeof ctx.consultarFornecedores === 'function') {
      const f = await ctx.consultarFornecedores();
      const c2 = _num(f);
      if (c2 != null) return { custo: c2, via: 'fornecedores', completo: true };
    }
    return { custo: null, via: 'sem-custo', completo: false };
  }

  if (comps.length > TETO_COMPONENTES) {
    const reserva = camposDoProduto();
    return { custo: reserva, via: reserva != null ? 'reserva-teto' : 'sem-custo', completo: false, motivo: 'composicao com ' + comps.length + ' componentes (teto ' + TETO_COMPONENTES + ')' };
  }

  let soma = 0, falhaConsulta = false;
  for (const cp of comps) {
    const r = await custoDeComponente(cp, ctx);
    if (r.falhaConsulta) falhaConsulta = true;
    if (r.custo == null) {
      const reserva = camposDoProduto();
      return { custo: reserva, via: reserva != null ? 'reserva-composicao-incompleta' : 'sem-custo', completo: false, falhaConsulta, motivo: 'componente sem custo' };
    }
    soma += r.custo * _qtdDe(cp);
  }
  if (soma > 0) return { custo: Math.round(soma * 10000) / 10000, via: 'composicao', completo: true, falhaConsulta };
  const reserva = camposDoProduto();
  return { custo: reserva, via: reserva != null ? 'reserva-soma-zero' : 'sem-custo', completo: false, falhaConsulta };
}

module.exports = { decidirCustoDoProduto, custoDeComponente, somarComposicaoOffline, custoDoBanco, componentesDe, TETO_COMPONENTES };
