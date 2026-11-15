'use strict';
/* 15/11 — CONVITE DE PRIMEIRO ACESSO DO PONTO (auditoria do Codex de 15/11, P1 nº 2).

   Antes, quem soubesse o E-MAIL de um funcionário recém-cadastrado (ou recém-resetado pelo gestor) definia a senha dele e
   entrava — a rota pública /ponto/criar-senha só pedia e-mail + senha. Agora a senha só nasce com um CÓDIGO DE CONVITE que o
   gestor recebe na tela ao cadastrar ou resetar, e passa ao funcionário em mãos (o galpão não tem e-mail corporativo por
   pessoa — o canal verificado é o gestor). O código:
     · é de uso ÚNICO: consumido ANTES de a senha ser gravada; o segundo uso é recusado;
     · VENCE em 72 h; vencido, o gestor gera outro (resetar de novo);
     · fica no disco só como HASH (sha256) — quem ler o arquivo não tem o código;
     · é por funcionário: um convite novo substitui o anterior.
   Guardado em disco (o Render tem disco persistente), fora do Supabase do Ponto: não exige mudar a tabela `funcionarios`.
   Gravação atômica (arquivo temporário + rename). */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VALIDADE_MS = 72 * 3600 * 1000;
/* sem 0/O/1/I/L — o código é lido em voz alta ou digitado do papel */
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function normalizar(codigo) {
  return String(codigo || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function hashDe(codigo) {
  return crypto.createHash('sha256').update(normalizar(codigo)).digest('hex');
}
function gerarCodigo() {
  const b = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += ALFABETO[b[i] % ALFABETO.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}

function criar(o) {
  const arquivo = o && o.arquivo;
  if (!arquivo) throw new Error('ponto-convites: falta o arquivo');
  const agora = (o && typeof o.agora === 'function') ? o.agora : () => Date.now();

  function ler() {
    try { const d = JSON.parse(fs.readFileSync(arquivo, 'utf8')); return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {}; }
    catch (e) { return {}; }
  }
  function gravar(d) {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    const tmp = arquivo + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(d, null, 1));
    fs.renameSync(tmp, arquivo);
  }

  /* gera (ou troca) o convite do funcionário; devolve o código EM CLARO uma única vez — é o que o gestor vê na tela */
  function gerar(funcionarioId) {
    const id = String(funcionarioId || '').trim();
    if (!id) throw new Error('ponto-convites: funcionário sem id');
    const codigo = gerarCodigo();
    const d = ler();
    d[id] = { hash: hashDe(codigo), expira: agora() + VALIDADE_MS, criado_em: new Date(agora()).toISOString() };
    gravar(d);
    return { codigo, expira: d[id].expira };
  }

  /* o convite ainda vale? (sem consumir) — pro gestor ver na lista */
  function pendente(funcionarioId) {
    const c = ler()[String(funcionarioId || '')];
    if (!c || !c.hash) return null;
    return { expira: c.expira, vencido: !(Number(c.expira) > agora()) };
  }

  /* confere E consome: só devolve ok quando o código bate e não venceu; o convite sai do disco ANTES de a senha ser gravada.
     Saídas: { ok:true } · { ok:false, motivo:'sem_convite' | 'vencido' | 'nao_confere' | 'sem_codigo' } */
  function consumir(funcionarioId, codigo) {
    const id = String(funcionarioId || '').trim();
    const n = normalizar(codigo);
    if (!n) return { ok: false, motivo: 'sem_codigo' };
    const d = ler();
    const c = d[id];
    if (!c || !c.hash) return { ok: false, motivo: 'sem_convite' };
    if (!(Number(c.expira) > agora())) { delete d[id]; gravar(d); return { ok: false, motivo: 'vencido' }; }
    const esperado = Buffer.from(String(c.hash), 'hex'), recebido = Buffer.from(hashDe(n), 'hex');
    if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) return { ok: false, motivo: 'nao_confere' };
    const expira = Number(c.expira);
    delete d[id]; gravar(d);
    return { ok: true, expira };
  }

  /* desfaz um consumo (a gravação da senha falhou depois): o funcionário não fica sem convite por um erro do banco */
  function devolver(funcionarioId, codigo, expira) {
    const id = String(funcionarioId || '').trim();
    const d = ler();
    d[id] = { hash: hashDe(codigo), expira: Number(expira) || (agora() + VALIDADE_MS), criado_em: new Date(agora()).toISOString(), devolvido: true };
    gravar(d);
  }

  function apagar(funcionarioId) { const d = ler(); if (delete d[String(funcionarioId || '')]) gravar(d); }

  return { gerar, pendente, consumir, devolver, apagar, VALIDADE_MS };
}

module.exports = { criar, normalizar, hashDe, gerarCodigo, VALIDADE_MS, ALFABETO };
