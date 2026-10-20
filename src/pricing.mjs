// Preços por modelo, para estimar custo.
//
// O arquivo é opcional: copie pricing.example.json para pricing.json.
// A chave "_default" é usada para modelos fora da lista — sem ela, um modelo
// desconhecido custaria 0 e o teto BUDGET_USD ficaria cego.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export function loadPricing(root) {
  const file = path.join(root, 'pricing.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function priceOf(pricing, model) {
  const entry = pricing?.[model] || pricing?._default;
  if (!entry) return null;
  return {
    input: Number(entry.input_per_1m) || 0,
    output: Number(entry.output_per_1m) || 0,
  };
}

export function costOf(pricing, model, usage) {
  const price = priceOf(pricing, model);
  if (!price) return 0;
  return ((usage?.in || 0) / 1e6) * price.input + ((usage?.out || 0) / 1e6) * price.output;
}
