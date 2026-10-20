// Grafo de tarefas: parsing, validação e ordenação.
//
// Este módulo é puro (sem rede, sem disco) — por isso é totalmente testável.
// Ele é a fronteira entre "o Planner escreveu texto" e "o orquestrador executa".
//
// Nada aqui confia no modelo: JSON malformado, agente inexistente, ciclo,
// dependência fantasma e excesso de tarefas são todos rejeitados com uma
// mensagem que pode ser devolvida ao próprio Planner para ele replanejar.

export const MAX_INSTRUCTION = 2000;

/** Papéis que podem receber tarefas de um plano. O Planner não se auto-atribui. */
export const EXECUTOR_ROLES = ['researcher', 'coder', 'reviewer'];

/**
 * Extrai JSON de um texto que pode vir embrulhado em markdown.
 * Modelos adoram responder ```json ... ``` mesmo quando pedimos JSON puro.
 */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const raw = text.trim();
  if (!raw) return null;

  // 1. já é JSON puro
  try {
    return JSON.parse(raw);
  } catch {
    /* segue */
  }

  // 2. bloco cercado por ``` (com ou sem linguagem)
  const fenced = raw.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* segue */
    }
  }

  // 3. primeiro objeto/array balanceado do texto
  const start = raw.search(/[[{]/);
  if (start >= 0) {
    const open = raw[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(raw.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Normaliza o que o modelo devolveu para uma lista de tarefas.
 * Aceita { tasks: [...] }, { plano: [...] } e o array direto.
 */
export function toTaskList(parsed) {
  if (!parsed) return null;
  if (Array.isArray(parsed)) return parsed;

  for (const key of ['tasks', 'tarefas', 'plano', 'plan', 'steps', 'etapas']) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }
  return null;
}

/**
 * Valida e normaliza o plano.
 *
 * @param {unknown} parsed JSON já parseado
 * @param {{maxTasks?: number, allowedAgents?: string[]}} options
 * @returns {{ok: boolean, tasks: object[], problems: string[]}}
 */
export function validatePlan(parsed, options = {}) {
  const maxTasks = options.maxTasks ?? 8;
  const allowedAgents = options.allowedAgents ?? EXECUTOR_ROLES;
  const problems = [];

  const list = toTaskList(parsed);
  if (!list) {
    return { ok: false, tasks: [], problems: ['resposta nao contem uma lista de tarefas'] };
  }

  if (list.length === 0) {
    return { ok: false, tasks: [], problems: ['lista de tarefas vazia'] };
  }

  if (list.length > maxTasks) {
    return {
      ok: false,
      tasks: [],
      problems: [`plano tem ${list.length} tarefas, o limite e ${maxTasks}`],
    };
  }

  const tasks = [];
  const seen = new Set();

  list.forEach((raw, index) => {
    const where = `tarefa ${index + 1}`;

    if (!raw || typeof raw !== 'object') {
      problems.push(`${where}: nao e um objeto`);
      return;
    }

    const id = String(raw.id ?? raw.id_tarefa ?? `t${index + 1}`).trim();
    if (!id) {
      problems.push(`${where}: id vazio`);
      return;
    }
    if (seen.has(id)) {
      problems.push(`${where}: id repetido "${id}"`);
      return;
    }
    seen.add(id);

    const agent = String(raw.agent ?? raw.agente ?? raw.responsavel ?? '').trim().toLowerCase();
    if (!agent) {
      problems.push(`${where} (${id}): sem campo "agent"`);
      return;
    }
    if (!allowedAgents.includes(agent)) {
      problems.push(`${where} (${id}): agente "${agent}" invalido (use: ${allowedAgents.join(', ')})`);
      return;
    }

    const instruction = String(raw.instruction ?? raw.instrucao ?? raw.task ?? raw.tarefa ?? '').trim();
    if (!instruction) {
      problems.push(`${where} (${id}): instrucao vazia`);
      return;
    }
    if (instruction.length > MAX_INSTRUCTION) {
      problems.push(`${where} (${id}): instrucao longa demais (${instruction.length} > ${MAX_INSTRUCTION})`);
      return;
    }

    const rawDeps = raw.depends_on ?? raw.dependsOn ?? raw.depende_de ?? raw.deps ?? [];
    const deps = Array.isArray(rawDeps) ? rawDeps.map((d) => String(d).trim()).filter(Boolean) : [];

    tasks.push({ id, agent, instruction, dependsOn: [...new Set(deps)] });
  });

  if (problems.length) return { ok: false, tasks: [], problems };

  // dependências precisam existir
  const ids = new Set(tasks.map((t) => t.id));
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        problems.push(`tarefa "${task.id}": depende de "${dep}", que nao existe no plano`);
      }
      if (dep === task.id) {
        problems.push(`tarefa "${task.id}": depende de si mesma`);
      }
    }
  }

  if (problems.length) return { ok: false, tasks: [], problems };

  return { ok: true, tasks, problems: [] };
}

/**
 * Ordena as tarefas em ondas de execução paralela.
 *
 * Onda 0 = tudo sem dependência. Onda 1 = quem só dependia da onda 0. Etc.
 * Se sobrar tarefa fora de qualquer onda, existe ciclo.
 *
 * @returns {{ok: boolean, waves: object[][], problems: string[]}}
 */
export function topoWaves(tasks) {
  const problems = [];
  const byId = new Map(tasks.map((t) => [t.id, t]));

  const pending = new Set(byId.keys());
  const done = new Set();
  const waves = [];

  let guard = 0;
  const maxRounds = tasks.length + 1;

  while (pending.size && guard++ < maxRounds) {
    const wave = [];

    for (const id of pending) {
      const task = byId.get(id);
      const ready = task.dependsOn.every((d) => done.has(d));
      if (ready) wave.push(task);
    }

    if (!wave.length) break; // ciclo

    waves.push(wave);
    for (const t of wave) {
      pending.delete(t.id);
      done.add(t.id);
    }
  }

  if (pending.size) {
    problems.push(`dependencia circular entre: ${[...pending].join(', ')}`);
    return { ok: false, waves: [], problems };
  }

  return { ok: true, waves, problems };
}

/**
 * Caminho completo: texto do modelo -> ondas prontas para executar.
 * É o que o orquestrador chama.
 */
export function buildPlan(text, options = {}) {
  const parsed = extractJson(text);
  if (!parsed) {
    return { ok: false, waves: [], tasks: [], problems: ['nao foi possivel extrair JSON da resposta'], parsed: null };
  }

  const validated = validatePlan(parsed, options);
  if (!validated.ok) {
    return { ok: false, waves: [], tasks: [], problems: validated.problems, parsed };
  }

  const ordered = topoWaves(validated.tasks);
  if (!ordered.ok) {
    return { ok: false, waves: [], tasks: [], problems: ordered.problems, parsed };
  }

  return { ok: true, waves: ordered.waves, tasks: validated.tasks, problems: [], parsed };
}

/** Resumo de uma linha por onda, para log e UI. */
export function describePlan(tasks) {
  return tasks.map((t) => ({
    id: t.id,
    agent: t.agent,
    instruction: t.instruction,
    dependsOn: t.dependsOn,
  }));
}
