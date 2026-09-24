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
  /* Codex #526 (P2, r4): um item lança até 3 chamadas ao Bling seguidas (busca, cadastro,
     POST). O lote (rotas-contagem.js) só espaçava ENTRE itens — nada espaçava as chamadas de
     DENTRO de um item, e a conta é limitada a ~3 req/s. Respostas rápidas do Bling bastavam pra
     estourar o limite sozinho, fabricando os próprios 429 que a rodada trata como falha geral.
     Paceia CADA chamada, não só o laço de fora — mesmo PAUSA_MS (350ms) usado no resto desta
     pasta pra essa mesma conta. */
  const _PAUSA_MS = Number(ctx.PAUSA_MS) || 350;
  const _sleep = typeof ctx.sleep === 'function' ? ctx.sleep : (ms => new Promise(r => setTimeout(r, ms)));
  async function blingGet(...args) { await _sleep(_PAUSA_MS); return ctx.blingGet(...args); }
  async function blingWrite(...args) { await _sleep(_PAUSA_MS); return ctx.blingWrite(...args); }

  /* acha o produto pelo código EXATO; só então tenta o EAN. A busca do Bling é
     "contém", então `lista[0]` pode ser outro produto cujo código apenas comece
     igual — `10-lisa-125mm-100` e `10-lisa-125mm-1000` convivem no catálogo dele.
     Codex #524 (P2): a v3 não tem um filtro "só exato" pra `codigo` (o `criterio` do Bling é
     outra coisa — já documentado em fragil/blingProdutos.js), então o único jeito de não perder
     o código exato é PAGINAR: um catálogo com mais de 5 (ou 100) prefixos iguais escondia o
     código certo numa página seguinte e devolvia "não encontrado" pra um produto que existe.
     Teto de 5 páginas de 100 (500 candidatos) pra não virar rajada num catálogo enorme. */
  async function acharProduto(sku) {
    const alvo = String(sku || '').trim();
    if (!alvo) return { erro: 'sem SKU' };

    /* Codex #524 (P2): `blingGet` já esgota as próprias tentativas antes de devolver `ok: false`
       — se chegou aqui falho, é token vencido, limite ou rede fora, não "essa página acabou".
       Tratar como página vazia (o código de antes) parava a paginação e concluía "não encontrado"
       pra um produto que existe; o operador ia tentar CORRIGIR o SKU quando o problema era a
       conexão com o Bling. Falha de consulta tem que voltar diferente de busca esgotada. */
    for (let pagina = 1; pagina <= 5; pagina++) {
      const r = await blingGet('/produtos?codigo=' + encodeURIComponent(alvo) + '&limite=100&pagina=' + pagina);
      if (!r || !r.ok) {
        return { erro: 'não consegui consultar o Bling pra achar ' + alvo + ' (HTTP ' + ((r && r.status) || '?') + ') — a busca falhou, o produto pode existir' };
      }
      const lista = (r.data && r.data.data) || [];
      const exato = lista.find(x => String(x.codigo || '').toUpperCase() === alvo.toUpperCase());
      if (exato && exato.id) return { produto: exato };
      if (lista.length < 100) break;   // acabaram as páginas
    }

    if (/^\d{12,14}$/.test(alvo)) {
      const rg = await blingGet('/produtos?gtin=' + encodeURIComponent(alvo) + '&limite=3');
      if (!rg || !rg.ok) {
        return { erro: 'não consegui consultar o Bling pelo EAN ' + alvo + ' (HTTP ' + ((rg && rg.status) || '?') + ') — a busca falhou, o produto pode existir' };
      }
      const lg = (rg.data && rg.data.data) || [];
      const porEan = lg.find(x => x && x.codigo);
      if (porEan) {
        const conf = await acharProduto(porEan.codigo);   // reconfere pelo código
        if (conf.produto || /a busca falhou/.test(conf.erro || '')) return conf;
      }
    }
    return { erro: 'produto ' + alvo + ' não encontrado no Bling (nem por código exato, nem por EAN)' };
  }

  /* kit e pai de grade NÃO recebem entrada: o saldo mora nos componentes/variações,
     e lançar no pai põe saldo onde ele não existe. Mesma regra da tela de contagem. */
  async function podeReceberEntrada(produtoId) {
    const d = await blingGet('/produtos/' + produtoId);
    const det = (d && d.ok && d.data && d.data.data) || null;
    /* Codex #524 (P1): falha de rede/Bling aqui devolvia "pode" — e sem `det` o chamador não
       tem como saber se é kit/pai de grade nem o custo do cadastro, e ainda assim mandava o
       POST de estoque adiante (custo nulo, tipo não conferido). O cabeçalho deste arquivo é
       claro: "toda dúvida aqui é resolvida RECUSANDO" — dúvida por falha de consulta entra na
       mesma regra. */
    if (!det) return { pode: false, sabido: false, motivo: 'falha-consulta' };
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

  /* lista os depósitos, pra o dono levantar o id da empresa dele sem caçar no Bling.
     Codex #524 (P2): falha de token/rede/Bling virava lista VAZIA em silêncio — a rota que
     chama isto documenta "aqui é como se descobre o id do depósito", e reportar "não há
     depósitos" quando na verdade a consulta falhou esconde a causa real e não deixa ninguém
     corrigir. Lança pra quem chama tratar (a rota já tem try/catch pronto pra isso). */
  async function listarDepositos() {
    const r = await blingGet('/depositos?limite=100');
    if (!r || !r.ok) throw new Error('não consegui consultar os depósitos no Bling (HTTP ' + ((r && r.status) || '?') + ')');
    const l = (r.data && r.data.data) || [];
    return l.map(d => ({ id: d.id, descricao: d.descricao || d.nome || '', situacao: d.situacao }));
  }

  /* A ENTRADA. Devolve sempre um motivo legível: quem vê isto é o dono decidindo
     se relança, não um log. */
  /* Codex #526 (P1): `blingGet` não tem timeout. Uma conexão que nunca responde deixava o
     `await` pendurado pra sempre — a rodada em lote não chegava à limpeza das reservas, e os
     itens ficavam travados até a reserva expirar, com a página do dono esperando eternamente.
     Teto de 45s por item: o suficiente pra uma chamada lenta, curto o bastante pra o lote não
     morrer em cima de um item. */
  function comTeto(promessa, ms, oQue) {
    let t;
    return Promise.race([
      promessa,
      new Promise((_, rej) => { t = setTimeout(() => rej(new Error('tempo esgotado ' + oQue)), ms); }),
    ]).finally(() => clearTimeout(t));
  }

  async function entrada({ sku, quantidade, observacao, depositoId }) {
    const qtd = Number(quantidade);
    if (!Number.isFinite(qtd) || qtd <= 0 || Math.floor(qtd) !== qtd) {
      return { ok: false, erro: 'quantidade inválida' };
    }
    if (!depositoId) {
      return { ok: false, erro: 'depósito não configurado para esta empresa — sem ele o Bling recusa ou lança no lugar errado' };
    }

    let ach;
    try { ach = await comTeto(acharProduto(sku), 45000, 'ao procurar o produto'); }
    catch (e) { return { ok: false, erro: String(e.message || e) + ' — nada foi lançado' }; }
    if (!ach.produto) return { ok: false, erro: ach.erro };

    let chk;
    try { chk = await comTeto(podeReceberEntrada(ach.produto.id), 45000, 'ao ler o cadastro'); }
    catch (e) { return { ok: false, erro: String(e.message || e) + ' — nada foi lançado' }; }
    if (!chk.pode) {
      let erro;
      if (chk.motivo === 'pai-de-variacao') erro = 'esse SKU é o PAI da grade — o saldo mora nas variações, lançar aqui não soma em lugar nenhum';
      else if (chk.motivo === 'falha-consulta') erro = 'não consegui confirmar no Bling se este produto é kit ou pai de grade — não lanço sem essa confirmação';
      else erro = 'esse SKU é um KIT — o saldo mora nos componentes, lançar aqui não soma em lugar nenhum';
      return { ok: false, erro };
    }

    const corpo = {
      produto: { id: ach.produto.id },
      deposito: { id: Number(depositoId) },
      operacao: 'E',
      quantidade: qtd,
      observacoes: String(observacao || 'Entrada pela tela de contagem').slice(0, 200),
    };
    const custo = custoDoCadastro(chk.det);
    /* Codex #524 (P1): sem custo resolvido, o corpo antes seguia pro POST só sem os campos de
       preço — e o Bling lança a peça valendo ZERO, exatamente o que o comentário da função acima
       diz que "distorce a margem depois". O cabeçalho do arquivo é claro: dúvida aqui é RECUSA,
       não "manda mesmo assim e deixa o custo pra lá". */
    if (custo == null) {
      return { ok: false, erro: 'não achei o custo deste produto no cadastro do Bling — não lanço sem custo, a peça entraria valendo ZERO' };
    }
    corpo.precoUnitario = custo; corpo.custo = custo; corpo.preco = custo;

    /* Codex #524 (P1): sem `semRetryDeRede`, uma exceção de rede aqui faria o blingWrite
       REPETIR o POST — mas isto cria um lançamento no Bling, não é idempotente. Se o Bling
       processou o primeiro e só a resposta se perdeu, a repetição dobra o estoque. Com a opção,
       uma falha de rede vira resultado AMBÍGUO (r.ambiguo), tratado abaixo como recusa que exige
       conferência manual — nunca como "tenta de novo sozinho". */
    let r;
    try { r = await comTeto(blingWrite('POST', '/estoques', corpo, { semRetryDeRede: true }), 45000, 'ao lançar no estoque'); }
    catch (e) {
      /* ⚠️ AQUI "tempo esgotado" NÃO é "nada foi lançado": o POST pode ter sido processado e só
         a resposta ter se perdido. Dizer que não entrou levaria o dono a lançar de novo e
         duplicar o estoque. Marca como AMBÍGUO, pra quem chama nunca reapresentar sozinho. */
      return {
        ok: false, ambiguo: true,
        erro: 'a resposta do Bling não chegou a tempo — NÃO SEI se a entrada foi registrada. Confira no Bling antes de lançar de novo.',
      };
    }
    if (!r || !r.ok) {
      if (r && r.ambiguo) {
        /* Codex #526 (P1, r4): esta devolução perdia o `ambiguo: true` que o `blingWrite`
           mandou — `aplicarUm` só marca `ultima_falha_ambigua` (e tira o item da fila
           automática do lote) quando VÊ a marca aqui. Sem ela, o item ambíguo voltava a
           entrar na fila da rodada seguinte e podia somar DE NOVO um lançamento que talvez
           já tivesse entrado no Bling. */
        return {
          ok: false, ambiguo: true,
          erro: 'não recebi confirmação do Bling (falha de rede) — CONFIRA MANUALMENTE no Bling se este lançamento já foi feito antes de tentar de novo, pra não duplicar o estoque',
        };
      }
      /* o MOTIVO REAL do Bling, não "falhou": é o que permite decidir se relança */
      let motivo = '';
      try {
        const d = (r && (r.data || r.error)) || {};
        motivo = (d.error && (d.error.description || d.error.message))
              || (d.error && d.error.fields && d.error.fields[0] && (d.error.fields[0].msg || d.error.fields[0].message))
              || (r && r.raw) || '';
      } catch (e) {}
      /* status 0 / sem status = a requisição não obteve resposta. Com `semRetryDeRede` não há
         repetição, mas TAMBÉM não dá pra afirmar que o Bling não processou: é ambíguo, e quem
         chama não pode reapresentar sozinho. Uma recusa com status (400, 422…) é conclusiva. */
      const semResposta = !r || !r.status;
      return {
        ok: false,
        ambiguo: semResposta,
        erro: (semResposta ? 'não obtive resposta do Bling — NÃO SEI se a entrada foi registrada. Confira antes de lançar de novo. ' : '') +
              'o Bling recusou (HTTP ' + ((r && r.status) || '?') + ')' + (motivo ? ': ' + String(motivo).slice(0, 300) : ''),
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
