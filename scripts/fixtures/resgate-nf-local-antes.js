'use strict';
/* fixture: as funções da AMB ANTES da peça (referência da equivalência) */
module.exports = function (dep) {
  const { ARQUIVO_DIR, CACHE_DIR, CONFERIDOS_FILE, path, readJson, writeJson } = dep;
function _degrausResgate(sitVerificado, envLista) {
  /* Os degraus que a conta DECLARA vem ANTES do VERIFICADO chutado: se o VERIFICADO aceita a ida e
     nao a volta, o pedido sairia de DESPACHADOS e ficaria la, e o caminho configurado nunca rodaria. */
  return String(envLista || '').split(',').map(function (x) { return Number(String(x).trim()); })
    .filter(function (n) { return isFinite(n) && n > 0; })
    .concat([21])   /* Em digitacao: id PADRAO do Bling (igual nas 3 contas), o degrau que o dono indicou */
    .concat(sitVerificado ? [Number(sitVerificado)] : [])
    .filter(function (n, k, arr) { return arr.indexOf(n) === k; });
}

function _detalheBling(mv) {
  if (!mv) return null;
  const partes = [];
  if (mv.erro || mv.error) partes.push(String(mv.erro || mv.error));
  const corpo = mv.data != null ? mv.data : mv.raw;
  if (corpo != null) { try { partes.push(typeof corpo === 'string' ? corpo : JSON.stringify(corpo)); } catch (e) {} }
  return partes.length ? partes.join(' | ').slice(0, 400) : null;
}

async function _moverAtendidoDesandando(o) {
  const mover = async function (sit) {
    try { return await o.moverSituacao(o.pedidoId, sit); }
    catch (e) { return { ok: false, erro: String((e && e.message) || e) }; }
  };
  const mv = await mover(o.sitAtendido);
  if (mv && mv.ok) {
    /* ⚠️ Codex #651: LIMPA a marca também aqui. Este é justamente o caminho do RETRY que eu
       anuncio: o pedido parou num degrau, o dono tenta de novo, e daí o salto direto funciona.
       Sem limpar, a marca ficava pra sempre — e o pedido seguiria "resgatável" depois de já
       estar resolvido, abrindo a porta pra um rascunho futuro com aquele id. */
    try { if (typeof o.limparMarca === 'function') o.limparMarca(); } catch (e) {}
    return { ok: true, mv };
  }
  /* So desando quando o Bling DISSE que a transicao nao existe — outro erro de validacao nao e prova. */
  const txt = String((mv && (mv.erro || mv.error)) || '') + ' ' + (_detalheBling({ data: mv && mv.data, raw: mv && mv.raw }) || '');
  if (!/n[aã]o\s+h[aá]\s+transi[cç][õo]es/i.test(txt) || !o.sitDespachados) return { ok: false, mv };
  let sitAtual = o.sitAtual;
  if (sitAtual == null && o.lerSituacao) { try { sitAtual = await o.lerSituacao(); } catch (e) {} }
  if (String(sitAtual || '') !== String(o.sitDespachados)) return { ok: false, mv };
  /* ⚠️ Codex #651: o pedido que PAROU num degrau já está nele — refazer o caminho desde o

     começo repete um PATCH que não muda nada (o Bling recusa ou é no-op) e gasta cota à toa.

     Quem chama informa de onde retomar (`o.degrauSalvo`), e eu pulo o que já foi dado. */

  const degraus = _degrausResgate(o.sitVerificado, process.env.AMBBKP_SIT_DEGRAUS)
    .filter(function (n) { return String(n) !== String(sitAtual); });
  if (!degraus.length) return { ok: false, mv };

  /* Lista de degraus na ordem (configurados primeiro, VERIFICADO por ultimo); paro no primeiro que o Bling aceitar. */
  const tentados = []; let ultimaRecusa = null;
  for (let k = 0; k < degraus.length; k++) {
    const passo = degraus[k];
    const mv1 = await mover(passo);
    tentados.push(passo + (mv1 && mv1.ok ? ':ok' : ':recusado' + ((mv1 && mv1.status) ? '(HTTP ' + mv1.status + ')' : '')));
    if (!(mv1 && mv1.ok)) {
      /* ⚠️ Codex #651 (P2): só sigo pro próximo degrau quando o Bling RECUSOU A TRANSIÇÃO. Token
         vencido, 429, rede ou 5xx não dizem nada sobre o caminho ser válido — e insistir vira uma
         rajada de PATCH contra um Bling que já está sufocado, comendo a cota que a operação
         precisa. Paro e digo que foi falha, não caminho errado. */
      const _t = String((mv1 && (mv1.erro || mv1.error)) || '') + ' ' + (_detalheBling({ data: mv1 && mv1.data, raw: mv1 && mv1.raw }) || '');
      const _st = Number((mv1 && mv1.status) || 0);
      const _recusouTransicao = /transi[cç][õo]es|transicoes|VALIDATION_ERROR/i.test(_t);
      if (!_recusouTransicao || _st === 401 || _st === 403 || _st === 429 || _st >= 500) {
        tentados.push('parei:falha-operacional');
        return { ok: false, mv: mv1, resposta: { ok: false, id: o.pedidoId, tentados,
          erro: 'o Bling FALHOU ao tentar o degrau ' + passo + (_st ? ' (HTTP ' + _st + ')' : '') +
                ' — isso nao e transicao invalida, e o Bling nao respondendo. Parei pra nao ' +
                'martelar a cota. Tente de novo em alguns minutos.',
          detalhe: _detalheBling(mv1) } };
      }
      ultimaRecusa = mv1; continue;
    }
    /* ⚠️ 09/10, observação do dono: "se mudar 1 status em digitação e depois de uns 30 segundos
       outro de novo pra atendido, vai de boa". Procede, e eu estava disparando os dois PATCH
       COLADOS: o Bling leva um instante pra assentar a mudança, e o segundo chegava enquanto a
       venda ainda estava na situação antiga — recusa que PARECE "transição inválida" mas é só
       pressa. Espero antes de tentar, e insisto com pausa maior se ainda não assentou.
       Escalonado (2s, 8s, 20s) em vez de 30s fixos: na maioria das vezes resolve no primeiro e
       o dono não fica olhando tela parada; o pior caso cobre a espera que ele descreveu. */
    /* Codex #654: o pedido JA mudou de situacao - grava a marca ANTES de dormir. Se o processo cair
       durante a espera, sem a marca o resgate recusa o pedido (nao e "resgatavel") e ele encalha. */
    let _marcaGravada = true;
    try { _marcaGravada = (typeof o.marcarParado === 'function') ? (o.marcarParado(passo) !== false) : true; }
    catch (e) { _marcaGravada = false; }
    const _pausas = [2000, 8000, 20000];
    let mv2 = null;
    for (let _t = 0; _t < _pausas.length; _t++) {
      await new Promise((r) => setTimeout(r, _pausas[_t]));
      mv2 = await mover(o.sitAtendido);
      if (mv2 && mv2.ok) break;
      /* só insisto se foi recusa de transição (a que a pressa causa). Token, 429 ou 5xx não
         melhoram esperando — e martelar o Bling come a cota da operação. */
      /* Codex #654: o 400 do Bling pode vir NAO-JSON (`data` null, texto em `raw`) - olho os dois. */
      const _t2 = String((mv2 && (mv2.erro || mv2.error)) || '') + ' ' + (_detalheBling({ data: mv2 && mv2.data, raw: mv2 && mv2.raw }) || '');
      const _st2 = Number((mv2 && mv2.status) || 0);
      if (!/transi[cç][õo]es|transicoes|VALIDATION_ERROR/i.test(_t2)) break;
      if (_st2 === 401 || _st2 === 403 || _st2 === 429 || _st2 >= 500) break;
    }
    if (mv2 && mv2.ok) {
      /* ⚠️ Codex #651: chegou no ATENDIDO — LIMPA a marca, senão o pedido ficaria pra sempre
         "em resgate" e um rascunho futuro com esse id seria tratado como resgatável. */
      try { if (typeof o.limparMarca === 'function') o.limparMarca(); } catch (e) {}
      console.log('[AMBBKP] RESGATE via degrau ' + passo + ': ' + o.pedidoId + ' -> ATENDIDO');
      return { ok: true, mv: mv2, degrau: passo };
    }
    /* ⚠️ Codex #651: o degrau FUNCIONOU e o final falhou — ESCREVO a marca AGORA. Sem isso a
       mensagem "tente de novo a partir daí" nunca funcionava: a próxima tentativa não reconhecia
       o pedido como pós-checkout e recusava. Eu lia a marca em três lugares e não gravava em
       nenhum. */
    /* ⚠️ Codex #651: o `marcarParado` DEVOLVE se conseguiu gravar. `writeJson` engole a exceção
       e retorna false (disco cheio, volume só-leitura), e sem isso eu mandava "tente de novo a
       partir daí" com marca nenhuma gravada — o retry recusaria o pedido. */
    /* (marca ja gravada logo apos o degrau - ver acima) */
    /* O degrau FUNCIONOU e o salto final nao: o pedido JA MUDOU de situacao. Paro e digo onde ele esta. */
    return { ok: false, mv: mv2, resposta: { ok: false, id: o.pedidoId, parou_em: passo, tentados,
      erro: 'o Bling nao aceita ir direto para ATENDIDO, entao usei um degrau. O pedido esta AGORA na situacao ' +
            passo + ', mas o passo final falhou' + ((mv2 && mv2.status) ? ' (HTTP ' + mv2.status + ')' : '') +
            '. ' + (_marcaGravada
                ? 'Tente o resgate de novo a partir dai.'
                : 'ATENCAO: nao consegui gravar a marca do resgate (disco cheio ou so-leitura), ' +
                  'entao o resgate automatico NAO vai reconhecer este pedido. Mude a situacao no Bling.'),
      detalhe: _detalheBling(mv2) } };
  }
  return { ok: false, mv, resposta: { ok: false, id: o.pedidoId, tentados,
    erro: 'o Bling nao tem transicao direta para ATENDIDO, e nenhum degrau que eu conheco foi aceito (tentei: ' +
          tentados.join(', ') + '). Descubra no Bling qual situacao aceita vir da atual e ir para Atendido, e declare o id em ' +
          'AMBBKP_SIT_DEGRAUS (pode ser lista separada por virgula).',
    detalhe: _detalheBling(ultimaRecusa) } };
}

function backfillNFLocal(dias) {
  dias = Math.max(1, Math.min(120, Number(dias || 45)));
  const corte = Date.now() - dias * 86400000;
  const conf2 = readJson(CONFERIDOS_FILE, {});
  let alvo = 0, comSimp = 0, semSimp = 0, ufN = 0, mexeu = false;   // semSimp = só quem AINDA está sem vprod_nf; mexeu = qualquer campo gravado (inclusive só numero_loja)
  for (const [cid, c] of Object.entries(conf2)) {
    if (!c || !c.conferido_em || new Date(c.conferido_em).getTime() < corte) continue;
    if (c.vprod_nf != null && c.numero_loja != null && c.uf != null) continue;
    alvo++;
    let ds = readJson(path.join(CACHE_DIR, String(cid), 'nf-simp.json'), null);
    if (!ds) ds = readJson(path.join(ARQUIVO_DIR, String(cid), 'nf-simp.json'), null);
    if (ds) {
      if (c.numero_loja == null && ds.numeroPedidoLoja) { c.numero_loja = String(ds.numeroPedidoLoja); mexeu = true; }
      // UF/município: dos campos novos do nf-simp, ou garimpado do endereço dos antigos ("..., Cidade - UF, CEP ...")
      if (c.uf == null) {
        let _u = ds.uf || null, _m = ds.municipio || null;
        if (!_u && ds.consumidor && ds.consumidor.endereco) {
          const seg = String(ds.consumidor.endereco).split(',').map(t => t.trim()).reverse().find(t => / - [A-Z]{2}$/.test(t));
          const mm = seg && seg.match(/^(.*) - ([A-Z]{2})$/);
          if (mm) { _m = _m || mm[1]; _u = mm[2]; }
        }
        if (_u) { c.uf = _u; if (_m && c.municipio == null) c.municipio = _m; ufN++; mexeu = true; }
      }
      if (Array.isArray(ds.itens) && ds.itens.length) {
        const s2 = ds.itens.reduce((a, i) => a + (Number(i.valorTotal) || 0), 0);
        if (isFinite(s2) && s2 > 0) { if (c.vprod_nf == null) { c.vprod_nf = Math.round(s2 * 100) / 100; comSimp++; mexeu = true; } continue; }
      }
    }
    if (c.vprod_nf == null) semSimp++;
  }
  if (mexeu) writeJson(CONFERIDOS_FILE, conf2);
  if (comSimp || semSimp) console.log(`[BACKFILL-NF] ${comSimp} preenchido(s) pela nota, ${semSimp} sem nf-simp no disco (janela ${dias}d)`);
  return { candidatos: alvo, preenchidos_pela_nf: comSimp, uf_preenchidas: ufN, sem_nf_simp_no_disco: semSimp, sem_vprod_nf: semSimp, dias };
}

  return { _degrausResgate, _detalheBling, _moverAtendidoDesandando, backfillNFLocal };
};
