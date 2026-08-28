// ============================================================
// GOOD Devoluções Bridge - background.js  (v1.4.3)
// ============================================================
// Roda como service worker da extensao.
// Recebe mensagens do content.js (vindas do painel admin).
//
// v1.3.0: executa DENTRO de uma aba real do Bling (chrome.scripting)
//         pra requisicao nascer identica a um clique manual.
// v1.3.1: nunca fica mudo - timeout interno diz em qual etapa travou.
// v1.3.2: acorda a aba do Bling antes (Edge congela abas paradas) e o
//         resultado volta por mensagem, sem depender do canal congelavel.
// v1.3.3: CASCATA DE CABECALHOS no obter-dados:
//         URL identica dava 404 pra gente e 200 pro Bling -> a diferenca
//         so pode ser os cabecalhos. Tenta com X-Requested-With (carimbo
//         que apps PHP exigem pra responder JSON) e, se existir, com o
//         token Bearer guardado na pagina. O modo vencedor e reusado
//         nos POSTs. Se tudo falhar, o erro lista cada tentativa.
// v1.4.0: ESPIAO DE CABECALHOS:
//         As capturas provaram: sem Authorization, e o segredo mora nos
//         cabecalhos que nao dava pra ver. Agora a extensao OBSERVA a
//         chamada obter-dados-devolucao feita pelo PROPRIO Bling (quando
//         Diego clica "Gerar devolucao" manual) via chrome.webRequest,
//         memoriza os cabecalhos exatos e usa OS MESMOS (modo "espelho").
//         Nossas chamadas levam o marcador X-GD-Bridge pra nao se
//         auto-capturar. Cracha fica memorizado na sessao do navegador.
// v1.4.1: CRACHA DESCOBERTO (capturado pelo Diego em 01/07/2026):
//         x-api-revision: 3.1.0
//         O Bling versiona a API interna por esse cabecalho; sem ele a
//         rota "nao existe" (404 RESOURCE_NOT_FOUND). Agora vai FIXO na
//         tentativa "revisao" (primeira da fila). O espiao segue como
//         plano B automatico caso o Bling mude a revisao no futuro.
//         POSTs xajax tambem ganham X-Requested-With (fiel ao jQuery).
//   REQUISITO: uma aba do www.bling.com.br aberta e logada.
//
// Fluxo COMPLETO de devolucao (roda na aba):
//   1. GET  /Api/v3/nfe/{idNF}/obter-dados-devolucao/{idLoja}
//   2. valida devolucaoExistente (anti-duplicata)
//   3. POST salvarNotaDevolucao  (monta XML com os IDs certos)
//   4. POST emitirNotaDevolucaoCertificadoArmazenado  (se emitir=true)
// ============================================================

// Cracha da API interna do Bling (descoberto por captura real).
// Se o Bling mudar a revisao um dia, o modo "espelho" (espiao) cobre
// automaticamente ate a gente atualizar este valor.
const BLING_API_REVISION = '3.1.0';

// v1.4.2: endereco do sistema pra extensao gravar o resultado SOZINHA
// (mesmo que o painel desista de esperar, nada se perde)
const API_SISTEMA = 'https://good-devolucoes-x-marketplaces-x-nfsbling.onrender.com';

// v1.5.0 (b297) - IDS FISCAIS VEM DO SERVIDOR, POR EMPRESA.
//
// Antes eram estes dois numeros cravados, com o aviso "sao especificos da
// GOOD. Girassol/AMB teriam outros" — ou seja, a extensao so servia a GOOD.
// Agora ela PERGUNTA ao sistema quais sao os ids da empresa daquela
// devolucao. Nao adivinhamos empresa por aba aberta nem por chute: quem
// dispara diz qual e, e o servidor responde com os ids DELA.
//
// Cada empresa responde na propria area, porque a sessao de cada uma vive
// num caminho diferente (a da AMB nao chega na raiz).
const ENDERECO_IDS = {
  good: '/api/ids-fiscais?empresa=good',
  ambtotal: '/amb/api/ids-fiscais',
};

// Ultimo recurso SO PRA GOOD: se o servidor nao responder, a GOOD continua
// funcionando como sempre funcionou. Para as demais empresas nao ha padrao —
// emitir com id de outra empresa seria pior do que nao emitir.
const GOOD_PADRAO = {
  idNaturezaOperacao: '5776118802',  // "Devolucao de Mercadoria - Entrada"
  idEmpresaControl: '4956030980',
};

const cacheIds = {};   // empresa -> { quando, fixos }

