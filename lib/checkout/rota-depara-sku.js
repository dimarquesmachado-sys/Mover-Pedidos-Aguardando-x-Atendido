'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   ROTA DO DE-PARA DE SKU (fatia 8 da desduplicação, 13/09/2026).

   129 linhas iguais nas duas empresas; só o prefixo do caminho mudava. É a rota
   que hoje resolveu o caso FL-1011-PRETO → 3933398010054: SKU renomeado no Bling
   deixava o banco de custos procurando o código velho todo dia.

   O que ela guarda de valioso não é o CRUD, são as travas aprendidas em revisão:
   apagar remove TODAS as variantes de grafia (um par gravado como "Pm1" sobrevivia
   a um apagar "pm1" e a rota ainda dizia ok), e declarar um par recusa ciclo
   seguindo a cadeia a partir do destino — senão a resolução entraria em loop.
   Duas cópias dessas regras eram duas chances de uma divergir da outra.

   A rota não conhece empresa: recebe o prefixo e as funções por injeção.
   ──────────────────────────────────────────────────────────────────────────── */

const { lerChaveAdmin } = require('../http/chave-admin');

function criarRotaDeParaSku(deps) {
  const { prefixo, json, readJson, path, CACHE_DIR, validarSessao, ehAdmin,
          lerDeParaSku, gravarDeParaSku, resolverDeParaSku, sugerirDeParaSku } = deps || {};
  for (const [nome, v] of Object.entries({ prefixo, json, readJson, path, CACHE_DIR, lerDeParaSku, gravarDeParaSku, resolverDeParaSku, sugerirDeParaSku })) {
    if (v == null) throw new Error('lib/checkout/rota-depara-sku: falta ' + nome);
  }

  return async function rotaDeParaSku(req, res, urlObj, method, p) {
      if (p === (prefixo + '/sku-depara-manual')) {
        const kM2 = lerChaveAdmin(req, urlObj);
        const sM2 = validarSessao(req.headers['cookie']);
        if (!((process.env.ADMIN_KEY && kM2 === process.env.ADMIN_KEY) || (sM2 && ehAdmin(sM2)))) { json(res, 404, { error: 'not found' }); return true; }

        if (method === 'GET') {
          const sug = String(urlObj.searchParams.get('sugerir') || '').trim();
          if (sug) {
            /* candidatos saem do banco de custos (SKUs que existem hoje) — sem varrer o catálogo
               inteiro do Bling, que é lento e já tem rota própria. */
            const cc = readJson(path.join(CACHE_DIR, '_custos.json'), {}) || {};
            /* 21/08 (Codex, revisão geral): o card não tinha como mostrar que o SKU JÁ está ligado —
               o campo vinha preenchido com a sugestão e parecia ligado sem estar, e uma ligação
               errada não tinha como ser desfeita pela tela. Devolvo o vínculo atual junto. */
            const _dpAtual = lerDeParaSku();
            const _kv = Object.keys(_dpAtual).find(k => String(k).toUpperCase() === sug.toUpperCase());
            json(res, 200, { ok: true, de: sug, sugestoes: sugerirDeParaSku(sug, Object.keys(cc)),
              vinculo: _kv ? { de: _kv, para: _dpAtual[_kv].para, em: _dpAtual[_kv].em || null } : null,
              leia: 'sugestao por semelhanca — confira antes de declarar; juntar produtos diferentes mistura as vendas' });
            return true;
          }
          /* 13/09 — DECLARAR O PAR PELO NAVEGADOR. A rota só aceitava POST com JSON, e o dono
             opera pelo navegador (a casa já tem outras rotas em GET por esse mesmo motivo).
             O caso que motivou: FL-1011-PRETO foi renomeado pra 3933398010054 no Bling, e o
             banco de custos seguia procurando o código velho — uma falha por rodada, todo dia,
             no produto que mais vende. Mesmas travas do POST: exige os dois lados, recusa par
             igual e recusa ciclo. */
          const deG = String(urlObj.searchParams.get('de') || '').trim();
          const paraG = String(urlObj.searchParams.get('para') || '').trim();
          if (deG || paraG) {
            /* Codex (#397 P2): só um dos dois lados caía direto na listagem — 200 ok:true sem
               gravar nada, e quem digitou errado achava que tinha declarado o par. */
            if (!deG || !paraG) { json(res, 400, { ok: false, erro: 'informe de e para' }); return true; }
            /* Codex (#397 P1): GET que grava é alvo de CSRF — o cookie de sessão é SameSite=Lax,
               que ainda viaja numa navegação top-level (um link/imagem noutro site abriria esta
               URL já logado e reescreveria o par). Navegadores atuais marcam esse caso com
               Sec-Fetch-Site: cross-site; só bloqueio esse caso — digitar a URL ou abrir por um
               link dentro do próprio sistema continua funcionando normalmente. */
            if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
              json(res, 403, { ok: false, erro: 'requisicao cross-site bloqueada (protecao contra CSRF) — abra o sistema e declare o par por lá' });
              return true;
            }
            if (deG.toUpperCase() === paraG.toUpperCase()) { json(res, 400, { ok: false, erro: 'de e para sao o mesmo SKU' }); return true; }
            const mG = lerDeParaSku();
            /* ciclo: seguindo a cadeia a partir de `para`, ela não pode voltar em `de` */
            let passo = paraG, voltas = 0;
            while (passo && voltas++ < 20) {
              const kk = Object.keys(mG).find(x => String(x).toUpperCase() === String(passo).toUpperCase());
              if (!kk) break;
              const prox = mG[kk] && mG[kk].para;
              if (prox && String(prox).toUpperCase() === deG.toUpperCase()) { json(res, 400, { ok: false, erro: 'esse par criaria um ciclo (' + deG + ' ↔ ' + paraG + ')' }); return true; }
              passo = prox;
            }
            for (const kk of Object.keys(mG).filter(x => String(x).trim().toUpperCase() === deG.toUpperCase())) delete mG[kk];
            mG[deG] = { para: paraG, em: new Date().toISOString() };
            gravarDeParaSku(mG);
            json(res, 200, { ok: true, ligado: { de: deG, para: paraG }, total: Object.keys(mG).length,
              leia: 'o histórico e o custo passam a resolver ' + deG + ' como ' + paraG + ' — confira que são o MESMO produto, porque juntar produtos diferentes mistura as vendas' });
            return true;
          }
          const m = lerDeParaSku();
          json(res, 200, { ok: true, total: Object.keys(m).length,
            pares: Object.keys(m).sort().map(k => ({ de: k, para: m[k].para, em: m[k].em || null })) });
          return true;
        }

        if (method === 'POST') {
          let corpo = '';
          await new Promise(r => { req.on('data', c => { corpo += c; if (corpo.length > 1e6) req.destroy(); }); req.on('end', r); req.on('error', r); });
          let b = {};
          try { b = JSON.parse(corpo || '{}'); } catch (e) { json(res, 400, { ok: false, erro: 'JSON invalido' }); return true; }
          const m = lerDeParaSku();

          if (b.apagar) {
            /* Codex (#185): o resto da rota trata SKU sem diferenciar maiúscula/minúscula, mas o
               apagar só removia a grafia exata e a MAIÚSCULA. Um par gravado como "Pm1" sobrevivia
               a um apagar "pm1" — e a rota ainda respondia ok, então parecia apagado e não estava. */
            /* Codex (#186): apagar SÓ a primeira variante era REGRESSÃO — o save antigo permitia
               "pm1" e "PM1" convivendo, e a versão anterior removia exata + MAIÚSCULA. Com uma
               chave só sobrando, ela voltaria a valer sozinha. Apaga TODAS as variantes. */
            const k = String(b.apagar).trim();
            const kTodas = Object.keys(m).filter(x => String(x).trim().toUpperCase() === k.toUpperCase());
            const tinha = kTodas.length > 0;
            for (const kk of kTodas) delete m[kk];
            gravarDeParaSku(m);
            json(res, 200, { ok: true, apagado: tinha ? k : null, total: Object.keys(m).length });
            return true;
          }

          const de = String(b.de || '').trim();
          const para = String(b.para || '').trim();
          if (!de || !para) { json(res, 400, { ok: false, erro: 'informe de e para' }); return true; }
          if (de.toUpperCase() === para.toUpperCase()) { json(res, 400, { ok: false, erro: 'de e para sao o mesmo SKU' }); return true; }
          /* ciclo: se o destino já aponta de volta pra origem, recusa — senão a resolução ficaria
             dando voltas e o Diego não entenderia por que o custo não aparece. */
          /* Codex (#185): a checagem antiga resolvia o destino PELA ARESTA ANTIGA do próprio `de`,
             e comparava só o resultado final. Com A→B e C→A, mudar A pra apontar pra C fazia
             resolverDeParaSku('C') devolver B — passava, e gravava o ciclo A↔C. Agora percorro a
             cadeia a partir de `para` IGNORANDO a aresta atual de `de`, e recuso se ela passar por
             `de` em qualquer ponto. */
          const _up = s => String(s || '').toUpperCase();
          let _passo = para, _visit = new Set([_up(de)]), _ciclo = false;
          for (let i = 0; i < 50 && _passo; i++) {
            if (_up(_passo) === _up(de)) { _ciclo = true; break; }
            if (_visit.has(_up(_passo))) break;            // ciclo que não envolve `de`: já existia
            _visit.add(_up(_passo));
            const _reg = m[_passo] || m[Object.keys(m).find(k => _up(k) === _up(_passo))];
            _passo = _reg && _reg.para;
          }
          if (_ciclo) {
            json(res, 400, { ok: false, erro: 'isso criaria um ciclo: seguindo ' + para + ' se chega de volta em ' + de }); return true;
          }
          /* Codex (#185): mesmo bug de caixa do apagar, do outro lado. Gravar "Pm1 → A" e depois
             "pm1 → B" deixava as DUAS chaves, e a resolução escolhia uma ou outra conforme a grafia
             que chegasse. Reaproveito a chave que já existe (comparação normalizada). */
          /* Codex (#186): reaproveitar UMA chave não bastava. Com "pm1" e "PM1" legados convivendo
             (o save antigo permitia), atualizar a primeira deixava a outra apontando pro destino
             VELHO — e como a busca dá precedência à chave exata, resolver "PM1" ainda devolvia o
             destino antigo. Mesma correção do apagar, do outro lado: some com todas as variantes e
             deixa UMA, preservando a grafia que já estava gravada. */
          const _vars = Object.keys(m).filter(x => String(x).trim().toUpperCase() === de.toUpperCase());
          const _deReal = _vars[0] || de;
          for (const _v of _vars) delete m[_v];
          m[_deReal] = { para, em: new Date().toISOString() };
          gravarDeParaSku(m);
          json(res, 200, { ok: true, de, para, resolve_para: resolverDeParaSku(de), total: Object.keys(m).length });
          return true;
        }
      }
    return false;
  };
}

module.exports = { criarRotaDeParaSku };
