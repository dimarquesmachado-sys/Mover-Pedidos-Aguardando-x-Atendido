'use strict';
/* 14/11 — O BOTÃO DO CHAT É O 4º QUADRADINHO DA COLUNA LATERAL, E O DASHBOARD MAIS LARGO NÃO MEXE NO CELULAR.

   O dono, em dois pedidos no mesmo dia:
   1. "PERGUNTE AO CLAUDE, tá em cima dos botões laterais no canto direito da página. Arrumar. E mais, deixa a largura do
      dashboard maior… pelo menos uns 2 cm pra cada lado. Atenção se mudar algo pra não prejudicar o layout do celular."
   2. "o Perguntar ao Claude, deixa só acima ali dos botões 3 que já tem na lateral, deixa quadradinho e só o balãozinho
      de conversa branco e ele azulzinho em volta. Aí fica no mesmo layout dos outros 3 que já existem ali."

   Medido num navegador de verdade (Chromium, o dashboard servido pelas rotas reais da AMB):
     · o botão entra na coluna ▲ ⌂ ▼ como o 1º de cima, com o MESMO tamanho dos outros (38×34 no computador, 42×38 no
       celular) e o mesmo espaço entre eles (6 px / 5 px); azul (#2563eb) com o balão branco; clicar abre a conversa,
       fechar devolve o botão pra coluna;
     · largura do conteúdo: tela 1920 1720 → 1882 px · 2560 1720 → 1920 · tablet 1024 e celular 390/360 iguais.
   17/11, o dono de novo: "aumenta toda paginação do dashboard, dá pra ficar mais 1cm esquerda e direita mais ou menos, até
   encostar naqueles botões de atalho rápido (IA, ir pra cima, pra baixo, home)". Na tela grande o teto de 1920 deixava a
   faixa vazia entre o conteúdo e a coluna. Medido no Chromium: 2194 (4K a 175%) 1920 → 2066 · 2560 1920 → 2432 — a 12 px
   da coluna (sem barra de rolagem; com a barra de 15 px, ~4 px); Full HD, tablet e celular iguais.

   Este teste roda na bateria (sem navegador) e prende as pontas, lendo os arquivos de produção:
     · a peça do chat ENCAIXA o botão dentro da coluna (#navCards), em cima dos três — rodando a peça de produção num
       documento de mentira, com a coluna já lá, com a coluna chegando depois e sem coluna nenhuma;
     · todo o visual do botão está na FOLHA DE ESTILO da peça (nada no `style` dele), e a regra de dentro da coluna NÃO
       declara largura nem altura — senão passa por cima do tamanho que a coluna dá aos botões dela (foi o que aconteceu
       na 1ª tentativa: o botão saiu com 20 px de altura);
     · a posição de RESERVA (enquanto a coluna não existe) é o mesmo lugar em que o botão fica dentro dela — conferido
       contra o CSS do dashboard, no computador e no celular;
     · a largura nova só vale de 1100 px pra cima: a regra de sempre continua lá, intacta. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let _chegouAoFim = false;
process.on('exit', (code) => { if (!_chegouAoFim && code === 0) { console.error('FALHOU: o teste acabou SEM chegar ao fim'); process.exitCode = 1; } });

const raiz = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(raiz, 'lib/checkout/painel/dashboard.html'), 'utf8');
const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
const { scriptDoChatAnalise, POSICAO_DO_BOTAO, BALAO } = require('../lib/checkout/painel-chat-analise');

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
  /* o seletor INTEIRO: começa no início do trecho, depois de uma regra ou de uma vírgula — "#x" não casa com "#y #x" */
  const re = new RegExp('(?:^|[},])\\s*' + seletor.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
  let m, ult = null; while ((m = re.exec(trecho))) ult = m[1];
  return ult;
}
const px = (decl, prop) => { const m = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*(\\d+)px').exec(decl || ''); return m ? Number(m[1]) : null; };

/* ═══ 1. o botão do chat dentro da coluna lateral ═══ */
{
  /* ── a coluna, como o dashboard a desenha: no computador e no celular ── */
  const navPC = regra(fora, '#navCards'), navBtPC = regra(fora, '#navCards button'), topoPC = regra(fora, '#navCards button.topo');
  assert.ok(navPC && /position:fixed/.test(navPC) && /flex-direction:column/.test(navPC), 'não achei a coluna #navCards no dashboard');
  const pc = { right: px(navPC, 'right'), bottom: px(navPC, 'bottom'), espaco: px(navPC, 'gap'), largura: px(navBtPC, 'width'), altura: px(navBtPC, 'height'), alturaTopo: px(topoPC, 'height') };
  assert.ok(Object.values(pc).every((v) => v != null), 'não consegui ler a coluna do dashboard: ' + JSON.stringify(pc));
  const midiaCel = blocos.filter((b) => /^max-width:\d+px$/.test(b.condicao) && regra(b.corpo, '#navCards'));
  assert.strictEqual(midiaCel.length, 1, 'esperava UMA regra de tela pequena pro #navCards (achei ' + midiaCel.length + ')');
  const corteCel = Number(/\d+/.exec(midiaCel[0].condicao)[0]);
  const ou = (v, padrao) => (v != null ? v : padrao);
  const navCel = regra(midiaCel[0].corpo, '#navCards'), navBtCel = regra(midiaCel[0].corpo, '#navCards button'), topoCel = regra(midiaCel[0].corpo, '#navCards button.topo');
  const cel = { right: ou(px(navCel, 'right'), pc.right), bottom: ou(px(navCel, 'bottom'), pc.bottom), espaco: ou(px(navCel, 'gap'), pc.espaco),
    largura: ou(px(navBtCel, 'width'), pc.largura), altura: ou(px(navBtCel, 'height'), pc.altura), alturaTopo: ou(px(topoCel, 'height'), pc.alturaTopo) };
  /* os três botões que a coluna já tem: ▲, ⌂ (o do topo, mais baixo) e ▼ */
  const montagem = /function montarNavCards\(\)\{[\s\S]*?document\.body\.appendChild\(d\);/.exec(html);
  assert.ok(montagem, 'não achei a montagem da coluna no dashboard');
  assert.deepStrictEqual([(montagem[0].match(/<button /g) || []).length, (montagem[0].match(/class="topo"/g) || []).length], [3, 1], 'a coluna do dashboard não tem mais os 3 botões (▲ ⌂ ▼) que a conta da reserva supõe');

  /* ── um documento de mentira, só com o que a peça usa ── */
  function documento(comColuna) {
    const porId = {}; const relogio = [];
    const no = (tag) => ({ tag, style: { cssText: '', display: '' }, filhos: [], textContent: '', innerHTML: '', attrs: {}, pai: null, ouvintes: {},
      appendChild(f) { if (f.pai) f.pai.filhos = f.pai.filhos.filter((x) => x !== f); this.filhos.push(f); f.pai = this; return f; },
      insertBefore(f, ref) { if (f.pai) f.pai.filhos = f.pai.filhos.filter((x) => x !== f); const k = ref ? this.filhos.indexOf(ref) : -1; if (k < 0) this.filhos.push(f); else this.filhos.splice(k, 0, f); f.pai = this; return f; },
      get parentNode() { return this.pai; }, get firstChild() { return this.filhos[0] || null; },
      setAttribute(k, v) { this.attrs[k] = String(v); }, addEventListener(n, f) { this.ouvintes[n] = f; }, focus() {},
      set id(v) { this._id = v; porId[v] = this; }, get id() { return this._id; } });
    const aqui = no('div'); aqui.id = 'chatAnaliseAqui';
    const porColuna = () => { const nav = no('div'); nav.id = 'navCards'; for (const t of ['▲', '⌂', '▼']) { const b = no('button'); b.textContent = t; nav.appendChild(b); } return nav; };
    if (comColuna) porColuna();
    const doc = { getElementById: (i) => porId[i] || null, createElement: no };
    const rodar = () => new Function('document', 'window', 'setTimeout', 'fetch', scriptDoChatAnalise('/amb-checkout-offline'))(doc, { location: { search: '' } }, (f, ms) => { relogio.push({ f, ms }); }, () => new Promise(() => {}));
    const andar = (n) => { for (let i = 0; i < n && relogio.length; i++) relogio.shift().f(); };
    return { porId, aqui, rodar, relogio, andar, porColuna };
  }

  /* A. a coluna já existe (o caso de produção: o dashboard monta a coluna antes de pedir a peça) */
  {
    const D = documento(true); D.rodar();
    const nav = D.porId.navCards, botao = D.porId.chatAnaliseBotao, estilo = D.porId.chatAnaliseEstilo, painel = D.porId.chatAnalisePainel;
    assert.ok(botao && estilo && painel && estilo.tag === 'style', 'a peça não criou o botão, a folha de estilo e o painel');
    assert.strictEqual(nav.filhos[0], botao, 'o botão do chat tem que ser o PRIMEIRO da coluna (em cima do ▲)');
    assert.deepStrictEqual(nav.filhos.slice(1).map((b) => b.textContent), ['▲', '⌂', '▼'], 'os três botões da coluna têm que continuar lá, na mesma ordem');
    assert.ok(!D.aqui.filhos.includes(botao) && D.aqui.filhos.includes(estilo) && D.aqui.filhos.includes(painel), 'a folha de estilo e o painel ficam no espaço da peça; o botão, só na coluna');
    assert.strictEqual(D.relogio.length, 0, 'com a coluna já lá não há o que tentar de novo');
    /* quadradinho, só o balão branco: nada de texto, nada no style do botão */
    assert.strictEqual(botao.style.cssText, '', 'o botão voltou a ter visual no `style` dele (' + botao.style.cssText.slice(0, 60) + '): o style ganha da folha de estilo e ele sai do layout da coluna');
    assert.deepStrictEqual([botao.innerHTML, botao.textContent], [BALAO, ''], 'o botão é só o balão');
    assert.ok(/^<svg [^>]*aria-hidden="true"[^>]*><path fill="#fff" d="[^"]+"\/><\/svg>$/.test(BALAO), 'o balão tem que ser um desenho BRANCO');
    assert.ok(/Perguntar ao Claude/.test(botao.title) && /Perguntar ao Claude/.test(botao.attrs['aria-label'] || ''), 'sem texto no botão, o nome dele vai no title e no aria-label');
    /* clicar abre a conversa e some com o botão; fechar devolve — e ele continua na coluna */
    botao.onclick();
    assert.deepStrictEqual([painel.style.display, botao.style.display], ['flex', 'none']);
    painel.filhos[0].filhos.find((x) => x.title === 'Fechar').onclick();
    assert.deepStrictEqual([painel.style.display, botao.style.display, botao.pai === nav, nav.filhos[0] === botao], ['none', '', true, true]);
    /* o dashboard injeta a peça de novo a cada troca de período: nada duplica */
    D.rodar();
    assert.deepStrictEqual([nav.filhos.length, nav.filhos.filter((x) => x.id === 'chatAnaliseBotao').length, D.aqui.filhos.length], [4, 1, 2], 'injetar a peça de novo criou outro botão');
  }
  /* B. a coluna chega DEPOIS: o botão nasce na reserva e muda pra coluna quando ela aparece */
  {
    const D = documento(false); D.rodar();
    const botao = D.porId.chatAnaliseBotao;
    assert.ok(D.aqui.filhos.includes(botao), 'sem a coluna, o botão fica na reserva (no espaço da peça)');
    assert.strictEqual(D.relogio.length, 1, 'sem a coluna, a peça tem que tentar de novo');
    D.andar(3);
    assert.ok(D.aqui.filhos.includes(botao) && D.relogio.length === 1 && D.relogio[0].ms <= 500, 'enquanto a coluna não chega, segue tentando');
    const nav = D.porColuna();
    D.andar(1);
    assert.ok(nav.filhos[0] === botao && nav.filhos.length === 4 && !D.aqui.filhos.includes(botao), 'a coluna chegou e o botão não foi pra cima dela');
    assert.strictEqual(D.relogio.length, 0, 'encaixou: para de tentar');
  }
  /* C. a coluna nunca chega: fica na reserva e DESISTE de tentar (não fica um relógio rodando pra sempre) */
  {
    const D = documento(false); D.rodar();
    let voltas = 0; while (D.relogio.length && voltas < 500) { D.andar(1); voltas++; }
    assert.ok(voltas >= 10 && voltas <= 60, 'a peça tentou ' + voltas + ' vezes: tem que tentar por alguns segundos e desistir');
    assert.ok(D.aqui.filhos.includes(D.porId.chatAnaliseBotao));
  }

  /* ── a folha de estilo ── */
  const D0 = documento(true); D0.rodar();
  const folha = D0.porId.chatAnaliseEstilo.textContent;
  const fe = blocosDeMidia(folha);
  const reserva = regra(fe.fora, '#chatAnaliseBotao');
  assert.ok(reserva && /position:fixed/.test(reserva) && /background:#2563eb/.test(reserva) && /border-radius:9px/.test(reserva), 'a reserva tem que ser o quadradinho azul flutuante');
  assert.strictEqual(fe.blocos.length, 1, 'a folha de estilo do botão tem que ter UMA regra de tela pequena');
  const reservaCel = regra(fe.blocos[0].corpo, '#chatAnaliseBotao');
  const lida = (d) => ({ right: px(d, 'right'), bottom: px(d, 'bottom'), largura: px(d, 'width'), altura: px(d, 'height') });
  assert.deepStrictEqual([lida(reserva), lida(reservaCel), fe.blocos[0].condicao], [POSICAO_DO_BOTAO.computador, POSICAO_DO_BOTAO.celular, 'max-width:' + POSICAO_DO_BOTAO.celular_ate + 'px'], 'a folha de estilo não saiu com a reserva da peça');
  assert.strictEqual(POSICAO_DO_BOTAO.celular_ate, corteCel, 'a reserva do botão muda em ' + POSICAO_DO_BOTAO.celular_ate + 'px e a coluna em ' + corteCel + 'px');
  /* dentro da coluna: entra na fila (sai do "fixo"), azul — e SEM largura nem altura (quem dá o tamanho é a coluna) */
  const naColuna = regra(fe.fora, '#navCards #chatAnaliseBotao');
  assert.ok(naColuna && /position:static/.test(naColuna) && /background:#2563eb/.test(naColuna), 'falta a regra do botão DENTRO da coluna (posição da fila, azul)');
  assert.ok(!/(^|;)\s*(width|height|min-width|min-height|max-width|max-height|margin[a-z-]*|flex[a-z-]*|font-size)\s*:/.test(naColuna), 'a regra de dentro da coluna declara tamanho/espaço (' + naColuna + '): ela passa por cima do que a coluna dá aos botões e o botão sai diferente dos outros três');
  assert.ok(!/(^|;)\s*display\s*:/.test(reserva + ';' + naColuna), 'a folha de estilo não pode fixar o `display` do botão: abrir a conversa esconde o botão pelo style');

  /* ── a reserva é o MESMO lugar em que o botão fica dentro da coluna ── */
  for (const [onde, c, r] of [['computador', pc, POSICAO_DO_BOTAO.computador], ['celular', cel, POSICAO_DO_BOTAO.celular]]) {
    const alturaDosTres = 2 * c.altura + c.alturaTopo + 2 * c.espaco;
    assert.deepStrictEqual(r, { right: c.right, bottom: c.bottom + alturaDosTres + c.espaco, largura: c.largura, altura: c.altura },
      onde + ': a reserva do botão do chat não é o lugar do 4º botão da coluna (a coluna do dashboard: ' + JSON.stringify(c) + ')');
  }
}

/* ═══ 2. a largura do dashboard ═══ */
{
  const maxW = (decl) => { const m = /max-width\s*:\s*min\((\d+)px\s*,\s*(\d+)vw\)/.exec(decl || ''); return m ? { teto: Number(m[1]), vw: Number(m[2]) } : null; };
  /* 17/11: a regra da tela larga é `max(min(TETO, VW), calc(100vw - FOLGA))` — a de antes OU a janela menos a folga das
     duas laterais (a coluna de botões), a que for MAIOR */
  const maxWLarga = (decl) => { const m = /max-width\s*:\s*max\(\s*min\((\d+)px\s*,\s*(\d+)vw\)\s*,\s*calc\(100vw\s*-\s*(\d+)px\)\s*\)/.exec(decl || ''); return m ? { teto: Number(m[1]), vw: Number(m[2]), folga: Number(m[3]) } : null; };
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
  const nova = maxWLarga(novaTxt[1]);
  assert.ok(nova && nova.teto > base.wrap.teto && nova.vw >= base.wrap.vw && nova.vw <= 100 && nova.folga > 0, 'a regra de tela larga não alarga: ' + JSON.stringify(nova) + ' ← ' + novaTxt[1]);

  /* não alcança celular nem tablet: começa ACIMA de toda regra de tela pequena do dashboard */
  const cortesPequenos = blocos.map((b) => /^max-width:(\d+)px$/.exec(b.condicao)).filter(Boolean).map((m) => Number(m[1]));
  assert.ok(cortesPequenos.length >= 2, 'não achei as regras de tela pequena do dashboard');
  assert.ok(aPartirDe > Math.max(...cortesPequenos), 'a largura nova começa em ' + aPartirDe + 'px, dentro da faixa das regras de tela pequena (até ' + Math.max(...cortesPequenos) + 'px)');
  assert.ok(aPartirDe >= 1100, 'a largura nova começa em ' + aPartirDe + 'px: tablet deitado (1024) entraria');

  /* a conta que o navegador faz: largura = min(teto, vw% da janela, o que sobra dentro do body) */
  const respiroBody = (janela) => (janela <= 720 ? 8 : 16) * 2;   /* body{padding:0 16px}; até 720px, 0 8px */
  const larguraCom = (r, janela, barra) => Math.min(Math.max(Math.min(r.teto, (r.vw / 100) * janela), r.folga != null ? janela - r.folga : 0), janela - barra - respiroBody(janela));
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
  /* 17/11 — "até encostar naqueles botões": na tela em que a regra de antes (o teto de 1920) deixava faixa vazia, a borda do
     conteúdo para ENTRE 0 e 12 px da coluna de botões (#navCards: a posição e a largura saem do CSS dela). A conta da
     posição: o conteúdo é centrado na área sem a barra de rolagem; a coluna é fixa a `right` px dessa mesma área. */
  {
    const navPC = regra(fora, '#navCards'), navBtPC = regra(fora, '#navCards button');
    const colunaOcupa = px(navPC, 'right') + px(navBtPC, 'width');   /* da borda da tela até o lado de dentro da coluna */
    const antes = { teto: nova.teto, vw: nova.vw };
    for (const barra of [0, 15, 17]) {
      for (let janela = 1100; janela <= 3840; janela += 2) {
        const w = largura(janela, barra);
        const folgaAteColuna = (janela - barra - colunaOcupa) - ((janela - barra) / 2 + w / 2);
        if (larguraCom(antes, janela, barra) < janela - nova.folga) {   /* a regra de antes deixava faixa: a nova encosta */
          assert.ok(folgaAteColuna >= 0 && folgaAteColuna <= 12, 'tela ' + janela + 'px (barra ' + barra + '): o conteúdo ficou a ' + folgaAteColuna.toFixed(1) + ' px da coluna de botões (tem que encostar: 0 a 12 px)');
        }
      }
    }
    /* o caso dele: 4K a 175% (janela de ~2194 px) — ganhou bem mais que 1 cm (37,8 px) de cada lado */
    const ganho2194 = (largura(2194, 15) - larguraCom(antes, 2194, 15)) / 2;
    assert.ok(ganho2194 >= 37.8, 'numa janela de 2194 px o dashboard ganhou só ' + ganho2194.toFixed(1) + ' px de cada lado (1 cm = 37,8 px)');
    /* e a regra de 14/11 continua valendo onde ela já dava mais (Full HD: 98% da janela, conteúdo por baixo da coluna como era) */
    assert.strictEqual(largura(1920, 15), larguraCom(antes, 1920, 15), 'em Full HD a largura mudou (a regra de 14/11 já passava da coluna)');
  }
}

/* ═══ 3. o dashboard carrega a versão nova da peça (o navegador não pode ficar com a antiga em cache) ═══ */
assert.ok(html.includes("['caScript', 'chat-analise', '?v=4']"), 'o dashboard não pede a versão nova do script do chat');

_chegouAoFim = true;
console.log('ok — o botão do chat é o 4º quadradinho da coluna lateral (em cima do ▲, mesmo tamanho, azul com o balão branco; reserva no mesmo lugar) e o dashboard mais largo não muda celular nem tablet');
