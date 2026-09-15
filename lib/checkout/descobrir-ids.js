'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   DESCOBRIR OS IDs DA EMPRESA NO BLING (15/09/2026).

   Pedido do dono em 26/08, que ficou na fila e ele repetiu hoje:

     "É algo que ao adicionar CNPJ de empresa nova deveria tá sempre buscando e
      pegando. Ou até conseguir consultar de tempos em tempos."

   Hoje esses ids são mapeados NO DEVTOOLS, à mão, abrindo tela por tela do Bling
   — foi assim que as unidades e depósitos da AMB entraram no arquivo de
   referência. É a maior fonte de digitação no embarque de uma empresa nova, e a
   que mais erra: id de FILIAL e id de UNIDADE DE NEGÓCIO são espaços diferentes, e
   confundir os dois já aconteceu (eu mesmo indiquei a filial quando era a unidade).

   O que esta peça faz: pergunta ao Bling, com o token que a empresa JÁ tem depois
   do OAuth, e devolve os ids prontos pra colar — canais de venda, depósitos e
   situações de pedido.

   Uma decisão importante de desenho: ela NÃO presume que sabe os caminhos da API.
   Cada recurso tem uma lista de caminhos CANDIDATOS e ela reporta qual respondeu e
   qual não existe. Chutar um caminho e tratar 404 como "não tem nada" seria dizer
   ao dono que a empresa não tem depósito — o tipo de mentira que custa horas.
   ──────────────────────────────────────────────────────────────────────────── */

/* candidatos por recurso: o primeiro que responder 200 vale. A ordem vai do mais
   provável ao menos, e o resultado diz qual funcionou — assim o próximo a mexer
   aqui não precisa adivinhar de novo. */
const RECURSOS = {
  /* 15/09, com dado real da AMB: /canais-de-venda e /lojas deram 404 nos dois. Em vez de
     continuar chutando caminho, descobrimos pelos PEDIDOS — cada pedido traz `loja: {id,
     nome}`, e esse endpoint a gente sabe que funciona porque o F1 usa o dia todo. É mais
     confiável que adivinhar rota: mostra os canais que a empresa REALMENTE usa, com o nome
     que aparece no Bling. */
  canais_de_venda: {
    para: 'ME_LOJA_IDS — quais canais o F1 considera do Mercado Livre',
    caminhos: [],
    derivar: 'pedidos',
  },
  depositos: {
    para: 'depósitos (Geral, Defeitos, os de Fulfillment de cada marketplace)',
    caminhos: ['/depositos'],
  },
  /* 15/09: /situacoes/modulos respondeu, mas devolve os MÓDULOS (Pedidos de Venda, Ordens de
     Produção), não as situações. As situações vêm num segundo passo, pelo id do módulo — o
     que interessa aqui é o de Pedidos de Venda. */
  situacoes: {
    para: 'SIT_ATENDIDO / SIT_AGUARDANDO / SIT_VERIFICADO — os ids que o fluxo move',
    caminhos: ['/situacoes/modulos'],
    seguirModulo: /pedidos?\s+de\s+venda/i,
  },
};