async function idsFiscaisDaEmpresa(empresa) {
  // b324 - o padrao 'good' na AUSENCIA de empresa foi o que deixou a AMB
  // emitir com os ids da GOOD: uma chamada do painel da AMB veio sem o campo
  // e caiu aqui em silencio. O padrao continua (a GOOD sempre chamou sem
  // empresa e nao vou quebrar isso), mas agora fica REGISTRADO no console —
  // se aparecer "assumindo good por omissao" numa aba da AMB, e este bug.
  if (!empresa) console.warn('[Bridge] chamada SEM empresa — assumindo good por omissao');
  const alvo = String(empresa || 'good').trim().toLowerCase();
  const chave = (alvo === 'amb' || alvo === 'ambtotal') ? 'ambtotal' : alvo;
  const caminho = ENDERECO_IDS[chave];
  if (!caminho) throw new Error('empresa desconhecida na extensao: ' + alvo);

  // cache curto: varias devolucoes seguidas nao repetem a consulta
  const c = cacheIds[chave];
  if (c && (Date.now() - c.quando) < 10 * 60 * 1000) return c.fixos;

  let dados = null;
  try {
    const r = await fetch(API_SISTEMA + caminho, { credentials: 'include' });
    dados = await r.json();
  } catch (e) { dados = null; }

  if (dados && dados.ok && dados.idNaturezaOperacao && dados.idEmpresaControl) {
    const fixos = {
      idNaturezaOperacao: String(dados.idNaturezaOperacao),
      idEmpresaControl: String(dados.idEmpresaControl),
    };
    cacheIds[chave] = { quando: Date.now(), fixos };
    return fixos;
  }

  if (chave === 'good') {
    console.warn('[Bridge] servidor nao devolveu os ids da GOOD; usando o padrao conhecido');
    return GOOD_PADRAO;
  }
  // sem padrao pra outras empresas: recusa em vez de emitir com id errado
  throw new Error(
    'Nao consegui os IDs fiscais da empresa "' + chave + '"'
    + (dados && dados.erro ? (': ' + dados.erro) : '')
    + '. Sem eles a nota sairia na empresa ou natureza erradas — nao emiti nada.'
  );
}

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// ============================================================
// ESPIAO DE CABECALHOS (v1.4.1)
// Observa a chamada obter-dados-devolucao feita pelo PROPRIO Bling
// (clique manual do Diego) e memoriza os cabecalhos exatos.
// Nossas chamadas levam o marcador X-GD-Bridge e sao ignoradas.
// ============================================================
let capturaEspiao = null; // { quando, url, headers: [{name, value}] }

try {
  chrome.webRequest.onSendHeaders.addListener(
    (det) => {
      try {
        if (!det.url || det.url.indexOf('obter-dados-devolucao') === -1) return;
        const hs = det.requestHeaders || [];
        const nossa = hs.some(h => (h.name || '').toLowerCase() === 'x-gd-bridge');
        if (nossa) return; // ignora nossas proprias tentativas
        capturaEspiao = {
          quando: Date.now(),
          url: det.url,
          headers: hs.map(h => ({ name: h.name, value: h.value || '' })),
        };
        try {
          chrome.storage.session.set({ capturaEspiao: capturaEspiao }).then(() => {}, () => {});
        } catch (e) { /* storage indisponivel; fica so em memoria */ }
        console.log('[Bridge/espiao] cracha capturado de', det.url, '->', hs.map(h => h.name).join(', '));
      } catch (e) { /* nunca deixa o espiao quebrar nada */ }
    },
    { urls: ['https://www.bling.com.br/*'] },
    ['requestHeaders', 'extraHeaders']
  );
  console.log('[Bridge/espiao] ligado, aguardando um "Gerar devolucao" manual pra copiar o cracha');
} catch (e) {
  console.log('[Bridge/espiao] webRequest indisponivel:', e.message || e);
}

// Recupera a captura (memoria ou sessao do navegador)
async function obterCapturaEspiao() {
  if (capturaEspiao) return capturaEspiao;
  try {
    const st = await chrome.storage.session.get('capturaEspiao');
    if (st && st.capturaEspiao) capturaEspiao = st.capturaEspiao;
  } catch (e) { /* sem storage; segue */ }
  return capturaEspiao;
}

// Converte a captura em cabecalhos utilizaveis num fetch:
// tira os que o navegador poe sozinho / nao deixa a gente por.
function montarEspelho(cap) {
  if (!cap || !cap.headers || !cap.headers.length) return null;
  const proibidos = ['cookie', 'host', 'connection', 'content-length', 'accept-encoding', 'origin', 'x-gd-bridge'];
  const headers = {};
  let referrer = null;
  for (const h of cap.headers) {
    const n = (h.name || '').toLowerCase();
    if (!n) continue;
    if (n === 'referer') { referrer = h.value || null; continue; }
    if (proibidos.indexOf(n) !== -1) continue;
    if (n.indexOf('sec-') === 0 || n === 'priority') continue;
    headers[h.name] = h.value || '';
  }
  return { headers: headers, referrer: referrer, nomes: cap.headers.map(h => h.name).join(', ') };
}

