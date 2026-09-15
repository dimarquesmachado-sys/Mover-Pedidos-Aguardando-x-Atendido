'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   DESCOBRIR OS IDs DA EMPRESA NO BLING (15/09/2026).

   Pedido do dono em 26/08, que ficou na fila e ele repetiu hoje:

     "É algo que ao adicionar CNPJ de empresa nova deveria tá sempre buscando e
      pegando. Ou até conseguir consultar de tempos em tempos."

   Hoje esses ids são mapeados NO DEVTOOLS, à mão, abrindo tela por tela do Bling
   — foi assim que as unidades e depósitos da AMB entraram no arquivo de
   referência. É a maior fonte de digitação no embarque de uma empresa nova, e a
   que mais erra: id de FILIAL e id de UNIDADE DE NEGÓCIO são espaços diferentes, e
   confundir os dois já aconteceu (eu mesmo indiquei a filial quando era a unidade).

   O que esta peça faz: pergunta ao Bling, com o token que a empresa JÁ tem depois
   do OAuth, e devolve os ids prontos pra colar — canais de venda, depósitos e
   situações de pedido.

   Uma decisão importante de desenho: ela NÃO presume que sabe os caminhos da API.
   Cada recurso tem uma lista de caminhos CANDIDATOS e ela reporta qual respondeu e
   qual não existe. Chutar um caminho e tratar 404 como "não tem nada" seria dizer
   ao dono que a empresa não tem depósito — o tipo de mentira que custa horas.
   ──────────────────────────────────────────────────────────────────────────── */

/* candidatos por recurso: o primeiro que responder 200 vale. A ordem vai do mais
   provável ao menos, e o resultado diz qual funcionou — assim o próximo a mexer
   aqui não precisa adivinhar de novo. */
const RECURSOS = {
  /* 15/09, com dado real da AMB: /canais-de-venda e /lojas deram 404 nos dois. Em vez de
     continuar chutando caminho, descobrimos pelos PEDIDOS — cada pedido traz `loja: {id,
     nome}`, e esse endpoint a gente sabe que funciona porque o F1 usa o dia todo. É mais
     confiável que adivinhar rota: mostra os canais que a empresa REALMENTE usa, com o nome
     que aparece no Bling. */
  canais_de_venda: {
    para: 'ME_LOJA_IDS — quais canais o F1 considera do Mercado Livre',
    caminhos: [],
    derivar: 'pedidos',
  },
  depositos: {
    para: 'depósitos (Geral, Defeitos, os de Fulfillment de cada marketplace)',
    caminhos: ['/depositos'],
  },
  /* 15/09: /situacoes/modulos respondeu, mas devolve os MÓDULOS (Pedidos de Venda, Ordens de
     Produção), não as situações. As situações vêm num segundo passo, pelo id do módulo — o
     que interessa aqui é o de Pedidos de Venda. */
  situacoes: {
    para: 'SIT_ATENDIDO / SIT_AGUARDANDO / SIT_VERIFICADO — os ids que o fluxo move',
    caminhos: ['/situacoes/modulos'],
    seguirModulo: /pedidos?\s+de\s+venda/i,
  },
};

