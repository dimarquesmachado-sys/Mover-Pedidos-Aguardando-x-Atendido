'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   PEDIDO QUE O BLING JÁ CANCELOU COM A NOTA AINDA VALENDO — A ROTA (27/11/2026, peça única, as três empresas).

   A regra e a varredura moram em lib/checkout/cancelados-bling-vigia. Esta rota é como o painel (e o dono) chegam nela.
   SÓ LEITURA no Bling; nada é gerado, cancelado ou movido por aqui (esta é a parte 1: ver o buraco).

   GET <prefixo>/cancelados-bling
       → { ok, rodou_em, em_andamento, ultimo, total, pendentes: [{ pedido_id, numero, numero_loja, marketplace, data,
            nf_numero, nfe_id, horas_desde_a_emissao, acao, prova_local }], nota_em_outra_situacao: [{ pedido_id, numero, nf_numero, nf_situacao }] }
         `acao`: 'cancelar' (nota emitida há menos de 24 h — ainda cancela no Bling) ou 'devolucao' (24 h ou mais).
         `prova_local: false` = pedido mais velho que o registro de bipagem (28 dias): não dá pra dizer "não postado".
         A VIGIA SE RENOVA SOZINHA: quando a lista é pedida e a última rodada tem mais de 30 min, uma rodada LEVE (3 dias,
         poucas leituras) é disparada em segundo plano, como trabalho de FUNDO (cede a vez à operação no porteiro do Bling).
         A resposta não espera por ela — mostra o que já se sabe.
   GET <prefixo>/cancelados-bling?varrer=1[&dias=N][&forcar=sim]
       → dispara uma rodada agora. Até 7 dias é leve e roda a qualquer hora. Mais que isso é a VARREDURA DAS ANTIGAS:
         gasta cota do Bling (duas leituras por pedido cancelado não bipado) e, no horário do galpão (seg–sex, 7h–18h de
         São Paulo), é RECUSADA — a não ser com &forcar=sim. Uma rodada por vez.

   Sem dado de gente. Trava: chave OU sessão de admin; sem as duas, 404.

   criar({ empresa, prefixo, json, lerChaveAdmin, validarSessao, ehAdmin, vigia, emFundo?, noGalpao?, agora? })
   ───────────────────────────────────────────────────────────────────────────── */
const RENOVA_MS = 30 * 60 * 1000;
const LEVE = { dias: 3, leituras: 40 };
const DIAS_LEVE_MAX = 7;

function caminhoDe(prefixo) { return prefixo + '/cancelados-bling'; }
function atende(prefixo, method, p) { return method === 'GET' && p === caminhoDe(prefixo); }

/* horário do galpão em São Paulo: segunda a sexta, das 7h às 18h */
function noGalpaoAgora(t) {
  const partes = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', hour12: false }).formatToParts(new Date(t));
  const h = Number((partes.find((x) => x.type === 'hour') || {}).value || 0) % 24;
  const d = String((partes.find((x) => x.type === 'weekday') || {}).value || '');
  return !/^(Sat|Sun)$/.test(d) && h >= 7 && h < 18;
}

