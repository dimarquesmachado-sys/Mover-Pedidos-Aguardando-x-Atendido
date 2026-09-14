'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   REGISTRO CANÔNICO DE EMPRESAS (13/09/2026).

   Nasce da auditoria multiloja que o dono pediu ao Codex. O achado central dela:
   a identidade de empresa tinha TRÊS fontes com semânticas incompatíveis —
   contrato-empresas.json diz que o id é `ambtotal` e `amb` é alias, lib/empresas.js
   trata `amb` como chave operacional com um mapa fixo de compat, e
   config/empresas.js mistura empresas com módulos que não são empresas (ponto,
   imagens, backup). Com isso, uma parte do sistema aceita uma loja que a outra
   recusa, e desativar por alias não desativa o módulo cujo id é o canônico.

   Aqui o CONTRATO passa a ser a única fonte da verdade. O código não guarda mais
   lista de empresa nenhuma: ele lê, valida e normaliza. Alias é coisa de BORDA
   (HTTP e env histórica); por dentro só circula id canônico.

   O que este módulo deliberadamente NÃO faz: mudar fluxo de produção. Ele é a
   base pras fábricas que vêm depois (fiscal, checkout) — construir factory sobre
   ids divergentes seria erguer parede em fundação torta.
   ──────────────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const path = require('path');

const CAMINHO_PADRAO = path.join(__dirname, '..', '..', 'contrato-empresas.json');

/* 14/09 (auditoria do Codex, P1) — distingue "não deu pra ler o contrato" (arquivo ausente,
   JSON quebrado) de "contrato lido, mas o CONTEÚDO viola uma regra" (alias colidindo,
   capacidade fora do vocabulário, etc). Quem chama `carregar()` decide o que fazer com cada
   caso, mas confundir os dois foi o bug: os dois caíam no mesmo catch genérico e o serviço
   subia com um contrato inválido, silenciosamente, em modo antigo. */
class ContratoInvalidoError extends Error {}

/* 14/09 (auditoria, P2) — VOCABULÁRIO FECHADO de capacidades. Sem isto, um erro de digitação
   no contrato ("shoppe", "tik-tok") viraria recurso silenciosamente desligado: temCapacidade
   devolveria false e ninguém saberia por quê. Capacidade nova entra AQUI de propósito, num
   commit que alguém revisa — é o mesmo princípio do teste que vira guarda. */
const CAPACIDADES_CONHECIDAS = new Set([
  'fiscal', 'checkout', 'ml', 'ml-full', 'shopee', 'magalu', 'tiktok', 'madeira-madeira',
]);

function _lerContrato(caminho) {
  const arq = caminho || process.env.CONTRATO_EMPRESAS_ARQ || CAMINHO_PADRAO;
  let cru;
  try {
    cru = JSON.parse(fs.readFileSync(arq, 'utf8'));
  } catch (e) {
    throw new Error('registro de empresas: não consegui ler o contrato em ' + arq + ' (' + (e.message || e) + ')');
  }
  /* Codex #423 (P1): `typeof null === 'object'`, então um contrato com "empresas": null
     passava por aqui e só quebrava adiante, com mensagem de leitura — culpando o arquivo
     que foi lido sem problema. E a diferença importa pro diagnóstico: "não consegui ler" e
     "li, mas está sem empresas" mandam procurar em lugares diferentes. */
  if (!cru || typeof cru !== 'object') {
    throw new Error('registro de empresas: o contrato em ' + arq + ' não é um objeto JSON');
  }
  if (!cru.empresas || typeof cru.empresas !== 'object' || Array.isArray(cru.empresas) || !Object.keys(cru.empresas).length) {
    throw new Error('registro de empresas: o contrato em ' + arq + ' foi LIDO, mas o bloco `empresas` está ausente, vazio ou não é um objeto');
  }
  return cru;
}

/* Valida o que faria a quarta empresa quebrar silenciosamente mais tarde: id ausente,
   alias repetido entre empresas, slug ou sufixo de tabela colidindo. Falha ALTO e no
   boot — a auditoria foi explícita: nada de recurso meio ligado. */