function criar(cfg) {
  for (const n of ['rotulo', 'blingGet']) {
    if (!cfg || cfg[n] == null) throw new Error('lib/checkout/descobrir-ids: falta ' + n);
  }
  const { rotulo, blingGet } = cfg;

  async function _tentar(caminhos) {
    const tentativas = [];
    for (const c of caminhos) {
      let r;
      try { r = await blingGet(c); } catch (e) { tentativas.push({ caminho: c, erro: String(e.message || e).slice(0, 120) }); continue; }
      const status = Number(r && r.status);
      const dados = r && r.data && (r.data.data || r.data);
      if (status === 200 && dados) return { caminho: c, dados, tentativas };
      tentativas.push({ caminho: c, status: status || null });
    }
    return { caminho: null, dados: null, tentativas };
  }

  /* nomes variam entre recursos do Bling; pegar o que existir em vez de exigir um
     formato — o objetivo é o dono ler a lista, não o código adivinhar o esquema. */
  function _resumir(item) {
    if (!item || typeof item !== 'object') return null;
    const id = item.id != null ? item.id : (item.idDeposito != null ? item.idDeposito : item.codigo);
    const nome = item.descricao || item.nome || item.titulo || item.situacao || null;
    const extra = {};
    for (const k of ['tipo', 'situacao', 'padrao', 'idModulo', 'modulo']) if (item[k] != null) extra[k] = item[k];
    return id == null && !nome ? null : Object.assign({ id, nome }, extra);
  }

  /* canais de venda a partir dos PEDIDOS: varre as últimas páginas e junta os `loja` que
     aparecem. Dá os canais que a empresa REALMENTE usa, com o nome do Bling — e sem depender
     de adivinhar uma rota que deu 404. */
  let _diagCanais = [];
  async function _canaisPelosPedidos() {
    _diagCanais = [];
    const vistos = new Map();
    /* guarda um numeroLoja de exemplo por canal: é com ele que dá pra PROVAR qual canal é o
       do ML, em vez de sugerir pelo mais usado. */
    for (let pag = 1; pag <= 3; pag++) {
      let r;
      /* 15/09 — a GOOD voltou "nenhum pedido recente trouxe loja" numa rodada e SEIS canais na
         anterior. A causa não é ausência de pedido: é a chamada falhando (cota do Bling, 429,
         timeout) e eu engolindo o erro com um break mudo. Dizer "não tem pedido" quando a
         verdade é "não consegui perguntar" manda o dono investigar o lugar errado. */
      try { r = await blingGet('/pedidos/vendas?pagina=' + pag + '&limite=100'); }
      catch (e) { _diagCanais.push({ pagina: pag, erro: String(e.message || e).slice(0, 110) }); break; }
      const status = Number(r && r.status);
      if (status && status !== 200) { _diagCanais.push({ pagina: pag, status }); break; }
      const lista = (r && r.data && r.data.data) || [];
      if (!lista.length) { _diagCanais.push({ pagina: pag, leia: 'a página voltou vazia' }); break; }
      for (const p of lista) {
        const l = p && p.loja;
        if (!l || l.id == null) continue;
        const k = String(l.id);
        const at = vistos.get(k) || { id: l.id, nome: l.nome || l.descricao || null, pedidos: 0, _amostra: null };
        at.pedidos++;
        if (!at._amostra && p.numeroLoja) at._amostra = String(p.numeroLoja);
        /* guarda o id do pedido pra, se a lista não tiver trazido o numeroLoja, buscar o
           detalhe depois — uma chamada por canal, não por pedido */
        if (!at._idPedido && p.id != null) at._idPedido = p.id;
        if (!at.nome && (l.nome || l.descricao)) at.nome = l.nome || l.descricao;
        vistos.set(k, at);
      }
    }
    const canais = [...vistos.values()].sort((a, b) => b.pedidos - a.pedidos);

    /* 15/09 — o retorno real mostrou a prova falhando com "não consegui provar pelo ML", e a
       causa é que a LISTA de pedidos do Bling nem sempre traz `numeroLoja`: o próprio F1 faz
       `pDetalhe?.numeroLoja || p?.numeroLoja`, buscando o detalhe primeiro. Sem a amostra,
       nem a prova nem a dedução por formato têm com o que trabalhar.
       Então, pros canais que ficaram sem amostra, buscamos UM detalhe cada — é uma chamada
       por canal desconhecido, não por pedido. */
    for (const c of canais) {
      if (c._amostra || !c._idPedido) continue;
      try {
        const r = await blingGet('/pedidos/vendas/' + c._idPedido);
        const d = r && r.data && r.data.data;
        /* o DETALHE traz o campo como `numeroPedidoLoja`, não `numeroLoja` (a LISTA usa o outro
           nome) — é o mesmo que o F1 já lê em amb-checkout-offline/index.js. `numeroLoja` fica
           só de fallback, caso algum Bling devolva os dois formatos. */
        const nl = d && (d.numeroPedidoLoja || d.numeroLoja);
        if (nl) c._amostra = String(nl);
      } catch (e) { /* um canal sem amostra não impede os outros */ }
    }
    return canais;
  }

  /* situações do módulo de Pedidos de Venda: o /situacoes/modulos devolve os módulos, e as
     situações vêm num segundo passo pelo id dele. */
  async function _situacoesDoModulo(modulos, padrao) {
    const mod = (modulos || []).find(m => padrao.test(String(m.nome || '')));
    if (!mod || mod.id == null) return { erro: 'não achei o módulo de Pedidos de Venda entre: ' + (modulos || []).map(m => m.nome).join(', ') };
    /* 15/09 — o dono mandou o print do select de situações do Bling da Girassol e faltava uma
       na minha lista: "Checkout parcial" (126724). A API devolve PAGINADO, e eu lia só a
       primeira página — uma lista de ids que se apresenta como completa e não é vale menos
       que lista nenhuma, porque ninguém desconfia dela. Agora percorre até acabar. */
    const itens = [];
    const vistos = new Set();
    for (let pag = 1; pag <= 10; pag++) {
      let r;
      try { r = await blingGet('/situacoes/modulos/' + mod.id + '?pagina=' + pag + '&limite=100'); }
      catch (e) { return itens.length ? { modulo: { id: mod.id, nome: mod.nome }, itens, aviso: 'parei na página ' + pag + ': ' + String(e.message || e).slice(0, 80) } : { erro: String(e.message || e).slice(0, 120) }; }
      if (Number(r && r.status) !== 200) {
        if (itens.length) return { modulo: { id: mod.id, nome: mod.nome }, itens, aviso: 'parei na página ' + pag + ' (HTTP ' + (r && r.status) + ')' };
        return { erro: 'HTTP ' + (r && r.status) + ' em /situacoes/modulos/' + mod.id };
      }
      const lista = (r.data && (r.data.data || r.data)) || [];
      const pagina = (Array.isArray(lista) ? lista : [lista]).map(_resumir).filter(Boolean);
      if (!pagina.length) break;
      let novos = 0;
      for (const it of pagina) {
        const k = String(it.id);
        if (vistos.has(k)) continue;
        vistos.add(k); itens.push(it); novos++;
      }
      /* se a página veio só com repetidos, o Bling está ignorando o `pagina` — parar evita
         laço infinito sem fingir que acabou */
      if (!novos) break;
    }
    return { modulo: { id: mod.id, nome: mod.nome }, itens };
  }

  /* 15/09, do retorno real da AMB: os pedidos trazem `loja.id` mas NÃO o nome — e sem nome o
     dono olha uma lista de números e não sabe qual é o do ML. Mas os DEPÓSITOS nomeiam os
     canais: "Shopee 206017368 (Fulfillment)", "Magalu 206018666 (Fulfillment)". Cruzar os
     dois dá nome a parte dos canais sem pedir nada a ninguém. */
  /* 15/09 — PROVA, não palpite. Sobrava um canal sem nome (133 pedidos na AMB) e a sugestão
     dizia "confirme que é mesmo o do ML". Dá pra confirmar sozinho: pega um numeroLoja
     daquele canal e pergunta ao Mercado Livre se aquele pedido é nosso. Se o ML responde e o
     vendedor é o nosso seller_id, aquele canal É o do ML — sem depender de o dono conferir.
     Se não der pra provar, a sugestão continua existindo, marcada como palpite: perder a
     prova não pode significar perder a ajuda. */
  /* Codex (#464): as duas chamadas do ML aqui embaixo não tinham prazo — se a API aceitar a
     conexão e não responder, o fetch fica pendurado pra sempre e trava /descobrir-ids. 20s é o
     mesmo prazo que o ml-token-manager já usa pro /users/me. */
  async function _fetchML(url, token) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try { return await fetch(url, { headers: { Authorization: 'Bearer ' + token }, signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
  }

  let _diagProva = [];
  async function _provarCanalML(canais, sellerId) {
    if (!cfg.garantirTokenML || !sellerId) { _diagProva = [{ leia: 'sem token do ML ou sem seller_id — a prova não chegou a rodar' }]; return null; }
    let token;
    /* mesmo buraco do apontamento do Codex, um passo mais fundo: este é um SEGUNDO garantirTokenML,
       independente do que _identidadeML já chamou — se o token cair bem entre os dois (ou o app não
       tiver permissão pra este escopo específico), o catch devolvia null sem registrar nada, e
       por_que_nao_provei sumia de novo, agora no caminho em que a identidade JÁ tinha saído bem. */
    try { token = await cfg.garantirTokenML(); }
    catch (e) { _diagProva = [{ leia: 'o token do ML falhou na hora de provar (a identidade já tinha saído bem antes)', erro: String(e.message || e).slice(0, 120) }]; return null; }
    /* 15/09 — a prova roda também nos canais já nomeados PELO FORMATO: o formato é dedução,
       a prova é fato, e dedução não pode impedir o fato de acontecer. (O teste pegou isso: eu
       acrescentei a dedução por formato e ela, sem querer, desligou a prova.) Canal nomeado
       por DEPÓSITO fica de fora — ali o nome veio do próprio Bling, não de palpite. */
    const semNome = canais.filter(c => c._amostra && (!c.nome || /formato/i.test(String(c.obs || ''))));
    /* 15/09 — a prova falhava e dizia só "não consegui provar", que é exatamente o erro que
       eu critiquei nos caminhos do Bling: sem saber O QUE respondeu, ninguém conserta. Agora
       cada tentativa fica registrada com o status. */
    _diagProva = [];
    for (const c of semNome) {
      for (const url of ['/orders/' + c._amostra, '/packs/' + c._amostra]) {
        let d;
        try {
          const r = await _fetchML('https://api.mercadolibre.com' + url, token);
          if (!r.ok) { _diagProva.push({ canal: c.id, url, status: r.status }); continue; }
          d = await r.json();
        } catch (e) { _diagProva.push({ canal: c.id, url, erro: String(e.message || e).slice(0, 80) }); continue; }
        let vendedor = (d && d.seller && d.seller.id) || (d && d.orders && d.orders[0] && d.orders[0].seller_id) || null;
        /* Codex (#464): se a prova veio do PEDIDO DE DENTRO do pacote (e não do /orders ou
           /packs de fora), a prova final tem que dizer isso — senão o dono lê "/packs/N" como
           se o vendedor tivesse vindo dali, quando na verdade veio de um pedido interno. */
        let urlProva = url;

        /* 15/09 — o diagnóstico criado ontem mostrou o caminho na GOOD: /orders deu 404 e
           /packs respondeu 200 "sem campo de vendedor". A causa é que o numeroPedidoLoja dela
           é um PACK, e o pacote traz só a lista de pedidos — o vendedor vive no PEDIDO. Um
           salto a mais resolve, e ele só acontece quando é necessário.
           Codex (#464): um pacote pode ter mais de um pedido, e o primeiro pode falhar (404,
           cancelado, etc.) enquanto outro dentro do mesmo pacote prova o vendedor — parar no
           `orders[0]` jogava fora essa prova à toa. Percorre os pedidos do pacote até um deles
           responder com vendedor ou a lista acabar. */
        if (!vendedor && d && Array.isArray(d.orders)) {
          for (const ped of d.orders) {
            if (!ped || ped.id == null) continue;
            const urlPed = '/orders/' + ped.id + ' (pedido de dentro do pacote)';
            try {
              const r2 = await _fetchML('https://api.mercadolibre.com/orders/' + ped.id, token);
              if (r2.ok) {
                const d2 = await r2.json();
                const v2 = (d2 && d2.seller && d2.seller.id) || null;
                if (v2) {
                  vendedor = v2;
                  urlProva = '/packs → /orders/' + ped.id;
                  _diagProva.push({ canal: c.id, url: urlProva, leia: 'o vendedor veio do pedido DENTRO do pacote' });
                  break;
                }
                _diagProva.push({ canal: c.id, url: urlPed, status: 200, leia: 'respondeu 200 mas sem campo de vendedor' });
              } else {
                _diagProva.push({ canal: c.id, url: urlPed, status: r2.status });
              }
            } catch (e) { _diagProva.push({ canal: c.id, url: urlPed, erro: String(e.message || e).slice(0, 80) }); }
          }
        }
        if (!vendedor) { _diagProva.push({ canal: c.id, url, status: 200, leia: 'respondeu 200 mas sem campo de vendedor' }); continue; }
        if (String(vendedor) !== String(sellerId)) {
          _diagProva.push({ canal: c.id, url: urlProva, vendedor_no_pedido: vendedor, nosso_seller: sellerId,
                            leia: 'o pedido existe mas é de OUTRO vendedor — este canal não é desta conta' });
          continue;
        }
        if (vendedor && String(vendedor) === String(sellerId)) {
          c.nome = 'Mercado Livre';
          c.obs = 'PROVADO: o pedido ' + c._amostra + ' deste canal pertence ao seller ' + sellerId + ' (' + urlProva + ')';
          return c;
        }
      }
    }
    return null;
  }

  /* 15/09 — o formato do numeroLoja identifica o marketplace, e isso resolve o canal que
     sobrou sem nome (206027680, 13 pedidos na AMB — sem depósito e não é ML). Não é adivinhar
     por nome: cada marketplace numera de um jeito próprio e estável.
     Vem marcado como "pelo formato", diferente do "PROVADO" do ML — a origem de cada
     afirmação tem que continuar visível, senão palpite bom e prova viram a mesma coisa. */
  /* 15/09, corrigido com dado real: o canal 206027680 da AMB veio com 586075287702374196 (18
     dígitos) e eu rotulei SHOPEE — porque meu padrão da Shopee era `6 dígitos + 8 ou mais
     alfanuméricos`, e dígito É alfanumérico, então ele engoliu o do TikTok. A ordem aqui
     importa: do MAIS específico pro mais genérico, e o da Shopee passou a exigir ao menos uma
     LETRA, que é o que realmente distingue o número dela. */
  const FORMATOS = [
    [/^\d{3}-\d{7}-\d{7}$/, 'Amazon (formato do pedido)'],
    [/^LU-?\d/i, 'Magalu (formato do pedido)'],
    [/^\d{18,19}$/, 'TikTok (formato do pedido)'],
    [/^\d{13,16}$/, 'Mercado Livre (formato do pedido)'],
    /* a Shopee: prefixo de data (AAMMDD) + sufixo que SEMPRE tem letra. O mínimo era 8
       caracteres no sufixo e eu baixei pra 4 — o comprimento varia e não é o que distingue;
       o que distingue é a LETRA, que nenhum dos outros formatos tem. */
    [/^\d{6}(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,}$/i, 'Shopee (formato do pedido)'],
  ];
  function _peloFormato(amostra) {
    const a = String(amostra || '').trim();
    if (!a) return null;
    for (const [re, nome] of FORMATOS) if (re.test(a)) return nome;
    return null;
  }

  function _nomearCanais(canais, depositos) {
    const porId = new Map();
    for (const d of depositos || []) {
      const m = String(d.nome || '').match(/(\d{6,})/);
      if (!m) continue;
      const marca = String(d.nome).replace(/\s*\d{6,}\s*/, ' ').replace(/\(.*?\)/g, '').trim();
      if (marca) porId.set(m[1], marca);
    }
    return canais.map(c => {
      const doDeposito = porId.get(String(c.id)) || null;
      if (c.nome || doDeposito) {
        return Object.assign({}, c, { nome: c.nome || doDeposito, obs: c.obs || 'nome vindo do depósito com o mesmo id' });
      }
      /* sem depósito que o nomeie, o FORMATO do número do pedido diz de qual marketplace é */
      const peloFormato = _peloFormato(c._amostra);
      return Object.assign({}, c, {
        nome: peloFormato,
        obs: peloFormato ? 'deduzido do formato do número do pedido (' + c._amostra + ')' : null,
        exemplo_pedido: peloFormato ? undefined : (c._amostra || null),
        leia: peloFormato ? undefined : 'não identifiquei este canal — o número de exemplo acima ajuda a reconhecer no Bling',
      });
    });
  }

  /* Sugere o valor de cada env a partir do que foi descoberto, casando pelo NOME da
     situação. É o passo que tira a digitação: em vez de o dono ler uma lista de ids e
     descobrir qual é qual, ele recebe as linhas prontas pra colar no Render. */
  /* 15/09 — ERRO SÉRIO CORRIGIDO. Eu montava os nomes das envs juntando um prefixo com um
     sufixo que eu inventei, e o resultado não existia no código:

        sugeri AMBBKP_SITUACAO_ATENDIDO  ·  o código lê AMBBKP_SIT_ATENDIDO
        sugeri AMBBKP_ME_LOJA_IDS        ·  o código lê AMB_ME_LOJA_IDS

     São DOIS espaços de nome diferentes no mesmo serviço: o checkout usa AMBBKP_ e o módulo
     fiscal usa AMB_ (e a Girassol, no fiscal, não usa prefixo nenhum). Colar a env errada é
     pior que não colar: o dono acha que configurou, o valor continua o padrão herdado, e o
     sintoma só aparece como pedido que o F1 ignora.
     Agora os nomes vêm de quem os LÊ — cada empresa passa os dela. */
  function _sugerirEnvs(envNomes, situacoes, canais, canalMlProvado) {
    const acha = (padrao) => {
      const s = (situacoes || []).find(x => padrao.test(String(x.nome || '')));
      return s ? s.id : null;
    };
    const env = {};
    const mapa = [
      ['atendido', /^atendido$/i],
      ['aguardando', /^aguardando$/i],
      ['despachados', /^despachados?$/i],
      ['verificado', /^verificado$/i],
    ];
    const naoAchei = [];
    for (const [chave, padrao] of mapa) {
      const nome = envNomes && envNomes[chave];
      if (!nome) continue;                       // empresa que não expõe essa env
      const id = acha(padrao);
      if (id != null) env[nome] = String(id);
      else naoAchei.push(nome);
    }
    /* canais: o dono escolhe qual é o do ML. Sugerimos o mais usado SEM nome de outro
       marketplace — e deixamos explícito que é sugestão, não certeza. */
    /* se o canal foi PROVADO (um pedido dele pertence ao nosso seller no ML), some o
       "confirme antes de colar" — a diferença entre prova e palpite tem que aparecer pra
       quem lê, senão as duas viram a mesma coisa. */
    let confira;
    if (canalMlProvado) {
      /* as duas correções valem e vieram de lados diferentes: o NOME da env vem de quem a lê
         (senão o dono cola uma env que não existe) e a frase não repete "PROVADO", porque o
         `obs` já começa com ela. */
      if (envNomes && envNomes.meLojaIds) env[envNomes.meLojaIds] = String(canalMlProvado.id);
      confira = 'ME_LOJA_IDS ' + canalMlProvado.obs;
    } else {
      const semMarca = (canais || []).filter(c => !/shopee|magalu|tiktok|amazon/i.test(String(c.nome || '')));
      if (semMarca.length) {
        if (envNomes && envNomes.meLojaIds) env[envNomes.meLojaIds] = String(semMarca[0].id);
        confira = 'ME_LOJA_IDS é PALPITE (não consegui provar pelo ML): foi o canal mais usado que não é ' +
                  'Shopee/Magalu/TikTok — confirme antes de colar, porque id errado faz o F1 ignorar todos os pedidos';
      } else {
        confira = 'não consegui sugerir ME_LOJA_IDS: todos os canais foram nomeados como outro marketplace';
      }
    }
    /* 15/09 — CONFERÊNCIA. Até agora a rota sugeria e o DONO comparava na mão com o Render,
       env por env. Ela já tem as duas pontas — o valor descoberto e o nome da env —, então
       comparar é trabalho dela. O que sai: o que já bate (nada a fazer), o que está com valor
       DIFERENTE (o caso perigoso: alguém configurou errado e ninguém vê) e o que não existe,
       com a informação que muda a decisão — se o padrão do código já é o valor certo, criar a
       env não muda nada; se não é, criar é obrigatório. */
    const conferencia = { ok: [], diferente: [], em_branco: [], ausente_mas_padrao_ok: [], ausente_precisa_criar: [] };
    const ehLista = (nome) => envNomes && nome === envNomes.meLojaIds;   // ME_LOJA_IDS aceita vários ids

    for (const [nome, valor] of Object.entries(env)) {
      const atual = process.env[nome];

      /* Codex #466: valor só com ESPAÇOS não é ausência. Os consumidores fazem
         `Number(process.env.X || 9)` e o espaço é truthy: Number('  ') vira 0, então a
         empresa não cai no padrão, fica com ZERO — situação inexistente, move desligado.
         É o pior dos três estados e não pode ser reportado como "não existe". */
      if (atual != null && String(atual) !== '' && String(atual).trim() === '') {
        conferencia.em_branco.push({ env: nome, descoberto: String(valor),
          leia: 'a env existe com só espaços — NÃO cai no padrão do código, vira 0 e desliga o que depende dela' });
        continue;
      }

      if (atual == null || String(atual) === '') {
        const padrao = (cfg.padroesEnv || {})[nome];
        /* Codex #466: se o valor é PALPITE (a prova do ML não saiu), não mandar criar como se
           fosse obrigatório — o dono colaria um id adivinhado achando que era certeza. */
        const ehPalpite = ehLista(nome) && !canalMlProvado;
        if (padrao != null && String(padrao) === String(valor) && !ehPalpite) {
          conferencia.ausente_mas_padrao_ok.push({ env: nome, valor,
            leia: 'não existe no Render, mas o padrão do código já é este valor — criar não muda nada',
            /* Codex #466: a Girassol tem um SEGUNDO consumidor de ME_LOJA_IDS
               (girassol/importarPedido.js) com padrão próprio; "não muda nada" só vale se
               TODOS os padrões forem iguais. */
            atencao: (cfg.padroesExtras || {})[nome] ? 'outro arquivo lê esta env com padrão ' + cfg.padroesExtras[nome] + ' — criar MUDA para ele' : undefined,
          });
        } else {
          conferencia.ausente_precisa_criar.push({ env: nome, valor,
            padrao_do_codigo: padrao != null ? String(padrao) : '(desconhecido)',
            atencao: ehPalpite ? 'este valor é PALPITE (a prova pelo ML não saiu) — confirme antes de criar' : undefined });
        }
        continue;
      }

      const atualLimpo = String(atual).trim();
      if (atualLimpo === String(valor)) { conferencia.ok.push({ env: nome, valor }); continue; }

      /* Codex #466: ME_LOJA_IDS aceita lista separada por vírgula, e o consumidor faz
         `.split(',')`. Se o id descoberto está na lista, está configurado — comparar a
         string inteira acusaria "diferente" numa empresa que tem ML normal e ML Full. */
      if (ehLista(nome)) {
        const lista = atualLimpo.split(',').map(x => x.trim()).filter(Boolean);
        if (lista.includes(String(valor))) {
          conferencia.ok.push({ env: nome, valor, leia: lista.length > 1 ? 'o id descoberto está na lista (' + lista.join(', ') + ') — os outros devem ser canais que não apareceram nos pedidos recentes, como o Full' : undefined });
          continue;
        }
      }
      conferencia.diferente.push({ env: nome, no_render: atualLimpo, descoberto: String(valor), leia: 'VALOR DIFERENTE — confira qual está certo antes de mexer' });
    }
    return { colar_no_render: env, confira, nao_encontrei: naoAchei, conferencia };
  }

  /* 15/09 — IDENTIDADE NOS MARKETPLACES. O /users/me do ML já é chamado 8 a 10 vezes
     espalhadas por empresa pra perguntar "quem sou eu", e a GOOD não chama nenhuma — ela
     simplesmente não sabe o próprio seller id. No embarque isso é o dado que fecha o ciclo:
     depois do OAuth, dá pra perguntar uma vez e ter certeza de que o token é da conta certa.
     Opcional de propósito: sem o token, o resto da descoberta continua valendo. */
  async function _identidadeML() {
    if (!cfg.garantirTokenML) return { ok: false, leia: 'o token do ML não foi passado pra esta rota' };
    let token;
    try { token = await cfg.garantirTokenML(); } catch (e) { return { ok: false, erro: String(e.message || e).slice(0, 120) }; }
    try {
      const r = await fetch('https://api.mercadolibre.com/users/me', { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) return { ok: false, erro: 'HTTP ' + r.status + ' em /users/me' };
      const d = await r.json();
      return {
        ok: true,
        seller_id: d.id,
        apelido: d.nickname || null,
        site: d.site_id || null,
        /* o e-mail confirma pra o dono que é a CONTA certa — o erro caro aqui não é errar o
           id, é autorizar a conta de outra empresa e só descobrir depois. */
        email: d.email || null,
      };
    } catch (e) { return { ok: false, erro: String(e.message || e).slice(0, 120) }; }
  }

  async function descobrir() {
    const saida = { empresa: rotulo, em: new Date().toISOString(), recursos: {} };
    for (const [nome, spec] of Object.entries(RECURSOS)) {
      if (spec.derivar === 'pedidos') {
        const canais = await _canaisPelosPedidos();
        saida.recursos[nome] = canais.length
          ? { para: spec.para, ok: true, via: 'pedidos recentes (as rotas /canais-de-venda e /lojas dão 404)', itens: canais,
              leia: 'ME_LOJA_IDS desta empresa = o(s) id(s) cujo nome é do Mercado Livre' }
          : { para: spec.para, ok: false, via: 'pedidos recentes',
              /* a mensagem depende do que REALMENTE aconteceu: chamada que falhou e página
                 vazia mandam investigar lugares diferentes. */
              leia: _diagCanais.some(d => d.erro || d.status)
                ? 'a consulta de pedidos FALHOU — não é ausência de venda; veja o detalhe abaixo e tente de novo fora do horário de pico do Bling'
                : 'nenhum pedido recente trouxe `loja` — a empresa tem vendas nos últimos dias?',
              tentei: _diagCanais };
        continue;
      }
      const r = await _tentar(spec.caminhos);
      if (!r.dados) {
        saida.recursos[nome] = {
          para: spec.para, ok: false,
          /* dizer o que foi TENTADO é o que evita a próxima pessoa repetir o chute */
          tentei: r.tentativas,
          leia: 'nenhum caminho respondeu — confira se o app do Bling desta empresa tem permissão pra este recurso',
        };
        continue;
      }
      const lista = Array.isArray(r.dados) ? r.dados : [r.dados];
      const itens = lista.map(_resumir).filter(Boolean);

      if (spec.seguirModulo) {
        const sit = await _situacoesDoModulo(itens, spec.seguirModulo);
        saida.recursos[nome] = sit.erro
          ? { para: spec.para, ok: false, caminho: r.caminho, modulos: itens, erro: sit.erro }
          /* o `aviso` de lista parcial existia na função e se perdia aqui — meia-porta: a
             lista saía como se estivesse completa, que é justamente o que este conserto
             existe pra evitar. */
          : { para: spec.para, ok: true, caminho: '/situacoes/modulos/' + sit.modulo.id, modulo: sit.modulo, itens: sit.itens, aviso: sit.aviso };
        continue;
      }

      saida.recursos[nome] = { para: spec.para, ok: true, caminho: r.caminho, itens };
    }

    saida.recursos.mercado_livre = Object.assign(
      { para: 'seller id da conta do ML — confirma que o token autorizado é o da empresa certa' },
      await _identidadeML());

    /* cruzamentos e sugestão: só depois de tudo descoberto */
    const cn = saida.recursos.canais_de_venda, dp = saida.recursos.depositos, st = saida.recursos.situacoes;
    if (cn && cn.ok && dp && dp.ok) cn.itens = _nomearCanais(cn.itens, dp.itens);
    /* com o seller_id em mãos, tenta PROVAR qual canal é o do ML antes de sugerir */
    const ml = saida.recursos.mercado_livre;
    let provado = null;
    if (cn && cn.ok && ml && ml.ok) {
      provado = await _provarCanalML(cn.itens, ml.seller_id);
    } else if (cn && cn.ok) {
      /* Codex #456 (P2): quando o token do ML falha ou o /users/me não responde, a prova nem
         CHEGA a rodar — e o diagnóstico ficava vazio justamente no caso mais comum, que é
         token expirado ou app sem permissão. O silêncio aqui é pior que nos outros, porque o
         dono lê "não consegui provar" e não tem o que investigar. */
      _diagProva = [{
        leia: 'a prova não chegou a rodar porque a identidade no ML falhou antes',
        identidade_ml: (ml && (ml.erro || ml.leia)) || 'recurso mercado_livre indisponível',
      }];
    }
    if (cn && cn.ok) for (const c of cn.itens) { delete c._amostra; delete c._idPedido; }   // ruído pro leitor
    if (cfg.envNomes) {
      saida.sugestao = _sugerirEnvs(cfg.envNomes, (st && st.ok) ? st.itens : [], (cn && cn.ok) ? cn.itens : [], provado);
      /* quando a prova não sai, o retorno precisa dizer O QUE o ML respondeu — sem isso, o
         "não consegui provar" é uma parede: ninguém sabe se é token, permissão ou o número
         do pedido não ser o que o ML espera. */
      if (!provado && _diagProva.length) saida.sugestao.por_que_nao_provei = _diagProva;
    }
    return saida;
  }

  return { descobrir, RECURSOS };
}

module.exports = { criar, RECURSOS };
