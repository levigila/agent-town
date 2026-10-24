const status = document.getElementById('repositoryStatus');

try {
  const response = await fetch('/api/repository/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: localStorage.getItem('agent-town:sync-project') || '' }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  status.textContent = result.updated
    ? `GitHub atualizado (${result.branch}). Recarregando...`
    : `Sincronizado com GitHub (${result.branch}).`;
  if (result.updated) location.reload();
  else await import('./main.js');
} catch (err) {
  status.textContent = `Sincronizacao bloqueada/falhou: ${err.message}`;
  console.error('[agent-town] sincronizacao:', err);
  await import('./main.js');
}
