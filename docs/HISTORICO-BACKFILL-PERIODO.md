# Histórico — o backfill manual de um período, em duas rotas (até 17/11/2026)

Norte C, `montarCheckout(empresa)`, passo 22: o `/backfill` da fábrica do painel e o `/backfill-vendas` escrito à mão no arquivo da GOOD faziam a mesma coisa (refazer o histórico de um período, em segundo plano). Viraram a peça única `lib/checkout/rota-backfill-periodo`, nos dois nomes e nas três empresas — a união do que cada uma tinha:

- a trava (chave OU sessão de admin; sem as duas, 404) vem antes de tudo — a da fábrica respondia "o canário está conferindo" antes de conferir quem pedia;
- o período é obrigatório e conferido (a da GOOD): `de`/`ate` AAAA-MM-DD e `de` <= `ate`, senão 400. A da fábrica, sem as datas, rodava de 01/01/2026 até hoje — o ano inteiro, de uma vez; o ano é o `/backfill-ano` (em fatias, fora do horário do galpão);
- o canário conferindo o Bling: espera; já rodando: o eco da 2ª requisição do navegador e a recusa que diz qual período ocupa (a da fábrica);
- dispara pela peça da empresa, no porteiro do Bling (a da GOOD chamava o motor direto, sem dar a vez ao galpão), e responde com onde acompanhar — sem a chave de admin no link (a da GOOD devolvia `?k=<a chave>`).

O andamento da rodada manual é o do registro da empresa (`lib/checkout/backfill-estado`), que o `/backfill-status` mostra nas três; o `_bfGood` da GOOD segue sendo o andamento das rodadas do plano e da rotina diária. Abaixo, o que cada lugar tinha, tirado do código sem tocar no texto.

## a fábrica (`lib/checkout/fabrica-rotas-painel.js`) — Girassol e AMB (e a GOOD, pelo nome `/backfill`)

```js
    /* ─── /backfill ─────────────────────────────────────────────── */

    if (method === 'GET' && p === (PREFIXO + '/backfill')) {
      if (!ehAdmin) return semPeca(res, 'ehAdmin');
      if (!_backfill) return semPeca(res, '_backfill');
      if (!backfillVendas) return semPeca(res, 'backfillVendas');
      /* 08/11 (união, grupo do backfill): a trava do canário que só a Girassol tinha — rodando o canário (que confere o Bling),
         o backfill espera. Empresa sem canário (peça ausente) segue como antes. */
      if (_canario && _canario.rodando) { json(res, 200, { ok: false, msg: 'o canário está conferindo o Bling agora (desde ' + _canario.desde + ') — espere alguns segundos e tente de novo' }); return true; }
      const kD = lerChaveAdmin(req, urlObj);
      const sessD = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
      const de = String((urlObj.searchParams && urlObj.searchParams.get('de')) || '2026-01-01').slice(0, 10);
      const ate = String((urlObj.searchParams && urlObj.searchParams.get('ate')) || new Date().toISOString().slice(0, 10)).slice(0, 10);
      if (_backfill.rodando) {
        /* 04/09 — ECO DA PRÓPRIA CHAMADA: o navegador faz duas requisições ao abrir a URL
           (a página e o favicon/retry). A primeira dispara; a segunda chega segundos depois,
           vê o estado já 'rodando' e respondia "já tem um backfill rodando" — mostrando o
           backfill que o próprio usuário acabou de criar. Parecia recusa e confundiu o dono
           várias vezes. Se o período pedido é o MESMO e a rodada começou há poucos segundos,
           é eco: responde 'iniciado'. Só quando é outro período (ou rodada antiga) é recusa
           de verdade. */
        /* Codex (#519): mesmo cuidado que a Girassol recebeu — a empresa faz parte da
           identidade da rodada. Aqui a rota dispara com EMPRESA (ver a chamada logo abaixo). */
        const mesmoPeriodo = _backfill.empresa === EMPRESA && _backfill.de === de && _backfill.ate === ate;
        const segundos = _backfill.inicio ? (Date.now() - Date.parse(_backfill.inicio)) / 1000 : 1e9;
        if (mesmoPeriodo && segundos < 30) {
          json(res, 200, { ok: true, msg: '✅ backfill deste período já foi iniciado (há ' + Math.round(segundos) + 's) — acompanhe em /backfill-status', de, ate, status: _backfill });
          return true;
        }
        json(res, 200, { ok: false,
          msg: mesmoPeriodo
            ? ('já tem um backfill DESTE período rodando desde ' + (_backfill.inicio ? new Date(_backfill.inicio).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(11, 16) : '?') + ' — acompanhe em /backfill-status')
            : ('já tem um backfill rodando (' + _backfill.de + ' a ' + _backfill.ate + ') — espere terminar; acompanhe em /backfill-status'),
          status: _backfill });
        return true;
      }
      backfillVendas(de, ate, EMPRESA);   // NÃO await — roda em background
      json(res, 200, { ok: true, msg: '✅ backfill iniciado em background (só ' + NOME_EMPRESA + '). Acompanhe em /backfill-status. Ele deleta o período antes e regrava, então pode rodar de novo sem duplicar.', de, ate });
      return true;
    }
```

## good (`good-checkout-offline/index.js`) — `/backfill-vendas`

