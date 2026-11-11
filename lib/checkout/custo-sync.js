'use strict';
/* 11/11 (plano multiloja, Fase 3 item 5 — os arquivos de entrada só compondo) — A SINCRONIZAÇÃO DE CUSTO, PEÇA ÚNICA.

   O `custoSync` (a rotina que busca no Bling o custo de cada SKU vendido, resolve kit/composição, grava o custo vigente
   e limpa os caches) existia IGUAL, linha a linha, no arquivo da Girassol e no da AMB — 236 linhas em cada, mudando só o
   nome da empresa em dois lugares. Agora mora aqui; a empresa entrega o que é dela.

   O corpo é o MESMO que estava nos dois arquivos (scripts/teste-custo-sync-peca.js compara com o de antes). O que vem
   de quem montou é lido A CADA RODADA (não na montagem): assim não depende da ordem em que o arquivo da empresa declara
   as coisas, e nunca roda com valor velho.

   A GOOD ainda tem a versão dela (lê os SKUs do histórico de um arquivo local, entre outras diferenças) — junta depois,
   nivelando por cima. */
const path = require('path');

const PECAS = ['CACHE_DIR', 'CONFERIDOS_FILE', '_anotarFalhaCusto', '_cst', '_custoComp', '_histCache', '_limparSkuInfo', 'blingGet', 'readJson', 'registrarCustoVigente', 'resolverDeParaSku', 'resolverProdutoPorSku', 'supaCfg', 'travaPesada', 'writeJson'];

