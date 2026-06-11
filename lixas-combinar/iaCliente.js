'use strict';

/**
 * iaCliente.js — Cliente Anthropic API pra interpretar respostas A COMBINAR
 *
 * Usa Claude Sonnet 4.5 com system prompt RESTRITIVO ao tema lixas+graos.
 *
 * Resposta do Claude vem em JSON estruturado:
 *   {
 *     categoria: "claro" | "ambiguo" | "pergunta_graos" | "fora_escopo",
 *     confianca: 0-100,
 *     interpretacao: "explicacao curta do que cliente quer",
 *     pedido_estruturado: [{grao: "24", quantidade: 30}, ...] (se claro),
 *     msg_pra_cliente: "texto resposta IA (max 350 chars)" (se categoria != fora_escopo)
 *   }
 */

const MODELO = process.env.LIXAS_IA_MODELO || 'claude-sonnet-4-5';
const API_KEY_VAR = process.env.LIXAS_IA_API_KEY_VAR || 'ANTHROPIC_API_KEY_LIXAS_IA';
const TIMEOUT_MS = 30000;
const MAX_TOKENS = 800;

function configurado() {
  const key = process.env[API_KEY_VAR];
  return !!(key && key.startsWith('sk-ant-'));
}

function montarSystemPrompt({ descricaoProduto, totalLixas, unidadesPorPacote, graosDisponiveis }) {
  return `Voce eh assistente de atendimento da Magazine Girassol no Mercado Livre, especializado em vendas de lixas A COMBINAR.

CONTEXTO DA VENDA ATUAL:
- Produto: ${descricaoProduto}
- Total comprado: ${totalLixas} lixas
- Cliente deve escolher quantidades em MULTIPLOS DE ${unidadesPorPacote}
- Graos disponiveis em estoque AGORA: ${graosDisponiveis.join(', ')}
- Soma das quantidades escolhidas deve dar EXATAMENTE ${totalLixas} lixas

IMPORTANTE - CONTEXTO DA CONVERSA:
Voce vera o HISTORICO da conversa. Use-o para interpretar mensagens curtas ou ambiguas
do cliente. Por exemplo, se a loja perguntou "quantos de cada grao?" e o cliente
respondeu "20 de cada", junte com os graos que JA foram mencionados pela loja ou cliente
anteriormente. Cliente curto eh normal — interprete usando contexto.

SUA UNICA TAREFA:
Interpretar a ULTIMA mensagem do cliente sobre QUAIS graos e QUANTAS lixas de cada quer.
Considere TODO o historico ao interpretar.

CLASSIFIQUE em UMA destas 4 categorias:

1. "claro" - Em QUALQUER um destes dois casos, com pedido_estruturado valido
   (todos os graos da lista de disponiveis, todas as quantidades multiplas de
   ${unidadesPorPacote}, e soma EXATAMENTE ${totalLixas}):

   CASO A — cliente especificou tudo: disse a quantidade de cada grao e ja fecha ${totalLixas}.
     Ex: "30 do 24 e 70 do 80" (30+70=${totalLixas} ✅)
     Ex: "20 de cada" apos loja listar 5 graos = 5×20=${totalLixas} ✅

   CASO B — cliente pediu VARIEDADE / UNIFORME e voce completa: quando ele sinaliza
     "variado", "um pouco de cada", "voce escolhe", "surpresa", OU pede "X de cada"
     mas isso nao fecha ${totalLixas}. Aqui VOCE PODE montar/completar a distribuicao
     pelos graos DISPONIVEIS, em multiplos de ${unidadesPorPacote}, ate somar ${totalLixas}.
     Ex: "10 de cada" em 8 graos = 80; voce distribui as 20 que faltam nos graos e fecha 100 ✅
     Ex: "manda variado" -> voce monta uma combinacao equilibrada que soma ${totalLixas} ✅
     IMPORTANTE: so use o CASO B quando o cliente sinaliza variedade OU dá um pedido
     uniforme ("X de cada"). Se ele deu quantidades ESPECIFICAS e DIFERENTES por grao
     que nao fecham (ex: 40+40+10+10+10=110), NAO complete nem corte: isso eh "ambiguo".

   AÇÃO: Confirme de forma DECLARATIVA que o pedido foi registrado e JA VAI SEGUIR,
   listando EXATAMENTE os itens (inclusive os que voce completou no caso B), e ENCERRE
   avisando da postagem. NAO pergunte se esta correto, NAO convide a mudar, NAO termine
   com pergunta. Se houver muitos itens, abrevie (ex: "10x grão 40") pra caber nos 350 chars.
   Ex de tom: "Olá! Pedido confirmado: [itens] — total ${totalLixas} lixas. Será postado em breve e todo rastreamento da entrega você acompanha dentro da sua compra no MercadoLivre. Obrigado! 😊"

2. "ambiguo" - Use APENAS quando NAO der pra resolver sozinho:
   - cliente listou graos mas SEM quantidade nenhuma e SEM sinal de variedade; OU
   - cliente deu quantidades ESPECIFICAS e DIFERENTES por grao que nao fecham
     ${totalLixas} (nesse caso NAO complete nem corte — peça o ajuste); OU
   - alguma quantidade NAO eh multiplo de ${unidadesPorPacote} (nao da meio pacote).
   Ex: "40 60 80 100 150" SEM contexto previo de loja sugerindo qtds
   Ex: "40 do 120, 40 do 240, 10 do 320, 10 do 400, 10 do 1500" (=110, especifico e nao fecha)
   Ex: "5 do 400 e 5 do 1500" (5 nao eh multiplo de ${unidadesPorPacote})
   AÇÃO: Peça/ajuste de forma clara, com exemplo. Se for nao-multiplo de ${unidadesPorPacote},
   explique que as quantidades precisam ser multiplas de ${unidadesPorPacote}.

3. "pergunta_graos" - Cliente esta perguntando QUAIS graos estao disponiveis
   Ex: "quais graos vcs tem?"
   Ex: "tem grão 80?"
   AÇÃO: Liste os graos disponiveis e oriente como escolher.

4. "fora_escopo" - QUALQUER outro assunto (preço, desconto, frete, troca, garantia, outros produtos, reclamacao, agradecimento simples, etc)
   AÇÃO: NAO responda nada. Marque como escalonamento humano.

REGRAS RIGIDAS:
- NUNCA invente graos que nao estao na lista de disponiveis
- Voce PODE completar/montar a distribuicao quando o cliente pede VARIEDADE ou um
  pedido UNIFORME ("X de cada") que nao fecha — sempre em multiplos de ${unidadesPorPacote}
  e somando EXATAMENTE ${totalLixas}, usando so graos disponiveis.
- NUNCA sobrescreva quantidades ESPECIFICAS que o cliente deu: se ele detalhou
  quantidades diferentes por grao e nao fecha, eh "ambiguo" e voce PERGUNTA — nao corta nem completa.
- NUNCA classifique como "claro" se o pedido_estruturado final nao somar EXATAMENTE ${totalLixas}
  com todos os graos disponiveis e todas as quantidades multiplas de ${unidadesPorPacote}.
- NUNCA prometa desconto, frete gratis, brinde, ou qualquer condicao comercial
- NUNCA fale de outros produtos da loja
- NUNCA peça dados pessoais (CPF, telefone, endereco)
- Mensagem pro cliente: max 350 caracteres, com acentos, tom cordial
- Use "Olá!" no inicio, assinatura sutil (sem emojis demais, max 1)
- Ao confirmar pedido CLARO, LISTE os itens entendidos de forma DECLARATIVA. O pedido segue direto: NUNCA pergunte "está correto?", NUNCA convide o cliente a mudar, NUNCA termine a confirmacao com pergunta

FORMATO DE RESPOSTA (JSON puro, sem markdown, sem comentario):
{
  "categoria": "claro" | "ambiguo" | "pergunta_graos" | "fora_escopo",
  "confianca": 0-100,
  "interpretacao": "frase curta explicando o que cliente quer",
  "pedido_estruturado": [{"grao": "24", "quantidade": 30}] ou null,
  "msg_pra_cliente": "texto resposta" ou null se fora_escopo
}`;
}

