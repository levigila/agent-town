// Provedor no formato chat/completions compativel com a especificacao da OpenAI
// (que e o formato usado pela Verboo e pela maioria dos agregadores).

import { postJson, getJson } from './http.mjs';

/**
 * Converte as mensagens internas para o formato do provedor.
 * Interno: { role: 'system'|'user'|'assistant'|'tool', content, toolCalls?, toolCallId?, name? }
 */
function toCompatMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
        })),
      };
    }

    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: String(m.content ?? '') };
    }

    return { role: m.role, content: String(m.content ?? '') };
  });
}

function toCompatTools(tools) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters || { type: 'object', properties: {} },
    },
  }));
}

function safeParse(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function createCompatProvider(providerConfig, model) {
  const { apiKey, baseUrl, key, label } = providerConfig;

  return {
    key,
    label,
    model,
    providerKey: key,
    get modelRef() {
      return `${key}:${model}`;
    },

    async chat({ messages, tools, temperature = 0.2, maxTokens = 2048, signal, onRetry }) {
      const body = {
        model,
        messages: toCompatMessages(messages),
        temperature,
        max_tokens: maxTokens,
      };

      const compatTools = toCompatTools(tools);
      if (compatTools) {
        body.tools = compatTools;
        body.tool_choice = 'auto';
      }

      const data = await postJson({
        url: `${baseUrl}/chat/completions`,
        headers: { Authorization: `Bearer ${apiKey}` },
        body,
        signal,
        onRetry,
      });

      const choice = data?.choices?.[0];
      if (!choice) {
        throw new Error(`resposta sem choices: ${JSON.stringify(data).slice(0, 300)}`);
      }

      const msg = choice.message || {};
      const toolCalls = (msg.tool_calls || []).map((c, i) => ({
        id: c.id || `call_${i}_${Date.now().toString(36)}`,
        name: c.function?.name || 'desconhecida',
        args: safeParse(c.function?.arguments),
      }));

      return {
        text: msg.content || '',
        toolCalls,
        finishReason: choice.finish_reason || 'stop',
        usage: {
          in: data?.usage?.prompt_tokens || 0,
          out: data?.usage?.completion_tokens || 0,
        },
      };
    },

    async listModels({ signal } = {}) {
      const data = await getJson({
        url: `${baseUrl}/models`,
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      });
      const list = data?.data || data?.models || [];
      return list.map((m) => m.id || m.name).filter(Boolean);
    },
  };
}
