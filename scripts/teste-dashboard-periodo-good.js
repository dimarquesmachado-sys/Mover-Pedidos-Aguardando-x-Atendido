'use strict';
/* 28/10 — o PERÍODO LIVRE e os AVISOS DO SERVIDOR na tela única (as três empresas). Este teste conferia a tela VELHA da
   GOOD (guardada como reserva desde a troca de 14/10, e que saiu agora). A auditoria antes de apagar mostrou que a tela
   única NÃO tinha três coisas que a velha tinha (Codex #551 e #564) — e elas vieram pra tela única, pras três:
   · de/até INVERTIDOS no período livre trocam de verdade (na busca, no estado e nos campos) — antes viravam busca vazia;
   · o servidor lê no máximo 60.000 linhas do período (das mais antigas pras mais novas) e AVISA o corte — a tela agora
     mostra (sem isso, os totais omitiam as vendas mais recentes em silêncio);
   · imposto recalculado e margem reconstruída na leitura viram aviso (o número muda e a tela diz por quê).
   E o que a velha conferia e a única já tinha: o período livre com as duas datas. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require('./_tela-empresa');

for (const emp of ['girassol', 'ambtotal', 'good']) {
  const html = T.telaDaEmpresa(emp);
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  assert.ok(/\['custom','Período…'\]/.test(js), emp + ': sumiu o período livre da lista de períodos');
  assert.ok(/type="date" id="pDe"/.test(js) && /type="date" id="pAte"/.test(js), emp + ': o período livre perdeu os campos de data');
  assert.ok(/else \{ de = pDe; ate = pAte; if\(de > ate\)\{ const t = de; de = ate; ate = t; \} \}/.test(js), emp + ': datas invertidas no período livre não são trocadas na busca');
  assert.ok(/if\(p === 'custom' && pDe && pAte && pDe > pAte\)\{ const t = pDe; pDe = pAte; pAte = t;/.test(js), emp + ': datas invertidas não são trocadas no estado (os campos seguiriam invertidos)');
  assert.ok(/if\(HIST\.truncado\) _av\.push\(/.test(js), emp + ': o aviso de período cortado (60.000 linhas) não chega na tela');
  assert.ok(/Number\(_t\.impostos_recalculados\)>0/.test(js) && /Number\(_t\.margens_reconstruidas\)>0/.test(js), emp + ': os avisos de imposto recalculado / margem reconstruída não chegam na tela');
  /* Codex #761: o aviso vale SÓ pro período que está na tela — mora no render, amarrado ao usaHist (o HIST é do período
     exibido), e só apaga o que ele mesmo escreveu */
  const iU = js.indexOf('const usaHist = !!(HIST && HIST.de===de && HIST.ate===ate && HIST.totais);'), iA = js.indexOf('if(HIST.truncado) _av.push(');
  assert.ok(iU > 0 && iA > iU && iA - iU < 1500 && /if\(usaHist\)\{\s*const _t = HIST\.totais/.test(js.slice(iU, iA)), emp + ': o aviso não está amarrado ao período da tela (usaHist)');
  assert.ok(/else if\(_elA\.dataset\.avisosHist === '1'\)\{ _elA\.innerHTML = ''; _elA\.dataset\.avisosHist = ''; \}/.test(js), emp + ': trocar pra Hoje/Ontem não apaga o aviso do período anterior (ou apaga o que não é dele)');
  assert.ok(js.indexOf('if(d.truncado) _av.push(') < 0, emp + ': sobrou o aviso no carregarHistorico (não sabe qual período está na tela)');
}
/* Codex #761 — o cenário de verdade, rodando o BLOCO DE PRODUÇÃO (recortado da tela): período longo cortado → aviso;
   trocou pra Hoje (o HIST não é do período da tela) → o aviso SOME; o "carregando"/falha de outro dono NÃO é apagado */
{
  const html = T.telaDaEmpresa('good');
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const i0 = js.indexOf("    const _elA = document.getElementById('histAviso');");
  const i1 = js.indexOf('  }catch(eAv){}', i0);
  assert.ok(i0 > 0 && i1 > i0, 'não achei o bloco dos avisos no render');
  const bloco = new Function('usaHist', 'HIST', 'document', 'N', js.slice(i0, i1));
  const el = { innerHTML: '', dataset: {} };
  const doc = { getElementById: (id) => (id === 'histAviso' ? el : null) };
  const N = (v) => String(v);
  const HIST = { de: '2026-01-01', ate: '2026-10-28', truncado: true, totais: { impostos_recalculados: 3 } };
  bloco(true, HIST, doc, N);
  assert.ok(/período grande demais/.test(el.innerHTML) && /3 imposto/.test(el.innerHTML), 'período cortado não avisou: ' + el.innerHTML);
  bloco(false, HIST, doc, N);   /* trocou pra Hoje: o HIST não é do período da tela */
  assert.strictEqual(el.innerHTML, '', 'o aviso do período anterior ficou na tela de Hoje');
  el.innerHTML = '⏳ carregando o histórico...'; el.dataset.avisosHist = '';
  bloco(false, HIST, doc, N);
  assert.ok(/carregando/.test(el.innerHTML), 'o bloco apagou o "carregando" de quem busca o histórico');
}
const srv = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'historico.js'), 'utf8');
assert.ok(/truncado: offset >= 60000/.test(srv), 'o servidor não sinaliza o corte de 60.000 linhas');
console.log('OK: período livre e avisos do servidor na tela única das três (datas invertidas trocam; corte de 60.000 avisa)');
