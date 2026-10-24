'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   SAÚDE DOS DADOS DA EMPRESA — e a preparação automática (24/10/2026).

   O dono, depois de uma semana de GOOD: "tinha que ter um esquema que quando ligasse a empresa, isso fosse buscado
   logo de cara". O que travou a GOOD (e, sem ninguém ver, o histórico da Girassol e da AMB desde 19/10) foi tudo coisa
   que uma conferência na subida do servidor teria mostrado no primeiro dia:
   · o banco do histórico sem a TROCA SEGURA (o script não tinha sido rodado) — cada backfill parava no fim;
   · o histórico do ano VAZIO na GOOD (ninguém tinha disparado o ano);
   · a rotina diária da GOOD DESLIGADA por variável;
   · o TikTok conectado e o financeiro sem coleta.

   verificar(empresa, d) → { empresa, pendencias, itens: [{ id, ok: true|false|null, titulo, detalhe, o_que_fazer }] }
     ok:null = NÃO SEI (o banco não respondeu) — nunca vira "está tudo bem" nem "está quebrado".
   prepararSozinha(empresa, d) → o que dá pra resolver sem o dono: histórico do ano VAZIO + a empresa tem o plano do ano
     → cria o plano (roda sozinho, fora do galpão). O resto (script do banco, variável) só a pessoa resolve: fica na
     lista do /embarque/dados com o que fazer.
   d: { supa: para(empresa) da lib/supabase, agora?, diarioDesligado?(), comoLigarDiario?, tiktokConectado?(),
        arquivoTikTok?, fs?, criarPlanoAno?(de, ate), planoExiste?() }
   ───────────────────────────────────────────────────────────────────────────── */

const { bancoPreparado } = require('./troca-periodo-historico');

const hojeSP = (agora) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(agora || new Date());
function menosDias(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }

/* a primeira venda gravada do ano e a última gravada (2 leituras de 1 linha) */
async function lerHistorico(empresa, supa, agora) {
  const hoje = hojeSP(agora), ano = hoje.slice(0, 4);
  const pedir = async (q) => {
    let r = null;
    try { r = await supa.req(empresa, 'GET', 'vendas_historico?empresa=eq.' + encodeURIComponent(empresa) + q, null); } catch (e) { return { erro: String((e && e.message) || e).slice(0, 120) }; }
    if (!r || !r.ok) return { erro: (r && (r.erro || ('HTTP ' + r.status))) || 'sem resposta' };
    try { const a = JSON.parse(r.body || '[]'); return { data: (Array.isArray(a) && a[0] && a[0].data_venda) ? String(a[0].data_venda).slice(0, 10) : null }; }
    catch (e) { return { erro: 'resposta ilegível' }; }
  };
  const ult = await pedir('&select=data_venda&order=data_venda.desc&limit=1');
  const pri = await pedir('&data_venda=gte.' + ano + '-01-01&select=data_venda&order=data_venda.asc&limit=1');
  if (ult.erro || pri.erro) return { ok: null, erro: ult.erro || pri.erro, hoje, ano };
  return { ok: true, hoje, ano, ultima: ult.data, primeira_do_ano: pri.data };
}

