'use strict';
/* 11/11 (plano multiloja, Fase 3 4e) — O PLANO DE BACKFILL EM FATIAS, POR EMPRESA, NUMA PEÇA SÓ.

   O que é: um período longo do histórico (um ano, por exemplo) vira FATIAS de 10 dias gravadas EM DISCO e rodadas uma
   por vez — fora do horário do galpão, cedendo a vez a outro backfill, refazendo sozinho a fatia que falha por motivo
   passageiro e retomando de onde parou se o serviço reiniciar (lib/backfill-fatiado: `criarMotor`).

   Como estava: a GOOD tinha o motor (15/10) e a rota; a Girassol tinha a rota e um "tocar" próprio, mais antigo (sem
   esperar o galpão fechar nem refazer sozinho); a AMB NÃO TINHA plano — o ano dela só rodava mês a mês, de uma vez, e
   uma queda no meio obrigava a recomeçar na mão. Esta peça é a UNIÃO: o motor da GOOD + o `acao=criar` da Girassol + a
   proteção contra clique duplo (plano em andamento não é sobrescrito sem &refazer=1).

   A empresa entrega só o que é dela: a pasta do cache (o plano mora nela), como roda UMA fatia e quando está ocupada.

   GET <prefixo>/backfill-plano?k=ADMIN_KEY            → como está (resumo do plano + o motor)
       &acao=criar&de=AAAA-MM-DD&ate=AAAA-MM-DD[&dias=10][&refazer=1]
       &acao=parar      → a fatia em curso termina e ele não segue
       &acao=retentar   → as fatias com erro voltam pra fila

   15/11 (norte C, rotas-cópia): GET|POST <prefixo>/backfill-ano[?ano=AAAA&ate=MM][&refazer=1] — o ANO vira plano (a
   regra da GOOD, que já era a melhor das três: fatias em disco, fora do horário do galpão, retoma sozinho). A Girassol
   e a AMB rodavam o ano em memória, mês a mês de uma vez (`backfillAnoTodo`): uma queda no meio perdia o andamento. A
   rota aceita a chave OU a sessão de admin quando a empresa entrega `validarSessao`/`ehAdmin` (como a Girassol e a AMB
   aceitavam); o período vem de lib/checkout/backfill-ano-periodo (sem &ate = até o mês passado). */