```js
  /* ═══ 01/10 — PARIDADE DO PAINEL: rotas que a AMB tinha e a GOOD não ═══
     O dono: "o que o painel de dashboard tem pra uma, tem q ter pra outra... os botões, os
     cards, isso tem q ser iguais nelas". Medi antes de copiar: das 18 que eu achava que faltavam, 5 já respondiam pelas libs
     comuns que a GOOD monta — sobraram 11, que entraram por levas (ml-fatura-cartao, tiktok-custo-devolucoes,
     magalu-cancelados… hoje todas pela fábrica do painel e pelas peças). O que ainda é SÓ desta empresa fica abaixo. */
  async function _rotaBackfillVendas(req, res, urlObj, method, p) {
    if (!((method === 'GET' || method === 'POST') && p === '/good-checkout-offline/backfill-vendas')) return false;
    const kB = lerChaveAdmin(req, urlObj);
    if (!(process.env.ADMIN_KEY && kB === process.env.ADMIN_KEY)) { json(res, 404, { error: 'not found' }); return true; }
    const de = urlObj.searchParams.get('de') || '';
    const ate = urlObj.searchParams.get('ate') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) {
      json(res, 400, { ok: false, erro: 'use ?de=AAAA-MM-DD&ate=AAAA-MM-DD' }); return true;
    }
    if (de > ate) { json(res, 400, { ok: false, erro: 'de maior que ate' }); return true; }
    try {
      const gbo = require('../lib/checkout/backfill-rodar');   /* 15/11 (norte C): o motor único (era o gbo-app da Girassol) */
      /* 14/10 (parecer do Codex, 6.1): contexto num lugar so — ver _ctxBackfillGood */
      const ctxGood = _ctxBackfillGood();
      /* roda em BACKGROUND: um mês de backfill leva minutos e o navegador desiste antes */
      /* 30/08: guarda o estado pra dar pra acompanhar sem caçar no log do Render — foi a
         primeira coisa que o dono precisou e não existia (o TikTok e o Magalu têm). */
      /* Codex #309 r4: minha detecção de "outro rodando" comparava o período — se alguém
         dispara DUAS vezes o MESMO mês, os períodos batem e o segundo apareceria como
         sucesso. Marco de quem é a rodada, decidido ANTES de disparar, resolve sem
         depender de comparar datas. */
      const jaAtivo = _bfGood && _bfGood.estado === 'rodando';
      if (jaAtivo) {
        json(res, 409, { ok: false, empresa: 'good', de, ate,
          erro: 'já existe um backfill da GOOD em andamento (' + (_bfGood.de || '') + '→' + (_bfGood.ate || '') + ') — aguarde terminar',
          /* Codex #309 r5: sobrou o placeholder aqui quando corrigi o outro — mesmo
             problema, link que não abre, na resposta que o dono mais vai ver (a de
             "já tem um rodando"). */
          acompanhe: '/good-checkout-offline/backfill-status?k=' + encodeURIComponent(kB) });
        return true;
      }
      const marca = Date.now().toString(36);
      _bfGood = { estado: 'rodando', de, ate, marca, iniciado: new Date().toISOString() };
      gbo.backfillVendas(de, ate, 'good', ctxGood)
        .then(r => {
          /* 31/08 — agora a função DIZ o que aconteceu: toda saída dela devolve `desfecho`
             (ok / com_erros / erro / abortado / ja_rodando / adiado). Antes eu inferia isso
             de fora comparando período, lendo fase e marcando rodada — três remendos que
             nasceram do mesmo defeito e cada um deixava um caso passar. */
          const d = r || {};
          const desf = d.desfecho || (d.adiado ? 'adiado' : (d.ok === false ? 'nao_rodou' : 'ok'));
          const MAPA = {
            ok: ['ok', null],
            com_erros: ['concluido_com_erros', 'terminou, mas houve erros em itens — confira antes de seguir'],
            erro: ['falhou', d.msg || 'erro durante o backfill'],
            /* 'abortado' vem de DOIS lugares: 6 falhas seguidas do Bling, e a trava de
               sanidade (dados novos < 60% do guardado). Nos dois casos NADA foi apagado —
               a mensagem original explica qual foi. */
            abortado: ['falhou', d.msg || 'abortado — NADA foi apagado, rode de novo'],
            ja_rodando: ['nao_rodou', d.msg || 'já havia um backfill em andamento'],
            /* Codex #309: o adiamento vem de dois lugares com campos diferentes — o
               reparo de SKU usa `adiado` e o canário usa `msg`. Lendo só um, o operador
               via 'adiado' sem saber o motivo. */
            adiado: ['nao_rodou', d.adiado || d.msg || 'adiado (canário ou reparo de SKU em andamento)'],
            nao_rodou: ['nao_rodou', d.msg || 'recusou iniciar'],
          };
          const [estado, motivo] = MAPA[desf] || ['ok', null];
          _bfGood = {
            estado, motivo, desfecho: desf, de, ate, marca,
            terminado: new Date().toISOString(),
            pedidos: d.pedidos, itens: d.itens, gravados: d.gravados, erros: d.erros, fase: d.fase || null,
          };
          console.log('[GOOD backfill]', desf, JSON.stringify(d).slice(0, 180));
        })
        .catch(e => {
          _bfGood = { estado: 'falhou', de, ate, erro: String(e.message || e).slice(0, 200), terminado: new Date().toISOString() };
          console.error('[GOOD backfill] falhou:', e.message);
        });
      json(res, 202, { ok: true, empresa: 'good', de, ate, em_background: true,
        /* Codex #309 r4: o placeholder não abre; devolve o link com a chave que veio */
        acompanhe: '/good-checkout-offline/backfill-status?k=' + encodeURIComponent(kB),
        nota: 'rode um mês por vez pra não estourar o tempo' });
    } catch (e) {
      json(res, 500, { ok: false, erro: String(e.message || e).slice(0, 160) });
    }
    return true;
  }
```
