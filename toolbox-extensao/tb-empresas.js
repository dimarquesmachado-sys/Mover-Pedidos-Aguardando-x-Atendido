/* Toolbox — A FICHA DAS EMPRESAS (2.1.20, V-09 do roteiro de liquidação do Devoluções).

   Até a 2.1.19 a lista das empresas estava FECHADA EM TRÊS, repetida em oito mapas espalhados pela
   extensão (popup.js, tb-acoes.js, central.html, popup.html, bg-devolucoes.js, bg-situacao.js,
   bg-coleta.js, shopee.js, respostas.js, ct-nf.js…). Foi assim que a Girassol entrou na ponte de
   Devoluções em 28/09 e ficou DOIS DIAS sem aparecer no menu (30/09): cada mapa era um lugar pra
   esquecer. Uma quarta empresa teria que caçar os oito.

   Daqui em diante a lista é ESTA, e só esta. Empresa nova = uma entrada aqui (e a mesma no
   contrato-empresas.json dos dois repos — o teste scripts/teste-toolbox-ficha-empresas.js confere
   que as duas listas batem e que nenhum outro arquivo da extensão voltou a ter mapa próprio).

   Campos:
   · nome / curto      — como aparece na Central e no menu;
   · emoji             — o ícone do botão de escolha da instalação;
   · canonico          — o id do contrato-empresas.json (a AMB é `amb` aqui por histórico e `ambtotal` lá);
   · aliases           — os outros nomes pelos quais a empresa chega (os mesmos `aliases` do contrato);
   · checkout          — a pasta do checkout offline no Mover-Pedidos (/<checkout>/...);
   · devolucoes        — o prefixo da empresa no Devoluções ('' = raiz, que é a GOOD; ⚠️ com barra no fim ao montar link);
   · fiscal            — o prefixo do módulo fiscal (NF em "Consultar situação") no Mover-Pedidos;
   · respostas         — { loja, instancia }: o id MAIÚSCULO que o servidor das Respostas Rápidas usa e o caminho do painel;
   · sem               — módulos que esta empresa NÃO tem no servidor (lista curta; o padrão é ter tudo —
                         nivelar por cima: módulo novo entra pra todas, salvo quem declarar aqui que não tem).
   Ids de módulo usados em `sem`: 'mm' (Etiquetas Madeira Madeira), 'bling' (Cookie Bling pro importador de
   NF do Magalu Full), 'mlfull' (NF-e Fulfillment Magalu+Shopee dentro do Bling), 'esteira' (Esteira de
   preços em produtos.php). */
'use strict';
const TB_EMPRESAS = {
  girassol: { nome: 'Magazine Girassol', curto: 'Girassol', emoji: '🌻', canonico: 'girassol', aliases: ['gira'], checkout: 'girassol-backup-offline', devolucoes: '/girassol', fiscal: '', respostas: { loja: 'GIRASSOL', instancia: 'girassol' }, sem: ['bling', 'mlfull'] },
  good:     { nome: 'GOOD Import',       curto: 'GOOD',     emoji: '📦', canonico: 'good',     aliases: ['gimpo'], checkout: 'good-checkout-offline',    devolucoes: '',          fiscal: '/good', respostas: { loja: 'GIMPO',    instancia: 'gimpo' },    sem: ['esteira'] },
  amb:      { nome: 'AMBTotal',          curto: 'AMBTotal', emoji: '🔧', canonico: 'ambtotal', aliases: ['ambtotal'], checkout: 'amb-checkout-offline',     devolucoes: '/amb',      fiscal: '/amb',  respostas: { loja: 'AMBTOTAL', instancia: 'ambtotal' }, sem: ['mm', 'esteira'] },
};
/* a ordem em que aparecem nas telas */
const TB_ORDEM = ['girassol', 'good', 'amb'];

/* a chave da ficha a partir de qualquer forma do nome ('amb', 'ambtotal', 'AMB ', 'gimpo'…); '' quando desconhecida */
function tbChave(emp) {
  const e = String(emp == null ? '' : emp).trim().toLowerCase();
  if (!e) return '';
  if (TB_EMPRESAS[e]) return e;
  for (const k of Object.keys(TB_EMPRESAS)) {
    const f = TB_EMPRESAS[k];
    if (f.canonico === e || (f.aliases || []).indexOf(e) !== -1 || (f.respostas && f.respostas.instancia === e)) return k;
  }
  return '';
}
function tbFicha(emp) { const k = tbChave(emp); return k ? TB_EMPRESAS[k] : null; }
function tbEmpresas() { return TB_ORDEM.slice(); }
/* a empresa tem o módulo? (desconhecida = não tem nada) */
function tbTem(emp, modulo) { const f = tbFicha(emp); return !!f && (f.sem || []).indexOf(modulo) === -1; }
/* as empresas que têm o módulo, na ordem das telas */
function tbQuemTem(modulo) { return TB_ORDEM.filter((k) => tbTem(k, modulo)); }

if (typeof module !== 'undefined' && module.exports) module.exports = { TB_EMPRESAS, TB_ORDEM, tbChave, tbFicha, tbEmpresas, tbTem, tbQuemTem };
