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
  canais_de_venda: {
    para: 'ME_LOJA_IDS — quais canais o F1 considera do Mercado Livre',
    caminhos: ['/canais-de-venda', '/lojas'],
  },
  depositos: {
    para: 'depósitos (Geral, Defeitos, os de Fulfillment de cada marketplace)',
    caminhos: ['/depositos'],
  },
  situacoes: {
    para: 'SIT_ATENDIDO / SIT_AGUARDANDO / SIT_VERIFICADO — os ids que o fluxo move',
    caminhos: ['/situacoes/modulos', '/situacoes'],
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

  async function descobrir() {
    const saida = { empresa: rotulo, em: new Date().toISOString(), recursos: {} };
    for (const [nome, spec] of Object.entries(RECURSOS)) {
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
      saida.recursos[nome] = {
        para: spec.para, ok: true, caminho: r.caminho,
        itens: lista.map(_resumir).filter(Boolean),
      };
    }
    return saida;
  }

  return { descobrir, RECURSOS };
}

module.exports = { criar, RECURSOS };