// Resultados vindos de dentro da pagina do Bling: execId -> resolve
const aguardandoResultado = new Map();

// ============================================================
// Listener principal (2 papeis):
//  a) pedido do painel (via content.js) pra criar devolucao
//  b) resultado vindo de dentro da pagina do Bling
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // b) resultado da pagina do Bling
  if (msg && msg.tipo === 'BLING_DEVOLUCAO_RESULTADO_PAGINA' && msg.execId) {
    const resolve = aguardandoResultado.get(msg.execId);
    if (resolve) {
      aguardandoResultado.delete(msg.execId);
      resolve(msg);
    }
    sendResponse({ recebido: true });
    return false;
  }

  // a) pedido do painel
  if (!msg || msg.tipo !== 'BLING_DEVOLUCAO_CRIAR') {
    return false; // nao e nossa mensagem
  }

  const painelTab = sender && sender.tab ? sender.tab : null;

  gerarDevolucao(msg.payload, painelTab)
    .then(resultado => sendResponse({ ok: true, resultado }))
    .catch(err => sendResponse({ ok: false, erro: err.message || String(err) }));

  return true; // mantem o canal aberto pra resposta async
});

// ============================================================
// Orquestra: acorda uma aba do Bling, injeta o fluxo, espera o
// resultado por mensagem e volta pro painel. Nunca fica mudo.
// payload = { idNFOriginal, idLoja, emitir }
// ============================================================
async function gerarDevolucao(payload, painelTab) {
  const { idNFOriginal, idLoja, emitir, idDeposito } = payload || {};
  // b297 - de qual empresa e esta devolucao? Quem dispara diz; na falta,
  // 'good' (que era o unico comportamento existente ate aqui).
  const empresa = String((payload && payload.empresa) || 'good').trim().toLowerCase();

  if (!idNFOriginal) throw new Error('idNFOriginal obrigatorio');

  let etapa = 'preparando';
  let execId = null;

  const trabalho = (async () => {
    // b297 - PRIMEIRO os ids da empresa: falhando aqui, nada e emitido
    etapa = 'buscando os IDs fiscais da empresa (' + empresa + ')';
    console.log('[Bridge] etapa:', etapa);
    const fixosDaEmpresa = await idsFiscaisDaEmpresa(empresa);

    etapa = 'procurando aba do Bling';
    console.log('[Bridge] etapa:', etapa);
    const tab = await acharAbaBling();

    // ---- ACORDA a aba (Edge congela abas paradas) ----
    etapa = 'acordando a aba do Bling';
    console.log('[Bridge] etapa:', etapa, '->', tab.url || tab.id);
    try {
      await chrome.tabs.update(tab.id, { active: true, autoDiscardable: false });
      if (tab.windowId != null) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch (e) {
      console.log('[Bridge] aviso ao acordar aba:', e.message || e);
    }
    await esperar(600); // da tempo da aba descongelar

    // ---- injeta o fluxo; o resultado volta por MENSAGEM ----
    execId = 'exec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const promResultado = new Promise(resolve => aguardandoResultado.set(execId, resolve));

    // Se o espiao ja copiou o cracha do Bling, manda junto (modo espelho)
    const captura = await obterCapturaEspiao();
    const espelho = montarEspelho(captura);
    if (espelho) {
      console.log('[Bridge] usando cracha do espiao:', espelho.nomes);
    } else {
      console.log('[Bridge] espiao ainda sem cracha (nenhum Gerar devolucao manual visto nesta sessao)');
    }

    etapa = 'injetando na aba do Bling (' + (tab.url || 'tab ' + tab.id) + ')';
    console.log('[Bridge] etapa:', etapa);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: fluxoDevolucaoNaPagina,
        args: [{
          execId: execId,
          idNFOriginal: String(idNFOriginal),
          idLoja: (idLoja !== undefined && idLoja !== null && String(idLoja).trim() !== '')
            ? String(idLoja).trim()
            : '0',
          emitir: !!emitir,
          idDepositoEscolhido: (idDeposito != null && String(idDeposito).trim() !== '') ? String(idDeposito).trim() : null,
          fixos: fixosDaEmpresa,   // b297 - vieram do servidor, da empresa certa
          apiRevision: BLING_API_REVISION,
          espelho: espelho,
        }],
      });
    } catch (e) {
      throw new Error(
        'Nao consegui executar na aba do Bling: ' + (e.message || String(e)) +
        '. Recarregue a aba do Bling (F5) e tente de novo.'
      );
    }

    etapa = 'aguardando a pagina do Bling terminar o trabalho';
    console.log('[Bridge] etapa:', etapa);
    const resposta = await promResultado;

    if (!resposta.ok) {
      throw new Error(resposta.erro || 'Erro desconhecido dentro da aba do Bling');
    }

    // v1.4.2: GRAVA o resultado direto no sistema (nao depende do painel
    // estar esperando - se o painel der timeout, nada se perde).
    if (payload.devolucaoId && resposta.resultado && resposta.resultado.idNotaDevolucao) {
      try {
        const rReg = await fetch(API_SISTEMA + '/api/admin/registrar-devolucao-gerada/' + encodeURIComponent(payload.devolucaoId), {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nf_devolucao_id_bling: String(resposta.resultado.idNotaDevolucao),
            nf_devolucao_numero: String(resposta.resultado.numero || ''),
          }),
        });
        console.log('[Bridge] auto-registro no sistema:', rReg.status);
      } catch (e) {
        console.log('[Bridge] auto-registro falhou (painel deve registrar):', e.message || e);
      }
    }

    return resposta.resultado;
  })();

  // Trava de seguranca: nunca deixa o painel esperando mais de 90s (SEFAZ tem dias lentos)
  const limite = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error('A extensao travou na etapa "' + etapa + '" (90s). A NF PODE ter sido criada mesmo assim - clique em Gerar de novo que o sistema confere e vincula. Se persistir, recarregue a aba do Bling (F5) e a pagina do painel (Ctrl+Shift+R) e tente de novo.'));
    }, 90000);
  });

  try {
    return await Promise.race([trabalho, limite]);
  } finally {
    // limpeza + volta pro painel (mesmo em erro/timeout)
    if (execId) aguardandoResultado.delete(execId);
    if (painelTab && painelTab.id != null) {
      try {
        await chrome.tabs.update(painelTab.id, { active: true });
        if (painelTab.windowId != null) {
          await chrome.windows.update(painelTab.windowId, { focused: true });
        }
      } catch (e) { /* painel pode ter fechado; ignora */ }
    }
  }
}

