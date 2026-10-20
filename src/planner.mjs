// O Planner: transforma um objetivo em um grafo de tarefas.
//
// Duas coisas importantes aqui:
//   1. O modelo é instruído a devolver JSON, mas NUNCA confiamos nisso.
//   2. Se o JSON vier quebrado, devolvemos o erro para ele corrigir
//      (uma tentativa). Se falhar de novo, o orquestrador cai no
//      pipeline fixo — a ferramenta nunca quebra por causa do Planner.

import { buildPlan, describePlan } from './graph.mjs';

export const PLANNER_SYSTEM = `Voce e o Planner de um time de agentes de software.

Sua unica funcao e decompor um objetivo em tarefas para os executores.
Voce NAO executa tarefas.

Agentes disponiveis:
- "researcher": le o projeto, busca informacao, resume regras. Nao escreve codigo.
- "coder": implementa codigo e roda os testes.
- "reviewer": revisa o trabalho do coder e da o veredito.

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
1. Entre 2 e 6 tarefas. Menos e melhor.
2. "depends_on" lista os ids que precisam terminar antes.
3. Nao crie dependencia circular.
4. Coloque "researcher" primeiro quando o coder precisar entender o projeto.
5. Sempre termine com uma tarefa do "reviewer" que dependa das do coder.
6. Instrucoes concretas: diga o que fazer, nao o que "considerar".
7. Nao invente arquivos que nao existem sem mandar o agente procurar antes.`;

function buildRepairPrompt(problems) {
  return `Sua resposta anterior foi rejeitada pelos seguintes motivos:

${problems.map((p) => `- ${p}`).join('\n')}

Responda novamente APENAS com o JSON corrigido, seguindo o formato pedido.`;
}

/**
 * Pede um plano ao modelo e valida.
 *
 * @param {object} params
 * @param {object} params.provider provider já pronto (com .chat e .limiter)
 * @param {string} params.task objetivo escrito pelo usuário
 * @param {string} [params.context] contexto do projeto (árvore de arquivos, spec)
 * @param {number} [params.maxTasks]
 * @param {AbortSignal} [params.signal]
 * @param {(msg: string) => void} [params.onNote]
 * @returns {Promise<{ok: boolean, tasks: object[], waves: object[][], attempts: number, problems: string[], raw: string}>}
 */
export async function planTask({ provider, task, context = '', maxTasks = 6, signal, onNote }) {
  const messages = [
    { role: 'system', content: PLANNER_SYSTEM },
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
      }),
    );

    lastRaw = res.text || '';
    const plan = buildPlan(lastRaw, { maxTasks });

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
