'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   AVISO DA PARTNER KEY DA SHOPEE NA BARRA DOS PAINÉIS (27/10/2026) — pedido do dono depois que a chave da Girassol
   venceu sem ninguém ver (23/10 → 27/10, o repasse, as devoluções e a carteira da Shopee dela pararam):
   "me apareça um aviso bem na cara no checkout tipo 5 dias antes". A Shopee NÃO informa a validade da chave pela API
   (só o console da Open Platform mostra) — então são duas fontes:
     · a DATA que o dono cadastra por empresa (<TAG>_SHOPEE_KEY_VENCE, AAAA-MM-DD; a geral SHOPEE_KEY_VENCE vale pra
       quem não tem a sua) — dá o aviso ANTES;
     · a PROVA da última conferência do canário das integrações (a Shopee aceitou ou recusou a assinatura da loja),
       gravada em <CACHE da empresa>/_shopee_chave_prova.json — pega o que a data não pega (chave errada, data velha).
   Para cada empresa do registro: recusou → vermelho; venceu (sem prova depois) → vermelho; faltam ≤ 5 dias → vermelho;
   data vencida mas a chave funcionou depois dela → amarelo (atualizar a data); sem data → amarelo (cadastrar).
   ───────────────────────────────────────────────────────────────────────────── */
const DIAS_AVISO = 5;
const ARQ_PROVA = '_shopee_chave_prova.json';

/* Codex #754: o formato não basta — '2027-13-25' vira NaN (o aviso sumia) e '2027-04-31' o JavaScript empurra pra 01/05
   (o aviso sairia um dia depois). Só vale data que EXISTE no calendário; o resto é "data inválida" (avisa, não some). */
function dataValida(v) {
  const s = String(v || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) ? s : null;
}
const _data = dataValida;
function _br(iso) { return iso ? iso.split('-').reverse().join('/') : ''; }

/* empresa: { id, nome, tag, loja } · prova: o que o canário gravou (ou null) · env: process.env · agora: ms */
function avaliar(empresa, prova, env, agora) {
  const e = env || process.env, t0 = (agora == null ? Date.now() : agora);
  const envEmp = empresa.tag ? empresa.tag + '_SHOPEE_KEY_VENCE' : null;
  /* a variável que VALE: a da empresa se estiver preenchida (mesmo que errada — aí é ela que tem que ser corrigida);
     senão a geral */
  const envUsado = (envEmp && String(e[envEmp] || '').trim()) ? envEmp : (String(e.SHOPEE_KEY_VENCE || '').trim() ? 'SHOPEE_KEY_VENCE' : null);
  const bruto = envUsado ? String(e[envUsado]).trim() : '';
  const vence = envUsado ? _data(bruto) : null;
  const pv = prova || {};
  /* Codex #754: a variável da Partner Key é a da LOJA de verdade no serviço (a da prova, que o canário resolveu da
     configuração — pode ter sido trocada por variável), não a chave da empresa */
  const envChave = String(pv.loja || empresa.loja || empresa.id || '').toUpperCase() + '_SYNC_SHOPEE_PARTNER_KEY';
  const base = { empresa: empresa.id, nome: empresa.nome || empresa.id, env: envEmp || 'SHOPEE_KEY_VENCE', envChave, vence: _br(vence) };
  const provaEm = Date.parse(pv.quando || '') || 0;
  if (pv.recusou) return Object.assign(base, { nivel: 'vermelho', tipo: 'recusou', quando: pv.quando || null, motivo: String(pv.recusou).slice(0, 160) });
  if (envUsado && !vence) return Object.assign(base, { nivel: 'amarelo', tipo: 'data_invalida', env: envUsado, valor: bruto.slice(0, 20) });
  if (!vence) return Object.assign(base, { nivel: 'amarelo', tipo: 'sem_data' });
  /* dias de CALENDÁRIO (São Paulo): "5 dias antes" é no dia 20 pra uma chave que vence no dia 25, qualquer que seja a hora */
  const hoje = new Date(t0).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const dias = Math.round((Date.parse(vence + 'T00:00:00Z') - Date.parse(hoje + 'T00:00:00Z')) / 864e5);
  if (dias < 0) {
    /* a data passou: se a Shopee ACEITOU a assinatura DEPOIS dela, a chave foi renovada e só a data está velha */
    if (pv.assinaturaOk && provaEm > Date.parse(vence + 'T23:59:59-03:00')) return Object.assign(base, { nivel: 'amarelo', tipo: 'data_velha', quando: pv.quando });
    return Object.assign(base, { nivel: 'vermelho', tipo: 'venceu', dias });
  }
  if (dias <= DIAS_AVISO) return Object.assign(base, { nivel: 'vermelho', tipo: 'vence', dias });
  return null;
}

/* empresas: [{ id, nome, tag, loja, cacheDir }] · lerJson(arquivo) */
function montarAlerta(empresas, o) {
  const path = require('path');
  const itens = [];
  for (const emp of empresas || []) {
    let prova = null;
    try { prova = emp.cacheDir ? o.lerJson(path.join(emp.cacheDir, ARQ_PROVA)) : null; } catch (e) { prova = null; }
    const it = avaliar(emp, prova, o.env, o.agora);
    if (it) itens.push(it);
  }
  return { alerta: itens.length > 0, itens };
}

module.exports = { avaliar, montarAlerta, dataValida, DIAS_AVISO, ARQ_PROVA };
