// Ferramentas que os agentes podem executar.
//
// SEGURANÇA: tudo fica preso ao diretório do workspace da execução.
// Nenhum caminho pode escapar dele (nem com .., nem com absoluto).

import { readFile, writeFile, appendFile, readdir, mkdir, stat } from 'node:fs/promises';
import { existsSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const MAX_FILE_BYTES = 64 * 1024;
const MAX_LIST = 200;

export const TOOL_DEFS = [
  {
    name: 'list_files',
    description: 'Lista os arquivos do projeto. Use antes de ler qualquer coisa.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_file',
    description: 'Le um arquivo de texto do projeto. Caminho relativo a raiz.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Caminho relativo, ex: src/price.mjs' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Escreve (ou substitui) um arquivo de texto. Envie o conteudo completo. ' +
      'Para arquivos grandes, use "append": true em chamadas sucessivas para nao estourar o limite de saida.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Caminho relativo, ex: src/price.mjs' },
        content: { type: 'string', description: 'Conteudo do arquivo (ou o trecho, quando append=true)' },
        append: {
          type: 'boolean',
          description: 'Se true, acrescenta ao final em vez de substituir. Use na 2a chamada em diante.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_tests',
    description: 'Executa a suite de testes do projeto e devolve a saida.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

/** Resolve um caminho relativo garantindo que fica dentro da raiz. */
export function safeResolve(root, rel) {
  const raw = String(rel ?? '').trim();
  if (!raw) throw new Error('caminho vazio');

  // Caminho absoluto é recusado de frente: o contrato da ferramenta é
  // "relativo à raiz". Remapear silenciosamente confundiria o agente.
  if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith('\\\\')) {
    throw new Error(`caminho absoluto nao permitido: ${rel}`);
  }

  const full = path.resolve(root, raw);
  const normalizedRoot = path.resolve(root);

  if (full !== normalizedRoot && !full.startsWith(normalizedRoot + path.sep)) {
    throw new Error(`caminho fora do workspace: ${rel}`);
  }
  return full;
}

const ALWAYS_SKIP = new Set([
  'node_modules',
  '.git',
  'build',
  '.dart_tool',
  'dist',
  'out',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
]);

async function walk(root, dir = root, acc = [], { ignore = [] } = {}) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || ALWAYS_SKIP.has(entry.name)) continue;

    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (ignore.some((pattern) => rel === pattern || rel.startsWith(pattern.replace(/\/$/, '') + '/'))) continue;

    if (entry.isDirectory()) {
      await walk(root, full, acc, { ignore });
    } else {
      acc.push(rel);
    }
    if (acc.length >= MAX_LIST) break;
  }
  return acc;
}

/**
 * Executa um processo escrevendo stdout/stderr num arquivo.
 * Evita pipes (que falham em ambientes restritos) e nunca trava o event loop.
 */
function runProcess({ command, args, cwd, timeoutMs = 60000, logPath }) {
  return new Promise((resolve) => {
    let fd;
    try {
      fd = openSync(logPath, 'w');
    } catch (err) {
      return resolve({ code: -1, output: `nao foi possivel criar o log: ${err.message}` });
    }

    let settled = false;
    let child;

    const finish = (code, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        closeSync(fd);
      } catch {
        /* já fechado */
      }
      let output = '';
      try {
        output = readFileSync(logPath, 'utf8');
      } catch {
        /* sem log */
      }
      resolve({ code, output: (output + extra).slice(0, 8000) });
    };

    const timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* já morreu */
      }
      finish(-1, `\n[timeout de ${timeoutMs}ms]`);
    }, timeoutMs);

    try {
      child = spawn(command, args, {
        cwd,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
        env: { ...process.env, NODE_OPTIONS: '' },
      });
    } catch (err) {
      return finish(-1, `\nfalha ao iniciar: ${err.message}`);
    }

    child.on('error', (err) => finish(-1, `\nerro: ${err.message}`));
    child.on('close', (code) => finish(code ?? -1));
  });
}

/**
 * Registro de quem é dono de cada arquivo durante uma execução.
 *
 * Com várias instâncias de coder trabalhando em paralelo, dois agentes podem
 * escrever o mesmo arquivo — o segundo apaga o trabalho do primeiro sem que
 * ninguém perceba. A guarda torna isso visível: o primeiro que escreve vira
 * dono, e o outro recebe um erro explicando o conflito.
 *
 * A posse é "pegajosa" dentro da execução (o dono continua podendo editar),
 * o que é o comportamento certo: quem começou o arquivo termina o arquivo.
 */
export function createWriteGuard() {
  const owners = new Map(); // caminho relativo -> id do agente

  return {
    /**
     * Pede o arquivo para o agente.
     * @returns {{ok: true} | {ok: false, owner: string}}
     */
    claim(relPath, agentId) {
      const owner = owners.get(relPath);
      if (owner && owner !== agentId) return { ok: false, owner };
      owners.set(relPath, agentId);
      return { ok: true };
    },

    ownerOf(relPath) {
      return owners.get(relPath) || null;
    },

    /** Arquivos escritos, para o relatório final. */
    snapshot() {
      return Object.fromEntries(owners);
    },
  };
}