function criar(cfg) {
  for (const n of ['rotulo', 'blingGet']) {
    if (!cfg || cfg[n] == null) throw new Error('lib/checkout/descobrir-ids: falta ' + n);
  }
  const { rotulo, blingGet } = cfg;

  async function _tentar(caminhos) {
    const tentativas = [];
    for (const c of caminhos) {
      let r;
      try { r = await blingGet(c); } catch (e) { tentativas.push({ caminho: c, erro: String(e.message || e).slice(0, 120) }); continue; }
      const status = Number(r && r.status);
      const dados = r && r.data && (r.data.data || r.data);
      if (status === 200 && dados) return { caminho: c, dados, tentativas };
      tentativas.push({ caminho: c, status: status || null });
    }
    return { caminho: null, dados: null, tentativas };
  }

  /* nomes variam entre recursos do Bling; pegar o que existir em vez de exigir um
     formato — o objetivo é o dono ler a lista, não o código adivinhar o esquema. */
  function _resumir(item) {
    if (!item || typeof item !== 'object') return null;
    const id = item.id != null ? item.id : (item.idDeposito != null ? item.idDeposito : item.codigo);
    const nome = item.descricao || item.nome || item.titulo || item.situacao || null;
    const extra = {};
    for (const k of ['tipo', 'situacao', 'padrao', 'idModulo', 'modulo']) if (item[k] != null) extra[k] = item[k];
    return id == null && !nome ? null : Object.assign({ id, nome }, extra);
  }

  /* canais de venda a partir dos PEDIDOS: varre as últimas páginas e junta os `loja` que
     aparecem. Dá os canais que a empresa REALMENTE usa, com o nome do Bling — e sem depender
     de adivinhar uma rota que deu 404. */
  async function _canaisPelosPedidos() {
    const vistos = new Map();
    for (let pag = 1; pag <= 3; pag++) {
      let r;
      try { r = await blingGet('/pedidos/vendas?pagina=' + pag + '&limite=100'); } catch (e) { break; }
      const lista = (r && r.data && r.data.data) || [];
      if (!lista.length) break;
      for (const p of lista) {
        const l = p && p.loja;
        if (!l || l.id == null) continue;
        const k = String(l.id);
        const at = vistos.get(k) || { id: l.id, nome: l.nome || l.descricao || null, pedidos: 0 };
        at.pedidos++;
        if (!at.nome && (l.nome || l.descricao)) at.nome = l.nome || l.descricao;
        vistos.set(k, at);
      }
    }
    return [...vistos.values()].sort((a, b) => b.pedidos - a.pedidos);
  }

  /* situações do módulo de Pedidos de Venda: o /situacoes/modulos devolve os módulos, e as
     situações vêm num segundo passo pelo id dele. */
  async function _situacoesDoModulo(modulos, padrao) {
    const mod = (modulos || []).find(m => padrao.test(String(m.nome || '')));
    if (!mod || mod.id == null) return { erro: 'não achei o módulo de Pedidos de Venda entre: ' + (modulos || []).map(m => m.nome).join(', ') };
    let r;
    try { r = await blingGet('/situacoes/modulos/' + mod.id); } catch (e) { return { erro: String(e.message || e).slice(0, 120) }; }
    if (Number(r && r.status) !== 200) return { erro: 'HTTP ' + (r && r.status) + ' em /situacoes/modulos/' + mod.id };
    const lista = (r.data && (r.data.data || r.data)) || [];
    return { modulo: { id: mod.id, nome: mod.nome }, itens: (Array.isArray(lista) ? lista : [lista]).map(_resumir).filter(Boolean) };
  }

  /* 15/09, do retorno real da AMB: os pedidos trazem `loja.id` mas NÃO o nome — e sem nome o
     dono olha uma lista de números e não sabe qual é o do ML. Mas os DEPÓSITOS nomeiam os
     canais: "Shopee 206017368 (Fulfillment)", "Magalu 206018666 (Fulfillment)". Cruzar os
     dois dá nome a parte dos canais sem pedir nada a ninguém. */
  function _nomearCanais(canais, depositos) {
    const porId = new Map();
    for (const d of depositos || []) {
      const m = String(d.nome || '').match(/(\d{6,})/);
      if (!m) continue;
      const marca = String(d.nome).replace(/\s*\d{6,}\s*/, ' ').replace(/\(.*?\)/g, '').trim();
      if (marca) porId.set(m[1], marca);
    }
    return canais.map(c => {
      const nome = c.nome || porId.get(String(c.id)) || null;
      return Object.assign({}, c, {
        nome,
        /* o canal mais usado que NÃO foi nomeado pelos depósitos é, na prática, o do
           marketplace principal — mas isso é palpite, e vai marcado como palpite. */
        obs: nome ? 'nome vindo do depósito com o mesmo id' : null,
      });
    });
  }

  /* Sugere o valor de cada env a partir do que foi descoberto, casando pelo NOME da
     situação. É o passo que tira a digitação: em vez de o dono ler uma lista de ids e
     descobrir qual é qual, ele recebe as linhas prontas pra colar no Render. */
  function _sugerirEnvs(prefixo, situacoes, canais) {
    const acha = (padrao) => {
      const s = (situacoes || []).find(x => padrao.test(String(x.nome || '')));
      return s ? s.id : null;
    };
    const env = {};
    const mapa = [
      ['SITUACAO_ATENDIDO', /^atendido$/i],
      ['SITUACAO_AGUARDANDO', /^aguardando$/i],
      ['SITUACAO_DESPACHADOS', /^despachados?$/i],
      ['SITUACAO_VERIFICADO', /^verificado$/i],
    ];
    const naoAchei = [];
    for (const [suf, padrao] of mapa) {
      const id = acha(padrao);
      if (id != null) env[prefixo + suf] = String(id);
      else naoAchei.push(suf);
    }
    /* canais: o dono escolhe qual é o do ML. Sugerimos o mais usado SEM nome de outro
       marketplace — e deixamos explícito que é sugestão, não certeza. */
    const semMarca = (canais || []).filter(c => !/shopee|magalu|tiktok|amazon/i.test(String(c.nome || '')));
    if (semMarca.length) {
      env[prefixo + 'ME_LOJA_IDS'] = String(semMarca[0].id);
    }
    return {
      colar_no_render: env,
      confira: semMarca.length
        ? 'ME_LOJA_IDS foi o canal mais usado que NÃO é Shopee/Magalu/TikTok — confirme que é mesmo o do Mercado Livre antes de colar'
        : 'não consegui sugerir ME_LOJA_IDS: todos os canais foram nomeados como outro marketplace',
      nao_encontrei: naoAchei,
    };
  }

  /* 15/09 — IDENTIDADE NOS MARKETPLACES. O /users/me do ML já é chamado 8 a 10 vezes
     espalhadas por empresa pra perguntar "quem sou eu", e a GOOD não chama nenhuma — ela
     simplesmente não sabe o próprio seller id. No embarque isso é o dado que fecha o ciclo:
     depois do OAuth, dá pra perguntar uma vez e ter certeza de que o token é da conta certa.
     Opcional de propósito: sem o token, o resto da descoberta continua valendo. */
  async function _identidadeML() {
    if (!cfg.garantirTokenML) return { ok: false, leia: 'o token do ML não foi passado pra esta rota' };
    let token;
    try { token = await cfg.garantirTokenML(); } catch (e) { return { ok: false, erro: String(e.message || e).slice(0, 120) }; }
    try {
      const r = await fetch('https://api.mercadolibre.com/users/me', { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) return { ok: false, erro: 'HTTP ' + r.status + ' em /users/me' };
      const d = await r.json();
      return {
        ok: true,
        seller_id: d.id,
        apelido: d.nickname || null,
        site: d.site_id || null,
        /* o e-mail confirma pra o dono que é a CONTA certa — o erro caro aqui não é errar o
           id, é autorizar a conta de outra empresa e só descobrir depois. */
        email: d.email || null,
      };
    } catch (e) { return { ok: false, erro: String(e.message || e).slice(0, 120) }; }
  }

  async function descobrir() {
    const saida = { empresa: rotulo, em: new Date().toISOString(), recursos: {} };
    for (const [nome, spec] of Object.entries(RECURSOS)) {
      if (spec.derivar === 'pedidos') {
        const canais = await _canaisPelosPedidos();
        saida.recursos[nome] = canais.length
          ? { para: spec.para, ok: true, via: 'pedidos recentes (as rotas /canais-de-venda e /lojas dão 404)', itens: canais,
              leia: 'ME_LOJA_IDS desta empresa = o(s) id(s) cujo nome é do Mercado Livre' }
          : { para: spec.para, ok: false, via: 'pedidos recentes', leia: 'nenhum pedido recente trouxe `loja` — a empresa tem vendas nos últimos dias?' };
        continue;
      }
      const r = await _tentar(spec.caminhos);
      if (!r.dados) {
        saida.recursos[nome] = {
          para: spec.para, ok: false,
          /* dizer o que foi TENTADO é o que evita a próxima pessoa repetir o chute */
          tentei: r.tentativas,
          leia: 'nenhum caminho respondeu — confira se o app do Bling desta empresa tem permissão pra este recurso',
        };
        continue;
      }
      const lista = Array.isArray(r.dados) ? r.dados : [r.dados];
      const itens = lista.map(_resumir).filter(Boolean);

      if (spec.seguirModulo) {
        const sit = await _situacoesDoModulo(itens, spec.seguirModulo);
        saida.recursos[nome] = sit.erro
          ? { para: spec.para, ok: false, caminho: r.caminho, modulos: itens, erro: sit.erro }
          : { para: spec.para, ok: true, caminho: '/situacoes/modulos/' + sit.modulo.id, modulo: sit.modulo, itens: sit.itens };
        continue;
      }

      saida.recursos[nome] = { para: spec.para, ok: true, caminho: r.caminho, itens };
    }

    saida.recursos.mercado_livre = Object.assign(
      { para: 'seller id da conta do ML — confirma que o token autorizado é o da empresa certa' },
      await _identidadeML());

    /* cruzamentos e sugestão: só depois de tudo descoberto */
    const cn = saida.recursos.canais_de_venda, dp = saida.recursos.depositos, st = saida.recursos.situacoes;
    if (cn && cn.ok && dp && dp.ok) cn.itens = _nomearCanais(cn.itens, dp.itens);
    if (cfg.prefixoEnv != null) {
      saida.sugestao = _sugerirEnvs(cfg.prefixoEnv, (st && st.ok) ? st.itens : [], (cn && cn.ok) ? cn.itens : []);
    }
    return saida;
  }

  return { descobrir, RECURSOS };
}

module.exports = { criar, RECURSOS };
