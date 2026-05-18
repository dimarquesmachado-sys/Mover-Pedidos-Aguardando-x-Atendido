'use strict';

// ──────────────────────────────────────────────────────────────────────
// Fluxo de correção de NFs pendentes (cidade, IE, endereço curto)
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

async function corrigirNFsPendentes() {
  if (_rodandoNF) {
    console.log('[GOOD corrigirNFs] Já em execução — pulando');
    return;
  }
  _rodandoNF = true;

  try {
    let token;
    try {
      token = await garantirTokenNF();
    } catch (e) {
      if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') token = await renovarTokenNF();
      else throw e;
    }

    const nfs = await getNFsParaCorrigir(token);
    console.log(`[GOOD corrigirNFs] ${nfs.length} NFs para verificar`);

    let corrigidas = 0, ignoradas = 0, erros = 0;
    const agora = new Date();

    for (const nf of nfs) {
      try {
        // Filtra NFs com menos de 5 minutos
        const dataEmissao = new Date(nf.dataEmissao || nf.data);
        const minutos = (agora - dataEmissao) / 1000 / 60;
        if (minutos < 5) {
          console.log(`[GOOD corrigirNFs] NF ${nf.id} tem ${minutos.toFixed(1)} min — aguardando`);
          ignoradas++;
          continue;
        }

        const detalhe = await getNFDetalhe(token, nf.id);
        if (!detalhe) { ignoradas++; continue; }

        // Se NF já autorizada (situacao=2) — ignora
        if (detalhe.situacao === 2) { ignoradas++; continue; }

        // Se tem XML gerado, NF já foi autorizada — ignora
        if (detalhe.xml && detalhe.xml.length > 0) { ignoradas++; continue; }

        const idContato = detalhe.contato?.id;
        const cep       = detalhe.contato?.endereco?.cep;
        const uf        = detalhe.contato?.endereco?.uf;
        const cnpj      = detalhe.contato?.numeroDocumento || '';
        const ie        = detalhe.contato?.ie || '';
        const endereco  = detalhe.contato?.endereco?.endereco || '';
        const isPJ      = cnpj.replace(/\D/g, '').length === 14;

        console.log(`[GOOD corrigirNFs] NF ${nf.id} | sit=${detalhe.situacao} | PJ=${isPJ} | IE="${ie}" | CEP=${cep} | UF=${uf}`);

        let corrigiu = false;

        // ── Corrigir endereço curto (menos de 2 caracteres) ──
        if (endereco.length < 2) {
          const novoEndereco = 'Endereço ' + endereco;
          console.log(`[GOOD corrigirNFs] NF ${nf.id} | endereço curto "${endereco}" -> "${novoEndereco}"`);
          detalhe.contato.endereco.endereco = novoEndereco;
          corrigiu = true;
        }

        // ── Corrigir cidade e UF na própria NF ───────────────
        if (cep) {
          const resCidade = await getCidadePorCEP(cep);
          if (resCidade) {
            const cidadeAtual = detalhe.contato?.endereco?.municipio || '';
            const ufAtual     = detalhe.contato?.endereco?.uf || '';
            console.log(`[GOOD corrigirNFs] NF ${nf.id} | "${cidadeAtual}|${ufAtual}" -> "${resCidade.municipio}|${resCidade.uf}"`);
            detalhe.contato.endereco.municipio = resCidade.municipio;
            detalhe.contato.endereco.uf        = resCidade.uf;
            corrigiu = true;
          }
        }

        // ── Corrigir IE (só PJ sem IE) ────────────────────────
        if (isPJ && !ie && uf && idContato) {
          const cnpjLimpo = cnpj.replace(/\D/g, '');
          const resultado = await getIEPorCNPJ(cnpjLimpo, uf);
          if (resultado) {
            console.log(`[GOOD corrigirNFs] NF ${nf.id} | IE: "${resultado.ie}" contribuinte=${resultado.contribuinte}`);
            const contato = await getContato(token, idContato);
            if (contato) {
              await atualizarIEContato(token, idContato, contato, resultado.ie, resultado.contribuinte);
            }
            detalhe.contato.ie = resultado.ie;
            detalhe.contato.contribuinte = resultado.contribuinte;
            corrigiu = true;
            await sleepNF(300);
          } else {
            console.log(`[GOOD corrigirNFs] NF ${nf.id} | IE não encontrada — intervenção manual`);
          }
        }

        // ── Salvar NF e enviar ─────────────────────────────────
        if (corrigiu) {
          await sleepNF(300);
          await salvarNF(token, nf.id, detalhe);
          await sleepNF(500);
          await enviarNF(token, nf.id);
          corrigidas++;
        } else {
          ignoradas++;
        }

      } catch (e) {
        if (e.code === 401 || e.message === 'TOKEN_EXPIRADO') token = await renovarTokenNF();
        console.error(`[GOOD corrigirNFs] Erro na NF ${nf.id}:`, e.message);
        erros++;
      }

      await sleepNF(300);
    }

    console.log(`[GOOD corrigirNFs] corrigidas=${corrigidas} | ignoradas=${ignoradas} | erros=${erros}`);

  } finally {
    _rodandoNF = false;
  }
}

module.exports = { corrigirNFsPendentes };
