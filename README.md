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
2. **Branch isolada, sem empilhar.** Cria `agent-town/<runId>` a partir da
   **branch principal** (`main`/`master`) — nunca de uma branch do próprio
   agent-town. Ao final, o repositório **volta** para a branch principal.
   Sem essas duas regras as execuções empilham: a segunda nasce da primeira, a
   terceira da segunda, e cada uma herda as mudanças da anterior.
3. **Working tree protegida.** Arquivo rastreado com alteração não commitada
   **bloqueia** a execução (senão o diff ficaria misturado). Arquivos não
   rastreados, como `.vscode/`, são tolerados e ficam fora do commit.
4. **Diff obrigatório.** Ao final, você vê exatamente o que mudou, arquivo por
   arquivo, com `+` e `-`.
5. **Commit na branch, sem push automatico.** Publicar na principal exige clicar
   em **Publicar na principal do GitHub** no painel de alteracoes.
6. **Testes plugáveis.** O projeto define seu próprio comando em `.agent-town.json`.

> **Onde fica o código que os agentes escreveram?** Na branch `agent-town/<runId>`.
> Como o repositório volta para `main` ao final, o *working tree* mostra o estado
> original — isso é proposital. Use `git diff main...agent-town/<runId>` para ver,
> e `git merge` para trazer.

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

### Mais agentes por função (`AGENTS_PER_ROLE`)

Por padrão cada função tem **duas instâncias**: `coder-1` e `coder-2`,
`researcher-1` e `researcher-2`, `reviewer-1` e `reviewer-2`. O Planner é único.

```env
AGENTS_PER_ROLE=2   # 1, 2 ou 3
```

Na cena, as duas instâncias da mesma função **dividem a mesma mesa**, sentadas
lado a lado, com a segunda usando um tom mais escuro de camisa.

O Planner sabe quantas instâncias existem e pode distribuí-las:

```json
{ "tasks": [
  { "id": "t1", "agent": "coder-1", "instruction": "mexer em public/js/world.js", "depends_on": [] },
  { "id": "t2", "agent": "coder-2", "instruction": "mexer em public/js/sprite.js", "depends_on": [] }
] }
```

Ele também pode escrever só `"coder"` — nesse caso o **escalonador** escolhe
qual instância estiver livre. As regras de execução:

| situação | comportamento |
|---|---|
| tarefas em instâncias **diferentes** | rodam em **paralelo** |
| duas tarefas na **mesma instância** | rodam em **série** (uma conversa por vez) |
| instância específica pedida | respeitada, sem substituição |
| todas ocupadas | a primeira assume; o agrupamento serializa |

**Aviso honesto sobre o ganho.** O paralelismo é limitado pela concorrência do
provedor, não pelo número de agentes. Com `VERBOO_CONCURRENCY=2`, só duas
chamadas acontecem ao mesmo tempo — três instâncias não aceleram mais que duas,
apenas esperam na fila. O ganho real vem de **dividir trabalho em arquivos
diferentes**, não de ter mais bonequinhos.

#### Conflito de escrita

Duas instâncias escrevendo o mesmo arquivo é a forma mais fácil de perder
trabalho: a segunda sobrescreve a primeira em silêncio. A guarda em
`src/tools.mjs` (`createWriteGuard`) torna isso impossível:

- o primeiro agente que escreve um arquivo vira **dono** dele na execução;
- o dono pode continuar editando à vontade;
- outra instância recebe um erro explicando quem é o dono, e é orientada a
  escolher outro arquivo.

### Agentes do OpenCode

