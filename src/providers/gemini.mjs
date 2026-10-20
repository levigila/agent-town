// Provedor Google Gemini (generateContent).
//
// O formato é bem diferente do [OI]: system vira systemInstruction,
// o assistente é "model", e resultado de ferramenta vira functionResponse
// dentro de um turno "user".

import { postJson, getJson } from './http.mjs';

function toGeminiContents(messages) {
  const systemParts = [];
  const contents = [];

  const push = (role, parts) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
      return;
    }
    contents.push({ role, parts });
  };

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) systemParts.push({ text: String(m.content) });
      continue;
    }

    if (m.role === 'user') {
      push('user', [{ text: String(m.content ?? '') }]);
      continue;
    }

    if (m.role === 'assistant') {
      const parts = [];
      if (m.content) parts.push({ text: String(m.content) });
      for (const call of m.toolCalls || []) {
        parts.push({ functionCall: { name: call.name, args: call.args || {} } });
      }
      push('model', parts);
      continue;
    }

    if (m.role === 'tool') {
      push('user', [
        {
          functionResponse: {
            name: m.name || 'ferramenta',
            response: { result: String(m.content ?? '') },
          },
        },
      ]);
    }
  }

  return { systemParts, contents };
}

function toGeminiTools(tools) {
  if (!tools?.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters || { type: 'object', properties: {} },
      })),
    },
  ];
}

export function createGeminiProvider(providerConfig, model) {
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
      const { systemParts, contents } = toGeminiContents(messages);

      const body = {
        contents,
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
        },
      };

      if (systemParts.length) {
        body.systemInstruction = { parts: systemParts };
      }

      const gemTools = toGeminiTools(tools);
      if (gemTools) body.tools = gemTools;

      const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const data = await postJson({ url, headers: {}, body, signal, onRetry });

      const candidate = data?.candidates?.[0];
      if (!candidate) {
        const reason = data?.promptFeedback?.blockReason || 'sem candidates';
        throw new Error(`Gemini nao retornou conteudo (${reason})`);
      }

      const parts = candidate?.content?.parts || [];
      const text = parts
        .filter((p) => typeof p.text === 'string')
        .map((p) => p.text)
        .join('')
        .trim();

      const toolCalls = parts
        .filter((p) => p.functionCall)
        .map((p, i) => ({
          id: `gem_${Date.now().toString(36)}_${i}`,
          name: p.functionCall.name,
          args: p.functionCall.args || {},
        }));

      return {
        text,
        toolCalls,
        finishReason: candidate.finishReason || 'STOP',
        usage: {
          in: data?.usageMetadata?.promptTokenCount || 0,
          out: data?.usageMetadata?.candidatesTokenCount || 0,
        },
      };
    },

    async listModels({ signal } = {}) {
      const data = await getJson({
        url: `${baseUrl}/models?key=${encodeURIComponent(apiKey)}`,
        headers: {},
        signal,
      });
      return (data?.models || [])
        .map((m) => String(m.name || '').replace(/^models\//, ''))
        .filter(Boolean);
    },
  };
}
