'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   TOKEN DOS MÓDULOS SATÉLITES — GRAVAR SEM PERDER O QUE FUNCIONAVA (26/11/2026).

   O aviso "Token do Bling vencido em um módulo" acendeu no Frágil com: "arquivo de token existe mas está sem
   refresh_token". Os seis gerenciadores satélites (frágil, estoque, estoque-girassol, lixas-combinar, amb-drive-imagens,
   good-drive-imagens) gravavam o que o Bling devolvesse, sem olhar:
     · resposta do OAuth SEM os tokens (corpo vazio "{}", ou só um dos dois) → o arquivo virava `{}` — JSON.stringify
       some com campo undefined — e o refresh_token que funcionava era APAGADO: módulo fora do ar até reautorizar à mão;
     · gravação direta no arquivo: um reinício no meio da escrita deixava o arquivo truncado (lido como `{}`).
   Os gerenciadores fiscais (lib/fiscal) já gravam com temporário + rename desde 14/10.

   salvarTokensSatelite(arquivo, access_token, refresh_token, rotulo)
     · os dois têm de ser texto não vazio — senão LANÇA erro e o arquivo fica como estava (quem chama já trata erro de
       renovação: tenta de novo depois, com o refresh_token antigo ainda no disco);
     · grava com temporário + rename (lib/escrita-atomica, que também cria a pasta), permissão só do dono.
   A mensagem de erro diz QUAL faltou, nunca o valor de token nenhum.
   ───────────────────────────────────────────────────────────────────────── */
function textoCheio(v) { return typeof v === 'string' && v.trim().length > 0; }

function salvarTokensSatelite(arquivo, access_token, refresh_token, rotulo) {
  const falta = [];
  if (!textoCheio(access_token)) falta.push('access_token');
  if (!textoCheio(refresh_token)) falta.push('refresh_token');
  if (falta.length) {
    throw new Error('[' + (rotulo || 'tokenManager') + '] o Bling respondeu sem ' + falta.join(' e sem ') + ' — nada foi gravado; o token que estava no disco foi mantido');
  }
  require('./escrita-atomica').gravarAtomico(arquivo, JSON.stringify({ access_token, refresh_token }, null, 2), { sincronizar: true, modo: 0o600 });
}

module.exports = { salvarTokensSatelite };
