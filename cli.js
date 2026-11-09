'use strict';

// ============================================================
// CLI:  node index.js [quantidade] [regiao]
//   node index.js            -> gera 1 conta (regiao BR)
//   node index.js 5          -> gera 5 contas
//   node index.js 3 BR       -> gera 3 contas na regiao BR
// Variaveis opcionais: NAME_PREFIX, PASS_PREFIX, PROXY_ENABLED, PROXY_HOST, PROXY_PORT, PROXY_USER, PROXY_PASS
// ============================================================
const { gerarUmaContaValida } = require('./gerador');

async function main() {
    const quantidade = Math.max(1, parseInt(process.argv[2], 10) || 1);
    const region = (process.argv[3] || process.env.REGION || 'BR').toUpperCase();
    const namePrefix = process.env.NAME_PREFIX || '';
    const passwordPrefix = process.env.PASS_PREFIX || '';
    const arquivo = require('path').join(__dirname, 'contas_geradas.txt');

    console.log(`[GERADOR] Gerando ${quantidade} conta(s) | regiao ${region}...`);
    let geradas = 0;
    for (let i = 1; i <= quantidade; i++) {
        const conta = await gerarUmaContaValida(region, namePrefix, passwordPrefix, 3);
        if (conta) {
            geradas++;
            require('fs').appendFileSync(arquivo, `${conta.uid}:${conta.password}\n`);
            console.log(`\n[${i}/${quantidade}] CONTA GERADA`);
            console.log(`  UID:    ${conta.uid}`);
            console.log(`  SENHA:  ${conta.password}`);
            console.log(`  NOME:   ${conta.name}`);
            console.log(`  FORMATO: ${conta.uid}:${conta.password}`);
        } else {
            console.log(`\n[${i}/${quantidade}] Falhou ao gerar conta (tente de novo ou configure proxy).`);
        }
    }
    console.log(`\n[GERADOR] Finalizado: ${geradas}/${quantidade} contas. Salvas em contas_geradas.txt`);
    process.exit(geradas > 0 ? 0 : 1);
}

main().catch((e) => { console.error('[ERRO]', e.message); process.exit(1); });
