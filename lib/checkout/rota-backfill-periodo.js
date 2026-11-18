'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   O BACKFILL MANUAL DE UM PERÍODO — peça única (17/11/2026, norte C, `montarCheckout`, passo 22).

   Eram DUAS rotas pra mesma coisa (refazer o histórico de um período, em segundo plano):
     · `/backfill?de=&ate=` — a da fábrica do painel, que as três têm (a Girassol e a AMB usam);
     · `/backfill-vendas?de=&ate=` — a última rota PRÓPRIA escrita num arquivo de entrada (o da GOOD), com o estado da
       rodada manual num objeto dela, sem passar pelo porteiro do Bling e devolvendo a chave de admin no link de
       acompanhar.
   Agora uma rota só, nos DOIS nomes (quem tem o link antigo segue usando) e nas três empresas — a UNIÃO do que cada uma
   tinha de melhor:
     · a trava: chave OU sessão de admin; sem as duas, 404 (rota de admin não confirma que existe). Vem ANTES de tudo —
       a da fábrica dizia "o canário está conferindo" a quem não era admin;
     · o período é obrigatório e conferido (a da GOOD): `de`/`ate` no formato AAAA-MM-DD e `de` <= `ate`, senão 400. A da
       fábrica, sem as datas, rodava de 01/01/2026 até hoje — o ANO inteiro, de uma vez, na hora que fosse (a cota do
       Bling é da operação); o ano tem rota própria, em fatias, fora do horário do galpão (`/backfill-ano`);
     · o canário conferindo o Bling: espera (a da fábrica);
     · já tem backfill rodando: o eco da 2ª requisição do navegador aparece como "já foi iniciado"; outro período, ou
       rodada antiga, é recusa dizendo qual período ocupa (a da fábrica);
     · dispara pela peça da empresa — o porteiro do Bling dá a vez ao galpão — e responde na hora, com onde acompanhar
       (sem a chave no link).
   O andamento da rodada é o do registro da empresa (lib/checkout/backfill-estado), que o /backfill-status mostra nas três.
   ───────────────────────────────────────────────────────────────────────────── */

/* os dois nomes (o da fábrica e o que a GOOD usava), no prefixo da empresa — escritos por extenso: a sonda da fila de rotas
   (scripts/teste-rotas-empresa.js) acha as rotas conhecidas lendo `prefixo + '/x'` no código */
function caminhosDe(prefixo) { return [prefixo + '/backfill', prefixo + '/backfill-vendas']; }
const DIA = /^\d{4}-\d{2}-\d{2}$/;

