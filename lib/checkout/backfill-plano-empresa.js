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
       &acao=retentar   → as fatias com erro voltam pra fila */

function criar(o) {
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
    rodarFatia: (f) => fundo.emFundo(empresa, () => o.rodarFatia(f)),
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

  /* plano ainda com fatia pendente (e não parado) — o que a proteção contra clique duplo olha */
  function emAndamento() { const pl = fat.ler(cacheDir); return !!(pl && !pl.parado && fat.proxima(pl)); }

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
      if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate) || de > ate) {
        json(res, 400, { ok: false, erro: 'use ?acao=criar&de=AAAA-MM-DD&ate=AAAA-MM-DD&dias=10 (com de até ate)' }); return true;
      }
      if (emAndamento() && urlObj.searchParams.get('refazer') !== '1') {
        json(res, 409, { ok: false, erro: 'já existe um plano em andamento — acompanhe no status (ou &refazer=1 pra recomeçar)', plano: fat.resumo(fat.ler(cacheDir)) });
        return true;
      }
      let pl;
      try { pl = criarPlano(de, ate, dias); } catch (e) { json(res, 500, { ok: false, erro: String((e && e.message) || e) }); return true; }
      let jan = { ok: true }; try { jan = podeRodarAgora() || { ok: true }; } catch (e) { jan = { ok: true }; }
      json(res, 200, { ok: true, empresa, msg: '✅ plano criado: ' + pl.fatias.length + ' fatia(s) de ' + dias + ' dia(s). Roda sozinho, uma por vez, e retoma se o serviço reiniciar.',
        comeca: jan.ok ? 'agora' : (jan.motivo || 'quando o galpão fechar'), resumo: fat.resumo(pl) });
      return true;
    }
    json(res, 200, Object.assign({ ok: true, empresa }, status()));
    return true;
  }

  /* 3 min depois do boot: plano que ficou pela metade (queda/deploy) é retomado sem ninguém pedir */
  function retomarNoBoot(ms) {
    const t = setTimeout(() => { motor.tocar().catch((e) => console.error('[plano-' + empresa + '] boot:', e && e.message)); }, ms == null ? 3 * 60000 : ms);
    if (t && t.unref) t.unref();
    return t;
  }

  return { motor, rota, status, criarPlano, emAndamento, retomarNoBoot };
}

module.exports = { criar };
