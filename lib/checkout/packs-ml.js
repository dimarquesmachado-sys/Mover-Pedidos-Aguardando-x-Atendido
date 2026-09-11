'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   PACKS DO ML (carrinho) — fatia 4 da desduplicação (11/09).

   Pequena de propósito. A maior sobra (331 linhas) é o CUSTO DIÁRIO, que estreou
   ontem e roda hoje às 23h: mexer nele numa sexta à noite, sem teste que o
   cubra, arrisca a margem do dia por nada. Fica pra quando houver teste antes.

   Estas 29 linhas eram iguais nas duas empresas e resolvem uma coisa só: quando
   o comprador leva vários itens no mesmo carrinho, o ML manda um pedido por
   item com o mesmo `pack_id` — e o checkout precisa saber quais números de
   pedido são irmãos, pra não cobrar frete de novo nem separar em duas caixas.
   ──────────────────────────────────────────────────────────────────────────── */

function criar(deps) {
  /* deps reais, lidas do código (não supostas): o banco de tarifas do ML (MLB_FILE) e o
     leitor de JSON. O cache de 30 min é DESTE módulo — cada empresa tem a sua instância,
     porque `criar` é chamado uma vez por checkout. */
  const { MLB_FILE, readJson } = deps;
  for (const [nome, v] of Object.entries({ MLB_FILE, readJson })) {
    if (v == null) throw new Error('lib/checkout/packs-ml: falta a dependência ' + nome);
  }
  let _packCache = { porVenda: null, doPack: null, em: 0 };   /* reatribuído a cada recarga — let, não const (o node pegou na hora) */

  function _carregarPacks() {
    if (_packCache.porVenda && (Date.now() - _packCache.em) < 30 * 60000) return _packCache;
    const porVenda = new Map(), doPack = new Map();
    try {
      const b = readJson(MLB_FILE(), { tarifas: {} });
      for (const t of Object.values(b.tarifas || {})) {
        if (!t || !t.o || !t.p) continue;
        const venda = String(t.o), pack = String(t.p);
        if (venda === pack) continue;
        porVenda.set(venda, pack);
        if (!doPack.has(pack)) doPack.set(pack, new Set());
        doPack.get(pack).add(venda);
      }
    } catch (e) {}
    _packCache = { em: Date.now(), porVenda, doPack };
    return _packCache;
  }
  /** as OUTRAS vendas do mesmo carrinho (inclui o próprio pack_id, que o Bling às vezes grava) */
  function _irmasDoPack(numeroLoja) {
    const { porVenda, doPack } = _carregarPacks();
    if (!porVenda) return null;
    const n = String(numeroLoja);
    const pack = porVenda.get(n) || (doPack.has(n) ? n : null);
    if (!pack) return null;
    const irmas = new Set(doPack.get(pack) || []);
    irmas.add(pack);
    irmas.delete(n);
    return irmas.size ? irmas : null;
  }

  return { _carregarPacks, _irmasDoPack };
}

module.exports = { criar };
