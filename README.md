# agent-town

Observatório visual de agentes de IA: uma sala em pixel art onde cada bonequinho
é um agente de verdade trabalhando, com balão de fala, badge de modelo e log
inspecionável.

**Você escreve um objetivo. O Planner decompõe em tarefas. Os agentes executam.**

| modo | o que faz | custo |
|---|---|---|
| `sim` | roteiro fixo, ótimo para mexer no visual | zero |
| `real` | chama a API de verdade, com grafo de tarefas | tokens |

---

## 1. Configuração

Crie o `.env` a partir do modelo:

```powershell
cd C:\agent-town
Copy-Item .env.example .env
notepad .env
```

O mínimo para funcionar:

```ini
VERBOO_API_KEY=sua-chave
ORCHESTRATOR=real
```

Opcional — Gemini, para revisão cruzada entre provedores:

```ini
GEMINI_API_KEY=sua-chave
```

Opcional — modo projeto. Com `HOST=127.0.0.1` (padrão) você escolhe qualquer
pasta na tela, sem configuração. Só precisa de `PROJECT_ROOTS` se for expor o
servidor:

```ini
# HOST=0.0.0.0  →  PROJECT_ROOTS=C:\projetos;D:\trabalho
```

**Segurança das chaves:**

- O `.env` está no `.gitignore` e é lido **só pelo servidor Node**.
- O browser nunca recebe chave: o frontend só fala com `/events` (SSE) e `/api/*`.
- Nunca coloque chave em `public/`.

### Conferir antes de rodar

```powershell
npm run doctor
```

Mostra o `.env`, o estado de cada chave (mascarada), o modelo de cada papel, o
que falta, faz **um ping real** em cada provedor e lista os modelos que a sua
conta pode usar.

---

## 2. Rodar

```powershell
cd C:\agent-town
npm start
```

Abra <http://127.0.0.1:4173>, escreva a tarefa e clique em **▶ Iniciar**.

Sem dependências: só **Node 20+**. Não precisa de `npm install`.

---

## 3. As três fases

### Fase A — tarefa variável

Você escreve o objetivo na tela. Ele vira o `task` enviado ao Planner.

```
POST /api/run
{ "task": "adicione validação de CPF no cadastro", "mode": "template", "template": "price-parser" }
```

Ctrl+Enter no campo inicia a execução.

### Fase B — o Planner decide

O Planner não devolve texto: devolve um **grafo** que o orquestrador executa.

```json
{
  "tasks": [
    { "id": "t1", "agent": "researcher", "instruction": "...", "depends_on": [] },
    { "id": "t2", "agent": "coder",      "instruction": "...", "depends_on": ["t1"] },
    { "id": "t3", "agent": "reviewer",   "instruction": "...", "depends_on": ["t2"] }
  ]
}
```

O caminho é: **validar → ordenar em ondas → executar em paralelo → alimentar contexto**.

**Nada do que o modelo escreve é confiado.** `src/graph.mjs` rejeita:

