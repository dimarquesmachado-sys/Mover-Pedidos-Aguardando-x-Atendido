'use strict';

/**
 * Módulos carregados pelo orquestrador — separados em LOJAS e APLICAÇÕES (13/09/2026).
 *
 * A auditoria do Codex apontou o problema com precisão: este arquivo era uma lista só, em
 * que as três empresas conviviam com quinze módulos que não são empresa nenhuma (ponto,
 * imagens, backup, respostas rápidas). Duas consequências ruins:
 *
 *   • quem lia não sabia dizer o que é loja e o que é aplicação auxiliar;
 *   • havia DOIS mecanismos de ativação com semânticas diferentes — `EMPRESAS` no registro
 *     canônico e `SKIP_EMPRESAS` aqui —, então desativar uma loja dependia de qual dos dois
 *     o leitor conhecia.
 *
 * Agora as lojas saem do REGISTRO (contrato-empresas.json) e as aplicações ficam na lista
 * própria. A ativação é uma coisa só: `EMPRESAS` diz quais LOJAS sobem; `SKIP_EMPRESAS`
 * desliga qualquer módulo, loja ou aplicação, por id ou alias — os dois normalizados pelo
 * registro, então "amb" e "ambtotal" valem igual.
 *
 * ⚠️ O que este arquivo NÃO faz, de propósito: criar loja a partir do contrato sem a pasta.
 * Isso é a fábrica de módulo fiscal, o passo seguinte da auditoria. Aqui o ganho é clareza e
 * UM contrato de ativação — sem isso, a fábrica nasceria sobre a mesma ambiguidade.
 */

const _registroLib = require('../lib/empresas/registro');
const _registro = (() => {
  try { return _registroLib.carregar({ servico: 'mover-pedidos' }); }
  catch (e) {
    /* 14/09 (auditoria do Codex, P1) — só o contrato ILEGÍVEL (arquivo ausente, JSON
       quebrado) cai pro modo antigo. Contrato LIDO mas com regra violada (alias colidindo,
       capacidade fora do vocabulário) é bug de configuração: subir mesmo assim é o oposto
       do que a validação existe pra garantir — deixa o erro derrubar o boot. */
    if (e instanceof _registroLib.ContratoInvalidoError) throw e;
    console.warn('[config] registro indisponível (' + (e.message || e) + ') — ativação no modo antigo');
    return null;
  }
})();

/* LOJAS: os módulos fiscais. A chave é o id canônico do contrato; o require continua
   explícito porque a pasta ainda é necessária (ver aviso acima). */
const LOJAS = {
  girassol: () => require('../girassol'),
  ambtotal: () => require('../ambtotal'),
  good: () => require('../good'),
};

/* APLICAÇÕES: tudo o que NÃO é empresa — ferramentas que atendem uma ou mais lojas. */
const APLICACOES = [
  require('../fragil'),
  require('../estoque'),
  require('../estoque-girassol'),
  require('../respostas-rapidas'),
  require('../auto-mensagens'),
  require('../lixas-combinar'),
  require('../good-drive-imagens'),
  require('../amb-drive-imagens'),
  require('../ponto'),
  require('../girassol-backup-offline/gbo-app'),   // 05/08: era require('../girassol-backup-offline') e resolvia pro index.js da pasta.
                                                  // Renomeado pra gbo-app.js porque havia 21 index.js no repo e isso já causou upload na pasta errada.
  require('../good-checkout-offline'),
  require('../amb-checkout-offline'),
  require('../good-mm-diag'),
  require('../good-mm-etiquetas'),
  require('../girassol-mm-etiquetas'),
  require('../backup-github'),
];

/* ── ATIVAÇÃO: um contrato só ────────────────────────────────────────────────── */
const _skipBruto = (process.env.SKIP_EMPRESAS || '').split(',').map(s => s.trim()).filter(Boolean);
const SKIP = new Set(_skipBruto.map(x => (_registro && _registro.normalizar(x)) || x.toLowerCase()));

const extras = [];   /* lojas que nascem do contrato, sem pasta */

function _lojasAtivas() {
  const ids = Object.keys(LOJAS);
  let escolhidas = ids;
  if (_registro) {
    /* EMPRESAS com typo ou empresa fora do contrato tem que ABORTAR o boot, não subir
       "todas as lojas conhecidas" — isso seria abrir rotas e crons de lojas que o deploy
       pediu pra NÃO ligar. Falha alto e não se recupera: deixa o erro subir. */
    const ativas = _registro.ativas();
    escolhidas = ativas.map(e => e.id).filter(id => ids.includes(id));
    /* loja no contrato e ativa na env, mas sem pasta aqui: avisa ALTO em vez de sumir em
       silêncio — é exatamente o caso da "quarta empresa" enquanto a fábrica não existe. */
    /* 14/09 — loja no contrato SEM pasta agora é MONTADA a partir do registro, em vez de só
       avisada. É o critério de aceitação da auditoria: empresa nova entra com registro e
       credenciais, sem pasta e sem editar JavaScript. As três existentes seguem com as
       pastas delas de propósito: carregam história (caminho de token relativo ao módulo, env
       sem prefixo, estratégia própria de retentativa no F1) que o montador não deve
       adivinhar — e adivinhar aqui custaria token perdido no meio do expediente. */
    /* 15/09 (P1 do Codex) — o catch aqui embaixo engolia o erro de montagem: logava e
       seguia o boot sem a empresa, mesmo pra erro de CONFIGURAÇÃO (ex.: falta ME_LOJA_IDS).
       Isso contradiz o resto deste arquivo — EMPRESAS inválida já aborta o boot (ver acima)
       — e contradiz o que o guard de ME_LOJA_IDS promete: "a montagem falha no boot em vez
       de a empresa ignorar todos os pedidos em silêncio". Empresa ativa e no contrato que
       não consegue montar é configuração quebrada: deixa o erro subir e derrubar o boot,
       não vira loja fantasma sem rotas nem crons. */
    for (const e of ativas) {
      if (!ids.includes(e.id)) {
        const { montarEmpresa } = require('../lib/fiscal/montar-empresa');
        const ocupados = ids.map(k => { try { return Number(String(LOJAS[k]().crons.nfeMl).split(',')[0]); } catch (e2) { return null; } })
                            .filter(n => n != null && !isNaN(n));
        extras.push(montarEmpresa(e.id, { registro: _registro, ocupadosF3: ocupados }));
        console.log('[config] loja "' + e.id + '" montada a partir do contrato (sem pasta)');
      }
    }
  }
  return escolhidas.filter(id => {
    if (SKIP.has(id)) { console.log('[config] loja "' + id + '" pulada (SKIP_EMPRESAS)'); return false; }
    return true;
  });
}

const lojas = _lojasAtivas().map(id => LOJAS[id]()).concat(extras);

const aplicacoes = APLICACOES.filter(m => {
  const id = String((m && m.id) || '').toLowerCase();
  const canon = (_registro && _registro.normalizar(id)) || id;
  if (SKIP.has(id) || SKIP.has(canon)) { console.log('[config] aplicação "' + id + '" pulada (SKIP_EMPRESAS)'); return false; }
  return true;
});

console.log('[config] lojas: ' + (lojas.map(l => l.id).join(', ') || '(nenhuma)') + ' | aplicações: ' + aplicacoes.length);

/* o orquestrador continua recebendo UMA lista — a separação é de leitura e de ativação, não
   de contrato com quem consome. */
module.exports = lojas.concat(aplicacoes);
module.exports.lojas = lojas;
module.exports.aplicacoes = aplicacoes;
