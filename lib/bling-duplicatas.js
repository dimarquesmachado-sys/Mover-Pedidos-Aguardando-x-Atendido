'use strict';

/**
 * lib/bling-duplicatas.js — caçar venda duplicada no Bling (01/09).
 *
 * O caso: agosto/2026 da AMB fecha R$ 259 mil no Bling, R$ 208 mil no Jodda e R$ 207 mil no
 * nosso dashboard. Os dois independentes concordam, então a sobra está no Bling — e a
 * suspeita do dono é venda importada duas vezes.
 *
 * Como procura, do sinal mais forte pro mais fraco:
 *   1. MESMO NÚMERO DE VENDA no marketplace em pedidos diferentes — é duplicata quase certa,
 *      porque o número vem do canal e não deveria repetir;
 *   2. mesmo cliente + mesmo valor + mesma data — o critério que o dono descreveu;
 *   3. mesmo cliente + mesmo valor em datas próximas (até 2 dias), que pega a importação
 *      repetida que caiu no dia seguinte.
 * O nível 1 é conclusivo; 2 e 3 são suspeitas e precisam de olho humano, porque cliente
 * recorrente comprando o mesmo item de novo é normal.
 *
 * Multi-empresa: recebe o leitor do Bling por parâmetro, como as outras libs.
 */

const r2 = v => Math.round((Number(v) || 0) * 100) / 100;

async function procurar(blingGet, de, ate, opcoes) {
  const o = opcoes || {};
  const limitePaginas = Math.min(200, Math.max(1, Number(o.paginas) || 60));
  const pedidos = [];
  let pagina = 1, erro = null;
  while (pagina <= limitePaginas) {
    let r = null;
    try {
      r = await blingGet('/pedidos/vendas?dataInicial=' + de + '&dataFinal=' + ate + '&pagina=' + pagina + '&limite=100');
    } catch (e) { erro = String(e.message || e).slice(0, 140); break; }
    const lista = (r && r.data) || (r && r.retorno && r.retorno.vendas) || [];
    if (!Array.isArray(lista) || !lista.length) break;
    for (const p of lista) {
      pedidos.push({
        id: p.id, numero: p.numero,
        numero_loja: String(p.numeroPedidoLoja || p.numeroLoja || '').trim() || null,
        data: String(p.data || '').slice(0, 10),
        total: r2(p.total || p.totalProdutos),
        cliente: (p.contato && (p.contato.nome || p.contato.id)) || null,
        doc: (p.contato && (p.contato.numeroDocumento || p.contato.documento)) || null,
        situacao: (p.situacao && (p.situacao.valor != null ? p.situacao.valor : p.situacao.id)) || null,
      });
    }
    if (lista.length < 100) break;
    pagina++;
    await new Promise(s => setTimeout(s, 200));
  }

  /* 1) mesmo número de venda do marketplace — o sinal forte */
  const porLoja = {};
  for (const p of pedidos) {
    if (!p.numero_loja) continue;
    (porLoja[p.numero_loja] = porLoja[p.numero_loja] || []).push(p);
  }
  const mesmoNumeroLoja = Object.keys(porLoja).filter(k => porLoja[k].length > 1)
    .map(k => ({ numero_loja: k, qtd: porLoja[k].length, valor_repetido: r2(porLoja[k].slice(1).reduce((s, p) => s + p.total, 0)), pedidos: porLoja[k] }));

  /* 2) mesmo cliente + valor + data */
  const chave = (p) => [p.doc || p.cliente || '?', p.total.toFixed(2), p.data].join('|');
  const porChave = {};
  for (const p of pedidos) (porChave[chave(p)] = porChave[chave(p)] || []).push(p);
  const jaVistos = new Set(mesmoNumeroLoja.flatMap(g => g.pedidos.map(p => p.id)));
  const mesmoDia = Object.keys(porChave).filter(k => porChave[k].length > 1)
    .map(k => porChave[k]).filter(g => g.some(p => !jaVistos.has(p.id)))
    .map(g => ({ cliente: g[0].cliente, valor: g[0].total, data: g[0].data, qtd: g.length,
                 valor_repetido: r2(g.slice(1).reduce((s, p) => s + p.total, 0)), pedidos: g }));

  /* 3) mesmo cliente + valor em até 2 dias */
  const chave2 = (p) => [p.doc || p.cliente || '?', p.total.toFixed(2)].join('|');
  const porChave2 = {};
  for (const p of pedidos) (porChave2[chave2(p)] = porChave2[chave2(p)] || []).push(p);
  const jaVistos2 = new Set([...jaVistos, ...mesmoDia.flatMap(g => g.pedidos.map(p => p.id))]);
  const diasProximos = [];
  for (const k of Object.keys(porChave2)) {
    const g = porChave2[k].slice().sort((a, b) => a.data.localeCompare(b.data));
    if (g.length < 2) continue;
    const pares = [];
    for (let i = 1; i < g.length; i++) {
      const d1 = Date.parse(g[i - 1].data), d2 = Date.parse(g[i].data);
      const dias = Math.abs(d2 - d1) / 86400000;
      if (dias > 0 && dias <= 2 && !jaVistos2.has(g[i].id)) pares.push([g[i - 1], g[i]]);
    }
    for (const par of pares) diasProximos.push({ cliente: par[0].cliente, valor: par[0].total,
      datas: [par[0].data, par[1].data], valor_repetido: par[1].total, pedidos: par });
  }

  const soma = (arr) => r2(arr.reduce((s, g) => s + (g.valor_repetido || 0), 0));
  return {
    periodo: { de, ate }, paginas_lidas: pagina, pedidos_lidos: pedidos.length, erro,
    total_do_periodo: r2(pedidos.reduce((s, p) => s + p.total, 0)),
    /* o que provavelmente está sobrando */
    duplicatas_certas: mesmoNumeroLoja.length, valor_duplicatas_certas: soma(mesmoNumeroLoja),
    suspeitas_mesmo_dia: mesmoDia.length, valor_suspeitas_mesmo_dia: soma(mesmoDia),
    suspeitas_dias_proximos: diasProximos.length, valor_suspeitas_dias_proximos: soma(diasProximos),
    lista_duplicatas_certas: mesmoNumeroLoja.slice(0, 100),
    lista_suspeitas_mesmo_dia: mesmoDia.slice(0, 100),
    lista_suspeitas_dias_proximos: diasProximos.slice(0, 100),
    leia: 'duplicatas_certas = o MESMO número de venda do marketplace em pedidos diferentes (o número vem do canal, não deveria repetir). As suspeitas precisam de olho humano: cliente recorrente comprando o mesmo item de novo é normal.',
  };
}

module.exports = { procurar };
