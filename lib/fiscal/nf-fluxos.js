'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   FLUXO DE CORREÇÃO DE NF-e — código único das empresas (13/09/2026).

   Primeira peça da Fase 2 da auditoria multiloja (a fábrica fiscal). Escolhida por
   medição, não por gosto: das dez peças fiscais, `nfFluxos.js` era a mais próxima
   de idêntica entre as três empresas — e a diferença real, conferida no diff, era
   UMA LINHA: o nome da env do cooldown. Ou seja, 972 linhas mantidas em triplicata
   por causa de um prefixo.

   É o caso exato que a auditoria chama de bloqueador: "código idêntico em duas
   pastas é candidato imediato a lib; em três é bloqueador para a quarta". Cada
   conserto aqui precisava ser lembrado três vezes — e hoje mesmo a gente viu o que
   acontece quando não é (consertos do vendasSync que ficaram só num lado).

   A empresa entra como parâmetro e os clientes por injeção: o fluxo não sabe de
   qual CNPJ se trata.
   ──────────────────────────────────────────────────────────────────────────── */

function criarFluxoNF(deps) {
  for (const nome of ['nfTokenManager', 'nfBlingApi', 'envCooldown']) {
    if (!deps || deps[nome] == null) throw new Error('lib/fiscal/nf-fluxos: falta ' + nome);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Fluxo de correção de NFs pendentes (cidade, IE, endereço curto)
  // + Retry SEFAZ (timeout/indisponibilidade) integrado
  // Roda a cada 5 minutos das 06h às 23h via cron no index.js
  // ──────────────────────────────────────────────────────────────────────

  /* injeção: cada empresa entrega o próprio gerenciador de token e o próprio cliente do
     Bling. A regra do fluxo não sabe (nem precisa saber) de qual CNPJ se trata. */
  const { garantirTokenNF, renovarTokenNF } = deps.nfTokenManager;
  const {
    sleepNF,
    getNFsParaCorrigir, getNFDetalhe, salvarNF, enviarNF,
    getContato, atualizarIEContato,
    getCidadePorCEP, getIEPorCNPJ
  } = deps.nfBlingApi;

  let _rodandoNF = false;
  /* 15/10: notas série 1 de venda FULL que este fluxo SEGUROU (não transmitiu) — pra quem quiser listar */
  const _fullBloqueadas = new Map();
  /* 15/10 — NOTA SÉRIE 1 DE VENDA FULL DO ML NÃO É TRANSMITIDA (nem no lote, nem no reenvio manual).
     Caso real (AMB, pedido 5692): o Bling gerou na importação uma série 1 pra uma venda Full — por cima da
     série 2 que o próprio ML emite — e este fluxo a transmitiria. Regras:
       · já confirmada antes neste processo ⇒ segue segurada (Codex #699: um ML fora do ar depois não pode
         devolvê-la à transmissão);
       · série 1 de loja do ML SEM número de pedido ⇒ segura (não é o caminho normal; não há o que perguntar);
       · com número de pedido e loja do ML (ou, sem a lista de lojas, número com cara de pedido do ML) ⇒
         pergunta ao ML; FULL confirmado ⇒ segura. Não saber (ML fora) ⇒ segue como sempre — atrasar nota
         boa por palpite pararia o galpão. Loja que não é do ML (TikTok tem número longo) nem pergunta. */
  async function _avaliarFull(detalhe, idNF) {
    if (!detalhe || String(detalhe.serie) !== '1' || !(detalhe.situacao === 1 || detalhe.situacao === 4)) return { segurar: false };
    const ja = _fullBloqueadas.get(String(idNF));
    /* só o FULL CONFIRMADO fica guardado de vez; a órfã é reavaliada a cada vez — se o pedido for ligado
       depois, ela segue a regra normal (Codex #699 r3) */
    if (ja && ja.tipo === 'full') return { segurar: true, motivo: ja.motivo, pedido: ja.pedido_ml, jaSabia: true };
    const nlF = String(detalhe.numeroPedidoLoja || '').trim();
    const lojaF = (detalhe.loja && detalhe.loja.id != null) ? Number(detalhe.loja.id) : null;
    const temLojas = Array.isArray(deps.lojasML) && deps.lojasML.length > 0;
    const lojaEhML = temLojas && lojaF != null && deps.lojasML.map(Number).includes(lojaF);
    let motivo = null;
    if (!nlF && lojaEhML) motivo = 'série 1 de loja do ML sem pedido vinculado';
    else if (nlF && typeof deps.ehVendaFullML === 'function' && (temLojas ? lojaEhML : /^2\d{15}$/.test(nlF))) {
      let ehFull = null;
      try { ehFull = await deps.ehVendaFullML(nlF); } catch (eF) { ehFull = null; }
      if (ehFull === true) motivo = 'venda FULL confirmada pelo ML';
    }
    if (!motivo) { if (ja) _fullBloqueadas.delete(String(idNF)); return { segurar: false }; }
    const tipo = motivo === 'venda FULL confirmada pelo ML' ? 'full' : 'orfa';
    _fullBloqueadas.set(String(idNF), { numero: detalhe.numero || null, pedido_ml: nlF || null, motivo, tipo, em: (ja && ja.em) || new Date().toISOString() });
    return { segurar: true, motivo, pedido: nlF || null, jaSabia: !!ja };
  }

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
  /* 13/09 — a ÚNICA diferença entre as três cópias deste arquivo era esta linha: o nome da
     env do cooldown (AMB_/GOOD_/GIRASSOL_). 972 linhas triplicadas por causa de um prefixo.
     O registro canônico (mergeado hoje) resolve isso sem mapa em código: ele sabe o prefixo
     de cada empresa POR SERVIÇO, inclusive o vazio da Girassol. */
  const NF_COOLDOWN_MIN = Number(process.env[deps.envCooldown] || 30);
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
    /* 15/10 (Codex #699): nota segurada que saiu da lista (excluída, autorizada por outro caminho) sai do aviso —
       mas SÓ quando a lista veio completa: a busca traz a 1ª página (100 por situação), e uma segurada que caiu
       na 2ª página não pode ser esquecida (r3) */
    if (nfs.length < 100) { const vivas = new Set(nfs.map(x => String(x.id))); for (const k of Array.from(_fullBloqueadas.keys())) if (!vivas.has(k)) _fullBloqueadas.delete(k); }

    let corrigidas = 0, reenviadasSEFAZ = 0, ignoradas = 0, erros = 0, bloqueadasFull = 0;
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

        /* 15/10: AUTORIZADA é 5 e CANCELADA é 2 (Bling API v3) — o código antigo tinha "2 = autorizada" e
           deixava a autorizada seguir pro bloco de correção. Nenhuma das duas se edita nem se reenvia. */
        if (detalhe.situacao === 2 || detalhe.situacao === 5) { _cooldownNF(nf.id); ignoradas++; continue; }

        /* 15/10 — NOTA SÉRIE 1 DE VENDA FULL DO ML NÃO É TRANSMITIDA. Caso da AMB (pedido 5692): o Bling
           gravou a venda Full na loja comum (unidade Matriz) e gerou uma série 1 — por cima da série 2 que
           o próprio ML emite no Full. Este fluxo transmitia toda nota pendente com mais de 5 min, sem
           perguntar de quem era: autorizaria a nota duplicada. Agora, nota série 1 pendente/rejeitada de
           pedido do ML: pergunta ao ML o tipo do envio; FULL CONFIRMADO = não transmite e avisa. Não saber
           (ML fora) mantém o comportamento de sempre — atrasar nota boa por palpite pararia o galpão. */
        /* 15/10 — nota série 1 de venda FULL (ver _avaliarFull): não transmite e avisa */
        { const av = await _avaliarFull(detalhe, nf.id);
          if (av.segurar) {
            if (!av.jaSabia) console.warn(`[corrigirNFs] ⛔ NF ${nf.id} (nº ${detalhe.numero}, série 1): ${av.motivo}${av.pedido ? ' (pedido ' + av.pedido + ')' : ''} — NÃO transmito. No Full quem emite a nota é o ML; exclua esta nota no Bling.`);
            bloqueadasFull++; _cooldownNF(nf.id); await sleepNF(300); continue;
          } }

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

        // ── Corrigir IE (PJ sem IE OU com IE divergente da SEFAZ) ──
        // Antes rodava só quando `!ie` (PJ sem nenhuma IE). Resultado: cliente PJ
        // que vem do marketplace COM uma IE errada (ex.: empresa ISENTA que o canal
        // manda como contribuinte) nunca era corrigido — a NF era retransmitida com
        // a mesma IE ruim e rejeitava pra sempre. Agora consulta sempre que for PJ e
        // só age se o cadastro oficial (CNPJá → SintegraWS) divergir do que está na NF.
        // A consulta tem cache em disco (7d positivo / 24h negativo), então na prática
        // é no máximo 1 consulta por CNPJ por semana.
        if (isPJ && uf && idContato) {
          const cnpjLimpo = cnpj.replace(/\D/g, '');
          const resultado = await getIEPorCNPJ(cnpjLimpo, uf);
          if (resultado) {
            const ieAtual = String(ie || '').trim().toUpperCase();
            const ieOficial = String(resultado.ie || '').trim().toUpperCase();
            // COMPARA SÓ A IE (corrigido 24/07). Antes comparava também o campo
            // `contribuinte`, mas ele NÃO vem no detalhe da NF — chega undefined,
            // vira 0, e 0 !== 1 dava divergência em 100% dos PJ. Efeito colateral:
            // PUT inútil no cadastro do contato + salvarNF numa NF já autorizada,
            // que o Bling recusa com HTTP 400 "situação da nota não permite edição".
            // A IE é o dado que o ML valida — é o que interessa aqui.
            if (ieAtual !== ieOficial) {
              console.log(`[corrigirNFs] NF ${nf.id} | IE "${ie}" → "${resultado.ie}" (contribuinte=${resultado.contribuinte})`);
              const contato = await getContato(token, idContato);
              if (contato) {
                // Corrige o CADASTRO do contato: as próximas vendas desse cliente
                // já nascem certas. Vale mesmo quando esta NF não aceita mais edição.
                await atualizarIEContato(token, idContato, contato, resultado.ie, resultado.contribuinte);
              }
              // A NF em si só é alterada/retransmitida se ainda aceitar edição
              // (pendente=1 ou rejeitada=4). Autorizada recusa o PUT.
              if (detalhe.situacao === 1 || detalhe.situacao === 4) {
                detalhe.contato.ie = resultado.ie;
                detalhe.contato.contribuinte = resultado.contribuinte;
                corrigiu = true;
              } else {
                console.log(`[corrigirNFs] NF ${nf.id} | situacao=${detalhe.situacao} não permite edição — corrigi só o cadastro do contato`);
              }
              await sleepNF(300);
            }
          } else if (!ie) {
            console.log(`[corrigirNFs] NF ${nf.id} | IE não encontrada — intervenção manual`);
          }
        }

        // ── Salvar NF e enviar ─────────────────────────────────
        /* 15/10: endereço e município também marcavam "corrigiu" em nota que não aceita edição (denegada) —
           salvar + reenviar só vale pra pendente ou rejeitada; nas outras, o cadastro do contato já foi
           corrigido acima e a nota fica como está */
        if (corrigiu && !(detalhe.situacao === 1 || detalhe.situacao === 4)) {
          console.log(`[corrigirNFs] NF ${nf.id} | situacao=${detalhe.situacao} não aceita edição — não salvo nem reenvio a nota`);
          corrigiu = false;
        }
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
          // Só reenvia se situacao=1 (pendente) ou 4 (rejeitada). Denegada (9) NUNCA — é decisão SEFAZ definitiva.
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

    console.log(`[corrigirNFs] corrigidas=${corrigidas} | reenviadasSEFAZ=${reenviadasSEFAZ} | ignoradas=${ignoradas} | erros=${erros} | bloqueadasFull=${bloqueadasFull}`);

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

  /* 15/10: códigos certos do Bling v3 — 5 autorizada, 2 cancelada, 9 denegada */
  if (detalhe.situacao === 5) {
    return { ok: false, erro: `NF ${idNF} já autorizada (situacao=5)` };
  }
  if (detalhe.situacao === 2) {
    return { ok: false, erro: `NF ${idNF} cancelada (situacao=2) — não pode ser reenviada` };
  }
  if (detalhe.situacao === 9) {
    return { ok: false, erro: `NF ${idNF} denegada pela SEFAZ (situacao=9) — não pode ser reenviada` };
  }
  /* 15/10 (Codex #699): o reenvio manual passa pela mesma guarda do Full */
  { const av = await _avaliarFull(detalhe, idNF);
    if (av.segurar) return { ok: false, erro: `NF ${idNF} segurada: ${av.motivo}${av.pedido ? ' (pedido ' + av.pedido + ')' : ''} — no Full quem emite a nota é o ML; exclua esta nota no Bling` }; }
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
  /* 13/09: o cooldown entra no estado. Ele era a ÚNICA diferença entre as três cópias
     deste fluxo, então é justamente o que alguém vai querer conferir depois da unificação
     — e sem isso não dá nem pra testar que cada empresa está lendo a env DELA. */
  return { totalNFsEmRetry: lista.length, cooldown_min: NF_COOLDOWN_MIN, env_cooldown: deps.envCooldown, lista,
    /* 15/10: notas série 1 de venda FULL que o fluxo segurou (excluir no Bling) */
    full_seguradas: Array.from(_fullBloqueadas, ([id, v]) => Object.assign({ id }, v)) };
  }

  /* a fábrica devolve as mesmas três funções que cada pasta exportava — as fachadas
     abaixo mantêm os require() antigos funcionando durante a migração. */
  return { corrigirNFsPendentes, retryNFManual, getEstadoRetrySEFAZ };

}

module.exports = { criarFluxoNF };
