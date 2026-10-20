// Verificacao estatica: imports/exports entre modulos + IDs usados no DOM.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const jsDir = path.join(root, 'public', 'js');
const files = readdirSync(jsDir).filter((f) => f.endsWith('.js'));

const errors = [];
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
