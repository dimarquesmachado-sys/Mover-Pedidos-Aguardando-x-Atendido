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

function _data(v) { const s = String(v || '').trim().slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; }
function _br(iso) { return iso ? iso.split('-').reverse().join('/') : ''; }

/* empresa: { id, nome, tag, loja } · prova: o que o canário gravou (ou null) · env: process.env · agora: ms */
function avaliar(empresa, prova, env, agora) {
  const e = env || process.env, t0 = (agora == null ? Date.now() : agora);
  const envEmp = empresa.tag ? empresa.tag + '_SHOPEE_KEY_VENCE' : null;
  const envUsado = (envEmp && _data(e[envEmp])) ? envEmp : (_data(e.SHOPEE_KEY_VENCE) ? 'SHOPEE_KEY_VENCE' : null);
  const vence = envUsado ? _data(e[envUsado]) : null;
  const envChave = String(empresa.loja || empresa.id || '').toUpperCase() + '_SYNC_SHOPEE_PARTNER_KEY';
  const base = { empresa: empresa.id, nome: empresa.nome || empresa.id, env: envEmp || 'SHOPEE_KEY_VENCE', envChave, vence: _br(vence) };
  const pv = prova || {};
  const provaEm = Date.parse(pv.quando || '') || 0;
  if (pv.recusou) return Object.assign(base, { nivel: 'vermelho', tipo: 'recusou', quando: pv.quando || null, motivo: String(pv.recusou).slice(0, 160) });
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

module.exports = { avaliar, montarAlerta, DIAS_AVISO, ARQ_PROVA };
