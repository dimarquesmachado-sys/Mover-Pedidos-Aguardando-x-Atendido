'use strict';
// 13/10 — a FABRICA FISCAL (F1 expediente a cada 3 min, F2, Corrigir-NFs a cada 5 min, F3 NF->ML a cada 10 min, das
// 3 empresas) chamava o Bling SEM pedir a vez ao porteiro: o /girassol/porteiro mostrou 8 avisos de 429 "com o porteiro
// folgado" no horario do galpao — a conta estourando por consumo de fora dele. Agora cada chamada da fabrica pede a vez
// como OPERACAO (e o pipeline do galpao: move pedido, emite e manda NF), no mesmo processo (sem HTTP), com o nome da
// rotina que esta rodando (ex.: girassol.expediente) — e avisa ok/429 com a ficha.
// Nunca segura uma chamada mais de 20 s (operacao nao espera rotina): passou disso, segue (falha aberta). Porteiro fora
// do ar (excecao) -> segue na hora, no ritmo local de sempre.
const { contexto } = require('../checkout/contexto-fundo');

function criarPorteiroFiscal(rotulo, opcoes) {
  const o = opcoes || {};
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const agora = o.agora || (() => Date.now());
  const P = () => { try { return require('../../bling-ritmo')._interno; } catch (e) { return null; } };
  const conta = () => { const p = P(); return p ? p.contaCanonica(String(rotulo || '').toLowerCase()) : null; };
  const servico = () => { const st = contexto.getStore(); return (st && st.servico) || (String(rotulo || 'fiscal').toLowerCase() + '.fiscal'); };

  // devolve a FICHA (ou null); nunca lanca
  async function vez() {
    const p = P(); const c = conta(); if (!p || !c) return null;
    const nome = servico();
    const ate = agora() + 20000;
    while (agora() < ate) {
      let r; try { r = p.permissao(c, 'operacao', nome); } catch (e) { return null; }
      if (r && r.ok) return r.ficha || null;
      const ms = (r && (r.esperar_ms || (r.pausa_s ? r.pausa_s * 1000 : 0))) || 300;
      await sleep(Math.min(Math.max(ms, 50), 2000));
    }
    return null;
  }
  function ok(ficha) {
    if (!ficha) return;
    const p = P(); const c = conta(); if (!p || !c) return;
    try { p.avisoOk(c, ficha); } catch (e) { /* aviso nunca atrapalha */ }
  }
  function aviso429(ficha, resp) {
    const p = P(); const c = conta(); if (!p || !c) return;
    const ra = resp && resp.headers && resp.headers.get ? resp.headers.get('retry-after') : '';
    try { p.aviso429(c, ra || '', 'operacao', servico(), ficha || undefined); } catch (e) { /* idem */ }
  }
  // um passo so pros fetch soltos: pede a vez, chama, avisa
  async function chamar(fn) {
    const ficha = await vez();
    const resp = await fn();
    if (resp && resp.status === 429) aviso429(ficha, resp);
    else if (resp && resp.status >= 200 && resp.status < 300) ok(ficha);
    return resp;
  }
  return { vez, ok, aviso429, chamar };
}

module.exports = { criarPorteiroFiscal };
