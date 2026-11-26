'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   COMPRAS — LANÇAR O PEDIDO DE COMPRA NO BLING A PARTIR DOS ITENS MARCADOS NO PLANO (26/11/2026).

   O dono monta o pedido do fornecedor marcando os itens no Plano de Compra. Até aqui ele baixava a planilha e depois
   digitava o Pedido de Compra no Bling, item a item, pra a mercadoria aparecer como "a caminho". Esta peça cria o
   Pedido de Compra no Bling com os mesmos itens: fornecedor escolhido numa lista, data prevista, quantidade de cada
   item e o preço = o CUSTO cadastrado do produto.

   O que foi LIDO do Bling (não suposto):
     · GET /contatos/tipos → os tipos de contato; nas duas empresas existe "Fornecedor" (sonda de 26/11);
     · GET /contatos?pagina=&limite=&idTipoContato=<id> → o filtro por tipo funciona (9 na Girassol, 5 na AMB);
     · GET /pedidos/compras/{id} → { data, dataPrevista, fornecedor:{id}, itens:[{ quantidade, valor, produto:{id,codigo} }] }.
   O que NÃO foi lido: o corpo do POST /pedidos/compras. Ele é montado como espelho do GET. Se o Bling recusar algum
   campo, a recusa volta INTEIRA pra tela (tipo e mensagens de validação do Bling) — nada é criado numa recusa.

   criar({ blingGet, blingWrite, cadastro, custos, agora?, hojeSP?, aoCriar?, prazoMs? }) → {
     fornecedores(forcar?) → Promise<{ ok:true, lista:[{ id, nome }], lido_em } | { ok:false, motivo }>
         Só os contatos do tipo "Fornecedor". Guardado 10 min (falha: 1 min). Vai pra tela do dono (admin).
     montar(pedido) → Promise<{ ok:true, corpo, resumo } | { ok:false, erros:[texto] }>
         pedido = { fornecedor, data_prevista, itens:[{ sku, quantidade }] }. NÃO fala com o Bling além da lista de
         fornecedores (guardada). Tudo ou nada: um item sem cadastro, quantidade torta ou fornecedor desconhecido
         recusa o pedido inteiro — pedido pela metade seria pior que nenhum.
         Item sem custo cadastrado vai com valor 0 e sai listado em resumo.sem_custo (a tela avisa antes de criar).
     lancar(pedido, chave) → Promise<resultado>
         { ok:true, id, numero }                      criado
         { ok:false, erros }                          não passou na conferência (nada foi enviado)
         { ok:false, recusado:true, status, bling }   o Bling recusou (nada foi criado)
         { ok:false, ambiguo:true, motivo }           NÃO SEI se criou (rede caiu / sem resposta): conferir no Bling
         { ok:false, repetido:true, anterior }        esta mesma chave já foi enviada — o resultado de antes
         { ok:false, em_andamento:true }              esta mesma chave está sendo enviada agora
   }
   ⚠️ Criar pedido NÃO é idempotente: uma tentativa só, sem repetir em erro de rede (blingWrite com semRetryDeRede).
   A `chave` vem da tela (uma por pedido aberto): clique duplo ou reenvio da mesma chave não cria dois pedidos. Depois
   de um "não sei", a mesma chave continua respondendo "não sei" — quem decide tentar de novo é o dono, depois de
   olhar o Bling.
   ───────────────────────────────────────────────────────────────────────── */

const FORN_OK_MS = 10 * 60 * 1000, FORN_FALHA_MS = 60 * 1000;
const POR_PAGINA = 100, MAX_PAGINAS = 5;
const MAX_ITENS = 300, MAX_QTD = 1000000;
const PRAZO_MS = 45000;
const CHAVES_MS = 6 * 3600 * 1000, MAX_CHAVES = 200;

function semAcento(t) { return String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
function diaValido(t) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(t == null ? '' : t).trim());
  if (!m) return null;
  const d = m[1] + '-' + m[2] + '-' + m[3];
  return (Number(m[1]) >= 2000 && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toISOString().slice(0, 10) === d) ? d : null;
}
function idValido(v) { return (typeof v === 'string' || typeof v === 'number') && /^\d{1,20}$/.test(String(v)) && Number(v) > 0; }
function centavos(v) { return Math.round(Number(v) * 100) / 100; }
/* o que o Bling disse numa recusa: o tipo, a descrição e as mensagens de validação — texto do Bling sobre o PEDIDO
   (campo tal inválido), aparado; nunca o corpo cru */
