'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   CANÁRIO MARKETPLACE × BLING — os ADAPTADORES por empresa (21/10/2026, Fase 3 / lib 100%).

   A regra do canário já era peça (lib/canario-marketplace, lib/canario-conserto); o que ficava em CÓPIA era o bloco
   dos adaptadores — listar os pedidos no Bling, listar as vendas em cada marketplace (ML, Shopee, Magalu, TikTok),
   achar o pacote de uma venda do ML e as ordens de um pacote, e o conserto (reimportar a venda do ML que não chegou).
   ~200 linhas, iguais na Girassol e na AMB a menos de: token do ML, chave da Shopee, conta do TikTok — e o conserto,
   que só a Girassol tinha. A GOOD não tinha canário.

   Aqui o bloco é UM, nascido da Girassol (a mais completa), com o que é da empresa vindo de lib/checkout/config-empresa
   (token do ML, chave da Shopee pela regra do canário, conta do TikTok, importador do ML) e as peças do módulo pela
   função deps (lidas na hora da chamada). Empresa sem módulo da Shopee (pedirAoSync) ou sem importador do ML: o canal
   / o conserto ficam de fora com aviso, sem quebrar.
   ───────────────────────────────────────────────────────────────────────────── */

const path = require('path');

function criarCanarioDaEmpresa(empresa, extra) {
  const cfg = require('./config-empresa').configCheckout(empresa);
  const x = extra || {};
  if (typeof x.deps !== 'function') throw new Error('lib/checkout/canario-empresa: falta deps (as peças do módulo da empresa)');
  const _dep = () => x.deps();
  const raiz = path.join(__dirname, '..', '..');
  const C = {
    tiktokConta: cfg.tiktokConta,
    shopeeKey: () => cfg.ler(cfg.canario.shopeeKey),
    mlTokenManager: x.mlTokenManager || (() => require(path.join(raiz, cfg.mlTokenManager))),
    importarPedido: x.importarPedido || (cfg.importarPedido ? () => require(path.join(raiz, cfg.importarPedido)) : null),
  };

  const _listarNoBlingCanario = async (de, ate) => {
    const porCanal = {};
    // Codex (P1): o Bling tem bug conhecido no MESMO DIA — o vendasSync já contorna
    // pedindo um dia a mais. Sem isso, venda de hoje sumiria e seria acusada de falta.
    const ateMais1 = new Date(Date.parse(ate + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
    /* 06/09 — UM DIA PRA TRÁS TAMBÉM, e agora com prova. A venda 2000018258015754 foi acusada de
       sumida por dias; o raio-x mostrou que ela ESTÁ no Bling (pedido 121197, gravado pelo pack
       2000014842564493) — só que com data 02/09, enquanto o ML a registra em 03/09 00:29 no
       horário de Brasília (23:29 do dia 2 no fuso -04:00 que o ML usa). Como o canário buscava no
       Bling a partir de 03/09, o pedido caía fora da janela e era contado como ausente.
       Não é atraso de importação — o Bling importa na aprovação. É a data de registro caindo do
       outro lado da meia-noite conforme o fuso. Venda perto da virada do dia sempre correu esse
       risco; um dia de folga em cada ponta resolve, e o custo é só ler mais algumas páginas. */
    const deMenos1 = new Date(Date.parse(de + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
    const MAX_PG = 200;
    for (let pg = 1; pg <= MAX_PG; pg++) {
      // 16/08 — MEDIDO em produção: rodar o canário JUNTO com o backfill estourou a cota do
      // Bling e voltou HTTP 429 na 2ª página. 429 é fila cheia, não integração quebrada —
      // então espera e tenta de novo. Erro de verdade (401/404) aborta na hora, sem insistir.
      let r = null;
      for (let tent = 1; tent <= 4; tent++) {
        r = await _dep().blingGet('/pedidos/vendas?dataInicial=' + deMenos1 + '&dataFinal=' + ateMais1 + '&pagina=' + pg + '&limite=100');
        if (r && r.ok) break;
        const st429 = (r && r.status) || 0;
        if (st429 !== 429 && st429 !== 0 && st429 < 500) break;
        // Codex: não dormir depois da ÚLTIMA tentativa — eram 16s de espera sem ninguém
        // atrás (o blingGet já tem retry próprio; a soma passava de 1 minuto pra nada).
        if (tent < 4) await new Promise(r2 => setTimeout(r2, tent * 4000));
      }
      // Codex (P2): falha do Bling NÃO pode virar "nenhum pedido" — isso acusaria o
      // marketplace inteiro de sumido quando o problema é a nossa própria consulta.
      // Codex: o blingGet devolve 429 TAMBÉM quando a rede falha (DNS, conexão) — afirmar
      // "cota estourada" mandaria investigar o lado errado. A mensagem passa a citar as duas
      // hipóteses, na ordem provável.
      if (!r || !r.ok) throw new Error('Bling não respondeu na página ' + pg + ' (HTTP ' + ((r && r.status) || '?') + ')' +
        (((r && r.status) === 429) ? ' — cota da API estourada OU Bling inacessível (rede). Se houver backfill rodando, é cota; senão, cheque o Bling.' : ''));
      const arr = (r.data && r.data.data) || [];
      if (!arr.length) break;
      for (const pd of arr) {
        const lid = String((pd.loja && pd.loja.id) || '');
        const canal = _dep().LOJA_MKT[lid] || 'outro';
        const nl = String(pd.numeroPedidoLoja || pd.numeroLoja || '').trim();
        if (!nl) continue;
        (porCanal[canal] = porCanal[canal] || new Set()).add(nl);
        /* 06/09 — CARRINHO. O ML gera UM NÚMERO POR ITEM vendido e um pack_id que agrupa; o
           Bling cria UM pedido só e vincula os dois. O canário comparava "vendas do ML" com
           "pedidos do Bling" e acusava a metade que não virou o numeroPedidoLoja principal —
           54 de 174 num sábado, com veredito 🔴 e a sugestão de reautorizar a integração, que
           estava perfeita. O dono conferiu no Bling: a venda estava lá, com NF emitida, e o
           pedido mostrava "vinculados: 2000018267208364, 2000018267197550" — as duas metades
           do mesmo carrinho, ambas na lista de "sumidas". Alarme falso ensina a ignorar
           alarme, então aqui as irmãs de pack entram no conjunto também. */
        const irmas = _dep().irmasDoPack(nl);
        if (irmas) for (const irma of irmas) porCanal[canal].add(irma);
      }
      if (arr.length < 100) break;
      // Codex (P2): página cheia no teto = lista truncada, e truncada não vale comparar
      if (pg === MAX_PG) throw new Error('mais de ' + (MAX_PG * 100) + ' pedidos no Bling nesse período — reduza &dias=');
      await new Promise(r2 => setTimeout(r2, 150));
    }
    return porCanal;
  };

  /* 06/09 (Codex #335 r2) — pack e ordens do pacote, para o canário conferir os faltantes.
     ENDPOINT: /packs/{id} com data.orders, que é o que o repo já usa em girassol/importarPedido.js
     (eu tinha pego /marketplace/orders/pack/{id} da documentação; o Codex mostrou que o caminho
     consolidado aqui é outro, e coerência com o que já funciona vale mais que a doc).
     TOKEN: pego UMA vez por rodada e passado adiante — garantirTokenML() faz um /users/me a cada
     chamada, então validar por candidato multiplicava as requisições justamente quando há muitos
     faltantes, que é quando o ML já está sob pressão. */
  /* 06/09 — CONSERTO AUTOMÁTICO do que o canário achou. Reimporta a venda que não chegou ao
     Bling, uma a uma e só quando são poucas; acima do teto vira aviso, porque muita falta é
     integração caída e reimportar não resolveria. Antes de criar, reconfere se já está lá — o
     canário errou 54 vezes esta semana e criar duplicata mexe em estoque, NF e imposto. */
  async function _consertarDoCanario(resultado) {
    const cons = require('../canario-conserto');
    return await cons.consertar(resultado, {
      cacheDir: _dep().CACHE_DIR,
      maxAuto: Number(process.env.CANARIO_MAX_AUTO || 5),
      jaEstaNoBling: async (canal, venda) => {
        if (canal !== 'ml') return false;
        try {
          const hoje = new Date();
          const de = new Date(hoje.getTime() - 10 * 86400000).toISOString().slice(0, 10);
          const ate = new Date(hoje.getTime() + 86400000).toISOString().slice(0, 10);
          const mapa = await _listarNoBlingCanario(de, ate);
          const set = (mapa && mapa[canal]) || new Set();
          if (set.has(String(venda))) return true;
          const rp = await _packDaVendaCanario(canal, venda);
          const pack = rp && typeof rp === 'object' ? rp.pack : rp;
          return !!(pack && set.has(String(pack)));
        } catch (e) { return true; }   /* na dúvida, NÃO cria: duplicar é pior que deixar faltando */
      },
      reimportar: async (canal, venda) => {
        if (canal !== 'ml') return { ok: false, erro: 'conserto automático só implementado pro ML' };
        /* 21/10: só quem tem o importador do ML (hoje a Girassol) reimporta sozinho; as demais ficam no aviso */
        if (!C.importarPedido) return { ok: false, erro: 'esta empresa ainda não tem o importador do ML — conserto só por aviso' };
        const { testarImportarPedido } = C.importarPedido();
        const r = await testarImportarPedido(String(venda), true);
        /* Codex #742: o importador (lib/importar-pedido-ml) devolve { modo: 'CRIADO', pedidoCriado } quando o Bling
           ACEITOU o pedido (ele lança em qualquer recusa). Sem reconhecer isso, toda criação de verdade virava "erro" e o
           aviso mandava importar à mão — convite à duplicata. Vale pra Girassol desde que o importador entrou aqui. */
        if (r && r.modo === 'CRIADO') return { ok: true, pedido: (r.pedidoCriado && (r.pedidoCriado.numero || r.pedidoCriado.id)) || null };
        if (r && (r.criado || r.pedido || r.ok)) return { ok: true, pedido: (r.pedido && r.pedido.numero) || r.numero || null };
        return { ok: false, erro: (r && (r.erro || r.msg)) || 'importação não confirmou criação' };
      }
    });
  }

  const _packCacheVenda = new Map();
  const _packOrdensCache = new Map();
  /* Codex #335 r4: eu escrevi que garantirTokenML() tem cache próprio — NÃO TEM. Ele faz um
     /users/me a cada chamada (mlTokenManager.js:69-78), então uma rodada com muitos faltantes
     dispara uma validação por candidato. Cache curto aqui, dentro de UMA rodada: 60 segundos
     resolve a rajada e é curto demais pra segurar um token que expirou. */
  let _tkCanario = { tk: null, ts: 0 };
  async function _tokenMLCanario() {
    if (_tkCanario.tk && (Date.now() - _tkCanario.ts) < 60000) return _tkCanario.tk;
    const { garantirTokenML } = C.mlTokenManager();
    const tk = await garantirTokenML();
    _tkCanario = { tk, ts: Date.now() };
    return tk;
  }
  const _packDaVendaCanario = async (canal, venda) => {
    if (canal !== 'ml') return null;
    const k = String(venda);
    const em = _packCacheVenda.get(k);
    if (em && (Date.now() - em.ts) < (em.ttl || 60 * 60000)) return { pack: em.pack, erro: em.erro || undefined, doCache: true };
    try {
      const tk = await _tokenMLCanario();
      const r = await _dep().fetch('https://api.mercadolibre.com/orders/' + k, { headers: { Authorization: 'Bearer ' + tk }, signal: AbortSignal.timeout(15000) });
      /* Codex #335 r5: cachear TAMBÉM o erro HTTP (404, 429, 5xx). Eu tinha cacheado só a
         resposta vazia; com erro, a venda voltava a ser consultada em toda rodada, consumia o
         teto, e os candidatos seguintes nunca eram inspecionados — o mesmo furo do orçamento
         pela quarta porta. TTL curto (15 min) porque erro pode ser transitório. */
      /* Codex #347 (P1): falha de consulta NÃO é "sem pack" — o flag `erro` deixa a lib jogar
         o candidato em NAO_CONFIRMADAS em vez de acusar ausência. E o CONCLUSIVO agora vive 26h
         (o cron é diário; com 1h, toda noturna re-gastava o teto nos mesmos primeiros e o resto
         nunca era inspecionado). Erro segue 15 min. */
      if (!r.ok) { _packCacheVenda.set(k, { pack: null, erro: true, ts: Date.now(), ttl: 15 * 60000 }); return { pack: null, erro: true, doCache: false }; }
      const d = await r.json().catch(() => null);
      if (!d) { _packCacheVenda.set(k, { pack: null, erro: true, ts: Date.now(), ttl: 15 * 60000 }); return { pack: null, erro: true, doCache: false }; }
      const pack = d.pack_id ? String(d.pack_id) : null;
      _packCacheVenda.set(k, { pack, ts: Date.now(), ttl: 7 * 86400000 });
      return { pack, doCache: false };
    } catch (e) { _packCacheVenda.set(k, { pack: null, erro: true, ts: Date.now(), ttl: 15 * 60000 }); return { pack: null, erro: true, doCache: false }; }
  };
  const _ordensDoPackCanario = async (canal, pack) => {
    if (canal !== 'ml') return null;
    const k = String(pack);
    const em = _packOrdensCache.get(k);
    if (em && (Date.now() - em.ts) < (em.ttl || 60 * 60000)) return { ordens: em.ordens, erro: em.erro || undefined, doCache: true };
    try {
      const tk = await _tokenMLCanario();
      const r = await _dep().fetch('https://api.mercadolibre.com/packs/' + k, { headers: { Authorization: 'Bearer ' + tk }, signal: AbortSignal.timeout(15000) });
      /* mesma razão do /orders acima */
      if (!r.ok) { _packOrdensCache.set(k, { ordens: null, erro: true, ts: Date.now(), ttl: 15 * 60000 }); return { ordens: null, erro: true, doCache: false }; }
      const d = await r.json().catch(() => null);
      const ordens = (d && Array.isArray(d.orders)) ? d.orders.map(o => String(o.id)) : null;
      /* Codex #347 (P1): resposta sem `orders` legível é falha de leitura, não pack vazio */
      if (!ordens) { _packOrdensCache.set(k, { ordens: null, erro: true, ts: Date.now(), ttl: 15 * 60000 }); return { ordens: null, erro: true, doCache: false }; }
      /* Codex #335 r4: cachear TAMBÉM quando não deu (404, erro, resposta sem orders). Sem isso,
         um pack que sempre falha volta a ser consultado em toda rodada e consome o teto pra
         sempre — o lote nunca avança pros seguintes, que é o furo que este orçamento veio
         evitar. Falha fica 15 min no cache; sucesso, 1h. */
      _packOrdensCache.set(k, { ordens, ts: Date.now(), ttl: 7 * 86400000 });
      return { ordens, doCache: false };
    } catch (e) { _packOrdensCache.set(k, { ordens: null, erro: true, ts: Date.now(), ttl: 15 * 60000 }); return { ordens: null, erro: true, doCache: false }; }
  };

  const _listarNoMarketplaceCanario = async (canal, deTs, ateTs) => {
    if (canal === 'shopee') {
      if (!C.shopeeKey()) return null;
      if (typeof _dep().pedirAoSync !== 'function') return null;   /* 21/10: empresa sem o módulo da Shopee (a GOOD) */
      const ids = [];
      for (let ini = deTs; ini < ateTs; ini += 15 * 86400) {
        const fimJ = Math.min(ini + 15 * 86400 - 1, ateTs);
        let cursor = '';
        const MAX_PG_SH = 60;
        for (let v = 1; v <= MAX_PG_SH; v++) {
          // Codex (P2): pedido não pago ou cancelado NÃO desce pro Bling — cobrá-lo seria
          // alarme falso. Pede o status junto e filtra abaixo.
          const q = 'time_range_field=create_time&time_from=' + ini + '&time_to=' + fimJ + '&page_size=100&response_optional_fields=order_status' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
          const r = await _dep().pedirAoSync('shopee-raw', { caminho: '/api/v2/order/get_order_list', q });
          const cru = r && r.dados && r.dados.resposta;
          const resp = cru && cru.response;
          // Codex (P1): erro do proxy/da Shopee NÃO pode virar lista vazia — vazio seria
          // lido como "o marketplace não vendeu nada", que é o oposto do que aconteceu.
          if (!resp) throw new Error('Shopee não respondeu: ' + String((cru && (cru.error || cru.message)) || (r && r.erro) || 'sem resposta').slice(0, 120));
          // Codex (P1): INVOICE_PENDING é pedido PAGO esperando nota — ele PRECISA estar no
          // Bling justamente pra ser faturado. Excluir escondia a queda de integração no estado
          // mais comum da madrugada, que é exatamente o cenário que este canário existe pra pegar.
          const FORA_SH = ['UNPAID', 'CANCELLED'];
          for (const o of (resp.order_list || [])) {
            if (!o || !o.order_sn) continue;
            if (FORA_SH.indexOf(String(o.order_status || '').toUpperCase()) >= 0) continue;
            ids.push(String(o.order_sn));
          }
          cursor = resp.next_cursor || '';
          if (!resp.more || !cursor) break;
          // Codex (P1): teto atingido com "more" ainda ligado = truncado
          if (v === MAX_PG_SH) return { incompleto: true, motivo: 'Shopee com mais de ' + (MAX_PG_SH * 100) + ' pedidos na janela' };
          await new Promise(r2 => setTimeout(r2, 200));
        }
      }
      return ids;
    }
    if (canal === 'tiktok') {
      let tk = null;
      /* x.tiktokOAuth: o teste injeta um cliente de mentira (Codex #726) — em produção é o módulo do repo */
      try { tk = x.tiktokOAuth ? x.tiktokOAuth() : require('../../tiktok-oauth'); } catch (e) { return null; }
      if (!tk || typeof tk.chamar !== 'function' || !tk.lerToken || !tk.lerToken(C.tiktokConta)) return null;
      const ids = [];
      let pageToken = '';
      const MAX_PG_TK = 100;
      for (let v = 1; v <= MAX_PG_TK; v++) {
        const r = await tk.chamar('/order/202309/orders/search',
          Object.assign({ page_size: '50' }, pageToken ? { page_token: pageToken } : {}),
          { metodo: 'POST', body: { create_time_ge: deTs, create_time_lt: ateTs } }, C.tiktokConta);
        // Codex (P1): erro do TikTok pode vir COM `data` preenchido — aceitar isso lia
        // lista vazia como sucesso. A lib do financeiro exige ok + code 0; aqui idem.
        if (!r || !r.ok || !r.corpo || r.corpo.code !== 0) {
          throw new Error('TikTok não respondeu: ' + String((r && r.corpo && r.corpo.message) || ('HTTP ' + (r && r.http))).slice(0, 120));
        }
        const d = r.corpo.data || {};
        const FORA_TK = ['UNPAID', 'CANCELLED'];
        for (const o of (d.orders || [])) {
          if (!o || !o.id) continue;
          if (FORA_TK.indexOf(String(o.status || '').toUpperCase()) >= 0) continue;
          ids.push(String(o.id));
        }
        pageToken = d.next_page_token || '';
        if (!pageToken) break;
        if (v === MAX_PG_TK) return { incompleto: true, motivo: 'TikTok com mais de ' + (MAX_PG_TK * 50) + ' pedidos no período' };
        await new Promise(r2 => setTimeout(r2, 200));
      }
      return ids;
    }
    if (canal === 'ml') {
      // 17/08 — o ML era o buraco do canário: ficava "sem fonte", e na AMB ele é 3.262 das 4.903
      // linhas do ano. Sem ele o veredito não cobria o canal que mais pesa.
      // Reusa o padrão que o backfill já usa: janelas de 5 DIAS (o /orders/search tem teto de
      // 1.000 e período grande perderia o excedente EM SILÊNCIO) e só pedido `paid` — não pago ou
      // cancelado não desce pro Bling e viraria alarme falso.
      let tkML = null;
      try { const { garantirTokenML: _gt } = C.mlTokenManager(); tkML = await _gt(); }
      catch (e) { return null; }
      if (!tkML) return null;
      /* Codex #347 (P1): sem abort, conexão pendurada no ML segurava a noturna e o
         _canario.ativos nunca zerava — backfill bloqueado pra sempre. 15s no padrão do
         raio-x-venda, com signal NOVO por chamada (AbortSignal.timeout dispara uma vez só). */
      const _HML = () => ({ headers: { Authorization: 'Bearer ' + tkML }, signal: AbortSignal.timeout(15000) });
      let sellerId = null;
      try {
        const rm = await _dep().fetch('https://api.mercadolibre.com/users/me', _HML());
        const dm = await rm.json().catch(() => null);
        if (rm.ok && dm && dm.id) sellerId = dm.id;
      } catch (e) {}
      if (!sellerId) throw new Error('não consegui identificar o vendedor no ML (/users/me)');
      const ids = [];
      /* Codex #347 r2 (P2): a janela por DIA-CALENDÁRIO em UTC começava até 3h DEPOIS de deTs
         (deTs entre 00:00-02:59Z caía no dia -03 seguinte) — e filtro nenhum restaura o que a
         query nem buscou. Limites agora são o INSTANTE EXATO, expresso em -03 como o ML espera. */
      const _iso03 = ts => new Date((ts - 10800) * 1000).toISOString().slice(0, 23) + '-03:00';
      for (let ini = deTs; ini <= ateTs; ini += 5 * 86400) {
        const fimJ = Math.min(ini + 5 * 86400 - 1, ateTs);
        const base = 'https://api.mercadolibre.com/orders/search?seller=' + sellerId +
                     '&order.date_created.from=' + encodeURIComponent(_iso03(ini)) +
                     '&order.date_created.to=' + encodeURIComponent(_iso03(fimJ)) +
                     '&sort=date_asc&limit=50';
        let totalML = Infinity;
        for (let off = 0; off < 1000 && off < totalML; off += 50) {
          const r = await _dep().fetch(base + '&offset=' + off, _HML());
          if (!r.ok) throw new Error('ML não respondeu (HTTP ' + r.status + ')');
          const d = await r.json().catch(() => null);
          if (!d) throw new Error('ML devolveu resposta ilegível');
          totalML = (d.paging && Number(d.paging.total)) || 0;
          const arr = d.results || [];
          for (const o of arr) {
            if (String(o.status || '') !== 'paid') continue;
            /* Codex #347 (P1): a janela consulta DIAS INTEIROS em UTC — sem filtrar pelo
               instante, venda criada DEPOIS do fim (dentro da folga de graça) entrava na
               comparação contra um Bling fotografado antes, e a borda de meia-noite podia
               puxar o dia local errado. O instante exato decide. */
            const tsCr = Date.parse(o.date_created || '') / 1000;
            if (!tsCr || tsCr < deTs || tsCr > ateTs) continue;
            /* 06/09 — UMA VENDA, UMA ENTRADA. Antes empurrávamos o id E o pack_id na mesma
               lista "pra os dois valerem como presença" — mas isso INFLA o lado do ML: cada
               venda com pack (e o ML cria pack até com item único) virava DUAS entradas,
               enquanto o Bling tem UMA. A metade sem correspondência era acusada de sumida.
               Foi o que deu 🔴 com 54 de 174 hoje, mandando reautorizar uma integração que
               estava perfeita — o dono conferiu venda por venda no Bling, com NF emitida.
               Agora cada venda entra UMA vez, levando junto seus apelidos: o comparador aceita
               o id OU o pack como prova de presença. */
            ids.push({ id: String(o.id), apelidos: o.pack_id ? [String(o.id), String(o.pack_id)] : [String(o.id)] });
          }
          if (!arr.length) break;
          await new Promise(r2 => setTimeout(r2, 150));
        }
        if (totalML > 1000) return { incompleto: true, motivo: 'mais de 1.000 pedidos numa janela de 5 dias no ML' };
        await new Promise(r2 => setTimeout(r2, 200));
      }
      return ids;
    }
    return null;
  };

  // Codex (P1 do #104): sem isto o canário só existiria se alguém lembrasse de abrir a URL —
  // e o objetivo é justamente avisar sozinho. A noturna passa a rodar a conferência.
  // Codex (#105): a trava vivia só na ROTA, e a noturna chama esta função direto — se um
  // backfill estivesse rodando, a etapa noturna passava por fora e brigava pela cota do Bling.
  // Além disso a checagem era de mão única: começado o canário, nada impedia um backfill de
  // entrar por cima. Agora o estado é COMPARTILHADO e vale para os dois lados.
  // Codex: com booleano, duas execuções sobrepostas (rota + noturna) entravam e a primeira a
  // terminar liberava a trava enquanto a outra ainda consultava. Contador resolve.

  /* 23/10 (passo 2): a CONFERÊNCIA e as ROTAS também eram cópia (Girassol e AMB; a GOOD não tinha). O estado é UM objeto
     por empresa (o backfill da empresa lê `rodando` pra não disputar a cota do Bling com o canário). */
  const estado = { ativos: 0, desde: null };
  Object.defineProperty(estado, 'rodando', { get() { return this.ativos > 0; } });
  async function conferir(dias, canais, opts) {
    /* x.ocupado(): o backfill DA EMPRESA está rodando? ({ rodando, de, ate, do_ano }) — os dois brigam pela cota (429) */
    let oc = null; try { oc = typeof x.ocupado === 'function' ? x.ocupado() : null; } catch (e) { oc = null; }
    if (oc && oc.rodando) {
      return { ok: false, erro: 'tem backfill rodando — os dois brigam pela cota do Bling (429). Espere terminar.',
        backfill: { de: oc.de || null, ate: oc.ate || null, do_ano: !!oc.do_ano } };
    }
    const canLib = require('../canario-marketplace');
    /* sem canais pedidos: só os que a empresa consegue consultar (sem o módulo da Shopee, ela fica de fora — senão todo
       resultado traria "shopee não verificado" e nunca fecharia limpo). Canal pedido na mão vale como foi pedido. */
    if (!(Array.isArray(canais) && canais.length) && typeof _dep().pedirAoSync !== 'function') canais = ['tiktok', 'ml'];
    estado.ativos++; estado.desde = estado.desde || new Date().toISOString();
    try {
      return await canLib.conferir({ empresa: cfg.loja, listarNoBling: _listarNoBlingCanario, listarNoMarketplace: _listarNoMarketplaceCanario,
        packDaVenda: _packDaVendaCanario, ordensDoPack: _ordensDoPackCanario }, dias || 3, Array.isArray(canais) ? canais : [], opts || {});
    } finally {
      estado.ativos = Math.max(0, estado.ativos - 1);
      if (!estado.ativos) estado.desde = null;
    }
  }
  /* rotas do canário da empresa: /canario-estado (o aviso do painel; SÓ admin — o estoquista não vê a faixa, pedido do
     dono) e /canario-marketplaces (conferência na mão; admin). r: { PREFIXO, json, validarSessao, ehAdmin, lerChaveAdmin } */
  function rotas(r) {
    return async function rotasCanario(req, res, urlObj, method, p) {
      if (method !== 'GET' || (p !== r.PREFIXO + '/canario-estado' && p !== r.PREFIXO + '/canario-marketplaces')) return false;
      const sC = r.validarSessao(req.headers['cookie']);
      const kC = r.lerChaveAdmin(req, urlObj);
      const ehAdm = (sC && r.ehAdmin(sC)) || (process.env.ADMIN_KEY && kC === process.env.ADMIN_KEY);
      if (!ehAdm) { r.json(res, 404, { error: 'not found' }); return true; }
      if (p === r.PREFIXO + '/canario-estado') {
        try {
          const cons = require('../canario-conserto');
          const h = cons.historico(_dep().CACHE_DIR, 20);
          const ultimo = h[0] || null;
          const pendente = cons.pendencia(ultimo);
          r.json(res, 200, { ok: true, precisa_de_voce: !!pendente,
            aviso: pendente ? {
              titulo: 'Vendas do ' + String(pendente.canal || 'marketplace').toUpperCase() + ' não estão chegando ao Bling',
              detalhe: (pendente.de != null ? pendente.faltando + ' de ' + pendente.de + ' vendas (' + pendente.pct + '%)' : pendente.faltando + ' venda(s)') + ' — ' + pendente.motivo,
              o_que_fazer: pendente.o_que_fazer || 'Bling → Canais de venda → reautorizar; depois rode o backfill do período',
            } : null,
            ultimo_conserto: ultimo, historico: h });
        } catch (e) { r.json(res, 500, { ok: false, erro: String((e && e.message) || e).slice(0, 160) }); }
        return true;
      }
      const out = await conferir(urlObj.searchParams.get('dias'),
        String(urlObj.searchParams.get('canais') || '').split(',').map((s2) => s2.trim()).filter(Boolean),
        { todos: urlObj.searchParams.get('todos') === '1' });
      r.json(res, 200, out);
      return true;
    };
  }

  return {
    empresa: cfg.loja,
    estado,
    conferir,
    rotas,
    listarNoBling: _listarNoBlingCanario,
    listarNoMarketplace: _listarNoMarketplaceCanario,
    packDaVenda: _packDaVendaCanario,
    ordensDoPack: _ordensDoPackCanario,
    consertar: _consertarDoCanario,
  };
}

module.exports = { criarCanarioDaEmpresa };