/**
 * Interpreta a mensagem do cliente usando Claude API.
 * Retorna o JSON estruturado.
 *
 * @param {string} mensagemCliente - ultima mensagem do cliente (foco)
 * @param {Array}  historicoConversa - opcional: [{role:'seller'|'buyer', text}, ...] para contexto
 */
async function interpretarRespostaCliente({
  mensagemCliente,
  descricaoProduto,
  totalLixas,
  unidadesPorPacote,
  graosDisponiveis,
  historicoConversa
}) {
  if (!configurado()) {
    return { ok: false, erro: 'IA nao configurada (env ANTHROPIC_API_KEY_LIXAS_IA ausente)' };
  }
  if (!mensagemCliente) {
    return { ok: false, erro: 'mensagem do cliente vazia' };
  }

  const apiKey = process.env[API_KEY_VAR];
  const systemPrompt = montarSystemPrompt({
    descricaoProduto, totalLixas, unidadesPorPacote, graosDisponiveis
  });

  // Monta texto da mensagem do user com historico (se disponivel) + msg atual
  let userText = '';
  if (Array.isArray(historicoConversa) && historicoConversa.length > 0) {
    userText += 'HISTORICO DA CONVERSA (mais antiga primeiro):\n';
    for (const m of historicoConversa) {
      const quem = m.role === 'seller' ? 'Loja' : 'Cliente';
      userText += `${quem}: "${m.text}"\n`;
    }
    userText += '\n';
  }
  userText += `ULTIMA MENSAGEM DO CLIENTE (foco da interpretacao):\n"""${mensagemCliente}"""\n\nAnalise considerando o historico e responda em JSON puro.`;

  const body = {
    model: MODELO,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [
      { role: 'user', content: userText }
    ]
  };

  const controller = new AbortController();
  const tId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(tId);

    const data = await r.json();
    if (!r.ok) {
      return { ok: false, erro: `Anthropic HTTP ${r.status}: ${JSON.stringify(data).slice(0, 300)}` };
    }

    // Resposta vem em data.content[].text
    const textoCompleto = (data.content || [])
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');

    // Tenta parsear JSON. Pode vir com markdown ```json ... ``` ou puro.
    let cleaned = textoCompleto.trim();
    cleaned = cleaned.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/```\s*$/, '');

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return {
        ok: false,
        erro: 'IA nao retornou JSON valido',
        raw: textoCompleto.slice(0, 500)
      };
    }

    // Validacoes basicas
    const categoriasValidas = ['claro', 'ambiguo', 'pergunta_graos', 'fora_escopo'];
    if (!categoriasValidas.includes(parsed.categoria)) {
      return {
        ok: false,
        erro: `categoria invalida: ${parsed.categoria}`,
        raw: parsed
      };
    }

    // msg_pra_cliente max 350 chars (validacao extra)
    if (parsed.msg_pra_cliente && parsed.msg_pra_cliente.length > 350) {
      console.warn(`[ia] msg_pra_cliente ultrapassou 350 chars (${parsed.msg_pra_cliente.length}) — truncando`);
      parsed.msg_pra_cliente = parsed.msg_pra_cliente.slice(0, 347) + '...';
    }

    return {
      ok: true,
      ...parsed,
      _modelo: MODELO,
      _tokens_in: data.usage?.input_tokens,
      _tokens_out: data.usage?.output_tokens
    };
  } catch (e) {
    clearTimeout(tId);
    return { ok: false, erro: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════════
// MULTI-KIT (dormente ate o fluxos ligar): carrinho com 2+ anuncios
// A COMBINAR diferentes (ex: kit 5pol lisa + kit 7pol furos).
// A funcao single-kit acima permanece INTOCADA.
// ═══════════════════════════════════════════════════════════════════

function montarSystemPromptMulti({ kits }) {
  // kits: [{ sku, descricaoProduto, totalLixas, unidadesPorPacote, graosDisponiveis }]
  const blocosKits = kits.map((k, i) => `
KIT ${i + 1} — "${k.descricaoProduto}" (sku interno: ${k.sku})
- Total comprado NESTE kit: ${k.totalLixas} lixas
- Quantidades em MULTIPLOS DE ${k.unidadesPorPacote}
- Graos disponiveis NESTE kit: ${k.graosDisponiveis.join(', ')}
- Soma das quantidades DESTE kit deve dar EXATAMENTE ${k.totalLixas} lixas`).join('\n');

  return `Voce eh atendente de pos-venda de uma loja de lixas no Mercado Livre.
O cliente comprou ${kits.length} KITS DIFERENTES de lixas "A COMBINAR" na MESMA compra,
e precisa informar a combinacao de graos DE CADA KIT.

${blocosKits}

SUA TAREFA: interpretar a resposta do cliente e montar o pedido DE CADA KIT.

CLASSIFIQUE em UMA destas 4 categorias (a categoria eh GLOBAL, do conjunto):

1. "claro" - SOMENTE quando TODOS os kits ficam resolvidos, cada um com pedido
   valido (graos da lista DAQUELE kit, quantidades multiplas DAQUELE kit, soma
   EXATAMENTE o total DAQUELE kit). Valem as mesmas regras do atendimento:
   - cliente especificou tudo de um kit -> ok;
   - cliente pediu VARIEDADE/"X de cada" num kit que nao fecha -> voce PODE
     completar a distribuicao DAQUELE kit ate fechar o total dele;
   - se o cliente nao disser a qual kit pertence uma lista, use o bom senso
     (tamanho/polegadas citados, ordem das listas, graos que so existem num kit).
     So assuma se a atribuicao for INEQUIVOCA — na duvida, eh "ambiguo".
   ACAO: confirmacao DECLARATIVA por kit, ABREVIADA pra caber em 350 chars.
   Formato: "Olá! Confirmado — Kit 5pol: 30x g40, 70x g80. Kit 7pol: 20x g100, 80x g240. Será postado em breve e todo rastreamento da entrega você acompanha dentro da sua compra no MercadoLivre. Obrigado! 😊"
   NUNCA pergunte "esta correto?", NUNCA convide a mudar, NUNCA termine com pergunta.

2. "ambiguo" - Qualquer kit sem resolucao: faltou a lista de um kit, quantidades
   especificas que nao fecham o total daquele kit (NAO complete nem corte),
   quantidade que nao eh multiplo daquele kit, grao inexistente naquele kit, ou
   nao da pra saber qual lista eh de qual kit.
   ACAO: pergunte SO o que falta, identificando o kit pelo nome (ex: "Pro kit de
   7 polegadas, faltou..."). Se um kit ja fechou, DIGA que ele esta ok e peca so o outro.

3. "pergunta_graos" - Cliente pergunta quais graos tem disponiveis (de um ou de todos).
   ACAO: responda os graos do(s) kit(s) perguntado(s), identificando cada um.

4. "fora_escopo" - Assunto nao relacionado a escolha de graos (frete, prazo, cancelamento).
   ACAO: nao responda; deixe pro humano.

REGRAS RIGIDAS:
- NUNCA invente graos fora da lista DO KIT correspondente
- NUNCA misture: cada quantidade pertence a UM kit; a soma de CADA kit fecha o total DELE
- Voce PODE completar distribuicao num kit quando o cliente pedir variedade/"X de cada" NAQUELE kit
- NUNCA sobrescreva quantidades especificas que o cliente deu
- NUNCA classifique "claro" se QUALQUER kit nao fechar exatamente
- Mensagem pro cliente: max 350 caracteres, cordial, "Olá!" no inicio, max 1 emoji

FORMATO DE RESPOSTA (JSON puro, sem markdown):
{
  "categoria": "claro" | "ambiguo" | "pergunta_graos" | "fora_escopo",
  "confianca": 0-100,
  "interpretacao": "frase curta",
  "pedidos_por_kit": [{"sku": "<sku interno do kit>", "itens": [{"grao": "24", "quantidade": 30}]}] ou null,
  "msg_pra_cliente": "texto" ou null
}
"pedidos_por_kit" so quando "claro": UM objeto por kit, TODOS os kits presentes, sku EXATO como informado.`;
}

/**
 * MULTI-KIT: interpreta a resposta do cliente pra 2+ kits A COMBINAR.
 * Mesma API/modelo/parse da single-kit. Retorna { ok, categoria, confianca,
 * interpretacao, pedidos_por_kit, msg_pra_cliente, ... }.
 */
async function interpretarRespostaClienteMultiKit({ mensagemCliente, kits, historicoConversa }) {
  if (!configurado()) {
    return { ok: false, erro: 'IA nao configurada (env ANTHROPIC_API_KEY_LIXAS_IA ausente)' };
  }
  if (!mensagemCliente) return { ok: false, erro: 'mensagem do cliente vazia' };
  if (!Array.isArray(kits) || kits.length < 2) {
    return { ok: false, erro: 'multi-kit requer 2+ kits (use interpretarRespostaCliente pra 1)' };
  }

  const apiKey = process.env[API_KEY_VAR];
  const systemPrompt = montarSystemPromptMulti({ kits });

  let userText = '';
  if (Array.isArray(historicoConversa) && historicoConversa.length > 0) {
    userText += 'HISTORICO DA CONVERSA (mais antiga primeiro):\n';
    for (const m of historicoConversa) {
      const quem = m.role === 'seller' ? 'Loja' : 'Cliente';
      userText += `${quem}: "${m.text}"\n`;
    }
    userText += '\n';
  }
  userText += 'ULTIMA MENSAGEM DO CLIENTE (foco da interpretacao):\n"""' + mensagemCliente + '"""\n\nAnalise considerando o historico e responda em JSON puro.';

  const body = {
    model: MODELO,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: userText }]
  };

  const controller = new AbortController();
  const tId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(tId);

    const data = await r.json();
    if (!r.ok) {
      return { ok: false, erro: `Anthropic HTTP ${r.status}: ${JSON.stringify(data).slice(0, 300)}` };
    }

    const textoCompleto = (data.content || [])
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');

    let cleaned = textoCompleto.trim();
    cleaned = cleaned.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/```\s*$/, '');

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return { ok: false, erro: 'IA nao retornou JSON valido', raw: textoCompleto.slice(0, 500) };
    }

    const categoriasValidas = ['claro', 'ambiguo', 'pergunta_graos', 'fora_escopo'];
    if (!categoriasValidas.includes(parsed.categoria)) {
      return { ok: false, erro: `categoria invalida: ${parsed.categoria}`, raw: parsed };
    }

    // Validacao estrutural do claro multi-kit: TODOS os kits presentes, sku batendo
    if (parsed.categoria === 'claro') {
      const completo = Array.isArray(parsed.pedidos_por_kit)
        && parsed.pedidos_por_kit.length === kits.length
        && kits.every(k => parsed.pedidos_por_kit.some(p => String(p.sku) === String(k.sku) && Array.isArray(p.itens) && p.itens.length > 0));
      if (!completo) {
        return { ok: false, erro: 'claro multi-kit sem pedidos_por_kit completo (todos os kits + sku exato)', raw: parsed };
      }
    }

    if (parsed.msg_pra_cliente && parsed.msg_pra_cliente.length > 350) {
      console.warn(`[ia-multi] msg_pra_cliente ultrapassou 350 chars (${parsed.msg_pra_cliente.length}) — truncando`);
      parsed.msg_pra_cliente = parsed.msg_pra_cliente.slice(0, 347) + '...';
    }

    return {
      ok: true,
      ...parsed,
      _modelo: MODELO,
      _tokens_in: data.usage?.input_tokens,
      _tokens_out: data.usage?.output_tokens
    };
  } catch (e) {
    clearTimeout(tId);
    return { ok: false, erro: e.message };
  }
}

module.exports = {
  configurado,
  interpretarRespostaCliente,
  interpretarRespostaClienteMultiKit,
  MODELO
};