function criar(G) {
  if (!G || !G.empresa) throw new Error('lib/checkout/custo-sync: falta empresa');
  for (const n of PECAS) if (!(n in G)) throw new Error('lib/checkout/custo-sync: falta ' + n);
  const EMPRESA = String(G.empresa);
  return async function custoSync(fresh) {
    const { CACHE_DIR, CONFERIDOS_FILE, _anotarFalhaCusto, _cst, _custoComp, _histCache, _limparSkuInfo, blingGet, readJson, registrarCustoVigente, resolverDeParaSku, resolverProdutoPorSku, supaCfg, travaPesada, writeJson } = G;
  /* Codex #367 r2: componente resolvido pela API vale pra TODOS os kits desta varredura —
     sem o memo, cada kit que usa a mesma lâmpada pagaria a consulta de novo. */
  const _memoComp = new Map();
  if (_cst.rodando) return;
  const CUSTO_FILE = path.join(CACHE_DIR, '_custos.json');
  const cc = readJson(CUSTO_FILE, {});
  const conf = readJson(CONFERIDOS_FILE, {});
  const todos = new Set();
  for (const c of Object.values(conf)) { for (const it of ((c && c.itens) || [])) { if (it && it.sku) todos.add(String(it.sku)); } }
  // 27/07: pega também os SKUs das vendas AINDA NÃO BIPADAS (_vendas_dia.json). Antes a fila saía só dos
  // conferidos — SKU que só aparecia em pedido não bipado nunca ganhava custo, e a margem saía inflada.
  try {
    const vd = readJson(path.join(CACHE_DIR, '_vendas_dia.json'), {});
    for (const v of Object.values(vd)) { for (const it of ((v && v.it) || [])) { if (it && it.sku) todos.add(String(it.sku)); } }
  } catch (e) {}
  // 28/07: e também os SKUs do HISTÓRICO (Supabase). O cache local só guarda ~6 dias de vendas,
  // então SKU que vendeu no começo do mês mas não vendeu essa semana nunca entrava na fila do
  // custo — e aparecia como "sem custo" no dashboard mesmo tendo preço cadastrado no Bling.
  try {
    const { url: uH, key: kH } = supaCfg(EMPRESA);
    if (uH && kH) {
      const desde = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
      let offH = 0, lidos = 0;
      while (offH < 120000) {
        const rh = await fetch(uH.replace(/\/+$/, '') + '/rest/v1/vendas_historico?empresa=eq.' + EMPRESA + '&data_venda=gte.' + desde +
        // 01/08 — SEM 'order' o Postgres NÃO garante a mesma ordem entre as páginas, e paginar
        // com offset PULA linhas. Um SKU que aparece em UMA única linha (kit vendido 1x) some da
        // fila e nunca ganha custo — foi o caso do 90-lisa-125mm-KIT62, vendido só em 01/05.
                   '&select=sku&order=data_venda.asc,numero_pedido.asc,sku.asc&limit=1000&offset=' + offH, { headers: { apikey: kH, Authorization: 'Bearer ' + kH } });
        if (!rh.ok) break;
        const ln = await rh.json().catch(() => []);
        if (!Array.isArray(ln) || !ln.length) break;
        for (const l of ln) { if (l && l.sku) todos.add(String(l.sku)); }
        lidos += ln.length;
        if (ln.length < 1000) break;
        offH += 1000;
      }
      if (lidos) console.log('[CUSTO] +SKUs do histórico: ' + lidos + ' linhas lidas, fila agora com ' + todos.size + ' SKU(s)');
    }
  } catch (e) {}
  const SETE_D = 7 * 24 * 3600 * 1000;
  // Codex (P2, 4ª rodada): SKU confirmadamente apagado no Bling continua no histórico de vendas
  // pra sempre. Sem marca, o predicado abaixo (`!k`) o reelegia a cada rodada: três buscas por
  // variante de caixa, nada encontrado, nada apagado — e de novo seis horas depois, para sempre.
  // Conforme SKUs deletados se acumulam, isso queima cota da API e atrasa o custo dos produtos
  // vivos. A LÁPIDE registra "conferido, não existe mais" e a rodada normal pula; o ?fresh=1 do
  // operador ignora a lápide e reconfere (produto pode ser restaurado no Bling).
  /* 13/09 — O SYNC PASSA A RESPEITAR O DE-PARA. O dono ligou FL-1011-PRETO ao SKU novo
     (3933398010054, renomeado no Bling) e a falha diária CONTINUOU: a varredura montava a
     lista de alvos direto do histórico e perguntava ao Bling pelo código VELHO, sem nunca
     consultar o de-para — a peça existia e não era usada neste caminho. Agora o código
     velho é traduzido antes: some da fila (não gasta consulta nem gera alarme) e, se o
     destino ainda não estiver na lista, ele entra no lugar. */
  const _traduzido = new Map();
  for (const sk of [...todos]) {
    let destino = null;
    try { destino = resolverDeParaSku(sk); } catch (e) { destino = null; }
    if (destino && String(destino).toUpperCase() !== String(sk).toUpperCase()) _traduzido.set(sk, String(destino));
  }
  if (_traduzido.size) {
    for (const [velho, novo] of _traduzido) { todos.delete(velho); todos.add(novo); }
    console.log('[CUSTO] de-para aplicado em ' + _traduzido.size + ' SKU(s): ' + [..._traduzido].map(([v, n]) => v + '→' + n).join(', '));
  }
  const alvos = [...todos].filter(sk => { const k = cc[sk]; if (k && k.apagado_em) { if (!fresh) return false; if ((Date.now() - k.apagado_em) < 30 * 86400000) return false; /* Codex #358: fresh diário revisitando TODA lápide devolvia os apagados ao resolvedor caro toda noite */ } return fresh || !k || !k.id || (Date.now() - (k.ts || 0)) > SETE_D || k.custo == null; });
  /* Codex #358 r2+r3: fila em ordem de PROFUNDIDADE de dependência — componente (0),
     kit (1), kit-de-kit (2)... Empatar todos os kits deixava o kit EXTERNO poder vir
     antes do interno e somar o agregado velho. Memoizado, teto 6 contra ciclo. */
  const _idxLower = {}; for (const sk0 of Object.keys(cc)) { if (sk0.startsWith('_')) continue; _idxLower[sk0.toLowerCase()] = sk0; const v0i = cc[sk0]; if (v0i && v0i.id) _idxLower['id:' + v0i.id] = sk0; /* Codex #358 r4: comps por id também resolvem */ }
  const _prof = {};
  const _profDe = (sk0, nivel) => {
    if (nivel > 6) return 6;
    if (_prof[sk0] != null) return _prof[sk0];
    const v0 = cc[sk0];
    if (!v0 || !Array.isArray(v0.comps) || !v0.comps.length) { _prof[sk0] = 0; return 0; }
    _prof[sk0] = 6; /* sentinela anti-ciclo enquanto calcula */
    let m = 0;
    for (const c0 of v0.comps) { const real = _idxLower[String(c0).toLowerCase()]; if (real) m = Math.max(m, _profDe(real, nivel + 1)); }
    _prof[sk0] = 1 + m;
    return _prof[sk0];
  };
  alvos.sort((x, y) => _profDe(x, 0) - _profDe(y, 0));
  /* muta, não reatribui: `_cst` é const e a referência vive em estadoDe() */
  Object.assign(_cst, { rodando: true, feitos: 0, total: alvos.length, ok: 0, falhas: 0, inicio: new Date().toISOString(), falhas_detalhe: [] });
  console.log('[CUSTO] sync iniciando — ' + alvos.length + ' SKU(s) a resolver (tartaruga: ~1,2s/chamada)');
  const dorme = ms => new Promise(r => setTimeout(r, ms));
  const bg2 = async (pth) => { for (let t = 0; t < 4; t++) { const r = await blingGet(pth); if (r && r.ok) return r; await dorme(1500 + t * 700); } return await blingGet(pth); };
  let desdeGravei = 0;
  for (const sku of alvos) {
    try {
      let prod = null;
      let _falhaConsulta = false; /* Codex #358 r2: distingue custo AUSENTE por decisão (limpar) de custo ausente por 429/erro (preservar) */
      const _res = await resolverProdutoPorSku(sku, bg2, 10);
      if (_res.produto && _res.produto.id) {
        const d = await bg2(`/produtos/${_res.produto.id}`);
        if (!d || !d.ok) _falhaConsulta = true; /* Codex #358 r2: falha ≠ conclusivo */
        prod = (d.ok && d.data && d.data.data) || _res.produto;
      }
      if (_res.inconclusivo) console.log('[CUSTO] ' + sku + ': resultado inconclusivo — ' + _res.motivo + ' (nada será apagado)');
      // Codex (P2, 4ª rodada): resolver o cadastro ATIVO não bastava — o cache de 6h do sku-info
      // podia estar com o custo/nome do cadastro EXCLUÍDO, e a sobreposição do permanente só cobre
      // custo NULO. Ou seja, o ?fresh=1 corrigia o banco e a tela seguia mostrando o valor velho.
      // Resolveu com sucesso: o cache secundário daquele SKU é invalidado para ser refeito.
      if (prod && prod.id) _limparSkuInfo(sku);
      // Codex (P1, PR#143): produto APAGADO no Bling — sem isto, o custo velho continuava no
      // cache e o próprio ?fresh=1 o regravava, ou seja, a correção não corrigia nada. Achou
      // cadastros e todos excluídos = o custo daquele SKU deixa de existir aqui também.
      // (busca vazia NÃO limpa: pode ser instabilidade do Bling, e apagar seria pior)
      // Codex (P1, 3ª rodada): eu tranquei TODA a limpeza atrás de `cc[sku]`. Se o custo tinha
      // entrado só pelo sku-info (sem passar pelo custo-sync), nada era limpo e o valor do produto
      // deletado voltava por lá. Só a remoção do permanente pode depender de ele existir.
      if (!prod && _res.todosExcluidos) {
        const _era = cc[sku] && cc[sku].custo;   // ler ANTES de apagar (senão o log sai 'undefined')
        if (cc[sku]) { delete cc[sku]; desdeGravei++; }
        // lápide: sem custo e sem id, só a marca de que já foi conferido e não existe mais
        cc[sku] = { apagado_em: Date.now(), motivo: 'só havia cadastro excluído no Bling' };
        // Codex (P1, 2ª rodada): existe um SEGUNDO cache (o do sku-info, em memória e em
        // _skus-info.json) que também guarda custo — e ele RESTAURA o valor antigo quando o novo
        // vem nulo. Apagar só o permanente deixava o custo do produto deletado voltar por ali,
        // com carimbo novo, indefinidamente. Os dois têm que cair juntos.
        _limparSkuInfo(sku);
        console.log('[CUSTO] ' + sku + ': só havia cadastro EXCLUÍDO no Bling — custo removido dos DOIS caches (era ' + JSON.stringify(_era) + ')');
      }
      if (prod && prod.id) {
        const forn = prod.fornecedor || {};
        // ⚠️ 19/08 — KIT: A COMPOSIÇÃO MANDA, NÃO O CAMPO DO FORNECEDOR.
        // Caso real (AMB, 10xE14-5W-3000K-BIV): a tela do Bling mostra fornecedor 34,00 e
        // "Preço Total de Custo" 34,00 (10 × 3,40), mas a API devolve no bloco `fornecedor` do
        // KIT: precoCusto **20,40** e precoCompra **3,40** — dois números que não são o custo do
        // kit (o 3,40 é o do COMPONENTE). Como `forn.precoCusto` era o primeiro candidato, o
        // dashboard gravava 20,40 e a margem do kit saía inflada em quase R$ 14 por venda.
        // O próprio Bling calcula o custo de um produto com composição SOMANDO os componentes —
        // é o que a tela mostra. Fazemos igual: havendo estrutura, ela decide; os campos do
        // fornecedor viram apenas reserva para quando a composição não fechar.
        const _candDosFornecedores = async () => {
          const rf = await bg2(`/produtos/fornecedores?idProduto=${prod.id}&limite=5`);
          if (!rf || !rf.ok) { _falhaConsulta = true; return []; }
          const arr = (rf.ok && rf.data && rf.data.data) || [];
          const pref = arr.find(x => x && x.padrao) || arr[0];
          // 27/07: o nome do campo varia na resposta do Bling — aceita todos os candidatos
          let c = [];
          if (pref) c = [pref.precoCusto, pref.precoCompra, pref.preco, pref.custo, pref.valor, pref.valorCusto]
                        .map(Number).filter(v => isFinite(v) && v > 0);
          if (!c.length && arr.length) {
            for (const fx of arr) {
              const vs = Object.keys(fx || {}).filter(k => /pre(c|ç)o|custo|valor/i.test(k)).map(k => Number(fx[k])).filter(v => isFinite(v) && v > 0);
              if (vs.length) { c = [Math.min.apply(null, vs)]; break; }
            }
          }
          return c;
        };
        /* 11/09 — A DECISÃO DE CUSTO MUDOU-SE PARA lib/custo-composicao.js. Por quê: ela
           levou QUATRO PRs pra ficar certa em 10/09 (o endpoint de fornecedores rodando
           antes da composição, o retrato embutido ganhando do banco, o banco consultado só
           por SKU quando a estrutura traz ID, a soma truncada virando custo, o kit aninhado
           pelo fornecedor) e vivia solta aqui dentro, sem como testar sem subir o serviço e
           falar com o Bling. Agora a regra está num lugar só, é a MESMA das duas empresas e
           tem teste (scripts/teste-custo-composicao.js, 11 cenários, incluindo o caso real
           do 2xE14). A rede continua sendo por aqui: a lib não fala com o Bling, recebe as
           consultas por injeção. */
        const _dec = await _custoComp.decidirCustoDoProduto(prod, {
          banco: cc,
          memo: _memoComp,
          consultarProduto: async (id) => {
            const dc = await bg2(`/produtos/${id}`);
            await dorme(420);
            if (!dc || !dc.ok) return { ok: false };
            return { ok: true, produto: (dc.data && dc.data.data) || null };
          },
          consultarFornecedores: async () => {
            const c = await _candDosFornecedores();
            return c.length ? c[0] : null;
          },
        });
        if (_dec.falhaConsulta) _falhaConsulta = true;
        if (_dec.motivo) console.log('[CUSTO] ' + sku + ': ' + _dec.motivo + ' — via ' + _dec.via);
        else console.log('[CUSTO] ' + sku + ': custo ' + (_dec.custo == null ? 'NAO resolvido' : _dec.custo) + ' via ' + _dec.via);
        const cand = _dec.custo != null ? [_dec.custo] : [];
        const _custoNovo = cand.length ? Math.round(cand[0] * 10000) / 10000 : null;
        /* 21/08: antes de sobrescrever, anota a linha do tempo — o Bling só guarda o custo
           ATUAL, então esta é a única chance de registrar que até ontem valia outro. */
        /* Codex #358 r4: este par usava _conclusivo/_antigo ANTES dos const abaixo —
           TDZ ReferenceError no exato caminho da remoção; o registro vem DEPOIS. */
        /* 09/09: grava os CÓDIGOS dos componentes — é o mapa reverso que o custo diário
           incremental usa pra saber quais kits re-buscar quando um unitário muda */
        /* Codex #358 r3: a estrutura do Bling normalmente vem SÓ com o ID do componente
           (prova: ciclo.js resolve por c.produto.id) — mapear só por codigo deixava o
           mapa de dependência VAZIO e o incremental nunca acharia kit nenhum. Guarda
           codigo (minúsculo) quando vier, senão 'id:<id>'; o scan de alterados marca
           pelos dois. */
        const _compsSkus = (((prod.estrutura && (prod.estrutura.componentes || prod.estrutura.itens)) || prod.composicao || prod.componentes) || [])
          .map(cp => {
            const cod = (cp.produto && cp.produto.codigo) || cp.codigo;
            if (cod) return String(cod).toLowerCase().trim();
            const idc2 = (cp.produto && cp.produto.id) || cp.produto || cp.id || cp.idProduto;
            return idc2 ? ('id:' + idc2) : '';
          }).filter(Boolean);
        /* Codex #358 r1+r2: três destinos possíveis pro custo nulo — (a) FALHA de consulta
           (429/erro no detalhe ou fornecedores): preserva custo antigo SEM avançar ts, a
           tartaruga re-tenta; (b) resposta CONCLUSIVA sem candidato (custo removido/zerado
           de propósito no Bling): grava null com ts novo — manter o velho esconderia pra
           sempre um produto que ficou sem custo; (c) custo novo: grava. E os comps só são
           substituídos quando a fonte atual TROUXE estrutura — detalhe falhado caía no
           resumo sem composição e apagava o mapa de dependência do kit. */
        const _antigo = cc[sku];
        const _conclusivo = !_falhaConsulta;
        const _custoFinal = (_custoNovo != null) ? _custoNovo : (_conclusivo ? null : ((_antigo && _antigo.custo != null) ? _antigo.custo : null));
        const _tsFinal = (_custoNovo != null || _conclusivo) ? Date.now() : ((_antigo && _antigo.ts) || 0);
        const _compsFinais = _compsSkus.length ? _compsSkus : ((!_conclusivo && _antigo && _antigo.comps) ? _antigo.comps : null);
        cc[sku] = Object.assign({ id: prod.id, preco: (prod.preco != null && isFinite(Number(prod.preco))) ? Number(prod.preco) : null, custo: _custoFinal, ts: _tsFinal }, _compsFinais && _compsFinais.length ? { comps: _compsFinais } : {});
        if (_custoNovo != null) { try { registrarCustoVigente(sku, _custoNovo, 'bling'); } catch (e) {} }
        else if (_conclusivo && _antigo && _antigo.custo != null) { try { registrarCustoVigente(sku, null, 'remocao-bling'); } catch (e) {} }
        _cst.ok++;
      } else { _cst.falhas++; _anotarFalhaCusto(sku, 'o Bling não devolveu o produto (resposta sem dados)'); }
    } catch (e) { _cst.falhas++; _anotarFalhaCusto(sku, String((e && e.message) || e).slice(0, 160)); }
    _cst.feitos++; desdeGravei++;
    if (desdeGravei >= 10) { desdeGravei = 0; try { writeJson(path.join(CACHE_DIR, '_custos.json'), cc); } catch (e) {} }
    /* Codex P1 (trava-pesada): fila grande o bastante (a 1,2s/SKU, ~4.500 SKUs) passa dos 90
       min do teto — sem sinal de vida, o relógio destrancaria uma rodada que ainda está viva,
       exatamente a sobreposição que a trava existe pra evitar. Renovar a cada SKU prova que
       segue em pé. */
    travaPesada.renovar();
    await dorme(1200);
  }
  try { writeJson(path.join(CACHE_DIR, '_custos.json'), cc); } catch (e) {}
  // 01/08: o /historico-longo guarda o agregado por 30 min. Sem limpar aqui, o dashboard continuava
  // mostrando "sem custo" DEPOIS do sync terminar — o custo já estava resolvido, mas a tela servia
  // a foto antiga. Foi exatamente o que aconteceu no filtro Ano.
  try {
    const nk = Object.keys(_histCache).length;
    for (const k2 of Object.keys(_histCache)) delete _histCache[k2];
    if (nk) console.log('[CUSTO] cache do histórico limpo (' + nk + ') — o dashboard recalcula com os custos novos');
  } catch (e) {}
  _cst.rodando = false;
  console.log('[CUSTO] sync concluiu — ok=' + _cst.ok + ' falhas=' + _cst.falhas + ' de ' + _cst.total);
};
}

module.exports = { criar, PECAS };
