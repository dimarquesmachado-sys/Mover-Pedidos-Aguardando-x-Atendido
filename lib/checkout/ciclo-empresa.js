'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CICLO DO CHECKOUT — PEÇA ÚNICA (30/10/2026). Era o ciclo.js de cada empresa (AMB 1.511, GOOD 1.412, Girassol 990
   linhas, cópias que divergiram). Passo 1: a peça nasce do ciclo da AMB (o mais completo) e a AMB passa a usá-la; a GOOD
   e a Girassol vêm nos passos seguintes, nivelando por cima (docs/fase3-diferencas-ciclo.md).
   criarCiclo({ base, nf, etiquetas, comum, produtos, arquivo, separacao,   ← os módulos da empresa
                prefixoEnv, prefixoLog, empresaFiscal, unsFullCasa, unsEmissaoPropriaCasa,
                mlTokenManager(), mlApi(), mmEtiquetas()?, fetch? })
   O estado do ciclo (rodando, último resumo, cursores, freio da Shopee) vive DENTRO da fábrica — um por empresa.
   ───────────────────────────────────────────────────────────────────────────── */
function criarCiclo(o) {
  if (!o || !o.base || !o.prefixoEnv || !o.empresaFiscal || typeof o.mlTokenManager !== 'function' || typeof o.mlApi !== 'function') {
    throw new Error('lib/checkout/ciclo-empresa: falta peça da empresa (base, prefixoEnv, empresaFiscal, mlTokenManager, mlApi)');
  }
  const ENV = o.prefixoEnv, LOG = o.prefixoLog || o.prefixoEnv;
  const LOJA_SHOPEE = o.lojaShopee || o.empresaFiscal;   /* a loja da empresa no serviço da Shopee (/amb, /good, /girassol) */
  /* 30/10 (ciclo 3): o filtro de Full pela UNIDADE DE NEGÓCIO (esconder da fila do galpão a venda cuja unidade é de Full)
     é da empresa que o liga. A Girassol entra com ele desligado (o ciclo dela nunca teve esse filtro) até o dono decidir —
     desligado, a env GIRABKP_UN_FULL não liga nada por engano. A venda que o PRÓPRIO ML diz ser Full ('fulfillment')
     sai da fila nas três, como a Girassol já fazia. */
  const FULL_ATIVO = o.fullAtivo !== false;
  // ════════════════════════════════════════════════════════════════════════
  //  amb-checkout-offline · módulo ciclo  (motor de sincronização — Lote 2)
  //  Dono do estado: rodando / ultimoResumo / ultimoSync / idxStatus.
  //  As rotas leem esse estado pelos getters exportados (getUltimoResumo, etc.).
  // ════════════════════════════════════════════════════════════════════════
  const fs    = require('fs');
  const path  = require('path');
  const fetch = o.fetch || require('node-fetch');
  const base  = o.base;
  const { BLING_BASE, CACHE_DIR, SIT_ATENDIDO, SIT_DESPACHADOS, SIT_VERIFICADO, SYNC_ON, JANELA_DIAS, PAUSA_MS, RETENCAO_DIAS, ETIQ_FORMATO, CRON_EXPR,
    MANIFEST_FILE, SKU_EAN_FILE, CONFERIDOS_FILE, RESERVAS_FILE, RESERVA_TTL_MS, KIT_CACHE_FILE, LOC_FILE, LOC_LOG_FILE, EAN_INDEX_FILE, EAN_INDEX_STATUS_FILE,
    ARQUIVO_DIR, ARQUIVO_DIAS, SMTP_HOST, SMTP_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_DEST, SCHEMA, LOJA_MKT, MKT_NOME,
    sleep, ensureDir, readJson, writeJson, dataISO, json, html, manifest, salvarManifest, skuEanCache, locCache, salvarLoc,
    salvarSkuEan, lerIndiceEan, lerReservas, lerOperadores, lerAdmins, ehAdmin, blingGet, blingWrite, moverSituacao } = base;
  /* 26/08, decisão do dono ("vai ficar 6h parado poluindo minha tela?"): a espera de 6h
     foi calibrada pro risco ERRADO neste ramo. Ela nasceu do incidente de 24/08 — mover
     pedido cuja NF EXISTE mas a série nunca foi lida (podia ser clone série 1) — e ESSE
     caso continua protegido pra sempre, sem prazo: NF vinculada sem série lida NUNCA move.
     Aqui é outro caso: o Bling AFIRMANDO que não há NF nenhuma (404 confirmado), o normal
     do Full espelhado. Clone nasce com NF vinculada e legível desde o primeiro minuto, então
     o único risco real é o ML Full recém-criado minutos antes de a matriz emitir a série 1
     própria — e pra isso 1 hora sobra.
     Codex #218 (P1): o prazo alcança TAMBÉM o ramo "nota lida sem série" — e é seguro pelo
     mesmo invariante, já verificado na casa (b83): clone é emitido pelo Bling ao salvar e
     NASCE com série 1 legível desde o primeiro minuto, então cai no ramo {serie}, nunca
     aqui. Nota lida sem série no corpo é, por definição, espelho de marketplace — a NF já
     existe do lado de lá; mover é ainda MAIS justificado que no 404. O único caso que
     nunca vence prazo nenhum segue sendo o perigoso: NF vinculada cuja leitura falhou. Configurável sem deploy: <PREFIXO>_ESPERA_FULL_MIN (AMBBKP_, GOODBKP_…). */
  /* Codex #218 (P2): typo na env (ex. "60m") dava NaN, e NaN na comparação movia NA HORA —
     o oposto da trava. Valor inválido ou ≤0 cai no padrão de 60; válido tem piso de 5. */
  /* 26/08, ordem do dono ("tem que identificar que é FULL e tirar dali NA HORA"): o padrão
     virou ZERO — Full com "sem NF" CONFIRMADO pelo Bling, ou com nota de espelho lida sem
     série, MOVE NA PRIMEIRA CONFERÊNCIA. É seguro pelo invariante verificado da casa (b83):
     clone nasce com NF vinculada e série 1 legível no instante em que o Bling salva — logo
     cai no ramo da série lida e nunca chega aqui; "sem NF confirmado" é fisicamente
     incompatível com clone. O caso genuinamente cego segue protegido sem prazo nenhum:
     NF vinculada cuja leitura FALHOU nunca move (é ele que guarda o incidente de 24/08).
     Quem quiser margem de relógio põe <PREFIXO>_ESPERA_FULL_MIN>0 no Render (piso 5). */
  const _espEnv = Number(process.env[ENV + '_ESPERA_FULL_MIN']);
  const ESPERA_FULL_MS = (Number.isFinite(_espEnv) && _espEnv > 0 ? Math.max(5, _espEnv) : 0) * 60 * 1000;
  /* 26/08, ordem do dono ("vc tem que editar pro novo identificador... senão as vendas não
     sairão do ATENDIDO"): as unidades Full CONHECIDAS DA CASA ficam EMBUTIDAS no código, e a
     env <PREFIXO>_UN_FULL passa a ACRESCENTAR em vez de ser a única fonte — antes, unidade nova
     criada no Bling (a reorganização de hoje: filial "AMBTotal - FULLFILMENT MLivre") exigia
     lembrar de editar env no Render, e esquecer = ML Full acampando em ATENDIDO de novo.
     Mapa: 2920348 Full Shopee · 2920232 Full Magalu · 2839148 FULL ML (unidade original) ·
     3456195 FULLFILMENT MLivre (filial nova de 26/08). Emissão própria (série 1 pela matriz
     é o fluxo NORMAL, não clone): as duas do MLivre. Env correspondente só acrescenta. */
  const UNS_FULL_CASA = (o.unsFullCasa || []).map(String);
  const UNS_EMISSAO_PROPRIA_CASA = (o.unsEmissaoPropriaCasa || []).map(String);
  const unsFullEfetivas = () => {
    const extra = String(process.env[ENV + '_UN_FULL'] || '').split(',').map(x => x.trim()).filter(Boolean);
    return Array.from(new Set(UNS_FULL_CASA.concat(extra)));
  };
  let _cursorConfirmacao = 0;   // r6: onde a janela de conferência da reconciliação parou (gira pelo tamanho do lote; restart zera, sem prejuízo)
  let _cursorFull = 0;          // Codex #212: os Full preservados também giram — ≥16 deles travaria a fatia fixa nos mesmos 15 pra sempre
  let _sondaPendente = null;    // r7: chamada de token/detalhe pendurada de um ciclo anterior — enquanto não assentar, a conferência é pulada (não empilha soquete)
  const { parseNF, acharNFporRange, nfDoPedido, serieDaNFdoPedido, carregarNFs, acharNFnaLista, baixarDanfe, parseXmlNF, baixarXmlNF, dadosNFSimp } = o.nf;
  const { baixarEtiqueta, baixarEtiquetaPDF, labelaryPost, zplParaPdf, etiquetaPdf } = o.etiquetas;
  const { servicoDoPedido, ehFlex, cronDeveriaTerRodado, kitIncompletoNoCache, zplEscape, bannerVolumeZpl } = o.comum;
  const { getPossiveisGtins, primeiroEan, primeiraImagem, localizacaoDeProduto, localizacaoPorSku, salvarNoIndiceEan, eanDoItem, produtoDetalhe, infoProduto, limparProdCache } = o.produtos;
  const { purgar, arquivarFinalizado, purgarArquivo, purgarConferidos } = o.arquivo;
  const { montarSeparacao, montarSeparacaoPorPedido } = o.separacao;

  // ─── estado do ciclo (mutável; lido pelas rotas via getters) ───
  let rodando = false;
  let rodandoDesde = 0;   // watchdog: se um ciclo pendurar (fetch sem resposta), a flag ficava presa e TODO cron seguinte era pulado em silencio
  let ultimoResumo = { rodouEm: null, total: 0, comEtiqueta: 0, semEtiqueta: 0, novos: 0, erros: 0 };
  let ultimoSync = { em: null, pendentes: 0, ok: 0, falhas: 0 };
  /* Codex #510 (P2): `fim` é memória de processo — um restart zerava pra null mesmo com o índice
     completo e intacto em disco, e a busca por nome passava a alertar "catálogo incompleto" à
     toa. Semeia do arquivo que sobrevive ao restart; grava nele toda vez que `fim` muda aqui. */
  let idxStatus = { rodando: false, feitos: 0, eans: 0, em: null, fim: (readJson(EAN_INDEX_STATUS_FILE, {}) || {}).fim || null, erro: null };
  function getUltimoResumo() { return ultimoResumo; }
  function getUltimoSync()   { return ultimoSync; }
  function getIdxStatus()    { return idxStatus; }

  /* 23/09 — MODO PROFUNDO (opcional), igual ao da Girassol: busca o detalhe de TODOS pra saber
     quem é kit, porque a listagem pode dizer "S" pra algo com composição. Custa uma chamada por
     produto, então não é o padrão — dispara com `?profundo=1`, fora do horário do galpão. */

  /* 15/10 — POR QUE O PEDIDO ESTÁ SEM ETIQUETA, NO PRÓPRIO CARD. Antes o motivo de cada tentativa (Bling, ML,
     Shopee) só ia pro log do Render e o card dizia sempre "o Bling não trouxe a etiqueta". Agora o motivo da
     ÚLTIMA tentativa fica no pedido (etq_motivo) e aparece no card. */
  /* 15/10 (Codex #697, P1): mensagem de erro do fetch traz a URL INTEIRA — e a da Shopee leva a chave
     (?k=SHOPEE_SYNC_KEY). O motivo vai pro manifesto e pra /lista dos operadores: nunca pode levar
     segredo. Tira a querystring de toda URL e mascara k/key/token/chave soltos. */
  function _semSegredo(msg) {
    return String(msg == null ? '' : msg)
      .replace(/https?:\/\/[^\s"'<>]+/g, (u) => u.split('?')[0])
      .replace(/\b(k|key|token|access_token|chave|senha|secret)=[^&\s"']+/gi, '$1=***');
  }
  function _motivoEtqML(status, sub, det) {
    const s = String(sub || ''), d = String(det || '');
    if (/invoice_pending/i.test(s)) return 'o ML ainda espera a nota fiscal deste pedido (invoice_pending)';
    if (/cancel/i.test(s)) return 'envio cancelado no ML (' + s + ')';
    if (/shipped|delivered|picked_up|in_hub|ready_to_pickup/i.test(s)) return 'já despachado no ML (' + s + ') — a etiqueta não sai mais';
    if (Number(status) === 401 || Number(status) === 403) return 'o ML recusou o token da empresa (HTTP ' + status + ')';
    return 'o ML não liberou a etiqueta (HTTP ' + status + (s ? ', envio ' + s : '') + (d ? ' — ' + _semSegredo(d).slice(0, 80) : '') + ')';
  }

  /* 30/10 (ciclo 3): o índice do catálogo da GIRASSOL (o mais completo) — guarda a FOTO de cada produto, compõe o nome
     da variação com o do pai ("lixa" passa a achar as variações na contagem) e conta os kits; vale pras três. */
  async function indexarCatalogoCompleto(opcoes) {
    const profundo = !!(opcoes && opcoes.profundo);
    if (idxStatus.rodando) return;
    idxStatus = { rodando: true, feitos: 0, eans: 0, em: new Date().toISOString(), fim: null, erro: null };
    idxStatus.profundo = profundo; idxStatus.kits = 0;
    /* Codex #514 (P1): partir do índice em disco parecia "resiliente", mas isso fazia a
       varredura completa NUNCA remover uma chave inválida gravada antes — exatamente o caso do
       NCM-como-EAN: o filtro novo (acima) parou de CRIAR essas chaves, mas uma reindexação total
       não apagava as que já estavam lá, porque elas nunca são revisitadas (não são um EAN de
       produto nenhum). Como este laço varre o catálogo INTEIRO, uma varredura que TERMINA (só
       grava `writeJson` se não abortou — ver abaixo) é a fotografia completa e correta do
       catálogo: começa vazio. Se abortar, o objeto em memória é descartado e o índice antigo
       em disco continua valendo — nada se perde. */
    const novo = {};
    const _nomePorId = {};   // id → nome, de todo produto visto (pra compor o da variação)
    const _paiDeSku  = {};   // sku da variação → id do pai
    const PAUSA = Number(process.env[ENV + '_PAUSA_MS'] || 700);
    try {
      let pagina = 1, tentativas = 0, catalogoCompleto = false;
      while (pagina <= 500) {                           // trava de segurança
        const r = await blingGet(`/produtos?pagina=${pagina}&limite=100`);
        /* 16/09 — ACHADO VINDO DO REPO DE DEVOLUÇÕES: lá a busca por nome da AMB ficou cega o
           dia todo porque um 401 PASSAGEIRO do Bling matou o índice na primeira página — e o
           token estava bom. Aqui era a mesma armadilha: `r.ok` falso devolvia lista vazia e o
           `break` tratava isso como "acabou o catálogo", salvando um índice VAZIO por cima do
           bom. Falha e fim de lista chegavam iguais.
           Agora são casos separados: lista vazia com resposta OK é fim; resposta que não veio OK
           é FALHA — tenta de novo (401 e 5xx são passageiros: token renova, serviço volta) e,
           se insistir, ABORTA sem salvar, preservando o índice anterior. Índice velho serve;
           índice vazio cega a busca. */
        if (!r.ok) {
          const passageiro = [401, 403, 429, 500, 502, 503, 504].includes(Number(r.status));
          if (passageiro && tentativas < 3) {
            tentativas++;
            /* Codex #484 (P2): isto ficava grudado mesmo quando a tentativa seguinte dava certo,
               e os três painéis mostram `st.erro` junto do "índice pronto" — toda indexação que
               se RECUPEROU aparecia como se tivesse falhado. Alarme falso recorrente ensina a
               ignorar o alarme, que é pior que não ter. Vai pra um campo separado. */
            idxStatus.ultimo_tropeco = 'HTTP ' + r.status + ' na página ' + pagina + ' (tentativa ' + tentativas + ' de 3)';
            await sleep(PAUSA * 4 * tentativas);
            continue;                                    // MESMA página
          }
          throw new Error('indexação abortada na página ' + pagina + ': HTTP ' + r.status +
                          ' — o índice anterior foi preservado');
        }
        /* Codex #484, 2ª rodada: 2xx com corpo ILEGÍVEL (JSON quebrado ou formato inesperado)
           deixa `ok: true` e `data` null — e este `|| []` transformava isso em lista vazia,
           que o `break` lia como "acabou o catálogo". Exatamente o mesmo buraco que eu tinha
           acabado de fechar na rota de localização, e aqui o estrago é maior: lá o dono lê uma
           mensagem errada; aqui o índice é publicado truncado e a busca fica cega.
           Não basta a resposta ter CHEGADO, nem ter vindo OK: ela precisa ter sido ENTENDIDA. */
        if (!r.data || !Array.isArray(r.data.data)) {
          if (tentativas < 3) {
            tentativas++;
            idxStatus.ultimo_tropeco = 'página ' + pagina + ' veio OK mas ilegível (tentativa ' + tentativas + ' de 3)';
            await sleep(PAUSA * 4 * tentativas);
            continue;                                    // MESMA página
          }
          throw new Error('indexação abortada na página ' + pagina +
                          ': o Bling respondeu OK mas o corpo não pôde ser lido — o índice anterior foi preservado');
        }
        tentativas = 0;                                  // a página veio E foi lida: zera o contador
        const itens = r.data.data;
        if (!itens.length) { catalogoCompleto = true; break; }   // agora isto significa mesmo "acabou"
        for (const it of itens) {
          idxStatus.feitos++;
          if (!it.id) continue;
          let eans = getPossiveisGtins(it).map(e => String(e).replace(/\D/g, '')).filter(e => e.length >= 8);
          let nome = it.nome, sku = it.codigo;
          let det = null;   // usado fora do if pra ler o `formato` quando o detalhe foi buscado
          if (!eans.length || profundo) {   // sem GTIN, ou modo profundo: precisa do detalhe
            det = await produtoDetalhe(it.id);
            await sleep(PAUSA);
            if (det) { eans = getPossiveisGtins(det).map(e => String(e).replace(/\D/g, '')).filter(e => e.length >= 8); nome = det.nome || nome; sku = det.codigo || sku; }
          }
          /* 22/09 — KIT NÃO PODE SER CONTADO. O dono explicou: `80-AE-8F-125mm-KIT40` é um kit,
             e lançar estoque nele no Bling dá erro — quem conta inventário são os COMPONENTES
             (`10-AE-8F-125mm-g24`, `10-AE-8F-125mm-g40`), que são produtos normais e aparecem
             na busca como qualquer outro. Variação também é contável.
             `formato === 'E'` é composição no Bling (já documentado em amb-drive-imagens), então
             a marca vai junto no índice e a busca esconde esses. Sem custo extra: o campo já vem
             na listagem que esta varredura faz. */
          /* quem decide é a COMPOSIÇÃO; o `formato` é o reforço. `V` é pai de grade, que também
             não tem estoque próprio. Sem o detalhe (modo normal), só o formato da listagem dá —
             e é por isso que o modo profundo existe. */
          const _alvo = det || it;
          const _comps = (_alvo.estrutura && (_alvo.estrutura.componentes || _alvo.estrutura.itens))
                      || _alvo.composicao || _alvo.componentes || [];
          const _fmt = String((det && det.formato) || it.formato || '').toUpperCase();
          /* Codex #515 (P2): detalhe que FALHOU não pode virar "não é kit". É exatamente o caso
             que o modo profundo existe pra resolver — listagem dizendo "S" pra um kit —, e
             publicar `false` ali seria afirmar o contrário do que se foi verificar.
             `null` = não sei: a busca não esconde, mas a trava do lançamento pega. */
          const _semVeredito = profundo && !det;
          const ehKit = _semVeredito ? null
                      : ((Array.isArray(_comps) && _comps.length > 0) || _fmt === 'E' || _fmt === 'V');
          /* 23/09 — a FOTO entra no índice. O dono pediu ver a imagem já na primeira lista de
             resultados, não só depois de clicar. Buscá-la ali custaria uma chamada ao Bling POR
             RESULTADO (até 30 por busca, a cada tecla) — inviável. Aqui vem de graça: a listagem
             que esta varredura já faz traz `imagemURL`. */
          const foto = primeiraImagem(det || it) || '';

          /* 23/09 — NOME DA VARIAÇÃO. O dono achou: a variação `10-lisa-125mm-100` tem
             Descrição "GRÃO:g100" — o nome completo ("10 X Lixas Disco Grão Liso…") mora só no
             PAI (`10-lisa-125mm-PAI-X`). Então procurar "lixa" não achava nenhuma variação, que
             é justamente o que se conta na prateleira; só o SKU exato funcionava, porque aquele
             caminho vai ao Bling, que devolve o nome montado.
             Guardo id→nome de todo produto e o pai de cada variação; no FIM da varredura (quando
             já vi o pai, venha ele antes ou depois) componho "nome do pai + nome da variação".
             Sem custo: nenhuma chamada a mais ao Bling.
             Codex (P1): no modo raso (sem GTIN não entra aqui — profundo=false e já tem EAN),
             `det` nunca é buscado e `_alvo` é o item da LISTAGEM, que não traz
             `variacao.produtoPai` (isso só vem no detalhe). A listagem traz o mesmo dado como
             `idProdutoPai` solto — é o fallback abaixo, senão a variação com EAN nunca ganhava
             o nome do pai na varredura padrão. */
          const _pai = (_alvo.variacao && _alvo.variacao.produtoPai) || null;
          const _paiId = (_pai && (_pai.id || _pai.idProduto || (typeof _pai === 'number' ? _pai : null)))
                      || _alvo.idProdutoPai || it.idProdutoPai || null;
          if (it.id) _nomePorId[it.id] = nome || '';
          if (_paiId) _paiDeSku[sku || ('id:' + it.id)] = _paiId;
          /* Codex #514 (P1, 2ª leva): `lerIndiceEan()` só preserva uma chave de 8 dígitos na
             leitura se o valor gravado declarar aquele número como `ean` — é o único jeito dela
             saber que não é um NCM sobrando de antes do conserto do coletor. Sem `ean: e` aqui,
             todo EAN-8 real que esta varredura gravasse seria apagado na primeira leitura
             seguinte, junto com o NCM. */
          if (ehKit) idxStatus.kits++;
          if (eans.length) {
            for (const e of eans) { if (!novo[e]) idxStatus.eans++; novo[e] = { sku: sku || '', nome: nome || '', id: it.id, kit: ehKit, img: foto, ean: e }; }
          } else if (sku) {
            // Codex (P2): sem GTIN, o produto nunca entrava no índice — e é o índice de EAN que
            // a busca por nome da contagem de estoque usa. Chave sintética prefixada (nunca é só
            // dígitos, ao contrário de um EAN de verdade) pra não colidir com o lookup por dígitos.
            novo['sku:' + sku] = { sku: sku, nome: nome || '', id: it.id, kit: ehKit, img: foto };
          }
        }
        /* Codex #484 (P2): eu guardei o salvamento FINAL e esqueci deste, que publica a cada
           página — então o índice parcial já estava em disco muito antes do aborto, e meu
           conserto não protegia nada. O "resiliente a queda" fazia sentido quando o parcial
           era melhor que nada; deixou de fazer quando o parcial CEGA a busca em silêncio.
           Agora acumula em memória e publica uma vez só, no fim, se a varredura completou. */
        idxStatus.paginas = pagina;
        await sleep(PAUSA);
        pagina++;
      }
      /* Codex #514 (P2): a trava de 500 páginas (50 mil produtos) existia só pra não rodar pra
         sempre — mas ao ESTOURAR ela o laço só para de iterar, sem passar por `catalogoCompleto`.
         Isso publicava `novo` do mesmo jeito que uma varredura terminada de verdade, e como agora
         `novo` NASCE VAZIO (Codex #514, P1), um catálogo com mais de 50 mil produtos faria a
         varredura apagar do índice tudo que está além da página 500 — o oposto de "trava de
         segurança". Estourar o limite sem ter visto a página vazia final é o mesmo caso que HTTP
         ruim ou corpo ilegível: aborta e preserva o índice anterior. */
      if (!catalogoCompleto) {
        throw new Error('indexação abortada: catálogo tem mais de 500 páginas (trava de segurança) ' +
                        '— o índice anterior foi preservado');
      }
    } catch (e) { idxStatus.erro = String(e && e.message || e); idxStatus.abortou = true; }
    /* 16/09 — o salvamento final rodava MESMO depois do erro, gravando o índice parcial por
       cima do bom. Somado ao `break` silencioso, era assim que uma falha passageira do Bling
       cegava a busca até alguém reindexar à mão. Índice velho serve; parcial engana, porque a
       busca responde "não encontrado" com a mesma cara de sempre. */
    /* compõe o nome das variações agora que o catálogo inteiro foi visto */
    if (!idxStatus.abortou) {
      let compostos = 0;
      for (const chave of Object.keys(novo)) {
        const it = novo[chave];
        if (!it || !it.sku) continue;
        const paiId = _paiDeSku[it.sku];
        if (!paiId) continue;
        const nomePai = _nomePorId[paiId];
        if (!nomePai) continue;                       // pai não veio na varredura: deixa como está
        const atual = String(it.nome || '');
        if (atual.toLowerCase().startsWith(nomePai.toLowerCase().slice(0, 20))) continue;  // já completo
        it.nome = (nomePai + ' ' + atual).trim();
        compostos++;
      }
      idxStatus.nomes_compostos = compostos;
    }
    if (!idxStatus.abortou) writeJson(EAN_INDEX_FILE, novo);
    else console.warn('[índice EAN] abortado — índice anterior preservado: ' + idxStatus.erro);
    idxStatus.rodando = false;
    idxStatus.fim = new Date().toISOString();
    writeJson(EAN_INDEX_STATUS_FILE, { fim: idxStatus.fim });
  }

  /* Codex #701 r6: ids de Full cujo DESPACHADOS deu certo neste processo — se gravar o conferido encerrado falhar
     (disco cheio), o sync não pode levar o pedido pra VERIFICADO por cima */
  const _fullDespachadosNoProcesso = new Set();
  /* 16/10 (Codex #702): a marca do Full despachado também vai pra um ARQUIVO — o conjunto em memória some no reinício
     (todo deploy), e o cache do pedido é apagado no move; sem o arquivo, um card velho finalizado depois de um deploy
     devolveria o pedido pro VERIFICADO, e o sync o pegaria */
  const FULL_DESPACHADOS_FILE = path.join(CACHE_DIR, '_full-despachados.json');
  function _marcarFullDespachado(id) {
    try {
      const d = readJson(FULL_DESPACHADOS_FILE, {}) || {}; const agora = Date.now();
      d[String(id)] = new Date(agora).toISOString();
      for (const k of Object.keys(d)) if (agora - (Date.parse(d[k]) || 0) > 30 * 86400000) delete d[k];   // guarda 30 dias
      writeJson(FULL_DESPACHADOS_FILE, d);
    } catch (e) {}
  }
  function fullJaDespachado(id) {
    if (_fullDespachadosNoProcesso.has(String(id))) return true;
    try { return !!((readJson(FULL_DESPACHADOS_FILE, {}) || {})[String(id)]); } catch (e) { return false; }
  }   // Codex #702: card aberto antes do move e finalizado depois não pode voltar o pedido pro VERIFICADO

  async function sincronizarConferidos(pular) {
    const conf = readJson(CONFERIDOS_FILE, {});
    /* Codex #701 r6: o conjunto de Full é derivado AQUI (manifesto + movidos do processo + o que o ciclo passar), pra
       valer também na rota manual /sincronizar, que chama sem argumento */
    pular = new Set([...(pular || []), ..._fullDespachadosNoProcesso]);
    /* Codex #702: só pula o Full do manifesto se o destino DESPACHADOS existe — com SIT_DESPACHADOS 0 (padrão da GOOD) o
       ciclo não move o Full, e o conferido dele tem que seguir pro VERIFICADO como sempre */
    if (Number(SIT_DESPACHADOS)) {
      try { const _m = readJson(MANIFEST_FILE, {}); for (const i of Object.keys(_m || {})) if (_m[i] && _m[i].full_ml) pular.add(String(i)); } catch (e) {}
      try { const _d = readJson(FULL_DESPACHADOS_FILE, {}) || {}; for (const i of Object.keys(_d)) pular.add(String(i)); } catch (e) {}   // Codex #702: marca durável (sobrevive a reinício)
    }
    /* 15/10 (Codex #701 r5): venda Full do ML (full_ml) tem destino DESPACHADOS — o move dela é do bloco do Full.
       Se esse move falhou neste ciclo, o conferido pendente NÃO pode virar VERIFICADO aqui por cima do retry. */
    const ids = Object.keys(conf).filter(id => conf[id] && !conf[id].sincronizado && !pular.has(String(id)));
    let ok = 0, falhas = 0, jaAvancados = 0;
    for (const id of ids) {
      const r = await moverSituacao(id, SIT_VERIFICADO);
      if (r.ok) {
        conf[id].sincronizado = true;
        conf[id].sincronizado_em = new Date().toISOString();
        delete conf[id].sync_erro;
        ok++;
        console.log(`[${LOG}] sync ${id} → ${SIT_VERIFICADO} OK`);
      } else {
        // Falha ao mover: confere se o pedido JÁ AVANÇOU (saiu de ATENDIDO por outro
        // processo — despachado/faturado). Se não está mais em ATENDIDO, o sync já não
        // é necessário: marca como resolvido em vez de "falha" (evita ruído no /saude).
        let situAtual = null, sumiu = false;
        try {
          const g = await blingGet(`/pedidos/vendas/${id}`);
          const ped = g && g.data && (g.data.data || g.data);
          situAtual = ped && ped.situacao && Number(ped.situacao.id);
          // 28/07: pedido EXCLUÍDO no Bling responde 404. Antes isso caía no "falha" e o sync
          // tentava de novo TODO ciclo, pra sempre — enchendo o log com o mesmo erro.
          if (g && Number(g.status) === 404) sumiu = true;
        } catch (e) {}
        if (!situAtual && Number(r.status) === 404) sumiu = true;
        if (situAtual && situAtual !== SIT_ATENDIDO) {
          conf[id].sincronizado = true;
          conf[id].sincronizado_em = new Date().toISOString();
          conf[id].sync_resolvido = 'ja-avancado:' + situAtual;
          delete conf[id].sync_erro;
          jaAvancados++;
          console.log(`[${LOG}] sync ${id}: já avançou p/ situacao ${situAtual} (resolvido, sem mover)`);
        } else if (sumiu) {
          // não existe mais no Bling: não há o que sincronizar — encerra e para de tentar
          conf[id].sincronizado = true;
          conf[id].sincronizado_em = new Date().toISOString();
          conf[id].sync_resolvido = 'pedido-excluido-no-bling';
          delete conf[id].sync_erro;
          jaAvancados++;
          console.log(`[${LOG}] sync ${id}: pedido não existe mais no Bling (excluído) — encerrado, não tenta mais`);
        } else {
          conf[id].sync_erro = String(r.status || 'err');
          falhas++;
          console.log(`[${LOG}] sync ${id} FALHOU (${r.status}) ${r.raw || ''}`);
        }
      }
      await sleep(PAUSA_MS);
    }
    if (ids.length) writeJson(CONFERIDOS_FILE, conf);
    ultimoSync = { em: new Date().toISOString(), pendentes: ids.length, ok, falhas, jaAvancados };
    return ultimoSync;
  }

  async function listarAtendidos() {
    const hoje = new Date();
    const ini  = new Date(hoje); ini.setDate(ini.getDate() - JANELA_DIAS);
    /* Codex #213 (P1, teria congelado a fila HOJE): o Bling tem o bug documentado de OMITIR
       as vendas do próprio dia quando dataFinal = hoje — o canário já contorna somando +1
       (ver _listarNoBlingCanario). Com o parâmetro antigo ignorado o bug nunca mordia; ao
       ativar o filtro de verdade, venda nova ficaria invisível pro estoquista até amanhã. */
    const fimJanela = new Date(hoje); fimJanela.setDate(fimJanela.getDate() + 1);
    /* 26/08, decisão do dono: a "janela" antiga era FICTÍCIA — dataEmissaoInicial/Final não
       existem no /pedidos/vendas e o Bling ignorava o filtro, listando TODOS os ATENDIDO de
       qualquer idade (foi isso, aliás, que manteve os 7 Full acampados visíveis pra
       reconciliação). Oficializado: janela REAL de 60 dias com o parâmetro CERTO da API v3
       (dataInicial/dataFinal — o mesmo que o backfill provou com `fora: 0`). Dois meses pega
       tudo que legitimamente vive em ATENDIDO; mais velho que isso é ruído que ele decidiu
       cortar. */
    const qs = `idSituacao=${SIT_ATENDIDO}&dataInicial=${dataISO(ini)}&dataFinal=${dataISO(fimJanela)}`;
    const out = [];
    let fetchOk = false;
    let completa = false;              // só true se a paginação foi até o fim SEM falhar no meio
    let paginasRefeitas = 0, falhouNaPagina = null;
    for (let pagina = 1; pagina <= 50; pagina++) {
      // 13/08 — uma falha isolada (429/timeout do Bling) fazia a lista voltar INCOMPLETA e a
      // reconciliação era pulada TODA vez. Efeito medido na Girassol: 9 pedidos ML já despachados
      // presos como "sem etiqueta" no painel. Cada página é re-tentada antes de desistir.
      // (22/08: só a Girassol tinha isso — a paridade por feature revelou que AMB e GOOD não.)
      let ok = false, data = null;
      for (let tent = 1; tent <= 4; tent++) {
        // Codex PR#53: o node-fetch v2 usado pelo blingGet NÃO tem timeout por padrão — se o Bling
        // aceita a conexão e não responde, o await ficava pendurado pra sempre: o ciclo travava e
        // a re-tentativa (o motivo deste PR) nunca acontecia. Cada tentativa tem prazo próprio.
        const TETO_MS = 45000;
        // Codex (#183): o Promise.race rejeitava só a ESPERA — o fetch seguia vivo dentro do
        // blingGet, e cada página estourada deixava até 4 conexões penduradas, acumulando a cada
        // ciclo até esgotar recurso. Agora o AbortController cancela a requisição de verdade, e o
        // timer é limpo no sucesso pra não segurar o processo à toa.
        const _ac = new AbortController();
        const _tm = setTimeout(() => _ac.abort(), TETO_MS);
        try {
          ({ ok, data } = await blingGet(`/pedidos/vendas?${qs}&pagina=${pagina}&limite=100`, 3, _ac.signal));
        } catch (e) { ok = false; data = null; console.log('[' + LOG + '] página ' + pagina + ' tentativa ' + tent + ': ' + String(e.message || e).slice(0, 80)); }
        finally { clearTimeout(_tm); }
        if (!ok && _ac.signal.aborted) console.log('[' + LOG + '] página ' + pagina + ' tentativa ' + tent + ': timeout ' + TETO_MS + 'ms (abortada)');
        if (ok) { if (tent > 1) paginasRefeitas++; break; }
        await new Promise(r => setTimeout(r, 1200 * tent));
      }
      if (pagina === 1) fetchOk = ok;        // marca se o Bling respondeu (p/ não limpar cache offline)
      const lista = (data && data.data) || [];
      // ⚠️ ANTES: um !ok na página 2+ saía do loop e a lista PARCIAL era devolvida como ok=true —
      // a reconciliação então apagava do cache todo pedido que faltou (levando junto etiqueta anexada).
      if (!ok) { falhouNaPagina = pagina; break; }   // falhou 4× → completa fica FALSE
      if (lista.length === 0) { completa = true; break; }
      out.push(...lista);
      if (lista.length < 100) { completa = true; break; }
      await sleep(PAUSA_MS);
    }

    // ── FILTRO FULL ──────────────────────────────────────────────────────
    // Vendas de fulfillment (Shopee Full, Magalu Full…) entram no Bling em
    // situação ATENDIDO mas NÃO passam pelo galpão. A unidade de negócio Full
    // identifica essas vendas.
    //
    // ⚠️ DOIS problemas descobertos na API do Bling (30/07, via sonda):
    //  (1) a unidade vem em pedido.loja.unidadeNegocio.id — NÃO no topo do
    //      pedido. (O HTML da tela chama de idConfUnidadeNegocio, que não
    //      existe no JSON.)
    //  (2) a lista /pedidos/vendas OMITE unidadeNegocio de forma INTERMITENTE
    //      — duas chamadas idênticas, uma traz o campo, a outra não. Por isso,
    //      quando a lista não traz a unidade, buscamos o DETALHE do pedido
    //      (/pedidos/vendas/{id}), que sempre traz.
    //
    // Configurável por env <PREFIXO>_UN_FULL = "2920348,2920232". VAZIA = não
    // filtra nada (idêntico ao comportamento antigo).
    const UN_FULL = FULL_ATIVO ? unsFullEfetivas() : [];   // casa + env (a env só acrescenta — ver UNS_FULL_CASA); Full desligado: nenhuma
    let ocultosFull = 0;
    let pedidos = out;
    const idsFullVistos = [];   // ids que se confirmaram Full (p/ expurgar do cache antigo)
    let ocultosSemSerie = [];   // Full pela unidade, mas série não descoberta: esconde da fila, NÃO move
    /* ⚠️ 25/08, corrigido À NOITE com o dono: o ML FULL EMITE SÉRIE 1 — POR NÓS.
       A regra de ontem ("série 1 = emissão própria = NÃO é Full") nasceu do padrão da Shopee
       e Magalu Full, onde a NF vem ESPELHADA do marketplace (série ≠1). No ML a premissa é
       FALSA: as 407 notas de agosto da filial Full MLivre são todas série 1, emitidas pela
       matriz — e o ML posta do galpão dele mesmo assim. Resultado da regra antiga: venda Full
       real do ML era "desescondida" e aparecia na fila do estoquista como sem-etiqueta (4
       pedidos em <24h de deploy, e ia crescer um a cada venda).
       Nas unidades listadas aqui, série 1 NÃO derruba o Full — ela é a nota final do pedido,
       e confirma o move. O custo assumido (decisão do dono): clone de garantia de venda ML
       Full volta a ser movido como era antes do incidente — não há como separar pelo número
       da série, já que ambos são série 1. Shopee/Magalu Full seguem com a trava intacta. */
    const UN_EMISSAO_PROPRIA = new Set(UNS_EMISSAO_PROPRIA_CASA.concat(String(process.env[ENV + '_UN_FULL_EMISSAO_PROPRIA'] || '').split(',').map(x => x.trim()).filter(Boolean)));
    const unPorFull = new Map();                                 // id do pedido -> unidade que o classificou
    if (UN_FULL.length) {
      const setFull = new Set(UN_FULL);
      // lê a unidade das duas formas possíveis na lista
      /* ⚠️ 24/08 — SÓ VALE A UNIDADE DA LOJA. A sonda de 30/07 (comentário acima) já tinha
         achado que a unidade do Full vem em `pedido.loja.unidadeNegocio.id`, e NÃO no topo do
         pedido. Mesmo assim havia um segundo caminho lendo o topo — e era por ali que vazava:
         pedido criado À MÃO dentro do Bling não tem loja de marketplace, escapava do caminho
         certo, caía no topo e recebia a unidade PADRÃO da empresa. Se essa unidade estivesse na
         lista do Full, TODO pedido interno virava "Full" e ia parar em DESPACHADOS.
         Caso real na AMB em 24/08: pedidos 26687588614 e 3902 (26687728978), NF série 1 gerada
         automaticamente, mandados pra DESPACHADOS no mesmo minuto, repetidamente a cada ciclo.
         Full é venda de marketplace (Shopee Full, ML Full, Magalu Full); pedido sem loja NUNCA
         é Full. Sem loja com unidade Full → devolve null e o pedido não é tocado. */
      const unDaLista = (p) => (p && p.loja && p.loja.unidadeNegocio && p.loja.unidadeNegocio.id) || null;
      // 1ª passada: decide pelo que a lista trouxe; junta os "sem unidade" p/ checar no detalhe
      const indefinidos = [];
      for (const p of out) {
        const un = unDaLista(p);
        if (un != null) {
          if (setFull.has(String(un))) { ocultosFull++; idsFullVistos.push(String(p.id)); unPorFull.set(String(p.id), String(un)); }
        } else if (p && p.loja) {
          indefinidos.push(p);   // TEM loja mas a lista omitiu a unidade → precisa do detalhe
        } else {
          /* 24/08: sem loja nenhuma = pedido criado à mão no Bling. Nunca é Full, então buscar o
             detalhe não mudaria a classificação — só gastaria uma chamada + PAUSA_MS por pedido,
             a cada 10 min, nos 5 dias da janela. Com muitos pedidos internos isso queima cota
             do Bling e arrasta o ciclo inteiro. */
        }
      }
      // 2ª passada: só os indefinidos → busca o detalhe (que sempre traz a unidade)
      const idsFullSet = new Set(idsFullVistos);
      for (const p of indefinidos) {
        try {
          const det = await detalhePedido(p.id);
          // mesma regra do unDaLista: só a unidade da LOJA vale (ver o porquê logo acima)
          const un = (det && det.loja && det.loja.unidadeNegocio && det.loja.unidadeNegocio.id) || null;
          if (un != null && setFull.has(String(un))) { ocultosFull++; idsFullVistos.push(String(p.id)); unPorFull.set(String(p.id), String(un)); idsFullSet.add(String(p.id)); }
        } catch (e) { /* se o detalhe falhar, não esconde — melhor mostrar que sumir por engano */ }
        await sleep(PAUSA_MS);
      }
      /* ═══ SÉRIE DA NF DECIDE (24/08, revisto) ═════════════════════════════════════════════
         Clonar pedido no Bling COPIA a unidade de negócio. O clone de uma venda Full nasce
         carimbado como Full mesmo saindo do galpão DELES, e o filtro acertava em cima de um
         dado errado. Série 1 = emissão nossa, da matriz → não é Full.

         ⚠️ CORREÇÃO DO QUE FOI AO AR ÀS 20:12 DE 24/08: eu tratava "não consegui descobrir a
         série" como se fosse Full, e o pedido era MOVIDO. O log provou o estrago: o pedido
         26687588614 (NF 003464, série 1) foi protegido às 20:12 e MOVIDO às 20:15 — mesmo
         pedido, 3 minutos depois. A diferença foi um 429 do Bling na consulta da NF (o log
         está cheio deles). Não saber NÃO pode autorizar uma ação destrutiva.

         Agora as duas decisões são separadas, porque o risco de errar é assimétrico:
           · ESCONDER da fila  → na dúvida, ESCONDE (se for Full de verdade, o estoquista não
             pode ir procurar mercadoria que está no galpão do marketplace)
           · MOVER/EXPURGAR    → na dúvida, NÃO MEXE (mover é destrutivo e só se desfaz na mão;
             deixar quieto custa um ciclo de espera até a consulta funcionar)

         E a série descoberta fica GUARDADA por pedido: uma vez que se sabe, um 429 depois não
         desfaz mais a proteção. */
      if (idsFullVistos.length) {
        const SERIE_FILE = path.join(CACHE_DIR, '_serie_nf.json');
        const serieCache = readJson(SERIE_FILE, {});
        const derrubados = [], semResposta = [], venceuEspera = [];
        const _consultaFalhou = new Set();   // Bling não respondeu — diferente de 'não tem NF'
        const _notaIlegivel = new Set();     // nota vinculada LIDA sem série no corpo (XML importado) — confirmação, relógio corre
        let mudouCache = false;
        for (const idF of idsFullVistos.slice()) {
          /* O cache tem VALIDADE (30 min) e a regra é simples: VENCIDO NÃO VALE.
             Se a renovação funcionar, usa o valor novo. Se falhar (429), fica DESCONHECIDA —
             que já é o estado seguro: esconde da fila e NÃO move.

             Eu tinha tentado ser esperto aqui, mantendo o valor vencido quando ele era série 1,
             e errei nos dois sentidos (Codex #195):
               · uma série 1 vencida cuja NF foi trocada por uma Full faria o pedido APARECER
                 pro estoquista, que iria procurar mercadoria parada no galpão do marketplace;
               · e a linha que anulava o vencido rodava mesmo quando a renovação tinha dado
                 certo — um Full confirmado voltava pra "desconhecida" e nunca era movido.
             Vencido = desconhecido resolve os dois, e não perde o objetivo original: um 429
             continua não conseguindo MOVER nada. */
          const chaveS = String(idF);
          const guardado = serieCache[chaveS];
          const valeAinda = guardado && guardado.ts && (Date.now() - Number(guardado.ts)) <= 30 * 60 * 1000;
          let info = valeAinda ? guardado : null;
          if (!valeAinda) {
            let nfF = null;
            try { nfF = await serieDaNFdoPedido(idF); } catch (e) { nfF = { falhou: true }; }
            await sleep(PAUSA_MS);
            if (nfF && nfF.falhou) _consultaFalhou.add(String(idF));   // não foi "sem NF" — foi não perguntei
            if (nfF && nfF.nfSemSerie) _notaIlegivel.add(String(idF));  // nota lida, série ausente: CONFIRMA e o relógio corre
            if (nfF && nfF.serie) {
              info = { serie: String(nfF.serie), nf: nfF.numero || null, ts: Date.now() };
              serieCache[chaveS] = info; mudouCache = true;
            }
          }
          /* ⚠️ LIMPA O RELÓGIO SEMPRE QUE DESCOBRIU A SÉRIE — inclusive na série 1 (Codex #199).
             Antes a limpeza só acontecia no ramo do Full confirmado. Um clone visto primeiro
             SEM nota e depois identificado como série 1 ficava com o `espera:` antigo gravado;
             passados os 30 min do cache da série, uma consulta que temporariamente não achasse
             a nota leria aquele carimbo como "6h já se passaram" e MOVERIA o clone protegido,
             em vez de começar uma espera nova. */
          /* ⚠️ marcar mudouCache: apagar só na memória não reescreve o _serie_nf.json, e o
             carimbo velho ressuscita no próximo boot — voltando a autorizar o move do clone
             protegido. Só marca quando a chave EXISTIA, pra não gravar o arquivo à toa. */
          if (info && serieCache['espera:' + chaveS]) { delete serieCache['espera:' + chaveS]; mudouCache = true; }
          if (info && String(info.serie) === '1' && !UN_EMISSAO_PROPRIA.has(String(unPorFull.get(String(idF)) || ''))) {
            derrubados.push({ id: idF, nf: info.nf });
            const ix = idsFullVistos.indexOf(idF);
            if (ix >= 0) idsFullVistos.splice(ix, 1);
            ocultosFull--;                                        // sai da contagem: não é Full
          } else if (!info) {
            /* ⚠️ "não sei a série" é CEDO, não é PARA SEMPRE (corrigido 25/08).
               A NF do Full vem ESPELHADA do marketplace e demora a chegar no Bling — nas
               primeiras horas o pedido legitimamente não tem nota. Eu tratei isso como estado
               permanente e o resultado foi 3 Full de verdade (2 Shopee Full + 1 Magalu Full)
               parados em ATENDIDO indefinidamente, ciclo após ciclo.
               Agora a espera tem PRAZO: marco quando comecei a tentar e, passadas 6h sem
               descobrir a série, movo — a unidade continua dizendo Full e já esperei o
               suficiente. O clone de garantia não é afetado: o Bling emite a NF dele ao
               SALVAR, então ele tem série 1 desde o primeiro minuto e cai no ramo de cima. */
            /* ⚠️ O RELÓGIO SÓ CORRE QUANDO O BLING CONFIRMOU QUE NÃO HÁ NOTA (Codex #199).
               `serieDaNFdoPedido` devolve vazio por DOIS motivos diferentes: o pedido não tem
               NF, ou a consulta não foi (429, Bling fora). Contar os dois igual significaria
               que 6h de 429 movem o pedido sem eu NUNCA ter olhado a nota — e se fosse um
               clone de garantia, seria exatamente o estrago que esta trava existe pra impedir.
               Consulta que falhou não avança o relógio: espera e tenta de novo. */
            if (_consultaFalhou.has(String(idF))) {
              semResposta.push(String(idF));                      // não perguntei ainda: espera, sem contar tempo
            } else {
              /* ⚠️ Codex #199 (P1): o relógio conta TEMPO CONFIRMADO, não tempo de parede.
                 O desenho anterior guardava só o `desde`: se o marcador nascesse e viessem horas
                 de 429, a PRIMEIRA resposta boa depois da pane encontraria o carimbo velho e
                 moveria o pedido na hora — 6h "vencidas" sem NENHUMA confirmação no meio.
                 Agora cada resposta "sem NF" soma ao acumulado apenas o intervalo desde a
                 confirmação anterior, com teto de 30 min por passo: ciclos normais (10 min)
                 somam inteiros; uma pane de horas entre duas confirmações soma no máximo 30
                 min. Falha continua sem tocar no marcador (ramo do _consultaFalhou acima).
                 Marcador antigo, só com `desde`, recomeça do zero — o lado seguro. */
              if (ESPERA_FULL_MS <= 0) {                       // ordem do dono: NA HORA
                venceuEspera.push(String(idF));
                continue;
              }
              const espera = serieCache['espera:' + chaveS];
              const agoraE = Date.now();
              if (!espera || !espera.ult) {
                serieCache['espera:' + chaveS] = { desde: agoraE, ult: agoraE, acum: 0 };
                mudouCache = true;
                semResposta.push(String(idF));                    // 1ª confirmação de "sem NF": começa o relógio
              } else {
                const passo = Math.max(0, Math.min(agoraE - Number(espera.ult), 30 * 60 * 1000));
                espera.acum = Number(espera.acum || 0) + passo;
                espera.ult = agoraE;
                mudouCache = true;
                if (espera.acum < ESPERA_FULL_MS) {
                  semResposta.push(String(idF));                  // ainda não somou 6h confirmadas
                } else {
                  venceuEspera.push(String(idF));                 // 6h CONFIRMADAS sem nota: MOVE
                }
              }
            }
          }
        }
        if (mudouCache) { try { writeJson(SERIE_FILE, serieCache); } catch (e) {} }
        if (derrubados.length) {
          console.log(`[${LOG}] série 1 derrubou o Full em ${derrubados.length} pedido(s) (emissão nossa, provável clone de venda Full): ` +
            derrubados.map(d => `pedido ${d.id}/NF ${d.nf}`).join(', '));
        }
        if (venceuEspera.length) {
          /* Codex #199 (P2, vinha da GOOD): com o destino DESLIGADO (SIT_DESPACHADOS=0, id da conta nunca configurado) o
             bloco do move lá embaixo nem roda — anunciar "movendo" mentiria a cada ciclo, escondendo exatamente a condição
             de pedido preso que este log existe pra diagnosticar */
          if (SIT_DESPACHADOS) {
            console.log(`[${LOG}] série não veio em ${Math.round(ESPERA_FULL_MS/60000)}min — movendo assim mesmo (a unidade diz Full e a NF do marketplace não chegou): ` + venceuEspera.join(', '));
          } else {
            console.log(`[${LOG}] série não veio em ${Math.round(ESPERA_FULL_MS/60000)}min em ${venceuEspera.length} pedido(s), mas o move está DESLIGADO (${ENV}_SIT_DESPACHADOS não configurado) — ficam em ATENDIDO: ` + venceuEspera.join(', '));
          }
        }
        if (semResposta.length) {
          console.log(`[${LOG}] série NÃO descoberta em ${semResposta.length} pedido(s) — NÃO vou mover (fica em ATENDIDO até dar pra conferir): ` +
            ` (${_consultaFalhou.size} falhada(s), sem contar tempo; ${semResposta.filter(i => _notaIlegivel.has(String(i))).length} com nota lida sem série, relógio corre; demais aguardando ${Math.round(ESPERA_FULL_MS/60000)}min)` + semResposta.join(', '));
          // some da lista de move/expurgo, mas segue escondido da fila (risco assimétrico)
          for (const idS of semResposta) {
            const ix = idsFullVistos.indexOf(idS);
            if (ix >= 0) idsFullVistos.splice(ix, 1);
          }
          ocultosSemSerie = semResposta.slice();
        }
      }

      // aplica: esconde da fila os Full confirmados E os que ainda não deu pra conferir
      const idsFullFinal = new Set(idsFullVistos.concat(ocultosSemSerie).map(String));
      pedidos = out.filter(p => !idsFullFinal.has(String(p.id)));
      if (ocultosFull) console.log(`[${LOG}] filtro Full: ${ocultosFull} pedido(s) ocultado(s) da fila do estoquista (UN ${UN_FULL.join(',')}; ${indefinidos.length} checado(s) por detalhe)`);
    }

    return { ok: fetchOk, completa, pedidos, ocultosFull, idsFullVistos, idsSemSerie: ocultosSemSerie,
             paginas_refeitas: paginasRefeitas, falhou_na_pagina: falhouNaPagina };
  }

  async function detalhePedido(id, signal) {
    // signal opcional: sem prazo, uma resposta que nunca chega pendura o await pra sempre
    const { data } = await blingGet(`/pedidos/vendas/${id}`, 3, signal);
    return data && data.data;
  }
  /* Codex #212 (o achado vale aqui também — o #211 pôs o sentinela no helper ERRADO): o
     detalhePedido tem 4 chamadores e três (classificador de unidade, cachear, curas) só
     checam `if (!det)` — o objeto {naoExiste} passaria por pedido de verdade, com direito a
     /undefined e pasta CACHE_DIR/undefined. O sentinela vive AQUI, num invólucro exclusivo
     da reconciliação — único lugar onde "apagado no Bling" significa remoção. */
  async function detalheParaReconciliacao(id, signal) {
    const r = await blingGet(`/pedidos/vendas/${id}`, 3, signal);
    if (r && Number(r.status) === 404) return { naoExiste: true };   // apagado: com certeza não está em ATENDIDO
    return r && r.data && r.data.data;
  }

  async function cachearPedido(ped, cacheEan, nfs, kitCache, locC, nfCtx) {
    const id  = ped.id;
    const dir = path.join(CACHE_DIR, String(id));
    ensureDir(dir);

    const lojaId = String((ped.loja && ped.loja.id) || '');
    const mkt = LOJA_MKT[lojaId] || 'outro';   // marketplace (usado p/ etiqueta MM e snapshot)

    const itens = [];
    let temKit = false;
    for (const it of (ped.itens || [])) {
      const itemQty = Number(it.quantidade || 0);
      const prodId  = it.produto && it.produto.id;
      const prod    = await produtoDetalhe(prodId); await sleep(PAUSA_MS);
      const sku     = it.codigo || (prod && prod.codigo) || (it.produto && it.produto.codigo) || '';
      const eanItem = prod ? primeiroEan(prod) : await eanDoItem(prodId, sku, cacheEan);
      if (sku && eanItem) cacheEan[sku] = eanItem;
      if (sku && locC) locC[sku] = localizacaoDeProduto(prod);     // localização do produto principal
      const descr   = it.descricao || (prod && prod.nome) || '';
      const imgItem = primeiraImagem(prod);

      const comps = (prod && prod.estrutura && Array.isArray(prod.estrutura.componentes))
        ? prod.estrutura.componentes : [];

      if (comps.length) {
        // KIT / composição → explode nos componentes (com cache por produto-pai)
        temKit = true;
        let base = kitCache && kitCache[prodId];
        if (base && base.some(c => !c.sku)) base = null;   // cache tinha componente vazio (falha anterior) → resolve de novo
        if (!base) {
          base = [];
          let incompleto = false;
          for (const c of comps) {
            const info = await infoProduto(c.produto && c.produto.id, cacheEan);
            if (!info.sku) incompleto = true;
            base.push({ sku: info.sku, ean: info.ean, descricao: info.descricao, img: info.img, loc: info.loc, qtd: Number(c.quantidade || 1) });
          }
          if (kitCache && !incompleto) kitCache[prodId] = base;   // SÓ grava se TODOS resolveram (não fixa falha transitória)
        }
        if (locC) base.forEach(c => { if (c.sku) locC[c.sku] = c.loc || locC[c.sku] || ''; }); // localização dos componentes
        // qtd final = qtd do componente no kit × qtd do kit no pedido
        const componentes = base.map(c => ({ sku: c.sku, ean: c.ean, descricao: c.descricao, img: c.img, qtd: c.qtd * (itemQty || 1) }));
        itens.push({ sku, ean: eanItem, descricao: descr, img: imgItem, qtd: itemQty, valor_unit: (it.valor != null ? Number(it.valor) : null), valor_total: (it.valor != null ? Number(it.valor) * (itemQty || 1) : null), tipo: 'kit', componentes });
      } else {
        const tipo = (prod && prod.variacao && prod.variacao.produtoPai) ? 'variacao' : 'simples';
        itens.push({ sku, ean: eanItem, descricao: descr, img: imgItem, qtd: itemQty, valor_unit: (it.valor != null ? Number(it.valor) : null), valor_total: (it.valor != null ? Number(it.valor) * (itemQty || 1) : null), tipo });
      }
    }

    let nf = acharNFnaLista(id, nfs || [], { numeroLoja: ped.numeroLoja, usadasIds: nfCtx && nfCtx.usadasIds, donoPorNumero: nfCtx && nfCtx.donoPorNumero });
    if (nf && nf._ambigua) { console.log(`[NF-CASA] pedido ${id}: faixa ambígua (NF disputada por outro pedido) → usando vínculo direto`); nf = null; }
    if (!nf || !nf.id) { nf = await nfDoPedido(id); await sleep(PAUSA_MS); }   // fora do range do lote (ou ambíguo) → vínculo direto pedido→NF
    if (nf && nf.id && nfCtx) {
      if (nfCtx.usadasIds) nfCtx.usadasIds.add(Number(nf.id));
      if (nfCtx.donoPorNumero && nf.numero != null) nfCtx.donoPorNumero[String(nf.numero)] = String(id);
    }
    // AUTO-CURA: se a NF deste pedido MUDOU vs cache anterior, DANFE/nf-simp antigas são de OUTRA nota → descarta p/ re-baixar as certas
    try {
      const _snapAnt = readJson(path.join(dir, 'pedido.json'), null);
      const _antId = _snapAnt && _snapAnt.nf && _snapAnt.nf.id;
      if (_antId && (!nf || Number(nf.id) !== Number(_antId))) {
        // porte (Codex): NF ANEXADA à mão? preserva o danfe.pdf (é o arquivo que o admin
        // subiu) mas o nf-simp.json morre do mesmo jeito — ele é dado PARSEADO da nota
        // antiga, e a DANFE simplificada e a etiqueta fundida imprimem dele.
        const _anexada = !!(_snapAnt && _snapAnt.nf_anexada);
        for (const fdel of (_anexada ? ['nf-simp.json'] : ['danfe.pdf', 'nf-simp.json'])) { try { fs.unlinkSync(path.join(dir, fdel)); } catch (e) {} }
        console.log(`[NF-CASA] pedido ${id}: NF corrigida (${_antId} → ${(nf && nf.id) || 'nenhuma'}) — ${_anexada ? 'DANFE ANEXADA preservada, nf-simp regerada' : 'DANFE antiga descartada'}`);   /* 30/10: o log diz a verdade quando a DANFE anexada fica (vinha da Girassol) */
      }
    } catch (e) {}

    const _etqPath = path.join(dir, `etiqueta.${ETIQ_FORMATO.toLowerCase()}`);
    const _etqPdfPath = path.join(dir, 'etiqueta.pdf');
    let temEtiqueta = fs.existsSync(_etqPath);   // etiqueta ZPL imutável → se já tem, não re-baixa (re-cache leve)
    let etqEhPdf = false;
    if (temEtiqueta) {
      try { if (fs.readFileSync(_etqPath, 'utf8').indexOf('^XA') < 0) etqEhPdf = true; } catch (e) {}   // arquivo salvo não é ZPL → etiqueta PDF
    } else if (fs.existsSync(_etqPdfPath) && mkt !== 'madeira') {
      temEtiqueta = true; etqEhPdf = true;          // já tem só o PDF cacheado (Amazon etc) — Madeira tem bloco próprio abaixo
    } else {
      const conteudoEtiqueta = await baixarEtiqueta(id); await sleep(PAUSA_MS);
      if (conteudoEtiqueta && conteudoEtiqueta.indexOf('^XA') >= 0) {       // ZPL de verdade (ML, Shopee...)
        fs.writeFileSync(_etqPath, conteudoEtiqueta); temEtiqueta = true;
      } else if (conteudoEtiqueta || mkt === 'amazon') {                    // veio não-ZPL, OU é Amazon (cujo link ZPL vem nulo) → etiqueta é PDF
        // captura o PDF nativo do Bling AGORA (ele ainda serve); depois do despacho ele para de servir e o email ficaria sem etiqueta.
        // o "|| mkt==='amazon'" pega o caso da Amazon (sem ZPL); ML/Shopee com falha transitória NÃO caem aqui (ficam p/ o próximo ciclo).
        try { const pdf = await baixarEtiquetaPDF(id); await sleep(PAUSA_MS); if (pdf && pdf.length) { fs.writeFileSync(_etqPdfPath, pdf); temEtiqueta = true; etqEhPdf = true; } } catch (e) {}
      }
    }
    let _motivoEtq = null;   /* 15/10: motivo da última tentativa de etiqueta (vai pro card) */
    /* Codex #698: Full CONFIRMADO numa rodada anterior não é perguntado de novo (o tipo do envio não muda)
       — e uma consulta que falhe agora não pode devolvê-lo à fila do galpão */
    const _fullAntes = (() => { try { const ps = JSON.parse(fs.readFileSync(path.join(dir, 'pedido.json'), 'utf8')); return !!(ps && ps.full_ml); } catch (e) { return false; } })();
    const _motivoAntes = (() => { try { const ps = JSON.parse(fs.readFileSync(path.join(dir, 'pedido.json'), 'utf8')); return (ps && ps.etq_motivo) || null; } catch (e) { return null; } })();
    let _fullML = _fullAntes;   /* 15/10: o próprio ML diz que o envio é FULL (o Bling registrou como loja comum).
       Codex #698 r2: já vale ANTES de qualquer chamada ao ML — token ou envio que falhem não o derrubam */
    if (_fullAntes) _motivoEtq = _motivoAntes || 'venda FULL no Mercado Livre — sai do centro de distribuição do ML, não do galpão (o Bling registrou como loja comum)';
    /* 17/10 (Codex #706): a marca de "aguardando o ML liberar" da rodada anterior vale até uma consulta BEM-SUCEDIDA
       dizer o contrário — token/ML fora não devolve o pedido à fila de sem etiqueta */
    const _dispAntes = (() => { try { const ps = JSON.parse(fs.readFileSync(path.join(dir, 'pedido.json'), 'utf8')); return !!(ps && ps.aguardando_disp); } catch (e) { return false; } })();
    let _aguardaDispML = _dispAntes;   /* 17/10: envio do ML em manufacturing/buffered (prazo de disponibilidade / envio programado) — fora da fila */
    // FALLBACK ML: Bling sem logística cadastrada (ex: pedido que ficou dias travado no ML sem NF —
    // o Bling não registra o envio e o /logisticas/etiquetas dá 404 pra sempre).
    // → baixa a etiqueta ZPL direto do Mercado Livre (shipment_labels) com o token ML da empresa.
    if (!temEtiqueta && mkt === 'ml' && ped.numeroLoja && !_fullAntes) {   /* Full já confirmado: nada a perguntar ao ML */
      try {
        const { garantirTokenML } = o.mlTokenManager();
        const { getShipmentInfo, getShipmentSubstatus } = o.mlApi();
        const tokenML = await garantirTokenML();
        const shipmentId = await getShipmentInfo(tokenML, ped.numeroLoja);
        /* 15/10 — VENDA FULL QUE O BLING REGISTROU COMO LOJA COMUM. O checkout reconhece Full pela unidade de
           negócio da loja do pedido; quando o Bling grava uma venda Full na loja comum (caso da AMB, 13-15/10:
           loja MLivre, unidade Matriz), ela cai na fila do galpão como "sem etiqueta" — o ML não libera
           etiqueta de Full. Antes de pedir a etiqueta, pergunta ao PRÓPRIO ML o tipo do envio: fulfillment
           = sai do centro de distribuição dele. Sai da fila (sem mexer em nada no Bling) e o painel avisa. */
        let _logiML = _fullAntes ? 'fulfillment' : null;
        let _stML = null, _subML = null, _stOk = false;   /* 17/10: status/substatus do envio (vem na mesma consulta); _stOk = a consulta respondeu */
        if (!_fullAntes) {
          try { const rS = await fetch(`https://api.mercadolibre.com/shipments/${shipmentId}`, { headers: { Authorization: `Bearer ${tokenML}`, 'x-format-new': 'true' } });
            if (rS.ok) { const jS = await rS.json(); _logiML = (jS && jS.logistic && jS.logistic.type) || (jS && jS.logistic_type) || null; _stML = (jS && jS.status) || null; _subML = (jS && jS.substatus) || null; _stOk = true; } } catch (e) {}
        }
        if (_logiML === 'fulfillment') {
          _fullML = true; _motivoEtq = (_fullAntes && _motivoAntes) || 'venda FULL no Mercado Livre — sai do centro de distribuição do ML, não do galpão (o Bling registrou como loja comum)';
          console.log(`[${LOG}] ${ped.numero}: venda FULL no ML gravada no Bling como loja comum — fora da fila do galpão`);
        } else if (_stOk ? /manufacturing|buffered/i.test(String(_subML || '')) : _dispAntes) {
          /* 17/10 — O ML AINDA NÃO LIBEROU O ENVIO. Dois estados da documentação de envios do ML:
               · manufacturing — "Aguardando disponibilidade de estoque": a etiqueta só sai depois que o vendedor clica
                 "Já estou com o produto" (o dono vende assim de propósito, pra faturar no mês seguinte);
               · buffered — envio programado: o ML segura e libera a etiqueta na data que ele definir.
             Nenhum dos dois é problema do galpão: sai da fila de "sem etiqueta" e o painel avisa à parte. A cada
             ciclo o ML é perguntado de novo; liberou, a etiqueta vem pelo caminho normal. Consulta que falhou mantém
             a marca da rodada anterior (Codex #706). */
          _aguardaDispML = true;
          if (!_stOk) _motivoEtq = _motivoAntes || 'aguardando o ML liberar o envio (a última consulta ao ML falhou — marca mantida)';
          else if (/buffered/i.test(String(_subML || ''))) _motivoEtq = 'envio programado pelo ML (buffered) — a etiqueta sai na data que o ML definir';
          else _motivoEtq = 'aguardando disponibilidade de estoque no ML — a etiqueta só sai depois de "Já estou com o produto"';
          /* 17/10: pedido retido pelo ML que JÁ tem nota (emitida antes da hora) entra na lista de espera do F3, que
             manda a nota ao ML quando ele pedir (no dia da coleta), fora da janela curta do F3. É também por aqui que
             as notas de ANTES deste conserto (que o F3 já tinha desistido) são resgatadas. */
          if (_stOk && nf && nf.id && (nf._criterio === 'exato' || nf._criterio === 'direto')) {   /* exato = nº do pedido na loja; direto = vínculo do próprio Bling (nfDoPedido); faixa (palpite) fica de fora */   /* Codex #707: só nota casada EXATAMENTE pelo nº do pedido na loja — o casamento por faixa de id pode ser de outro pedido */
            try { const _agF3 = require('../fiscal/f3-aguardando-ml');
              if (!_agF3.ler(o.empresaFiscal)[String(nf.id)]) _agF3.registrar(o.empresaFiscal, nf.id, { numero: nf.numero || null, pedido_ml: String(ped.numeroLoja), status: _stML, substatus: _subML, proxima: 0, origem: 'checkout' });
            } catch (e) {}
          }
        } else {
        if (_stOk) _aguardaDispML = false;   /* 17/10: o ML respondeu e o envio não está mais esperando — volta ao normal */
        const r = await fetch(`https://api.mercadolibre.com/shipment_labels?shipment_ids=${shipmentId}&response_type=zpl2`, { headers: { Authorization: `Bearer ${tokenML}` } });
        if (r.ok) {
          const buf = await r.buffer();
          let zpl = null;
          if (buf && buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4B) {   // veio ZIP → extrai o .txt/.zpl de dentro
            const AdmZip = require('adm-zip');
            const zip = new AdmZip(buf);
            const ent = zip.getEntries().find(e => /\.(txt|zpl)$/i.test(e.entryName)) || zip.getEntries()[0];
            zpl = ent ? ent.getData().toString('utf8') : null;
          } else if (buf) {
            zpl = buf.toString('utf8');
          }
          if (zpl && zpl.indexOf('^XA') >= 0) {
            fs.writeFileSync(_etqPath, zpl); temEtiqueta = true;
            console.log(`[${LOG}] etiqueta ${ped.numero} baixada DIRETO do ML (fallback, shipment ${shipmentId})`);
          } else {
            console.log(`[${LOG}] fallback ML ${ped.numero}: resposta sem ZPL (etiqueta ainda não liberada no ML?)`); _motivoEtq = 'o ML ainda não liberou a etiqueta';
          }
        } else {
          let det400 = ''; try { det400 = (await r.text()).slice(0, 220).replace(/\s+/g, ' '); } catch (e) {}
          let sub400 = ''; try { const st = await getShipmentSubstatus(tokenML, shipmentId); sub400 = `${st.status}/${st.substatus}`; if (/manufacturing|buffered/i.test(String(st.substatus || ''))) _aguardaDispML = true; /* Codex #706: a 1ª consulta falhou mas esta respondeu — classifica já */ } catch (e) {}
          console.log(`[${LOG}] fallback ML ${ped.numero}: shipment_labels HTTP ${r.status} shipment=${sub400 || '?'} motivo=${det400}`);
          _motivoEtq = _motivoEtqML(r.status, sub400, det400);
        }
        }   /* fim do 'não é Full' */
      } catch (e) { console.log(`[${LOG}] fallback ML ${ped.numero}: ${String(e.message || e).slice(0, 160)}`); _motivoEtq = 'ML: ' + _semSegredo(e.message || e).slice(0, 100); }
    }
    // FALLBACK SHOPEE (b15): quando o Bling não trouxe a etiqueta (importou o pedido depois do envio
    // já organizado, ou a NF travou a edição → /logisticas/etiquetas 404 pra sempre), busca a etiqueta
    // DIRETO na API oficial da Shopee, via o serviço shopee-nf-sync que guarda os tokens.
    // Vem em ZPL (a conta imprime térmico) — mesmo formato do Bling, cai no fluxo normal de impressão.
    // Modo &rapido=1: só baixa documento que já existe (~3s), sem create/polling, pra não travar o ciclo.
    // Precisa da env SHOPEE_SYNC_KEY; sem ela o bloco nem tenta.
    // 30/07 — FREIO: sem isso ele repete a MESMA chamada a cada 2 min pra sempre (o caso 2577
    // falhou 18x seguidas com o mesmo erro). Depois de 3 falhas, espera 1 hora antes de tentar de
    // novo naquele pedido. Assim para de gastar chamada (e de somar aos 429) num pedido que não
    // vai resolver sozinho — mas continua tentando de tempos em tempos, caso a Shopee libere.
    const _shKey = 'sh:' + String(ped.numeroLoja || ped.numero);
    const _shSt = (!temEtiqueta && mkt === 'shopee') ? _freioSh.estado(_shKey) : null;   /* 19/10: 5→10→20→30 min; o "Bling agora" zera */
    const _shFreado = !!_shSt;
    if (_shFreado) {
      console.log(`[${LOG}] fallback Shopee ${ped.numero}: em espera (${_shSt.n} falhas seguidas, pr\u00f3xima tentativa em ${_shSt.faltaMin} min)`)
      _motivoEtq = 'Shopee: ' + (_shSt.ultimo || 'falhou ' + _shSt.n + 'x seguidas') + ' — nova tentativa em ' + _shSt.faltaMin + ' min (ou clique em 🔄 Bling agora)';
    }
    if (!_shFreado && !temEtiqueta && mkt === 'shopee' && ped.numeroLoja && process.env.SHOPEE_SYNC_KEY) {
      try {
        const SH_URL = process.env.SHOPEE_SYNC_URL || 'https://girassol-shopee-sync-organizar-envio.onrender.com';
        const urlEtq = SH_URL + '/' + LOJA_SHOPEE + '/interno/etiqueta?rapido=1&k=' + encodeURIComponent(process.env.SHOPEE_SYNC_KEY) + '&order_sn=' + encodeURIComponent(String(ped.numeroLoja).trim());
        const rSh = await fetch(urlEtq, { timeout: 45000 });
        if (rSh.ok) {
          const bufSh = await rSh.buffer();
          const fmtSh = String(rSh.headers.get('x-etiqueta-formato') || '').toLowerCase();
          const ehZpl = fmtSh === 'zpl' || (bufSh && bufSh.slice(0, 400).toString('utf8').indexOf('^XA') >= 0);
          const ehPdfSh = fmtSh === 'pdf' || (bufSh && bufSh.slice(0, 4).toString('utf8') === '%PDF');
          if (bufSh && bufSh.length > 300 && ehZpl) {
            fs.writeFileSync(_etqPath, bufSh); temEtiqueta = true; _freioSh.ok(_shKey);   // ZPL no caminho nativo
            console.log(`[${LOG}] etiqueta ${ped.numero} baixada DIRETO da Shopee em ZPL (${bufSh.length} bytes)`);
          } else if (bufSh && bufSh.length > 300 && ehPdfSh) {
            fs.writeFileSync(_etqPdfPath, bufSh); temEtiqueta = true; etqEhPdf = true; _freioSh.ok(_shKey);
            console.log(`[${LOG}] etiqueta ${ped.numero} baixada DIRETO da Shopee em PDF (${bufSh.length} bytes)`);
          } else {
            console.log(`[${LOG}] fallback Shopee ${ped.numero}: resposta sem etiqueta reconhecível`); _motivoEtq = 'a Shopee ainda não liberou a etiqueta';
          }
        } else {
          // 30/07: o corte em 200 caracteres escondia justamente o que interessa — a lista
          // "selecionaveis" com os formatos que a Shopee aceita PRA ESTE pedido. Sem ela não dá
          // pra saber qual formato pedir. Agora vai inteiro (até 1200) e, quando dá pra ler o
          // JSON, destacamos o formato aceito numa linha própria.
          let detSh = ''; try { detSh = (await rSh.text()).slice(0, 1200).replace(/\s+/g, ' '); } catch (e) {}
          console.log(`[${LOG}] fallback Shopee ${ped.numero}: HTTP ${rSh.status} ${detSh}`);
          _motivoEtq = (rSh.status === 401 || rSh.status === 403) ? 'o Shopee-sync recusou a chave (confira SHOPEE_SYNC_KEY)' : ('a Shopee não entregou a etiqueta (HTTP ' + rSh.status + (detSh ? ' — ' + _semSegredo(detSh).slice(0, 90) : '') + ')');
          try {
            const jSh = JSON.parse(detSh);
            const pPar = (jSh && jSh.passos || []).find(x => x && x.passo === 'parameter');
            if (pPar && Array.isArray(pPar.selecionaveis) && pPar.selecionaveis.length) {
              console.log(`[${LOG}] \ud83d\udd0e Shopee ${ped.numero} (${ped.numeroLoja}): pedimos "${pPar.sugerido}" mas ela S\u00d3 ACEITA [${pPar.selecionaveis.join(', ')}] \u2014 \u00e9 esse o formato que o shopee-nf-sync precisa usar`);
            }
          } catch (e) {}
        }
      } catch (e) { console.log(`[${LOG}] fallback Shopee ${ped.numero}: ${String(e.message || e).slice(0, 160)}`); _motivoEtq = 'Shopee: ' + _semSegredo(e.message || e).slice(0, 100); }
      if (!temEtiqueta) _freioSh.falhou(_shKey, _motivoEtq);
    }
    /* 23/10: a etiqueta do MADEIRA vem da peça única lib/checkout/etiqueta-madeira — ZPL público primeiro (o mesmo que a
       impressão usa; o PDF com token dava timeout), NF também sem o zero da frente, e o MOTIVO vai pro card */
    let etiquetaMM = false, volumesMM = 1;
    if (!temEtiqueta && mkt === 'madeira') {
      let mmEtq = null;
      try { mmEtq = (o.mmEtiquetas ? o.mmEtiquetas() : null); } catch (e) { mmEtq = null; }   /* sem módulo do Madeira nesta empresa = não vende lá */
      try {
        const _mm = await require('./etiqueta-madeira').etiquetaMadeiraNoCiclo({ dir, ped, nf, mmEtq });
        etiquetaMM = !!_mm.ok; volumesMM = _mm.volumes || 1;
        if (!_mm.ok && _mm.motivo) _motivoEtq = _mm.motivo;
      } catch (e) { _motivoEtq = 'Madeira: ' + String((e && e.message) || e).slice(0, 100); }
    }

    const _servico = servicoDoPedido(ped);
    const snapshot = {
      bling_id: id,
      numero: ped.numero || null,
      numero_loja: ped.numeroLoja || null,
      loja_id: lojaId || null,
      // 24/08: SÓ a unidade da LOJA (mesma regra do unDaLista). Gravar o topo do pedido aqui
      // fazia a reconciliação (que lê este snapshot) reclassificar pedido interno como Full.
      un_id: String((ped.loja && ped.loja.unidadeNegocio && ped.loja.unidadeNegocio.id) || ''),
      marketplace: mkt,
      servico: _servico,
      flex: ehFlex(_servico),
      situacao_id: (ped.situacao && ped.situacao.id) || SIT_ATENDIDO,
      cliente: (ped.contato && ped.contato.nome) || '',
      total: (ped.total != null ? Number(ped.total) : null),   // valor total do pedido (p/ faturamento no relatório)
      uf: (ped.transporte && ped.transporte.etiqueta && ped.transporte.etiqueta.uf) || null,           // estado do destinatário (dashboard: vendas por UF)
      venda_dia: (ped.data ? String(ped.data).slice(0, 10) : null),   // DATA DA VENDA (Bling, todos os canais) — atribui fim de semana ao dia certo
      taxa_mkt: (ped.taxas && isFinite(Number(ped.taxas.taxaComissao)) && Number(ped.taxas.taxaComissao) > 0) ? Math.round(Number(ped.taxas.taxaComissao) * 100) / 100 : null,   // 💎 comissão que o Bling importa do marketplace (TikTok/Shopee/Magalu…)
      frete_mkt: (ped.taxas && isFinite(Number(ped.taxas.custoFrete)) && Number(ped.taxas.custoFrete) > 0) ? Math.round(Number(ped.taxas.custoFrete) * 100) / 100 : null,        // frete informado pelo canal via Bling
      municipio: (ped.transporte && ped.transporte.etiqueta && ped.transporte.etiqueta.municipio) || null,
      nf,
      itens,
      tem_nf: !!nf,
      tem_danfe: fs.existsSync(path.join(dir, 'danfe.pdf')),   // por existência do arquivo → sobrevive a re-cache
      tem_kit: temKit,
      tem_etiqueta: temEtiqueta || etiquetaMM,
      etq_motivo: (temEtiqueta || etiquetaMM) ? null : (_motivoEtq || null),   /* 15/10: por que está sem etiqueta (vai pro card) */
      full_ml: !!_fullML,   /* 15/10: o ML diz que é FULL — fora da fila do galpão */
      aguardando_disp: !!_aguardaDispML && !(temEtiqueta || etiquetaMM),   /* 17/10: prazo de disponibilidade no ML — fora da fila */
      etiqueta_formato: (etiquetaMM || etqEhPdf) ? 'PDF' : (temEtiqueta ? ETIQ_FORMATO : null),
      etiqueta_mm: etiquetaMM,
      etiqueta_pdf: !!(etiquetaMM || etqEhPdf),   // etiqueta é PDF (Madeira, Amazon...) → impressão/email usam o caminho PDF
      volumes: etiquetaMM ? volumesMM : 1,
      schema: SCHEMA,
      visto_em: (function () { try { const a = JSON.parse(fs.readFileSync(path.join(dir, 'pedido.json'), 'utf8')); return (a && (a.visto_em || a.cacheado_em)) || new Date().toISOString(); } catch (e) { return new Date().toISOString(); } })(),   // 1ª vez que ESTE pedido apareceu pro sistema — sobrevive a re-caches
      cacheado_em: new Date().toISOString()
    };
    // porte (Codex P1a): o snapshot novo NÃO carregava os carimbos de anexo — no ciclo
    // seguinte a guarda não via mais `nf_anexada` e a auto-cura apagava a NF que o admin
    // subiu; num anexo só de XML, o passo da DANFE baixava a nota CANCELADA de volta.
    // Os carimbos são do ADMIN, não do Bling — sobrevivem a qualquer re-cache.
    try {
      const _ant = readJson(path.join(dir, 'pedido.json'), null);
      if (_ant) {
        if (_ant.nf_anexada) {
          snapshot.nf_anexada = true;
          if (_ant.nf_numero && !snapshot.nf_numero) snapshot.nf_numero = _ant.nf_numero;
          if (_ant.nf_emissao && !snapshot.nf_emissao) snapshot.nf_emissao = _ant.nf_emissao;
          // 10/08 (Codex, PR#5): preservar TAMBÉM no objeto CANÔNICO. Lista, detalhe e
          // busca leem snapshot.nf.numero/dataEmissao e tem_nf — restaurar só o top-level
          // fazia esses fluxos voltarem pra nota velha do Bling (ou pra "sem nota").
          snapshot.nf = Object.assign({}, snapshot.nf || {},
            (_ant.nf && _ant.nf.chave) ? { chave: _ant.nf.chave } : {},
            _ant.nf_numero ? { numero: _ant.nf_numero } : {},
            _ant.nf_emissao ? { dataEmissao: _ant.nf_emissao } : {});
          if (_ant.nf_numero || (snapshot.nf && snapshot.nf.numero)) snapshot.tem_nf = true;
          if (fs.existsSync(path.join(dir, 'danfe.pdf'))) snapshot.tem_danfe = true;
        }
        if (_ant.etiqueta_anexada) {
          snapshot.etiqueta_anexada = true;
          snapshot.tem_etiqueta = true;
          if (_ant.etiqueta_pdf != null) snapshot.etiqueta_pdf = _ant.etiqueta_pdf;
          if (_ant.etiqueta_formato) snapshot.etiqueta_formato = _ant.etiqueta_formato;
        }
      }
    } catch (e) {}
    writeJson(path.join(dir, 'pedido.json'), snapshot);
    return snapshot;
  }

  // 30/07: quantas vezes seguidas a etiqueta da Shopee falhou em cada pedido (freio anti-martelo)
  const _freioSh = require('./freio-etiqueta-shopee').criarFreio();   /* 19/10: freio da etiqueta Shopee (era 1 h fixa; ver a lib) */

  async function rodarCiclo(motivo = 'cron', forcar = false) {
    if (rodando && rodandoDesde && (Date.now() - rodandoDesde) > 15 * 60 * 1000) {
      console.log('[CICLO] WATCHDOG: ciclo anterior pendurado h\u00e1 ' + Math.round((Date.now() - rodandoDesde) / 60000) + ' min \u2014 destravando e seguindo');
      rodando = false;
    }
    if (rodando) {
      console.log('[' + LOG + '] ciclo já em andamento — pulei');
      /* ⚠️ 06/10 — marca que PULOU. Quem chama (o resgate do pedido em limbo) precisa saber: o
         ciclo em andamento tirou a foto do ATENDIDO antes do resgate, então o pedido resgatado não
         entra NESTE ciclo. Sem o aviso, quem chama não tem como reagendar — e devolver o resumo
         anterior parecia sucesso. */
      return Object.assign({}, ultimoResumo || {}, { pulado: true });
    }
    rodando = true;
    rodandoDesde = Date.now();
    limparProdCache();                       // zera cache de produto por ciclo
    const _kc = readJson(KIT_CACHE_FILE, {});
    const kitCache = (_kc && _kc._schema === SCHEMA && _kc.kits) ? _kc.kits : {}; // invalida se schema mudou
    const t0 = Date.now();
    let novos = 0, erros = 0;
    try {
      ensureDir(CACHE_DIR);
      console.log(`[${LOG}] ▶ ciclo (${motivo})${forcar ? ' [FORCE]' : ''}`);
      const man      = manifest();
      const cacheEan = skuEanCache();
      const locC     = locCache();
      const { ok: listaOk, completa: listaCompleta, pedidos: atendidos, idsFullVistos, idsSemSerie, paginas_refeitas: pagRef, falhou_na_pagina: pagFalha } = await listarAtendidos();
      /* 17/09 — PORTE do diagnóstico da reconciliação (a Girassol tinha, estas não). É o
         único lugar que diz POR QUE a limpeza do cache foi pulada: sem ele o painel mostra
         o sintoma (pedido despachado preso como "sem etiqueta") e ninguém liga à causa.
         ⚠️ os ramos NÃO são copiados da Girassol: aqui a reconciliação roda também com fila
         VAZIA desde que haja cache a conferir (conserto dos fantasmas, 25/08). Copiar o
         'pulada_lista_vazia' dela marcaria como pulado um ciclo que RODOU. */
      let reconciliacao = 'ok';
      console.log(`[${LOG}] ${atendidos.length} pedido(s) ATENDIDO(${SIT_ATENDIDO}) na janela de ${JANELA_DIAS}d (bling ok=${listaOk})`);

      // EXPURGO FULL: pedidos que a lista do Bling trouxe como Full mas que já
      // estavam no cache (cacheados ANTES do filtro existir) — remove do cache
      // uma vez, pra sumirem da fila do estoquista. Diferente da reconciliação,
      // aqui a remoção é SEGURA e desejada: sabemos que são Full (não é "lista
      // ruim do Bling"). Full não tem etiqueta de vendedor, então nada de valor
      // é perdido.
      if (Array.isArray(idsFullVistos) && idsFullVistos.length) {
        let expurgados = 0;
        for (const id of idsFullVistos) {
          if (man[id]) {
            try { fs.rmSync(path.join(CACHE_DIR, String(id)), { recursive: true, force: true }); } catch (e) {}
            delete man[id];
            expurgados++;
          }
        }
        if (expurgados) { salvarManifest(man); console.log(`[${LOG}] expurgo Full: ${expurgados} pedido(s) Full removido(s) do cache (saíram da fila)`); }

        // MOVE FULL → DESPACHADOS: o Full já foi despachado pela Shopee (a
        // mercadoria saiu do CD dela), então o lugar dele no Bling é DESPACHADOS,
        // não ATENDIDO. Movemos por API, igual o F1 faz com o ML. Isso é
        // COMPLEMENTAR ao filtro: o filtro já tirou da fila do estoquista (o que
        // importa); o move só arruma a situação no Bling, de tempos em tempos.
        // Se o move falhar (429, rede), tudo bem — o filtro continua escondendo
        // e o move é tentado no próximo ciclo. <PREFIXO>_SIT_DESPACHADOS controla o
        // destino; se ficar 0/vazio, o move é DESLIGADO (só o filtro age).
        if (SIT_DESPACHADOS && Array.isArray(idsFullVistos) && idsFullVistos.length) {
          let movidos = 0, falhas = 0;
          for (const id of idsFullVistos) {
            try {
              const r = await moverSituacao(id, SIT_DESPACHADOS);
              if (r && r.ok !== false) movidos++; else falhas++;
            } catch (e) { falhas++; }
            await sleep(PAUSA_MS);
          }
          /* 24/08: o log dizia só "N movido(s)", sem dizer QUAIS — e foi por isso que levou horas
             pra descobrir se os movidos eram Full de verdade ou pedido interno. Agora lista os ids. */
          console.log(`[${LOG}] move Full → DESPACHADOS(${SIT_DESPACHADOS}): ${movidos} movido(s)${falhas ? `, ${falhas} falha(s) (retenta no próximo ciclo)` : ''}` +
            (idsFullVistos.length ? ` — pedidos: ${idsFullVistos.join(', ')}` : ''));
        }
      }

      // RECONCILIAÇÃO: remove do cache quem NÃO está mais em ATENDIDO (enviado/processado).
      // Só roda se o Bling respondeu E veio algo — assim, se o Bling cair, o cache offline é preservado.
      if (listaOk && !listaCompleta) {
        reconciliacao = 'pulada_lista_incompleta';
        console.log('[' + LOG + '] ⚠️ lista do Bling veio INCOMPLETA (falhou no meio da paginação) — reconciliação PULADA, cache preservado');
      }
      /* 25/08 (fantasmas imortais): a guarda `atendidos.length > 0` protegia o cache de uma
         lista vazia suspeita — mas na AMB a fila fica LEGITIMAMENTE vazia (todos os pedidos de
         ATENDIDO são Full e somem no filtro), então a reconciliação era PULADA em silêncio em
         TODO ciclo e pasta órfã nunca saía (5 fantasmas com dias de idade, um deles o card
         "sem etiqueta" da Denise). Agora ela roda também com fila vazia DESDE QUE haja cache a
         conferir — e, nesse caso, SÓ pelo caminho da confirmação individual lá embaixo: pedido
         a pedido no Bling, nunca remoção em massa apoiada numa lista vazia. O espírito da
         guarda fica: lista vazia continua não podendo apagar nada sozinha. */
      if (!listaOk) reconciliacao = 'sem_lista';
      if (listaOk && listaCompleta && (atendidos.length > 0 || Object.keys(man).length > 0)) {
        const idsAtuais = new Set(atendidos.map(p => String(p.id)));
        // Pedidos que estão em ATENDIDO mas foram OCULTADOS pelo filtro Full
        // (unidade de negócio de fulfillment) não podem contar como "sumiram":
        // eles continuam no Bling, só não aparecem na fila. Se já entraram no
        // cache numa versão anterior, mantemos — nunca removê-los aqui.
        const UN_FULL_REC = FULL_ATIVO ? unsFullEfetivas() : [];   // mesma união casa+env do filtro
        let idsFull = new Set();
        if (UN_FULL_REC.length) {
          try {
            const setF = new Set(UN_FULL_REC);
            for (const id of Object.keys(man)) {
              const snap = readJson(path.join(CACHE_DIR, String(id), 'pedido.json'), null);
              /* 24/08: só confia no un_id de snapshot do SCHEMA atual. Os gravados antes traziam
                 o fallback do topo do pedido, então um pedido interno apareceria aqui como Full e
                 ficaria preso na fila offline até a retenção limpar. Snapshot velho é tratado como
                 NÃO-Full, que é o comportamento seguro: ele volta a ser removido normalmente ao
                 sair de ATENDIDO. O bump do SCHEMA reescreve esses snapshots sozinho. */
              const un = (snap && snap.schema === SCHEMA && snap.un_id) ? String(snap.un_id) : '';
              if (un && setF.has(un)) idsFull.add(String(id));
            }
          } catch (e) {}
        }
        /* ⚠️ PRESERVAR os de série desconhecida. Eles ficam escondidos da fila (não entram em
           `atendidos`) e foram tirados do idsFullVistos pra NÃO serem movidos — então cairiam
           nas duas peneiras e a reconciliação apagaria o cache deles como se tivessem saído de
           ATENDIDO, levando junto a ETIQUETA ANEXADA. O próprio arquivo avisa em outro ponto
           que é melhor não remover do que apagar etiqueta. */
        const preservar = new Set((idsSemSerie || []).map(String));
        /* 26/08 de manhã (a Denise sobreviveu à noite): a regra anterior — Full-marcado só
           entra na limpeza com FILA VAZIA — tinha um furo de horário comercial: a fila nunca
           zera durante o dia, então fantasma marcado Full era imortal na prática (o pedido
           dela estava CANCELADO no Bling e o card seguia no painel, madrugada adentro).
           Regra nova: Full-marcado ausente da lista SEMPRE entra como candidato, e a presença
           de QUALQUER um deles força o modo de confirmação individual logo abaixo — que é
           seguro por definição: um Full de verdade ainda em ATENDIDO responde 9 e é mantido;
           só sai quem o Bling confirmar que saiu. A remoção EM MASSA continua nunca tocando
           em Full-marcado (o modo forçado garante isso por construção). */
        const aRemover = Object.keys(man).filter(id => !idsAtuais.has(String(id)) && !preservar.has(String(id)));
        const fullNoLote = aRemover.filter(id => idsFull.has(String(id))).length;
        // TRAVA DE SEGURANÇA: sumir com muita coisa de uma vez quase sempre é lista ruim do Bling,
        // não 40% dos pedidos despachados no mesmo minuto. Melhor não remover do que apagar etiqueta anexada.
        const limiteSeguro = Math.max(5, Math.ceil(Object.keys(man).length * 0.4));
        /* fila vazia OU qualquer Full-marcado no lote => confirmação individual OBRIGATÓRIA */
        if (aRemover.length > limiteSeguro || atendidos.length === 0 || fullNoLote > 0) {
          // 02/08 — ANTES: abortava TUDO e o cache nunca encolhia. Numa empresa de volume menor a
          // remoção normal passa dos 40% com facilidade (AMB: 49 de 71 = 69%), então a trava disparava
          // em TODO ciclo. Pior: pedido preso no cache também nunca mais era reprocessado, porque a
          // fila parte da lista do Bling — por isso os "sem etiqueta" fantasmas nunca resolviam.
          // AGORA: em vez de confiar na proporção, PERGUNTAMOS ao Bling um por um. Só sai do cache
          // quem o Bling confirmar que existe e NÃO está mais em ATENDIDO. Lista ruim do Bling continua
          // sem apagar nada (a consulta individual falha ou devolve ATENDIDO), e limpeza legítima passa.
          console.log(`[${LOG}] reconciliação: ${aRemover.length} de ${Object.keys(man).length} candidatos a sair — acima do limite (${limiteSeguro}), conferindo um a um no Bling…${fullNoLote ? ` — ${fullNoLote} marcado(s) Full no lote: modo individual forçado` : ''}`);
          /* Codex #205 (P1×2): (a) o detalhePedido daqui não tinha prazo — Bling que aceita a
             conexão e emudece penduraria o ciclo inteiro, e o watchdog de 15 min empilharia
             ciclos por cima; o prazo vence POR FORA, numa corrida, porque o blingGet espera o
             token ANTES de olhar o sinal. (b) resposta com `situacao` OMITIDA caía no rmSync —
             deletar sem confirmação é exatamente o que este ramo não pode fazer, e o repo já
             documenta que o Bling omite situacao de vez em quando. Agora: só deleta com status
             NUMÉRICO e explicitamente ≠ ATENDIDO; omitido/ilegível conta como sem resposta. */
          /* r7: o prazo vence por fora, mas a chamada de baixo (token sem sinal) segue viva —
             a promessa EM VOO fica exposta: quem estourar o prazo pendura ela em
             _sondaPendente e os ciclos seguintes PULAM a conferência até ela assentar.
             1 soquete no máximo por processo, nunca um por ciclo. */
          const prazoDet = (fn, ms) => {
            const ac = new AbortController();
            let emVoo = null;
            const pr = new Promise((resolva, rejeite) => {
              const tt = setTimeout(() => { ac.abort(); rejeite(new Error('prazo estourado')); }, ms || 20000);
              emVoo = Promise.resolve().then(() => fn(ac.signal));
              emVoo.then(
                (vv) => { clearTimeout(tt); resolva(vv); },
                (ee) => { clearTimeout(tt); rejeite(ee); }
              );
            });
            pr.emVoo = () => emVoo;
            return pr;
          };
          /* Codex #205 r4 (P1×2 + P2): (a) TETO de 15 conferências por ciclo — 46 candidatos
             mudos × 20s dariam 15+ min e o watchdog empilharia um 2º ciclo mexendo no MESMO
             cache; o resto fica adiado e morre nos ciclos seguintes. (b) prazo estourado =
             OAuth/Bling MUDO: os próximos travariam igual, então a conferência do ciclo
             ABORTA na hora — no máximo 1 socket pendurado, não um por candidato (o fetch do
             token não aceita sinal; ver tokenManager). (c) a PAUSA vale pra TODO candidato,
             inclusive os preservados — antes só o removido pausava e os "ainda ATENDIDO"
             saíam em rajada, furando o ritmo e convidando 429. */
          let confirmados = 0, mantidos = 0, semResposta = 0, adiados = 0, mudo = false, tentados = 0;
          if (_sondaPendente) {
            /* Codex #491: aqui a conferência inteira é pulada — todo `aRemover` fica pendurado
               sem resposta, mas antes ficava mudo em 'ok'. A tela dizia "reconciliação em dia"
               bem no ciclo em que ela nem rodou, escondendo do painel o motivo do "sem etiqueta". */
            reconciliacao = 'adiada_bling_mudo';
            console.log(`[${LOG}] reconciliação: conferência PULADA — chamada do ciclo anterior ainda pendurada no token; ${aRemover.length} candidato(s) adiado(s)`);
          } else {
          /* Codex #205 r5: fatia FIXA daria fome — os mesmos 15 primeiros seriam tentados em
             todo ciclo (a ordem do manifest é estável) e, se preservados, o 16º em diante
             nunca seria conferido apesar de "adiado". A janela agora GIRA com o relógio:
             cada ciclo começa de um ponto diferente da lista, e em poucos ciclos todo
             candidato passa pela conferência. */
          /* Codex r6: offset derivado do RELÓGIO entra em ressonância com o cron — com 60
             candidatos e cron de 30 em 30 min, os inícios alternam entre 2 pontos e faixas
             inteiras nunca são conferidas. O cursor agora PERSISTE em memória e avança pelo
             tamanho REAL do lote: cobertura completa por construção, qualquer que seja o
             cron. Restart zera o cursor — só recomeça a volta, nada se perde. */
          /* Codex #211: os Full-marcados — justamente quem FORÇOU o modo individual — podiam
             ficar ciclos fora do lote de 15 esperando o cursor sortear a faixa deles. Agora
             eles entram PRIMEIRO (são poucos por natureza), e o cursor gira só sobre os
             comuns, preenchendo o resto do lote — a garantia de cobertura dos comuns fica
             intacta, e o fantasma que abriu o modo é conferido já no primeiro ciclo. */
          /* Codex #212: com ≥16 Full preservados (ainda ATENDIDO), a fatia fixa repetia os
             mesmos 15 e nunca alcançava o 16º — nem sobrava vaga pra comum nenhum. Agora os
             Full têm cursor rotativo PRÓPRIO e teto de 10: todos passam pela conferência ao
             longo dos ciclos, e sempre sobram ≥5 vagas pros comuns. */
          const fullTodos = aRemover.filter(id => idsFull.has(String(id)));
          const gF = fullTodos.length ? (_cursorFull % fullTodos.length) : 0;
          const fullGirado = fullTodos.slice(gF).concat(fullTodos.slice(0, gF));
          const loteFull = fullGirado.slice(0, 10);
          const comunsC = aRemover.filter(id => !idsFull.has(String(id)));
          const vagas = Math.max(0, 15 - loteFull.length);
          const giroC = comunsC.length ? (_cursorConfirmacao % comunsC.length) : 0;
          const girado = comunsC.slice(giroC).concat(comunsC.slice(0, giroC));
          /* Codex #212 r2+r3: qualquer id fixo na frente vira gargalo se for cronicamente
             mudo (um Full doente matava os comuns; um comum doente único viraria canário
             eterno e mataria os Full). REGRA UNIFORME, sem caso especial: o 1º estouro —
             seja de quem for — pula o pedido e testa o PRÓXIMO; DOIS ids diferentes mudos
             no mesmo ciclo = mudez do token, aborta. Teto de 2 soquetes vivos por ciclo,
             e nenhum pedido doente consegue parar a limpeza sozinho. Um comum abre o lote
             só pela ordem (barato responde primeiro); não decide mais nada. */
          const loteConf = girado.slice(0, 1).concat(loteFull, girado.slice(1, vagas));
          adiados = aRemover.length - loteConf.length;
          let tentadosComuns = 0, tentadosFull = 0, estouros = 0;
          for (let iC = 0; iC < loteConf.length; iC++) {
            const id = loteConf[iC];
            tentados++;
            if (idsFull.has(String(id))) tentadosFull++; else tentadosComuns++;
            let det = null, estourou = false;
            const pd = prazoDet(sig => detalheParaReconciliacao(id, sig));
            try { det = await pd; }
            catch (e) { det = null; estourou = /prazo/.test(String((e && e.message) || '')); }
            await new Promise(r => setTimeout(r, PAUSA_MS || 220));                 // pausa SEMPRE, preservado incluso
            if (estourou) {
              estouros++;
              if (estouros < 2) {                         // 1º estouro: pode ser só ESTE pedido doente — pula e testa o próximo
                adiados++;
                continue;
              }
              mudo = true; adiados += (loteConf.length - iC);   // 2º: dois ids diferentes mudos = token; aborta
              reconciliacao = 'adiada_bling_mudo';              // Codex #491: sobra candidato sem confirmar — não é 'ok'
              /* r7fix: a pendurada é registrada ANTES do break — depois dele é código morto
                 (foi exatamente o que o Codex pegou na primeira versão disto). */
              _sondaPendente = pd.emVoo().catch(() => {}).then(() => { _sondaPendente = null; });
              break;
            }
            if (!det) { semResposta++; continue; }                                  // Bling não respondeu → preserva
            if (!det.naoExiste) {                                                   // 404 = apagado no Bling: pula direto pra remoção
            const sitRaw = det.situacao != null ? (det.situacao.id != null ? det.situacao.id : det.situacao) : null;
            /* Codex #205 r2: Number(null), Number('') e Number('   ') são TODOS 0 — finito e
               ≠ ATENDIDO — então qualquer forma vazia de situacao cairia na remoção como se
               fosse um status real. Confirmação exige DÍGITOS de verdade: só texto não-vazio
               composto de números vira status; o resto é "não confirmado" e preserva. */
            const sitTxt = String(sitRaw == null ? '' : sitRaw).trim();
            if (!/^\d+$/.test(sitTxt)) { semResposta++; continue; }                 // omitida/vazia/ilegível → NÃO confirmado → preserva
            const sit = Number(sitTxt);
            /* Codex #205 r3: situacao 0 / {id:0} / "0" passa na régua dos dígitos, e 0 ≠
               ATENDIDO cairia na remoção — mas 0 NÃO é id de situação válido no Bling, é a
               forma numérica do "ausente". Status confirmado tem que ser POSITIVO. */
            if (sit <= 0) { semResposta++; continue; }
            if (sit === Number(SIT_ATENDIDO)) { mantidos++; continue; }             // ainda ATENDIDO → preserva
            }                                                                       // fim do !naoExiste
            try { fs.rmSync(path.join(CACHE_DIR, String(id)), { recursive: true, force: true }); } catch (e) {}
            delete man[id]; confirmados++;
          }
          /* Codex r7: o cursor avança pelo que foi DE FATO tentado — adiantá-lo pelo lote
             inteiro fazia o aborto por mudez pular 14 candidatos nunca olhados (com o veneno
             no índice 0, as voltas começariam em 0/15/30/45 e faixas inteiras escapariam).
             Mínimo 1 pra não emperrar eternamente em cima de um candidato que sempre estoura. */
          _cursorConfirmacao = comunsC.length ? (giroC + Math.max(1, tentadosComuns)) % comunsC.length : 0;
          _cursorFull = fullTodos.length ? (gF + Math.max(1, tentadosFull)) % fullTodos.length : 0;
          if (confirmados) salvarManifest(man);
          /* Codex #491 r2: o abort por mudez já vira 'adiada_bling_mudo' lá em cima, mas sobram
             DOIS caminhos que também deixam candidato sem confirmar e não tocavam em `reconciliacao`:
             o excesso além da fatia de 15 (`adiados = aRemover.length - loteConf.length`) e o 1º
             estouro isolado (pula o pedido, `adiados++`, continua sem abortar). Nos dois, 'ok' era
             mentira — havia "sem etiqueta" pendurado que o próximo ciclo ainda precisa conferir. */
          if (adiados > 0 && reconciliacao === 'ok') reconciliacao = 'adiada_parcial';
          console.log(`[${LOG}] reconciliação conferida: ${confirmados} removido(s) · ${mantidos} seguem em ATENDIDO · ${semResposta} sem resposta do Bling (preservados) — ${adiados} adiado(s) p/ o próximo ciclo${mudo ? ' — BLING MUDO: conferência ABORTADA neste ciclo, tenta no próximo' : ''}`);
          }
        } else if (aRemover.length) {
          for (const id of aRemover) {
            try { fs.rmSync(path.join(CACHE_DIR, String(id)), { recursive: true, force: true }); } catch (e) {}
            delete man[id];
          }
          salvarManifest(man);
          console.log(`[${LOG}] reconciliação: ${aRemover.length} pedido(s) saíram do ATENDIDO e foram removidos do cache`);
        }
      }

      // ESPELHO DO BLING: pedido que estava finalizado+sincronizado aqui mas VOLTOU pra ATENDIDO no Bling
      // (alguém reverteu lá) → desfinaliza aqui pra ele reaparecer na lista. Espelha a virada do Bling.
      if (listaOk && atendidos.length > 0) {
        const idsAtend = new Set(atendidos.map(p => String(p.id)));
        const conf = readJson(CONFERIDOS_FILE, {});
        let reabertos = 0;
        for (const id of Object.keys(conf)) {
          /* Codex #702: a lista é do COMEÇO do ciclo — conferido sincronizado DEPOIS dele (o operador finalizou no meio) não é
             prova de reversão no Bling, e apagá-lo tiraria o VERIFICADO como origem válida do move do Full logo abaixo */
          if (conf[id] && conf[id].sincronizado && idsAtend.has(String(id)) && !(conf[id].sincronizado_em && Date.parse(conf[id].sincronizado_em) >= t0)) { delete conf[id]; reabertos++; }
        }
        if (reabertos) { writeJson(CONFERIDOS_FILE, conf); console.log(`[${LOG}] espelho Bling: ${reabertos} pedido(s) voltaram pra ATENDIDO → desfinalizados (reaparecem na lista)`); }
      }

      // (re)processa quem não tem etiqueta OU está num schema antigo (ganha EAN+kit) OU tem kit incompleto no cache
      const aProcessar = atendidos.filter(ped => {
        if (forcar) return true;
        const ja = man[ped.id];
        if (ja && ja.tem_kit && kitIncompletoNoCache(ped.id)) return true;   // kit com componente vazio → re-resolve sozinho
        return !(ja && ja.tem_etiqueta && ja.schema === SCHEMA);
      });
      console.log(`[${LOG}] ${aProcessar.length} a (re)processar`);

      // carrega as NFs recentes UMA vez (cobre o menor id do lote) e casa em memória
      let nfs = [];
      if (aProcessar.length) {
        const idMin = Math.min(...aProcessar.map(p => Number(p.id) || Infinity));
        if (Number.isFinite(idMin)) {
          nfs = await carregarNFs(idMin - 5);
          console.log(`[${LOG}] ${nfs.length} NF(s) recentes carregadas p/ casar`);
        }
      }

      // ordem ASC por id: essencial p/ a exclusividade casar 1º pedido ↔ 1ª NF, 2º ↔ 2ª... (Bling emite em sequência)
      aProcessar.sort((a, b) => Number(a.id) - Number(b.id));
      // contexto anti-duplicidade do casamento NF×pedido (uma NF nunca em dois pedidos)
      const nfCtx = { usadasIds: new Set(), donoPorNumero: {} };
      for (const [mid, mm] of Object.entries(man)) { if (mm && mm.nf_numero != null) nfCtx.donoPorNumero[String(mm.nf_numero)] = String(mid); }

      for (const ped of aProcessar) {
        const id = ped.id;
        const ja = man[id];
        try {
          const det = await detalhePedido(id); await sleep(PAUSA_MS);
          if (!det) { erros++; continue; }
          const snap = await cachearPedido(det, cacheEan, nfs, kitCache, locC, nfCtx);
          man[id] = {
            numero: snap.numero, marketplace: snap.marketplace,
            servico: snap.servico || '', flex: !!snap.flex,
            // 10/08 (Codex, PR#6): com NF ANEXADA o campo do ADMIN ganha do que o Bling
            // ainda mostra — senão cada re-cache republicava o número da nota CANCELADA.
            cliente: snap.cliente || '', nf_numero: (snap.nf_anexada && snap.nf_numero) || (snap.nf && snap.nf.numero) || snap.nf_numero || null,
            tem_nf: snap.tem_nf, tem_kit: snap.tem_kit, tem_etiqueta: snap.tem_etiqueta, etq_motivo: snap.etq_motivo || null, full_ml: !!snap.full_ml, aguardando_disp: !!snap.aguardando_disp,
            tem_danfe: !!((ja && ja.tem_danfe) || snap.tem_danfe),
            // 10/08: os CARIMBOS DE ANEXO no manifesto — o 5º ponto de leitura. O snapshot
            // preserva (b136), mas o manifesto era reconstruído com lista fixa de campos e
            // os perdia no re-cache (kit re-resolve toda rodada!) → o painel, que lê DAQUI,
            // deixava de mostrar os selos e voltava a tratar o pedido como não-anexado.
            nf_anexada: !!(snap.nf_anexada || (ja && ja.nf_anexada)),
            etiqueta_anexada: !!(snap.etiqueta_anexada || (ja && ja.etiqueta_anexada)),
            numero_loja: snap.numero_loja || null,
            nf_emissao: (snap.nf_anexada && snap.nf_emissao) || (snap.nf && snap.nf.dataEmissao) || snap.nf_emissao || null,   // data+hora OFICIAL da NF no Bling
            visto_em: snap.visto_em || null,
            itens: snap.itens.length, skus: (snap.itens || []).map(it => it.sku).filter(Boolean),
            // skus_pick = SKUs que o estoquista REALMENTE pega: kit/composição explode nos componentes; item normal usa o próprio SKU
            skus_pick: (snap.itens || []).flatMap(it => (it.tipo === 'kit' && Array.isArray(it.componentes) && it.componentes.length) ? it.componentes.map(c => c.sku) : [it.sku]).filter(Boolean),
            schema: snap.schema, volumes: snap.volumes || 1, cacheado_em: snap.cacheado_em
          };
          if (!ja) novos++;
          salvarManifest(man);
          salvarSkuEan(cacheEan);
          salvarLoc(locC);
          writeJson(KIT_CACHE_FILE, { _schema: SCHEMA, kits: kitCache });
        } catch (e) { erros++; console.error(`[${LOG}] erro pedido ${id}:`, e.message); }
        await sleep(PAUSA_MS);
      }

      // passo: baixa o DANFE que falta (TODOS — fica pronto p/ offline rápido)
      let danfesNovos = 0, danfesFalha = 0, danfesSemId = 0, danfesReparo = 0;
      for (const ped of atendidos) {
        const dir = path.join(CACHE_DIR, String(ped.id));
        if (fs.existsSync(path.join(dir, 'danfe.pdf'))) {
          // já tem o PDF — garante o flag tem_danfe (re-cache pode ter limpado o campo)
          const s = readJson(path.join(dir, 'pedido.json'), null);
          if (s && !s.tem_danfe) { s.tem_danfe = true; writeJson(path.join(dir, 'pedido.json'), s); danfesReparo++; }
          if (man[ped.id] && !man[ped.id].tem_danfe) { man[ped.id].tem_danfe = true; danfesReparo++; }
          continue;
        }
        const snap = readJson(path.join(dir, 'pedido.json'), null);
        if (!snap || !snap.nf || !snap.nf.id) { danfesSemId++; continue; }
        // porte: NF anexada à mão NUNCA é re-baixada do Bling — o snap.nf.id ainda é o da
        // nota VELHA, então este passo restauraria a cancelada se o danfe.pdf sumisse.
        if (snap && snap.nf_anexada) { continue; }
        const pdf = await baixarDanfe(snap.nf.id); await sleep(PAUSA_MS);
        if (pdf) {
          fs.writeFileSync(path.join(dir, 'danfe.pdf'), pdf);
          snap.tem_danfe = true; writeJson(path.join(dir, 'pedido.json'), snap);
          if (man[ped.id]) man[ped.id].tem_danfe = true;
          danfesNovos++;
        } else { danfesFalha++; }
      }
      if (danfesNovos || danfesReparo) salvarManifest(man);
      console.log(`[${LOG}] DANFE: ${danfesNovos} novos, ${danfesReparo} reparados, ${danfesFalha} falha, ${danfesSemId} sem nf.id`);

      // passo: cacheia os DADOS do DANFE SIMPLIFICADO (p/ imprimir 10x15 na Zebra OFFLINE)
      //        guarda o parsed (nf-simp.json) — o PDF é gerado na hora pela rota /danfe-simp
      let simpNovos = 0, simpFalha = 0, simpSemId = 0, simpCurados = 0;
      for (const ped of atendidos) {
        const dir = path.join(CACHE_DIR, String(ped.id));
        if (fs.existsSync(path.join(dir, 'nf-simp.json'))) continue;   // já tem
        const snap = readJson(path.join(dir, 'pedido.json'), null);
        if (!snap) { simpSemId++; continue; }
        // porte (Codex): NF anexada? não regerar o nf-simp daqui — o snap.nf.id ainda é o
        // da nota VELHA e este passo reconstruiria o arquivo com os dados fiscais da
        // CANCELADA. Melhor sem nf-simp (a rota cai no caminho normal) do que com o errado.
        if (snap.nf_anexada) { continue; }
        let nfId = snap.nf && snap.nf.id;
        if (!nfId) {   // re-cache antigo pode ter perdido o nf.id → acha ao vivo e CURA o snapshot
          try {
            const nf = await nfDoPedido(ped.id); await sleep(PAUSA_MS);
            if (nf && nf.id) {
              nfId = nf.id; snap.nf = nf; snap.tem_nf = true;
              writeJson(path.join(dir, 'pedido.json'), snap);
              if (man[ped.id]) { man[ped.id].tem_nf = true; man[ped.id].nf_numero = nf.numero || null; }
              simpCurados++;
            }
          } catch (e) {}
        }
        if (!nfId) { simpSemId++; continue; }
        try {
          const ds = await dadosNFSimp(nfId, snap.numero); await sleep(PAUSA_MS);
          if (ds) { writeJson(path.join(dir, 'nf-simp.json'), ds); simpNovos++; }
          else simpFalha++;
        } catch (e) { simpFalha++; }
      }
      if (simpCurados) salvarManifest(man);
      console.log(`[${LOG}] DANFE-simp: ${simpNovos} novos, ${simpCurados} curados, ${simpFalha} falha, ${simpSemId} sem nf`);

      // passo: baixa a ETIQUETA em PDF (p/ modo A4 / fallback Zebra) — só de quem já tem ZPL
      let etqPdfNovos = 0;
      const extEtq = ETIQ_FORMATO.toLowerCase();
      for (const ped of atendidos) {
        const dir = path.join(CACHE_DIR, String(ped.id));
        if (fs.existsSync(path.join(dir, 'etiqueta.pdf'))) continue;
        if (!fs.existsSync(path.join(dir, `etiqueta.${extEtq}`))) continue;
        // porte (Codex P1c): ZPL veio de ANEXO do admin? NÃO baixar o PDF do Bling — o PDF
        // de lá é da etiqueta VELHA, e é ele que a impressão A4 e a /imprimir usam.
        try { const _s = readJson(path.join(dir, 'pedido.json'), null); if (_s && _s.etiqueta_anexada) continue; } catch (e) {}
        const pdf = await baixarEtiquetaPDF(ped.id); await sleep(PAUSA_MS);
        if (pdf) { fs.writeFileSync(path.join(dir, 'etiqueta.pdf'), pdf); etqPdfNovos++; }
      }
      if (etqPdfNovos) console.log(`[${LOG}] ${etqPdfNovos} etiqueta(s) PDF cacheadas`);

      // passo: garante servico + flex no manifest (p/ filtro marketplace/FLEX) — lê detalhe só de quem falta
      let svcNovos = 0;
      for (const ped of atendidos) {
        const m = man[ped.id];
        if (!m || m.servico !== undefined) continue;
        const det = await detalhePedido(ped.id); await sleep(PAUSA_MS);
        const svc = servicoDoPedido(det);
        m.servico = svc; m.flex = ehFlex(svc);
        // aproveita p/ preencher o snapshot também
        const snapPath = path.join(CACHE_DIR, String(ped.id), 'pedido.json');
        const snap = readJson(snapPath, null);
        if (snap) { snap.servico = svc; snap.flex = ehFlex(svc); writeJson(snapPath, snap); }
        svcNovos++;
      }
      if (svcNovos) { salvarManifest(man); console.log(`[${LOG}] ${svcNovos} servico/flex preenchidos`); }

      // recalcula o flex de quem JÁ tem servico em cache (barato, sem Bling) — pega mudança nas FLEX_KEYWORDS
      let flexFix = 0;
      for (const ped of atendidos) {
        const m = man[ped.id];
        if (!m || m.servico === undefined) continue;
        const nf = ehFlex(m.servico);
        if (m.flex !== nf) {
          m.flex = nf;
          const sp = path.join(CACHE_DIR, String(ped.id), 'pedido.json');
          const sn = readJson(sp, null);
          if (sn) { sn.flex = nf; writeJson(sp, sn); }
          flexFix++;
        }
      }
      if (flexFix) { salvarManifest(man); console.log(`[${LOG}] ${flexFix} flex recalculado`); }

      // passo: aquece as LOCALIZAÇÕES que faltam (SKUs a separar) — teto por ciclo (mais alto no force)
      if (listaOk) {
        const sepSkus = montarSeparacao(null).linhas
          .map(l => l.sku).filter(s => s && s !== '(sem SKU)' && !(s in locC));
        const tetoLoc = forcar ? 80 : 25;
        let locNovas = 0;
        for (const sku of sepSkus) {
          if (locNovas >= tetoLoc) break;
          locC[sku] = await localizacaoPorSku(sku); await sleep(PAUSA_MS);
          locNovas++;
        }
        if (locNovas) { salvarLoc(locC); console.log(`[${LOG}] ${locNovas} localização(ões) aquecidas`); }
      }

      /* 15/10 — ORDEM DO DONO: "pedido Full que cai no ATENDIDO sai de lá na hora e vai pra despachados" (não
         só esconder da fila). A venda Full que o Bling gravou na LOJA COMUM (full_ml: o PRÓPRIO ML confirmou que o
         envio é fulfillment — caso AMB 5689/5690/5691/5692 de 15/10) é movida pra DESPACHADOS — aqui, depois do cache
         dos pedidos novos (pega a Full descoberta neste ciclo) e ANTES do sincronizarConferidos, que poderia levar o
         pedido pra VERIFICADO antes do move (Codex #701). Travas (Codex #701):
           · só move pedido que está AGORA no ATENDIDO, numa lista do Bling que veio inteira — pedido que já saiu
             (cancelado, avançado à mão) não é sobrescrito;
           · o cache e a marca de Full SÓ são apagados depois do move dar certo — falhou, o pedido segue marcado
             (fora da fila) e tenta de novo no próximo ciclo, sem depender do ML responder de novo.
         Com SIT_DESPACHADOS 0/vazio, o move fica desligado (só sai da fila, como no #698). */
      if (SIT_DESPACHADOS && listaOk && listaCompleta) {
        const _noAtendido = new Set((atendidos || []).map(p => String(p && p.id)));
        const _alvosFull = Object.keys(man).filter(i => man[i] && man[i].full_ml && _noAtendido.has(String(i)));
        const _PRAZO_MOVE_FULL_MS = Number(process.env.CHECKOUT_PRAZO_MOVE_FULL_MS || 30000);
        /* Codex #701 r4: prazo do LOTE inteiro (default 5 min, bem abaixo do watchdog de 15) e, se uma chamada estourar
           o prazo (Bling mudo), o lote para — o resto fica marcado e tenta no próximo ciclo */
        const _PRAZO_LOTE_FULL_MS = Number(process.env.CHECKOUT_PRAZO_LOTE_FULL_MS || 300000);
        if (_alvosFull.length) {
          let movF = 0, falhaF = 0, _estourou = false;
          const _iniLoteF = Date.now();
          for (const idF of _alvosFull) {
            if (_estourou || Date.now() - _iniLoteF > _PRAZO_LOTE_FULL_MS) break;
            /* Codex #701 r3: PRAZO nas duas chamadas (o GET da situação e o PATCH) — um Bling que aceita a conexão e
               não responde não pode pendurar o ciclo inteiro; estourou, aborta, conta falha e a marca full_ml fica */
            const _acF = (typeof AbortController === 'function') ? new AbortController() : null;
            const _tmF = setTimeout(() => { try { if (_acF) _acF.abort(); } catch (e) {} }, _PRAZO_MOVE_FULL_MS); if (_tmF && _tmF.unref) _tmF.unref();
            try {
              /* Codex #701 r2: a lista é do COMEÇO do ciclo — confere a situação AGORA, logo antes do PATCH; pedido
                 cancelado/avançado nesse meio-tempo não é sobrescrito. Sem resposta do Bling, não mexe (próximo ciclo). */
              let _detF = null; try { _detF = await detalhePedido(idF, _acF ? _acF.signal : undefined); } catch (e) { _detF = null; }
              const _sitAgora = _detF && _detF.situacao ? Number(_detF.situacao.id) : null;
              /* 16/10 (acerto do #701): o card do Full finalizado no MEIO do ciclo (antes de a classificação chegar ao
                 painel) já foi pra VERIFICADO pelo espelho em tempo real — se há conferido desse pedido, VERIFICADO
                 também é origem válida pro DESPACHADOS (o destino de venda Full). Qualquer outra situação: não mexe. */
              const _cfF = (() => { try { return readJson(CONFERIDOS_FILE, {}) || {}; } catch (e) { return {}; } })();
              const _podeMoverF = _sitAgora === Number(SIT_ATENDIDO) || (_sitAgora === Number(SIT_VERIFICADO) && !!_cfF[idF]);
              if (!_podeMoverF) { falhaF++; continue; }
              /* Codex #701 r4: sem pausa entre a conferência e o PATCH (o throttle vem depois da escrita) */
              /* o mesmo PATCH do moverSituacao, com o prazo; sem repetir em erro de rede (resposta ambígua → o próximo
                 ciclo confere a situação de novo antes de qualquer coisa) */
              const r = await blingWrite('PATCH', `/pedidos/vendas/${idF}/situacoes/${SIT_DESPACHADOS}`, null, { signal: _acF ? _acF.signal : undefined, semRetryDeRede: true });
              if (r && r.ok !== false) {
                movF++; _fullDespachadosNoProcesso.add(String(idF)); _marcarFullDespachado(idF); try { fs.rmSync(path.join(CACHE_DIR, String(idF)), { recursive: true, force: true }); } catch (e) {} delete man[idF];
                /* Codex #701 r4: Full que alguém finalizou no checkout antes da classificação tem um conferido pendente —
                   o sync de conferidos (logo abaixo) faria o PATCH pra VERIFICADO por cima do DESPACHADOS. O move do Full
                   encerra esse conferido como resolvido, e o sync passa reto. */
                try { const _cf = readJson(CONFERIDOS_FILE, {}); if (_cf[idF] && !_cf[idF].sincronizado) { _cf[idF].sincronizado = true; _cf[idF].sincronizado_em = new Date().toISOString(); _cf[idF].sync_resolvido = 'full-ml-despachado'; delete _cf[idF].sync_erro; writeJson(CONFERIDOS_FILE, _cf); } } catch (e) {}
              }
              else falhaF++;
            } catch (e) { falhaF++; }
            finally { clearTimeout(_tmF); if (_acF && _acF.signal.aborted) _estourou = true; }
            await sleep(PAUSA_MS);
          }
          if (movF) salvarManifest(man);
          console.log(`[${LOG}] Full do ML na loja comum → DESPACHADOS(${SIT_DESPACHADOS}): ${movF} movido(s)${falhaF ? ', ' + falhaF + ' falha(s) — seguem marcados e fora da fila, tenta no próximo ciclo' : ''} — pedidos: ${_alvosFull.join(', ')}`);
        }
      }

      // FASE 3: Bling respondeu (listaOk) → drena a fila de conferidos offline p/ VERIFICADO (24)
      // só roda automático se <PREFIXO>_SYNC_ON=1 (trava de segurança até você testar)
      if (listaOk && SYNC_ON) {
        const sync = await sincronizarConferidos(new Set(Object.keys(man).filter(i => man[i] && man[i].full_ml).map(String)));
        if (sync.pendentes) console.log(`[${LOG}] sync conferidos→${SIT_VERIFICADO}: ${sync.ok} ok, ${sync.falhas} falha(s) de ${sync.pendentes}`);
      }

      purgar(man);
      purgarArquivo();
      purgarConferidos();
      salvarManifest(man);
      const ids = Object.keys(man);
      ultimoResumo = {
        rodouEm: new Date().toISOString(),
        duracaoSeg: Math.round((Date.now() - t0) / 1000),
        blingOk: listaOk,                            // o Bling respondeu neste ciclo? (p/ o /saude)
        paginasRefeitas: pagRef || 0,                // 22/08: quantas páginas precisaram de re-tentativa
        reconciliacao,                               // 'ok' | 'pulada_lista_incompleta' | 'sem_lista' | 'adiada_bling_mudo' | 'adiada_parcial'
        falhouNaPagina: pagFalha || null,            // se a lista veio incompleta, em qual página parou
        total: ids.length,
        comEtiqueta: ids.filter(i => man[i].tem_etiqueta).length,
        semEtiqueta: ids.filter(i => !man[i].tem_etiqueta && !man[i].full_ml && !man[i].aguardando_disp).length,   /* 15/10: Full do ML não é problema do galpão */
        novos, erros
      };
      console.log('[' + LOG + '] ✔ ciclo:', JSON.stringify(ultimoResumo));
    } catch (e) {
      console.error('[' + LOG + '] ciclo falhou:', e.message);
    } finally {
      rodando = false;
    }
    return ultimoResumo;
  }

  return { zerarFreioShopee: () => _freioSh.zerar(), indexarCatalogoCompleto, sincronizarConferidos, listarAtendidos, detalhePedido, cachearPedido, rodarCiclo, getUltimoResumo, getUltimoSync, getIdxStatus, fullJaDespachado, unsFullEfetivas, UNS_EMISSAO_PROPRIA_CASA };
}

module.exports = { criarCiclo };