O [OpenCode](https://opencode.ai) guarda agentes como Markdown com frontmatter
YAML. O agent-town **lê esses arquivos** e os transforma em agentes de verdade.

Onde ele procura, do mais específico para o mais global:

```
<projeto>/.opencode/agent/*.md
<projeto>/.opencode/agents/*.md
~/.config/opencode/agent/*.md
~/.config/opencode/agents/*.md
```

Um arquivo assim:

```markdown
---
description: Writes and maintains project documentation
mode: subagent
model: verboo:deepseek-v4.1-flash
permission:
  edit: deny
---

You are a technical writer. Create clear documentation.
```

vira um agente com:

| campo do OpenCode | vira |
|---|---|
| nome do arquivo | `id` do agente |
| corpo do Markdown | system prompt |
| `permission.edit: deny` | somente leitura (`list_files`, `read_file`) |
| `permission.edit: allow` (ou ausente) | com escrita (+ `write_file`, `run_tests`) |
| `tools.write: false` | somente leitura |
| `model` | modelo usado (formato `provider:modelo`) |
| `description` | nome exibido |

Liste o que foi encontrado:

```powershell
curl.exe -s "http://127.0.0.1:4173/api/agents?project=C:\seu-projeto"
```

Para usar numa execução, mande os agentes já convertidos em `extraAgents`:

```powershell
$oc = (curl.exe -s "http://127.0.0.1:4173/api/agents?project=C:\proj" | ConvertFrom-Json).opencode.agents
$body = @{
  task         = "..."
  mode         = "project"
  projectPath  = "C:\proj"
  extraAgents  = $oc
} | ConvertTo-Json -Depth 6
```

Eles entram como instâncias extras: o Planner passa a vê-los e o escalonador os
trata como qualquer outro agente. Sem `model` no frontmatter, herdam o modelo do
Coder.

**Limites da conversão.** O frontmatter é lido por um parser do subconjunto que
o OpenCode usa (`chave: valor` e um nível de aninhamento) — não é YAML completo,
porque o projeto é zero-dependency. O agent-town também não executa shell
arbitrário, então `permission.shell` é ignorado: os agentes só têm as 4
ferramentas internas.

---

## Reuniões de melhoria

No modo real, clique na mesa de reunião para iniciar uma rodada. Os agentes
propõem melhorias uma de cada vez e recebem as propostas anteriores como
contexto para evitar repetição. Em seguida, cada agente registra uma crítica,
uma sugestão e um voto (`approve`, `adjust` ou `reject`) para cada proposta.
Essa rodada é uma análise interna; a decisão final continua sendo do usuário.

Os cards ficam salvos em `.agent-town/proposals.json` e permanecem disponíveis
depois de fechar a reunião ou reiniciar o servidor. As propostas anteriores
também são incluídas no contexto das reuniões futuras para reduzir repetição.
Ao aprovar uma ou mais propostas, a reunião é encerrada, os agentes voltam às
bancadas e a implementação começa imediatamente como um projeto. Rejeitar
apenas altera o status. Ao terminar a execução, os cards ficam em validação e
o usuário pode marcá-los como concluídos. Propostas rejeitadas e arquivadas
continuam no histórico.

Status internos: `proposal`, `analysis`, `approved`, `rejected`,
`implementing`, `validating`, `completed` e `archived`.

### Publicar no GitHub e atualizar o projeto

O projeto real deve ter `origin` apontando para GitHub e autenticacao Git
configurada no computador (Git Credential Manager/SSH). Nao coloque tokens no
URL do remote nem no navegador. A branch principal e descoberta por `origin/HEAD`.

Ao terminar uma execucao com commit, clique em **Publicar na principal do GitHub**
no painel **Alteracoes**. O botao integra o commit ja criado pelos agentes na
principal e faz push, sem force-push e sem adicionar outros arquivos. O GitHub
pode recusar a publicacao por permissao ou protecao de branch; o erro aparece na
tela. Se o push falhar, o commit permanece local e o botao permite tentar novamente.

Recarregar a pagina sincroniza automaticamente a principal do ultimo projeto
executado nesta janela (ou o proprio agent-town, antes de escolher um projeto).
Alteracoes locais, arquivos nao rastreados, reuniao/execucao em andamento e
historicos divergentes bloqueiam a operacao com uma mensagem visivel.
Nao ha stash, reset, merge com conflitos nem force-push automaticos.

Para recarregar tambem o servidor Node quando o codigo dele mudar, inicie o
agent-town com `npm run dev` (watch), em vez de `npm start`. A pagina recarrega
apos uma sincronizacao com novidades; se o watch reiniciar o servidor durante
a requisicao, recarregue novamente quando ele estiver disponivel. Atualizacoes
de dependencias/configuracao e outros projetos com servidores proprios podem
exigir instalacao ou reinicio manual: o agent-town nao reinicia processos externos.
Execucoes e seu commit disponivel para publicacao sao mantidos na sessao do
servidor; apos reiniciar, a branch Git continua existindo para publicacao manual.

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
| `MAX_OUTPUT_TOKENS` | `8192` | teto de **saída** por chamada — baixo demais trunca o `write_file` |
| `AGENTS_PER_ROLE` | `2` | instâncias por função executora (1–3) |
| `MAX_TOKENS` | `200000` | teto de tokens por execução (sempre funciona) |
| `BUDGET_USD` | `0.50` | teto de gasto **estimado** (usa `pricing.json`) |
| `TIMEOUT_SEC` | `600` | tempo máximo da execução |
| `HOST` | `127.0.0.1` | `127.0.0.1` = livre escolha de pasta · `0.0.0.0` = exige `PROJECT_ROOTS` |
| `PROJECT_ROOTS` | — | só obrigatório se expuser o servidor; funciona como allowlist |

### Catálogo Verboo

Quem manda é `GET /models` com a sua chave — `npm run doctor` mostra os IDs
exatos. No plano API pré-pago: `deepseek-v4.1-flash`, `glm-5.3-flash`,
`mimo-v2.6-flash`, `qwen3.8-27b`.

### O valor em dólar NÃO é uma cobrança

O número que aparece na tela (`US$ 0,029`, por exemplo) é uma **estimativa
calculada localmente**: `src/pricing.mjs` multiplica os tokens contados pelo
preço por milhão que está em `pricing.json`. Nenhuma chamada é feita ao
faturamento da Verboo, e o valor não aparece em lugar nenhum da sua conta.

A confusão é justa, porque a API tem dois tipos de chave e só uma delas cobra:

| tipo de chave | como cobra | como medir o consumo |
|---|---|---|
| **plano / assinatura** (`vbk_pro_...`) | mensalidade fixa, uso dentro do plano | headers `X-RateLimit-*` (requisições por janela) |
| **pré-paga** | por token, desconta saldo | `402 Insufficient prepaid balance` quando acaba |

Com chave de plano, **não existe cobrança por token** — a documentação da Verboo
só usa o status `402` para saldo pré-pago insuficiente. O limite real do plano é
de **requisições**: `X-RateLimit-Limit: 40` por minuto, com
`X-RateLimit-Remaining` e `X-RateLimit-Reset` na resposta.

Na prática: use o número em dólar para comparar execuções entre si (esta custou
3× aquela), não como extrato. Para saber o consumo real, olhe as requisições —
o `npm run doctor` e a faixa de limite do painel mostram isso.


Modelo fora do seu plano responde `404 model not available in any of your groups`.

---

## 5. Testes

```powershell
npm test
```

Doze verificações, todas **sem gastar token**:

| teste | o que valida |
|---|---|
| `check` | **sintaxe** de todo `.js`/`.mjs`, grafo de imports/exports e IDs do DOM |
| `smoke` | 1200 frames da máquina de estados com canvas stubado |
| `test-graph` | parsing de JSON, schema, DAG, ciclos, limites |
| `verify-template` | a tarefa do template é resolvível |
| `test-tools` | sandbox: `../`, caminho absoluto, `run_tests`, guarda de escrita |
| `test-project` | allowlist de caminho, `.agent-town.json`, ferramentas plugáveis |
| `test-orchestrator` | grafo real, fallback, contexto, git branch/diff/commit, recusas, **não empilhar branches** |
| `test-adapters` | adaptadores HTTP contra servidor local falso |
| `test-agents` | instâncias por função, permissões do OpenCode, guarda de escrita |
| `test-parallel` | instâncias diferentes se sobrepõem no tempo; a mesma serializa |
| `test-ui` | **`ui.js` carrega e constrói** com DOM falso, aceita todos os eventos |
| `test-budget` | aviso em 80% do teto e relatório de quem gastou |

Duas dessas linhas existem por causa de incidentes reais:

- **`check` agora faz parse de verdade.** A validação anterior era só de imports
  por regex, então um `ui.js` **truncado** (escrito em partes, cortado pelo teto
  de tokens) passava por toda a suíte. No navegador o módulo não carregava, o
  `main.js` nunca rodava, e a tela ficava **preta sem nenhum agente**.
- **`test-ui` executa a UI.** O `smoke` substituía `ui` por um mock, então
  `ui.js` não era executado em teste nenhum — qualquer erro dentro dele só
  aparecia no navegador.

O `test-orchestrator` cobre inclusive o que **não** deve acontecer: recusar
working tree suja, recusar caminho fora das raízes, não commitar lixo não
rastreado, e não herdar a branch de uma execução anterior.

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
                    │  branch + diff + commit local      │
                    └─────────────────────────────────────┘
```

```
src/
├─ orchestrator.mjs   planeja, executa ondas, finaliza com diff
├─ planner.mjs        prompt do Planner + retentativa com o erro
├─ graph.mjs          parsing, validação, DAG, ondas  (puro, testável)
├─ git.mjs            branch, diff, commit local
├─ repository.mjs     sincronizacao e publicacao explicita no GitHub
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
| `rate_limit` | `remaining`, `limit`, `resetAt` | selo de requisições no topo |
| `diff_ready` | `branch`, `files`, `diff` | painel de alterações |

---

## 7. Orçamento: o que acontece quando o teto chega

`MAX_TOKENS` é o teto de tokens (entrada + saída) da **execução inteira**, não
por agente. Quando estoura, a execução para — e sem aviso o agente continua
lendo arquivo até morrer, sem entregar nada.

Duas proteções:

1. **Aviso em 80%.** Quando resta menos de 20% do teto, o agente recebe uma
   mensagem dizendo quantos tokens sobraram e para entregar o que já tem.
   Entregar incompleto é melhor que não entregar.
2. **Relatório de quem gastou.** Ao estourar, o `run_finished` traz os três
   agentes que mais consumiram, para você saber se o problema é o modelo, o
   número de tarefas, ou o tamanho da tarefa.

Ajuste em `.env`:

```env
MAX_TOKENS=500000   # teto da execução inteira
MAX_TASKS=4         # menos tarefas = menos agentes lendo os mesmos arquivos
MAX_STEPS=12        # passos por agente
```

**O teto é compartilhado, e mais agentes gastam mais.** Com `AGENTS_PER_ROLE=2`,
dois coders leem os mesmos arquivos em conversas separadas — o cache de leitura
é por conversa, então não há economia entre instâncias. Se estourar com
frequência, reduza `AGENTS_PER_ROLE` ou `MAX_TASKS` antes de aumentar o teto.

---

## 8. Custo medido

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

## 9. Limitações conhecidas

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

## 10. Próximos passos

1. **Replay** — gravar os eventos em `runs/<id>/events.jsonl` e reproduzir sem custo.
2. **Mais templates** em `templates/` (o seletor já lê a pasta).
3. **Deploy na VPS** — Docker + Caddy, resolve o Gemini e roda 24/7.
4. **Diff aplicável** — botão para aceitar/rejeitar o diff por arquivo.