// Acha uma aba aberta do Bling (prefere ativa, depois acordada)
async function acharAbaBling() {
  const tabs = await chrome.tabs.query({ url: 'https://*.bling.com.br/*' });
  console.log('[Bridge] abas do Bling encontradas:', tabs ? tabs.length : 0);
  if (!tabs || tabs.length === 0) {
    throw new Error('Nenhuma aba do Bling aberta. Abra www.bling.com.br numa aba, faca login e tente de novo.');
  }
  const tab =
    tabs.find(t => t.active && !t.discarded) ||
    tabs.find(t => !t.discarded && t.status === 'complete') ||
    tabs.find(t => t.status === 'complete') ||
    tabs[0];
  console.log('[Bridge] usando aba:', tab.id, tab.url || '(sem url)', tab.discarded ? '(dormindo)' : '(acordada)');
  return tab;
}

// ============================================================
// TUDO ABAIXO RODA DENTRO DA ABA DO BLING (funcao auto-contida:
// nao pode usar nada de fora - por isso os helpers ficam dentro).
// Devolve o resultado por chrome.runtime.sendMessage (nao pelo
// retorno da injecao, que congela junto com a aba).
// ============================================================
function fluxoDevolucaoNaPagina(p) {
  async function rodar() {
    // ---------- helpers ----------
    function escapeXajax(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }
    function formatarQtde(q) {
      const n = Number(q);
      if (!isFinite(n)) return '1,00';
      return n.toFixed(2).replace('.', ',');
    }
    function formatarValor(v) {
      const n = Number(v);
      if (!isFinite(n)) return '0,0000000000';
      return n.toFixed(10).replace('.', ',');
    }
    function formatarCpfCnpj(numero) {
      const d = String(numero || '').replace(/\D/g, '');
      if (d.length === 11) {
        return d.slice(0,3) + '.' + d.slice(3,6) + '.' + d.slice(6,9) + '-' + d.slice(9);
      }
      if (d.length === 14) {
        return d.slice(0,2) + '.' + d.slice(2,5) + '.' + d.slice(5,8) + '/' + d.slice(8,12) + '-' + d.slice(12);
      }
      return numero || '';
    }
    function formatarCep(cep) {
      const d = String(cep || '').replace(/\D/g, '');
      if (d.length === 8) {
        return d.slice(0,2) + '.' + d.slice(2,5) + '-' + d.slice(5);
      }
      return cep || '';
    }
    function entry(key, valueXml) {
      return '<e><k>' + escapeXajax(key) + '</k><v>' + valueXml + '</v></e>';
    }
    function leaf(value) {
      return escapeXajax(value == null ? '' : String(value));
    }
    function montarXmlDevolucao(itens, contato) {
      const produtosXml = '<xjxobj>' + Object.keys(itens).map(function (idItem) {
        const it = itens[idItem] || {};
        const inner = '<xjxobj>' +
          entry('quantidade', leaf(formatarQtde(it.quantidade))) +
          entry('valor', leaf(formatarValor(it.valor))) +
        '</xjxobj>';
        return entry(String(idItem), inner);
      }).join('') + '</xjxobj>';

      const end = contato.endereco || {};

      // b325 - normaliza telefone brasileiro pro formato que o Bling aceita.
      // Tira DDI 55, mantem so digitos, e devolve (XX) XXXX-XXXX ou
      // (XX) XXXXX-XXXX. Fora disso -> vazio.
      function telefoneBR(v) {
        let d = String(v == null ? '' : v).replace(/\D/g, '');
        if (d.length > 11 && d.startsWith('55')) d = d.slice(2);   // DDI
        if (d.length === 11) return '(' + d.slice(0,2) + ') ' + d.slice(2,7) + '-' + d.slice(7);
        if (d.length === 10) return '(' + d.slice(0,2) + ') ' + d.slice(2,6) + '-' + d.slice(6);
        return '';   // sem DDD ou lixo: melhor vazio que invalido
      }

      const contatoXml = '<xjxobj>' +
        entry('nome',           leaf(contato.nome)) +
        entry('id',             leaf(contato.id)) +
        entry('tipo',           leaf(contato.tipoPessoa || 'F')) +
        entry('cnpj',           leaf(formatarCpfCnpj(contato.numeroDocumento))) +
        entry('ie',             leaf(contato.ie || '')) +
        entry('indIEDest',      leaf(contato.contribuinte != null ? String(contato.contribuinte) : '9')) +
        entry('rg',             leaf(contato.rg || '')) +
        entry('nomePais',       leaf(end.pais || '')) +
        entry('idPais',         leaf('')) +
        entry('cep',            leaf(formatarCep(end.cep))) +
        entry('cidade',         leaf(end.municipio || '')) +
        entry('idMunicipio',    leaf(contato.idMunicipio || '')) +
        entry('uf',             leaf(end.uf || '')) +
        entry('endereco',       leaf(end.endereco || '')) +
        entry('enderecoNro',    leaf(end.numero || '')) +
        entry('bairro',         leaf(end.bairro || '')) +
        entry('complemento',    leaf(end.complemento || '')) +
        entry('email',          leaf(contato.email || '')) +
        // b325 - TELEFONE SANEADO. O Bling recusou uma devolucao da GOOD com
        // "E necessario preencher corretamente o campo Telefone" DUAS vezes
        // (fone e celular): o valor do cadastro ia cru, e formato que ele nao
        // aceita (com DDI, sem DDD, com lixo) trava a emissao inteira.
        //
        // NAO invento numero: telefone falso entraria no cadastro do cliente
        // no Bling e viraria dado errado permanente. O que faco e limpar e
        // formatar o que EXISTE; se nao der pra formar um telefone valido,
        // mando VAZIO — o campo nao e obrigatorio na NF-e, e vazio e honesto.
        entry('fone',           leaf(telefoneBR(contato.telefone))) +
        entry('celular',        leaf(telefoneBR(contato.celular))) +
        entry('dataNascimento', leaf(contato.dataNascimento || '')) +
      '</xjxobj>';

      return '<xjxobj>' +
        entry('produtos', produtosXml) +
        entry('contato', contatoXml) +
        entry('idNaturezaOperacao', leaf(p.fixos.idNaturezaOperacao)) +
        entry('idEmpresaControl', leaf(p.fixos.idEmpresaControl)) +
      '</xjxobj>';
    }
    // Le a resposta como JSON; se vier HTML/login, devolve { __erro }
    async function lerJson(resp, contexto) {
      const text = await resp.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        if (text.indexOf('<html') !== -1 || text.toLowerCase().indexOf('login') !== -1) {
          return { __erro: 'Sessao Bling expirada (' + contexto + '). Faca login no Bling nesta aba e tente de novo.' };
        }
        return { __erro: 'Resposta inesperada do Bling (' + contexto + '): ' + text.slice(0, 160) };
      }
    }
    // Procura um token JWT guardado pela pagina (localStorage/sessionStorage)
    function acharTokenGuardado() {
      try {
        const fontes = [window.localStorage, window.sessionStorage];
        for (const st of fontes) {
          for (let i = 0; i < st.length; i++) {
            const k = st.key(i);
            if (!k) continue;
            if (/token|jwt|auth/i.test(k)) {
              const v = st.getItem(k);
              if (v && /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(v.trim())) return v.trim();
            }
          }
        }
      } catch (e) { /* sem acesso; segue sem token */ }
      return null;
    }
    // So os NOMES das chaves que parecem token (pra diagnostico, sem valores)
    function listarChavesToken() {
      try {
        const nomes = [];
        [window.localStorage, window.sessionStorage].forEach(function (st) {
          for (let i = 0; i < st.length; i++) {
            const k = st.key(i);
            if (k && /token|jwt|auth|bearer/i.test(k)) nomes.push(k);
          }
        });
        return nomes.length ? nomes.join(', ') : '(nenhuma)';
      } catch (e) { return '(erro ao ler)'; }
    }

    // ---------- PASSO 1: obter dados da devolucao ----------
    // O Bling exige "carimbos" (cabecalhos) que o fetch puro nao poe.
    // Tenta em cascata e memoriza o modo que funcionou pros POSTs.
    const urlDados = '/Api/v3/nfe/' + encodeURIComponent(p.idNFOriginal) +
      '/obter-dados-devolucao/' + encodeURIComponent(p.idLoja);

    const tentativas = [];
    // Modo REVISAO: o cracha descoberto (x-api-revision) fixo - 1a da fila.
    // Fiel a captura real: o fetch do Bling manda Accept + x-api-revision.
    tentativas.push({
      nome: 'revisao',
      headers: { 'Accept': '*/*', 'x-api-revision': (p.apiRevision || '3.1.0'), 'X-GD-Bridge': '1' },
      referrer: null,
    });
    // Modo ESPELHO: usa os cabecalhos exatos capturados do proprio Bling
    if (p.espelho && p.espelho.headers) {
      tentativas.push({ nome: 'espelho', headers: p.espelho.headers, referrer: p.espelho.referrer || null });
    }
    // Marcador pra o espiao nao capturar nossas proprias tentativas
    tentativas.push({ nome: 'ajax',    headers: { 'Accept': '*/*', 'X-Requested-With': 'XMLHttpRequest', 'X-GD-Bridge': '1' }, referrer: null });
    tentativas.push({ nome: 'simples', headers: { 'Accept': '*/*', 'X-GD-Bridge': '1' }, referrer: null });
    const tokenPagina = acharTokenGuardado();
    if (tokenPagina) {
      tentativas.push({
        nome: 'bearer',
        headers: { 'Accept': '*/*', 'X-Requested-With': 'XMLHttpRequest', 'Authorization': 'Bearer ' + tokenPagina, 'X-GD-Bridge': '1' },
        referrer: null,
      });
    }

    let r1 = null;
    let headersBase = { 'Accept': '*/*' };
    let refBase = null;
    let modoHttp = null;
    const falhas = [];
    let diag = '';
    for (const t of tentativas) {
      const resp = await fetch(urlDados, {
        method: 'GET',
        credentials: 'include',
        headers: t.headers,
        referrer: t.referrer || 'about:client',
      });
      if (resp.ok) {
        r1 = resp;
        headersBase = t.headers;
        refBase = t.referrer || null;
        modoHttp = t.nome;
        break;
      }
      falhas.push(t.nome + '=HTTP ' + resp.status);
      if (!diag) {
        try {
          const ct = resp.headers.get('content-type') || '?';
          const corpo = (await resp.text()).slice(0, 120).replace(/\s+/g, ' ');
          diag = ' | 1a recusa: [' + ct + '] ' + corpo;
        } catch (e) { diag = ''; }
      }
    }
    if (!r1) {
      const temEspelho = !!(p.espelho && p.espelho.headers);
      const orientacao = temEspelho
        ? ' Nem copiando os cabecalhos exatos do Bling funcionou (cabecalhos capturados: ' + p.espelho.nomes + ').'
        : ' AINDA SEM O CRACHA: nesta MESMA aba do Bling, clique nos 3 pontinhos de qualquer NF -> "Gerar devolucao" (pode cancelar o popup) e depois clique de novo em Criar rascunho no painel - eu copio o cracha sozinho e uso.';
      return {
        ok: false,
        erro: 'Bling recusou o obter-dados em ' + urlDados +
          ' (tentativas: ' + falhas.join(' | ') + ').' +
          orientacao + diag +
          ' Chaves de token na pagina: ' + listarChavesToken() + '.',
      };
    }
    console.log('[Bridge/pagina] obter-dados OK no modo:', modoHttp);
    const j1 = await lerJson(r1, 'obter-dados');
    if (j1.__erro) return { ok: false, erro: j1.__erro };

    const dados = j1 && j1.data;
    if (!dados) return { ok: false, erro: 'obter-dados-devolucao veio sem campo "data".' };

    // ---------- PASSO 2: anti-duplicata ----------
    if (dados.devolucaoExistente === true) {
      return { ok: false, erro: 'Esta NF ja possui devolucao efetuada no Bling. Nada foi criado (protecao anti-duplicata).' };
    }

    // ═══════════════════════════════════════════════════════════════
    // b322 - IDS FISCAIS SAEM DA PROPRIA CONTA LOGADA, quando ela informa.
    //
    // O erro real na AMB (19/08): o Bling recusou o salvar com
    //   "Essa nota fiscal parece nao pertencer a essa conta"
    //   + "O CFOP () do item ... nao e um CFOP valido"
    // Os dois juntos sao a assinatura de idEmpresaControl/natureza de OUTRA
    // conta: o Bling nao acha a empresa, nao resolve o CFOP da natureza e
    // reclama das duas coisas.
    //
    // A origem: o `idEmpresaControl` da AMB era um numero que ficou como
    // "padrao do codigo" sem nunca ter sido confirmado NA CONTA DELA — a
    // sonda da b282 mostrou que `/empresas` da 404 na API v3, entao nao havia
    // como validar por la. Era um chute herdado.
    //
    // Mas o proprio `obter-dados-devolucao` responde DENTRO da conta logada.
    // Se ele traz esses ids, eles sao a verdade — melhor que env, melhor que
    // padrao, e funciona pra qualquer empresa nova sem configurar nada.
    const idEmpresaDaConta = String(
      dados.idEmpresaControl || dados.idEmpresa ||
      (dados.dadosNota && (dados.dadosNota.idEmpresaControl || dados.dadosNota.idEmpresa)) || ''
    ).trim();
    const idNaturezaDaConta = String(
      dados.idNaturezaOperacao ||
      (dados.dadosNota && dados.dadosNota.idNaturezaOperacao) || ''
    ).trim();
    if (idEmpresaDaConta) {
      console.log('[Bridge/pagina] idEmpresaControl veio da conta logada:', idEmpresaDaConta);
      p.fixos = Object.assign({}, p.fixos, { idEmpresaControl: idEmpresaDaConta });
    }
    if (idNaturezaDaConta) {
      console.log('[Bridge/pagina] idNaturezaOperacao veio da conta logada:', idNaturezaDaConta);
      p.fixos = Object.assign({}, p.fixos, { idNaturezaOperacao: idNaturezaDaConta });
    }
    p.__origemIds = {
      empresa: idEmpresaDaConta ? 'conta_logada' : 'servidor',
      natureza: idNaturezaDaConta ? 'conta_logada' : 'servidor',
    };

    const itens = dados.itens || {};
    if (Object.keys(itens).length === 0) {
      return { ok: false, erro: 'A NF nao retornou itens pra devolucao.' };
    }
    const dadosNota = dados.dadosNota || {};
    const idNotaVenda = dadosNota.id;
    // v1.4.3: o painel pode escolher o deposito (Geral/DEFEITOS/etc);
    // sem escolha, vale o padrao da NF (Geral)
    const idDeposito = (p.idDepositoEscolhido && String(p.idDepositoEscolhido).trim() !== '')
      ? String(p.idDepositoEscolhido).trim()
      : dadosNota.idDeposito;
    if (!idNotaVenda) return { ok: false, erro: 'obter-dados-devolucao nao trouxe dadosNota.id' };

    // ---------- PASSO 3: montar XML e salvar (cria a nota) ----------
    const xml = montarXmlDevolucao(itens, dados.contato || {});
    const bodySalvar =
      'xajax=salvarNotaDevolucao' +
      '&xajaxr=' + Date.now() +
      '&xajaxargs[]=' + encodeURIComponent(idNotaVenda) +
      '&xajaxargs[]=' + encodeURIComponent(xml) +
      '&xajaxargs[]=true';

    const r3 = await fetch('/services/notas.fiscais.server.php?f=salvarNotaDevolucao', {
      method: 'POST',
      credentials: 'include',
      headers: Object.assign({}, headersBase, {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
      }),
      referrer: refBase || 'about:client',
      body: bodySalvar,
    });
    if (!r3.ok) {
      return { ok: false, erro: 'Bling respondeu HTTP ' + r3.status + ' (salvar devolucao).' };
    }
    const salvo = await lerJson(r3, 'salvar devolucao');
    if (salvo.__erro) return { ok: false, erro: salvo.__erro };

    if (!salvo.idNotaDevolucao) {
      if (salvo && salvo.errors && salvo.errors.length) {
        // b322 - dizer QUAIS ids foram usados e DE ONDE vieram. Sem isso, o
        // "nao pertence a essa conta" e um beco sem saida: a tela nao mostra o
        // numero que o Bling recusou, e ninguem sabe se veio da conta, do
        // servidor ou de um padrao velho.
        const usados = ' | IDs usados -> empresa: ' + String((p.fixos && p.fixos.idEmpresaControl) || '(vazio)')
          + ' (' + ((p.__origemIds && p.__origemIds.empresa) || '?') + ')'
          + ', natureza: ' + String((p.fixos && p.fixos.idNaturezaOperacao) || '(vazio)')
          + ' (' + ((p.__origemIds && p.__origemIds.natureza) || '?') + ')';
        return { ok: false, erro: 'Bling recusou o salvar: ' + JSON.stringify(salvo.errors).slice(0, 300) + usados };
      }
      return { ok: false, erro: 'Bling nao retornou idNotaDevolucao: ' + JSON.stringify(salvo).slice(0, 300) };
    }

    const idNotaDevolucao = salvo.idNotaDevolucao;
    const numero = (salvo.dadosEmissao && salvo.dadosEmissao.numero) || null;

    // Se NAO for pra emitir, para aqui (fica como rascunho, situacao 1)
    if (!p.emitir) {
      return {
        ok: true,
        resultado: {
          idNotaDevolucao: idNotaDevolucao,
          numero: numero,
          situacao: (salvo.dadosEmissao && salvo.dadosEmissao.situacao) || '1',
          emitida: false,
          idDeposito: idDeposito || null,
        },
      };
    }

    // ---------- PASSO 4: emitir no SEFAZ ----------
    if (!idDeposito) {
      return { ok: false, erro: 'Nao foi possivel emitir: idDeposito ausente nos dados da NF.' };
    }
    const bodyEmitir =
      'xajax=emitirNotaDevolucaoCertificadoArmazenado' +
      '&xajaxr=' + Date.now() +
      '&xajaxargs[]=' + encodeURIComponent(idNotaDevolucao) +
      '&xajaxargs[]=' + encodeURIComponent(idDeposito);

    const r4 = await fetch('/services/notas.fiscais.server.php?f=emitirNotaDevolucaoCertificadoArmazenado', {
      method: 'POST',
      credentials: 'include',
      headers: Object.assign({}, headersBase, {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
      }),
      referrer: refBase || 'about:client',
      body: bodyEmitir,
    });
    if (!r4.ok) {
      return { ok: false, erro: 'Bling respondeu HTTP ' + r4.status + ' (emitir devolucao).' };
    }
    const emissao = await lerJson(r4, 'emitir devolucao');
    if (emissao.__erro) return { ok: false, erro: emissao.__erro };

    if (emissao.situacao !== 2) {
      const erroMsg = emissao.erros || emissao.mensagem || JSON.stringify(emissao).slice(0, 300);
      return { ok: false, erro: 'SEFAZ nao autorizou (situacao ' + emissao.situacao + '): ' + erroMsg };
    }

    return {
      ok: true,
      resultado: {
        idNotaDevolucao: idNotaDevolucao,
        numero: numero,
        situacao: String(emissao.situacao),
        emitida: emissao.situacao === 2,
        mensagem: emissao.mensagem || '',
        idDeposito: idDeposito,
      },
    };
  }

  // Roda e devolve o resultado por MENSAGEM (canal que nao congela)
  rodar()
    .catch(function (e) {
      return { ok: false, erro: (e && e.message) ? e.message : String(e) };
    })
    .then(function (resp) {
      try {
        chrome.runtime.sendMessage({
          tipo: 'BLING_DEVOLUCAO_RESULTADO_PAGINA',
          execId: p.execId,
          ok: resp.ok,
          resultado: resp.resultado,
          erro: resp.erro,
        });
      } catch (e) { /* extensao recarregada no meio; nada a fazer */ }
    });

  return true; // resposta imediata; o resultado real vem por mensagem
}

// Log de instalacao (aparece em edge://extensions/ -> service worker)
chrome.runtime.onInstalled.addListener(() => {
  console.log('[GOOD Devolucoes Bridge] v1.4.3 instalada com sucesso');
});