function criar(o) {
  if (!o || !o.empresa) throw new Error('lib/checkout/rota-backfill-periodo: falta empresa');
  for (const k of ['json', 'lerChaveAdmin', 'validarSessao', 'ehAdmin', 'backfillVendas']) {
    if (typeof o[k] !== 'function') throw new Error('lib/checkout/rota-backfill-periodo (' + o.empresa + '): falta ' + k);
  }
  if (!o.estado || typeof o.estado !== 'object') throw new Error('lib/checkout/rota-backfill-periodo (' + o.empresa + '): falta o estado do backfill da empresa');
  const cfg = require('./config-empresa').configCheckout(o.empresa);   /* empresa fora do contrato derruba no boot */
  const prefixo = o.prefixo != null ? o.prefixo : require('./config-empresa').prefixoDe(o.empresa);
  const nome = o.nomeEmpresa || cfg.nomeCurto || String(o.empresa).toUpperCase();
  const { empresa, json, lerChaveAdmin, validarSessao, ehAdmin, backfillVendas, estado } = o;
  const canario = o.canario || null;   /* empresa sem canário: nada a esperar */
  const caminhos = caminhosDe(prefixo);
  const acompanhe = prefixo + '/backfill-status';

  async function rotaBackfillPeriodo(req, res, urlObj, method, p) {
    if (!((method === 'GET' || method === 'POST') && caminhos.includes(p))) return false;
    const k = lerChaveAdmin(req, urlObj);
    const sess = validarSessao(req.headers['cookie']);
    if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sess && ehAdmin(sess)))) { json(res, 404, { error: 'not found' }); return true; }
    const de = String((urlObj.searchParams && urlObj.searchParams.get('de')) || '');
    const ate = String((urlObj.searchParams && urlObj.searchParams.get('ate')) || '');
    if (!DIA.test(de) || !DIA.test(ate)) {
      json(res, 400, { ok: false, erro: 'use ?de=AAAA-MM-DD&ate=AAAA-MM-DD — um mês por vez; o ano inteiro é o /backfill-ano (em fatias, fora do horário do galpão)' });
      return true;
    }
    if (de > ate) { json(res, 400, { ok: false, erro: 'de maior que ate' }); return true; }
    if (canario && canario.rodando) {
      json(res, 200, { ok: false, msg: 'o canário está conferindo o Bling agora (desde ' + canario.desde + ') — espere alguns segundos e tente de novo' });
      return true;
    }
    if (estado.rodando) {
      /* 04/09 — o ECO da própria chamada: o navegador faz duas requisições ao abrir a URL (a página e o favicon/retry); a
         segunda via o estado já 'rodando' e respondia "já tem um backfill rodando" — o que o próprio usuário acabou de
         criar. Mesmo período (e a MESMA empresa, Codex #519), começado há poucos segundos: é eco. */
      const mesmoPeriodo = estado.empresa === empresa && estado.de === de && estado.ate === ate;
      const segundos = estado.inicio ? (Date.now() - Date.parse(estado.inicio)) / 1000 : 1e9;
      if (mesmoPeriodo && segundos < 30) {
        json(res, 200, { ok: true, msg: '✅ backfill deste período já foi iniciado (há ' + Math.round(segundos) + 's) — acompanhe em /backfill-status', de, ate, acompanhe, status: estado });
        return true;
      }
      json(res, 200, { ok: false,
        msg: mesmoPeriodo
          ? ('já tem um backfill DESTE período rodando desde ' + (estado.inicio ? new Date(estado.inicio).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(11, 16) : '?') + ' — acompanhe em /backfill-status')
          : ('já tem um backfill rodando (' + estado.de + ' a ' + estado.ate + ') — espere terminar; acompanhe em /backfill-status'),
        acompanhe, status: estado });
      return true;
    }
    /* NÃO await — roda em segundo plano; a falha vai pro log (e pro andamento da empresa), nunca derruba o processo */
    let corrida;
    try { corrida = backfillVendas(de, ate, empresa); } catch (e) { corrida = Promise.reject(e); }   /* chamada NA HORA: o andamento já sai "rodando" pro eco */
    const registrarRecusa = (desfecho, motivo) => {
      const agora = new Date().toISOString();
      Object.assign(estado, { rodando: false, empresa, de, ate, pagina: 0, pedidos: 0, itens: 0, gravados: 0, erros: desfecho === 'erro' ? 1 : 0,
        fase: desfecho === 'erro' ? 'erro' : 'nao_rodou', desfecho, inicio: agora, fim: agora, msg: motivo });
    };
    Promise.resolve(corrida).then((r) => {
      /* Codex #937: o motor RECUSA sem tocar no registro (reparo de SKU, caça da Magalu, canário → `adiado`; `nao_rodou`) —
         sem isto o /backfill-status seguiria mostrando a rodada anterior (ou o parado) e ninguém saberia por que o período
         não rodou. Só registra a recusa quando nada está rodando (`ja_rodando` é outra rodada legítima: não se mexe nela). */
      if (r && r.ok === false && (r.desfecho === 'adiado' || r.desfecho === 'nao_rodou') && !estado.rodando) {
        registrarRecusa(r.desfecho, r.adiado || r.msg || 'o backfill não rodou');
      }
    }, (e) => {
      const m = String((e && e.message) || e).slice(0, 200);
      console.error('[' + cfg.tag + '] backfill ' + de + '→' + ate + ' falhou: ' + m);
      if (!estado.rodando) registrarRecusa('erro', m);
    });
    json(res, 200, { ok: true, msg: '✅ backfill iniciado em background (só ' + nome + '). Acompanhe em /backfill-status. Ele deleta o período antes e regrava, então pode rodar de novo sem duplicar.',
      de, ate, acompanhe, nota: 'rode um mês por vez pra não estourar o tempo' });
    return true;
  }
  rotaBackfillPeriodo.caminhos = caminhos.slice();
  return rotaBackfillPeriodo;
}

/* os caminhos que a rota atende, num prefixo — quem monta (a fábrica) decide se é com ela antes de exigir as peças */
function atende(prefixo, method, p) { return (method === 'GET' || method === 'POST') && caminhosDe(prefixo).includes(p); }

module.exports = { criar, atende, caminhosDe };