/**
 * @param {string} root diretório onde os agentes podem atuar
 * @param {string} tmpDir diretório para logs (fora do root)
 * @param {object} [options]
 * @param {string[]|null} [options.testCommand] comando de teste do projeto
 * @param {number} [options.testTimeoutMs] timeout do comando de teste
 * @param {string[]} [options.ignore] padrões extras a esconder do list_files
 * @param {object} [options.writeGuard] guarda de conflito compartilhada
 */
export function createTools(root, tmpDir, options = {}) {
  const testCommand = Array.isArray(options.testCommand) ? options.testCommand : null;
  const testTimeoutMs = Number(options.testTimeoutMs) > 0 ? Number(options.testTimeoutMs) : 180000;
  const extraIgnore = Array.isArray(options.ignore) ? options.ignore : [];
  const writeGuard = options.writeGuard || null;

  // Arquivos já lidos, POR CONVERSA. Releitura devolve um aviso curto em vez
  // do conteúdo inteiro: o modelo esquece o que leu e relê, e cada releitura
  // custa o arquivo inteiro em tokens de novo.
  //
  // A chave inclui o escopo (um por agente/tarefa). Sem isso, o agente B
  // receberia "já lido" de um arquivo que só o agente A viu — e ficaria cego.
  const reads = new Set();

  return {
    root,
    writeGuard,

    /**
     * Executa uma ferramenta. NUNCA lança: sempre devolve
     * { ok, summary, output } — inclusive para caminho inválido.
     *
     * @param {string} name
     * @param {object} args
     * @param {string|{scope: string, owner?: string}} [ctx]
     *   string = só o escopo da conversa; objeto = escopo + dono (para a guarda)
     */
    async execute(name, args = {}, ctx = 'default') {
      const scope = typeof ctx === 'string' ? ctx : ctx.scope || 'default';
      const owner = typeof ctx === 'string' ? null : ctx.owner || null;

      try {
        return await runTool(name, args, scope, owner);
      } catch (err) {
        return { ok: false, summary: err.message || 'falha na ferramenta', output: '' };
      }
    },
  };

  async function runTool(name, args, scope, owner) {
    switch (name) {
      case 'list_files': {
        const files = await walk(root, root, [], { ignore: extraIgnore });
        return { ok: true, summary: `${files.length} arquivos`, output: files.join('\n') || '(vazio)' };
      }

      case 'read_file': {
        const full = safeResolve(root, args.path);
        const rel = path.relative(root, full).split(path.sep).join('/');
        const key = `${scope}|${rel}`;

        if (reads.has(key)) {
          return {
            ok: true,
            summary: 'ja lido nesta tarefa',
            output: `[ja lido] O conteudo de ${rel} esta na conversa acima. Use-o; nao precisa reler.`,
          };
        }

        const info = await stat(full).catch(() => null);
        if (!info?.isFile()) return { ok: false, summary: 'arquivo nao encontrado', output: '' };
        if (info.size > MAX_FILE_BYTES) return { ok: false, summary: 'arquivo grande demais', output: '' };
        const text = await readFile(full, 'utf8');
        reads.add(key);
        return { ok: true, summary: `${text.split('\n').length} linhas`, output: text };
      }

      case 'write_file': {
        // Argumentos vazios quase sempre significam resposta truncada pelo
        // limite de saída. Explicar isso é melhor que só dizer "caminho vazio".
        if (!args.path || typeof args.path !== 'string') {
          return {
            ok: false,
            summary: 'faltou o parametro "path"',
            output:
              'write_file precisa de "path" e "content". Se voce enviou os dois, sua resposta ' +
              'provavelmente foi cortada pelo limite de tokens de saida: reenvie o arquivo em ' +
              'trechos menores usando append:true a partir da segunda chamada.',
          };
        }

        if (typeof args.content !== 'string') {
          return {
            ok: false,
            summary: 'faltou o parametro "content"',
            output: 'write_file precisa de "content" (string com o conteudo). Reenvie a chamada completa.',
          };
        }

        const full = safeResolve(root, args.path);
        const content = args.content;
        if (content.length > MAX_FILE_BYTES) {
          return { ok: false, summary: 'conteudo grande demais', output: '' };
        }

        // Conflito entre instâncias: outra instância já é dona deste arquivo.
        // Deixar escrever apagaria o trabalho dela em silêncio.
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (writeGuard && owner) {
          const claim = writeGuard.claim(rel, owner);
          if (!claim.ok) {
            return {
              ok: false,
              summary: `arquivo em uso por ${claim.owner}`,
              output:
                `${rel} ja esta sendo alterado por ${claim.owner} nesta execucao. ` +
                'NAO escreva neste arquivo: escolha outro ou peça a tarefa para o dono dele. ' +
                'Sobrescrever apagaria o trabalho do outro agente.',
            };
          }
        }

        await mkdir(path.dirname(full), { recursive: true });
        const existed = existsSync(full);
        const isAppend = args.append === true;

        if (isAppend) {
          await appendFile(full, content, 'utf8');
          return {
            ok: true,
            summary: 'trecho acrescentado',
            output: `acrescentado a ${args.path} (+${content.length} bytes)`,
          };
        }

        await writeFile(full, content, 'utf8');
        return {
          ok: true,
          summary: existed ? 'arquivo atualizado' : 'arquivo criado',
          output: `${existed ? 'atualizado' : 'criado'}: ${args.path} (${content.length} bytes)`,
        };
      }

      case 'run_tests':
        return await runTests();

      default:
        return { ok: false, summary: `ferramenta desconhecida: ${name}`, output: '' };
    }
  }

  async function runTests() {
    // 1. Comando configurado no projeto tem prioridade (Flutter, Maven, pytest...).
    if (Array.isArray(testCommand) && testCommand.length) {
      return runCustomTests(testCommand);
    }

    // 2. Pasta test/ com testes do Node.
    const testDir = path.join(root, 'test');
    if (existsSync(testDir)) {
      const nodeTests = await runNodeTests(testDir);
      if (nodeTests) return nodeTests;
    }

    // 3. Script "test" do package.json — cobre projetos que usam npm test.
    const fromPackage = await runPackageScript();
    if (fromPackage) return fromPackage;

    return {
      ok: false,
      summary: 'projeto sem testes executaveis',
      output:
        'Nao ha pasta test/, nem script "test" no package.json, nem testCommand em .agent-town.json. ' +
        'Voce NAO pode validar por testes: revise o codigo manualmente antes de concluir.',
    };
  }

  /** Roda os *.test.* da pasta test/ com o runner do Node. */
  async function runNodeTests(testDir) {
    // Passa os arquivos explicitamente: `node --test test/` nao funciona
    // igual em todas as versoes/plataformas.
    const entries = await readdir(testDir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && /\.(test|spec)\.[cm]?js$/.test(e.name))
      .map((e) => `test/${e.name}`)
      .sort();

    if (!files.length) return null;

    const logPath = path.join(tmpDir, `test-${Date.now()}.log`);
    const result = await runProcess({
      command: process.execPath,
      args: ['--test', ...files],
      cwd: root,
      timeoutMs: 60000,
      logPath,
    });

    rmSync(logPath, { force: true });

    const passed = result.code === 0;
    const tail = result.output.split('\n').filter(Boolean).slice(-25).join('\n');
    // O reporter do Node usa "â„¹ pass 9"; versoes antigas usam "# pass 9".
    const count = (label) => {
      const m = result.output.match(new RegExp(`(?:^|[\\s#\\u2139])${label}\\s+(\\d+)`, 'm'));
      return m ? Number(m[1]) : null;
    };

    const passCount = count('pass');
    const failCount = count('fail');

    const summary = passed
      ? `${passCount ?? '?'} testes passando`
      : failCount !== null
        ? `${failCount} falha(s)`
        : `saiu com codigo ${result.code}`;

    return { ok: passed, summary, output: tail || '(sem saida)' };
  }

  /** Comando de teste definido pelo projeto em .agent-town.json. */
  async function runCustomTests(command) {
    const [bin, ...args] = command;
    const logPath = path.join(tmpDir, `test-${Date.now()}.log`);

    const result = await runProcess({
      command: bin,
      args,
      cwd: root,
      timeoutMs: testTimeoutMs,
      logPath,
    });

    rmSync(logPath, { force: true });

    const passed = result.code === 0;
    const tail = result.output.split('\n').filter(Boolean).slice(-30).join('\n');
    const label = command.join(' ');

    return {
      ok: passed,
      summary: passed ? `"${label}" passou` : `"${label}" falhou (codigo ${result.code})`,
      output: tail || '(sem saida)',
    };
  }

  /**
   * Usa o script "test" do package.json.
   * Sem isso, um projeto como o agent-town (que testa via npm test) ficaria
   * sem nenhuma forma de validação — e o agente não teria como saber se acertou.
   */
  async function runPackageScript() {
    const pkgPath = path.join(root, 'package.json');
    if (!existsSync(pkgPath)) return null;

    let script;
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
      script = pkg?.scripts?.test;
    } catch {
      return null;
    }

    if (!script || typeof script !== 'string') return null;

    const logPath = path.join(tmpDir, `test-${Date.now()}.log`);

    // Node 20+ recusa spawn() direto de .cmd/.bat (CVE-2024-27980), então
    // passamos pelo shell do sistema em vez de chamar "npm.cmd".
    const isWin = process.platform === 'win32';
    const result = await runProcess({
      command: isWin ? 'cmd.exe' : 'sh',
      args: isWin ? ['/d', '/s', '/c', 'npm test --silent'] : ['-c', 'npm test --silent'],
      cwd: root,
      timeoutMs: testTimeoutMs,
      logPath,
    });

    rmSync(logPath, { force: true });

    const passed = result.code === 0;
    const tail = result.output.split('\n').filter(Boolean).slice(-30).join('\n');

    return {
      ok: passed,
      summary: passed ? 'npm test passou' : `npm test falhou (codigo ${result.code})`,
      output: tail || '(sem saida)',
    };
  }
}
