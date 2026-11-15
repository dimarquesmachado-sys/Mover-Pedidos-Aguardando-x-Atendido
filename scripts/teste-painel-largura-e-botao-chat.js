'use strict';
/* 14/11 — O BOTÃO DO CHAT NÃO FICA EM CIMA DOS BOTÕES LATERAIS, E O DASHBOARD MAIS LARGO NÃO MEXE NO CELULAR.

   O dono: "PERGUNTE AO CLAUDE, tá em cima dos botões laterais no canto direito da página. Arrumar. E mais, deixa a
   largura do dashboard maior, tá estreita… pelo menos uns 2 cm pra cada lado. Atenção se mudar algo pra não prejudicar
   o layout do celular."

   Medido num navegador de verdade (Chromium, o dashboard servido pelas rotas reais da AMB), antes × depois:
     tela 1920   conteúdo 1720 → 1882 px     botão em cima dos laterais: sim → não
     tela 2560   conteúdo 1720 → 1920 px                                 sim → não
     tela 1366   conteúdo 1311 → 1334 px                                 sim → não
     tablet 1024 conteúdo  983 →  983 px (igual)                         sim → não
     celular 390 conteúdo  374 →  374 px (igual)                         sim → não
     celular 360 conteúdo  344 →  344 px (igual)                         sim → não

   Este teste roda na bateria (sem navegador) e prende as DUAS pontas, lendo os arquivos de produção:
     · a coluna de botões laterais (#navCards) mora no CSS do dashboard; o botão do chat, na peça do chat. São dois
       arquivos: mudar um sem o outro põe um em cima do outro de novo. Aqui a geometria dos dois é conferida junta, no
       computador e no celular;
     · a posição do botão tem que estar na FOLHA DE ESTILO da peça — se voltar pro `style` do botão, a regra do celular
       deixa de valer (style ganha da folha);
     · a largura nova só vale de 1100 px pra cima: a regra de sempre continua lá, intacta, e nenhuma regra de tela
       pequena do dashboard alcança essa faixa. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let _chegouAoFim = false;
process.on('exit', (code) => { if (!_chegouAoFim && code === 0) { console.error('FALHOU: o teste acabou SEM chegar ao fim'); process.exitCode = 1; } });

const raiz = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(raiz, 'lib/checkout/painel/dashboard.html'), 'utf8');
const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
const { scriptDoChatAnalise, POSICAO_DO_BOTAO } = require('../lib/checkout/painel-chat-analise');

/* ── o CSS do dashboard, separado em "fora de @media" e "dentro de cada @media" ── */
function blocosDeMidia(txt) {
  const blocos = []; let fora = ''; let i = 0;
  while (i < txt.length) {
    const m = /@media\s*\(([^)]*)\)\s*\{/g; m.lastIndex = i;
    const r = m.exec(txt);
    if (!r) { fora += txt.slice(i); break; }
    fora += txt.slice(i, r.index);
    let nivel = 1, j = m.lastIndex;
    while (j < txt.length && nivel > 0) { if (txt[j] === '{') nivel++; else if (txt[j] === '}') nivel--; j++; }
    assert.strictEqual(nivel, 0, 'o CSS do dashboard tem um @media que não fecha');
    blocos.push({ condicao: r[1].replace(/\s+/g, ''), corpo: txt.slice(m.lastIndex, j - 1) });
    i = j;
  }
  return { fora, blocos };
}
const semComentario = css.replace(/\/\*[\s\S]*?\*\//g, '');
const { fora, blocos } = blocosDeMidia(semComentario);
/* a declaração de um seletor EXATO num trecho de CSS (a última vence, como no navegador) */
function regra(trecho, seletor) {
  const re = new RegExp('(?:^|[}\\s,])' + seletor.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
  let m, ult = null; while ((m = re.exec(trecho))) ult = m[1];
  return ult;
}
const px = (decl, prop) => { const m = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*(\\d+)px').exec(decl || ''); return m ? Number(m[1]) : null; };

/* ═══ 1. o botão do chat × os botões laterais ═══ */
{
  /* os laterais, no computador e no celular (a regra do celular fica num @media(max-width:…)) */
  const navPC = regra(fora, '#navCards'), navBtPC = regra(fora, '#navCards button');
  assert.ok(navPC && /position:fixed/.test(navPC), 'não achei a regra do #navCards no dashboard');
  const pc = { right: px(navPC, 'right'), bottom: px(navPC, 'bottom'), largura: px(navBtPC, 'width') };
  assert.ok(pc.right != null && pc.bottom != null && pc.largura != null, 'não consegui ler a posição/largura do #navCards: ' + JSON.stringify(pc));
  const midiaCel = blocos.filter((b) => /^max-width:\d+px$/.test(b.condicao) && regra(b.corpo, '#navCards'));
  assert.strictEqual(midiaCel.length, 1, 'esperava UMA regra de tela pequena pro #navCards (achei ' + midiaCel.length + ')');
  const corteCel = Number(/\d+/.exec(midiaCel[0].condicao)[0]);
  const navCel = regra(midiaCel[0].corpo, '#navCards'), navBtCel = regra(midiaCel[0].corpo, '#navCards button');
  const cel = { right: px(navCel, 'right') != null ? px(navCel, 'right') : pc.right, bottom: px(navCel, 'bottom') != null ? px(navCel, 'bottom') : pc.bottom,
    largura: px(navBtCel, 'width') != null ? px(navBtCel, 'width') : pc.largura };

  /* o botão: a peça de produção rodando num documento mínimo — o que ela CRIA é o que vale */
  const criados = {};
  const no = (tag) => ({ tag, style: { cssText: '' }, filhos: [], textContent: '', appendChild(f) { this.filhos.push(f); return f; }, addEventListener() {}, set id(v) { this._id = v; criados[v] = this; }, get id() { return this._id; } });
  const aqui = no('div');
  const documento = { getElementById: (i) => (i === 'chatAnaliseAqui' ? aqui : null), createElement: no };
  new Function('document', 'window', scriptDoChatAnalise('/amb-checkout-offline'))(documento, { location: { search: '' } });
  const botao = criados.chatAnaliseBotao, estilo = criados.chatAnaliseEstilo;
  assert.ok(botao && estilo && estilo.tag === 'style', 'a peça não criou o botão e a folha de estilo da posição dele');
  assert.ok(aqui.filhos.includes(estilo) && aqui.filhos.includes(botao), 'a folha de estilo e o botão têm que ir pro espaço da peça');
  assert.ok(/position:fixed/.test(botao.style.cssText), 'o botão deixou de ser flutuante');
  assert.ok(!/(^|;)\s*(right|bottom|left|top)\s*:/.test(botao.style.cssText), 'a posição do botão voltou pro `style` dele (' + botao.style.cssText.slice(0, 60) + '…): o style ganha da folha de estilo, e a regra do celular deixa de valer');

  /* a folha de estilo: uma regra geral e uma de tela pequena, com os números da peça */
  const fe = blocosDeMidia(estilo.textContent);
  const bPC = regra(fe.fora, '#chatAnaliseBotao');
  assert.strictEqual(fe.blocos.length, 1, 'a folha de estilo do botão tem que ter UMA regra de tela pequena');
  const bCel = regra(fe.blocos[0].corpo, '#chatAnaliseBotao');
  const B = { pc: { right: px(bPC, 'right'), bottom: px(bPC, 'bottom') }, cel: { right: px(bCel, 'right'), bottom: px(bCel, 'bottom') } };
  assert.deepStrictEqual(B.pc, POSICAO_DO_BOTAO.computador, 'a folha de estilo do botão não saiu com a posição da peça (computador)');
  assert.deepStrictEqual(B.cel, POSICAO_DO_BOTAO.celular, 'a folha de estilo do botão não saiu com a posição da peça (celular)');
  assert.strictEqual(fe.blocos[0].condicao, 'max-width:' + POSICAO_DO_BOTAO.celular_ate + 'px');
  /* o corte "é celular" do botão é o MESMO do dashboard pros laterais — cortes diferentes deixam uma faixa de largura em
     que um já mudou de lugar e o outro não */
  assert.strictEqual(POSICAO_DO_BOTAO.celular_ate, corteCel, 'o botão do chat muda de posição em ' + POSICAO_DO_BOTAO.celular_ate + 'px e os botões laterais em ' + corteCel + 'px: entre os dois cortes um fica em cima do outro');

  /* a geometria: o botão fica À ESQUERDA da coluna, com folga, e na mesma altura dela */
  const FOLGA_MIN = 8;
  for (const [onde, nav, b] of [['computador', pc, B.pc], ['celular', cel, B.cel]]) {
    const bordaEsquerdaDaColuna = nav.right + nav.largura;   /* distância, a partir da direita da janela, até o lado esquerdo da coluna */
    assert.ok(b.right >= bordaEsquerdaDaColuna + FOLGA_MIN, onde + ': o botão do chat (a ' + b.right + 'px da direita) fica em cima dos botões laterais (que vão de ' + nav.right + ' a ' + bordaEsquerdaDaColuna + 'px) — precisa de pelo menos ' + (bordaEsquerdaDaColuna + FOLGA_MIN));
    assert.ok(b.right <= bordaEsquerdaDaColuna + 24, onde + ': o botão do chat ficou longe demais da coluna (' + b.right + 'px)');
    assert.strictEqual(b.bottom, nav.bottom, onde + ': o botão do chat e a coluna de botões laterais não estão na mesma altura');
  }
  /* no celular o botão ainda cabe inteiro na menor tela comum (320 px): ~200 px de botão + a distância da direita */
  assert.ok(B.cel.right + 200 <= 320, 'no celular o botão do chat sai pela esquerda da tela');
}

/* ═══ 2. a largura do dashboard ═══ */
{
  const maxW = (decl) => { const m = /max-width\s*:\s*min\((\d+)px\s*,\s*(\d+)vw\)/.exec(decl || ''); return m ? { teto: Number(m[1]), vw: Number(m[2]) } : null; };
  /* a regra de SEMPRE continua lá, igual, pras duas faixas (conteúdo e cabeçalho) */
  const base = { wrap: maxW(regra(fora, '.wrap')), hrow: maxW(regra(fora, '.hrow')) };
  assert.deepStrictEqual(base, { wrap: { teto: 1720, vw: 96 }, hrow: { teto: 1720, vw: 96 } }, 'a regra de largura de sempre (a que vale no celular e no tablet) foi mexida: ' + JSON.stringify(base));
  /* a largura nova: UMA regra, só pra tela larga, valendo pro conteúdo E pro cabeçalho (senão um fica mais largo que o outro) */
  /* (toda regra de @media cujo seletor inclui .wrap ou .hrow E que declara max-width — a do celular que só muda o
     espaçamento do cabeçalho não conta) */
  const mexeNaLargura = (corpo) => { const re = /([^{}]+)\{([^}]*)\}/g; let m; while ((m = re.exec(corpo))) { if (m[1].split(',').some((x) => /^\.(wrap|hrow)$/.test(x.trim())) && /max-width\s*:/.test(m[2])) return true; } return false; };
  const largas = blocos.filter((b) => mexeNaLargura(b.corpo));
  assert.strictEqual(largas.length, 1, 'esperava UMA regra de @media mexendo na largura do dashboard (achei ' + largas.length + ')');
  /* e fora de @media só as duas de sempre (uma 3ª regra de largura mais abaixo venceria a de sempre no celular) */
  assert.strictEqual((fora.match(/(?:^|[}\s,])\.(?:wrap|hrow)\s*(?:,[^{]*)?\{[^}]*max-width/g) || []).length, 2, 'apareceu outra regra de largura do dashboard fora de @media');
  const mm = /^min-width:(\d+)px$/.exec(largas[0].condicao);
  assert.ok(mm, 'a largura nova tem que valer só de uma largura mínima pra cima (achei @media(' + largas[0].condicao + '))');
  const aPartirDe = Number(mm[1]);
  const novaTxt = /\.wrap\s*,\s*\.hrow\s*\{([^}]*)\}/.exec(largas[0].corpo);
  assert.ok(novaTxt, 'a largura nova tem que valer pro conteúdo (.wrap) e pro cabeçalho (.hrow) juntos');
  const nova = maxW(novaTxt[1]);
  assert.ok(nova && nova.teto > base.wrap.teto && nova.vw >= base.wrap.vw && nova.vw <= 100, 'a regra de tela larga não alarga: ' + JSON.stringify(nova));

  /* não alcança celular nem tablet: começa ACIMA de toda regra de tela pequena do dashboard */
  const cortesPequenos = blocos.map((b) => /^max-width:(\d+)px$/.exec(b.condicao)).filter(Boolean).map((m) => Number(m[1]));
  assert.ok(cortesPequenos.length >= 2, 'não achei as regras de tela pequena do dashboard');
  assert.ok(aPartirDe > Math.max(...cortesPequenos), 'a largura nova começa em ' + aPartirDe + 'px, dentro da faixa das regras de tela pequena (até ' + Math.max(...cortesPequenos) + 'px)');
  assert.ok(aPartirDe >= 1100, 'a largura nova começa em ' + aPartirDe + 'px: tablet deitado (1024) entraria');

  /* a conta que o navegador faz: largura = min(teto, vw% da janela, o que sobra dentro do body) */
  const respiroBody = (janela) => (janela <= 720 ? 8 : 16) * 2;   /* body{padding:0 16px}; até 720px, 0 8px */
  const larguraCom = (r, janela, barra) => Math.min(r.teto, (r.vw / 100) * janela, janela - barra - respiroBody(janela));
  const largura = (janela, barra) => larguraCom(janela >= aPartirDe ? nova : base.wrap, janela, barra);
  /* celular e tablet: IDÊNTICO ao que era */
  for (const janela of [320, 360, 390, 414, 720, 768, 860, 1024, aPartirDe - 1]) {
    assert.strictEqual(largura(janela, 0), larguraCom(base.wrap, janela, 0), 'a largura do dashboard mudou numa tela de ' + janela + 'px — celular/tablet não podiam mudar');
  }
  /* o pedido: "pelo menos uns 2 cm pra cada lado" — 2 cm são 75,6 px de CSS; numa janela Full HD com barra de rolagem */
  const ganhoFHD = (largura(1920, 15) - larguraCom(base.wrap, 1920, 15)) / 2;
  assert.ok(ganhoFHD >= 75, 'em Full HD o dashboard ganhou só ' + ganhoFHD.toFixed(1) + 'px de cada lado (2 cm = 75,6 px)');
  const ganho2560 = (largura(2560, 15) - larguraCom(base.wrap, 2560, 15)) / 2;
  assert.ok(ganho2560 >= 75, 'numa tela de 2560px o dashboard ganhou só ' + ganho2560.toFixed(1) + 'px de cada lado');
  /* nunca fica MAIS estreito do que era, em tela nenhuma */
  for (let janela = 320; janela <= 3840; janela += 20) assert.ok(largura(janela, 15) >= larguraCom(base.wrap, janela, 15) - 1e-9, 'a ' + janela + 'px o dashboard ficou mais estreito do que era');
}

/* ═══ 3. o dashboard carrega a versão nova da peça (o navegador não pode ficar com a antiga em cache) ═══ */
assert.ok(html.includes("['caScript', 'chat-analise', '?v=2']"), 'o dashboard não pede a versão nova do script do chat');

_chegouAoFim = true;
console.log('ok — o botão do chat fica ao lado dos botões laterais (computador e celular) e o dashboard mais largo não muda celular nem tablet');
