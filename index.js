'use strict';
// Site gerador de contas FF.  Uso:  node index.js
// Abre o site no seu PC e cria um link publico (Cloudflare) para qualquer pessoa acessar.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { gerarUmaContaValida } = require('./gerador');

// ---------------- CONFIG (pode mudar por variavel de ambiente) ----------------
const PORT = parseInt(process.env.PORT, 10) || 3000;
const SITE_SENHA = process.env.SITE_SENHA || '';                          // vazio = qualquer um usa
const MAX_POR_PEDIDO = parseInt(process.env.MAX_POR_PEDIDO, 10) || 1;     // contas por clique
const COOLDOWN_S = process.env.COOLDOWN_S !== undefined ? parseInt(process.env.COOLDOWN_S, 10) : 60; // espera por IP
const MAX_SIMULTANEOS = parseInt(process.env.MAX_SIMULTANEOS, 10) || 2;   // geracoes ao mesmo tempo
const USAR_TUNEL = (process.env.TUNEL || 'on') !== 'off';
const REGIOES = ['BR', 'ME', 'IND', 'ID', 'VN', 'TH', 'BD', 'PK', 'TW', 'CIS', 'SAC'];
const ARQUIVO = path.join(__dirname, 'contas_geradas.txt');

// ---------------- ESTADO ----------------
const jobs = new Map();       // id -> { status, total, contas[], falhas, criadoEm }
const ultimoPedido = new Map(); // ip -> timestamp
let ativos = 0;

const ipDe = (req) =>
    req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

async function executarJob(id, quantidade, regiao) {
    const job = jobs.get(id);
    ativos++;
    try {
        for (let i = 0; i < quantidade; i++) {
            const conta = await gerarUmaContaValida(regiao, '', '', 3).catch(() => null);
            if (conta) {
                job.contas.push({ uid: conta.uid, senha: conta.password, nome: conta.name });
                try { fs.appendFileSync(ARQUIVO, `${conta.uid}:${conta.password}\n`); } catch (e) { /* ignora */ }
            } else job.falhas++;
        }
        job.status = job.contas.length > 0 ? 'CONCLUIDO' : 'ERRO';
    } catch (e) {
        job.status = 'ERRO';
    } finally {
        ativos--;
    }
}

// ---------------- HTTP ----------------
function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
}

function lerBody(req) {
    return new Promise((resolve) => {
        let data = '';
        req.on('data', (c) => { data += c; if (data.length > 2000) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
        req.on('error', () => resolve({}));
    });
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');

    if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(PAGINA);
    }

    if (req.method === 'GET' && url.pathname === '/api/info') {
        return json(res, 200, { precisaSenha: !!SITE_SENHA, maxPorPedido: MAX_POR_PEDIDO, cooldown: COOLDOWN_S, regioes: REGIOES });
    }

    if (req.method === 'POST' && url.pathname === '/api/gerar') {
        const b = await lerBody(req);
        if (SITE_SENHA && b.senha !== SITE_SENHA) return json(res, 401, { erro: 'Senha incorreta.' });

        const ip = ipDe(req);
        const agora = Date.now();
        const falta = Math.ceil(((ultimoPedido.get(ip) || 0) + COOLDOWN_S * 1000 - agora) / 1000);
        if (falta > 0) return json(res, 429, { erro: `Aguarde ${falta}s para gerar de novo.` });
        if (ativos >= MAX_SIMULTANEOS) return json(res, 429, { erro: 'Muita gente gerando agora. Tente em instantes.' });

        const quantidade = Math.min(MAX_POR_PEDIDO, Math.max(1, parseInt(b.quantidade, 10) || 1));
        const regiao = REGIOES.includes(String(b.regiao).toUpperCase()) ? String(b.regiao).toUpperCase() : 'BR';

        const id = crypto.randomBytes(8).toString('hex');
        jobs.set(id, { status: 'GERANDO', total: quantidade, contas: [], falhas: 0, criadoEm: agora });
        ultimoPedido.set(ip, agora);
        executarJob(id, quantidade, regiao);
        return json(res, 200, { id });
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
        const job = jobs.get(url.searchParams.get('id'));
        if (!job) return json(res, 404, { erro: 'Pedido nao encontrado.' });
        return json(res, 200, { status: job.status, total: job.total, contas: job.contas, falhas: job.falhas });
    }

    json(res, 404, { erro: 'Nao encontrado.' });
});

setInterval(() => {
    const agora = Date.now();
    for (const [id, j] of jobs) if (agora - j.criadoEm > 30 * 60 * 1000) jobs.delete(id);
    for (const [ip, t] of ultimoPedido) if (agora - t > 60 * 60 * 1000) ultimoPedido.delete(ip);
}, 5 * 60 * 1000).unref();

// ---------------- TUNEL PUBLICO ----------------
async function abrirTunel(port) {
    try {
        const { Tunnel, install, bin } = await import('cloudflared');
        if (!fs.existsSync(bin)) { console.log('  [TUNEL] Baixando cloudflared (so na primeira vez)...'); await install(bin); }
        const t = Tunnel.quick(`http://localhost:${port}`);
        process.on('exit', () => { try { t.stop(); } catch (e) { /* ignora */ } });
        return await new Promise((resolve, reject) => {
            t.once('url', resolve);
            t.once('error', reject);
            setTimeout(() => reject(new Error('tempo esgotado')), 60000);
        });
    } catch (e) {
        console.log(`  [TUNEL] Nao foi possivel abrir o link publico (${e.message}).`);
        return null;
    }
}

