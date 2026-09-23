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
   readJson, writeJson, empresa */
function criar(ctx) {
  for (const n of ['prefixo', 'json', 'validarSessao', 'lerIndiceEan', 'CACHE_DIR',
                   'readJson', 'writeJson', 'empresa', 'blingGet']) {
    if (!ctx || ctx[n] === undefined) throw new Error('rotas-contagem: falta ' + n + ' no contexto');
  }
  const { prefixo, json, validarSessao, lerIndiceEan, CACHE_DIR, readJson, writeJson, empresa } = ctx;

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
     deixar passar um kit que a busca já escondeu. */
  async function ehKitNoBling(sku) {
    try {
      const r = await ctx.blingGet(`/produtos?codigo=${encodeURIComponent(sku)}&limite=1`);
      const it = r.ok && r.data && r.data.data && r.data.data[0];
      if (!it) return { kit: false, sabido: false };
      return { kit: String(it.formato || '').toUpperCase() === 'E', sabido: true };
    } catch (e) { return { kit: false, sabido: false }; }
  }

  async function saldoAoVivo(sku, detalhado) {
    const variantes = [...new Set([sku, sku.toUpperCase(), sku.toLowerCase()])];
    const controle = new AbortController();
    const relogio = setTimeout(() => controle.abort(), 15000);
    try {
      let saldo = null, achou = false;
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
          break;
        } catch (e) {}
      }
      return detalhado ? { saldo, achou } : saldo;
    } finally {
      clearTimeout(relogio);
    }
  }

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
        json(res, 200, { ok: false, erro: 'esse SKU é um KIT — conte os produtos que o compõem, não o kit' });
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
        contado: n,
        /* o saldo do Bling é guardado COMO ESTAVA NO MOMENTO da contagem: é o
           que torna a divergência auditável depois. Recalcular na revisão
           compararia a contagem de ontem com o saldo de hoje */
        saldo_bling_na_hora: (saldoBling != null && isFinite(saldoBling)) ? saldoBling : null,
        /* de onde veio o saldo: conferido no Bling no instante do lançamento, ou herdado da
           tela. A revisão precisa saber a diferença antes de confiar na divergência. */
        saldo_conferido_na_hora: saldoVeioDoBling,
        divergencia: (saldoBling != null && isFinite(saldoBling)) ? (n - saldoBling) : null,
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
      if (l.saldo_bling_na_hora != null) l.divergencia = novo - Number(l.saldo_bling_na_hora);

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
      if (Number(l.contado) === n) { json(res, 200, { ok: true, contado: n, divergencia: l.divergencia }); return true; }

      if (!Array.isArray(l.ajustes)) l.ajustes = [];
      l.ajustes.push({ de: l.contado, para: n, quem: String(sess.nome || sess || ''), quando: new Date().toISOString() });
      l.contado = n;
      if (l.saldo_bling_na_hora != null) l.divergencia = n - Number(l.saldo_bling_na_hora);

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
      if (l.excluido) { json(res, 200, { ok: true, ja: true }); return true; }

      l.excluido = true;
      l.excluido_por = String(sess.nome || sess || '');
      l.excluido_em = new Date().toISOString();
      if (!gravar(d)) { json(res, 200, { ok: false, erro: 'não consegui excluir — a linha continua valendo' }); return true; }
      json(res, 200, { ok: true });
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
      json(res, 200, { ok: true, saldo: r.saldo });
      return true;
    }

    return false;
  };
}

module.exports = { criar };