function recusaDoBling(data) {
  const e = data && data.error;
  if (!e || typeof e !== 'object') return null;
  const txt = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : null);
  const campos = Array.isArray(e.fields) ? e.fields.slice(0, 12).map((f) => (f && typeof f === 'object')
    ? { campo: txt(f.element, 80) || txt(f.namespace, 80), msg: txt(f.msg, 200) } : null).filter((f) => f && (f.campo || f.msg)) : [];
  return { tipo: txt(e.type, 60), mensagem: txt(e.message, 200), descricao: txt(e.description, 300), campos };
}

function criar(deps) {
  const d = deps || {};
  for (const n of ['blingGet', 'blingWrite', 'cadastro', 'custos']) {
    if (typeof d[n] !== 'function') throw new Error('lib/checkout/compras-lancar: falta ' + n);
  }
  const agora = typeof d.agora === 'function' ? d.agora : Date.now;
  const hojeSP = typeof d.hojeSP === 'function' ? d.hojeSP : () => new Date(agora()).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const prazoMs = Number(d.prazoMs) > 0 ? Number(d.prazoMs) : PRAZO_MS;

  /* ── os fornecedores ── */
  let _forn = null, _fornEmVoo = null;
  async function lerFornecedores() {
    const ctl = new AbortController();
    const ESTOUROU = {};
    let timer = null;
    const prazo = new Promise((ok) => { timer = setTimeout(() => { ctl.abort(); ok(ESTOUROU); }, prazoMs); });
    const pedir = async (caminho) => {
      let r;
      try { r = await Promise.race([Promise.resolve().then(() => d.blingGet(caminho, 3, ctl.signal)), prazo]); } catch (e) { r = null; }
      if (r === ESTOUROU) throw ESTOUROU;
      return (r && typeof r === 'object' && r.ok && r.data && Array.isArray(r.data.data)) ? r.data.data : null;
    };
    try {
      const tipos = await pedir('/contatos/tipos');
      if (!tipos) return { ok: false, motivo: 'não consegui ler os tipos de contato do Bling — tente de novo' };
      const tipo = tipos.filter((t) => t && idValido(t.id) && semAcento(t.descricao).includes('fornecedor'))[0];
      if (!tipo) return { ok: false, motivo: 'o Bling desta empresa não tem o tipo de contato "Fornecedor"' };
      const porId = new Map();
      let completo = false;
      for (let pg = 1; pg <= MAX_PAGINAS; pg++) {
        const lista = await pedir('/contatos?pagina=' + pg + '&limite=' + POR_PAGINA + '&idTipoContato=' + encodeURIComponent(String(tipo.id)));
        if (!lista) return { ok: false, motivo: 'não consegui ler os fornecedores do Bling — tente de novo' };
        for (const c of lista) {
          if (!c || !idValido(c.id)) continue;
          const nome = String(c.nome == null ? '' : c.nome).replace(/\s+/g, ' ').trim().slice(0, 120);
          if (nome) porId.set(String(c.id), nome);
        }
        if (lista.length < POR_PAGINA) { completo = true; break; }
      }
      const lista = [...porId].map(([id, nome]) => ({ id, nome })).sort((a, b) => semAcento(a.nome).localeCompare(semAcento(b.nome)) || a.id.localeCompare(b.id));
      if (!lista.length) return { ok: false, motivo: 'nenhum contato do tipo "Fornecedor" no Bling desta empresa — cadastre o fornecedor lá' };
      return { ok: true, lista, incompleto: !completo };
    } catch (e) {
      if (e !== ESTOUROU) throw e;
      return { ok: false, motivo: 'o Bling não respondeu em ' + Math.round(prazoMs / 1000) + ' s — tente de novo' };
    } finally { clearTimeout(timer); }
  }
  function fornecedores(forcar) {
    const t = agora();
    if (!forcar && _forn && (t - _forn.ts) < (_forn.val.ok ? FORN_OK_MS : FORN_FALHA_MS)) return Promise.resolve(_forn.val);
    if (_fornEmVoo) return _fornEmVoo;
    _fornEmVoo = lerFornecedores()
      .then((v) => v, () => ({ ok: false, motivo: 'erro ao ler os fornecedores' }))
      .then((v) => { const val = Object.assign({}, v, { lido_em: new Date(agora()).toISOString() }); _forn = { ts: agora(), val }; _fornEmVoo = null; return val; });
    return _fornEmVoo;
  }

  /* ── a conferência e o corpo ── */
  async function montar(pedido) {
    const p = (pedido && typeof pedido === 'object') ? pedido : {};
    const erros = [];
    const hoje = hojeSP();
    /* fornecedor: tem de ser um da lista lida do Bling (id digitado à mão não vale) */
    let fornecedor = null;
    if (!idValido(p.fornecedor)) erros.push('escolha o fornecedor');
    else {
      const f = await fornecedores(false);
      if (!f.ok) erros.push('não consegui conferir o fornecedor: ' + f.motivo);
      else {
        fornecedor = f.lista.filter((x) => x.id === String(p.fornecedor))[0] || null;
        if (!fornecedor) erros.push('o fornecedor escolhido não está entre os fornecedores do Bling desta empresa');
      }
    }
    /* data prevista: opcional; se veio, é um dia que existe e não é passado */
    let dataPrevista = null;
    if (p.data_prevista != null && String(p.data_prevista).trim() !== '') {
      dataPrevista = diaValido(p.data_prevista);
      if (!dataPrevista) erros.push('a data prevista não é uma data válida');
      else if (dataPrevista < hoje) erros.push('a data prevista já passou');
    }
    /* itens */
    const entrada = Array.isArray(p.itens) ? p.itens : [];
    if (!entrada.length) erros.push('nenhum item no pedido');
    if (entrada.length > MAX_ITENS) erros.push('o pedido tem ' + entrada.length + ' itens — o máximo é ' + MAX_ITENS + ' por pedido');
    const cad = d.cadastro() || {}, cus = d.custos() || {};
    const vistos = new Set(), itens = [], semCusto = [];
    let unidades = 0, total = 0;
    for (const it of entrada.slice(0, MAX_ITENS)) {
      const sku = (it && it.sku != null) ? String(it.sku) : '';
      const rot = sku ? ('"' + sku.slice(0, 60) + '"') : '(item sem SKU)';
      if (!sku) { erros.push('há um item sem SKU'); continue; }
      if (vistos.has(sku)) { erros.push('o SKU ' + rot + ' aparece mais de uma vez'); continue; }
      vistos.add(sku);
      const q = (it.quantidade === '' || it.quantidade == null) ? NaN : Number(it.quantidade);
      if (!(Number.isInteger(q) && q > 0 && q <= MAX_QTD)) { erros.push('a quantidade do SKU ' + rot + ' tem de ser um número inteiro maior que zero'); continue; }
      const c = Object.prototype.hasOwnProperty.call(cad, sku) ? cad[sku] : null;
      if (!c || !idValido(c.id)) { erros.push('o SKU ' + rot + ' não tem o cadastro do Bling guardado — recalcule o plano e tente de novo'); continue; }
      const cu = Object.prototype.hasOwnProperty.call(cus, sku) ? cus[sku] : null;
      const custo = (cu && cu.custo != null && cu.custo !== '' && isFinite(Number(cu.custo)) && Number(cu.custo) > 0) ? centavos(cu.custo) : null;
      if (custo == null) semCusto.push(sku);
      const nome = String(c.nome == null ? '' : c.nome).replace(/\s+/g, ' ').trim().slice(0, 120);
      itens.push({ produto: { id: Number(c.id) }, descricao: nome || sku, quantidade: q, valor: custo == null ? 0 : custo });
      unidades += q; total += q * (custo == null ? 0 : custo);
    }
    if (erros.length) return { ok: false, erros };
    const corpo = { data: hoje, fornecedor: { id: Number(fornecedor.id) }, itens };
    if (dataPrevista) corpo.dataPrevista = dataPrevista;
    return { ok: true, corpo, resumo: { fornecedor: fornecedor.nome, data_prevista: dataPrevista, itens: itens.length, unidades, total: centavos(total), sem_custo: semCusto } };
  }

  /* ── o envio ── */
  const _chaves = new Map();   /* chave → { ts, estado:'indo'|'feito', resultado } */
  function lembrar(chave, v) {
    _chaves.delete(chave); _chaves.set(chave, v);   /* vai pro fim: o Map guarda a ordem de chegada */
    const t = agora();
    /* esquece as vencidas e, passando do teto, as mais antigas — nunca uma que está sendo enviada agora */
    for (const [k, x] of _chaves) {
      if (x.estado === 'indo') continue;
      if ((t - x.ts) >= CHAVES_MS || _chaves.size > MAX_CHAVES) _chaves.delete(k);
    }
  }
  async function lancar(pedido, chave) {
    if (typeof chave !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(chave)) return { ok: false, erros: ['pedido sem a chave de envio — recarregue a tela e tente de novo'] };
    const ja = _chaves.get(chave);
    if (ja && (agora() - ja.ts) < CHAVES_MS) {
      if (ja.estado === 'indo') return { ok: false, em_andamento: true };
      return { ok: false, repetido: true, anterior: ja.resultado };
    }
    lembrar(chave, { ts: agora(), estado: 'indo', resultado: null });
    let resultado;
    try {
      const m = await montar(pedido);
      if (!m.ok) { _chaves.delete(chave); return { ok: false, erros: m.erros }; }   /* nada foi enviado: a chave volta a valer */
      const ctl = new AbortController();
      const ESTOUROU = {};
      let timer = null, r;
      const prazo = new Promise((ok) => { timer = setTimeout(() => { ctl.abort(); ok(ESTOUROU); }, prazoMs); });
      try { r = await Promise.race([Promise.resolve().then(() => d.blingWrite('POST', '/pedidos/compras', m.corpo, { semRetryDeRede: true, signal: ctl.signal })), prazo]); }
      catch (e) { r = { ambiguo: true }; }
      finally { clearTimeout(timer); }
      const status = (r && r !== ESTOUROU && Number.isFinite(Number(r.status))) ? Number(r.status) : null;
      const criado = r && r !== ESTOUROU && r.ok && r.data && r.data.data && idValido(r.data.data.id) ? r.data.data : null;
      if (criado) {
        resultado = { ok: true, id: String(criado.id), numero: (criado.numero != null && /^\d{1,12}$/.test(String(criado.numero))) ? Number(criado.numero) : null, resumo: m.resumo };
        try { if (typeof d.aoCriar === 'function') d.aoCriar(resultado); } catch (e) {}
      } else if (r === ESTOUROU || !r || r.ambiguo || status === 0 || status == null || (r.ok && !criado) || status >= 500) {
        /* sem resposta, rede caída, erro do servidor do Bling, ou um "ok" sem o id do pedido: NÃO SEI se criou */
        resultado = { ok: false, ambiguo: true, motivo: (r === ESTOUROU ? 'o Bling não respondeu em ' + Math.round(prazoMs / 1000) + ' s' : (status >= 500 ? 'o Bling respondeu erro ' + status : (r && r.ok ? 'o Bling respondeu sem o número do pedido' : 'a conexão com o Bling caiu'))) +
          ' — NÃO SEI se o pedido foi criado. Confira em Pedidos de Compra no Bling antes de tentar de novo.' };
      } else {
        /* 4xx: o Bling recusou — nada foi criado. 401/403/429 dizem o que é; o resto traz a validação do Bling */
        const motivo = status === 401 ? 'token do Bling recusado — tente de novo em instantes'
          : status === 403 ? 'o app desta empresa no Bling não tem a permissão de Pedidos de Compra'
          : status === 429 ? 'limite do Bling — tente de novo daqui a pouco'
          : 'o Bling recusou o pedido (' + status + ')';
        resultado = { ok: false, recusado: true, status, motivo, bling: recusaDoBling(r.data) };
      }
    } catch (e) {
      resultado = { ok: false, ambiguo: true, motivo: 'erro inesperado no envio — NÃO SEI se o pedido foi criado. Confira em Pedidos de Compra no Bling antes de tentar de novo.' };
    }
    /* recusa clara: nada foi criado, a mesma chave pode tentar de novo (o dono corrige e reenvia). Criado ou "não sei":
       a chave fica gasta. */
    if (resultado.recusado) _chaves.delete(chave);
    else lembrar(chave, { ts: agora(), estado: 'feito', resultado });
    return resultado;
  }

  return { fornecedores, montar, lancar };
}

module.exports = { criar, MAX_ITENS, MAX_QTD, PRAZO_MS, POR_PAGINA, MAX_PAGINAS };
