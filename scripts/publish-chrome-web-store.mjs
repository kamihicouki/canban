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
  const bytes = fs.readFileSync(env.CWS_PACKAGE_PATH);
  if (bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('Package is not a ZIP');
  // Do not log request bodies, tokens, or raw OAuth/API errors.
  const tokenResponse = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST', signal: AbortSignal.timeout(30_000),
    body: new URLSearchParams({ client_id: env.CWS_CLIENT_ID, client_secret: env.CWS_CLIENT_SECRET, refresh_token: env.CWS_REFRESH_TOKEN, grant_type: 'refresh_token' }),
  });
  if (!tokenResponse.ok) throw new Error(`OAuth token refresh failed (HTTP ${tokenResponse.status})`);
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
  const upload = await api(`${API}/upload/v2/${name}:upload?uploadType=media`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: bytes });
  let uploadState = upload.uploadState;
  for (let attempt = 0; uploadState === 'IN_PROGRESS' && attempt < 24; attempt++) {
    await sleep(5000);
    status = await api(`${itemUrl}:fetchStatus`);
    uploadState = status.lastAsyncUploadState;
  }
  if (uploadState !== 'SUCCEEDED') throw new Error(`Upload did not succeed (${uploadState || 'unknown'}); publication was not attempted`);
  log(`アップロード成功: ${env.CWS_EXTENSION_ID}${upload.crxVersion ? ` / ${upload.crxVersion}` : ''}`);
  if (mode === 'upload') return { state: 'UPLOADED' };
  const submission = await api(`${itemUrl}:publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH', blockOnWarnings: true, skipReview: false }) });
  if (!['PENDING_REVIEW', 'PUBLISHED'].includes(submission.state)) throw new Error(`Unexpected submission state: ${submission.state || 'unknown'}`);
  const readback = await api(`${itemUrl}:fetchStatus`);
  const confirmedState = readback.submittedItemRevisionStatus?.state || readback.publishedItemRevisionStatus?.state;
  if (confirmedState !== submission.state && !(submission.state === 'PENDING_REVIEW' && confirmedState === 'PUBLISHED')) throw new Error('Submission readback was inconclusive; check Developer Dashboard before retrying');
  log(confirmedState === 'PUBLISHED' ? 'ストア掲載済み' : '審査申請済み（ストア掲載は審査承認後）');
  return { state: confirmedState, status: readback };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await publishChromeWebStore(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