async function verificar(empresa, d) {
  const itens = [];
  const E = String(empresa).toUpperCase();
  /* 1) o banco do histórico tem a troca segura? */
  let b = null;
  try { b = await bancoPreparado({ empresa, supaReq: d.supa.req }); } catch (e) { b = { ok: null, msg: String((e && e.message) || e) }; }
  itens.push({ id: 'banco', titulo: 'Banco do histórico pronto (troca segura)',
    ok: b && b.ok === true ? true : (b && b.nao_preparado ? false : null),
    detalhe: b && b.ok === true ? 'tabela de rascunho e função da troca existem' : ((b && b.msg) || 'sem resposta'),
    o_que_fazer: b && b.nao_preparado ? 'rodar sql/historico-troca-segura.sql no SQL Editor do projeto de SUPABASE_URL_VENDAS_' + E : null });
  /* 2) o histórico do ano: começa em janeiro e está em dia? */
  const h = await lerHistorico(empresa, d.supa, d.agora);
  let it;
  if (h.ok !== true) it = { ok: null, detalhe: 'não consegui ler o histórico: ' + h.erro, o_que_fazer: null };
  else if (!h.primeira_do_ano) it = { ok: false, detalhe: 'nenhuma venda de ' + h.ano + ' gravada', o_que_fazer: 'rodar o plano do ano (backfill-ano) — onde a empresa tem o plano, ele é criado sozinho' };
  else {
    const parado = !h.ultima || h.ultima < menosDias(h.hoje, 3);
    const semComeco = h.primeira_do_ano > h.ano + '-01-10';
    it = { ok: !(parado || semComeco), detalhe: 'gravado de ' + h.primeira_do_ano + ' a ' + h.ultima,
      o_que_fazer: parado ? 'o histórico parou em ' + h.ultima + ' — a rotina diária não está gravando (ver o backfill-status da empresa)'
        : (semComeco ? 'falta o começo do ano — rodar o backfill de ' + h.ano + '-01-01 até ' + h.primeira_do_ano : null) };
  }
  itens.push(Object.assign({ id: 'historico', titulo: 'Histórico de vendas do ano' }, it,
    { primeira_do_ano: (h && h.primeira_do_ano) || null, ultima: (h && h.ultima) || null }));
  /* 3) a rotina diária do histórico está ligada? (só onde existe a chave de desligar) */
  if (typeof d.diarioDesligado === 'function') {
    const off = !!d.diarioDesligado();
    itens.push({ id: 'rotina_diaria', titulo: 'Rotina diária do histórico', ok: !off, detalhe: off ? 'desligada' : 'ligada',
      o_que_fazer: off ? (d.comoLigarDiario || 'religar a rotina diária') : null });
  }
  /* 4) TikTok conectado → o financeiro está sendo coletado? */
  let tkConectado = false;
  try { tkConectado = typeof d.tiktokConectado === 'function' && !!d.tiktokConectado(); } catch (e) { tkConectado = false; }
  if (tkConectado) {
    /* Codex #735: a coleta grava o arquivo mesmo quando FALHA (o TikTok recusou, zero registros) — a data do arquivo
       ficaria sempre nova e esconderia a falha. Vale o `ok_em`, que o coletor só atualiza quando a coleta deu certo. */
    let okEm = null, ilegivel = false, existe = true;
    try { okEm = (JSON.parse((d.fs || require('fs')).readFileSync(d.arquivoTikTok, 'utf8')) || {}).ok_em || null; }
    catch (e) { if (e && e.code === 'ENOENT') existe = false; else ilegivel = true; }
    const idadeH = okEm ? (Date.now() - Date.parse(okEm)) / 3600000 : null;
    const ok = ilegivel ? null : (idadeH !== null && isFinite(idadeH) && idadeH < 72);
    itens.push({ id: 'tiktok', titulo: 'Financeiro do TikTok', ok,
      detalhe: ilegivel ? 'não consegui ler o arquivo do financeiro'
        : (!existe ? 'conectado, mas o financeiro nunca foi coletado'
          : (okEm ? ('última coleta que deu certo há ' + Math.round(idadeH) + ' h') : 'nenhuma coleta deu certo até agora')),
      o_que_fazer: ok === false ? 'a coleta diária não está dando certo — coletar agora em /tiktok/financeiro-coletar?loja=' + empresa + '&dias=120 e ver o erro' : null });
  }
  return { empresa, quando: new Date().toISOString(), pendencias: itens.filter((i) => i.ok === false).length, itens };
}

/* o que dá pra resolver sozinho: histórico do ano vazio + plano do ano disponível → cria o plano */
async function prepararSozinha(empresa, d) {
  const h = await lerHistorico(empresa, d.supa, d.agora);
  if (h.ok !== true) return { feito: false, motivo: 'não sei — o histórico não respondeu (' + h.erro + ')' };
  if (h.primeira_do_ano) return { feito: false, motivo: 'o histórico de ' + h.ano + ' já tem vendas (de ' + h.primeira_do_ano + ')' };
  if (typeof d.criarPlanoAno !== 'function') return { feito: false, motivo: 'histórico do ano vazio, mas esta empresa não tem o plano do ano' };
  if (typeof d.planoExiste === 'function' && d.planoExiste()) return { feito: false, motivo: 'histórico do ano vazio e o plano do ano já existe (rodando ou parado)' };
  const r = await d.criarPlanoAno(h.ano + '-01-01', h.hoje);
  return { feito: !!(r && r.ok !== false), motivo: 'histórico de ' + h.ano + ' vazio — plano do ano criado (' + h.ano + '-01-01 a ' + h.hoje + ')', resultado: r || null };
}

module.exports = { verificar, prepararSozinha, lerHistorico };
