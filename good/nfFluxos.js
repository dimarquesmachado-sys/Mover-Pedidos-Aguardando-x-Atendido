'use strict';

// ──────────────────────────────────────────────────────────────────────
// Fluxo de correção de NFs pendentes (cidade, IE, endereço curto)
// + Retry SEFAZ (timeout/indisponibilidade) integrado
// Roda a cada 5 minutos das 06h às 23h via cron no index.js
// ──────────────────────────────────────────────────────────────────────

const { garantirTokenNF, renovarTokenNF } = require('./nfTokenManager');
const {
  sleepNF,
  getNFsParaCorrigir, getNFDetalhe, salvarNF, enviarNF,
  getContato, atualizarIEContato,
  getCidadePorCEP, getIEPorCNPJ
} = require('./nfBlingApi');

let _rodandoNF = false;

// ── Estado de retry SEFAZ em memória ─────────────────────────────────
// Mapa { idNF: { tentativas: N, ultimaTentativaTs: ms } }
// Limita reenvios pra não pingar SEFAZ infinitamente em NF com erro real.
//
// Backoff progressivo — espera mínima ANTES de cada tentativa:
//   tentativa 1: 0 min   (imediato)
//   tentativa 2: 15 min
//   tentativa 3: 15 min
//   tentativa 4: 15 min
//   tentativa 5: 15 min
//   tentativa 6: 1h
//   tentativa 7: 2h
//   tentativa 8: 2h
// Total: 8 tentativas cobrindo até ~6h após o erro inicial.
const _retrySEFAZ = new Map();
const RETRY_BACKOFF_MS = [
  0,                  // tentativa 1 — imediato
  15 * 60 * 1000,     // tentativa 2 — +15min
  15 * 60 * 1000,     // tentativa 3 — +15min
  15 * 60 * 1000,     // tentativa 4 — +15min
  15 * 60 * 1000,     // tentativa 5 — +15min
  60 * 60 * 1000,     // tentativa 6 — +1h
  2 * 60 * 60 * 1000, // tentativa 7 — +2h
  2 * 60 * 60 * 1000  // tentativa 8 — +2h
];
const RETRY_MAX_TENTATIVAS = RETRY_BACKOFF_MS.length;     // 8
const RETRY_LIMPEZA_MS     = 24 * 60 * 60 * 1000;          // limpa registros >24h

// ── Cooldown por NF ───────────────────────────────────────────────────
// Evita re-buscar o detalhe (chamada Bling) toda rodada de NFs que NAO
// precisaram de acao: autorizada (2), denegada (5), retry SEFAZ bloqueado,
// ou que deram erro/429. Sem isso o corrigirNFs martela o Bling a cada 5 min
// nas mesmas NFs presas -> HTTP 429 em loop. Cooldown padrao 30 min (env).
const NF_COOLDOWN_MIN = Number(process.env.GOOD_NF_COOLDOWN_MIN || 30);
const _nfCooldown = new Map(); // idNF -> ts (ms) ate quando pular
function _emCooldownNF(idNF) {
  const ate = _nfCooldown.get(idNF);
  return !!ate && Date.now() < ate;
}
function _cooldownNF(idNF) {
  _nfCooldown.set(idNF, Date.now() + NF_COOLDOWN_MIN * 60 * 1000);
}

function _limparRetriesAntigos() {
  const agora = Date.now();
  for (const [id, info] of _retrySEFAZ.entries()) {
    if (agora - info.ultimaTentativaTs > RETRY_LIMPEZA_MS) {
      _retrySEFAZ.delete(id);
    }
  }
  for (const [id, ate] of _nfCooldown.entries()) {
    if (agora > ate) _nfCooldown.delete(id);
  }
}

function _podeReenviarSEFAZ(idNF) {
  const info = _retrySEFAZ.get(idNF);
  if (!info) return { ok: true, tentativas: 0 };
  if (info.tentativas >= RETRY_MAX_TENTATIVAS) {
    return { ok: false, motivo: `máx tentativas (${RETRY_MAX_TENTATIVAS}) atingido`, tentativas: info.tentativas };
  }
  // Próxima tentativa = info.tentativas + 1 (1-indexed); backoff exigido = RETRY_BACKOFF_MS[info.tentativas]
  const esperaExigida = RETRY_BACKOFF_MS[info.tentativas] || 0;
  const desde = Date.now() - info.ultimaTentativaTs;
  if (desde < esperaExigida) {
    const restanteMin = Math.ceil((esperaExigida - desde) / 60000);
    return { ok: false, motivo: `aguardando ${restanteMin}min pro retry #${info.tentativas + 1}`, tentativas: info.tentativas };
  }
  return { ok: true, tentativas: info.tentativas };
}

