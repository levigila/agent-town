// Reuniao de melhoria: cada agente propoe UMA melhoria para o proprio
// agent-town, e o usuario aprova ou descarta no card da tela.
//
// Por que existe: o escritorio e a ferramenta ao mesmo tempo. Em vez de o
// usuario imaginar o que melhorar, os agentes olham o projeto e propoem.
//
// Decisoes de projeto:
//   - UMA proposta por agente. Pedir tres vira texto generico.
//   - JSON estrito, validado aqui. Modelo adora responder em prosa.
//   - Falha de um agente nao derruba a reuniao: ele so nao contribui.
//   - Nada e implementado sem aprovacao explicita do usuario.

export const PROPOSAL_KINDS = ['visual', 'agente', 'implementacao', 'processo'];

export const KIND_LABEL = {
  visual: 'visual',
  agente: 'novo agente',
  implementacao: 'implementacao',
  processo: 'processo',
};

const EFFORTS = ['pequeno', 'medio', 'grande'];

const MAX_TITLE = 90;
const MAX_TEXT = 600;
const MAX_FILES = 4;

/**
 * System prompt do agente durante a reuniao.
 *
 * @param {object} agent instância (id, name, role, roleName)
 * @param {object} opts
 * @param {boolean} [opts.canEdit] false para agentes somente-leitura
 */
export function buildMeetingPrompt(agent, { canEdit = true } = {}) {
  const papel = agent.roleName || agent.role || 'agente';

  const kinds = canEdit
    ? 'visual (mudar o cenario), agente (criar/melhorar um agente), implementacao (codigo do agent-town), processo (como o time trabalha)'
    : 'visual (mudar o cenario), agente (criar/melhorar um agente), processo (como o time trabalha). Voce nao pode propor mudanca de codigo.';

  return `Voce e ${agent.name}, ${papel} do time agent-town.

O agent-town e um observatorio visual de agentes de IA: um escritorio em pixel
art desenhado em canvas, um servidor Node sem nenhuma dependencia, e um
orquestrador que decompoe tarefas em grafo e executa em ondas.

Estamos numa reuniao de melhoria. Sua funcao e propor UMA melhoria concreta
para o proprio agent-town.

Tipos de proposta aceitos: ${kinds}.

Regras:
- Seja ESPECIFICO. "melhorar a UI" nao serve; "destacar o agente que esta
  bloqueado com um icone de cadeado acima da cabeca" serve.
- Uma proposta por resposta. Menos e melhor.
- Diga o QUE, o PORQUE e o COMO, em passos que um coder consiga seguir.
- Cite no maximo ${MAX_FILES} arquivos reais do projeto.
- Escolha o esforco com honestidade: "pequeno" = menos de 50 linhas.
- Nao proponha reescrever o projeto. Proponha o proximo passo.

Responda APENAS com JSON valido, sem markdown, sem texto em volta:
{
  "title": "frase curta que resume a melhoria",
  "kind": "${canEdit ? 'visual' : 'processo'}",
  "why": "por que isso melhora o escritorio ou o trabalho do time",
  "how": "como fazer, em passos concretos",
  "files": ["caminho/relativo.js"],
  "effort": "pequeno"
}

Comece com { e termine com }.`;
}

