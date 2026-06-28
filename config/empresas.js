'use strict';

/**
 * Lista de empresas ATIVAS no orquestrador.
 *
 * Para adicionar uma nova empresa no futuro:
 *  1. Cria a pasta da empresa (ex: /good) com os arquivos do módulo
 *  2. Adiciona uma linha aqui requerendo o módulo
 *  3. Configura as env vars correspondentes no Render
 *
 * Para desativar uma empresa temporariamente: comenta a linha aqui.
 *
 * rev 27/06/2026 — good-checkout-offline restaurado (tinha sido sobrescrito)
 *                  + good-mm-etiquetas (uma vez só).
 */

const empresas = [
  require('../girassol'),
  require('../ambtotal'),
  require('../good'),
  require('../fragil'),
  require('../estoque'),
  require('../estoque-girassol'),
  require('../respostas-rapidas'),
  require('../auto-mensagens'),
  require('../lixas-combinar'),
  require('../good-drive-imagens'),
  require('../amb-drive-imagens'),
  require('../ponto'),
  require('../girassol-backup-offline'),
  require('../good-checkout-offline'),
  require('../good-mm-diag'),
  require('../good-mm-etiquetas'),
];

// Filtra empresas marcadas como inativas via env var (ex: SKIP_EMPRESAS=girassol,good)
const SKIP = (process.env.SKIP_EMPRESAS || '').split(',').map(s => s.trim()).filter(Boolean);

module.exports = empresas.filter(e => {
  if (SKIP.includes(e.id)) {
    console.log(`[config] Empresa "${e.id}" pulada (SKIP_EMPRESAS)`);
    return false;
  }
  return true;
});
