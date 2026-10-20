// O Planner: transforma um objetivo em um grafo de tarefas.
//
// Duas coisas importantes aqui:
//   1. O modelo é instruído a devolver JSON, mas NUNCA confiamos nisso.
//   2. Se o JSON vier quebrado, devolvemos o erro para ele corrigir
//      (uma tentativa). Se falhar de novo, o orquestrador cai no
//      pipeline fixo — a ferramenta nunca quebra por causa do Planner.

import { buildPlan, describePlan } from './graph.mjs';

/**
 * Monta o system prompt do Planner.
 *
 * A lista de agentes é dinâmica: com 2 instâncias por papel, o Planner pode
 * pedir "coder-1" e "coder-2" para trabalhar em paralelo, ou só "coder" para
 * que o escalonador escolha quem estiver livre.
 *
 * @param {object[]} [agents] instâncias configuradas (config.agents)
 */
export function buildPlannerPrompt(agents = []) {
  const executors = agents.filter((a) => a.role !== 'planner');
  const byRole = new Map();
  for (const a of executors) {
    if (!byRole.has(a.role)) byRole.set(a.role, []);
    byRole.get(a.role).push(a.id);
  }

  const perRole = executors.length / Math.max(1, byRole.size);
  const parallel = perRole > 1;

  const lines = [];
  lines.push('Agentes disponiveis:');
  for (const [role, ids] of byRole) {
    const what =
      role === 'researcher'
        ? 'le o projeto, busca informacao, resume regras. Nao escreve codigo'
        : role === 'coder'
          ? 'implementa codigo e roda os testes'
          : 'revisa o trabalho do coder e da o veredito';
    lines.push(`- "${role}" — ${what}.`);
    if (parallel) {
      lines.push(
        `  instancias: ${ids.join(', ')} — use os ids para dividir trabalho em paralelo, ` +
          `ou so "${role}" para deixar o escalonador escolher quem estiver livre.`,
      );
    }
  }

  const capacityNote = parallel
    ? `\nVoce tem ${perRole} instancias por funcao. Duas tarefas da MESMA instancia rodam em serie; ` +
      `instancias diferentes rodam em paralelo. Divida trabalho paralelizavel entre instancias diferentes ` +
      `(ex: coder-1 mexe em public/js/world.js e coder-2 em public/js/sprite.js) e coloque as duas na mesma onda.`
    : '';

  return `Voce e o Planner de um time de agentes de software.

Sua unica funcao e decompor um objetivo em tarefas para os executores.
Voce NAO executa tarefas.

${lines.join('\n')}
${capacityNote}
Responda APENAS com JSON valido, sem markdown, sem explicacao, neste formato:
{
  "tasks": [
    {
      "id": "t1",
      "agent": "researcher",
      "instruction": "instrucao clara e especifica para este agente",
      "depends_on": []
    }
  ]
}

Regras:
1. Entre 2 e 5 tarefas. Menos e melhor — cada tarefa custa tokens.
2. "depends_on" lista os ids que precisam terminar antes.
3. Nao crie dependencia circular.
4. Coloque "researcher" primeiro quando o coder precisar entender o projeto.
5. Sempre termine com uma tarefa do "reviewer" que dependa das do coder.
6. Instrucoes concretas: diga o que fazer, nao o que "considerar".
7. Nao invente arquivos que nao existem sem mandar o agente procurar antes.
8. A instrucao de cada tarefa deve citar no maximo 3 arquivos concretos.
9. NUNCA coloque duas tarefas que alteram o MESMO arquivo em paralelo — elas
   se sobrescrevem. Se precisar de dois coders, de arquivos diferentes a cada um.
${
  parallel
    ? `10. Quando duas tarefas forem independentes e mexerem em arquivos diferentes,
   distribua entre instancias diferentes e deixe-as na mesma onda para ganhar tempo.`
    : `10. No maximo duas tarefas de "coder" no plano inteiro. Prefira uma que faca tudo.`
}

Comece a resposta com { e termine com }. Nada antes, nada depois.`;
}

/** Compatibilidade: prompt padrão sem instâncias explícitas. */
export const PLANNER_SYSTEM = buildPlannerPrompt([]);

function buildRepairPrompt(problems) {
  return `Sua resposta anterior foi rejeitada pelos seguintes motivos:

${problems.map((p) => `- ${p}`).join('\n')}

Responda novamente APENAS com o JSON corrigido, seguindo o formato pedido.
Comece com { e termine com }. Sem markdown, sem texto em volta.`;
}

/**
 * Pede um plano ao modelo e valida.
 *
 * @param {object} params
 * @param {object} params.provider provider já pronto (com .chat e .limiter)
 * @param {string} params.task objetivo escrito pelo usuário
 * @param {string} [params.context] contexto do projeto (árvore de arquivos, spec)
 * @param {number} [params.maxTasks]
 * @param {object[]} [params.agents] instâncias configuradas (config.agents)
 * @param {string[]} [params.allowedAgents] ids aceitos nas tarefas
 * @param {AbortSignal} [params.signal]
 * @param {(msg: string) => void} [params.onNote]
 * @param {(info: object) => void} [params.onRateLimit]
 * @returns {Promise<{ok: boolean, tasks: object[], waves: object[][], attempts: number, problems: string[], raw: string}>}
 */
export async function planTask({
  provider,
  task,
  context = '',
  maxTasks = 6,
  agents = [],
  allowedAgents,
  signal,
  onNote,
  onRateLimit,
}) {
  const messages = [
    { role: 'system', content: buildPlannerPrompt(agents) },
    {
      role: 'user',
      content: `Objetivo:\n${task}\n\nContexto do projeto:\n${context || '(sem contexto adicional)'}`,
    },
  ];

  let attempts = 0;
  let lastProblems = [];
  let lastRaw = '';

  for (let round = 0; round < 2; round++) {
    attempts += 1;

    const res = await provider.limiter.run(() =>
      provider.chat({
        messages,
        tools: [],
        temperature: 0.1,
        maxTokens: 1200,
        signal,
        onRetry: onNote,
        onRateLimit,
      }),
    );

    lastRaw = res.text || '';
    const plan = buildPlan(lastRaw, { maxTasks, allowedAgents });

    if (plan.ok) {
      return {
        ok: true,
        tasks: describePlan(plan.tasks),
        waves: plan.waves,
        attempts,
        problems: [],
        raw: lastRaw,
        usage: res.usage,
      };
    }

    lastProblems = plan.problems;
    onNote?.(`plano invalido: ${plan.problems[0]}`);

    // devolve o erro para o modelo corrigir
    messages.push({ role: 'assistant', content: lastRaw || '(vazio)' });
    messages.push({ role: 'user', content: buildRepairPrompt(plan.problems) });
  }

  return {
    ok: false,
    tasks: [],
    waves: [],
    attempts,
    problems: lastProblems,
    raw: lastRaw,
  };
}

/**
 * Pipeline de emergência quando o Planner falha.
 * Mantém a ferramenta útil em vez de só dar erro.
 */
export function fallbackPlan() {
  return [
    { id: 'f1', agent: 'researcher', instruction: 'Leia o projeto e resuma o que precisa ser feito.', dependsOn: [] },
    {
      id: 'f2',
      agent: 'coder',
      instruction: 'Implemente o objetivo. Rode os testes ate passarem.',
      dependsOn: ['f1'],
    },
    { id: 'f3', agent: 'reviewer', instruction: 'Revise o trabalho e rode os testes.', dependsOn: ['f2'] },
  ];
}