server.listen(PORT, '0.0.0.0', async () => {
    console.log('\n  ===== Site Gerador de Contas FF =====\n');
    console.log(`  Local:  http://localhost:${PORT}`);
    for (const lista of Object.values(os.networkInterfaces())) {
        for (const i of lista || []) if (i.family === 'IPv4' && !i.internal) console.log(`  Rede:   http://${i.address}:${PORT}   (so quem esta no seu Wi-Fi)`);
    }
    console.log(`  Regras: ${MAX_POR_PEDIDO} conta(s) por clique | espera ${COOLDOWN_S}s por pessoa | ${MAX_SIMULTANEOS} geracoes simultaneas | senha: ${SITE_SENHA ? 'SIM' : 'nao'}\n`);

    if (!USAR_TUNEL) return console.log('  Link publico desligado (TUNEL=off).\n');
    console.log('  Abrindo link publico...');
    const publico = await abrirTunel(PORT);
    if (publico) console.log(`\n  >>> LINK PUBLICO (mande para quem quiser): ${publico}\n  Mantenha esta janela aberta e o PC ligado.\n`);
});

// ---------------- PAGINA ----------------
const PAGINA = `<!doctype html>
<html lang="pt-br"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gerador de Contas FF</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0d14;color:#eee;font-family:system-ui,Segoe UI,Arial,sans-serif;padding:16px}
.card{width:100%;max-width:440px;background:#171722;border:1px solid #2a2a3d;border-radius:16px;padding:24px}
h1{margin:0 0 4px;font-size:22px}p.sub{margin:0 0 18px;color:#9a9ab0;font-size:14px}
label{display:block;font-size:13px;color:#9a9ab0;margin:12px 0 4px}
select,input{width:100%;padding:11px;border-radius:10px;border:1px solid #2a2a3d;background:#0d0d14;color:#eee;font-size:15px}
button{width:100%;margin-top:18px;padding:13px;border:0;border-radius:10px;background:#7c5cff;color:#fff;font-size:16px;font-weight:600;cursor:pointer}
button:disabled{opacity:.5;cursor:wait}
.msg{margin-top:14px;font-size:14px;color:#ffb86b;min-height:20px}
.conta{margin-top:14px;background:#0d0d14;border:1px solid #2a2a3d;border-radius:10px;padding:12px;font-family:Consolas,monospace;font-size:14px;word-break:break-all}
.conta small{display:block;color:#9a9ab0;font-family:system-ui;margin-bottom:6px}
.cp{margin-top:8px;padding:8px;font-size:13px;background:#2a2a3d}
</style></head><body><div class="card">
<h1>Gerador de Contas FF</h1><p class="sub">Clique e aguarde a conta ser criada (leva alguns segundos).</p>
<div id="boxSenha" hidden><label>Senha do site</label><input id="senha" type="password" autocomplete="off"></div>
<label>Regiao</label><select id="regiao"></select>
<button id="btn">Gerar conta</button>
<div class="msg" id="msg"></div><div id="out"></div>
</div>
<script>
const $=id=>document.getElementById(id);
fetch('/api/info').then(r=>r.json()).then(i=>{
  $('boxSenha').hidden=!i.precisaSenha;
  $('regiao').innerHTML=i.regioes.map(r=>'<option>'+r+'</option>').join('');
});
function mostrar(c){
  const d=document.createElement('div');d.className='conta';
  const s=document.createElement('small');s.textContent='Nome: '+c.nome;d.appendChild(s);
  const t=document.createElement('div');t.textContent=c.uid+':'+c.senha;d.appendChild(t);
  const b=document.createElement('button');b.className='cp';b.textContent='Copiar';
  b.onclick=()=>{navigator.clipboard.writeText(c.uid+':'+c.senha);b.textContent='Copiado!'};
  d.appendChild(b);$('out').prepend(d);
}
$('btn').onclick=async()=>{
  $('msg').textContent='';$('btn').disabled=true;
  try{
    const r=await fetch('/api/gerar',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({regiao:$('regiao').value,senha:$('senha').value,quantidade:1})});
    const j=await r.json();
    if(!r.ok){$('msg').textContent=j.erro||'Erro.';$('btn').disabled=false;return}
    $('msg').textContent='Gerando conta... aguarde.';
    const t=setInterval(async()=>{
      try{
        const s=await (await fetch('/api/status?id='+j.id)).json();
        if(s.status==='GERANDO')return;
        clearInterval(t);$('btn').disabled=false;
        if(s.status==='CONCLUIDO'){$('msg').textContent='Pronto!';s.contas.forEach(mostrar)}
        else $('msg').textContent='Nao foi possivel gerar agora. Tente de novo.';
      }catch(e){}
    },3000);
  }catch(e){$('msg').textContent='Falha de conexao.';$('btn').disabled=false}
};
</script></body></html>`;