function _registrarTentativaSEFAZ(idNF) {
  const info = _retrySEFAZ.get(idNF) || { tentativas: 0, ultimaTentativaTs: 0 };
  info.tentativas++;
  info.ultimaTentativaTs = Date.now();
  _retrySEFAZ.set(idNF, info);
}

async function corrigirNFsPendentes() {
  if (_rodandoNF) {
    console.log('[corrigirNFs] Já em execução — pulando');
    return;
  }
  _rodandoNF = true;
  _limparRetriesAntigos();

  try {
    let token;
    try {
      token = await garantirTokenNF();
    } catch (e) {
      if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') token = await renovarTokenNF();
      else throw e;
    }

    const nfs = await getNFsParaCorrigir(token);
    console.log(`[corrigirNFs] ${nfs.length} NFs para verificar`);

    let corrigidas = 0, reenviadasSEFAZ = 0, ignoradas = 0, erros = 0;
    const agora = new Date();

    for (const nf of nfs) {
      let acaoTomada = false;
      try {
        // Filtra NFs com menos de 5 minutos
        const dataEmissao = new Date(nf.dataEmissao || nf.data);
        const minutos = (agora - dataEmissao) / 1000 / 60;
        if (minutos < 5) {
          console.log(`[corrigirNFs] NF ${nf.id} tem ${minutos.toFixed(1)} min — aguardando`);
          ignoradas++;
          continue;
        }

        // Cooldown: NF checada ha pouco sem precisar de acao -> pula (nao bate no Bling)
        if (_emCooldownNF(nf.id)) { ignoradas++; continue; }

        const detalhe = await getNFDetalhe(token, nf.id);
        if (!detalhe) { ignoradas++; continue; }

        // Se NF já autorizada (situacao=2) — ignora
        if (detalhe.situacao === 2) { _cooldownNF(nf.id); ignoradas++; continue; }
        // NOTA: NÃO checar detalhe.xml — Bling gera XML local mesmo em NF rejeitada

        const idContato = detalhe.contato?.id;
        const cep = detalhe.contato?.endereco?.cep;
        const uf = detalhe.contato?.endereco?.uf;
        const cnpj = detalhe.contato?.numeroDocumento || '';
        const ie = detalhe.contato?.ie || '';
        const endereco = detalhe.contato?.endereco?.endereco || '';
        const isPJ = cnpj.replace(/\D/g, '').length === 14;

        console.log(`[corrigirNFs] NF ${nf.id} | sit=${detalhe.situacao} | PJ=${isPJ} | IE="${ie}" | CEP=${cep} | UF=${uf}`);

        let corrigiu = false;

        // ── Corrigir endereço curto (menos de 2 caracteres) ──
        if (endereco.length < 2) {
          const novoEndereco = 'Endereço ' + endereco;
          console.log(`[corrigirNFs] NF ${nf.id} | endereço curto "${endereco}" -> "${novoEndereco}"`);
          detalhe.contato.endereco.endereco = novoEndereco;
          corrigiu = true;
        }

        // ── Corrigir cidade e UF na própria NF ───────────────
        if (cep) {
          const resCidade = await getCidadePorCEP(cep);
          if (resCidade) {
            const cidadeAtual = detalhe.contato?.endereco?.municipio || '';
            const ufAtual = detalhe.contato?.endereco?.uf || '';
            const mudou = (cidadeAtual !== resCidade.municipio) || (ufAtual !== resCidade.uf);
            if (mudou) {
              console.log(`[corrigirNFs] NF ${nf.id} | "${cidadeAtual}|${ufAtual}" -> "${resCidade.municipio}|${resCidade.uf}"`);
              detalhe.contato.endereco.municipio = resCidade.municipio;
              detalhe.contato.endereco.uf = resCidade.uf;
              corrigiu = true;
            }
          }
        }

        // ── Corrigir IE (só PJ sem IE) ────────────────────────
        if (isPJ && !ie && uf && idContato) {
          const cnpjLimpo = cnpj.replace(/\D/g, '');
          const resultado = await getIEPorCNPJ(cnpjLimpo, uf);
          if (resultado) {
            console.log(`[corrigirNFs] NF ${nf.id} | IE: "${resultado.ie}" contribuinte=${resultado.contribuinte}`);
            const contato = await getContato(token, idContato);
            if (contato) {
              await atualizarIEContato(token, idContato, contato, resultado.ie, resultado.contribuinte);
            }
            detalhe.contato.ie = resultado.ie;
            detalhe.contato.contribuinte = resultado.contribuinte;
            corrigiu = true;
            await sleepNF(300);
          } else {
            console.log(`[corrigirNFs] NF ${nf.id} | IE não encontrada — intervenção manual`);
          }
        }

        // ── Salvar NF e enviar ─────────────────────────────────
        if (corrigiu) {
          await sleepNF(300);
          await salvarNF(token, nf.id, detalhe);
          await sleepNF(500);
          await enviarNF(token, nf.id);
          corrigidas++;
          acaoTomada = true;
          // Correção real "zera" o histórico de retry — começou do zero
          _retrySEFAZ.delete(nf.id);
        } else {
          // ── Retry SEFAZ ────────────────────────────────────
          // Cadastro está OK mas NF segue rejeitada/pendente — provável Timeout SEFAZ.
          // Só reenvia se situacao=1 (pendente) ou 4 (rejeitada). Denegada (5) NUNCA — é decisão SEFAZ definitiva.
          if (detalhe.situacao === 1 || detalhe.situacao === 4) {
            const podeRetry = _podeReenviarSEFAZ(nf.id);
            if (!podeRetry.ok) {
              console.log(`[corrigirNFs] NF ${nf.id} | retry SEFAZ bloqueado: ${podeRetry.motivo}`);
              ignoradas++;
            } else {
              console.log(`[corrigirNFs] NF ${nf.id} | retry SEFAZ (tentativa ${podeRetry.tentativas + 1}/${RETRY_MAX_TENTATIVAS})`);
              await sleepNF(300);
              try {
                await enviarNF(token, nf.id);
                _registrarTentativaSEFAZ(nf.id);
                reenviadasSEFAZ++;
                acaoTomada = true;
              } catch (e) {
                _registrarTentativaSEFAZ(nf.id);
                throw e; // cai no catch externo pra contar como erro
              }
            }
          } else {
            ignoradas++;
          }
        }
      } catch (e) {
        if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') token = await renovarTokenNF();
        console.error(`[corrigirNFs] Erro na NF ${nf.id}:`, e.message);
        erros++;
      }
      // NF que nao precisou de acao (autorizada/denegada/retry bloqueado/erro)
      // entra em cooldown pra nao re-buscar o detalhe dela a cada 5 min (alivia 429).
      if (!acaoTomada) _cooldownNF(nf.id);
      await sleepNF(300);
    }

    console.log(`[corrigirNFs] corrigidas=${corrigidas} | reenviadasSEFAZ=${reenviadasSEFAZ} | ignoradas=${ignoradas} | erros=${erros}`);

  } finally {
    _rodandoNF = false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Retry manual (chamado pela rota POST /run/retry-nf/:id no index.js)
// Não respeita backoff nem máx tentativas — é manual mesmo.
// ──────────────────────────────────────────────────────────────────────
async function retryNFManual(idNF) {
  let token;
  try {
    token = await garantirTokenNF();
  } catch (e) {
    if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') token = await renovarTokenNF();
    else throw e;
  }

  const detalhe = await getNFDetalhe(token, idNF);
  if (!detalhe) {
    return { ok: false, erro: `NF ${idNF} não encontrada` };
  }

  if (detalhe.situacao === 2) {
    return { ok: false, erro: `NF ${idNF} já autorizada (situacao=2)` };
  }
  if (detalhe.situacao === 5) {
    return { ok: false, erro: `NF ${idNF} denegada pela SEFAZ (situacao=5) — não pode ser reenviada` };
  }
  // NOTA: NÃO checar detalhe.xml — Bling gera XML local mesmo em NF rejeitada (sit=4) ou pendente (sit=1)

  console.log(`[retryNFManual] Reenviando NF ${idNF} (situacao=${detalhe.situacao})`);
  await enviarNF(token, idNF);
  // Registra a tentativa (pra cron não competir logo em seguida)
  _registrarTentativaSEFAZ(idNF);
  return { ok: true, idNF, situacaoAnterior: detalhe.situacao };
}

// Pra debug/monitoramento
function getEstadoRetrySEFAZ() {
  const agora = Date.now();
  const lista = [];
  for (const [id, info] of _retrySEFAZ.entries()) {
    lista.push({
      idNF: id,
      tentativas: info.tentativas,
      ultimaTentativaMin: Math.round((agora - info.ultimaTentativaTs) / 60000)
    });
  }
  return { totalNFsEmRetry: lista.length, lista };
}

module.exports = { corrigirNFsPendentes, retryNFManual, getEstadoRetrySEFAZ };
