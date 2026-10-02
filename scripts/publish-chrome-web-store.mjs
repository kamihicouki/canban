#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://chromewebstore.googleapis.com';
export async function publishChromeWebStore({ env = process.env, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console.log } = {}) {
  const required = ['CWS_PUBLISHER_ID', 'CWS_EXTENSION_ID', 'CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN', 'CWS_PACKAGE_PATH'];
  const missing = required.filter(key => !env[key]);
  if (missing.length) throw new Error(`設定が不足しています: ${missing.join(', ')}`);
  if (!/^[a-p]{32}$/.test(env.CWS_EXTENSION_ID) || !/^[A-Za-z0-9_-]+$/.test(env.CWS_PUBLISHER_ID)) throw new Error('Invalid publisher or extension ID');
  const mode = env.CWS_MODE || 'upload';
  if (!['upload', 'publish'].includes(mode)) throw new Error('CWS_MODE must be upload or publish');
  const expectedVersion = env.CWS_PACKAGE_VERSION;
  if (expectedVersion && (!/^\d+(\.\d+){0,3}$/.test(expectedVersion) || expectedVersion.split('.').some(n => +n > 65535) || expectedVersion.split('.').every(n => +n === 0))) throw new Error('Invalid package version');
  const bytes = fs.readFileSync(env.CWS_PACKAGE_PATH);
  if (bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('Package is not a ZIP');
  // Do not log request bodies, tokens, or raw OAuth/API errors.
  const tokenResponse = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST', signal: AbortSignal.timeout(30_000),
    body: new URLSearchParams({ client_id: env.CWS_CLIENT_ID, client_secret: env.CWS_CLIENT_SECRET, refresh_token: env.CWS_REFRESH_TOKEN, grant_type: 'refresh_token' }),
  });
  if (!tokenResponse.ok) {
    let code;
    try { code = (await tokenResponse.json()).error; } catch {}
    const knownErrors = ['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope', 'deleted_client'];
    const detail = knownErrors.includes(code) ? `; ${code}` : '';
    throw new Error(`OAuth token refresh failed (HTTP ${tokenResponse.status}${detail})`);
  }
  const { access_token: accessToken } = await tokenResponse.json();
  if (!accessToken) throw new Error('OAuth response has no access token');
  async function api(url, options = {}) {
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(120_000), headers: { ...options.headers, Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error(`Chrome Web Store request failed (HTTP ${response.status}); check Developer Dashboard`);
    return response.json();
  }
  const name = `publishers/${env.CWS_PUBLISHER_ID}/items/${env.CWS_EXTENSION_ID}`;
  const itemUrl = `${API}/v2/${name}`;
  let status = await api(`${itemUrl}:fetchStatus`);
  if (status.takenDown || status.warned) throw new Error('Store policy action requires attention in Developer Dashboard');
  if (['PENDING_REVIEW', 'STAGED'].includes(status.submittedItemRevisionStatus?.state)) throw new Error('An existing submission is pending or staged; resolve it in Developer Dashboard first');
  if (expectedVersion) {
    const candidate = expectedVersion.split('.').map(Number);
    const compareVersion = version => {
      const published = version.split('.').map(Number);
      for (let i = 0; i < 4; i++) {
        const difference = (candidate[i] || 0) - (published[i] || 0);
        if (difference) return difference;
      }
      return 0;
    };
    if (status.publishedItemRevisionStatus?.distributionChannels?.some(channel => compareVersion(channel.crxVersion) <= 0)) throw new Error('Package version must be newer than the published version');
  }
  const upload = await api(`${API}/upload/v2/${name}:upload?uploadType=media`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: bytes });
  let uploadState = upload.uploadState;
  for (let attempt = 0; uploadState === 'IN_PROGRESS' && attempt < 24; attempt++) {
    await sleep(5000);
    status = await api(`${itemUrl}:fetchStatus`);
    uploadState = status.lastAsyncUploadState;
  }
  if (uploadState !== 'SUCCEEDED') throw new Error(`Upload did not succeed (${uploadState || 'unknown'}); publication was not attempted`);
  log(`アップロード成功: ${env.CWS_EXTENSION_ID}${upload.crxVersion ? ` / ${upload.crxVersion}` : ''}`);
  if (expectedVersion && upload.crxVersion && upload.crxVersion !== expectedVersion) throw new Error('Uploaded version does not match the verified package');
  if (mode === 'upload') return { state: 'UPLOADED' };
  const submission = await api(`${itemUrl}:publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH', blockOnWarnings: true, skipReview: false }) });
  if (!['PENDING_REVIEW', 'PUBLISHED'].includes(submission.state)) throw new Error(`Unexpected submission state: ${submission.state || 'unknown'}`);
  const readback = await api(`${itemUrl}:fetchStatus`);
  const revision = [readback.submittedItemRevisionStatus, readback.publishedItemRevisionStatus].find(candidate => candidate && (candidate.state === submission.state || (submission.state === 'PENDING_REVIEW' && candidate.state === 'PUBLISHED')) && (!expectedVersion || candidate.distributionChannels?.some(channel => channel.crxVersion === expectedVersion)));
  if (!revision) throw new Error('Submission readback was inconclusive; check Developer Dashboard before retrying');
  const confirmedState = revision.state;
  log(confirmedState === 'PUBLISHED' ? 'ストア掲載済み' : '審査申請済み（ストア掲載は審査承認後）');
  return { state: confirmedState, status: readback, ...(expectedVersion && { version: expectedVersion }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await publishChromeWebStore();
    if (process.env.CWS_REPORT_PATH) {
      const receipt = { state: result.state, version: process.env.CWS_PACKAGE_VERSION, sha256: process.env.CWS_PACKAGE_SHA256, extensionId: process.env.CWS_EXTENSION_ID, sourceSha: process.env.GITHUB_SHA, sourceRef: process.env.GITHUB_REF, runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` };
      fs.writeFileSync(process.env.CWS_REPORT_PATH, `${JSON.stringify(receipt, null, 2)}\n`);
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Chrome Web Store: **${receipt.state}**\n\nVersion: ${receipt.version}\n\nProduction commit: ${receipt.sourceSha}\n\nZIP SHA-256: ${receipt.sha256}\n`);
    }
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
