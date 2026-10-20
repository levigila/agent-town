// Prepara o workspace de uma execução a partir de um template.

import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

export const TEMPLATES = {
  'price-parser': path.join(ROOT, 'templates', 'price-parser'),
};

/** Diretório base das execuções. Lido a cada chamada para permitir override. */
export function runsDir() {
  return process.env.AGENT_TOWN_RUNS_DIR
    ? path.resolve(process.env.AGENT_TOWN_RUNS_DIR)
    : path.join(ROOT, 'runs');
}

/**
 * Copia o template para <runs>/<runId>/workspace e cria a pasta de logs.
 * @returns {Promise<{runDir: string, workspace: string, tmpDir: string}>}
 */
export async function seedWorkspace(runId, templateName = 'price-parser') {
  const template = TEMPLATES[templateName];
  if (!template) throw new Error(`template desconhecido: ${templateName}`);

  const runDir = path.join(runsDir(), runId);
  const workspace = path.join(runDir, 'workspace');
  const tmpDir = path.join(runDir, '.tmp');

  await rm(runDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  await cp(template, workspace, { recursive: true });

  return { runDir, workspace, tmpDir };
}
