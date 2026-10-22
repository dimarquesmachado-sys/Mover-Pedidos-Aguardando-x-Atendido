'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   FOTOS DOS PRODUTOS DO PAINEL (/produto-fotos) — peça única (20/10/2026, tela única).

   A rota existia em DUAS cópias: a da AMB (na pasta dela) e a da fábrica do painel (GOOD) — iguais a menos de três
   guardas de peça faltando e de uma linha que a fábrica ganhou (o cadastro escolhido entra primeiro e os demais do
   MESMO SKU vêm atrás). A Girassol NÃO tinha a rota: a tela única (lib/checkout/painel/dashboard.html) mostra a foto
   de cada produto no ranking, e a Girassol ficaria com a coluna vazia. Agora a rota nasce aqui (a versão da fábrica,
   a mais completa) e as três empresas a montam com as peças delas.
   ───────────────────────────────────────────────────────────────────────────── */

const path = require('path');

function criarRotaProdutoFotos(cfg) {
  const c = cfg || {};
  for (const k of ['PREFIXO', 'json', 'validarSessao', 'deps']) if (!c[k]) throw new Error('rota-produto-fotos: falta ' + k);
  const PREFIXO = c.PREFIXO, json = c.json, validarSessao = c.validarSessao;
  const FOTO_V = c.FOTO_V || 6;
  const semPeca = typeof c.semPeca === 'function' ? c.semPeca : (res, peca) => json(res, 200, { ok: false, erro: 'esta empresa ainda não tem a peça ' + peca });
  return async function rotaProdutoFotos(req, res, urlObj, method, p) {
    const { CACHE_DIR, blingGet, primeiraImagem, readJson, writeJson } = c.deps();

      if (method === 'GET' && p === (PREFIXO + '/produto-fotos')) {
        if (!blingGet) return semPeca(res, 'blingGet');
        if (!primeiraImagem) return semPeca(res, 'primeiraImagem');
        if (!FOTO_V) return semPeca(res, 'FOTO_V');
        // ?diag=SKU — mostra PASSO A PASSO o que o Bling devolveu pra esse SKU: se a busca
        // achou, qual o id, quais campos de imagem existem e o que o primeiraImagem extraiu.
        // Serve pra parar de supor: o print do Bling mostra foto, então o dado está lá — falta
        // saber em QUAL campo ele vem pros kits.
        /* 20/10: a sessão vale pra TUDO aqui, inclusive o ?diag= (que devolve dados do cadastro do Bling) — nas duas
           cópias antigas ele vinha antes da checagem e respondia sem login */
        const opF = validarSessao(req.headers['cookie']);
        if (!opF) { json(res, 401, { ok: false, erro: 'Sessão necessária. Faça login.' }); return true; }
        if (urlObj.searchParams && urlObj.searchParams.get('diag')) {
          const skD = String(urlObj.searchParams.get('diag') || '').trim();
          const outD = { sku: skD, passos: [] };
          try {
            const r1 = await blingGet('/produtos?codigo=' + encodeURIComponent(skD) + '&criterio=5&limite=10');
            const l1 = (r1.ok && r1.data && r1.data.data) || [];
            // lista TODOS os cadastros com esse código (multiloja duplica) e diz quem tem foto
            for (const c1 of l1.slice(0, 6)) {
              let i2 = primeiraImagem(c1), viaDetalhe = false;
              if (i2 == null && c1.id) {
                const dX = await blingGet('/produtos/' + c1.id);
                const pX = (dX.ok && dX.data && dX.data.data) || null;
                i2 = pX ? primeiraImagem(pX) : null; viaDetalhe = !!i2;
                if (pX && pX.midia && pX.midia.imagens) {
                  outD.passos.push({ passo: 'candidato ' + c1.id, codigo: c1.codigo, nome: String(c1.nome || '').slice(0, 60),
                    externas: (pX.midia.imagens.externas || []).length, internas: (pX.midia.imagens.internas || []).length,
                    imagensURL: (pX.midia.imagens.imagensURL || []).length, foto: i2 || null, via_detalhe: viaDetalhe });
                  continue;
                }
              }
              outD.passos.push({ passo: 'candidato ' + c1.id, codigo: c1.codigo, nome: String(c1.nome || '').slice(0, 60), foto: i2 || null, via_detalhe: viaDetalhe });
            }
            outD.passos.push({ passo: 'busca por codigo (criterio=5)', http: r1.status, achou: l1.length,
              id: l1[0] && l1[0].id, codigo: l1[0] && l1[0].codigo,
              campos: l1[0] ? Object.keys(l1[0]) : null,
              imagemURL: l1[0] && l1[0].imagemURL || null,
              primeiraImagem: l1[0] ? primeiraImagem(l1[0]) : null });
            if (!l1.length) {
              const r2 = await blingGet('/produtos?pesquisa=' + encodeURIComponent(skD) + '&limite=5');
              const l2 = (r2.ok && r2.data && r2.data.data) || [];
              outD.passos.push({ passo: 'busca livre (pesquisa=)', http: r2.status, achou: l2.length,
                codigos: l2.map(x => x && x.codigo) });
            }
            const mB2 = /^(\d+)\s*x\s*(.+)$/i.exec(skD);
            if (mB2) {
              const sb = mB2[2].trim();
              const rb2 = await blingGet('/produtos?codigo=' + encodeURIComponent(sb) + '&criterio=5&limite=1');
              const ib2 = (rb2.ok && rb2.data && rb2.data.data && rb2.data.data[0]) || null;
              let imb = ib2 ? primeiraImagem(ib2) : null;
              if (ib2 && imb == null) { const db2 = await blingGet('/produtos/' + ib2.id); const dd2 = (db2.ok && db2.data && db2.data.data) || null; if (dd2) imb = primeiraImagem(dd2); }
              outD.passos.push({ passo: 'SKU-BASE do kit', base: sb, achou: !!ib2, primeiraImagem: imb || null });
            }
            const idD = (l1[0] && l1[0].id) || null;
            if (idD) {
              const r3 = await blingGet('/produtos/' + idD);
              const d3 = (r3.ok && r3.data && r3.data.data) || null;
              outD.passos.push({ passo: 'detalhe /produtos/{id}', http: r3.status,
                tem_midia: !!(d3 && d3.midia),
                midia_chaves: d3 && d3.midia ? Object.keys(d3.midia) : null,
                imagens_chaves: d3 && d3.midia && d3.midia.imagens ? Object.keys(d3.midia.imagens) : null,
                midia_crua: d3 ? (d3.midia || null) : null,
                tem_estrutura: !!(d3 && d3.estrutura),
                componentes: d3 && d3.estrutura ? ((d3.estrutura.componentes || d3.estrutura.itens || []).length) : 0,
                primeiraImagem: d3 ? primeiraImagem(d3) : null });
            }
          } catch (e) { outD.erro = String(e.message || e).slice(0, 200); }
          json(res, 200, { ok: true, diagnostico: outD });
          return true;
        }
        const skusF = String(urlObj.searchParams.get('skus') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 60);
        const F_PROD_F = path.join(CACHE_DIR, '_prod_compra.json');
        const cacheF = readJson(F_PROD_F, {});
        const fotos = {}, faltando = [];
        for (const sk of skusF) {
          const c = cacheF[sk];
          if (c && c.img) fotos[sk] = c.img;
          // 11/08: só o carimbo da FOTO (`ts_img`) conta. Antes o `ts` do plano de compra
          // (que guarda saldo e podia ter img null) marcava o SKU como "já procurado" e o
          // kit ficava com 📦 pra sempre. Sem ts_img → tenta de novo.
          // 11/08 (2ª rodada): o carimbo `ts_img` de ANTES do conserto do primeiraImagem foi
          // gravado por uma versão que não sabia ler imagem INTERNA do Bling — os kits ficaram
          // marcados como "não tem foto" por 12h e o conserto não apareceria. Só vale o cache
          // gravado pela versão ATUAL (foto_v). Versão nova = tenta de novo, uma vez.
          else if (c && c.ts_img && c.foto_v === FOTO_V && (Date.now() - c.ts_img) < 12 * 3600 * 1000) fotos[sk] = null;
          else faltando.push(sk);
        }
        let buscadas = 0;
        for (const sk of faltando.slice(0, 16)) {
          try {
            // 1) pelo código exato — TODOS os cadastros, não só o primeiro.
            //    11/08: o Bling pode ter MAIS DE UM produto com o mesmo SKU (multiloja). O
            //    diagnóstico achou o id 16638636805 com mídia vazia, enquanto o cadastro que o
            //    Diego abre (16638891054) tem 4 imagens externas. Pegar "o primeiro" era sorteio.
            let rb = await blingGet('/produtos?codigo=' + encodeURIComponent(sk) + '&criterio=5&limite=10');
            let cands = (rb.ok && rb.data && rb.data.data) || [];
            let it0 = cands[0] || null;
            // 2) não achou pelo código? tenta a busca livre (SKU com variação, espaço, caixa diferente)
            if (!it0) {
              rb = await blingGet('/produtos?pesquisa=' + encodeURIComponent(sk) + '&limite=5');
              const lst = (rb.ok && rb.data && rb.data.data) || [];
              it0 = lst.find(x => String(x && x.codigo || '').trim().toUpperCase() === sk.toUpperCase()) || lst[0] || null;
              /* Codex #571: sem isto o laço de candidatos abaixo nunca rodava e o SKU recuperado pela
                 busca livre ficava com foto null por 12h — o inverso do que o fallback existe pra
                 fazer. Acha-se pelo código exato primeiro; senão o 1º resultado. */
              if (it0) cands = [it0].concat(lst.filter(x => x && x !== it0 && String(x.codigo || '').trim().toUpperCase() === sk.toUpperCase()));
            }
            let img = null, det = null;
            // 2) entre os candidatos, fica com o PRIMEIRO QUE TEM IMAGEM (na lista ou no detalhe)
            for (const c0 of cands.slice(0, 4)) {
              let i1 = primeiraImagem(c0);
              let d1 = null;
              if (i1 == null && c0 && c0.id) {
                const dd = await blingGet('/produtos/' + c0.id);
                d1 = (dd.ok && dd.data && dd.data.data) || null;
                if (d1) i1 = primeiraImagem(d1);
              }
              if (i1) { img = i1; it0 = c0; det = d1 || det; break; }
              if (!det) { it0 = it0 || c0; det = d1; }
              await new Promise(r => setTimeout(r, 240));
            }
            // 3) KIT sem foto própria: usa a foto do 1º COMPONENTE. No Bling o kit costuma
            //    não ter imagem — quem tem é o produto que o compõe (foi o caso dos 10x/7x/6x
            //    no TOP Produtos). Mesmo caminho que o custo do kit já usa (estrutura.componentes).
            if (it0 && img == null && det) {
              const comps = (det.estrutura && (det.estrutura.componentes || det.estrutura.itens)) || det.composicao || det.componentes || null;
              if (Array.isArray(comps) && comps.length) {
                for (const cp of comps.slice(0, 3)) {
                  const idc = (cp.produto && cp.produto.id) || cp.idProduto || cp.id || null;
                  if (!idc) continue;
                  const dc = await blingGet('/produtos/' + idc);
                  const pc = (dc.ok && dc.data && dc.data.data) || null;
                  const ic = pc ? primeiraImagem(pc) : null;
                  if (ic) { img = ic; break; }
                  await new Promise(r => setTimeout(r, 260));
                }
              }
            }
            // 4) [REMOVIDO em 11/08] Tentei cair pro SKU-BASE do kit (10xE14… → E14…), mas a
            //    foto do produto base é UMA lâmpada — e o kit de 9 aparecia com a foto de 1.
            //    Imagem errada é pior que imagem nenhuma: quem bate o olho no TOP Produtos
            //    confia no que vê. Sem foto, fica o 📦.
            //    O CAMINHO CERTO é encher a mídia no Bling: o diagnóstico provou que a API
            //    devolve `midia.imagens` VAZIA nesses kits (externas[], internas[], imagensURL[]),
            //    então nem existe imagem pra API entregar. O módulo /amb-drive-imagens envia
            //    URLs de imagem pro Bling (grava em `externas`) — feito isso, a foto aparece aqui
            //    sozinha, e será a foto CERTA do kit.
            fotos[sk] = img || null;
            const antes = cacheF[sk] || {};
            // ⚠️ (Codex PR#22) NÃO tocar no `ts` — ele é o carimbo do SALDO, lido pelo Plano de
            // Compra. Se esta rota (que NÃO consulta estoque) gravasse ts=agora com saldo null,
            // o plano confiaria no cache por 12h, leria saldo ausente como ZERO e mandaria
            // comprar a meta inteira de um produto cheio no estoque. A foto tem carimbo próprio.
            cacheF[sk] = Object.assign({}, antes, {
              img: img || null,
              nome: (it0 && it0.nome) || antes.nome || null,
              ts_img: Date.now(),
              foto_v: FOTO_V
            });
            buscadas++;
            await new Promise(r => setTimeout(r, 320));
          } catch (e) { fotos[sk] = null; }
        }
        if (buscadas) { try { writeJson(F_PROD_F, cacheF); } catch (e) {} }
        const restam = faltando.slice(12);
        json(res, 200, { ok: true, fotos, buscadas_agora: buscadas, faltando: restam });
        return true;
      }
    return false;
  };
}

module.exports = { criarRotaProdutoFotos };
