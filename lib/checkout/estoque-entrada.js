/* ══════════════════════════════════════════════════════════════════════════════
   ENTRADA DE ESTOQUE NO BLING — lib única, empresa como parâmetro.

   Caminho PROVADO: é o mesmo que roda em produção no ciclo de defeitos do
   Devoluções (lib/defeitos-ciclo.js do repo GOOD-Devolucoes). O dono mandou a
   função inteira justamente pra não redescobrirmos as armadilhas.

   ⚠️ DAS 4 ARMADILHAS DE LÁ, DUAS NÃO SE APLICAM AQUI — e é importante dizer
   por quê, pra ninguém "consertar" o que não está quebrado:
     · "o corpo vai em `data`, não em `body`" é do cliente axios da GOOD. O
       nosso `blingWrite` é fetch e manda em `body` mesmo.
     · "URL completa" também é de lá: o nosso concatena BLING_BASE.
     · a re-tentativa no 429 o `blingWrite` já faz.
   AS DUAS QUE VALEM, e que são as que erram calado:
     · o endpoint quer o **id** do produto, não o SKU;
     · o casamento tem que ser EXATO por código — pegar `lista[0]` cego lança
       no PRODUTO ERRADO, e ninguém descobre olhando a tela.

   ⚠️ ESTA É A ÚNICA PEÇA DESTE PROJETO QUE ESCREVE NO BLING, e é de mão única:
   lançamento aplicado só se desfaz com outro lançamento. Toda dúvida aqui é
   resolvida RECUSANDO.
   ══════════════════════════════════════════════════════════════════════════════ */

