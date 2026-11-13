'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   FÁBRICA DE MÓDULO FISCAL — as três empresas (14/09/2026).

   Passo que a auditoria do Codex chama de P1: hoje uma loja nova precisa de pasta
   e `require` manual, então o registro sabe da empresa mas o serviço não monta
   nada pra ela. Esta fábrica é o outro lado — ela produz o módulo inteiro
   (rotinas, rotas e crons) a partir de configuração e das peças injetadas.

   O que era por empresa e virou parâmetro: o prefixo HTTP (/amb, /good, '' na
   Girassol), o rótulo das mensagens e os minutos do cron do F3 — escalonados de
   propósito (0, 2 e 4) pra as três não competirem pela cota do Bling.

   O que continua vindo de fora, por injeção: os fluxos, os gerenciadores de token
   e o cliente do Bling daquela empresa. A fábrica não conhece CNPJ nenhum.

   ⚠️ Ainda NÃO é onboarding declarativo: as peças injetadas vivem na pasta da
   empresa. O passo seguinte é essas peças também nascerem do registro — mas com
   esta fábrica, o que sobra na pasta é fiação, não regra.
   ──────────────────────────────────────────────────────────────────────────── */

function criarModuloFiscal(cfg) {
  for (const nome of ['id', 'nome', 'prefixo', 'rotulo', 'pecas', 'crons']) {
    if (!cfg || cfg[nome] == null) throw new Error('lib/fiscal/criar-modulo: falta ' + nome);
  }
  const { id, nome, prefixo, rotulo, crons } = cfg;
  /* 12/11 — a VIGIA das notas em "Consultar situação" (lib/fiscal/situacao-vigia): a memória e o aviso no checkout do admin
     quando a consulta automática não destrava. Só existe quando a empresa informa a pasta dos avisos (`dirTravadas`, a
     mesma do aviso de NF travada do checkout) e expõe a listagem; montada na 1ª vez que alguém precisa. */
  let _vigiaSit = null;
  const vigiaSituacao = () => {
    if (_vigiaSit) return _vigiaSit;
    if (!cfg.dirTravadas || typeof cfg.pecas.getNFsSituacaoConsulta !== 'function') return null;
    _vigiaSit = require('./situacao-vigia').criar({ dirTravadas: cfg.dirTravadas,
      listar: async () => cfg.pecas.getNFsSituacaoConsulta(await cfg.pecas.garantirTokenNF()),
      /* Codex #856: sumir da lista "da janela" não prova que destravou — a nota é conferida no dia de emissão dela */
      confirmar: typeof cfg.pecas.nfEstaEmConsulta === 'function'
        ? async (idNF, dataEmissao) => cfg.pecas.nfEstaEmConsulta(await cfg.pecas.garantirTokenNF(), idNF, dataEmissao) : undefined });
    return _vigiaSit;
  };
  const {
    rotinaExpediente, rotinaVirada, rotinaManha, estadoFluxos,   /* 20/10: opcional — /diagnostico/fluxos (Codex #722) */
    corrigirNFsPendentes, retryNFManual, getEstadoRetrySEFAZ,
    garantirToken, gerarTokenInicial,
    gerarTokenInicialNF, garantirTokenNF,
    garantirTokenML, trocarCodigoPorToken, gerarUrlAutorizacao,
    getPedidoDetalhe,
    rotinaNFeML, enviarNFeUnica,
    /* 30/09 — a rota /robo/nfs-consultar-situacao fazia `require('./nfBlingApi')` de dentro de
       lib/fiscal/, onde esse arquivo NÃO existe: cada empresa tem o seu na própria pasta. A
       rota quebrava com "Cannot find module" nas TRÊS — o dono topou com isso ao diagnosticar
       uma NF parada, e o erro estava no ar desde que o módulo virou fábrica.
       OPCIONAL de propósito: se a empresa não passar, a rota responde dizendo isso em vez de
       estourar — uma empresa nova sem este robô não pode derrubar a rota. */
    getNFsSituacaoConsulta,
    /* 12/11: opcionais — o reenvio com a resposta inteira e a conferência "esta nota está em Consultar situação?" pelo dia
       de emissão dela, pro teste /robo/nf-reenvio-teste */
    enviarNFCru, nfEstaEmConsulta,
    /* 12/11: opcional — a medição de como o Bling lê a data do filtro de notas (/robo/nf-filtro-data) */
    medirFiltroDeData,
    /* 30/09 — e MAIS TRÊS rotas de debug tinham o mesmo require relativo quebrado
       (/debug/nf-corrigir/, /debug/sintegra/, /debug/cep/). Eu só tinha visto a que o dono
       topou; o teste novo varreu o arquivo e achou as outras. Todas opcionais: empresa que
       não passar a peça recebe recusa explicada, não um "Cannot find module". */
    getNFDetalhe, getIEPorCNPJ, getCidadePorCEP,
  } = cfg.pecas;

  /* o teste pegou o furo: validar só o que EXISTE deixa passar `pecas: {}` — a empresa
     nasceria com rotinas undefined e a falha apareceria no primeiro cron, em produção, de
     madrugada. A lista é explícita pra peça faltando derrubar aqui, no boot. */
  const PECAS_OBRIGATORIAS = [
    'rotinaExpediente', 'rotinaVirada', 'rotinaManha',
    'corrigirNFsPendentes', 'retryNFManual', 'getEstadoRetrySEFAZ',
    'garantirToken', 'gerarTokenInicial',
    'gerarTokenInicialNF', 'garantirTokenNF',
    'garantirTokenML', 'trocarCodigoPorToken', 'gerarUrlAutorizacao',
    'getPedidoDetalhe', 'rotinaNFeML', 'enviarNFeUnica',
  ];
  const faltando = PECAS_OBRIGATORIAS.filter(p => typeof cfg.pecas[p] !== 'function');
  if (faltando.length) {
    throw new Error('lib/fiscal/criar-modulo: ' + id + ' está sem a(s) peça(s): ' + faltando.join(', '));
  }

  function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  }
  function html(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
  }

  /**
   * Registra as rotas HTTP do módulo AMBTotal sob o prefixo /amb
   */
  function routes(readBody) {
  return async function handle(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;

    // ─── Setup OAuth Bling (Mover-Pedidos) ─────────────────────────
    if (p === (prefixo + '/setup') && method === 'POST') {
      const body = await readBody(req);
      try {
        await gerarTokenInicial(body.auth_code);
        json(res, 200, { ok: true, message: `${rotulo}: Tokens Bling gerados ✓` });
      } catch (e) { json(res, 400, { ok: false, error: e.message }); }
      return true;
    }
    if (p === (prefixo + '/callback') && method === 'GET') {
      const code = urlObj.searchParams.get('code');
      if (!code) { html(res, 400, `<h2>❌ ${rotulo}: Código não encontrado</h2>`); return true; }
      try {
        await gerarTokenInicial(code);
        html(res, 200, `<h2>✅ ${rotulo}: Token Bling obtido. Pode fechar.</h2>`);
      } catch (e) { html(res, 500, `<h2>❌ ${rotulo} Erro: ${e.message}</h2>`); }
      return true;
    }

    // ─── Setup OAuth Bling NF (Corrigir-NFs) ───────────────────────
    if (p === (prefixo + '/setup-nf') && method === 'POST') {
      const body = await readBody(req);
      try {
        await gerarTokenInicialNF(body.auth_code);
        json(res, 200, { ok: true, message: `${rotulo}: Tokens Bling NF gerados ✓` });
      } catch (e) { json(res, 400, { ok: false, error: e.message }); }
      return true;
    }
    if (p === (prefixo + '/callback-nf') && method === 'GET') {
      const code = urlObj.searchParams.get('code');
      if (!code) { html(res, 400, `<h2>❌ ${rotulo} NF: Código não encontrado</h2>`); return true; }
      try {
        await gerarTokenInicialNF(code);
        html(res, 200, `<h2>✅ ${rotulo}: Token Bling NF obtido. Pode fechar.</h2>`);
      } catch (e) { html(res, 500, `<h2>❌ ${rotulo} NF Erro: ${require('../http/sem-segredos').semSegredos(e.message)}</h2>`); }   /* 01/11 (Codex F13): a tela nunca mostra pedaço de credencial */
      return true;
    }

    // ─── Setup OAuth ML ────────────────────────────────────────────
    if (p === (prefixo + '/setup-ml') && method === 'GET') {
      try {
        const authUrl = gerarUrlAutorizacao();
        res.writeHead(302, { Location: authUrl });
        res.end();
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (p === (prefixo + '/callback-ml') && method === 'GET') {
      const code = urlObj.searchParams.get('code');
      if (!code) { html(res, 400, `<h2>❌ ${rotulo} ML: Código não encontrado</h2>`); return true; }
      try {
        await trocarCodigoPorToken(code);
        html(res, 200, `<h2>✅ ${rotulo}: Token ML obtido. Pode fechar.</h2>`);
      } catch (e) { html(res, 500, `<h2>❌ ${rotulo} ML Erro: ${e.message}</h2>`); }
      return true;
    }

    /* 30/09 — O QUE O RESOLVEDOR DEVOLVE PRA UM CEP, ponta a ponta.
       Nasceu de uma NF da Girassol parada porque o cliente escreveu "Sem Peixe" e o nome
       oficial é "Sem-Peixe" (MG). Acrescentei a correção, a NF continuou parada, e eu não
       tinha como saber POR QUÊ: a sandbox não alcança o ViaCEP, e sem ver o que ele devolve
       pra aquele CEP não dá pra dizer se o problema é a fonte, a correção ou outra coisa.
       Mostra: o que CADA fonte responde, o que a correção de nome faz com isso, e se há
       fallback pro CEP. Só leitura, só admin — e responde num clique no navegador. */
    if (method === 'GET' && p === (prefixo + '/debug/cep')) {
      /* a chave vem da querystring: este arquivo não tem o `lerChaveAdmin` do checkout — eu
         copiei de lá sem conferir e o eslint pegou. Aceita o header também, porque é o jeito
         seguro quando a URL for parar num log. */
      const kC = String(urlObj.searchParams.get('k') || req.headers['x-admin-key'] || '');
      if (!(process.env.ADMIN_KEY && kC === process.env.ADMIN_KEY)) { json(res, 404, { error: 'not found' }); return true; }
      const cepPedido = String(urlObj.searchParams.get('cep') || '').replace(/\D/g, '');
      if (cepPedido.length !== 8) { json(res, 200, { ok: false, erro: 'informe ?cep= com 8 dígitos' }); return true; }
      (async () => {
        try {
          const { getCidadePorCEP, FONTES } = require('../cepResolver');
          const { aplicarCorrecaoCidade, fallbackPorCEP } = require('../correcoesCidades');

          /* o resultado FINAL, que é o que a NF usa */
          const final = await getCidadePorCEP(cepPedido, '[debug/cep]');

          /* e cada fonte isolada: é isto que diz se o nome vem diferente do esperado */
          const porFonte = [];
          for (const f of FONTES) {
            try {
              /* Codex #543 (P1): a promessa precisa resolver em TODOS os finais. Eu tratava só
                 `data`/`end` da resposta e o `timeout` do pedido — se a fonte aceita a conexão
                 e CORTA a resposta no meio, o socket já fechou, o timeout não dispara mais, e
                 a promessa nunca resolve: a rota de diagnóstico trava.
                 `resolveu` garante uma resolução só, e `aborted`/`close`/`error` da RESPOSTA
                 fecham o caso. Teto de tempo próprio por cima de tudo, que é o que impede
                 depender do comportamento de cada fonte. */
              const r = await new Promise((ok) => {
                let resolveu = false;
                const fim = (v) => { if (!resolveu) { resolveu = true; ok(v); } };
                const teto = setTimeout(() => fim(null), 6000);
                const req2 = require('https').get(f.url(cepPedido), { timeout: 5000 }, (r2) => {
                  let b2 = '';
                  r2.on('data', (c) => { b2 += c; });
                  r2.on('end', () => { clearTimeout(teto); try { fim(f.parse(JSON.parse(b2))); } catch (e) { fim(null); } });
                  /* fonte que fecha a resposta no meio ("Premature close", caso do BrasilAPI v2):
                     'end' nunca vem e o timeout do request não dispara, então sem isto a promise
                     ficaria pendente e a rota nunca responderia. (O caso concreto é do
                     claude[bot]; o teto de tempo acima é a minha rede de segurança pra quando
                     NENHUM evento vier — nenhuma das duas sozinha cobre as duas situações.) */
                  r2.on('aborted', () => { clearTimeout(teto); fim(null); });
                  r2.on('close', () => { clearTimeout(teto); fim(null); });
                  r2.on('error', () => { clearTimeout(teto); fim(null); });
                });
                req2.on('timeout', () => { req2.destroy(); clearTimeout(teto); fim(null); });
                req2.on('error', () => { clearTimeout(teto); fim(null); });
              });
              porFonte.push({ fonte: f.nome || String(f.url(cepPedido)).split('/')[2], bruto: r,
                              apos_correcao: r && r.municipio ? aplicarCorrecaoCidade(r.municipio, r.uf) : null });
            } catch (e) { porFonte.push({ fonte: '?', erro: String(e.message || e) }); }
          }

          json(res, 200, {
            ok: true, cep: cepPedido,
            resultado_final: final,
            por_fonte: porFonte,
            fallback_por_cep: fallbackPorCEP(cepPedido),
            leia: 'resultado_final e o que a NF usa. Se `bruto` de alguma fonte traz um nome ' +
                  'diferente do oficial e `apos_correcao` NAO corrige, falta a entrada em ' +
                  'CORRECOES_CIDADE. Se nenhuma fonte responde, use FALLBACK_POR_CEP.',
          });
        } catch (e) {
          json(res, 200, { ok: false, erro: String(e.message || e) });
        }
      })();
      return true;
    }

    // ─── Runs manuais ──────────────────────────────────────────────
    if (method === 'POST') {
      if (p === (prefixo + '/run/expedicao')) {
        rotinaExpediente().catch(console.error);
        json(res, 202, { queued: `${rotulo} rotinaExpediente` });
        return true;
      }
      if (p === (prefixo + '/run/virada')) {
        rotinaVirada().catch(console.error);
        json(res, 202, { queued: `${rotulo} rotinaVirada` });
        return true;
      }
      if (p === (prefixo + '/run/manha')) {
        rotinaManha().catch(console.error);
        json(res, 202, { queued: `${rotulo} rotinaManha` });
        return true;
      }
      if (p === (prefixo + '/run/corrigir-nfs')) {
        corrigirNFsPendentes().catch(console.error);
        json(res, 202, { queued: `${rotulo} corrigirNFsPendentes` });
        return true;
      }
      if (p === (prefixo + '/run/nfe-ml')) {
        rotinaNFeML().catch(console.error);
        json(res, 202, { queued: `${rotulo} rotinaNFeML` });
        return true;
      }
      // Envio manual de UMA NF específica: POST /amb/run/nfe-ml/:idNfe
      if (p.startsWith((prefixo + '/run/nfe-ml/'))) {
        const idNfe = p.split('/').pop();
        try {
          const resultado = await enviarNFeUnica(idNfe);
          json(res, 200, resultado);
        } catch (e) { json(res, 500, { ok: false, error: e.message }); }
        return true;
      }
      // Retry manual de UMA NF rejeitada por SEFAZ: POST /amb/run/retry-nf/:id
      if (p.startsWith((prefixo + '/run/retry-nf/'))) {
        const idNF = p.split('/').pop();
        if (!idNF || !/^\d+$/.test(idNF)) { json(res, 400, { ok: false, erro: 'ID da NF inválido' }); return true; }
        try {
          const r = await retryNFManual(idNF);
          json(res, r.ok ? 200 : 400, r);
        } catch (e) {
          json(res, 500, { ok: false, erro: e.message });
        }
        return true;
      }
    }

    // ─── Debug ─────────────────────────────────────────────────────
    if (method === 'GET' && p === (prefixo + '/debug/retry-sefaz')) {
      json(res, 200, getEstadoRetrySEFAZ());
      return true;
    }

    // Robô local: lista NFs em "Consultar situação" (sit=0) pra validar via UI interna
    if (method === 'GET' && p === (prefixo + '/robo/nfs-consultar-situacao')) {
      if (typeof getNFsSituacaoConsulta !== 'function') {
        json(res, 200, { ok: false, erro: 'esta empresa não expõe getNFsSituacaoConsulta ao módulo fiscal' });
        return true;
      }
      try {
        const token = await garantirTokenNF();
        const nfs = await getNFsSituacaoConsulta(token);
        /* 12/11: quem pediu a lista (Toolbox, robô) acabou de trazer a verdade do Bling — a vigia aproveita (sem outra chamada) */
        try { const _vg = vigiaSituacao(); if (_vg) _vg.reconciliar(nfs).catch((eV) => console.error('[' + rotulo + '] vigia consultar-situacao:', eV.message)); } catch (eV) { console.error('[' + rotulo + '] vigia consultar-situacao:', eV.message); }   /* em fundo: não segura a resposta */
        json(res, 200, {
          empresa: id,   /* estava chumbado como 'ambtotal' na fábrica das três */
          total: nfs.length,
          nfs: nfs.map(n => ({ id: n.id, numero: n.numero, dataEmissao: n.dataEmissao }))
        });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }

    /* 12/11 — MEDIÇÃO: como o Bling lê a data do filtro de notas (lib/fiscal/nf-bling-api, medirFiltroDeData). Três consultas
       de leitura, nada gravado. Admin. */
    if (method === 'GET' && p === (prefixo + '/robo/nf-filtro-data')) {
      if (typeof medirFiltroDeData !== 'function') { json(res, 200, { ok: false, erro: 'esta empresa não expõe medirFiltroDeData ao módulo fiscal' }); return true; }
      try { json(res, 200, Object.assign({ ok: true, empresa: id }, await medirFiltroDeData(await garantirTokenNF()))); }
      catch (e) { json(res, 500, { ok: false, erro: String(e.message || e).slice(0, 200) }); }
      return true;
    }

    /* 12/11 — O RESULTADO da consulta automática (a Toolbox devolve o que a SEFAZ respondeu pra cada nota). A vigia guarda e,
       se não destravou, põe o aviso no checkout do admin na hora. Chave de admin ou da Toolbox (porteiro central). */
    if (method === 'POST' && p === (prefixo + '/robo/nfs-consultar-situacao/resultado')) {
      const _vg = vigiaSituacao();
      if (!_vg) { json(res, 200, { ok: false, erro: 'esta empresa não tem a vigia do Consultar situação ligada' }); return true; }
      let corpoR = null;
      try { corpoR = await readBody(req); if (typeof corpoR === 'string') corpoR = JSON.parse(corpoR || '{}'); } catch (eB) { json(res, 400, { ok: false, erro: 'corpo inválido' }); return true; }
      if (!corpoR || !Array.isArray(corpoR.resultados)) { json(res, 400, { ok: false, erro: 'faltou resultados[]' }); return true; }
      try { const rr = _vg.receberResultados(corpoR.resultados, corpoR.origem); json(res, 200, { ok: true, recebidos: rr.recebidos }); }
      catch (eR) { json(res, 500, { ok: false, erro: String(eR.message || eR).slice(0, 200) }); }
      return true;
    }

    /* 12/11 — TESTE (pergunta do dono: "não consegue automatizar isso num ciclo por API, num cron? Se eu não entrar no
       Bling a NF fica travada infinita"). A API do Bling NÃO tem "consultar situação"; a única ação que ela oferece sobre
       uma nota já enviada é o REENVIO (POST /nfe/{id}/enviar). Em junho esse teste bateu no limite de requisições e nunca
       chegou a uma resposta. Esta rota mede, numa nota em "Consultar situação": a situação ANTES → o que o Bling responde
       ao reenvio → a situação DEPOIS (lida de novo após a espera). Se a nota vira autorizada, dá pra fazer por cron no
       servidor, sem navegador; se não, o caminho continua sendo a página do Bling (Toolbox).
       Só nota que está na lista de "Consultar situação" — a nota já está autorizada na SEFAZ, então o reenvio não gera outra nota (na
       pior hipótese a SEFAZ responde duplicidade e a situação fica como estava ou vira rejeitada-duplicidade, que o
       "Consultar situação" conserta). Admin (a regra central de /robo/). */
    if (method === 'GET' && p === (prefixo + '/robo/nf-reenvio-teste')) {
      const idT = String(urlObj.searchParams.get('id') || '').trim();
      if (!/^\d{5,}$/.test(idT)) { json(res, 400, { ok: false, erro: 'informe ?id=<id da nota no Bling> (o número do fim do endereço da nota, ex.: 27382395982)' }); return true; }
      if (typeof getNFDetalhe !== 'function' || typeof enviarNFCru !== 'function' || typeof nfEstaEmConsulta !== 'function') { json(res, 200, { ok: false, erro: 'esta empresa não expõe getNFDetalhe/enviarNFCru/nfEstaEmConsulta ao módulo fiscal' }); return true; }
      try {
        const token = await garantirTokenNF();
        const antes = await getNFDetalhe(token, idT);
        if (!antes) { json(res, 404, { ok: false, erro: 'nota ' + idT + ' não encontrada nesta empresa' }); return true; }
        const sitAntes = Number(antes.situacao);
        /* 12/11 (erro meu, pego pelo dono no 1º uso: a rota respondeu "não está em Consultar situação" pras duas notas
           TRAVADAS). Eu conferia o código da situação no DETALHE da nota contra 10 — mas 10 é o valor do FILTRO da
           listagem; no detalhe o Bling devolve OUTRO código pra esse estado (veio 0). Quem diz se a nota está em
           "Consultar situação" é a LISTA com o filtro (a mesma que o robô e a Toolbox usam): é contra ela que a rota
           confere, antes e depois do reenvio. O código do detalhe vai junto na resposta, só como informação. */
        /* Codex #854: a conferência é pelo DIA DE EMISSÃO da própria nota (filtro situacao=10 só naquele dia, lido até o
           fim) — a lista "da janela" só cobre os últimos dias e tem teto de páginas, então a ausência nela não provava nada
           pra nota mais antiga. true = está; false = o dia foi lido inteiro e ela não está; null = não deu pra saber. */
        const _emissao = antes.dataEmissao || antes.data || null;
        /* a nota está em "Consultar situação"? Vale a LISTA DA JANELA (a mesma que o dono abre e que a Toolbox usa) OU a busca
           pela data de emissão da nota (pra nota mais antiga que a janela). Só é "não está" quando as DUAS dizem que não;
           uma falhando e a outra dizendo que não = "não sei". */
        const _vistas = { janela: null, porData: null };
        const naLista = async () => {
          let naJanela = null;
          if (typeof getNFsSituacaoConsulta === 'function') { try { const l = await getNFsSituacaoConsulta(token); naJanela = (Array.isArray(l) ? l : []).some((n) => n && String(n.id) === idT); } catch (eJ) { naJanela = null; } }
          _vistas.janela = naJanela;
          if (naJanela === true) return true;
          let porData = null; try { porData = await nfEstaEmConsulta(token, idT, _emissao); } catch (eP) { porData = null; }
          _vistas.porData = porData;
          if (porData === true) return true;
          return (naJanela === false && porData === false) ? false : null;
        };
        const estava = await naLista();
        /* 12/11: DIAGNÓSTICO que vai em toda resposta — a mesma pergunta feita "só no dia da emissão" (inicial = final, sem
           hora). Foi essa busca que não achou as notas do dono; o resultado dela, ao lado do da janela folgada, mostra
           como o Bling lê uma data final sem hora (e decide se as outras buscas por data precisam do mesmo cuidado). */
        let _noDiaExato = null; try { _noDiaExato = await nfEstaEmConsulta(token, idT, _emissao, { diaExato: true }); } catch (eD) { _noDiaExato = 'erro: ' + String(eD.message || eD).slice(0, 80); }
        let _folgada = _vistas.porData; if (_folgada === null) { try { _folgada = await nfEstaEmConsulta(token, idT, _emissao); } catch (eF) { _folgada = 'erro: ' + String(eF.message || eF).slice(0, 80); } }
        const _diag = { emissao_no_detalhe: _emissao, achou_na_lista_da_janela: _vistas.janela, achou_pela_data_com_folga: _folgada, achou_so_no_dia_da_emissao: _noDiaExato };
        if (estava === null) { json(res, 200, { ok: false, empresa: id, nota: { id: idT, numero: antes.numero || null }, situacao_no_detalhe: sitAntes, diagnostico: _diag, erro: 'não consegui confirmar se esta nota está em "Consultar situação" (sem a data de emissão, ou a busca do dia não terminou) — nada foi reenviado' }); return true; }
        if (estava === false) { json(res, 200, { ok: false, empresa: id, nota: { id: idT, numero: antes.numero || null }, situacao_no_detalhe: sitAntes, diagnostico: _diag, erro: 'esta nota não aparece agora na lista de "Consultar situação" do Bling — o teste só reenvia nota que está nela' }); return true; }
        const envio = await enviarNFCru(token, idT);
        const esperaS = Math.max(3, Math.min(25, Number(urlObj.searchParams.get('espera')) || 12));
        await new Promise((ok) => setTimeout(ok, esperaS * 1000));
        let depois = null, erroDepois = null, ainda = null;
        try { depois = await getNFDetalhe(token, idT); } catch (e2) { erroDepois = String(e2.message || e2).slice(0, 160); }
        try { ainda = await naLista(); } catch (e3) { erroDepois = (erroDepois ? erroDepois + ' | ' : '') + 'lista: ' + String(e3.message || e3).slice(0, 120); }
        const sitDepois = depois ? Number(depois.situacao) : null;
        json(res, 200, { ok: true, empresa: id, nota: { id: idT, numero: antes.numero || null },
          estava_em_consultar_situacao: true, situacao_no_detalhe_antes: sitAntes, diagnostico: _diag,
          reenvio: { http: envio.status, resposta: envio.corpo },
          esperei_segundos: esperaS, continua_em_consultar_situacao: ainda, situacao_no_detalhe_depois: sitDepois, erro_ao_reler: erroDepois,
          destravou: ainda === false,
          leia: ainda === false ? 'a nota SAIU de "Consultar situação" só com o reenvio pela API (situação no detalhe agora: ' + sitDepois + '; 5 = autorizada) — confira no Bling se ficou Autorizada e me mande este resultado: se sim, dá pra automatizar por cron no servidor'
            : (ainda === true ? 'a nota CONTINUA em "Consultar situação" — o reenvio pela API não destravou (pelo menos não em ' + esperaS + ' s)'
              : 'não consegui reler a lista depois do reenvio — olhe a nota no Bling e mande este resultado inteiro') });
      } catch (e) { json(res, 500, { ok: false, erro: String(e.message || e).slice(0, 200) }); }
      return true;
    }

    if (method === 'GET' && p === (prefixo + '/debug/token')) {
      try {
        const token = await garantirToken();
        json(res, 200, { token });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (method === 'GET' && p === (prefixo + '/debug/token-nf')) {
      try {
        const token = await garantirTokenNF();
        json(res, 200, { token });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (method === 'GET' && p === (prefixo + '/debug/token-ml')) {
      try {
        const token = await garantirTokenML();
        json(res, 200, { token });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (method === 'GET' && p.startsWith((prefixo + '/debug/pedido/'))) {
      const idPedido = p.split('/').pop();
      try {
        const token = await garantirToken();
        const detalhe = await getPedidoDetalhe(token, idPedido);
        json(res, 200, detalhe);
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    // Envio único de NF-e → ML (debug/manual via GET — pode abrir no navegador)
    if (method === 'GET' && p.startsWith((prefixo + '/debug/enviar-nfe/'))) {
      const nfeId = p.split('/').pop();
      try {
        const resultado = await enviarNFeUnica(nfeId);
        json(res, 200, resultado);
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (method === 'GET' && p.startsWith((prefixo + '/debug/nf-corrigir/'))) {
      const idNF = p.split('/').pop();
      try {
        if (typeof getNFDetalhe !== 'function') { json(res, 200, { ok: false, erro: 'esta empresa não expõe getNFDetalhe ao módulo fiscal' }); return true; }
        const token = await garantirTokenNF();
        const detalhe = await getNFDetalhe(token, idNF);
        json(res, 200, detalhe);
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    // Debug SintegraWS: GET /amb/debug/sintegra/:cnpj/:uf
    // Debug CNPJá (fonte 2 de IE): GET /amb/debug/cnpja/:cnpj/:uf
    if (method === 'GET' && p.startsWith((prefixo + '/debug/cnpja/'))) {
      const partes = p.split('/');
      const cnpj = partes[4];
      const uf = partes[5];
      if (!cnpj || !uf) { json(res, 400, { ok: false, erro: 'Uso: /amb/debug/cnpja/:cnpj/:uf' }); return true; }
      try {
        const resp = await fetch(`https://open.cnpja.com/office/${String(cnpj).replace(/\D/g,'')}`, { headers: { 'Accept': 'application/json' } });
        const data = resp.ok ? await resp.json() : null;
        const regs = (data && Array.isArray(data.registrations)) ? data.registrations : [];
        json(res, 200, { cnpj, uf, httpStatus: resp.status, registrations: regs });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    if (method === 'GET' && p.startsWith((prefixo + '/debug/sintegra/'))) {
      const partes = p.split('/');
      const cnpj = partes[4];
      const uf = partes[5];
      if (!cnpj || !uf) {
        json(res, 400, { ok: false, erro: 'Uso: /amb/debug/sintegra/:cnpj/:uf' });
        return true;
      }
      try {
        if (typeof getIEPorCNPJ !== 'function') { json(res, 200, { ok: false, erro: 'esta empresa não expõe getIEPorCNPJ ao módulo fiscal' }); return true; }
        const resultado = await getIEPorCNPJ(cnpj, uf);
        json(res, 200, {
          cnpj, uf, resultado,
          observacao: resultado
            ? `IE encontrada: "${resultado.ie}" (contribuinte=${resultado.contribuinte})`
            : 'IE não encontrada — SintegraWS pode ter falhado ou retornou vazio. Veja os logs do servidor.'
        });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    // Debug CEP (paridade com Girassol): GET /amb/debug/cep/:cep
    if (method === 'GET' && p.startsWith((prefixo + '/debug/cep/'))) {
      const cep = p.split('/').pop();
      try {
        if (typeof getCidadePorCEP !== 'function') { json(res, 200, { ok: false, erro: 'esta empresa não expõe getCidadePorCEP ao módulo fiscal' }); return true; }
        const resultado = await getCidadePorCEP(cep);
        json(res, 200, {
          cep, resultado,
          observacao: resultado
            ? 'Este é o que seria gravado na NF (municipio + uf)'
            : 'CEP inválido ou nenhuma fonte retornou dados'
        });
      } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }

    return false;
  };
  }


  /* 12/11: junto da correção de 5 em 5 min, a vigia do "Consultar situação" confere a lista (ela mesma se limita a uma
     conferência a cada 15 min) — é o que faz o aviso do checkout aparecer mesmo sem nenhuma Toolbox rodando. Falha da
     vigia não derruba a rotina. */
  const corrigirNFsComVigia = async (...a) => {
    const r = await corrigirNFsPendentes(...a);
    try { const _vg = vigiaSituacao(); if (_vg) await _vg.vigiarSeDevido(); } catch (eV) { console.error('[' + rotulo + '] vigia consultar-situacao:', eV.message); }
    return r;
  };
  return { id, nome, rotinas: {
    rotinaExpediente, rotinaVirada, rotinaManha, estadoFluxos,
    corrigirNFs: corrigirNFsComVigia,
    nfeMl: rotinaNFeML,
  }, routes, crons };
}

module.exports = { criarModuloFiscal };
