'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   lib/checkout/rotas-contagem.js — CONTAGEM DE ESTOQUE (registro interno)

   O que o dono pediu (22/09): uma tela pro funcionário procurar um produto por
   SKU, EAN ou PARTE DO NOME, ver o nome completo e a foto, e lançar a
   quantidade que ele contou.

   Três decisões que ele tomou e que moldam tudo aqui:

   1) NÃO GRAVA NO BLING. É registro interno; ele revisa depois e decide o que
      enviar. Por isso nenhuma rota daqui chama blingWrite — a única coisa que
      este módulo escreve é o próprio arquivo de contagens.
   2) É CONTAGEM, não entrada/saída. O funcionário informa o saldo que contou,
      não um delta. A divergência contra o Bling é calculada na hora do
      lançamento e guardada junto: é ela que interessa na revisão.
   3) Girassol primeiro. Mas o código nasce com a empresa como parâmetro, como
      toda peça nova — plugar as outras duas é passar o contexto.

   ⚠️ BUSCA POR NOME É LOCAL, DE PROPÓSITO. O funcionário digitando um nome
   dispararia uma consulta ao Bling por tecla, e a cota é da conta — a operação
   perde primeiro. O índice de EAN já guarda { sku, nome, id } de tudo que
   passou pela busca ou pela indexação, então o nome é procurado ali. SKU e EAN
   continuam indo ao Bling, porque precisam do saldo e da foto do momento.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

/* ctx precisa de: prefixo, json, validarSessao, blingGet, lerIndiceEan, CACHE_DIR,
   readJson, writeJson, empresa, produtoDetalhe, localizacaoDeProduto, locCache */