/** Contexto comum da reuniao (vai no prompt do usuario). */
export function buildMeetingContext({ task = '', fileTree = '' } = {}) {
  return [
    'Contexto do projeto (arvore de arquivos):',
    fileTree || '(sem arvore de arquivos)',
    task ? `\nPedido do usuario: ${task}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Extrai o primeiro objeto JSON balanceado do texto. */
function extractObject(text) {
  if (typeof text !== 'string') return null;
  const raw = text.trim();

  try {
    return JSON.parse(raw);
  } catch {
    /* segue */
  }

  const fenced = raw.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* segue */
    }
  }

  const start = raw.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

const clean = (v, max) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/**
 * Valida e normaliza uma proposta vinda do modelo.
 *
 * @returns {{ok: true, proposal: object} | {ok: false, problem: string}}
 */
export function normalizeProposal(raw, agent) {
  if (!raw || typeof raw !== 'object') return { ok: false, problem: 'resposta nao e um objeto' };

  const title = clean(raw.title, MAX_TITLE);
  if (!title) return { ok: false, problem: 'sem title' };

  const kind = PROPOSAL_KINDS.includes(raw.kind) ? raw.kind : 'implementacao';

  const files = Array.isArray(raw.files)
    ? raw.files
        .filter((f) => typeof f === 'string' && f.trim())
        .map((f) => clean(f, 120))
        .slice(0, MAX_FILES)
    : [];

  return {
    ok: true,
    proposal: {
      id: `p_${agent.id}`,
      agentId: agent.id,
      agentName: agent.name || agent.id,
      role: agent.role,
      kind,
      title,
      why: clean(raw.why, MAX_TEXT),
      how: clean(raw.how, MAX_TEXT),
      files,
      effort: EFFORTS.includes(raw.effort) ? raw.effort : 'medio',
    },
  };
}

/** Chave de deduplicação: duas propostas com o mesmo título são a mesma. */
const dedupeKey = (p) => p.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Roda a reuniao: pergunta a cada agente e devolve as propostas validas.
 *
 * @param {object} params
 * @param {object[]} params.agents instâncias (config.agents)
 * @param {object} params.byInstance providers por id de instância
 * @param {object} params.byRole providers por papel (fallback)
 * @param {string} [params.context]
 * @param {AbortSignal} [params.signal]
 * @param {(type: string, agentId: string|null, payload: object) => void} [params.emit]
 * @param {number} [params.maxTokens]
 * @param {number} [params.timeoutMs]
 * @returns {Promise<{ok: boolean, proposals: object[], errors: object[], usage: {in: number, out: number}}>}
 */
export async function runMeeting({
  agents,
  byInstance,
  byRole,
  context = '',
  signal,
  emit = () => {},
  maxTokens = 900,
  timeoutMs = 90000,
}) {
  // Todos participam, inclusive o Planner: ele e quem enxerga o processo
  // inteiro, entao e dele que costumam vir as propostas de "como o time
  // trabalha". O dedup no final corta o que repetir.
  const executors = (agents || []).slice();
  const usage = { in: 0, out: 0 };
  const errors = [];
  const collected = [];

  emit('meeting_started', null, {
    agents: executors.map((a) => ({ id: a.id, name: a.name || a.id, role: a.role })),
  });

  const one = async (agent) => {
    const provider = byInstance?.[agent.id] || byRole?.[agent.role];
    if (!provider) {
      errors.push({ agentId: agent.id, problem: 'sem provedor' });
      return;
    }

    const canEdit = !Array.isArray(agent.toolNames) || agent.toolNames.includes('write_file');

    emit('agent_thinking', agent.id, { text: 'pensando em uma melhoria' });

    try {
      const res = await provider.limiter.run(() =>
        provider.chat({
          messages: [
            { role: 'system', content: agent.prompt || buildMeetingPrompt(agent, { canEdit }) },
            { role: 'user', content: context },
          ],
          tools: [],
          temperature: 0.8,
          maxTokens,
          signal,
        }),
      );

      usage.in += res.usage?.in || 0;
      usage.out += res.usage?.out || 0;

      const parsed = extractObject(res.text || '');
      const checked = normalizeProposal(parsed, agent);

      if (!checked.ok) {
        errors.push({ agentId: agent.id, problem: checked.problem });
        emit('agent_error', agent.id, { text: `proposta descartada: ${checked.problem}` });
        return;
      }

      collected.push(checked.proposal);
      emit('proposal', agent.id, { proposal: checked.proposal });
      emit('agent_done', agent.id, { summary: checked.proposal.title });
    } catch (err) {
      if (signal?.aborted) throw err;
      errors.push({ agentId: agent.id, problem: err.message });
      emit('agent_error', agent.id, { text: err.message });
    }
  };

  // Uma chamada por agente, em paralelo: o semáforo do provedor já limita a
  // concorrência real, então não precisa de fila própria aqui.
  const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.());
  await Promise.race([Promise.all(executors.map(one)), timeout]);

  // Dedup por título, mantendo a primeira proposta (a de quem respondeu antes).
  const seen = new Set();
  const proposals = [];
  for (const p of collected) {
    const key = dedupeKey(p);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    proposals.push(p);
  }

  // Ordena do mais barato para o mais caro: o usuário vê primeiro o que dá
  // para aprovar hoje.
  const order = { pequeno: 0, medio: 1, grande: 2 };
  proposals.sort((a, b) => (order[a.effort] ?? 1) - (order[b.effort] ?? 1));

  emit('meeting_done', null, { proposals, errors, usage });

  return { ok: true, proposals, errors, usage };
}

/**
 * Transforma as propostas aprovadas em uma tarefa para o orquestrador.
 *
 * @param {object[]} approved
 * @returns {string}
 */
export function composeTask(approved) {
  const list = (approved || []).filter(Boolean);
  if (!list.length) return '';

  const linhas = list.map((p, i) => {
    const partes = [
      `${i + 1}. ${p.title} (${KIND_LABEL[p.kind] || p.kind}, esforco ${p.effort})`,
      p.why ? `   porque: ${p.why}` : '',
      p.how ? `   como: ${p.how}` : '',
      p.files?.length ? `   arquivos: ${p.files.join(', ')}` : '',
    ];
    return partes.filter(Boolean).join('\n');
  });

  return [
    'Implemente as melhorias aprovadas na reuniao do escritorio.',
    'Faca uma de cada vez, na ordem, e rode os testes ao final.',
    '',
    linhas.join('\n\n'),
  ].join('\n');
}
