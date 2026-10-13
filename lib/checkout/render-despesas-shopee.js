/* ═══ DESPESAS DA SHOPEE — peça compartilhada ════════════════════════════════════════════════
   Medido em `docs/duplicacao-telas-medida.md`: eram 90 linhas IDÊNTICAS na AMB e na Girassol.
   Extraível de verdade porque RECEBE o dado por parâmetro — ao contrário da `renderAnalise`, que
   lê o painel inteiro (767 identificadores externos).

   ⚠️ As dependências entram por PARÂMETRO, não por global:
     · `MOD`  — prefixo da empresa, monta os links `/ir-shopee` de cada pedido. Sem receber isso, a
                peça apontaria pro pedido da LOJA ERRADA, que é pior que link ausente;
     · `BRL`, `dBR`, `N` — formatadores da tela;
     · `MOTIVO_SHP`, `NOME_TIPO_SHP` — dicionários de rótulo da Shopee.

   A tela passa os seus; a peça não lê nada de fora. */
function desenharDespesasShopee(d, dep) {
  var MOD = dep.MOD, BRL = dep.BRL, dBR = dep.dBR, N = dep.N;
  var MOTIVO_SHP = dep.MOTIVO_SHP, NOME_TIPO_SHP = dep.NOME_TIPO_SHP;

  /* ⚠️ o ELEMENTO entra por parâmetro, como as outras dependências. Ler `document` aqui faria a
     peça só funcionar no navegador — e a checagem de órfãos pegou, com razão: este arquivo roda
     em Node no teste que compara a saída com a da tela. Quem chama passa o seu — sem fallback
     pro `document`, senão o arquivo volta a depender do navegador e a checagem acusa de novo. */
  const el = dep.el;
  if (!el) return;
  const cst = (d.carteira && d.carteira.custo_por_tipo) || {};
  const sai = (d.carteira && d.carteira.sai_do_bolso) || 0;
  const dev = d.devolucoes || {};
  const tipos = Object.keys(cst).sort((a2,b2)=>cst[b2]-cst[a2]);
  let h = '<div style="display:flex;gap:8px;flex-wrap:wrap">'+
    tipos.map(function(k){
      return '<div class="miniTot" style="background:var(--card);border:1px solid var(--line);border-radius:9px;padding:7px 11px" title="'+k+'">'+
             '<div class="mut" style="font-size:9.5px;text-transform:uppercase;letter-spacing:.03em">'+(NOME_TIPO_SHP[k]||k)+'</div>'+
             '<div style="font-weight:800;font-size:13px;color:#f87171">'+BRL(cst[k])+'</div></div>';
    }).join('')+
    '<div class="miniTot" style="background:var(--card);border:1px solid var(--line);border-radius:9px;padding:7px 11px" title="Shopee Ads no per\u00edodo — mesma r\u00e9gua do painel da Shopee (venda AMPLA: qualquer produto comprado depois do clique). \u00c9 CONSUMO de cr\u00e9dito, n\u00e3o desembolso: o que sai do bolso aparece na carteira como recarga (SPM_DEDUCT) e j\u00e1 est\u00e1 no \u2211 acima">'+
      '<div class="mut" style="font-size:9.5px;text-transform:uppercase;letter-spacing:.03em">\ud83d\udce3 Ads (consumo)</div>'+
      '<div style="font-weight:800;font-size:13px">'+BRL((d.ads&&d.ads.gasto)||0)+'</div></div>'+
    ((d.ads&&d.ads.gasto)>0 ? '<div class="miniTot" style="background:var(--card);border:1px solid var(--line);border-radius:9px;padding:7px 11px" title="vendas atribu\u00eddas aos an\u00fancios / gasto — igual ao painel da Shopee">'+
      '<div class="mut" style="font-size:9.5px;text-transform:uppercase;letter-spacing:.03em">\ud83c\udfaf ROAS</div>'+
      '<div style="font-weight:800;font-size:13px" class="ok">'+((d.ads.roas!=null?d.ads.roas:0))+'\u00d7 \u00b7 '+BRL(d.ads.vendas||d.ads.gmv_amplo||0)+'</div></div>' : '')+
    '<div class="miniTot" style="background:var(--bg2);border:1px solid var(--line2);border-radius:9px;padding:7px 11px" title="tudo que a Shopee tirou da carteira e que N\u00c3O \u00e9 saque nem renda de pedido">'+
      '<div class="mut" style="font-size:9.5px;text-transform:uppercase;letter-spacing:.03em">\u2211 sai do bolso</div>'+
      '<div style="font-weight:800;font-size:13px" class="'+(sai>0?'bad':'ok')+'">'+BRL(sai)+'</div></div>'+
    '<div class="miniTot" style="background:var(--card);border:1px solid var(--line);border-radius:9px;padding:7px 11px" title="quantas devolu\u00e7\u00f5es e quanto foi devolvido ao comprador no per\u00edodo">'+
      '<div class="mut" style="font-size:9.5px;text-transform:uppercase;letter-spacing:.03em">\u21a9\ufe0f Devolu\u00e7\u00f5es</div>'+
      '<div style="font-weight:800;font-size:13px">'+N(dev.quantidade||0)+' \u00b7 '+BRL(dev.valor_devolvido||0)+'</div></div>'+
    '</div>';
  const mot = dev.por_motivo || {};
  const motOrd = Object.keys(mot).sort((a2,b2)=>mot[b2]-mot[a2]);
  if(motOrd.length) h += '<div class="mut" style="font-size:11px;margin-top:8px">por que voltou: '+
    motOrd.map(k=> '<b>'+N(mot[k])+'</b> '+(MOTIVO_SHP[k]||k)).join(' \u00b7 ')+'</div>';
  // 14/08 — a tabela mostrava só "R$ devolvido", que é o PREÇO reembolsado ao comprador e
  // NÃO o custo da loja (parte a Shopee banca). Medido: R$ 5.249 devolvidos × R$ 1.653 de
  // custo real no mesmo período. Agora as duas colunas aparecem, e o % passa a ser do CUSTO,
  // que é o que decide onde mexer.
  const sk = (dev.por_sku||[]).slice(0,10);
  if(sk.length){
    const temCusto = sk.some(function(s){ return Number(s.custo_real)>0; });
    const totCusto = Number(dev.custo_real_na_carteira||0) || 1;
    const tot = (dev.valor_devolvido||0) || 1;
    h += '<table style="width:100%;margin-top:10px;font-size:12px"><thead><tr>'+
      '<th style="text-align:left">SKU que mais voltou</th><th style="text-align:right">un.</th>'+
      '<th style="text-align:right" title="preço reembolsado ao comprador — parte disso a Shopee banca">R$ devolvido</th>'+
      (temCusto? '<th style="text-align:right" title="o que a Shopee debitou de VOC\u00ca por essa devolu\u00e7\u00e3o (inclui o frete de retorno). \u00c9 este o preju\u00edzo">\ud83d\udcb8 custo real</th>':'')+
      '<th style="text-align:right">% do total</th></tr></thead><tbody>'+
      sk.map(function(s){
        const cr = Number(s.custo_real)||0;
        const pct = temCusto ? (cr/totCusto*100) : (s.valor/tot*100);
        return '<tr><td title="'+(s.nome||'').replace(/"/g,'')+'">'+s.sku+'</td>'+
               '<td style="text-align:right">'+N(s.qtd)+'</td>'+
               '<td style="text-align:right" class="mut">'+BRL(s.valor)+'</td>'+
               (temCusto? '<td style="text-align:right;color:#f87171;font-weight:700">'+BRL(cr)+'</td>':'')+
               '<td style="text-align:right" class="mut">'+(Math.round(pct*10)/10)+'%</td></tr>';
      }).join('')+
      (temCusto? '<tfoot><tr style="border-top:1px solid var(--line2)">'+
        '<td style="padding-top:6px"><b>total das devolu\u00e7\u00f5es do per\u00edodo</b></td><td></td>'+
        '<td style="text-align:right" class="mut">'+BRL(dev.valor_devolvido||0)+'</td>'+
        '<td style="text-align:right;color:#f87171;font-weight:800">'+BRL(dev.custo_real_na_carteira||0)+'</td>'+
        '<td></td></tr></tfoot>':'')+
      '</tbody></table>'+
      (temCusto? '<div class="mut" style="font-size:10.5px;margin-top:5px">\u201cR$ devolvido\u201d \u00e9 o pre\u00e7o que voltou pro comprador; \u201ccusto real\u201d \u00e9 o que a Shopee tirou da sua carteira (com o frete de retorno dentro). O % \u00e9 sobre o custo.'+
        ((Math.abs((Number(dev.custo_real_na_carteira)||0) - (Number((d.carteira&&d.carteira.custo_por_tipo&&(d.carteira.custo_por_tipo.ADJUSTMENT_FOR_RR_AFTER_ESCROW_VERIFIED||0)))||0)) > 1)
          ? ' <b>Aten\u00e7\u00e3o:</b> este total conta as devolu\u00e7\u00f5es ABERTAS no per\u00edodo, com o d\u00e9bito onde quer que a Shopee o tenha lan\u00e7ado (\u00e0s vezes no m\u00eas seguinte). O \u201cestorno\u201d l\u00e1 em cima soma s\u00f3 os d\u00e9bitos lan\u00e7ados DENTRO do per\u00edodo \u2014 por isso os dois n\u00fameros podem diferir.'
          : '')+'</div>':'');
  }
  // 14/08 (Diego): tabela com o N\u00daMERO DA VENDA tamb\u00e9m na Shopee, como no card do ML —
  // o link passa pela rota /ir-shopee, que resolve o id interno do pedido no Seller Center.
  const mai = (dev.maiores||[]).slice(0,20);
  if(mai.length){
    h += '<div class="mut" style="font-size:11px;margin-top:10px">devolu\u00e7\u00f5es do per\u00edodo \u2014 clique no n\u00famero pra abrir o pedido na Shopee</div>'+
      '<table style="width:100%;margin-top:4px;font-size:12px"><thead><tr>'+
      '<th style="text-align:left">pedido</th><th style="text-align:left">SKU</th>'+
      '<th style="text-align:left">motivo</th><th style="text-align:left">status</th>'+
      '<th style="text-align:right">R$ devolvido</th><th style="text-align:right">custo real</th></tr></thead><tbody>'+
      mai.map(function(x){
        const sn = String(x.order_sn||'');
        const link = sn ? '<a href="'+MOD+'/ir-shopee?sn='+encodeURIComponent(sn)+'" target="_blank" rel="noopener" style="color:#38bdf8;text-decoration:none">'+sn+' \u2197</a>' : '<span class="dim">\u2014</span>';
        return '<tr><td>'+link+'</td>'+
          '<td>'+(x.sku||'<span class="dim">\u2014</span>')+'</td>'+
          '<td class="mut" title="'+String(x.texto||'').replace(/"/g,'')+'">'+(MOTIVO_SHP[x.motivo]||x.motivo||'')+'</td>'+
          '<td class="mut">'+(x.status||'')+(x.parcial?' \u00b7 parcial':'')+'</td>'+
          '<td style="text-align:right" class="mut">'+BRL(x.valor||0)+'</td>'+
          '<td style="text-align:right'+((x.custo_real||0)>0?';color:#f87171;font-weight:700':'')+'">'+BRL(x.custo_real||0)+'</td></tr>';
      }).join('')+'</tbody></table>'+
      '<div class="mut" style="font-size:10.5px;margin-top:4px">passe o mouse no motivo pra ler o que o comprador escreveu.</div>';
  }
  if(Number(dev.canceladas_fora_da_conta)>0){
    h += '<div class="mut" style="font-size:10.5px;margin-top:4px">'+N(dev.canceladas_fora_da_conta)+' devolu\u00e7\u00e3o(\u00f5es) cancelada(s) pela Shopee ficaram FORA da conta (custo zero).</div>';
  }
  const at = (d.atualizado && (d.atualizado.carteira || d.atualizado.devolucoes)) || null;
  if(at) h += '<div class="mut" style="font-size:10px;margin-top:5px">Shopee atualizada em '+dBR(String(at).slice(0,10))+'</div>';
  el.innerHTML = h;
}

/* ⚠️ A MESMA função serve aos DOIS mundos, e é de propósito: o teste roda ela em Node pra
   comparar com a tela, e o navegador recebe o MESMO texto por `scriptDasDespesas`. Se fossem duas
   cópias, o teste provaria uma coisa e o dono veria outra — que é o buraco que esta extração
   existe pra fechar. */
function scriptDasDespesas() {
  return '(function(){\n' +
         desenharDespesasShopee.toString() + '\n' +
         'window.desenharDespesasShopee = desenharDespesasShopee;\n' +
         '})();';
}

module.exports = { desenharDespesasShopee, scriptDasDespesas };
