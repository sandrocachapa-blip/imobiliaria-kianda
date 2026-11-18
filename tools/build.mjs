// Uso: node tools/build.mjs src/app.html
// Gera index.html (modo servidor) e api/_seed.json a partir da app de demonstração
import fs from 'node:fs';
import { JSDOM } from 'jsdom'; // npm i --no-save jsdom
const src = fs.readFileSync(process.argv[2], 'utf8');
const apiMode = fs.readFileSync(new URL('../src/api-mode.js', import.meta.url), 'utf8');
let out = src.replace('<head>', '<head>\n<script>window.KIANDA_API=true</script>');
out = out.replace(/<\/script>\s*<\/body>/, '</script>\n<script>\n' + apiMode + '\n</script>\n</body>');
out = out.replace('<title>Kianda Imobiliária — Portal e Gestão</title>', '<title>Kianda Imobiliária — Imóveis em Angola</title>\n<meta name="description" content="Apartamentos, moradias e outros imóveis para comprar ou arrendar em Luanda e em Angola.">\n<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22%3E%3Crect width=%2224%22 height=%2224%22 rx=%226%22 fill=%22%23E5484D%22/%3E%3Cpath d=%22M5 11.5 12 6l7 5.5M7 10.5V18h10v-7.5%22 stroke=%22white%22 stroke-width=%222%22 fill=%22none%22/%3E%3C/svg%3E">');
fs.writeFileSync(new URL('../index.html', import.meta.url), out);
// dados iniciais
const dom = new JSDOM(src, { runScripts: 'dangerously', url: 'https://seed.local/', pretendToBeVisual: true });
const w = dom.window; w.scrollTo = () => {};
const S = w.eval('S');
const seed = {}; for (const k of ['equipa','clientes','props','visitas','propostas','arrend','despesas','custos','manut','fornecedores','cfg']) seed[k] = S[k];
seed.equipa.forEach(u => { u.mfa = false; });
seed.props.forEach(p => { if (/exemplo\.ao/.test(p.video || '')) p.video = ''; if (/exemplo\.ao/.test(p.tour || '')) p.tour = ''; });
fs.writeFileSync(new URL('../api/_seed.json', import.meta.url), JSON.stringify(seed));
console.log('index.html', out.length, 'seed props', seed.props.length, 'clientes', seed.clientes.length);