/* ctx: { blingGet, blingWrite, empresa } — empresa traz o depósito e o rótulo */
function criar(ctx) {
  for (const n of ['blingGet', 'blingWrite']) {
    if (typeof ctx[n] !== 'function') throw new Error('estoque-entrada: falta ' + n);
  }

  /* acha o produto pelo código EXATO; só então tenta o EAN. A busca do Bling é
     "contém", então `lista[0]` pode ser outro produto cujo código apenas comece
     igual — `10-lisa-125mm-100` e `10-lisa-125mm-1000` convivem no catálogo dele. */
  async function acharProduto(sku) {
    const alvo = String(sku || '').trim();
    if (!alvo) return { erro: 'sem SKU' };

    /* Codex #524 (P2): a busca do Bling por `codigo` é "contém", e eu olhava só os 5 primeiros.
       No catálogo dele isso não é hipótese: `10-lisa-125mm-100` casa com `-1000`, `-1500`…, e o
       exato pode cair na página 2. Aí a função dizia "não encontrado" pra um produto que
       existe. Varre as páginas até achar ou acabar — teto de 5 páginas (500 códigos), que já é
       muito mais do que qualquer prefixo plausível. */
    for (let pag = 1; pag <= 5; pag++) {
      const r = await ctx.blingGet('/produtos?codigo=' + encodeURIComponent(alvo) + '&limite=100&pagina=' + pag);
      const lista = (r && r.ok && r.data && r.data.data) || [];
      const exato = lista.find(x => String(x.codigo || '').toUpperCase() === alvo.toUpperCase());
      if (exato && exato.id) return { produto: exato };
      if (lista.length < 100) break;       // última página
    }

    if (/^\d{12,14}$/.test(alvo)) {
      const rg = await ctx.blingGet('/produtos?gtin=' + encodeURIComponent(alvo) + '&limite=3');
      const lg = (rg && rg.ok && rg.data && rg.data.data) || [];
      const porEan = lg.find(x => x && x.codigo);
      if (porEan) {
        const conf = await acharProduto(porEan.codigo);   // reconfere pelo código
        if (conf.produto) return conf;
      }
    }
    return { erro: 'produto ' + alvo + ' não encontrado no Bling (nem por código exato, nem por EAN)' };
  }

  /* kit e pai de grade NÃO recebem entrada: o saldo mora nos componentes/variações,
     e lançar no pai põe saldo onde ele não existe. Mesma regra da tela de contagem. */
  async function podeReceberEntrada(produtoId) {
    const d = await ctx.blingGet('/produtos/' + produtoId);
    const det = (d && d.ok && d.data && d.data.data) || null;
    /* Codex #524 (P1): sem o detalhe eu NÃO SEI se é kit nem qual o custo — e aprovava assim
       mesmo, mandando o POST irreversível. "Não sei" aqui não pode virar "pode": a escrita é de
       mão única, e um kit aceito por engano põe saldo onde ele não existe.
       Recusa, e diz que foi por não conseguir conferir — o dono tenta de novo. */
    if (!det) return { pode: false, motivo: 'sem-detalhe', sabido: false };
    const comps = (det.estrutura && (det.estrutura.componentes || det.estrutura.itens))
               || det.composicao || det.componentes || [];
    const fmt = String(det.formato || '').toUpperCase();
    if (Array.isArray(comps) && comps.length > 0) return { pode: false, motivo: 'kit', sabido: true, det };
    if (fmt === 'E') return { pode: false, motivo: 'kit', sabido: true, det };
    if (fmt === 'V') return { pode: false, motivo: 'pai-de-variacao', sabido: true, det };
    return { pode: true, sabido: true, det };
  }

  /* o custo do próprio cadastro: sem ele a peça entra valendo ZERO e distorce a
     margem depois. O Bling guarda em lugares diferentes conforme o produto foi
     criado — a lista de candidatos veio do código de produção do Devoluções. */
  function custoDoCadastro(det) {
    const cand = det ? [
      det.precoCusto, det.estoque && det.estoque.precoCusto, det.custo,
      det.precos && det.precos.custo, det.precos && det.precos.precoCusto,
      det.custos && det.custos.custo, det.custos && det.custos.precoCusto,
      det.fornecedor && det.fornecedor.precoCusto,
      det.fornecedores && det.fornecedores[0] && det.fornecedores[0].precoCusto,
      det.precoCompra,
    ] : [];
    for (const c of cand) {
      const n = Number(c);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  }

  /* lista os depósitos, pra o dono levantar o id da empresa dele sem caçar no Bling */
  async function listarDepositos() {
    const r = await ctx.blingGet('/depositos?limite=100');
    /* Codex #524 (P2): falha (401, 429, rede) virava lista VAZIA e a rota respondia ok — o dono
       concluiria que a empresa não tem depósito e iria caçar no Bling à toa. Erro é erro. */
    if (!r || !r.ok) {
      const e = new Error('não consegui listar os depósitos no Bling (HTTP ' + ((r && r.status) || '?') + ')');
      e.semResposta = true;
      throw e;
    }
    const l = (r.data && r.data.data) || [];
    return l.map(d => ({ id: d.id, descricao: d.descricao || d.nome || '', situacao: d.situacao }));
  }

  /* A ENTRADA. Devolve sempre um motivo legível: quem vê isto é o dono decidindo
     se relança, não um log. */
  async function entrada({ sku, quantidade, observacao, depositoId }) {
    const qtd = Number(quantidade);
    if (!Number.isFinite(qtd) || qtd <= 0 || Math.floor(qtd) !== qtd) {
      return { ok: false, erro: 'quantidade inválida' };
    }
    if (!depositoId) {
      return { ok: false, erro: 'depósito não configurado para esta empresa — sem ele o Bling recusa ou lança no lugar errado' };
    }

    const ach = await acharProduto(sku);
    if (!ach.produto) return { ok: false, erro: ach.erro };

    const chk = await podeReceberEntrada(ach.produto.id);
    if (!chk.pode) {
      if (chk.motivo === 'sem-detalhe') {
        return { ok: false, erro: 'não consegui conferir o cadastro do produto no Bling agora — nada foi lançado. Tente de novo.' };
      }
      return {
        ok: false,
        erro: chk.motivo === 'pai-de-variacao'
          ? 'esse SKU é o PAI da grade — o saldo mora nas variações, lançar aqui não soma em lugar nenhum'
          : 'esse SKU é um KIT — o saldo mora nos componentes, lançar aqui não soma em lugar nenhum',
      };
    }

    const corpo = {
      produto: { id: ach.produto.id },
      deposito: { id: Number(depositoId) },
      operacao: 'E',
      quantidade: qtd,
      observacoes: String(observacao || 'Entrada pela tela de contagem').slice(0, 200),
    };
    const custo = custoDoCadastro(chk.det);
    if (custo != null) { corpo.precoUnitario = custo; corpo.custo = custo; corpo.preco = custo; }

    /* Codex #524 (P1): o `blingWrite` repete o envio quando o `fetch` ESTOURA — e faz sentido
       pra leitura ou pra um PUT, que são idempotentes. Este POST NÃO é: se o Bling gravou a
       entrada e a conexão caiu antes da resposta chegar, a repetição soma DE NOVO no estoque
       real, e ninguém descobre olhando a tela.
       Aqui uma tentativa só. Falhou por rede? O dono confere no Bling e decide — que é o certo
       pra uma operação que não tem desfazer. O 429 também não repete: ele significa que a
       requisição NÃO foi processada, mas distinguir isso de um timeout depois do commit é
       justamente o que não dá pra fazer daqui. */
    const r = await ctx.blingWrite('POST', '/estoques', corpo, { tentativas: 1 });
    if (!r || !r.ok) {
      /* o MOTIVO REAL do Bling, não "falhou": é o que permite decidir se relança */
      let motivo = '';
      try {
        const d = (r && (r.data || r.error)) || {};
        motivo = (d.error && (d.error.description || d.error.message))
              || (d.error && d.error.fields && d.error.fields[0] && (d.error.fields[0].msg || d.error.fields[0].message))
              || (r && r.raw) || '';
      } catch (e) {}
      return {
        ok: false,
        erro: 'o Bling recusou (HTTP ' + ((r && r.status) || '?') + ')' + (motivo ? ': ' + String(motivo).slice(0, 300) : ''),
      };
    }
    return {
      ok: true,
      produto_id: ach.produto.id,
      deposito: String(depositoId),
      quantidade: qtd,
      custo,
      link: 'https://www.bling.com.br/estoque.php?buscaid=' + ach.produto.id,
    };
  }

  return { entrada, acharProduto, podeReceberEntrada, listarDepositos, custoDoCadastro };
}

module.exports = { criar };
