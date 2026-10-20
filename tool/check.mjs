// Verificacao estatica: sintaxe + imports/exports entre modulos + IDs usados no DOM.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);

const root = path.resolve(process.argv[2] || '.');
const jsDir = path.join(root, 'public', 'js');
const files = readdirSync(jsDir).filter((f) => f.endsWith('.js'));

const errors = [];

// ---------------------------------------------------------------------------
// 1. SINTAXE — cada arquivo precisa ser JavaScript valido.
//
// Este bloco existe por causa de um bug real: um agente escreveu ui.js em
// partes (write_file com append) e o teto de tokens cortou no meio. O arquivo
// ficou sem a chave final da classe, o navegador nao conseguiu carregar o
// modulo, o main.js nunca rodou e a tela ficou PRETA, sem nenhum agente.
//
// A validacao anterior era so de imports por regex, entao nao via nada disso.
// `node --check` usa o parser de verdade. Os processos rodam em paralelo:
// sequencial no Windows levava ~10 s, em paralelo fica em ~1 s.
// ---------------------------------------------------------------------------
async function syntaxCheck(file) {
  try {
    await run(process.execPath, ['--check', file], { encoding: 'utf8' });
    return null;
  } catch (err) {
    const raw = `${err.stderr || ''}${err.stdout || ''}`.trim();
    const m = raw.match(/(SyntaxError|Error):\s*(.+)/);
    const loc = raw.match(/^(?:.*?):(\d+)$/m);
    return {
      message: m ? m[2].trim() : raw.split('\n').slice(-1)[0] || 'erro de sintaxe',
      line: loc ? Number(loc[1]) : null,
    };
  }
}

/** Todo arquivo .mjs/.js do projeto (fora de node_modules, runs e dotdirs). */
function collectJs(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'runs' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJs(full, out);
    } else if (/\.m?js$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const rootFiles = readdirSync(root)
  .filter((f) => /\.m?js$/.test(f) && statSync(path.join(root, f)).isFile())
  .map((f) => path.join(root, f));

const allJs = [
  ...collectJs(path.join(root, 'public')),
  ...collectJs(path.join(root, 'src')),
  ...collectJs(path.join(root, 'tool')),
  ...rootFiles,
];

const results = await Promise.all(allJs.map((file) => syntaxCheck(file)));

results.forEach((bad, i) => {
  if (!bad) return;
  const rel = path.relative(root, allJs[i]).split(path.sep).join('/');
  errors.push(
    `${rel}${bad.line ? `:${bad.line}` : ''}: SINTAXE INVALIDA — ${bad.message}` +
      ` (arquivo truncado? rode "node --check ${rel}")`,
  );
});

const sources = {};
for (const f of files) sources[f] = readFileSync(path.join(jsDir, f), 'utf8');

function exportsOf(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+class\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  return names;
}

const exportsMap = Object.fromEntries(Object.entries(sources).map(([f, s]) => [f, exportsOf(s)]));

for (const [f, src] of Object.entries(sources)) {
  for (const m of src.matchAll(/import\s+(?:\*\s+as\s+([A-Za-z0-9_$]+)|\{([^}]+)\}|([A-Za-z0-9_$]+))\s+from\s+['"]([^'"]+)['"]/g)) {
    const [, ns, named, def, spec] = m;
    if (!spec.startsWith('.')) continue;
    const target = path.basename(spec);
    if (!sources[target]) {
      errors.push(`${f}: importa "${spec}" que nao existe`);
      continue;
    }
    if (named) {
      for (const part of named.split(',')) {
        const n = part.trim().split(/\s+as\s+/)[0].trim();
        if (!n) continue;
        if (!exportsMap[target].has(n)) errors.push(`${f}: "${n}" nao e exportado por ${target}`);
      }
    }
    if (ns) {
      // uso de namespace: valida W.xxx
      const re = new RegExp(`\\b${ns}\\.([A-Za-z0-9_$]+)`, 'g');
      for (const u of src.matchAll(re)) {
        if (!exportsMap[target].has(u[1])) errors.push(`${f}: ${ns}.${u[1]} nao existe em ${target}`);
      }
    }
    if (def) {
      if (!exportsMap[target].has('default')) errors.push(`${f}: import default de ${target} sem export default`);
    }
  }
}

// IDs do DOM
const html = readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
for (const [f, src] of Object.entries(sources)) {
  for (const m of src.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)) {
    if (!htmlIds.has(m[1])) errors.push(`${f}: getElementById("${m[1]}") nao existe no HTML`);
  }
}

// classes usadas em querySelector (procuradas no HTML e nos templates dos .js)
const allMarkup = html + Object.values(sources).join('\n');
for (const [f, src] of Object.entries(sources)) {
  for (const m of src.matchAll(/querySelector\(['"]\.([a-z-]+)['"]\)/g)) {
    if (!allMarkup.includes(m[1])) errors.push(`${f}: classe .${m[1]} nao aparece no HTML nem nos templates`);
  }
}

console.log(`arquivos analisados: ${files.length}`);
console.log(`ids no HTML: ${htmlIds.size}`);
if (errors.length === 0) {
  console.log('OK — nenhum problema de import/export/DOM encontrado');
} else {
  console.log(`\n${errors.length} problema(s):`);
  for (const e of errors) console.log(' - ' + e);
  process.exitCode = 1;
}
