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

1. "claro" - Cliente especificou QUANTIDADES E GRAOS, soma confere ${totalLixas}
   Ex direto: "30 do 24 e 70 do 80" (30+70=${totalLixas} ✅)
   Ex contextual: cliente diz "20 de cada" apos loja listar 5 graos = 5×20=100 ✅
   AÇÃO: Confirme o pedido de forma amigavel, listando EXATAMENTE qual o pedido entendido.

2. "ambiguo" - Cliente listou graos mas SEM quantidades, ou quantidades nao fecham
   Ex: "40 60 80 100 150" SEM contexto previo de loja sugerindo qtds
   Ex: "20 do 24 e 30 do 80" (50 != ${totalLixas})
   AÇÃO: Peça as quantidades de forma clara, dando exemplo.

3. "pergunta_graos" - Cliente esta perguntando QUAIS graos estao disponiveis
   Ex: "quais graos vcs tem?"
   Ex: "tem grão 80?"
   AÇÃO: Liste os graos disponiveis e oriente como escolher.

4. "fora_escopo" - QUALQUER outro assunto (preço, desconto, frete, troca, garantia, outros produtos, reclamacao, agradecimento simples, etc)
   AÇÃO: NAO responda nada. Marque como escalonamento humano.

REGRAS RIGIDAS:
- NUNCA invente graos que nao estao na lista de disponiveis
- NUNCA prometa desconto, frete gratis, brinde, ou qualquer condicao comercial
- NUNCA fale de outros produtos da loja
- NUNCA peça dados pessoais (CPF, telefone, endereco)
- Mensagem pro cliente: max 350 caracteres, com acentos, tom cordial
- Use "Olá!" no inicio, assinatura sutil (sem emojis demais, max 1)
- Ao confirmar pedido CLARO, LISTE os itens entendidos para o cliente verificar

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

module.exports = {
  configurado,
  interpretarRespostaCliente,
  MODELO
};
