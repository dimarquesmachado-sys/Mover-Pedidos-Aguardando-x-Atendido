'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   FRETE MAGALU (coparticipação) — primeira fatia da desduplicação dos checkouts
   (11/09/2026).

   Estas 209 linhas eram BYTE A BYTE iguais em amb-checkout-offline/index.js e
   girassol-backup-offline/gbo-app.js. Medição do dia: os dois arquivos têm 85%
   de linhas idênticas (~5.900), e todo conserto precisava ser espelhado à mão —
   foi assim o dia inteiro de ontem e hoje ("espelhado nas 2 empresas" em cada
   commit). Com o CNPJ novo a caminho, isso vira 4 lugares por bug.

   A regra do dono pra peça nova é código ÚNICO com a empresa como parâmetro.
   Aqui é o mesmo princípio aplicado ao que já existe: o módulo não conhece
   empresa nenhuma — recebe o que muda (pasta de cache, acesso ao Bling) por
   injeção, e devolve as mesmas funções que o checkout já chamava, com os mesmos
   nomes, pra troca ser invisível.

   Fatia deliberadamente pequena: sem rota, sem estado compartilhado com o resto
   do arquivo, e com as duas cópias provadas idênticas antes de mexer.
   ──────────────────────────────────────────────────────────────────────────── */

const path = require('path');

