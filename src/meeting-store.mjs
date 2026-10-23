import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MEETING_PROPOSAL_STATUSES = [
  'proposal',
  'analysis',
  'approved',
  'rejected',
  'implementing',
  'validating',
  'completed',
  'archived',
];

export async function loadProposals(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`arquivo de propostas invalido: ${file}`);
  return parsed.map((proposal) => ({
    ...proposal,
    status: proposal.status === 'pending' ? 'proposal' : proposal.status === 'dismissed' ? 'rejected' : proposal.status,
    statusHistory: Array.isArray(proposal.statusHistory) ? proposal.statusHistory : [],
  }));
}

export async function saveProposals(file, proposals) {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(proposals, null, 2)}\n`, 'utf8');
    await rename(temp, file);
  } catch (err) {
    throw new Error(`falha ao salvar propostas em ${file}: ${err.message}`, { cause: err });
  }
}

export function setProposalStatus(proposal, status, at = Date.now()) {
  if (!MEETING_PROPOSAL_STATUSES.includes(status)) {
    throw new Error(`status de proposta invalido: ${status}`);
  }

  return {
    ...proposal,
    status,
    statusHistory: [...(Array.isArray(proposal.statusHistory) ? proposal.statusHistory : []), { status, at }],
    updatedAt: at,
  };
}