| problema | tratamento |
|---|---|
| JSON quebrado ou com markdown em volta | extrai do bloco ``` e tenta de novo |
| agente inexistente ou `planner` | rejeita e devolve o erro ao modelo |
| dependência fantasma ou autodependência | rejeita |
| ciclo (`a → b → a`) | detecta e rejeita |
| mais tarefas que `MAX_TASKS` | rejeita |
| instrução vazia ou gigante | rejeita |

Quando rejeita, o erro volta para o Planner numa segunda tentativa. Se falhar de
novo, o orquestrador usa um **pipeline fixo** — a ferramenta nunca quebra por
causa do Planner.

Execução em ondas: tarefas sem dependência rodam juntas (respeitando o semáforo
de 2 requisições); o resultado de uma tarefa entra no prompt das que dependem dela.
Dependência que falhou **bloqueia** quem dependia.

### Fase C — projeto real

Em vez do template, os agentes trabalham numa pasta sua — **a que você escolher**,
sem lista fixa.

Na tela, mude o seletor **modo** para `projeto real` e clique em **…** para abrir o
navegador de pastas. Ele lista só diretórios e marca com o selo `git` os que são
repositórios, então você acha o projeto certo de relance. Os últimos caminhos
usados ficam salvos no navegador.

Também dá para digitar direto ou usar a API:

```powershell
$body = @{ task = "..."; mode = "project"; projectPath = "C:\farmasave" } | ConvertTo-Json
```

**Como a autorização funciona:**

| situação | regra |
|---|---|
| `HOST=127.0.0.1` (padrão) | qualquer pasta — só a sua máquina alcança a API |
| `HOST=0.0.0.0` / IP | `PROJECT_ROOTS` **obrigatório**; fora dele, recusa |

Sem isso, expor o servidor na rede permitiria que qualquer um apontasse os
agentes para `C:\Windows`. Localmente não há esse risco, então você escolhe livre.

O que o modo projeto garante:

1. **Caminho validado.** A pasta tem que existir e ser um repositório git **com
   pelo menos um commit** — sem isso não há base para comparar o diff.
2. **Branch isolada.** Cria `agent-town/<runId>` a partir da branch atual.
   Nunca trabalha na sua branch.
3. **Working tree protegida.** Arquivo rastreado com alteração não commitada
   **bloqueia** a execução (senão o diff ficaria misturado). Arquivos não
   rastreados, como `.vscode/`, são tolerados e ficam fora do commit.
4. **Diff obrigatório.** Ao final, você vê exatamente o que mudou, arquivo por
   arquivo, com `+` e `-`.
5. **Commit na branch, nunca push.** Não existe `git push` em nenhum lugar do código.
6. **Testes plugáveis.** O projeto define seu próprio comando em `.agent-town.json`.

Para revisar depois:

```powershell
git log --oneline agent-town/<runId>
git diff master...agent-town/<runId>
git checkout master && git branch -D agent-town/<runId>   # descartar
```

#### `.agent-town.json` (opcional, na raiz do projeto)

```json
{
  "testCommand": ["flutter", "test"],
  "ignore": ["build/", ".dart_tool/"],
  "maxSteps": 8
}
```

Sem esse arquivo, o `run_tests` usa o runner do Node (`test/*.test.mjs`).

---

## 4. Variáveis do `.env`

| variável | padrão | para que serve |
|---|---|---|
| `ORCHESTRATOR` | `sim` | `sim` ou `real` |
| `VERBOO_API_KEY` | — | chave da Verboo |
| `VERBOO_BASE_URL` | `https://code.verboo.ai/router/v1` | oficial |
| `VERBOO_CONCURRENCY` | `2` | requisições simultâneas do seu plano |
| `GEMINI_API_KEY` | — | chave do Google AI Studio |
| `PLANNER_MODEL` | `verboo:deepseek-v4.1-flash` | formato `provedor:modelo` |
| `RESEARCHER_MODEL` | `verboo:glm-5.3-flash` | |
| `CODER_MODEL` | `verboo:deepseek-v4.1-flash` | |
| `REVIEWER_MODEL` | `verboo:qwen3.8-27b` | família diferente = revisão cruzada |
| `MAX_STEPS` | `10` | passos por agente |
| `MAX_TASKS` | `6` | tarefas máximas num plano |
| `MAX_TOKENS` | `200000` | teto de tokens por execução (sempre funciona) |
| `BUDGET_USD` | `0.50` | teto de gasto estimado (usa `pricing.json`) |
| `TIMEOUT_SEC` | `600` | tempo máximo da execução |
| `HOST` | `127.0.0.1` | `127.0.0.1` = livre escolha de pasta · `0.0.0.0` = exige `PROJECT_ROOTS` |
| `PROJECT_ROOTS` | — | só obrigatório se expuser o servidor; funciona como allowlist |

### Catálogo Verboo

Quem manda é `GET /models` com a sua chave — `npm run doctor` mostra os IDs
exatos. No plano API pré-pago: `deepseek-v4.1-flash`, `glm-5.3-flash`,
`mimo-v2.6-flash`, `qwen3.8-27b`.

Modelo fora do seu plano responde `404 model not available in any of your groups`.

---

## 5. Testes

```powershell
npm test
```

Oito verificações, todas **sem gastar token**:

| teste | o que valida |
|---|---|
| `check` | grafo de imports/exports e IDs do DOM |
| `smoke` | 1200 frames da máquina de estados com canvas stubado |
| `test-graph` | parsing de JSON, schema, DAG, ciclos, limites |
| `verify-template` | a tarefa do template é resolvível |
| `test-tools` | sandbox: `../`, caminho absoluto, `run_tests` |
| `test-project` | allowlist de caminho, `.agent-town.json`, ferramentas plugáveis |
| `test-orchestrator` | grafo real, fallback, contexto, git branch/diff/commit, recusas |
| `test-adapters` | adaptadores HTTP contra servidor local falso |

O `test-orchestrator` cobre inclusive o que **não** deve acontecer: recusar
working tree suja, recusar caminho fora das raízes, e não commitar lixo
não rastreado.

---

## 6. Arquitetura

```
                    ┌─────────────────────────────────────┐
   você escreve ───▶│  Planner  →  grafo JSON             │
   a tarefa         └──────────────┬──────────────────────┘
                                   │  src/graph.mjs valida
                                   ▼
                    ┌─────────────────────────────────────┐
                    │  ondas → execução paralela          │
                    │  Researcher · Coder · Reviewer      │
                    └──────────────┬──────────────────────┘
                                   │  src/git.mjs isola
                                   ▼
                    ┌─────────────────────────────────────┐
                    │  branch + diff + commit (nunca push)│
                    └─────────────────────────────────────┘
```

```
src/
├─ orchestrator.mjs   planeja, executa ondas, finaliza com diff
├─ planner.mjs        prompt do Planner + retentativa com o erro
├─ graph.mjs          parsing, validação, DAG, ondas  (puro, testável)
├─ git.mjs            branch, diff, commit — nunca push
├─ project.mjs        allowlist de caminho + .agent-town.json
├─ tools.mjs          list/read/write/run_tests, presos ao workspace
├─ providers/         openai-compat · gemini · http com retry
├─ limiter.mjs        semáforo por provedor + backoff
├─ workspace.mjs      prepara runs/<id>/workspace
├─ simulator.mjs      roteiro simulado (modo sim)
└─ pricing.mjs        custo por modelo
```

A regra que sustenta tudo: **o frontend nunca fala com a API dos modelos.**
Ele só consome eventos. Trocar simulado por real não muda uma linha do cliente.

### Contrato de eventos

```jsonc
{ "id": "e0001", "ts": 1730000000000, "type": "tool_call",
  "agentId": "coder", "runId": "run_abc", "tool": "run_tests", "args": "parser" }
```

| type | payload | efeito na tela |
|---|---|---|
| `run_started` | `label`, `cycle`, `silent` | reinicia a sala (ondas são silenciosas) |
| `run_finished` | `reason`, `total`, `verdict` | encerra |
| `plan_created` | `tasks`, `waveCount`, `fellBack` | painel de plano |
| `agent_spawned` | `cycle` | agente volta ao lugar |
| `agent_thinking` | `text` | balão de pensamento |
| `agent_message` | `to`, `text`, `taskId` | anda até o colega e fala |
| `tool_call` | `tool`, `args` | monitor acende |
| `tool_result` | `tool`, `ok`, `summary` | ok ou erro |
| `token_usage` | `model`, `in`, `out`, `cost` | contador no card |
| `agent_done` | `summary`, `taskId` | balão verde |
| `agent_error` | `text` | balão vermelho |
| `diff_ready` | `branch`, `files`, `diff` | painel de alterações |

---

## 7. Custo medido

Execução real com 3 tarefas (researcher → coder → reviewer), 9 testes:

| agente | modelo | tokens in/out |
|---|---|---|
| Planner | deepseek-v4.1-flash | ~400 / ~200 |
| Researcher | glm-5.3-flash | ~4.800 / ~700 |
| Coder | deepseek-v4.1-flash | ~14.000 / ~3.600 |
| Reviewer | qwen3.8-27b | ~8.500 / ~800 |

**Total: ~US$ 0,0076 por execução.** O Planner acerta o plano na primeira
tentativa na maioria dos casos.

---

## 8. Limitações conhecidas

- **Gemini bloqueado em rede corporativa.** Se o `doctor` mostrar
  `SELF_SIGNED_CERT_IN_CHAIN`, o proxy da empresa intercepta TLS. Não é a chave
  nem o código. Use a Verboo, uma VPS ou rede pessoal.
- **Um agente por papel.** O grafo distribui tarefas, não cria novos agentes.
  "Contratar mais 3 coders" exigiria concorrência maior que o seu plano permite.
- **Contexto entre tarefas é linear.** Cada tarefa recebe o resultado das
  dependências diretas, truncado em 4000 caracteres.
- **Sem streaming.** A resposta chega completa por chamada; por isso o balão
  mostra o começo do texto, não letra por letra.

---

## 9. Próximos passos

1. **Replay** — gravar os eventos em `runs/<id>/events.jsonl` e reproduzir sem custo.
2. **Mais templates** em `templates/` (o seletor já lê a pasta).
3. **Deploy na VPS** — Docker + Caddy, resolve o Gemini e roda 24/7.
4. **Diff aplicável** — botão para aceitar/rejeitar o diff por arquivo.
