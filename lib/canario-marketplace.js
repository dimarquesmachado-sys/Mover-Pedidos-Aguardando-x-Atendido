'use strict';
// ════════════════════════════════════════════════════════════════════════════════
//  CANÁRIO MARKETPLACE × BLING — código único, multi-empresa (16/08/2026)
// ════════════════════════════════════════════════════════════════════════════════
//  Pedido do Diego, depois do token Bling↔Shopee da Girassol expirar em silêncio:
//  *"o Bling não é o rei, quem manda tem que ser o marketplace. Tinha que ter um canário
//   pegando os dados dos marketplaces e comparando com o Bling — senão dá discrepância."*
//
//  O ESTRAGO QUE ISSO PEGA (caso real de 15-16/08): 28 pedidos da Shopee não desceram
//  para o Bling porque o token da integração venceu (dura ~365 dias e o Bling NÃO avisa).
//  Sintoma que chegou primeiro: o Jodda mostrava R$ 15 mil de faturamento no dia e o
//  nosso painel R$ 11 mil — a diferença era exatamente os pedidos ausentes. Antes disso,
//  o mesmo aconteceu com a GOOD em 11/08 (estoquista um dia inteiro sem pedido Shopee).
//
//  A regra que este canário implementa: a VENDA existe no marketplace. Se ela não está
//  no Bling, o Bling é que está errado — e alguém precisa saber HOJE, não no fechamento.
//
//  ctx = { listarNoMarketplace(canal, deTs, ateTs) -> [ids]     (null = canal sem fonte)
//          listarNoBling(de, ate) -> { canal: Set(numero_loja) }
//          empresa }
// Codex (P2): os filtros de data do Bling são em data LOCAL do negócio. Derivar em UTC
// fazia a data inicial pular um dia entre 23h e 02h59 (São Paulo), e os pedidos daquela
// noite apareceriam como "faltando" sem nunca terem sido buscados no Bling.
const _dia = ts => new Date((ts - 3 * 3600) * 1000).toISOString().slice(0, 10);