function criar(ctx) {
  for (const n of ['prefixo', 'json', 'validarSessao', 'lerIndiceEan', 'CACHE_DIR',
                   'readJson', 'writeJson', 'empresa', 'blingGet',
                   'produtoDetalhe', 'localizacaoDeProduto', 'locCache']) {
    if (!ctx || ctx[n] === undefined) throw new Error('rotas-contagem: falta ' + n + ' no contexto');
  }
  const { prefixo, json, validarSessao, lerIndiceEan, CACHE_DIR, readJson, writeJson, empresa,
          produtoDetalhe, localizacaoDeProduto, locCache } = ctx;

  /* Codex #509 (P1): o saldo é o dado que torna a divergência auditável, e ele precisa ser o
     do INSTANTE do lançamento. Esta função é a mesma usada pela rota /contagem-saldo (que a
     tela chama ao abrir o produto) e pelo próprio lançamento — duas cópias divergiriam, e a do
     lançamento é a que vai pro registro permanente.

     Codex #509 (P1, r3): o saldo vinha do `estoque` embutido em /produtos (lista) ou no
     detalhe — mas no Bling v3 esses campos são OPCIONAIS na resposta, e o próprio saldo em
     lote da casa (gbo-app.js, "SALDO em LOTE") já sabia disso: usa /estoques/saldos, que é a
     fonte dedicada. Ir pelo /produtos podia devolver saldo nulo (e a contagem gravava sem
     divergência, ou com o valor herdado da tela) mesmo com o produto TENDO saldo — só não veio
     junto da lista/detalhe. Agora resolve o ID e busca o saldo no endpoint certo.

     Codex #509 (P1, r3): blingGet não tem timeout — documentado nele mesmo, e um Bling que
     aceita a conexão e nunca responde deixava esta chamada (e o botão Salvar, que espera por
     ela) pendurados pra sempre. Um abort de 15s cobre a busca inteira (até 3 variantes de
     caixa, 2 chamadas cada): generoso pro Bling normal, finito pro caso ruim — melhor gravar
     sem saldo confirmado do que travar quem está contando. */
  /* `formato === 'E'` é composição no Bling — está documentado em amb-drive-imagens, que
     preserva a estrutura justamente porque o Bling recusa sem ela. Se a consulta falhar,
     NÃO bloqueia: recusar um produto legítimo por causa de uma falha de rede é pior que
     deixar passar um kit que a busca já escondeu.

     Codex #511 (P1): sem abort, um Bling que aceita a conexão e nunca responde deixava
     /contagem-lancar (e o botão Salvar) pendurados pra sempre — mesmo bug que o #509 já
     tinha achado em `saldoAoVivo`, só que aqui ainda sem o remédio. Mesmo abort de 15s.

     Codex #511 (P2): `?codigo=` do Bling é case-sensitive (documentado em `saldoAoVivo` e em
     `porSku` de rotas-catalogo.js) — só tentar a grafia recebida deixava um SKU de kit em
     caixa diferente da cadastrada responder "não achei" aqui, mesmo que `saldoAoVivo` ache o
     produto pela variante certa logo depois. Mesmas 3 variantes dos outros dois caminhos. */
  /* dá nome aos componentes: o Bling às vezes devolve só `produto.id`. Resolve no máximo 6 —
     além disso a lista já não cabe na tela, e recusar um lançamento não pode custar uma rajada
     de chamadas. Quem não resolver sai com o id, que ainda é melhor que nada. */
  async function resolverComponentes(comps, sinal) {
    const saida = [];
    let buscados = 0;
    for (const c of comps) {
      const qtd = Number(c.quantidade || c.qtd || 1) || 1;
      let sku = (c.produto && c.produto.codigo) || c.codigo || '';
      let nome = (c.produto && c.produto.nome) || c.nome || '';
      const id = (c.produto && c.produto.id) || c.idProduto || c.id || null;
      if (!sku && !nome && id && buscados < 6) {
        buscados++;
        try {
          const d = await ctx.blingGet(`/produtos/${id}`, 3, sinal);
          const pd = d && d.ok && d.data && d.data.data;
          if (pd) { sku = pd.codigo || ''; nome = pd.nome || ''; }
        } catch (e) {}
      }
      if (!sku && !nome && id) sku = 'id ' + id;   // nunca sai vazio
      if (sku || nome) saida.push({ sku, nome, qtd });
    }
    return saida;
  }

  async function ehKitNoBling(sku) {
    const variantes = [...new Set([sku, sku.toUpperCase(), sku.toLowerCase()])];
    const controle = new AbortController();
    const relogio = setTimeout(() => controle.abort(), 15000);
    try {
      for (const v of variantes) {
        try {
          const r = await ctx.blingGet(`/produtos?codigo=${encodeURIComponent(v)}&limite=1`, 3, controle.signal);
          const it = r.ok && r.data && r.data.data && r.data.data[0];
          if (!it) continue;

          /* 23/09 — O `formato` DA LISTAGEM NÃO BASTA, e o dono trouxe os três casos:
             · a LISTA pode dizer "S" pra algo que é kit — a estrutura nem sempre vem nela;
             · `V` é pai de variação (grade), que também não tem estoque próprio;
             · quem decide de verdade é `estrutura.componentes`: se tem componente, é kit,
               independente do que o `formato` disser.
             Como esta trava roda UMA vez por lançamento (não por produto do catálogo), buscar
             o detalhe aqui é barato — e é o único ponto onde não pode passar. */
          const det = await ctx.blingGet(`/produtos/${it.id}`, 3, controle.signal).catch(() => null);
          const prod = (det && det.ok && det.data && det.data.data) || it;
          const comps = (prod.estrutura && (prod.estrutura.componentes || prod.estrutura.itens))
                     || prod.composicao || prod.componentes || [];
          const temComponentes = Array.isArray(comps) && comps.length > 0;
          const fmt = String(prod.formato || it.formato || '').toUpperCase();

          if (temComponentes || fmt === 'E') {
            /* devolve OS COMPONENTES: dizer "é kit" sem dizer o que contar deixa a pessoa
               parada. Aqui ela já sai sabendo quais SKUs lançar. */
            return {
              kit: true, sabido: true, motivo: temComponentes ? 'composicao' : 'formato-E',
              /* Codex #515 (P2): o componente pode vir SÓ com `produto.id`, sem código nem
                 nome — o atualizador de imagens e os testes de composição já tratam essa
                 forma. Sem resolver, a mensagem sairia "conte os produtos que o compõem:"
                 e nada depois, que é pior que não listar.
                 Resolve no máximo 6, pra não transformar uma recusa em rajada de chamadas. */
              componentes: await resolverComponentes(comps.slice(0, 12), controle.signal),
            };
          }
          if (fmt === 'V') {
            /* pai de grade: o estoque mora nas variações filhas, não nele */
            return { kit: true, sabido: true, motivo: 'pai-de-variacao', componentes: [] };
          }
          return { kit: false, sabido: true };
        } catch (e) {}
      }
      return { kit: false, sabido: false };
    } finally {
      clearTimeout(relogio);
    }
  }

  async function saldoAoVivo(sku, detalhado) {
    const variantes = [...new Set([sku, sku.toUpperCase(), sku.toLowerCase()])];
    const controle = new AbortController();
    const relogio = setTimeout(() => controle.abort(), 15000);
    try {
      let saldo = null, achou = false, localizacao = '';
      for (const v of variantes) {
        try {
          const r = await ctx.blingGet(`/produtos?codigo=${encodeURIComponent(v)}&limite=1`, 3, controle.signal);
          const it = r.ok && r.data && r.data.data && r.data.data[0];
          if (!it || !it.id) continue;
          achou = true;
          const r2 = await ctx.blingGet(`/estoques/saldos?idsProdutos[]=${it.id}`, 3, controle.signal);
          const arr = (r2.ok && r2.data && r2.data.data) || [];
          const e2 = arr.find(x => x && x.produto && x.produto.id === it.id) || arr[0];
          const sv = e2 && (e2.saldoVirtualTotal != null ? e2.saldoVirtualTotal : e2.saldoFisicoTotal);
          saldo = (sv != null && isFinite(Number(sv))) ? Number(sv) : null;
          /* Codex #522 (P2): a busca por nome do card inline não tem como mostrar a localização
             — o índice local que ela usa (lerIndiceEan) nunca guardou esse campo, e adicioná-lo
             ali exigiria varrer o catálogo de novo. Resolve aqui, sob demanda, no mesmo foco que
             já busca o saldo — mesma lógica de /buscar-produto: 1º o Bling (fonte da verdade,
             precisa do DETALHE — a listagem não traz), 2º o cache local (localização editada
             pelo painel, pra produto sem localização cadastrada no Bling). Só quando `detalhado`
             (a rota /contagem-saldo, chamada uma vez por produto focado) — o lançamento
             (`/contagem-lancar`) não precisa disto e não paga o custo da chamada extra. */
          if (detalhado) {
            const det = await produtoDetalhe(it.id);
            localizacao = localizacaoDeProduto(det);
            if (!localizacao) {
              const lc = locCache(); const sk = it.codigo || sku;
              localizacao = lc[sk] || lc[sk.toUpperCase()] || lc[sk.toLowerCase()] || '';
            }
          }
          break;
        } catch (e) {}
      }
      return detalhado ? { saldo, achou, localizacao } : saldo;
    } finally {
      clearTimeout(relogio);
    }
  }

  /* a lib da entrada nasce com a empresa como parâmetro (regra da casa: peça nova em /lib) */
  let _libEstoque = null;
  const _estoqueEntrada = () => {
    if (!_libEstoque) _libEstoque = require('./estoque-entrada').criar({ blingGet: ctx.blingGet, blingWrite: ctx.blingWrite });
    return _libEstoque;
  };
  /* o depósito é POR EMPRESA e vem de env — o da GOOD é 4956031259, o da Girassol precisa ser
     levantado (rota /contagem-depositos lista). Sem ele a entrada é recusada, nunca chutada. */
  const depositoDaEmpresa = () => {
    const nome = (ctx.empresa && ctx.empresa.envDeposito) || '';
    return (nome && process.env[nome]) || (ctx.empresa && ctx.empresa.depositoGeral) || '';
  };

  const ARQ = () => path.join(CACHE_DIR, '_contagem-estoque.json');

  /* Codex #509 (P1): `writeJson` abre o arquivo TRUNCANDO. Se o disco encher ou o processo cair
     no meio, o histórico inteiro fica vazio ou pela metade — e o `ler()` de antes, ao encontrar
     um arquivo quebrado, devolvia `{lancamentos: []}` em silêncio. A próxima gravação partiria
     dessa lista vazia e o registro do dia todo sumiria sem ninguém perceber.
     Duas mudanças: grava num temporário e RENOMEIA por cima (rename é atômico — ou o arquivo
     velho inteiro, ou o novo inteiro, nunca meio), e arquivo ilegível vira ERRO em vez de lista
     vazia, pra ninguém escrever por cima do que não conseguiu ler. */
  const gravar = (d) => {
    const alvo = ARQ();
    const tmp = alvo + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
      fs.renameSync(tmp, alvo);
      return true;
    } catch (e) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}
      return false;
    }
  };

  /* Codex #511 (P2): os lançamentos gravados ANTES desta versão não têm `id` — o campo só
     nasce no caminho novo. No primeiro deploy por cima de um arquivo existente, todos eles
     apareceriam SEM os botões + e −, e sem explicação nenhuma na tela: o funcionário veria
     umas linhas ajustáveis e outras não.
     Carimba na leitura e grava uma vez só, quando faltar. */
  const carimbarIds = (d) => {
    let mudou = false;
    for (const l of d.lancamentos) {
      if (l && !l.id) {
        l.id = 'v1' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        mudou = true;
      }
    }
    return mudou;
  };

  const ler = () => {
    const alvo = ARQ();
    if (!fs.existsSync(alvo)) return { lancamentos: [] };   // primeira contagem: vazio é a verdade
    const d = readJson(alvo, null);
    if (d && Array.isArray(d.lancamentos)) return d;
    /* existe mas não dá pra ler: NÃO devolve vazio. Vazio aqui faria a próxima gravação apagar
       o que sobrou — perder o resto é pior que recusar o lançamento. */
    throw new Error('arquivo de contagens ilegível');
  };

  /* sem acento e sem caixa: o funcionário digita "luminaria" e o catálogo tem
     "Luminária" — exigir o acento seria uma busca que só funciona pra quem já
     sabe o nome exato, e quem sabe o nome exato usa o SKU */
  const simples = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  /* a assinatura segue a da casa — rotas-catalogo e as irmãs recebem
     (req, res, urlObj, method). Escrevi diferente primeiro e o próprio registro
     no módulo mostrou; alinhar aqui é mais barato que ter duas convenções. */
  return async function rotasContagem(req, res, urlObj, method) {
    const p = urlObj.pathname;
    /* ── tela ── */
    if (method === 'GET' && p === (prefixo + '/contagem')) {
      const f = path.join(__dirname, '..', '..', empresa.pasta, 'contagem.html');
      if (!fs.existsSync(f)) { json(res, 404, { ok: false, erro: 'tela de contagem não habilitada nesta empresa' }); return true; }
      const sess = validarSessao(req.headers['cookie']);
      if (!sess) { json(res, 401, { ok: false, erro: 'precisa estar logado' }); return true; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(f, 'utf8'));
      return true;
    }

    /* ── busca por PARTE DO NOME (local, sem tocar no Bling) ── */
    /* ── busca por nome: MUDOU DE CASA (22/09) ───────────────────────────────
       O dono perguntou por que a contagem não usava a busca do 🔎 do painel. Usava a mesma
       rota pra SKU e EAN; o que estava só aqui era a busca por PARTE DO NOME — e o lugar dela
       é a lib de CATÁLOGO, que as três empresas já registram. Movida pra lá como
       /buscar-produto-nome, o painel das três ganhou junto e sumiu a cópia.
       A tela da contagem chama a rota do catálogo direto; não sobra atalho aqui. */

    /* ── lançar a contagem ── */
    if (method === 'POST' && p === (prefixo + '/contagem-lancar')) {
      const sess = validarSessao(req.headers['cookie']);
      if (!sess) { json(res, 401, { ok: false, erro: 'precisa estar logado' }); return true; }
      let body = {};
      try { body = await ctx.readBody(req); } catch (e) { body = {}; }

      const sku = String(body.sku || '').trim();
      if (!sku) { json(res, 200, { ok: false, erro: 'sem SKU' }); return true; }

      /* a quantidade é o ponto do recurso inteiro: número errado aqui vira
         inventário errado. Recusa o que não for inteiro >= 0 e diz por quê —
         não aceita texto, não arredonda, não assume zero */
      const bruto = String(body.contado == null ? '' : body.contado).trim().replace(',', '.');
      const n = Number(bruto);
      if (bruto === '' || !isFinite(n) || n < 0 || Math.floor(n) !== n) {
        json(res, 200, { ok: false, erro: 'quantidade inválida — use um número inteiro a partir de 0' });
        return true;
      }
      if (n > 1000000) { json(res, 200, { ok: false, erro: 'quantidade acima do razoável — confira o que digitou' }); return true; }

      /* Codex #509 (P1): o saldo vinha DO NAVEGADOR, capturado quando o produto foi aberto.
         Entre abrir e salvar há a contagem física — minutos, às vezes mais — e nesse intervalo
         cabe uma venda ou um ajuste. A divergência gravada nascia comparando o contado de agora
         com o saldo de antes, e fica assim PARA SEMPRE: é registro, ninguém recalcula depois.
         Agora o saldo é buscado AQUI, no servidor, no instante do lançamento.
         Se a consulta falhar, grava com saldo nulo e diz isso no campo — divergência ausente é
         honesta; divergência errada não. */
      /* 22/09 — TRAVA NO LANÇAMENTO: kit não entra. A busca já esconde, mas ela depende da
         marca vir da indexação — índice antigo não tem, e o funcionário pode digitar o SKU do
         kit direto. Aqui a resposta do Bling é a autoridade, no instante que importa.
         Por que isso é mais que arrumação: contar um kit gera um número que NUNCA vai poder
         ser lançado, e quem conferir depois vai gastar tempo entendendo por quê. */
      const infoKit = await ehKitNoBling(sku);
      if (infoKit.kit) {
        const comps = infoKit.componentes || [];
        const lista = comps.map(c => (c.qtd > 1 ? c.qtd + '× ' : '') + (c.sku || c.nome)).join(', ');
        json(res, 200, {
          ok: false,
          erro: infoKit.motivo === 'pai-de-variacao'
            ? 'esse SKU é o PAI da grade — conte a variação (cor/tamanho), não o pai'
            : ('esse SKU é um KIT — conte os produtos que o compõem' + (lista ? ': ' + lista : '')),
          componentes: comps,
        });
        return true;
      }

      let saldoBling = await saldoAoVivo(sku);
      const saldoVeioDoBling = saldoBling != null;
      if (saldoBling == null && body.saldo_bling != null && body.saldo_bling !== '') {
        /* último recurso: o que o navegador tinha. Marcado como tal, pra revisão saber que
           aquele número não foi conferido na hora. */
        const doNav = Number(body.saldo_bling);
        if (isFinite(doNav)) saldoBling = doNav;
      }
      let d;
      try { d = ler(); } catch (e) {
        json(res, 200, { ok: false, erro: 'o arquivo de contagens está ilegível — NÃO lance nada e avise o responsável, pra não perder o que já foi contado' });
        return true;
      }
      /* 22/09 — cada lançamento ganha ID. Sem ele não há como ajustar UMA linha depois (o dono
         pediu + e − na lista), e usar a posição no array seria frágil: basta outro funcionário
         lançar ao mesmo tempo pra o índice apontar pra outra coisa. */
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      d.lancamentos.push({
        id,
        sku,
        nome: String(body.nome || ''),
        /* 22/09 — a FOTO fica guardada no lançamento. O dono pediu vê-la na linha das contagens,
           e buscá-la de novo por linha custaria uma chamada ao Bling por item da lista — a cota
           é da conta. A tela já tem a URL na mão quando o produto foi escolhido; só viaja junto.
           Aceita só http(s): outros esquemas não têm o que fazer num <img> a não ser surpresa. */
        img: (() => {
          const u = String(body.img || '').trim();
          return /^https?:\/\//i.test(u) ? u.slice(0, 500) : '';
        })(),
        ean: String(body.ean || ''),
        /* 23/09 — O TIPO DO LANÇAMENTO. O dono: "eu quero olhar aqui do meu lado, se tem 10
           produtos A, e só digitar 10, pra ADICIONAR 10 ao total". Isso é outra coisa do que a
           tela fazia: ela gravava "há 10 na prateleira" e calculava divergência contra o Bling.
           Os dois usos são legítimos — hoje ele está registrando estoque que NÃO está na
           prateleira do galpão; amanhã quer inventário de verdade —, mas o registro PRECISA
           dizer qual é. Quem for aplicar isso no Bling tem que saber se 10 significa "deixa em
           10" ou "soma 10"; misturar os dois sem marca põe o estoque errado sem ninguém
           descobrir por quê. */
        tipo: (String(body.tipo || '') === 'somar') ? 'somar' : 'contagem',
        contado: n,
        /* o saldo do Bling é guardado COMO ESTAVA NO MOMENTO da contagem: é o
           que torna a divergência auditável depois. Recalcular na revisão
           compararia a contagem de ontem com o saldo de hoje */
        saldo_bling_na_hora: (saldoBling != null && isFinite(saldoBling)) ? saldoBling : null,
        /* de onde veio o saldo: conferido no Bling no instante do lançamento, ou herdado da
           tela. A revisão precisa saber a diferença antes de confiar na divergência. */
        saldo_conferido_na_hora: saldoVeioDoBling,
        /* divergência só existe em CONTAGEM: no modo somar, 10 não é "a prateleira tem 10",
           é "chegaram 10" — comparar com o saldo daria um número sem significado, e número
           errado é pior que número ausente. */
        divergencia: (String(body.tipo || '') !== 'somar' && saldoBling != null && isFinite(saldoBling))
                     ? (n - saldoBling) : null,
        quem: String(sess.nome || sess || ''),
        quando: new Date().toISOString(),
        enviado_ao_bling: false,   // o dono decide depois; nada aqui escreve no Bling
      });
      /* Codex #509 (P1): writeJson engole a exceção e só loga — se o disco estiver cheio
         ou read-only, a gravação falha e o retorno CONTINUAVA ok:true. O funcionário via
         "salva" e ia pro próximo item com a contagem perdida. Sem checar o retorno, esta
         checagem não existe pra ninguém. */
      if (!gravar(d)) {
        json(res, 200, { ok: false, erro: 'não consegui gravar a contagem no disco — avise o responsável antes de continuar' });
        return true;
      }
      json(res, 200, { ok: true, total: d.lancamentos.length });
      return true;
    }

    /* ── ajustar a quantidade de um lançamento (+ / −) ───────────────────────
       Pedido do dono: na lista do dia, poder acrescentar ou tirar unidades sem refazer a
       contagem inteira — o funcionário acha mais uma caixa no canto e soma.

       ⚠️ O registro continua AUDITÁVEL: o ajuste não apaga o valor anterior, ele empilha em
       `ajustes` com quem mexeu e quando. Sobrescrever calado transformaria um registro de
       conferência numa caixa preta — e o ponto desta tela é justamente poder conferir depois. */
    if (method === 'POST' && p === (prefixo + '/contagem-ajustar')) {
      const sess = validarSessao(req.headers['cookie']);
      if (!sess) { json(res, 401, { ok: false, erro: 'precisa estar logado' }); return true; }
      let body = {};
      try { body = await ctx.readBody(req); } catch (e) { body = {}; }

      const id = String(body.id || '').trim();
      const delta = Number(body.delta);
      if (!id) { json(res, 200, { ok: false, erro: 'sem id do lançamento' }); return true; }
      /* Codex #511 (P2): a rota é chamável direto, sem passar pelos dois botões. Qualquer
         inteiro passava — inclusive um que levasse a contagem acima do teto que o LANÇAMENTO
         recusa, deixando os dois caminhos com regras diferentes pro mesmo campo. O ajuste é de
         UMA unidade por vez, que é o que os botões fazem. */
      if (delta !== 1 && delta !== -1) {
        json(res, 200, { ok: false, erro: 'ajuste inválido — use os botões + e − (uma unidade por vez)' });
        return true;
      }

      let d;
      try { d = ler(); } catch (e) {
        json(res, 200, { ok: false, erro: 'o arquivo de contagens está ilegível — avise o responsável' });
        return true;
      }
      if (carimbarIds(d)) gravar(d);   // arquivo antigo: dá id a quem não tem, uma vez só
      const l = d.lancamentos.find(x => x && x.id === id && !x.excluido);
      if (!l) { json(res, 200, { ok: false, erro: 'lançamento não encontrado' }); return true; }
      /* Codex #524 (P2): lançamento JÁ APLICADO no Bling vira registro histórico. Editar a
         quantidade, ajustar no + / −, trocar o tipo ou excluir depois disso faz a linha deixar
         de descrever o que foi enviado — e o estoque real não muda junto. Congela. */
      if (l.aplicado_em) {
        json(res, 200, { ok: false, erro: 'este lançamento já foi aplicado no Bling em ' + String(l.aplicado_em).slice(0, 10) + ' — não dá mais pra alterar. Para corrigir, faça um lançamento novo.' });
        return true;
      }

      const novo = Number(l.contado) + delta;
      /* não deixa a contagem ficar negativa: unidade negativa não existe na prateleira, e o
         botão − seguido de cliques rápidos chegaria lá sem querer */
      if (novo < 0) { json(res, 200, { ok: false, erro: 'a contagem não pode ficar negativa' }); return true; }
      /* Codex #511 (P2, r2): um lançamento já no teto de 1.000.000 (o mesmo limite do
         lançamento e do /contagem-definir) aceitava +1 e ia pra 1.000.001 — o botão + não
         tinha o mesmo teto dos outros dois caminhos pro mesmo campo. */
      if (novo > 1000000) { json(res, 200, { ok: false, erro: 'quantidade acima do razoável — confira o que digitou' }); return true; }

      if (!Array.isArray(l.ajustes)) l.ajustes = [];
      l.ajustes.push({ de: l.contado, para: novo, quem: String(sess.nome || sess || ''), quando: new Date().toISOString() });
      l.contado = novo;
      /* a divergência acompanha: ela é o que o dono olha na revisão */
      if (l.tipo !== 'somar' && l.saldo_bling_na_hora != null) l.divergencia = novo - Number(l.saldo_bling_na_hora);

      if (!gravar(d)) {
        json(res, 200, { ok: false, erro: 'não consegui salvar o ajuste — NÃO confie no número da tela' });
        return true;
      }
      json(res, 200, { ok: true, contado: novo, divergencia: l.divergencia });
      return true;
    }

    /* ── definir a quantidade direto (sem ficar clicando no +) ───────────────
       Pedido do dono: "pra eu não ter que digitar de novo o 404 caso queira adicionar mais 1".
       Os botões resolvem de 1 em 1; quando a diferença é grande, digitar o número certo é mais
       rápido e erra menos que clicar dez vezes. Mesma validação do lançamento — o número é o
       ponto do recurso inteiro. */
    if (method === 'POST' && p === (prefixo + '/contagem-definir')) {
      const sess = validarSessao(req.headers['cookie']);
      if (!sess) { json(res, 401, { ok: false, erro: 'precisa estar logado' }); return true; }
      let body = {};
      try { body = await ctx.readBody(req); } catch (e) { body = {}; }

      const id = String(body.id || '').trim();
      if (!id) { json(res, 200, { ok: false, erro: 'sem id do lançamento' }); return true; }

      const bruto = String(body.contado == null ? '' : body.contado).trim().replace(',', '.');
      const n = Number(bruto);
      if (bruto === '' || !isFinite(n) || n < 0 || Math.floor(n) !== n) {
        json(res, 200, { ok: false, erro: 'quantidade inválida — use um número inteiro a partir de 0' });
        return true;
      }
      if (n > 1000000) { json(res, 200, { ok: false, erro: 'quantidade acima do razoável — confira o que digitou' }); return true; }

      let d;
      try { d = ler(); } catch (e) {
        json(res, 200, { ok: false, erro: 'o arquivo de contagens está ilegível — avise o responsável' });
        return true;
      }
      if (carimbarIds(d)) gravar(d);
      const l = d.lancamentos.find(x => x && x.id === id && !x.excluido);
      if (!l) { json(res, 200, { ok: false, erro: 'lançamento não encontrado' }); return true; }
      /* Codex #524 (P2): lançamento JÁ APLICADO no Bling vira registro histórico. Editar a
         quantidade, ajustar no + / −, trocar o tipo ou excluir depois disso faz a linha deixar
         de descrever o que foi enviado — e o estoque real não muda junto. Congela. */
      if (l.aplicado_em) {
        json(res, 200, { ok: false, erro: 'este lançamento já foi aplicado no Bling em ' + String(l.aplicado_em).slice(0, 10) + ' — não dá mais pra alterar. Para corrigir, faça um lançamento novo.' });
        return true;
      }
      if (Number(l.contado) === n) { json(res, 200, { ok: true, contado: n, divergencia: l.divergencia }); return true; }

      if (!Array.isArray(l.ajustes)) l.ajustes = [];
      l.ajustes.push({ de: l.contado, para: n, quem: String(sess.nome || sess || ''), quando: new Date().toISOString() });
      l.contado = n;
      if (l.tipo !== 'somar' && l.saldo_bling_na_hora != null) l.divergencia = n - Number(l.saldo_bling_na_hora);

      if (!gravar(d)) { json(res, 200, { ok: false, erro: 'não consegui salvar — NÃO confie no número da tela' }); return true; }
      json(res, 200, { ok: true, contado: n, divergencia: l.divergencia });
      return true;
    }

    /* ── excluir um lançamento ────────────────────────────────────────────────
       Pedido do dono, com confirmação na tela. O registro NÃO some do arquivo: fica marcado
       como excluído, com quem tirou e quando, e some só da LISTA.
       Apagar de verdade tiraria do dono a chance de saber que alguém contou e desfez — e é
       exatamente isso que uma conferência precisa poder mostrar depois. */
    if (method === 'POST' && p === (prefixo + '/contagem-excluir')) {
      const sess = validarSessao(req.headers['cookie']);
      if (!sess) { json(res, 401, { ok: false, erro: 'precisa estar logado' }); return true; }
      let body = {};
      try { body = await ctx.readBody(req); } catch (e) { body = {}; }
      const id = String(body.id || '').trim();
      if (!id) { json(res, 200, { ok: false, erro: 'sem id do lançamento' }); return true; }

      let d;
      try { d = ler(); } catch (e) {
        json(res, 200, { ok: false, erro: 'o arquivo de contagens está ilegível — avise o responsável' });
        return true;
      }
      if (carimbarIds(d)) gravar(d);
      const l = d.lancamentos.find(x => x && x.id === id);
      if (!l) { json(res, 200, { ok: false, erro: 'lançamento não encontrado' }); return true; }
      /* Codex #524 (P2): lançamento JÁ APLICADO no Bling vira registro histórico. Editar a
         quantidade, ajustar no + / −, trocar o tipo ou excluir depois disso faz a linha deixar
         de descrever o que foi enviado — e o estoque real não muda junto. Congela. */
      if (l.aplicado_em) {
        json(res, 200, { ok: false, erro: 'este lançamento já foi aplicado no Bling em ' + String(l.aplicado_em).slice(0, 10) + ' — não dá mais pra alterar. Para corrigir, faça um lançamento novo.' });
        return true;
      }
      if (l.excluido) { json(res, 200, { ok: true, ja: true }); return true; }

      l.excluido = true;
      l.excluido_por = String(sess.nome || sess || '');
      l.excluido_em = new Date().toISOString();
      if (!gravar(d)) { json(res, 200, { ok: false, erro: 'não consegui excluir — a linha continua valendo' }); return true; }
      json(res, 200, { ok: true });
      return true;
    }

    /* ── trocar o TIPO de um lançamento já gravado ────────────────────────────
       O dono lançou ~10 itens antes de os dois modos existirem, querendo SOMAR, e tudo ficou
       gravado como contagem — com divergências absurdas ("Bling tinha 1115, contado 7,
       divergência −1108"). Os números que ele digitou estão certos; o que está errado é o que
       eles SIGNIFICAM.
       Não reescrevo isso sozinho: adivinhar a intenção de um registro é o mesmo erro, ao
       contrário. Ele marca, e fica registrado quem marcou e quando. */
    if (method === 'POST' && p === (prefixo + '/contagem-tipo')) {
      const sess = validarSessao(req.headers['cookie']);
      if (!sess) { json(res, 401, { ok: false, erro: 'precisa estar logado' }); return true; }
      let body = {};
      try { body = await ctx.readBody(req); } catch (e) { body = {}; }

      const id = String(body.id || '').trim();
      const novoTipo = String(body.tipo || '').trim();
      if (!id) { json(res, 200, { ok: false, erro: 'sem id do lançamento' }); return true; }
      if (novoTipo !== 'somar' && novoTipo !== 'contagem') {
        json(res, 200, { ok: false, erro: 'tipo inválido' }); return true;
      }

      let d;
      try { d = ler(); } catch (e) {
        json(res, 200, { ok: false, erro: 'o arquivo de contagens está ilegível — avise o responsável' });
        return true;
      }
      if (carimbarIds(d)) gravar(d);
      const l = d.lancamentos.find(x => x && x.id === id && !x.excluido);
      if (!l) { json(res, 200, { ok: false, erro: 'lançamento não encontrado' }); return true; }
      /* Codex #524 (P2): lançamento JÁ APLICADO no Bling vira registro histórico. Editar a
         quantidade, ajustar no + / −, trocar o tipo ou excluir depois disso faz a linha deixar
         de descrever o que foi enviado — e o estoque real não muda junto. Congela. */
      if (l.aplicado_em) {
        json(res, 200, { ok: false, erro: 'este lançamento já foi aplicado no Bling em ' + String(l.aplicado_em).slice(0, 10) + ' — não dá mais pra alterar. Para corrigir, faça um lançamento novo.' });
        return true;
      }

      const antes = l.tipo || 'contagem';
      if (antes === novoTipo) { json(res, 200, { ok: true, tipo: novoTipo, divergencia: l.divergencia }); return true; }

      l.tipo = novoTipo;
      /* a divergência acompanha o significado: em somar ela deixa de existir, em contagem
         volta a ser calculada contra o saldo que foi guardado NO MOMENTO do lançamento */
      l.divergencia = (novoTipo === 'contagem' && l.saldo_bling_na_hora != null)
                      ? (Number(l.contado) - Number(l.saldo_bling_na_hora)) : null;
      if (!Array.isArray(l.tipo_trocas)) l.tipo_trocas = [];
      l.tipo_trocas.push({ de: antes, para: novoTipo, quem: String(sess.nome || sess || ''), quando: new Date().toISOString() });

      if (!gravar(d)) { json(res, 200, { ok: false, erro: 'não consegui salvar — o tipo NÃO foi alterado' }); return true; }
      json(res, 200, { ok: true, tipo: novoTipo, divergencia: l.divergencia });
      return true;
    }

    /* ── quais são os depósitos desta empresa ────────────────────────────────
       O id do depósito é obrigatório na entrada, e é diferente em cada empresa (o da GOOD é
       4956031259; o da Girassol ninguém tinha levantado). Em vez de mandar o dono caçar no
       Bling, esta rota lista. Admin, e só leitura. */
    if (method === 'GET' && p === (prefixo + '/contagem-depositos')) {
      const sess = validarSessao(req.headers['cookie']);
      if (!sess) { json(res, 401, { ok: false, erro: 'precisa estar logado' }); return true; }
      /* Codex #524 (P2): eu documentei como admin e deixei qualquer sessão entrar. É metadado
         de configuração da empresa, e o fluxo equivalente já exige chave. */
      if (!ctx.ehAdmin || !ctx.ehAdmin(String(sess.nome || sess || ''))) {
        json(res, 200, { ok: false, erro: 'só o responsável vê os depósitos' });
        return true;
      }
      const lib = _estoqueEntrada();
      try {
        json(res, 200, { ok: true, depositos: await lib.listarDepositos(), configurado: depositoDaEmpresa() || null });
      } catch (e) {
        json(res, 200, { ok: false, erro: String(e.message || e) });
      }
      return true;
    }

    /* ── APLICAR no estoque do Bling ──────────────────────────────────────────
       ⚠️ A ÚNICA OPERAÇÃO DESTE PROJETO QUE ESCREVE NO BLING, e é de mão única: aplicado só
       se desfaz com outro lançamento. Por isso cada trava abaixo RECUSA em vez de tentar.

       Exige ADMIN: o desenho que o dono descreveu em 22/09 é o funcionário informar e ELE
       aprovar depois. Enquanto é ele mesmo lançando não muda nada; quando o Lucas e o Ygor
       usarem, muda tudo. */
    if (method === 'POST' && p === (prefixo + '/contagem-aplicar')) {
      const sess = validarSessao(req.headers['cookie']);
      if (!sess) { json(res, 401, { ok: false, erro: 'precisa estar logado' }); return true; }
      /* Codex #524 (P1): `ehAdmin` devolve TRUE quando a lista de admins está VAZIA — é o
         comportamento antigo, de quando não havia lista. Eu me apoiei nele sem ler isso: com a
         env não configurada, QUALQUER pessoa logada lançaria no estoque real.
         Aqui a ausência de lista não é permissão: é configuração faltando, e a escrita é de mão
         única. Exige lista configurada E o nome nela. */
      const listaAdmins = (process.env[(ctx.empresa && ctx.empresa.envAdmin) || 'GIRABKP_ADMIN'] || '')
        .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
      if (!listaAdmins.length) {
        json(res, 200, { ok: false, erro: 'nenhum responsável configurado para lançar no estoque — configure a lista de admins antes' });
        return true;
      }
      if (!listaAdmins.includes(String(sess.nome || sess || '').trim().toLowerCase())) {
        json(res, 200, { ok: false, erro: 'só o responsável pode lançar no estoque do Bling' });
        return true;
      }
      let body = {};
      try { body = await ctx.readBody(req); } catch (e) { body = {}; }
      const id = String(body.id || '').trim();
      if (!id) { json(res, 200, { ok: false, erro: 'sem id do lançamento' }); return true; }

      const dep = depositoDaEmpresa();
      if (!dep) {
        json(res, 200, { ok: false, erro: 'depósito desta empresa não configurado — veja /contagem-depositos e configure a env antes de lançar' });
        return true;
      }

      let d;
      try { d = ler(); } catch (e) {
        json(res, 200, { ok: false, erro: 'o arquivo de contagens está ilegível — avise o responsável' });
        return true;
      }
      if (carimbarIds(d)) gravar(d);
      const l = d.lancamentos.find(x => x && x.id === id && !x.excluido);
      if (!l) { json(res, 200, { ok: false, erro: 'lançamento não encontrado' }); return true; }

      /* as três recusas que evitam estoque errado no Bling */
      if (l.aplicado_em) {
        json(res, 200, { ok: false, ja: true, erro: 'este lançamento JÁ foi aplicado em ' + l.aplicado_em + ' — aplicar de novo somaria em dobro' });
        return true;
      }
      if (l.tipo !== 'somar') {
        json(res, 200, { ok: false, erro: 'só lançamento do tipo SOMAR entra no estoque: uma CONTAGEM diz quanto TEM, e somar esse número duplicaria o saldo' });
        return true;
      }
      /* trava de concorrência: dois cliques quase juntos não podem virar duas entradas */
      if (l.aplicando_em && (Date.now() - Date.parse(l.aplicando_em)) < 120000) {
        json(res, 200, { ok: false, erro: 'já há um lançamento deste item em andamento — espere terminar' });
        return true;
      }
      l.aplicando_em = new Date().toISOString();
      if (!gravar(d)) { json(res, 200, { ok: false, erro: 'não consegui reservar o lançamento — nada foi enviado ao Bling' }); return true; }

      const lib = _estoqueEntrada();
      const r = await lib.entrada({
        sku: l.sku,
        quantidade: Number(l.contado),
        /* Codex #524 (P2): a data vinha do ISO cru (UTC). Um lançamento das 21h-23h59 de SP
           gravaria no Bling a observação com o dia SEGUINTE — e a observação é irreversível. */
        observacao: 'Contagem ' + (() => {
          try { return new Date(l.quando).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 10); }
          catch (e) { return String(l.quando || '').slice(0, 10); }
        })() + ' por ' + String(l.quem || ''),
        depositoId: dep,
      });

      /* relê antes de gravar o resultado: a rodada pode ter demorado e outra mão ter mexido */
      try { d = ler(); } catch (e) { d = null; }
      const l2 = d && d.lancamentos.find(x => x && x.id === id);
      /* Codex #524 (P1): se a releitura ou a gravação do marcador falhar, o Bling JÁ recebEU a
         entrada — mas o registro local não sabe. Responder ok aqui faria a linha continuar com
         o botão 📦, e o próximo clique somaria DE NOVO no estoque real.
         Quando não consigo marcar, digo exatamente isso: lançou, mas não registrei. */
      if (!l2) {
        json(res, 200, { ok: false, aplicouSemRegistrar: !!r.ok, erro: r.ok
          ? '⚠️ A ENTRADA FOI LANÇADA NO BLING, mas não consegui registrar aqui. NÃO lance de novo — confira no Bling.'
          : (r.erro || 'falhou') });
        return true;
      }
      if (l2) {
        delete l2.aplicando_em;
        if (r.ok) {
          l2.aplicado_em = new Date().toISOString();
          l2.aplicado_por = String(sess.nome || sess || '');
          l2.bling_produto_id = r.produto_id;
          l2.bling_deposito = r.deposito;
          l2.bling_link = r.link;
          /* Codex #524 (P2): a falha anterior ficava gravada, e a linha mostrava "✅ no Bling"
             E "⚠ falhou" ao mesmo tempo — quem revisa não saberia se entrou ou não. */
          delete l2.ultima_falha; delete l2.ultima_falha_em;
        } else {
          l2.ultima_falha = String(r.erro || '').slice(0, 300);
          l2.ultima_falha_em = new Date().toISOString();
        }
        if (!gravar(d) && r.ok) {
          json(res, 200, { ok: false, aplicouSemRegistrar: true,
            erro: '⚠️ A ENTRADA FOI LANÇADA NO BLING, mas não consegui registrar aqui. NÃO lance de novo — confira no Bling: ' + (r.link || '') });
          return true;
        }
      }
      json(res, 200, r.ok ? { ok: true, link: r.link, quantidade: r.quantidade, custo: r.custo } : r);
      return true;
    }

    /* ── lista pra revisão ── */
    if (method === 'GET' && p === (prefixo + '/contagem-lista')) {
      const sess = validarSessao(req.headers['cookie']);
      if (!sess) { json(res, 401, { ok: false, erro: 'precisa estar logado' }); return true; }
      let d;
      try { d = ler(); } catch (e) {
        json(res, 200, { ok: false, erro: 'arquivo de contagens ilegível' });
        return true;
      }
      if (carimbarIds(d)) gravar(d);   // arquivo antigo: sem isto a lista vem sem os botões
      const de = String(urlObj.searchParams.get('de') || '');
      /* Codex #509 (P2): o carimbo `quando` é ISO (UTC) e o `de` chega como dia de SÃO PAULO.
         Comparar os dois por prefixo de texto punha os lançamentos das 21h-23h59 de ontem
         dentro do "hoje" do dia seguinte inteiro — o turno da noite aparecia duas vezes e o
         funcionário via contagem que não era dele. Converte o carimbo pro dia de SP antes. */
      const diaSP = (iso) => {
        try {
          return new Date(iso).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 10);
        } catch (e) { return String(iso).slice(0, 10); }
      };
      /* excluído some da LISTA, não do arquivo: o registro guarda quem tirou e quando, porque
         uma conferência precisa poder mostrar que alguém contou e desfez. */
      const vivos = d.lancamentos.filter(l => l && !l.excluido);
      const lista = de ? vivos.filter(l => diaSP(l.quando) >= de) : vivos;
      /* mais recente primeiro, com paginação: sem isto, um dia com mais de 500
         lançamentos (contagem geral do galpão) perdia os mais antigos da revisão
         em silêncio — a lista dizia "acabou" sem ter mostrado tudo */
      const ordenada = lista.slice().reverse();
      const off = Math.max(0, parseInt(urlObj.searchParams.get('offset'), 10) || 0);
      const pagina = ordenada.slice(off, off + 500);
      json(res, 200, {
        ok: true,
        lancamentos: pagina,
        total_no_filtro: lista.length,
        total: vivos.length,
        tem_mais: off + pagina.length < ordenada.length,
        proximo_offset: off + pagina.length,
        com_divergencia: lista.filter(l => l.divergencia != null && l.divergencia !== 0).length,
      });
      return true;
    }

    /* ── saldo AO VIVO (sem cache) pro card de contagem ──
       Codex (P1): buscar-produto usa produtoDetalhe, cujo cache não tem TTL e só é
       limpo quando o ciclo do checkout roda — pra quem já foi resolvido no ciclo
       atual, o saldo mostrado pode ser de horas atrás. Aqui o saldo É o dado: uma
       venda ou ajuste no meio do caminho vira uma divergência gravada errada e
       permanente. Mesmo padrão do /estoque-pedido: vai direto ao Bling. */
    if (method === 'GET' && p === (prefixo + '/contagem-saldo')) {
      const sess = validarSessao(req.headers['cookie']);
      if (!sess) { json(res, 401, { ok: false, erro: 'precisa estar logado' }); return true; }
      const sku = String(urlObj.searchParams.get('sku') || '').trim();
      if (!sku) { json(res, 200, { ok: false, erro: 'sem SKU' }); return true; }
      const r = await saldoAoVivo(sku, true);
      if (!r.achou) { json(res, 200, { ok: false, erro: 'produto não encontrado no Bling' }); return true; }
      json(res, 200, { ok: true, saldo: r.saldo, localizacao: r.localizacao || '' });
      return true;
    }

    return false;
  };
}

module.exports = { criar };
