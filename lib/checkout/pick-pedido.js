'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   O QUE O ESTOQUISTA PEGA, COM A QUANTIDADE (07/11/2026, pedido do dono). A lista da esquerda do checkout mostrava
   "SKU · 1 item(s)" — o número de LINHAS do pedido. Kit de 3 lixas (30-AE-8F-125mm-KIT80) aparecia "1 item(s)" e o
   estoquista tinha que pegar 3 peças diferentes; pendente com 2 unidades (LTJ30-CINZA-B) também aparecia "1 item(s)".
   Isso confundia. Aqui sai a lista REAL do que pegar: kit/composição vira os componentes (a quantidade do componente já
   vem multiplicada pela do kit no pedido — ciclo-empresa), item normal é ele mesmo com a quantidade; SKU repetido soma.

   listaDoQuePegar(itens do pedido.json) → { pick: [{ sku, qtd }] (na ordem do pedido), unidades (total), kits: [SKUs dos kits] } */
function listaDoQuePegar(itens) {
  const ordem = [];
  const soma = new Map();
  const kits = [];
  let unidades = 0;
  for (const it of (Array.isArray(itens) ? itens : [])) {
    if (!it) continue;
    const ehKit = it.tipo === 'kit' && Array.isArray(it.componentes) && it.componentes.length > 0;
    if (ehKit && it.sku) kits.push(String(it.sku));
    const linhas = ehKit ? it.componentes.map((c) => ({ sku: c && c.sku, qtd: c && c.qtd })) : [{ sku: it.sku, qtd: it.qtd }];
    for (const l of linhas) {
      const sku = String(l.sku == null ? '' : l.sku).trim();
      if (!sku) continue;
      const q = Number(l.qtd) > 0 ? Number(l.qtd) : 1;
      if (!soma.has(sku)) { soma.set(sku, 0); ordem.push(sku); }
      soma.set(sku, soma.get(sku) + q);
      unidades += q;
    }
  }
  return { pick: ordem.map((sku) => ({ sku, qtd: soma.get(sku) })), unidades, kits };
}

module.exports = { listaDoQuePegar };