function criar(o0) {
  /* 17/11 (montarCheckout, passo 20): o prefixo sai do contrato da empresa (quem passar o prefixo fica com o seu) */
  const o = (o0 && o0.prefixo == null && o0.empresa) ? Object.assign({}, o0, { prefixo: require('./config-empresa').prefixoDe(o0.empresa) }) : o0;
  for (const n of ['empresa', 'prefixo', 'cacheDir', 'json', 'lerChaveAdmin', 'rodarFatia', 'ocupado']) {
    if (!o || o[n] == null) throw new Error('lib/checkout/backfill-plano-empresa: falta ' + n);
  }
  const fat = o.fat || require('../backfill-fatiado');
  const fundo = require('./contexto-fundo');
  const { empresa, prefixo, cacheDir, json, lerChaveAdmin } = o;
  const podeRodarAgora = o.podeRodarAgora || (() => fundo.janelaRotinaPesada());

  const motor = fat.criarMotor(Object.assign({
    cacheDir,
    pausaMs: Number((o.envPausa && process.env[o.envPausa]) || o.pausaMs || 20000),   /* respiro entre fatias */
    /* a fatia roda como FUNDO desta empresa (o porteiro do Bling dá a vez ao galpão) */
    rodarFatia: (f) => fundo.emFundo(empresa, () => o.rodarFatia(f)),   /* encerrando → devolve { adiado } e a fatia volta pra fila (Codex #901) */
    ocupado: () => { try { return !!o.ocupado(); } catch (e) { return true; } },   /* na dúvida, não atropela */
    podeRodarAgora,
  }, o.motor || {}));

  function status() { return Object.assign({}, fat.resumo(fat.ler(cacheDir)), { motor: motor.estado() }); }

  /* cria o plano em disco e aciona o motor (que só roda se a janela e a vez deixarem). LANÇA se o disco recusar. */
  function criarPlano(de, ate, dias) {
    const pl = fat.criar(cacheDir, de, ate, dias || 10);
    motor.tocar().catch(() => {});
    return pl;
  }

  /* 16/11: existe plano em disco (rodando, parado ou concluído) — o que a preparação sozinha da empresa olha antes de criar o do ano */
  function existe() { return !!fat.ler(cacheDir); }

  /* plano ainda com fatia pendente (e não parado) — o que a proteção contra clique duplo olha */
  function emAndamento() { const pl = fat.ler(cacheDir); return !!(pl && !pl.parado && fat.proxima(pl)); }

  /* 18/11 — o ECO do navegador (o mesmo do /backfill, 04/09): abrir a URL pode mandar DUAS requisições (a pré-carga do
     navegador e a navegação). A 1ª cria o plano e o motor já começa a 1ª fatia; a 2ª via a empresa ocupada (ou o plano em
     andamento) e respondia 409 "já tem backfill rodando" — e é ESSA que fica na tela: o dono leu como erro com o plano do
     ano rodando direitinho. Plano do MESMO período, criado há menos de 60 s e ainda em andamento: é eco — responde que já
     foi criado (com o resumo) e não mexe em nada, nem com &refazer=1 (recriar o mesmo período recém-criado zeraria a
     fatia em curso à toa). Devolve os segundos, ou null. */
  function ecoDoPlano(de, ate) {
    const pl = fat.ler(cacheDir);
    if (!pl || pl.parado || pl.de !== de || pl.ate !== ate || !fat.proxima(pl)) return null;
    const seg = (Date.now() - Date.parse(pl.criado || '')) / 1000;
    return (seg >= 0 && seg < 60) ? Math.round(seg) : null;
  }
  const msgEco = (seg) => '✅ este plano já foi criado (há ' + seg + 's) e roda sozinho, uma fatia por vez — acompanhe em /backfill-status';

  /* Codex #840: a data tem que EXISTIR no calendário — "2026-13-01" e "2026-02-30" passam no formato, e a biblioteca de
     fatias normalizava em silêncio (30/02 virava 02/03; mês 13 dava plano vazio anunciado como aceito) */
  function dataReal(t) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(t || ''))) return false;
    const d = new Date(t + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t;
  }

  async function rota(req, res, urlObj, method, p) {
    if (!(method === 'GET' && p === prefixo + '/backfill-plano')) return false;
    const k = lerChaveAdmin(req, urlObj);
    if (!(process.env.ADMIN_KEY && k === process.env.ADMIN_KEY)) { json(res, 404, { error: 'not found' }); return true; }
    const acao = urlObj.searchParams.get('acao') || 'status';
    if (acao === 'parar') {
      const okP = fat.parar(cacheDir);
      json(res, okP ? 200 : 500, okP ? { ok: true, msg: 'plano parado: a fatia em curso termina e ele não segue' } : { ok: false, erro: 'não consegui gravar a parada do plano — ele segue como estava' });
      return true;
    }
    if (acao === 'retentar') {
      const n = fat.retentar(cacheDir);
      if (n < 0) { json(res, 500, { ok: false, erro: 'não consegui gravar o plano — nada voltou pra fila' }); return true; }
      motor.tocar().catch(() => {});
      json(res, 200, { ok: true, msg: n + ' fatia(s) com erro voltaram pra fila' });
      return true;
    }
    if (acao === 'criar') {
      const de = urlObj.searchParams.get('de') || '', ate = urlObj.searchParams.get('ate') || '';
      const dias = Math.min(31, Math.max(1, Number(urlObj.searchParams.get('dias')) || 10));
      if (!dataReal(de) || !dataReal(ate) || de > ate) {
        json(res, 400, { ok: false, erro: 'use ?acao=criar&de=AAAA-MM-DD&ate=AAAA-MM-DD&dias=10 (datas que existem, com de até ate)' }); return true;
      }
      const eco = ecoDoPlano(de, ate);
      if (eco != null) { json(res, 200, { ok: true, empresa, eco: true, msg: msgEco(eco), resumo: fat.resumo(fat.ler(cacheDir)) }); return true; }
      if (emAndamento() && urlObj.searchParams.get('refazer') !== '1') {
        json(res, 409, { ok: false, erro: 'já existe um plano em andamento — acompanhe no status (ou &refazer=1 pra recomeçar)', plano: fat.resumo(fat.ler(cacheDir)) });
        return true;
      }
      let pl;
      try { pl = criarPlano(de, ate, dias); } catch (e) { json(res, 500, { ok: false, erro: String((e && e.message) || e) }); return true; }
      /* plano sem fatia nenhuma não é "criado" (não anuncia como aceito o que não vai rodar) */
      if (!pl || !pl.fatias || !pl.fatias.length) { json(res, 400, { ok: false, erro: 'período vazio: ' + de + ' a ' + ate + ' não gerou fatia nenhuma' }); return true; }
      let jan = { ok: true }; try { jan = podeRodarAgora() || { ok: true }; } catch (e) { jan = { ok: true }; }
      json(res, 200, { ok: true, empresa, msg: '✅ plano criado: ' + pl.fatias.length + ' fatia(s) de ' + dias + ' dia(s). Roda sozinho, uma por vez, e retoma se o serviço reiniciar.',
        comeca: jan.ok ? 'agora' : (jan.motivo || 'quando o galpão fechar'), resumo: fat.resumo(pl) });
      return true;
    }
    json(res, 200, Object.assign({ ok: true, empresa }, status()));
    return true;
  }

  /* o ANO como plano: GET|POST <prefixo>/backfill-ano */
  function _admin(req, urlObj) {
    const k = lerChaveAdmin(req, urlObj);
    if (process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) return true;
    if (typeof o.validarSessao === 'function' && typeof o.ehAdmin === 'function') {
      const sess = o.validarSessao(req.headers && req.headers['cookie']);
      return !!(sess && o.ehAdmin(sess));
    }
    return false;
  }
  async function rotaAno(req, res, urlObj, method, p) {
    if (!((method === 'GET' || method === 'POST') && p === prefixo + '/backfill-ano')) return false;
    if (!_admin(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }   /* rota de admin não confirma que existe */
    const per = require('./backfill-ano-periodo').resolverPeriodoAno({ ano: urlObj.searchParams.get('ano'), ate: urlObj.searchParams.get('ate') });
    if (!per.ok) { json(res, 400, { ok: false, erro: per.erro }); return true; }
    /* 18/11: o eco do navegador vem ANTES da trava de ocupado — o plano recém-criado já ocupa a empresa com a 1ª fatia */
    const eco = ecoDoPlano(per.de, per.fim);
    if (eco != null) {
      const plE = fat.ler(cacheDir);
      json(res, 200, { ok: true, empresa, eco: true, ano: per.ano, de: per.de, ate: per.fim, fatias: plE.fatias.length, msg: msgEco(eco), acompanhe: prefixo + '/backfill-status' });
      return true;
    }
    /* Codex: a trava do canário (e a de qualquer backfill em curso) vale pro ano também — `ocupado` é a trava COMPLETA da empresa */
    let ocp = false; try { ocp = !!o.ocupado(); } catch (e) { ocp = true; }
    if (ocp) { json(res, 409, { ok: false, erro: 'já tem backfill rodando (ou o canário conferindo o Bling) — acompanhe no status e tente de novo depois' }); return true; }
    if (emAndamento() && urlObj.searchParams.get('refazer') !== '1') {
      json(res, 409, { ok: false, erro: 'já existe um plano em andamento — acompanhe no status (ou &refazer=1 pra recomeçar)', plano: fat.resumo(fat.ler(cacheDir)) });
      return true;
    }
    let pl;
    try { pl = criarPlano(per.de, per.fim, 10); } catch (e) { json(res, 500, { ok: false, erro: String((e && e.message) || e) }); return true; }
    if (!pl || !pl.fatias || !pl.fatias.length) { json(res, 400, { ok: false, erro: 'período vazio: ' + per.de + ' a ' + per.fim + ' não gerou fatia nenhuma' }); return true; }
    let jan = { ok: true }; try { jan = podeRodarAgora() || { ok: true }; } catch (e) { jan = { ok: true }; }
    /* 13/09: a chave NÃO volta na resposta — quem abriu por sessão clica e funciona; quem usa chave acrescenta a sua */
    json(res, 202, { ok: true, empresa, ano: per.ano, de: per.de, ate: per.fim, fatias: pl.fatias.length, automatico: true,
      comeca: jan.ok ? 'agora' : (jan.motivo || 'quando o galpão fechar'),
      acompanhe: prefixo + '/backfill-status',
      nota: 'plano em disco: roda sozinho fora do horário do galpão, uma fatia de 10 dias por vez, refaz sozinho a que falhar e retoma de onde parou se o serviço reiniciar.' });
    return true;
  }

  /* 3 min depois do boot: plano que ficou pela metade (queda/deploy) é retomado sem ninguém pedir */
  function retomarNoBoot(ms) {
    const t = setTimeout(() => { motor.tocar().catch((e) => console.error('[plano-' + empresa + '] boot:', e && e.message)); }, ms == null ? 3 * 60000 : ms);
    if (t && t.unref) t.unref();
    return t;
  }

  return { motor, rota, rotaAno, status, criarPlano, existe, emAndamento, retomarNoBoot };
}

module.exports = { criar };