function criar(o) {
  if (!o || !o.empresa) throw new Error('lib/checkout/rota-cancelados-bling: falta empresa');
  for (const k of ['json', 'lerChaveAdmin', 'validarSessao', 'ehAdmin']) if (typeof o[k] !== 'function') throw new Error('lib/checkout/rota-cancelados-bling (' + o.empresa + '): falta ' + k);
  if (!o.prefixo || !o.vigia || typeof o.vigia.varrer !== 'function' || typeof o.vigia.pendentes !== 'function') throw new Error('lib/checkout/rota-cancelados-bling (' + o.empresa + '): falta prefixo/vigia');
  const { empresa, prefixo, json, lerChaveAdmin, validarSessao, ehAdmin, vigia } = o;
  const agora = o.agora || (() => Date.now());
  const noGalpao = o.noGalpao || noGalpaoAgora;
  const emFundo = o.emFundo || ((fn) => require('./contexto-fundo').emFundo(String(empresa) + '.cancelados-bling', fn));
  let ultimoDisparo = 0, ultimoErro = null;

  /* dispara sem esperar: a resposta HTTP não fica presa na varredura, e erro dela não derruba ninguém */
  function disparar(op) {
    ultimoDisparo = agora();
    Promise.resolve().then(() => emFundo(() => vigia.varrer(op)))
      .then((r) => { ultimoErro = r && r.ok === false && r.etapa !== 'rodando' ? String(r.erro || r.etapa || r.motivo || 'não rodou') : null; })
      .catch((e) => { ultimoErro = 'a varredura falhou: ' + String((e && e.message) || e).slice(0, 160); });
  }

  return async function rotaCanceladosBling(req, res, urlObj, method, p) {
    if (!atende(prefixo, method, p)) return false;
    const k = lerChaveAdmin(req, urlObj);
    const sess = validarSessao(req.headers['cookie']);
    if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sess && ehAdmin(sess)))) { json(res, 404, { error: 'not found' }); return true; }
    const base = { empresa, so_leitura: true };
    const q = (n) => String((urlObj.searchParams && urlObj.searchParams.get(n)) || '').trim();

    if (q('varrer')) {
      const bruto = q('dias');
      if (bruto && !/^\d{1,3}$/.test(bruto)) { json(res, 400, Object.assign({ ok: false, erro: 'use ?varrer=1&dias=<1 a 180>' }, base)); return true; }
      const dias = bruto ? Math.max(1, Math.min(180, Number(bruto))) : LEVE.dias;
      if (vigia.emAndamento && vigia.emAndamento()) { json(res, 200, Object.assign({ ok: false, etapa: 'rodando', erro: 'já tem uma varredura em andamento — veja o resultado em ' + caminhoDe(prefixo) }, base)); return true; }
      const pesada = dias > DIAS_LEVE_MAX;
      if (pesada && noGalpao(agora()) && q('forcar').toLowerCase() !== 'sim') {
        json(res, 200, Object.assign({ ok: false, etapa: 'horario_do_galpao', erro: 'varredura de ' + dias + ' dias gasta cota do Bling e agora é horário do galpão (seg–sex, 7h–18h) — rode depois das 18h ou no fim de semana; pra rodar assim mesmo, acrescente &forcar=sim' }, base));
        return true;
      }
      disparar({ dias, leituras: pesada ? 600 : LEVE.leituras });
      json(res, 200, Object.assign({ ok: true, disparada: { dias, pesada }, acompanhe: caminhoDe(prefixo) }, base));
      return true;
    }

    let lido = null;
    try { lido = vigia.pendentes(); }
    catch (e) { json(res, 200, Object.assign({ ok: false, etapa: 'registro', erro: 'não consegui ler o registro da vigia dos cancelados' }, base)); return true; }
    /* a vigia se renova: lista pedida + última rodada velha (ou nenhuma) → uma rodada leve em segundo plano */
    const rodou = lido.rodou_em ? Date.parse(lido.rodou_em) : 0;
    const emAndamento = !!(vigia.emAndamento && vigia.emAndamento());
    if (!emAndamento && !(agora() - rodou < RENOVA_MS) && !(agora() - ultimoDisparo < RENOVA_MS)) disparar(LEVE);
    let ultimo = null;
    try { const reg = vigia.ler(); ultimo = reg && reg.ultimo ? reg.ultimo : null; } catch (e) { ultimo = null; }
    json(res, 200, Object.assign({ ok: true, rodou_em: lido.rodou_em, em_andamento: emAndamento, ultimo, ultimo_erro: ultimoErro, total: lido.pendentes.length, pendentes: lido.pendentes, nota_em_outra_situacao: lido.outras || [],
      leia: 'pedidos que o Bling já cancelou, que o galpão não bipou, e cuja NF de VENDA ainda está autorizada. Devolução já emitida não aparece aqui (a API do Bling não mostra) — confira antes de gerar outra. `nota_em_outra_situacao` = nota nem autorizada nem cancelada (pendente, rejeitada…): sem ação, só pra você ver.' }, base));
    return true;
  };
}

module.exports = { criar, atende, caminhoDe, noGalpaoAgora, RENOVA_MS };