function criar(deps) {
  const { CACHE_DIR, readJson, writeJson, blingGet, resolverProdutoPorSku } = deps;
  for (const [nome, v] of Object.entries({ CACHE_DIR, readJson, writeJson, blingGet, resolverProdutoPorSku })) {
    if (v == null) throw new Error('lib/checkout/magalu-frete: falta a dependência ' + nome);
  }

  // ─── FRETE MAGALU (coparticipação) — tabela + cubagem + banco por SKU ─────────
  // A Magalu cobra o frete por FAIXA de peso (o maior entre peso real e cubado),
  // com desconto conforme o nível de "Despacho no Prazo" do mês. A API financeira
  // só traz o frete REAL quando o pedido liquida; até lá estimamos pela tabela
  // (e, se o SKU já vendeu antes, pela média real dele — auto-corretivo).
  const MAGALU_FRETE_TABELA = [
    // [pesoMaxKg, semDesconto, desc25 (87-97%), desc50 (>97%)]
    [0.5, 35.90, 26.93, 17.95], [1, 40.80, 30.68, 20.45], [2, 42.90, 32.18, 21.45],
    [5, 50.90, 38.18, 25.45], [9, 77.90, 58.43, 38.95], [13, 98.00, 74.18, 49.45],
    [17, 111.90, 83.93, 55.95], [23, 134.90, 101.18, 67.45], [30, 148.90, 111.68, 74.45],
    [40, 179.90, 134.93, 89.95], [50, 189.90, 142.43, 94.95], [60, 199.90, 149.93, 99.95],
    [70, 209.90, 157.43, 104.95], [80, 219.90, 164.93, 109.95], [90, 229.90, 172.43, 114.95],
    [100, 239.90, 179.93, 119.95], [110, 249.90, 187.43, 124.95], [120, 259.90, 194.93, 129.95],
    [130, 269.90, 202.43, 134.95], [140, 279.90, 209.93, 139.95], [150, 289.90, 217.43, 144.95],
    [160, 299.90, 224.93, 149.95], [170, 309.90, 232.43, 154.95], [180, 319.90, 239.93, 159.95],
    [190, 329.90, 247.43, 164.95], [200, 339.90, 254.93, 169.95]
  ];
  // nível de desconto configurável (default 50% = coluna >97%; salvo em _config-frete-magalu.json).
  // Índice na linha da tabela: 1=sem desconto, 2=desc25, 3=desc50.
  function magaluNivelColuna() {
    try {
      const cfg = readJson(path.join(CACHE_DIR, '_config-frete-magalu.json'), {});
      const n = cfg.nivel_desconto;   // 'sem' | '25' | '50'
      if (n === 'sem') return 1;
      if (n === '25') return 2;
      return 3;   // default 50%
    } catch (e) { return 3; }
  }
  // peso cubado + faixa → valor da tabela pela coluna do nível. Retorna null se faltar dimensão.
  function magaluFreteTabela(dim, pesoBruto) {
    if (!dim) return null;
    const larg = Number(dim.largura), alt = Number(dim.altura), prof = Number(dim.profundidade);
    if (!(larg > 0 && alt > 0 && prof > 0)) return null;
    // unidadeMedida:1 = cm (o padrão do Bling). Converte pra metros.
    const m3 = (larg / 100) * (alt / 100) * (prof / 100);
    const cubado = m3 * 167;   // fator 167 (leves) — casa com o dado real; pesados (300) raros
    const pReal = Number(pesoBruto) || 0;
    const peso = Math.max(pReal, cubado);   // a Magalu usa o MAIOR
    const col = magaluNivelColuna();
    for (const linha of MAGALU_FRETE_TABELA) {
      if (peso <= linha[0]) return Math.round(linha[col] * 100) / 100;
    }
    return Math.round(MAGALU_FRETE_TABELA[MAGALU_FRETE_TABELA.length - 1][col] * 100) / 100;   // acima de 200kg
  }
  // banco por SKU: média do frete REAL conforme os pedidos liquidam (fonte auto-corretiva).
  function magaluFreteSkuLer() { try { return readJson(path.join(CACHE_DIR, '_magalu_frete_sku.json'), {}); } catch (e) { return {}; } }
  function magaluFreteSkuGravar(sku, freteReal) {
    if (!sku || !(freteReal > 0)) return;
    try {
      const F2 = path.join(CACHE_DIR, '_magalu_frete_sku.json');
      const banco = readJson(F2, {});
      const cur = banco[sku] || { soma: 0, n: 0, media: 0 };
      cur.soma = Math.round((cur.soma + freteReal) * 100) / 100; cur.n += 1;
      cur.media = Math.round((cur.soma / cur.n) * 100) / 100;
      cur.ultimo = freteReal; cur.em = new Date().toISOString();
      banco[sku] = cur; writeJson(F2, banco);
    } catch (e) {}
  }
  // cache das dimensões por SKU (evita re-consultar o Bling toda rodada)
  const _dimCache = {};
  async function magaluDimSku(sku, signal) {
    if (!sku) return null;
    if (_dimCache[sku] !== undefined) return _dimCache[sku];
    try {
      /* Acerto (Codex #226 final): em catálogo com duplicata, o data[0] cru podia ser cadastro
         EXCLUÍDO/inativo — e a dimensão errada ficava 14 dias no cache aplicando a faixa errada em
         todas as rotas. O resolverProdutoPorSku aplica as regras da casa (ativo > reserva, variantes
         de caixa, inconclusivo quando uma busca falha). Inconclusivo = transitório (nada persiste);
         não achado/todos excluídos = miss com TTL. */
      const rr = await resolverProdutoPorSku(sku, async (p) => {
        const r = await blingGet(p, undefined, signal);
        /* Codex #228 r2: 400/404/422 da BUSCA é resposta DEFINITIVA (SKU inválido/inexistente) —
           vira página vazia pro resolver (→ produto null → miss com TTL), não falha transitória. */
        if (r && !r.ok && (r.status === 404 || r.status === 400 || r.status === 422)) return { ok: true, data: { data: [] } };
        return r;
      }, 50);   // Codex #228 r2: limite 50 num request só — ativo atrás de 10+ duplicatas aparece sem paginar; >50 cadastros do MESMO código é patológico e segue transitório (inconclusivo sem ativo)
      /* Codex #228: ATIVO achado é conclusivo mesmo com página cheia (o resolver marca inconclusivo
         junto) — só rejeita inconclusivo SEM ativo (a variante que falhou pode ser a do cadastro). */
      if (rr && rr.inconclusivo && !rr.ativo) return { erro: true };
      const p0 = rr && rr.produto;
      if (!p0 || !p0.id) { _dimCache[sku] = null; return null; }
      const rd = await blingGet('/produtos/' + p0.id, undefined, signal);
      if (!rd || !rd.ok) {
        const st2 = rd && rd.status;
        if (st2 === 404 || st2 === 400 || st2 === 422) { _dimCache[sku] = null; return null; }   // Codex #226 r2: definitivo = miss com TTL
        return { erro: true };
      }
      const prod = (rd.data && rd.data.data) || null;
      const out = prod ? { dim: prod.dimensoes, peso: prod.pesoBruto } : null;
      _dimCache[sku] = out; return out;
    } catch (e) { return { erro: true }; }
  }
  // frete provisório de um pedido: histórico do SKU (se já vendeu) senão a tabela pela dimensão.
  async function magaluFreteProvisorio(v) {
    /* Acerto (Codex #226 final): a MESMA regra de seleção do leitor do histórico — itens ordenados
       por SKU, banco de QUALQUER item vence (a média é o PACOTE), senão a dimensão do 1º ordenado.
       Sem isto, o mesmo pedido multi-item mostrava um frete no dia e outro no Mês/Ano. */
    const its = (v.it || []).map(x => ({ sku: String((x && x.sku) || '').trim() })).filter(x => x.sku)
      .sort((a, b) => a.sku.localeCompare(b.sku));
    if (!its.length) return null;
    const banco = magaluFreteSkuLer();
    for (const x of its) { const b = banco[x.sku]; const m = b && Number(b.media); if (m > 0) return m; }
    /* Codex #228: como no leitor, a fase dimensão itera TODOS os itens ordenados até um resolver —
       parar no 1º sem dimensão era regressão pra pedido [B-com-dim, A-sem-dim]. O _dimCache segura
       o custo das repetições. */
    for (const x of its) {
      const d = await magaluDimSku(x.sku);
      if (d && d.erro) break;   // Codex #228 r2: falha TRANSITÓRIA do Bling (429/5xx/rede) atinge tudo — parar em vez de re-tentar item a item e pendurar o sync inteiro na indisponibilidade
      if (d && d.dim) { const f = magaluFreteTabela(d.dim, d.peso); if (f != null) return f; }
    }
    return null;
  }
  /* Codex #228 (pós-merge): o cache v1 foi populado HOJE pelo data[0] cru — podia carregar dimensão
     de cadastro EXCLUÍDO por 14 dias mesmo com o resolver novo no ar. Bump pra v2 = cache antigo
     ignorado; o novo se popula já pelas regras do resolverProdutoPorSku (ativo > reserva). */
  const _MAGALU_DIM_DISCO = path.join(CACHE_DIR, '_magalu_dim_sku_v2.json');

  // ─── frete PREVISTO por SKU pro completar do histórico (26/08) ─────────────────
  // O completar na leitura do /historico-longo (20/08) só cobria SKU que JÁ liquidou
  // alguma vez (banco por SKU). SKU Magalu que nunca liquidou continuava com frete 0
  // em julho — a última sobra do frete zerado. Este wrapper fecha o buraco com a MESMA
  // conta do caminho do dia: banco por SKU manda; senão a tabela por dimensão (frete do
  // PACOTE de 1 unidade — mesma premissa do magaluFreteProvisorio: o 1º item define a
  // faixa e a maioria dos pedidos é 1 SKU ×1). As dimensões ganham cache em DISCO
  // (_magalu_dim_sku.json): a 1ª leitura consulta o Bling e grava; as próximas saem do
  // disco — o historico-longo não pode pendurar em 2 GETs do Bling por SKU toda vez.
  // `orc` é o orçamento da requisição ({ bling, max }): estourou o teto, devolve null e
  // o SKU fica pra próxima leitura (o dado entra sozinho, sem segurar a resposta).
  function _dimUsavel(e) {   // Codex #225 r5: dimensão só é "sucesso" se a tabela consegue usá-la
    const dm = e && e.dim;
    return !!(dm && Number(dm.largura) > 0 && Number(dm.altura) > 0 && Number(dm.profundidade) > 0);
  }
  async function magaluFretePrevistoSku(sku, orc) {
    const s = String(sku || '').trim();
    if (!s) return null;
    /* Codex #225 r5: numa leitura de 60 mil linhas o wrapper era chamado por pedido — re-ler e
       re-parsear os DOIS JSONs do disco a cada chamada travava o event loop. O `orc` (o estado da
       requisição) agora carrega as leituras: 1× por requisição, atualizadas quando o próprio
       wrapper grava. Sem orc (chamador avulso), lê na hora como antes. */
    let banco;
    if (orc && orc._banco) banco = orc._banco;
    else { banco = magaluFreteSkuLer(); if (orc) orc._banco = banco; }
    if (banco[s] && banco[s].media > 0) return banco[s].media;
    const AGORA = Date.now();
    const TTL_DIM = 14 * 24 * 3600 * 1000;    // Codex #225: dimensão corrigida no Bling tem que chegar — o cache vence em 14 dias e re-consulta
    const TTL_MISS = 3 * 24 * 3600 * 1000;    // Codex #225: MISS persistido (produto sem dimensão/não achado) — re-tenta em 3 dias e, até lá, NÃO gasta orçamento
    let d = null;
    try {
      let dd;
      if (orc && orc._disco) dd = orc._disco;
      else { dd = readJson(_MAGALU_DIM_DISCO, {}); if (orc) orc._disco = dd; }
      let e0 = dd && dd[s];
      /* Codex #226: caixa diferente (PM1 gravado × pm1 na linha) não pode gastar outra consulta —
         índice UPPER→chave montado 1× por requisição (no orc); sem orc, varredura simples. */
      if (!e0 && dd) {
        if (orc) {
          if (!orc._discoIdx) { orc._discoIdx = {}; for (const kD of Object.keys(dd)) { const kU = kD.toUpperCase(); if (orc._discoIdx[kU] === undefined) orc._discoIdx[kU] = kD; } }
          const kR = orc._discoIdx[s.toUpperCase()];
          if (kR !== undefined && dd[kR]) e0 = dd[kR];
        } else {
          const kR = Object.keys(dd).find(kD => kD.toUpperCase() === s.toUpperCase());
          if (kR) e0 = dd[kR];
        }
      }
      if (e0) {
        const idade = AGORA - (Date.parse(e0.em || 0) || 0);
        if (_dimUsavel(e0) && idade < TTL_DIM) d = e0;   // Codex r5: entrada antiga com dimensão zerada NÃO é sucesso — cai pra re-consulta/miss
        else if (e0.miss && idade < TTL_MISS) return null;   // miss fresco: corta antes do orçamento e do Bling
      }
    } catch (e) {}
    if (!d) {
      /* Codex #225 r4: o DISCO já foi olhado ACIMA — o orçamento só decide a ida ao BLING. Cortes
         devolvem MARCADOR (não null): o chamador conta como pendente, não memoiza e não cacheia o
         agregado — null de verdade fica só pro miss (produto sem dimensão). */
      if (orc && orc.ate == null) orc.ate = Date.now() + 6000;   // Codex #226 r2: o prazo nasce AQUI, na 1ª ida REAL ao Bling — candidatos servidos pelo cache não gastam relógio
      if (orc && orc.ate != null && Date.now() > orc.ate) return '__orcamento__';   // prazo TOTAL — Bling lento não pendura o dashboard
      if (orc && orc.max != null && orc.bling >= orc.max) return '__orcamento__';   // teto de consultas da requisição
      if (orc) orc.bling++;
      delete _dimCache[s];   // Codex #225 r2: o cache de MEMÓRIA não expira — sem isto, o TTL do disco re-gravava o dado velho (ou o null) pra sempre em processo longevo
      /* prazo PRÓPRIO da consulta + CANCELAMENTO REAL (Codex r4): o abort mata o fetch junto com o
         prazo — sem ele, cada leitura acumulava conexões vivas com o Bling atrás do race. */
      const _ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      let _tt = null;
      /* Codex #226 r4: o prazo da consulta respeita o RESTANTE do prazo compartilhado - consulta que
         comeca a 300ms do orc.ate nao ganha 4s inteiros (3 lentas seguidas seguravam a rota ~10s). */
      const _resta = (orc && orc.ate != null) ? Math.max(200, orc.ate - Date.now()) : 4000;
      const _prazoMs = Math.min(4000, _resta);
      const prazo = new Promise(res => { _tt = setTimeout(() => { try { if (_ac) _ac.abort(); } catch (e2) {} res('__prazo__'); }, _prazoMs); });
      d = await Promise.race([magaluDimSku(s, _ac ? _ac.signal : undefined), prazo]);
      if (_tt) clearTimeout(_tt);
      if (d === '__prazo__' || (d && d.erro)) return '__transitorio__';   // Codex r2/r4: timeout e falha de API/transporte não viram miss nem congelam agregado — re-tenta na próxima leitura
      try {
        const dd = readJson(_MAGALU_DIM_DISCO, {});
        /* Codex #226: gravar na chave que JÁ existe com outra caixa — senão PM1 e pm1 viram duas
           entradas e a leitura fica ambígua. */
        const kEx = (dd[s] !== undefined) ? s : Object.keys(dd).find(kD => kD.toUpperCase() === s.toUpperCase());
        const kGr = kEx || s;
        /* Codex r5: dimensão INUTILIZÁVEL (objeto existe, medidas zeradas/faltando) grava como MISS
           (3 dias) e não como sucesso (14) — corrigir o cadastro no Bling volta a valer rápido. */
        if (_dimUsavel(d)) dd[kGr] = { dim: d.dim, peso: d.peso, em: new Date().toISOString() };
        else dd[kGr] = { miss: true, em: new Date().toISOString() };   // não achado, sem dimensão ou dimensão zerada: miss com TTL
        writeJson(_MAGALU_DIM_DISCO, dd);
        if (orc) { orc._disco = dd; orc._discoIdx = null; }   // a leitura cacheada acompanha; o índice de caixa regenera
      } catch (e) {}
    }
    if (!d || !d.dim) return null;
    return magaluFreteTabela(d.dim, d.peso);
  }


  return { magaluNivelColuna, magaluFreteTabela, magaluFreteSkuLer, magaluFreteSkuGravar,
           magaluDimSku, magaluFretePrevistoSku, magaluFreteProvisorio, MAGALU_FRETE_TABELA };
}

module.exports = { criar };
