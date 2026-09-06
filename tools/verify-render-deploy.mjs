#!/usr/bin/env node
/** Read-only Render release verification. Never triggers deploys, switches branches or logs secrets. */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const expectedCommit = process.argv[2] || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const expectedBranch = 'arena/01a073df-core-wh';
const serviceIds = (process.env.AYROVI_RENDER_SERVICE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const token = process.env.RENDER_API_KEY;
const timeoutMs = Math.min(Number(process.env.AYROVI_DEPLOY_TIMEOUT_MS || 600000), 1200000);
const result = { checkedAt: new Date().toISOString(), expectedCommit, expectedBranch, finalStatus: 'NOT READY', deploymentVerified: false, services: [], blockers: [] };

async function render(path) {
  const response = await fetch(`https://api.render.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Render API returned HTTP ${response.status}`);
  return response.json();
}
async function verify(id) {
  const response = await render(`services/${encodeURIComponent(id)}`);
  const service = response.service || response;
  const row = { id, name: service.name ?? 'unknown', branch: service.branch ?? 'unknown', commitDeployed: null,
    deployStatus: 'NOT VERIFIED', healthCheck: 'NOT VERIFIED', productionUrl: service.serviceDetails?.url ?? null, blockers: [] };
  result.services.push(row);
  const repo = (service.repo || '').replace(/\.git$/, '').replace(/\/$/, '');
  if (repo !== 'https://github.com/issamweldlatifa-gif/Core-wh') row.blockers.push('Repository link does not match the approved repository.');
  if (row.branch !== expectedBranch) row.blockers.push('Render follows another/unknown branch; no branch change was attempted.');
  if (!['yes', true].includes(service.autoDeploy)) row.blockers.push('Automatic deployment is disabled or unverified.');
  if (row.blockers.length) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await render(`services/${encodeURIComponent(id)}/deploys?limit=20`);
    const deployments = list.map((entry) => entry.deploy || entry);
    const deployment = deployments.find((entry) => entry.commit?.id === expectedCommit);
    if (deployment) {
      row.commitDeployed = deployment.commit.id;
      row.deployStatus = deployment.status;
      if (['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled', 'deactivated'].includes(deployment.status)) {
        row.blockers.push('The matching commit did not deploy successfully. Inspect the service logs.'); return;
      }
      if (deployment.status === 'live') break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  if (row.deployStatus !== 'live') { row.blockers.push('No live deployment of the expected commit was observed before timeout.'); return; }
  if (!row.productionUrl?.startsWith('https://')) { row.blockers.push('Public HTTPS service URL is not available.'); return; }
  const health = await fetch(`${row.productionUrl.replace(/\/$/, '')}/api/v1/system/health`, { signal: AbortSignal.timeout(15000) });
  if (!health.ok) { row.healthCheck = `FAILED HTTP ${health.status}`; row.blockers.push('Health check failed.'); return; }
  const payload = await health.json();
  if (payload.status !== 'ok' || payload.database !== 'up' || payload.build?.commitFull !== expectedCommit) {
    row.healthCheck = 'FAILED: unhealthy database or commit mismatch'; row.blockers.push('HTTP200 alone does not prove this commit is healthy.'); return;
  }
  row.healthCheck = 'PASS: API, database and exact commit match';
}

try {
  if (!/^[a-f0-9]{40}$/i.test(expectedCommit)) throw new Error('Expected commit must be a full Git SHA.');
  if (!token) result.blockers.push('Render connection missing: configure RENDER_API_KEY in the approved secret environment.');
  if (!serviceIds.length) result.blockers.push('Service inventory missing: configure AYROVI_RENDER_SERVICE_IDS with approved web service IDs.');
  if (!result.blockers.length) {
    for (const id of serviceIds) {
      try { await verify(id); } catch (error) { result.blockers.push(`${id}: ${error.message}`); }
    }
    if (result.services.length === serviceIds.length && result.services.every((row) => row.blockers.length === 0 && row.healthCheck.startsWith('PASS')) && !result.blockers.length) {
      result.deploymentVerified = true;
      result.blockers.push('Commit/health verified. Build/runtime log review and warehouse release gates still require documented approval.');
    }
  }
} catch (error) { result.blockers.push(error.message); }
const output = JSON.stringify(result, null, 2);
console.log(output);
if (process.env.AYROVI_DEPLOY_REPORT_FILE) writeFileSync(process.env.AYROVI_DEPLOY_REPORT_FILE, `${output}\n`, { mode: 0o600 });
process.exitCode = result.finalStatus === 'READY' ? 0 : 2;
