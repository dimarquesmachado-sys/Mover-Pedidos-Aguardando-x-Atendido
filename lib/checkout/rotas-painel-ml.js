/* ════════════════════════════════════════════════════════════════════════════
   ROTAS DE MERCADO LIVRE DO PAINEL — fatia da fábrica (02/10).

   A fábrica chegou a 2.726 linhas e o teto da casa é 3.000. Em vez de parar de acrescentar
   rota, quebrei por ASSUNTO: este é o maior grupo (10 rotas, ~730 linhas).

   Mesmo contrato da fábrica: nada de `require` relativo pra pasta de empresa, tudo por injeção,
   e peça que nem toda empresa tem é conferida pela própria rota (`semPeca`).
   ════════════════════════════════════════════════════════════════════════════ */

'use strict';

function criarRotasML(ctx) {
  const { EMPRESA, PREFIXO, json, lerChaveAdmin, validarSessao, readJson, writeJson,
          CACHE_DIR, fsx, pathx, semPeca, _env, PROPRIAS, NOME_EMPRESA, mlTokenManager,
          MLB_FILE, _mlb, _mlcred, aplicarCreditosFlex, blingGet, ehAdmin, garantirTokenML, mlBillingSync, supaCfg, supaReq } = ctx;
  const path = pathx;
  const fs = fsx;
  const DIR = CACHE_DIR;

  return async function rotasML(req, res, p, method, urlObj) {
    /* ─── /ml-devolucoes ────────────────────────────────────────── */

    if (method === 'GET' && (p === (PREFIXO + '/ml-devolucoes') || p === (PREFIXO + '/ml-devolucoes-coletar'))) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!supaReq) return semPeca(res, 'supaReq');
      if (!garantirTokenML) return semPeca(res, 'garantirTokenML');
      const kV = lerChaveAdmin(req, urlObj);
      const sV = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kV === process.env.ADMIN_KEY) || (sV && ehAdmin(sV)))) { json(res, 404, { error: 'not found' }); return true; }
      const mlDevLib = require('../ml-devolucoes');
      const buscarNoHistorico = async (orderIds) => {
        const ids = Array.from(new Set((orderIds || []).map(x => String(x || '').trim()).filter(Boolean)));
        const mapa = {};
        for (let i0 = 0; i0 < ids.length; i0 += 40) {
          const lote = ids.slice(i0, i0 + 40);
          const q = 'vendas_historico?empresa=eq.' + EMPRESA + '&numero_loja=in.(' + lote.map(encodeURIComponent).join(',') + ')' +
                    '&select=numero_loja,sku,descricao,valor_produto,quantidade&limit=1000';
          try {
            const rr = await supaReq(EMPRESA, 'GET', q, null);
            if (!rr.ok) continue;
            const arr = JSON.parse(rr.body || '[]');
            if (!Array.isArray(arr)) continue;
            for (const l of arr) {
              const k = String((l && l.numero_loja) || '');
              if (!k) continue;
              if (!mapa[k]) mapa[k] = { sku: l.sku || null, nome: l.descricao || null, valor: 0 };
              mapa[k].valor = Math.round((mapa[k].valor + (Number(l.valor_produto) || 0)) * 100) / 100;
            }
          } catch (e) {}
        }
        return mapa;
      };
      const ctxDev = { CACHE_DIR, path, readJson, writeJson, buscarNoHistorico };
      if (p.endsWith('-coletar')) {
        let tkV = null;
        try { tkV = garantirTokenML ? await garantirTokenML() : null; }
        catch (e) { json(res, 200, { ok: false, erro: 'sem token ML: ' + String(e.message || e).slice(0, 160) }); return true; }
        const r = await mlDevLib.coletarDevolucoesML(Object.assign({ token: tkV }, ctxDev), urlObj.searchParams.get('dias'), { refazer: urlObj.searchParams.get('refazer') === '1' });
        json(res, 200, r);
        return true;
      }
      const de = String(urlObj.searchParams.get('de') || '').slice(0, 10);
      const ate = String(urlObj.searchParams.get('ate') || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) { json(res, 400, { ok: false, erro: 'passe &de=AAAA-MM-DD&ate=AAAA-MM-DD' }); return true; }
      if (de > ate) { json(res, 400, { ok: false, erro: 'período invertido' }); return true; }
      json(res, 200, Object.assign({ ok: true, de, ate }, await mlDevLib.resumoDevolucoesML(ctxDev, de, ate)));
      return true;
    }

    /* 02/09 — O QUE SOBROU EM 'outros': depois de classificar 4 categorias novas, a AMB ainda
       tem -R$ 450 e a Girassol R$ 4.286 nesse balde. Como o valor da AMB é NEGATIVO, é crédito
       que o ML devolveu e o dashboard não mostra — dinheiro faltando a favor do dono. Esta rota
       lista as descrições que não casaram com nenhuma regra, agrupadas, pra fechar de vez em
       vez de adivinhar. Só lê o cache; não chama a API nem grava nada. */
    /* 02/09 — FATURA DO CARTÃO do ML, pelo ciclo do ML (13→12), com composição. Vem do campo
       debited_from_operation que a coleta passou a gravar; sem re-sincronizar, os registros
       antigos não têm a marca e aparecem em sem_marca. Só lê o cache. */



    /* ─── /ml-billing ───────────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/ml-billing')) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!_mlb) return semPeca(res, '_mlb');
      if (!mlBillingSync) return semPeca(res, 'mlBillingSync');
      const kB = lerChaveAdmin(req, urlObj);
      const sB = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kB === process.env.ADMIN_KEY) || (sB && ehAdmin(sB)))) { json(res, 404, { error: 'not found' }); return true; }
      // 02/08: uma rodada presa bloqueava todas as seguintes (a fun\u00e7\u00e3o volta na hora se j\u00e1 estiver
      // rodando) \u2014 e sem reiniciar o servi\u00e7o n\u00e3o havia sa\u00edda. Com ?forcar=1 a trava \u00e9 solta.
      if ((urlObj.searchParams.get('forcar') || '') === '1' && _mlb.rodando) {
        console.log('[ML-BILLING] trava solta na m\u00e3o (rodada presa desde ' + _mlb.inicio + ')');
        _mlb.rodando = false; _mlb.msg = 'rodada anterior descartada a pedido';
      }
      if (_mlb.rodando) { json(res, 409, { ok: false, erro: 'j\u00e1 existe uma rodada em andamento desde ' + _mlb.inicio + ' \u2014 use &forcar=1 para descartar', status: _mlb }); return true; }
      mlBillingSync(Number(urlObj.searchParams.get('periodos')) || 12).catch(e => console.log('[ML-BILLING] \u2717 ' + e.message));
      json(res, 202, { ok: true, msg: 'puxando o faturamento do ML em background', status: (PREFIXO + '/ml-billing-status') });
      return true;
    }



    /* ─── /ml-billing-status ────────────────────────────────────── */

    /* Codex #573: repetia a condição de `/ml-billing` e nunca era alcançado. O original lê o
       arquivo de tarifas e devolve o progresso — sem chave, como na AMB e na Girassol. */
    if (method === 'GET' && p === (PREFIXO + '/ml-billing-status')) {
      if (!_mlb) return semPeca(res, '_mlb');
      /* o arquivo é o mesmo nas três empresas, dentro da pasta de cache de cada uma */
      const b = readJson(path.join(CACHE_DIR, '_ml_billing.json'), { tarifas: {}, porDia: {} });
      const porCat = {}, comVenda = {};
      for (const t of Object.values(b.tarifas || {})) { porCat[t.c] = Math.round(((porCat[t.c] || 0) + t.v) * 100) / 100;
        if (t.o) comVenda[t.c] = (comVenda[t.c] || 0) + 1; }
      json(res, 200, { ok: true, status: _mlb, tentativas: _mlb.tentativas || [], detalhes: _mlb.detalhes || [], amostra_item: _mlb.amostra_item || null, amostra_venda: _mlb.amostra_venda || null, amostra_periodos: _mlb.amostra_periodos || null, atualizado: b.atualizado || null,
                       tarifas_guardadas: Object.keys(b.tarifas || {}).length, total_por_categoria: porCat, com_numero_de_venda: comVenda,
                       dias_com_dado: Object.keys(b.porDia || {}).length });
      return true;
    }



    /* ─── /raio-x-venda ─────────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/raio-x-venda')) {
      if (!blingGet) return semPeca(res, 'blingGet');
      if (!garantirTokenML) return semPeca(res, 'garantirTokenML');
      const kR = lerChaveAdmin(req, urlObj);
      if (!(process.env.ADMIN_KEY && kR === process.env.ADMIN_KEY)) { json(res, 404, { error: 'not found' }); return true; }
      const venda = String(urlObj.searchParams.get('venda') || '').replace(/\D/g, '');
      if (!venda) { json(res, 400, { ok: false, erro: 'use ?venda=2000018258015754&k=SUA_ADMIN_KEY' }); return true; }
      const out = { ok: true, venda, ml: {}, bling: {}, veredito: null };
      try {
        /* Codex #343 r4: garantirTokenML() sonda /users/me e pode renovar, nenhum dos dois com
           timeout — ML que aceita a conexão e não responde deixaria o diagnóstico pendurado
           antes mesmo de começar. Aqui a espera tem limite: sem token em 20s, é indeterminado. */
        const tk = await Promise.race([
          garantirTokenML(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('o ML não respondeu em 20s ao validar o token')), 20000))
        ]);
        const r = await fetch('https://api.mercadolibre.com/orders/' + venda, { headers: { Authorization: 'Bearer ' + tk }, signal: AbortSignal.timeout(15000) }   /* Codex #343 r2: ML que aceita a conexão e não responde deixaria a rota pendurada */);
        out.ml.orders_status = r.status;
        /* Codex #343: o número pode ser um PACK — o Bling grava ora um, ora outro. Aí /orders
           dá 404 e a rota desistia, perdendo justamente as ordens do pacote, que são o que
           interessa. Se o /orders não achou, tenta como pack. */
        if (!r.ok && r.status === 404) {
          const rp0 = await fetch('https://api.mercadolibre.com/packs/' + venda, { headers: { Authorization: 'Bearer ' + tk }, signal: AbortSignal.timeout(15000) }   /* Codex #343 r2: ML que aceita a conexão e não responde deixaria a rota pendurada */);
          out.ml.packs_status = rp0.status;
          if (rp0.ok) {
            const dp0 = await rp0.json().catch(() => null);
            out.ml.era_pack = true;
            out.ml.pack_id = String(venda);
            out.ml.ordens_do_pack = (dp0 && Array.isArray(dp0.orders)) ? dp0.orders.map(o => String(o.id)) : null;
            if (out.ml.ordens_do_pack === null) out.ml.pack_incompleto = true;
            /* Codex #343 r2: com o pack aberto eu tinha as ordens mas NÃO a data — e sem data
               a rota caía sempre no INDETERMINADO, ou seja, meu próprio conserto do apontamento
               anterior deixou o caminho do pack inútil. Busca a data numa das ordens. */
            const prim = (out.ml.ordens_do_pack || [])[0];
            if (prim) {
              /* Codex #343 r5: com timeout esta chamada LANÇA, e sem try local a exceção sairia
                 pro catch de fora perdendo as ordens do pack já apuradas. */
              try {
                const ro = await fetch('https://api.mercadolibre.com/orders/' + prim, { headers: { Authorization: 'Bearer ' + tk }, signal: AbortSignal.timeout(15000) });
                if (ro.ok) { const dor = await ro.json().catch(() => null); if (dor && dor.date_created) { out.ml.date_created = dor.date_created; out.ml.status = dor.status; } }
              } catch (eOrd) { out.ml.data_erro = String(eOrd.message || eOrd).slice(0, 120); }
            }
          }
        }
        if (r.ok) {
          const d = await r.json().catch(() => null);
          out.ml.id = d && d.id ? String(d.id) : null;
          out.ml.pack_id = d && d.pack_id ? String(d.pack_id) : null;
          out.ml.status = d && d.status;
          out.ml.date_created = d && d.date_created;
          if (out.ml.pack_id) {
            /* Codex #343 r5: o timeout que EU acabei de pôr faz esta chamada LANÇAR quando
               estoura — e a exceção pulava pro catch de fora sem marcar pack_incompleto. Como
               a date_created já tinha sido capturada, a rota seguia e dava veredito definitivo
               sem conhecer as irmãs do carrinho. O try local marca o que não deu pra saber. */
            try {
              const rp = await fetch('https://api.mercadolibre.com/packs/' + out.ml.pack_id, { headers: { Authorization: 'Bearer ' + tk }, signal: AbortSignal.timeout(15000) });
              out.ml.packs_status = rp.status;
              const dp = rp.ok ? await rp.json().catch(() => null) : null;
              out.ml.ordens_do_pack = (dp && Array.isArray(dp.orders)) ? dp.orders.map(o => String(o.id)) : null;
            } catch (ePack) {
              out.ml.ordens_do_pack = null;
              out.ml.packs_erro = String(ePack.message || ePack).slice(0, 120);
            }
            /* Codex #343: pack que não abriu (429/5xx/JSON ruim) deixa o conjunto de candidatos
               incompleto — e num carrinho o Bling pode ter gravado o número de uma IRMÃ. Sem
               marcar isso, um 'NÃO achei' sairia sem ter procurado por todos os números. */
            if (out.ml.ordens_do_pack === null) out.ml.pack_incompleto = true;
          }
        } else { out.ml.corpo = String(await r.text().catch(() => '')).slice(0, 200); }
      } catch (e) { out.ml.erro = String(e.message || e).slice(0, 200); }
      /* o que o Bling tem: procura pelo número da venda E pelo pack */
      const candidatos = [venda, out.ml.pack_id].filter(Boolean).concat(out.ml.ordens_do_pack || []);
      out.bling.procurei_por = [...new Set(candidatos)];
      out.bling.achados = [];
      /* 06/09 (2ª versão) — O BLING IGNORA ?numeroLoja. A primeira versão desta rota usava esse
         filtro e o Bling devolveu os 100 pedidos MAIS RECENTES, sem filtrar nada — o veredito
         então dizia "ESTÁ no Bling" porque achava tudo, não porque achava aquilo. Falso
         positivo numa ferramenta de diagnóstico é pior que não ter a ferramenta.
         Agora varremos a janela de datas em volta da venda e comparamos NÓS mesmos, que é o
         que o canário faz — assim o raio-x enxerga exatamente o que ele enxerga. */
      /* Codex #343: sem date_created (token falhou, /orders falhou, JSON ruim) a janela caía
         em HOJE — e uma venda antiga seria declarada ausente depois de varrer a semana errada.
         Sem data do ML, não há veredito. */
      const diaML = String(out.ml.date_created || '').slice(0, 10);
      if (!diaML) {
        out.veredito = 'INDETERMINADO: não consegui a data da venda no ML (' + (out.ml.erro || ('HTTP ' + out.ml.orders_status)) + ') — sem ela eu varreria a janela errada no Bling e o resultado não valeria nada.';
        json(res, 200, out); return true;
      }
      const base = Date.parse(diaML + 'T12:00:00Z');
      const _d = ms => new Date(ms).toISOString().slice(0, 10);
      const deB = _d(base - 3 * 86400000), ateB = _d(base + 3 * 86400000);
      out.bling.janela = { de: deB, ate: ateB, nota: 'o Bling ignora ?numeroLoja — varremos por data e comparamos aqui' };
      const alvo = new Set(out.bling.procurei_por.map(String));
      let vistos = 0;
      for (let pg = 1; pg <= 30; pg++) {
        /* 06/09 (3ª versão) — ESPERAR O 429. A versão anterior desistia na primeira recusa do
           Bling: varreu 100 de ~700 pedidos e mesmo assim afirmou "NÃO achei". Veredito sobre
           14% da janela não prova nada, e ainda por cima aponta o dedo pra integração que pode
           estar perfeita. O resto do sistema já espera nesses casos (o canário e o backfill
           fazem isso); aqui faltava. */
        let rb = null;
        for (let tent = 1; tent <= 5; tent++) {
          /* Codex #343 r3: o blingGet aceita um AbortSignal (3º parâmetro) e eu não estava
             passando — Bling que trava na conexão deixaria a primeira tentativa pendurada pra
             sempre, e as 5 tentativas nunca aconteceriam. Sinal NOVO a cada requisição: um
             sinal compartilhado abortaria as tentativas seguintes junto com a primeira. */
          try { rb = await blingGet('/pedidos/vendas?dataInicial=' + deB + '&dataFinal=' + ateB + '&pagina=' + pg + '&limite=100', 3, AbortSignal.timeout(20000)); }
          catch (e) { rb = null; }
          if (rb && rb.ok) break;
          const st = (rb && rb.status) || 0;
          if (st !== 429 && st !== 0 && st < 500) break;         /* erro real: não insiste */
          if (tent < 5) await new Promise(r2 => setTimeout(r2, tent * 5000));
        }
        if (!rb || !rb.ok) {
          out.bling.erro = 'Bling respondeu ' + ((rb && rb.status) || '?') + ' na página ' + pg + ' mesmo após 5 tentativas';
          out.bling.varredura_completa = false;
          break;
        }
        /* Codex #343 r2: 2xx com JSON inválido ou envelope mudado devolve data:null, e tratar
           isso como "página vazia" transformava falha em varredura completa — o mesmo vício de
           dar veredito sem ter olhado, agora pela quarta porta. */
        if (!rb.data || !Array.isArray(rb.data.data)) {
          out.bling.varredura_completa = false;
          out.bling.erro = 'o Bling respondeu ' + rb.status + ' mas com corpo inesperado na página ' + pg;
          break;
        }
        const arr = rb.data.data;
        if (!arr.length) { out.bling.fim_real = true; break; }
        vistos += arr.length;
        for (const pd of arr) {
          const nl = String(pd.numeroPedidoLoja || pd.numeroLoja || '').trim();
          if (alvo.has(nl)) out.bling.achados.push({ casou_com: nl, id: pd.id, numero: pd.numero, numeroLoja: nl, situacao: pd.situacao && (pd.situacao.id != null ? pd.situacao.id : pd.situacao.valor)   /* Codex #343: a LISTAGEM do Bling manda o id, não o nome em .valor */, data: pd.data });
        }
        if (arr.length < 100) { out.bling.fim_real = true; break; }
        if (pg === 30) { out.bling.varredura_completa = false; out.bling.erro = 'mais de 3.000 pedidos na janela — varredura truncada no teto de páginas'; }
        await new Promise(r2 => setTimeout(r2, 120));
      }
      out.bling.pedidos_varridos = vistos;
      if (out.bling.varredura_completa !== false) out.bling.varredura_completa = true;
      out.veredito = out.bling.achados.length
        ? ('ESTÁ no Bling (pedido ' + out.bling.achados.map(a => a.numero).join(', ') + ') — o Bling gravou pelo número ' + [...new Set(out.bling.achados.map(a => a.casou_com))].join(', '))
        : (out.ml.pack_incompleto
            ? ('INDETERMINADO: o pacote ' + out.ml.pack_id + ' não abriu no ML, então não sei todos os números do carrinho — o Bling pode tê-la gravado por uma das irmãs. Tente de novo em alguns minutos.')
            : out.bling.varredura_completa === false
            ? ('INDETERMINADO: o Bling parou de responder no meio (' + (out.bling.erro || '') + '). Varri só ' + vistos + ' pedidos de ' + deB + ' a ' + ateB + ' — NÃO dá pra dizer que a venda não está lá. Tente de novo em alguns minutos.')
            : ('NÃO achei no Bling entre os ' + vistos + ' pedidos de ' + deB + ' a ' + ateB + ' (varredura completa) — procurei por ' + out.bling.procurei_por.join(', ')));
      json(res, 200, out);
      return true;
    }

    /* 06/09 — O QUE O CANÁRIO ACHOU E O QUE FEZ. O dono perguntou por que a venda que o canário
       encontra não volta pro Bling sozinha; a resposta era que ninguém tinha feito. Agora: pouca
       falta é reimportada automaticamente (com reconferência antes de criar, pra não duplicar),
       e muita falta vira aviso na tela — porque aí é integração caída e só reautorizar no
       navegador resolve. Esta rota alimenta o aviso do checkout e do dashboard. */



    /* ─── /ml-creditos-flex ─────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/ml-creditos-flex')) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!_mlcred) return semPeca(res, '_mlcred');
      if (!aplicarCreditosFlex) return semPeca(res, 'aplicarCreditosFlex');
      // guarda no padrão das rotas do dashboard: chave admin OU sessão de admin logado
      // (ehAdmin sozinho NÃO serve — recebe NOME de operador, não chave; sem sessão ele libera)
      const k = lerChaveAdmin(req, urlObj);
      const sessCF = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sessCF && ehAdmin(sessCF)))) { json(res, 404, { error: 'not found' }); return true; }
      if (urlObj.searchParams.get('status')) { json(res, 200, _mlcred); return true; }
      const de = urlObj.searchParams.get('de') || '2026-01-01';
      const ate = urlObj.searchParams.get('ate') || new Date().toISOString().slice(0, 10);
      if (_mlcred.rodando) { json(res, 200, { ok: false, ja_rodando: true, msg: 'uma distribuição já está em andamento (' + (_mlcred.de || '?') + ' a ' + (_mlcred.ate || '?') + ') — acompanhe em ?status=1 e repita depois', de: _mlcred.de, ate: _mlcred.ate }); return true; }
      aplicarCreditosFlex(de, ate).catch(() => {});
      json(res, 200, { ok: true, msg: 'distribuindo créditos Flex de ' + de + ' a ' + ate + ' em background — acompanhe em ?status=1', de, ate });
      return true;
    }

    // ── AUTORIZAÇÃO DO ML PELA AMB (14/08) ────────────────────────────────────────
    // O setup do ML vive no módulo `ambtotal`, que NÃO está respondendo neste serviço
    // (/amb/setup-ml devolve 404 do roteador raiz = nenhum módulo tratou). Como o
    // reconsentimento é obrigatório pra liberar as devoluções (o token atual não ganha o
    // escopo novo sozinho), a autorização passa a existir também aqui, no módulo que está
    // no ar. Usa o MESMO mlTokenManager da AMB — não cria credencial nova.
    //   1) /amb-checkout-offline/setup-ml?k=      → manda pro ML autorizar
    //   2) o ML volta pro redirect cadastrado com ?code=… (se aquele caminho der 404,
    //      basta copiar o code da barra de endereços)
    //   3) /amb-checkout-offline/ml-trocar-code?code=…&k=  → grava o token novo



    /* ─── /ml-faltantes-classificar ─────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/ml-faltantes-classificar')) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!supaCfg) return semPeca(res, 'supaCfg');
      if (!garantirTokenML) return semPeca(res, 'garantirTokenML');
      if (!MLB_FILE) return semPeca(res, 'MLB_FILE');
      const kF = lerChaveAdmin(req, urlObj);
      const sF = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kF === process.env.ADMIN_KEY) || (sF && ehAdmin(sF)))) { json(res, 404, { error: 'not found' }); return true; }
      const deF = String(urlObj.searchParams.get('de') || '').slice(0, 10);
      const ateF = String(urlObj.searchParams.get('ate') || '').slice(0, 10);
      if (!deF || !ateF) { json(res, 400, { ok: false, erro: 'informe ?de=2026-01-01&ate=2026-08-27' }); return true; }
      const maxC = Math.min(250, Math.max(10, parseInt((urlObj.searchParams.get('max') || '150'), 10) || 150));
      // 1) vendas que o ML cobrou comiss\u00e3o no per\u00edodo
      const b = readJson(MLB_FILE(), { tarifas: {} });
      // 02/08 \u2014 O MAPA VENDA\u2192PACK VEM DE **TODAS** AS TARIFAS, n\u00e3o s\u00f3 das comiss\u00f5es.
      // O shipping_info (onde mora o pack_id) nem sempre vem na linha da comiss\u00e3o \u2014 na amostra que
      // o ML mandou ele apareceu numa TAXA DE PARCELAMENTO. Filtrar por comiss\u00e3o antes de montar o
      // mapa jogava fora justamente a linha que tinha o pack, e metade da lista vinha com pack:null.
      // O pack \u00e9 propriedade do pedido, ent\u00e3o o mapa ignora data e categoria.
      const packDe = new Map();
      for (const t of Object.values(b.tarifas || {})) if (t.o && t.p) packDe.set(String(t.o), String(t.p));
      const doML = new Map();   // numero da venda -> { comiss\u00e3o somada, pack }
      let semPack = 0;
      for (const t of Object.values(b.tarifas || {})) {
        if (!t.o || !t.d) continue;
        if (t.d < deF || t.d > ateF) continue;
        if (t.c !== 'comissao') continue;
        { const at = doML.get(String(t.o)) || { com: 0, pack: null };
          doML.set(String(t.o), { com: Math.round((at.com + t.v) * 100) / 100, pack: t.p || at.pack || packDe.get(String(t.o)) || null }); }
      }

      // 2) o que temos no hist\u00f3rico
      const { url: uF, key: kSup } = supaCfg(EMPRESA);
      const nosso = new Set();
      if (uF && kSup) {
        const HF = { apikey: kSup, Authorization: 'Bearer ' + kSup };
        const BF = uF.replace(/\/+$/, '') + '/rest/v1/vendas_historico?empresa=eq.' + EMPRESA + '&canal=eq.ml' +
                   '&data_venda=gte.' + deF + '&data_venda=lte.' + ateF;
        for (let off = 0; off < 80000; off += 1000) {
          const rF = await fetch(BF + '&select=numero_loja&order=data_venda.asc,numero_pedido.asc,sku.asc&limit=1000&offset=' + off, { headers: HF });
          if (!rF.ok) break;
          const ln = await rF.json().catch(() => []);
          if (!Array.isArray(ln) || !ln.length) break;
          for (const l of ln) if (l.numero_loja) nosso.add(String(l.numero_loja).trim());
          if (ln.length < 1000) break;
        }
      }

      // 3) o que o ML tem e n\u00f3s n\u00e3o. Aten\u00e7\u00e3o ao CARRINHO: o Bling junta o pack num pedido s\u00f3,
      // ent\u00e3o uma venda "faltando" pode estar dentro de um pedido nosso com outro n\u00famero.
      // 02/08: s\u00f3 conta como faltando se NEM a venda NEM o carrinho estiverem no nosso hist\u00f3rico
      const faltam = []; let achadasPeloPack = 0;
      for (const [venda, info] of doML.entries()) {
        if (nosso.has(venda)) continue;
        if (info.pack && nosso.has(String(info.pack))) { achadasPeloPack++; continue; }
        if (!info.pack) semPack++;
        faltam.push({ venda, pack: info.pack || null, comissao_ml: info.com });
      }
      faltam.sort((a, b2) => b2.comissao_ml - a.comissao_ml);   // os de maior comissão primeiro
      const alvo = faltam.slice(0, maxC);
      let tokenML = null;
      try { tokenML = await garantirTokenML(); } catch (e) {}
      if (!tokenML) { json(res, 500, { ok: false, erro: 'sem token do ML' }); return true; }
      const classes = { cancelada: 0, paga_ausente: 0, carrinho_descoberto_agora: 0, outra_situacao: 0, erro_consulta: 0 };
      const amostras = { cancelada: [], paga_ausente: [], carrinho_descoberto_agora: [], outra_situacao: [] };
      let comPagas = 0;
      for (const f of alvo) {
        try {
          const r = await fetch('https://api.mercadolibre.com/orders/' + f.venda, { headers: { Authorization: 'Bearer ' + tokenML } });
          const d = await r.json().catch(() => null);
          if (!r.ok || !d) { classes.erro_consulta++; }
          else {
            const st = String(d.status || '');
            const packAgora = d.pack_id ? String(d.pack_id) : null;
            if (st === 'cancelled') { classes.cancelada++; if (amostras.cancelada.length < 6) amostras.cancelada.push({ venda: f.venda, comissao_ml: f.comissao_ml }); }
            else if (packAgora && nosso.has(packAgora)) { classes.carrinho_descoberto_agora++; if (amostras.carrinho_descoberto_agora.length < 6) amostras.carrinho_descoberto_agora.push({ venda: f.venda, pack: packAgora }); }
            else if (st === 'paid') { classes.paga_ausente++; comPagas = Math.round((comPagas + f.comissao_ml) * 100) / 100; if (amostras.paga_ausente.length < 10) amostras.paga_ausente.push({ venda: f.venda, comissao_ml: f.comissao_ml, data: (d.date_created || '').slice(0, 10) }); }
            else { classes.outra_situacao++; if (amostras.outra_situacao.length < 6) amostras.outra_situacao.push({ venda: f.venda, status: st }); }
          }
        } catch (e) { classes.erro_consulta++; }
        await new Promise(r2 => setTimeout(r2, 120));   // gentileza com o rate limit do ML
      }
      json(res, 200, { ok: true, de: deF, ate: ateF, faltantes_total: faltam.length, classificadas: alvo.length,
        classes, comissao_das_pagas_ausentes: comPagas,
        estimativa_faturamento_pagas_ausentes: Math.round(comPagas / 0.125 * 100) / 100,
        amostras,
        leia: 'cancelada e carrinho_descoberto_agora estao OK — PAGA_AUSENTE e o buraco real. Se faltantes_total > classificadas, rode de novo: as ja classificadas nao mudam de lista, entao o retrato por CLASSE e representativo do topo (maior comissao primeiro)' });
      return true;
    }



    /* ─── /ml-flex-debug ────────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/ml-flex-debug')) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!garantirTokenML) return semPeca(res, 'garantirTokenML');
      if (!aplicarCreditosFlex) return semPeca(res, 'aplicarCreditosFlex');
      const kD = lerChaveAdmin(req, urlObj);
      const sessD = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
      const vendaD = String(urlObj.searchParams.get('venda') || '').trim();
      if (!vendaD) { json(res, 400, { ok: false, erro: 'use ?venda=<numero da venda no ML>&k=ADMIN_KEY' }); return true; }
      const outD = { venda: vendaD, order: null, shipment: null, costs: null, pagamentos: null, billing: [], erros: [] };
      try {
        const tk = await garantirTokenML();
        const HD = { headers: { Authorization: 'Bearer ' + tk } }   /* Codex #343 r4: objeto REUSADO em várias requisições — sinal aqui abortaria todas as seguintes junto com a primeira; timeout é por requisição, em quem chama */;

        const ro = await fetch('https://api.mercadolibre.com/orders/' + encodeURIComponent(vendaD), HD);
        // Codex PR#46: corpo de ERRO (401/403/429/404) nao pode virar "order" — a rota existe
        // pra separar "fonte sem dado" de "fonte falhou", entao so o payload de sucesso conta
        let dor = ro.ok ? await ro.json().catch(() => null) : null;
        // Codex PR#46: id que da 404 em /orders e PACK (carrinho) — as vendas deste caso SAO
        // carrinho. Mesma cascata que a pesca ja usa: abre /packs/{id} e pega a 1a order.
        if (!ro.ok && ro.status === 404) {
          try {
            const rp = await fetch('https://api.mercadolibre.com/packs/' + encodeURIComponent(vendaD), HD);
            const dp = await rp.json().catch(() => null);
            const idsPack = rp.ok && dp && Array.isArray(dp.orders) ? dp.orders.map(o => o.id || o) : [];
            if (idsPack.length) {
              outD.resolvido_de_pack = { pack: vendaD, orders: idsPack };
              // Codex PR#46: carrinho pode ter frete/tarifa em QUALQUER das orders — busca todas
              outD.orders_do_pack = [];
              for (const oidP of idsPack) {
                // Codex PR#46: try por order — queda de rede numa nao pode esconder as outras
                let dorP = null;
                try {
                  const roP = await fetch('https://api.mercadolibre.com/orders/' + oidP, HD);
                  dorP = roP.ok ? await roP.json().catch(() => null) : null;
                  if (!dorP) outD.erros.push('orders(' + oidP + '): HTTP ' + roP.status);
                } catch (eP) { outD.erros.push('orders(' + oidP + '): ' + String(eP.message || eP).slice(0, 120)); }
                if (!dorP) { await new Promise(r => setTimeout(r, 150)); continue; }
                outD.orders_do_pack.push({ id: dorP.id, shipping_id: (dorP.shipping && dorP.shipping.id) || null, total: dorP.total_amount, frete_comprador: (dorP.shipping && dorP.shipping.cost) != null ? dorP.shipping.cost : null, pagamentos: (dorP.payments || []).map(pg => ({ id: pg.id, valor: pg.transaction_amount, frete: pg.shipping_cost, taxa: pg.marketplace_fee })) });
                if (!dor) dor = dorP;
                await new Promise(r => setTimeout(r, 150));
              }
              if (!dor) outD.erros.push('nenhuma order do pack respondeu');
            } else outD.erros.push('packs: HTTP ' + rp.status);
          } catch (e3) { outD.erros.push('packs: ' + String(e3.message || e3).slice(0, 120)); }
        } else if (!ro.ok) { outD.erros.push('orders: HTTP ' + ro.status); }
        // Codex PR#46 (5a rodada): se veio uma ORDER de carrinho (payload OK com pack_id), as
        // irmas nunca eram abertas — a compensacao Flex pode estar em qualquer uma delas
        if (dor && dor.pack_id && !outD.resolvido_de_pack) {
          try {
            const rpk = await fetch('https://api.mercadolibre.com/packs/' + encodeURIComponent(dor.pack_id), HD);
            const dpk = rpk.ok ? await rpk.json().catch(() => null) : null;
            const idsIrmas = dpk && Array.isArray(dpk.orders) ? dpk.orders.map(o => o.id || o) : [];
            if (idsIrmas.length) {
              outD.resolvido_de_pack = { pack: String(dor.pack_id), orders: idsIrmas, veio_de: 'order' };
              outD.orders_do_pack = outD.orders_do_pack || [];
              for (const oidI of idsIrmas) {
                if (String(oidI) === String(dor.id)) { outD.orders_do_pack.push({ id: dor.id, shipping_id: (dor.shipping && dor.shipping.id) || null, total: dor.total_amount, frete_comprador: (dor.shipping && dor.shipping.cost) != null ? dor.shipping.cost : null, pagamentos: (dor.payments || []).map(pg => ({ id: pg.id, valor: pg.transaction_amount, frete: pg.shipping_cost, taxa: pg.marketplace_fee })) }); continue; }
                try {
                  const roI = await fetch('https://api.mercadolibre.com/orders/' + oidI, HD);
                  const dorI = roI.ok ? await roI.json().catch(() => null) : null;
                  if (!dorI) { outD.erros.push('orders(' + oidI + '): HTTP ' + roI.status); continue; }
                  outD.orders_do_pack.push({ id: dorI.id, shipping_id: (dorI.shipping && dorI.shipping.id) || null, total: dorI.total_amount, frete_comprador: (dorI.shipping && dorI.shipping.cost) != null ? dorI.shipping.cost : null, pagamentos: (dorI.payments || []).map(pg => ({ id: pg.id, valor: pg.transaction_amount, frete: pg.shipping_cost, taxa: pg.marketplace_fee })) });
                } catch (eI) { outD.erros.push('orders(' + oidI + '): ' + String(eI.message || eI).slice(0, 120)); }
                await new Promise(r => setTimeout(r, 150));
              }
            } else outD.erros.push('packs(' + dor.pack_id + '): HTTP ' + rpk.status);
          } catch (ePk) { outD.erros.push('packs(' + dor.pack_id + '): ' + String(ePk.message || ePk).slice(0, 120)); }
        }
        if (!dor) { outD.erros.push('sem order utilizavel'); }
        else {
          outD.order = { id: dor.id, pack_id: dor.pack_id || null, status: dor.status, total: dor.total_amount, pago: dor.paid_amount, frete_comprador: (dor.shipping && dor.shipping.cost) != null ? dor.shipping.cost : null };
          outD.pagamentos = (dor.payments || []).map(pg => ({ id: pg.id, status: pg.status, valor: pg.transaction_amount, frete: pg.shipping_cost, taxa: pg.marketplace_fee, tipo: pg.payment_type }));
          // Codex PR#46 (4a rodada): num carrinho o envio pode estar em QUALQUER das orders —
          // junta todos os shipment ids distintos e consulta cada um. E cada fonte tem try
          // proprio: falha de transporte em /shipments nao pode impedir a consulta a /costs,
          // que e justamente a outra candidata que esta rota existe pra comparar.
          const shipIds = [];
          for (const cand of [dor].concat(outD.orders_do_pack ? [] : [])) { const sid = cand && cand.shipping && cand.shipping.id; if (sid && !shipIds.includes(sid)) shipIds.push(sid); }
          for (const oP of (outD.orders_do_pack || [])) { const sid = oP && oP.shipping_id; if (sid && !shipIds.includes(sid)) shipIds.push(sid); }
          if (!shipIds.length) outD.erros.push('nenhuma order tem shipping.id');
          outD.envios = [];
          for (const shipId of shipIds) {
            const linhaE = { shipment_id: shipId, shipment: null, costs: null };
            try {
              const rs = await fetch('https://api.mercadolibre.com/shipments/' + shipId, HD);
              const ds = rs.ok ? await rs.json().catch(() => null) : null;
              if (ds) { const soD = ds.shipping_option || {}; linhaE.shipment = { logistic: (ds.logistic && ds.logistic.type) || ds.logistic_type || null, status: ds.status, base_cost: ds.base_cost, list_cost: soD.list_cost != null ? soD.list_cost : ds.list_cost, cost: soD.cost != null ? soD.cost : ds.cost }; }
              else outD.erros.push('shipments(' + shipId + '): HTTP ' + rs.status);
            } catch (eS) { outD.erros.push('shipments(' + shipId + '): ' + String(eS.message || eS).slice(0, 120)); }
            try {
              const rc = await fetch('https://api.mercadolibre.com/shipments/' + shipId + '/costs', HD);
              const dc = rc.ok ? await rc.json().catch(() => null) : null;
              if (dc) {
                const sd = Array.isArray(dc.senders) ? dc.senders[0] : null;
                linhaE.costs = { gross_amount: dc.gross_amount, receiver_cost: dc.receiver && dc.receiver.cost, sender_cost: sd && sd.cost, compensation: sd && sd.compensation, compensations: (sd && sd.compensations) || [], save: sd && sd.save, discounts: (sd && sd.discounts) || null };
              } else outD.erros.push('costs(' + shipId + '): HTTP ' + rc.status);
            } catch (eC) { outD.erros.push('costs(' + shipId + '): ' + String(eC.message || eC).slice(0, 120)); }
            outD.envios.push(linhaE);
            await new Promise(r => setTimeout(r, 150));
          }
          // compatibilidade: os campos antigos apontam pro 1o envio
          if (outD.envios.length) { outD.shipment = Object.assign({ id: outD.envios[0].shipment_id }, outD.envios[0].shipment || {}); outD.costs = outD.envios[0].costs; }
        }
      } catch (e) { outD.erros.push('ML: ' + String(e.message || e).slice(0, 160)); }

      try {
        const arqD = readJson(path.join(CACHE_DIR, '_ml_billing.json'), null);
        // Codex PR#46: cache ausente/corrompido NAO pode parecer "cache sem linhas" — isso
        // inverteria o diagnostico. Sem tarifas legiveis, e falha de FONTE e vai pros erros.
        if (!arqD || typeof arqD !== 'object' || !arqD.tarifas || typeof arqD.tarifas !== 'object') {
          outD.erros.push('billing: _ml_billing.json ausente ou invalido (fonte indisponivel, nao "sem linhas")');
          outD.billing = null;
          json(res, 200, outD);
          return true;
        }
        // Codex PR#46: no carrinho o credito costuma estar na ORDER, nao no pack — junta todos
        // os ids conhecidos (o pedido pedido, a order resolvida, o pack e as orders do pack)
        const chavesD = new Set([vendaD]);
        if (outD.order && outD.order.id) chavesD.add(String(outD.order.id));
        if (outD.order && outD.order.pack_id) chavesD.add(String(outD.order.pack_id));
        for (const oid2 of ((outD.resolvido_de_pack && outD.resolvido_de_pack.orders) || [])) chavesD.add(String(oid2));
        // Codex PR#46: se a API do ML falhou, o proprio CACHE liga order↔pack (mesmo mapa que o
        // aplicarCreditosFlex monta) — assim o billing continua correto sem depender do ML
        const tarifasD = Object.values(arqD.tarifas || {});
        for (let volta = 0; volta < 2; volta++) {
          for (const tf of tarifasD) {
            if (!tf) continue;
            const o = String(tf.o || ''), pk = String(tf.p || '');
            if (o && pk) { if (chavesD.has(o)) chavesD.add(pk); if (chavesD.has(pk)) chavesD.add(o); }
          }
        }
        outD.chaves_consultadas = [...chavesD];
        for (const tf of tarifasD) {
          if (!tf) continue;
          if (chavesD.has(String(tf.o || '')) || chavesD.has(String(tf.p || ''))) outD.billing.push({ data: tf.d, valor: tf.v, categoria: tf.c, texto: tf.t });
        }
      } catch (e) { outD.erros.push('billing: ' + String(e.message || e).slice(0, 120)); }

      json(res, 200, outD);
      return true;
    }

    // CRÉDITOS FLEX — distribui os bônus de envio do billing no histórico (?de=&ate=; sem período = ano)



    /* ─── /ml-trocar-code ───────────────────────────────────────── */

    if (method === 'GET' && (p === (PREFIXO + '/setup-ml') || p === (PREFIXO + '/ml-trocar-code'))) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      /* Codex #575: precisa das DUAS operações do manager (autorizar e trocar o code), não só do
         `garantirTokenML` — sintetizar um manager com uma função só fazia as duas sub-rotas
         responderem 500 sempre. Vem inteiro, injetado pela empresa (`mlTokenManager`). */
      if (!mlTokenManager) return semPeca(res, 'mlTokenManager');
      if (typeof mlTokenManager.gerarUrlAutorizacao !== 'function') return semPeca(res, 'mlTokenManager.gerarUrlAutorizacao');
      if (typeof mlTokenManager.trocarCodigoPorToken !== 'function') return semPeca(res, 'mlTokenManager.trocarCodigoPorToken');
      const kA = lerChaveAdmin(req, urlObj);
      const sA = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kA === process.env.ADMIN_KEY) || (sA && ehAdmin(sA)))) { json(res, 404, { error: 'not found' }); return true; }
      const mlTM = mlTokenManager;
      if (p.endsWith('/setup-ml')) {
        try {
          const url = mlTM.gerarUrlAutorizacao();
          if (urlObj.searchParams.get('link') === '1') { json(res, 200, { ok: true, url, leia: 'abra esta URL logado como ' + NOME_EMPRESA + '; depois copie o code do endereço e chame ' + PREFIXO + '/ml-trocar-code?code=…&k=' }); return true; }
          res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' }); res.end();
        } catch (e) { json(res, 500, { ok: false, erro: String(e.message || e).slice(0, 200) }); }
        return true;
      }
      const code = String(urlObj.searchParams.get('code') || '').trim();
      if (!code) { json(res, 400, { ok: false, erro: 'passe ?code=… (o código que o ML devolveu na URL depois de autorizar)' }); return true; }
      try {
        await mlTM.trocarCodigoPorToken(code);
        json(res, 200, { ok: true, msg: 'token do ML da ' + NOME_EMPRESA + ' renovado com o escopo novo. Rode ' + PREFIXO + '/ml-devolucoes-coletar?dias=60&k=…' });
      } catch (e) { json(res, 500, { ok: false, erro: String(e.message || e).slice(0, 250) }); }
      return true;
    }

    // ── COMPLETAR TARIFA DO TIKTOK (18/08) ────────────────────────────────────────



    /* ─── /ml-vendas-do-dia ─────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/ml-vendas-do-dia')) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!supaCfg) return semPeca(res, 'supaCfg');
      if (!garantirTokenML) return semPeca(res, 'garantirTokenML');
      const kV = lerChaveAdmin(req, urlObj);
      const sV = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kV === process.env.ADMIN_KEY) || (sV && ehAdmin(sV)))) { json(res, 404, { error: 'not found' }); return true; }
      const deV  = String(urlObj.searchParams.get('de')  || new Date().toISOString().slice(0,10)).slice(0,10);
      const ateV = String(urlObj.searchParams.get('ate') || deV).slice(0,10);
      const out = { ok: true, de: deV, ate: ateV, passos: [] };

      let tokenML = null;
      try { tokenML = await garantirTokenML(); }
      catch (e) { json(res, 200, { ok: false, erro: 'sem token ML: ' + (e.message || e) }); return true; }
      const H = { headers: { Authorization: 'Bearer ' + tokenML } };

      // 1) quem sou eu (seller id)
      let sellerId = null;
      try {
        const rm = await fetch('https://api.mercadolibre.com/users/me', H);
        const bd = await rm.text();
        out.passos.push({ passo: 'users/me', status: rm.status, resposta: bd.slice(0, 200) });
        if (rm.ok) { try { sellerId = JSON.parse(bd).id; } catch (e) {} }
      } catch (e) { out.passos.push({ passo: 'users/me', erro: String(e.message || e).slice(0, 140) }); }
      if (!sellerId) { out.erro = 'nao consegui o seller id'; json(res, 200, out); return true; }
      out.seller = sellerId;

      // 2) vendas do periodo, paginando (mesmo padrao ja usado em auto-mensagens)
      const from = deV + 'T00:00:00.000-03:00', to = ateV + 'T23:59:59.999-03:00';
      const base = 'https://api.mercadolibre.com/orders/search?seller=' + sellerId +
                   '&order.date_created.from=' + encodeURIComponent(from) +
                   '&order.date_created.to=' + encodeURIComponent(to) + '&sort=date_asc&limit=50';
      const vendas = [];
      let total = Infinity;
      /* Codex #575: varredura INCOMPLETA não pode virar "tudo no histórico". Falha de HTTP, corpo
         ilegível ou período com mais vendas que o teto (1000) aborta com ok:false, em vez de
         calcular o veredito em cima de uma lista parcial. */
      const TETO_VENDAS = 1000;
      for (let off = 0; off < TETO_VENDAS && off < total; off += 50) {
        const r = await fetch(base + '&offset=' + off, H);
        const bd = await r.text();
        if (off === 0) out.passos.push({ passo: 'orders/search', status: r.status, resposta: bd.slice(0, 260) });
        if (!r.ok) { json(res, 200, { ...out, ok: false, erro: 'varredura incompleta: orders/search HTTP ' + r.status + ' no offset ' + off + ' — nada foi comparado' }); return true; }
        let d = null; try { d = JSON.parse(bd); } catch (e) { json(res, 200, { ...out, ok: false, erro: 'varredura incompleta: orders/search ilegível no offset ' + off + ' — nada foi comparado' }); return true; }
        const arr = (d && d.results) || [];
        for (const o of arr) {
          const it = (o.order_items || [])[0] || {};
          vendas.push({ order_id: String(o.id), pack_id: o.pack_id ? String(o.pack_id) : null,
            data: String(o.date_created || '').slice(0, 19), status: o.status,
            valor: Number(o.total_amount) || 0,
            sku: (it.item && (it.item.seller_sku || it.item.seller_custom_field)) || null,
            titulo: (it.item && String(it.item.title || '').slice(0, 40)) || null });
        }
        const t = Number(d && d.paging && d.paging.total);
        total = isFinite(t) ? t : vendas.length;
        if (arr.length < 50) break;
        await new Promise(r2 => setTimeout(r2, 300));
      }
      out.vendas_no_ml = vendas.length;
      out.total_informado_pelo_ml = (isFinite(total) ? total : null);
      if (isFinite(total) && total > vendas.length) {
        json(res, 200, { ...out, ok: false, erro: 'varredura incompleta: o ML informa ' + total + ' venda(s) no período e só ' + vendas.length + ' foram lidas (teto de ' + TETO_VENDAS + ') — reduza o período (?de=&ate=)' });
        return true;
      }
      out.faturamento_ml = Math.round(vendas.reduce((a, v) => a + v.valor, 0) * 100) / 100;
      out.por_status = vendas.reduce((a, v) => { a[v.status] = (a[v.status] || 0) + 1; return a; }, {});

      // 3) o que ja temos no historico
      const nosso = new Set();
      try {
        const cfg = supaCfg(EMPRESA);
        if (cfg.url && cfg.key) {
          const HB = { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key };
          const B = cfg.url.replace(/\/+$/, '') + '/rest/v1/vendas_historico?empresa=eq.' + EMPRESA + '&canal=eq.ml' +
                    '&data_venda=gte.' + deV + '&data_venda=lte.' + ateV;
          for (let o2 = 0; o2 < 20000; o2 += 1000) {
            const rq = await fetch(B + '&select=numero_loja&order=data_venda.asc,numero_pedido.asc,sku.asc&limit=1000&offset=' + o2, { headers: HB });
            if (!rq.ok) throw new Error('histórico: HTTP ' + rq.status);   // lista parcial → "faltando" falso
            const ln = await rq.json().catch(() => null);
            if (!Array.isArray(ln)) throw new Error('histórico: resposta ilegível');
            if (!ln.length) break;
            for (const l of ln) if (l.numero_loja) nosso.add(String(l.numero_loja).trim());
            if (ln.length < 1000) break;
          }
        }
      } catch (e) { out.erro_supabase = String(e.message || e).slice(0, 140); }
      out.no_nosso_historico = nosso.size;
      if (out.erro_supabase) { json(res, 200, { ...out, ok: false, erro: 'leitura do histórico incompleta (' + out.erro_supabase + ') — nada foi comparado' }); return true; }

      const faltam = vendas.filter(v => !nosso.has(v.order_id) && !(v.pack_id && nosso.has(v.pack_id)));
      out.faltando = faltam.length;
      out.valor_faltante = Math.round(faltam.reduce((a, v) => a + v.valor, 0) * 100) / 100;
      out.lista = faltam.slice(0, 60);
      out.veredito = faltam.length
        ? faltam.length + ' venda(s) existem no Mercado Livre e NAO no nosso historico — sao essas que o dashboard nao mostra'
        : 'tudo o que o ML tem no periodo ja esta no nosso historico';
      json(res, 200, out); return true;
    }



    /* ─── /ml-vendas-faltando ───────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/ml-vendas-faltando')) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!supaCfg) return semPeca(res, 'supaCfg');
      if (!MLB_FILE) return semPeca(res, 'MLB_FILE');
      const kF = lerChaveAdmin(req, urlObj);
      const sF = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kF === process.env.ADMIN_KEY) || (sF && ehAdmin(sF)))) { json(res, 404, { error: 'not found' }); return true; }
      const deF = String(urlObj.searchParams.get('de') || '').slice(0, 10);
      const ateF = String(urlObj.searchParams.get('ate') || '').slice(0, 10);
      if (!deF || !ateF) { json(res, 400, { ok: false, erro: 'informe ?de=2026-07-01&ate=2026-07-31' }); return true; }

      // 1) vendas que o ML cobrou comiss\u00e3o no per\u00edodo
      const b = readJson(MLB_FILE(), { tarifas: {} });
      // 02/08 \u2014 O MAPA VENDA\u2192PACK VEM DE **TODAS** AS TARIFAS, n\u00e3o s\u00f3 das comiss\u00f5es.
      // O shipping_info (onde mora o pack_id) nem sempre vem na linha da comiss\u00e3o \u2014 na amostra que
      // o ML mandou ele apareceu numa TAXA DE PARCELAMENTO. Filtrar por comiss\u00e3o antes de montar o
      // mapa jogava fora justamente a linha que tinha o pack, e metade da lista vinha com pack:null.
      // O pack \u00e9 propriedade do pedido, ent\u00e3o o mapa ignora data e categoria.
      const packDe = new Map();
      for (const t of Object.values(b.tarifas || {})) if (t.o && t.p) packDe.set(String(t.o), String(t.p));
      const doML = new Map();   // numero da venda -> { comiss\u00e3o somada, pack }
      let semPack = 0;
      for (const t of Object.values(b.tarifas || {})) {
        if (!t.o || !t.d) continue;
        if (t.d < deF || t.d > ateF) continue;
        if (t.c !== 'comissao') continue;
        { const at = doML.get(String(t.o)) || { com: 0, pack: null };
          doML.set(String(t.o), { com: Math.round((at.com + t.v) * 100) / 100, pack: t.p || at.pack || packDe.get(String(t.o)) || null }); }
      }

      // 2) o que temos no hist\u00f3rico
      const { url: uF, key: kSup } = supaCfg(EMPRESA);
      const nosso = new Set();
      if (uF && kSup) {
        const HF = { apikey: kSup, Authorization: 'Bearer ' + kSup };
        const BF = uF.replace(/\/+$/, '') + '/rest/v1/vendas_historico?empresa=eq.' + EMPRESA + '&canal=eq.ml' +
                   '&data_venda=gte.' + deF + '&data_venda=lte.' + ateF;
        for (let off = 0; off < 80000; off += 1000) {
          const rF = await fetch(BF + '&select=numero_loja&order=data_venda.asc,numero_pedido.asc,sku.asc&limit=1000&offset=' + off, { headers: HF });
          if (!rF.ok) break;
          const ln = await rF.json().catch(() => []);
          if (!Array.isArray(ln) || !ln.length) break;
          for (const l of ln) if (l.numero_loja) nosso.add(String(l.numero_loja).trim());
          if (ln.length < 1000) break;
        }
      }

      // 3) o que o ML tem e n\u00f3s n\u00e3o. Aten\u00e7\u00e3o ao CARRINHO: o Bling junta o pack num pedido s\u00f3,
      // ent\u00e3o uma venda "faltando" pode estar dentro de um pedido nosso com outro n\u00famero.
      // 02/08: s\u00f3 conta como faltando se NEM a venda NEM o carrinho estiverem no nosso hist\u00f3rico
      const faltam = []; let achadasPeloPack = 0;
      for (const [venda, info] of doML.entries()) {
        if (nosso.has(venda)) continue;
        if (info.pack && nosso.has(String(info.pack))) { achadasPeloPack++; continue; }
        if (!info.pack) semPack++;
        faltam.push({ venda, pack: info.pack || null, comissao_ml: info.com });
      }
      faltam.sort((a, b2) => b2.comissao_ml - a.comissao_ml);
      const somaCom = Math.round(faltam.reduce((a, x) => a + x.comissao_ml, 0) * 100) / 100;

      json(res, 200, { ok: true, de: deF, ate: ateF,
        vendas_no_ml: doML.size, vendas_no_nosso_historico: nosso.size, faltando: faltam.length, achadas_pelo_carrinho: achadasPeloPack, faltantes_sem_pack_conhecido: semPack, packs_mapeados: packDe.size,
        comissao_das_faltantes: somaCom,
        estimativa_faturamento_faltante: Math.round(somaCom / 0.125 * 100) / 100,
        aviso: 'venda do ML pode estar dentro de um CARRINHO no nosso lado (o Bling junta o pack num pedido s\u00f3) \u2014 confira algumas no Bling antes de concluir',
        amostra: faltam.slice(0, 40) });
      return true;
    }

    // 01/08 — varredura de cancelados: apaga do histórico quem foi cancelado no Bling
    /* 27/08 — CLASSIFICADOR das vendas 'faltando' do /ml-vendas-faltando: consulta o status REAL
       de cada uma na API do ML. Motivo: o billing pode lançar o ESTORNO da comissão noutra
       categoria, então venda CANCELADA fica no mapa com comissão cheia — indistinguível de venda
       perdida sem olhar o status. Separa: cancelada (ok, o histórico exclui de propósito) ×
       carrinho que o billing não mapeou (ok, está no nosso pelo número do pack) × PAGA-E-AUSENTE
       (o buraco real a importar). Máx 250 por chamada (~1min) — rode em fatias se precisar. */


    return false;
  };
}

module.exports = { criarRotasML };