function _validar(empresas, capacidadesConhecidas) {
  const porAlias = new Map();
  const slugs = new Map();
  const tabelas = new Map();
  for (const [chave, e] of Object.entries(empresas)) {
    const id = String(e && e.id_canonico || '').trim();
    if (!id) throw new ContratoInvalidoError('registro: empresa "' + chave + '" sem id_canonico');
    if (chave !== id) throw new ContratoInvalidoError('registro: a chave "' + chave + '" difere do id_canonico "' + id + '"');

    const aliases = new Set([id, ...(Array.isArray(e.aliases) ? e.aliases : [])].map(a => String(a).toLowerCase().trim()).filter(Boolean));
    for (const a of aliases) {
      if (porAlias.has(a) && porAlias.get(a) !== id) {
        throw new ContratoInvalidoError('registro: o alias "' + a + '" aponta pra duas empresas (' + porAlias.get(a) + ' e ' + id + ')');
      }
      porAlias.set(a, id);
    }
    const slug = String(e.slug_http || '').trim().toLowerCase();
    if (slug) {
      if (slugs.has(slug) && slugs.get(slug) !== id) throw new ContratoInvalidoError('registro: slug_http "' + slug + '" colide entre ' + slugs.get(slug) + ' e ' + id);
      slugs.set(slug, id);
    }
    /* capacidade fora do vocabulário FALHA no boot: melhor não subir do que subir com um
       recurso desligado por engano de digitação. E a declaração em si é OBRIGATÓRIA: sem
       isso, uma 4ª empresa que esquecesse (ou digitasse errado) o nome do campo passava
       batido pela checagem abaixo e temCapacidade() voltava a devolver null pra ela — a
       ambiguidade que este commit existe pra eliminar (achado do Codex, P2). */
    if (capacidadesConhecidas) {
      if (!Array.isArray(e.capacidades)) {
        throw new ContratoInvalidoError('registro: empresa "' + id + '" não declara `capacidades` (lista obrigatória, mesmo vazia)');
      }
      const fora = e.capacidades.filter(c => !capacidadesConhecidas.has(String(c)));
      if (fora.length) throw new ContratoInvalidoError('registro: capacidade desconhecida em "' + id + '": ' + fora.join(', '));
    }
    const tab = String(e.sufixo_tabelas || '').trim().toLowerCase();
    if (tab) {
      if (tabelas.has(tab) && tabelas.get(tab) !== id) throw new ContratoInvalidoError('registro: sufixo_tabelas "' + tab + '" colide entre ' + tabelas.get(tab) + ' e ' + id);
      tabelas.set(tab, id);
    }
  }
  return porAlias;
}

/**
 * Carrega o registro. `servico` diz qual prefixo de env histórico vale aqui (o mesmo
 * CNPJ usa nomes diferentes em repos diferentes, e o contrato guarda os dois).
 * `ativas` é SÓ filtro de ativação deste deploy — nunca cadastro implícito: empresa
 * que não está no contrato não passa a existir por aparecer na env.
 */
function carregar(opcoes) {
  const { caminho, servico = 'mover-pedidos', ativas } = opcoes || {};
  const contrato = _lerContrato(caminho);
  const porAlias = _validar(contrato.empresas, CAPACIDADES_CONHECIDAS);

  function normalizar(idOuAlias) {
    const a = String(idOuAlias || '').toLowerCase().trim().replace(/^\//, '');
    return porAlias.get(a) || null;
  }

  function obter(idOuAlias) {
    const id = normalizar(idOuAlias);
    if (!id) return null;
    const e = contrato.empresas[id];
    return {
      id,
      nome: e.nome || id,
      aliases: Array.isArray(e.aliases) ? e.aliases.slice() : [],
      slugHttp: e.slug_http || ('/' + id),
      /* atenção ao `!= null`: prefixo histórico VAZIO é um valor, não ausência — com `||`
         a Girassol no Mover-Pedidos cairia no padrão GIRASSOL_ e todas as envs dela
         apontariam pra nomes inexistentes. */
      prefixoEnv: (e.prefixo_env_historico && e.prefixo_env_historico[servico] != null)
        ? e.prefixo_env_historico[servico]
        : (e.prefixo_env || (id.toUpperCase() + '_')),
      prefixoFiscal: e.prefixo_fiscal || e.prefixo_env || (id.toUpperCase() + '_'),
      sufixoTabelas: e.sufixo_tabelas || ('_' + id),
      contas: Object.assign({}, e.conta_marketplace || {}),
      donoHoje: Object.assign({}, e.dono_hoje || {}),
    };
  }

  /* a lista de ativação vem da env (filtro), mas passa pelo registro: alias desconhecido
     é ERRO declarado, não empresa nova nascendo por descuido de digitação. */
  function ativasNoDeploy() {
    const bruto = (ativas != null ? ativas : process.env.EMPRESAS);
    const ids = Object.keys(contrato.empresas);
    if (!bruto) return ids.map(obter);
    const pedidas = String(bruto).split(',').map(s => s.trim()).filter(Boolean);
    const fora = pedidas.filter(p => !normalizar(p));
    if (fora.length) throw new Error('registro: EMPRESAS cita empresa que não está no contrato: ' + fora.join(', '));
    const vistos = new Set();
    return pedidas.map(normalizar).filter(id => (vistos.has(id) ? false : vistos.add(id))).map(obter);
  }

  /** Nome de env por empresa, com o prefixo do serviço — sem mapa fixo em código.
      O prefixo VAZIO é legítimo e o contrato o registra: a Girassol foi a 1ª empresa do
      Mover-Pedidos e as envs dela nasceram sem prefixo (BLING_CLIENT_ID), enquanto no
      Devoluções ela é nova e entra no padrão. Forçar underscore aqui inventaria uma env
      que não existe — foi o primeiro erro que este registro quase cometeu. */
  function nomeEnv(idOuAlias, sufixo) {
    const e = obter(idOuAlias);
    if (!e) return null;
    const suf = String(sufixo || '').replace(/^_/, '');
    const pre = String(e.prefixoEnv || '');
    if (!pre) return suf;
    return pre.replace(/_?$/, '_') + suf;
  }

  function temCapacidade(idOuAlias, capacidade) {
    const e = obter(idOuAlias);
    if (!e) return false;
    const c = contrato.empresas[e.id].capacidades;
    if (!Array.isArray(c)) return null;   // o contrato ainda não declara: quem chama decide
    return c.indexOf(String(capacidade)) >= 0;
  }

  return { normalizar, obter, ativas: ativasNoDeploy, nomeEnv, temCapacidade, versao: contrato.versao || null };
}

module.exports = { carregar, ContratoInvalidoError };