async function conferir(ctx, dias, canais, opts) {
  const nDias = Math.min(30, Math.max(1, Number(dias) || 3));
  // Codex (P2): o Bling é lido ANTES do marketplace e a integração tem atraso normal de
  // alguns minutos. Sem folga, todo pedido feito agorinha viraria "sumido" e o canário
  // gritaria todo dia. Fecha a janela 2h atrás — venda mais nova que isso não é cobrada.
  const GRACA_S = Number(process.env.CANARIO_GRACA_MIN || 120) * 60;
  const fim = Math.floor(Date.now() / 1000) - GRACA_S;
  const ini = fim - nDias * 86400;
  const alvo = (canais && canais.length) ? canais : ['shopee', 'tiktok', 'ml'];

  let noBling = {};
  try { noBling = await ctx.listarNoBling(_dia(ini), _dia(fim)); }
  catch (e) { return { ok: false, erro: 'não consegui listar o Bling: ' + String(e.message || e).slice(0, 160) }; }

  const porCanal = {};
  const alertas = [];
  const naoVerificados = [];
  for (const canal of alvo) {
    let ids = null;
    try { ids = await ctx.listarNoMarketplace(canal, ini, fim); }
    catch (e) {
      // Codex (P1): se a consulta ao marketplace FALHA, o canário não pode dizer que está
      // tudo certo — ele não verificou nada. Canal com erro deixa o veredito indeterminado.
      porCanal[canal] = { erro: String(e.message || e).slice(0, 200), verificado: false };
      naoVerificados.push(canal);
      continue;
    }
    if (ids === null) {
      // Codex (P1): canal sem fonte NÃO pode passar por limpo — `?canais=ml` diria "está tudo
      // no Bling" sem ter comparado nada. Sem fonte = não verificado.
      porCanal[canal] = { sem_fonte: true, verificado: false, nota: 'sem API conectada para este canal — nada foi comparado' };
      naoVerificados.push(canal);
      continue;
    }

    // Codex (P2/P1): lista truncada = comparação sem valor. O coletor sinaliza com
    // `{ incompleto: true }` e o canal fica NÃO VERIFICADO em vez de acusar falso positivo.
    if (ids && ids.incompleto) {
      porCanal[canal] = { erro: 'lista do marketplace veio TRUNCADA (' + (ids.motivo || 'limite de páginas') + ') — comparação não confiável', verificado: false };
      naoVerificados.push(canal);
      continue;
    }
    const doBling = noBling[canal] || new Set();
    /* 06/09 — o coletor pode devolver strings (compatível) ou { id, apelidos }: uma venda do
       ML tem o número do pedido E o do pacote, e o Bling grava um OU outro. Qualquer apelido
       encontrado prova que a venda chegou; contar os dois como entradas separadas inflava a
       lista do ML e acusava metade das vendas de sumidas. */
    const _apelidos = x => (x && typeof x === 'object' && x.apelidos) ? x.apelidos.map(a => String(a).trim())
                          : [String(x).trim()];
    const _rotulo = x => (x && typeof x === 'object' && x.id) ? String(x.id) : String(x);
    let faltando = ids.filter(x => !_apelidos(x).some(a => doBling.has(a))).map(_rotulo);
    const naoConfirmadas = [];

    /* 06/09 — SEGUNDA CHANCE, CONSULTANDO O ML. A documentação do ML é explícita: "pack é um
       componente obrigatório em todas as compras, todas as ordens serão associadas a um
       pack_id" — ou seja, TODA venda tem dois números, mesmo com item único. O Bling grava um
       deles; qual, não controlamos. A busca por período às vezes devolve o pack_id junto (e aí
       o filtro acima já resolve), mas às vezes NÃO — foi o caso da venda 2000018258015754, de
       03/09, já entregue e com NF, que o canário insistia em chamar de sumida.
       Então, para os poucos que sobram, perguntamos o pack ao ML, um a um. É barato porque só
       roda no resto: numa rodada boa são zero ou uma chamada. E é limitado a 25 pra uma
       integração realmente caída não virar centenas de requisições. */
    /* Codex #347 r2 (P1): a segunda chance é uma história do ML (pack obrigatório) — os
       ajudantes devolvem null pra qualquer outro canal, e tratar null como erro mandava
       toda venda REALMENTE sumida da Shopee/TikTok pra nao_confirmadas, calando o alerta.
       O fallback agora é PRESO ao canal ml; nos demais, faltando fica como calculado. */
    if (canal === 'ml' && faltando.length && typeof ctx.packDaVenda === 'function') {
      /* 06/09 — SEGUNDA CHANCE, PERGUNTANDO AO ML. A doc do ML: "pack é componente obrigatório
         em todas as compras, todas as ordens serão associadas a um pack_id". Toda venda tem
         dois números; o Bling grava um deles e a busca por período nem sempre devolve o outro.
         Para os poucos que sobram, perguntamos: primeiro o pack da venda, depois — se o pack
         também não estiver no Bling — as ORDENS daquele pack, porque num carrinho o Bling pode
         ter gravado o número de uma irmã.
         ORÇAMENTO (Codex, 3 rodadas): o teto conta IDAS AO ML, não candidatos. Resposta de
         cache não gasta, senão os mesmos 25 primeiros consumiriam tudo em toda rodada e os
         seguintes nunca seriam perguntados — o falso alerta permanente que este bloco veio
         evitar. Cada etapa (pack e irmãs) desconta do mesmo teto. */
      /* Codex #347 (P1, dois deles): CORTE DE ORÇAMENTO e ERRO DE CONSULTA não são ausência.
         Antes, candidato pulado pelo teto ou com lookup falhado (429/5xx/timeout) seguia na
         lista de FALTANDO e virava alerta definitivo — exatamente o falso positivo que esta
         segunda chance existe pra evitar. Agora eles vão pra NAO_CONFIRMADAS: aparecem, sujam
         o veredito (nunca ✅), mas não acusam. Só resposta CONCLUSIVA condena ou absolve. */
      const LIMITE = 25;
      const resolvidos = [];
      let idas = 0;
      /* Codex #347 r2 (P2): fila ROTATIVA — com ordem estável e backlog > 2 lotes, o vaivém
         de TTL fazia os dias re-gastarem o teto nos mesmos primeiros e o rabo nunca chegava
         (e deploy zera o cache em memória). Começar de um ponto que gira com o dia garante
         avanço mesmo com cache frio; conclusivo de 7 dias acumula o resto. */
      const _rot = new Date().getUTCDate() % Math.max(1, faltando.length);
      const fila = faltando.slice(_rot).concat(faltando.slice(0, _rot));
      const _pack = r => (r && typeof r === 'object' && 'pack' in r) ? r.pack : r;
      const _veioDoCache = r => !!(r && typeof r === 'object' && r.doCache);
      const _comErro = r => r === null || (r && typeof r === 'object' && r.erro);
      for (const venda of fila) {
        if (idas >= LIMITE) { naoConfirmadas.push(venda); continue; }
        let rp = null;
        try { rp = await ctx.packDaVenda(canal, venda); } catch (e) { rp = null; }
        if (!_veioDoCache(rp)) idas++;
        if (_comErro(rp)) { naoConfirmadas.push(venda); continue; }   /* falhou: indeterminada */
        const pack = _pack(rp);
        if (!pack) { resolvidos.push(venda); continue; }    /* CONCLUSIVO: sem pack e id fora do Bling */
        const packS = String(pack).trim();
        if (doBling.has(packS)) continue;                   /* o Bling guardou pelo pacote */
        if (typeof ctx.ordensDoPack !== 'function') { resolvidos.push(venda); continue; }
        if (idas >= LIMITE) { naoConfirmadas.push(venda); continue; }
        let ri = null;
        try { ri = await ctx.ordensDoPack(canal, packS); } catch (e) { ri = null; }
        if (!_veioDoCache(ri)) idas++;
        if (_comErro(ri)) { naoConfirmadas.push(venda); continue; }
        const irmas = (ri && typeof ri === 'object' && 'ordens' in ri) ? ri.ordens : ri;
        if (!Array.isArray(irmas)) { naoConfirmadas.push(venda); continue; }
        if (irmas.some(o => doBling.has(String(o).trim()))) continue;
        resolvidos.push(venda);
      }
      faltando = resolvidos;
    }
    /* Codex #347 r2 (P1): as noturnas decidem sucesso por `alertas` e `nao_verificados` —
       canal que terminou com pendência de confirmação NÃO pode passar como verificado, senão
       a rodada reporta "ml: 0 de N" com a comparação em aberto. Pendência ⇒ nao_verificados. */
    if (naoConfirmadas.length) naoVerificados.push(canal);
    const pct = ids.length ? Math.round(faltando.length / ids.length * 1000) / 10 : 0;
    porCanal[canal] = {
      no_marketplace: ids.length, no_bling: doBling.size,
      faltando_no_bling: faltando.length, pct_faltando: pct,
      nao_confirmadas: naoConfirmadas.length || undefined,
      exemplos_nao_confirmadas: naoConfirmadas.length ? naoConfirmadas.slice(0, 10) : undefined,
      nota_nao_confirmadas: naoConfirmadas.length ? 'vendas SEM confirmação (erro ou orçamento na consulta ao ML) — não são faltantes; rode de novo pra fechá-las' : undefined,
      // 17/08: com a integração voltando "só pra frente", o Diego precisa da LISTA INTEIRA
      // pra reimportar os represados no Bling um a um. `&todos=1` devolve todos.
      exemplos: (opts && opts.todos) ? faltando : faltando.slice(0, 15),
      lista_completa: !!(opts && opts.todos)
    };
    // ⚠️ o alerta é por AUSÊNCIA, não por diferença de valor: pedido que existe na venda e
    // não existe no Bling é venda que some do dashboard, do imposto e do estoque.
    // Codex (P1): 1 ou 2 pedidos faltando em período grande ficavam abaixo do corte e o
    // veredito saía ✅ com `faltando_no_bling` > 0 — escondendo exatamente a venda que este
    // canário existe pra achar. Agora QUALQUER falta suja o veredito; o corte serve só pra
    // separar "grave" (provável integração caída) de "pontual".
    /* 06/09 — O TOM SEGUE O TAMANHO. Uma venda em 124 vinha como 🔴 GRAVE mandando reautorizar
       a integração do Bling — e a integração estava perfeita: o dono conferiu venda por venda,
       com NF emitida. Diagnóstico errado em letra garrafal é pior que não avisar, porque
       ensina a ignorar o vermelho e manda mexer no que está funcionando.
       Integração caída derruba TUDO, não uma venda: o alarme de reautorizar só faz sentido
       quando a maior parte sumiu. Abaixo disso é caso pontual — vale registrar, não vale
       pânico. A falta continua aparecendo em qualquer tamanho (isso foi um acerto anterior do
       Codex: 1 ou 2 sumidas não podem passar por ✅), só muda como é comunicada. */
    if (faltando.length > 0) {
      const parece_integracao = pct >= 30 || (faltando.length >= 10 && pct >= 10);
      const muitas = faltando.length >= 3 || pct >= 10;
      alertas.push({
        gravidade: parece_integracao ? 'grave' : (muitas ? 'atencao' : 'pontual'),
        canal, faltando: faltando.length, de: ids.length, pct,
        provavel: parece_integracao
          ? ('integração Bling↔' + canal + ' caída ou token expirado (vence ~365 dias e o Bling não avisa)')
          : (faltando.length === 1
              ? 'uma venda isolada — normalmente é venda recém-aprovada que o Bling ainda não importou, ou um número de pedido que o marketplace devolve diferente do que o Bling gravou'
              : 'poucas vendas — provável atraso de importação ou casos isolados; NÃO tem cara de integração caída'),
        o_que_fazer: parece_integracao
          ? ('Bling → Canais de venda → ' + canal + ' → reautorizar; depois rode o backfill do período')
          : 'confira uma das vendas em `exemplos` no Bling. Se estiver lá, é diferença de numeração e pode ignorar; se não estiver, rode o backfill do período.'
      });
    }
  }
  const totalNaoConf = Object.values(porCanal).reduce((t, c) => t + ((c && c.nao_confirmadas) || 0), 0);
  return {
    ok: true, empresa: ctx.empresa || null, dias: nDias,
    periodo: { de: _dia(ini), ate: _dia(fim), folga_minutos: Math.round(GRACA_S / 60) },
    por_canal: porCanal, alertas,
    nao_verificados: naoVerificados,
    /* 06/09: o emoji segue a gravidade — 🔴 só quando parece integração caída */
    veredito: alertas.length
      ? ((alertas.some(a => a.gravidade === 'grave') ? '🔴 ' : '🟡 ')
         + alertas.length + ' canal(is) com venda que NÃO chegou ao Bling — ver `alertas`')
      : (naoVerificados.length
          ? '⚠️ INDETERMINADO: não consegui verificar ' + naoVerificados.join(', ') + ' — o silêncio aqui NÃO quer dizer que está tudo certo'
          : (totalNaoConf
              ? '⚠️ INDETERMINADO: ' + totalNaoConf + ' venda(s) ficaram SEM confirmação (erro ou orçamento na consulta ao ML) — nada FALTANDO confirmado, mas ✅ só quando fecharem; rode de novo'
              : '✅ todo pedido do marketplace no período está no Bling')),
    nota: 'a fonte da verdade é o MARKETPLACE. O Bling é espelho: o que está lá e não aqui é problema do espelho, não da venda.'
  };
}

module.exports = { conferir };
