import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { listAntigravitySessions } from '../server/sources/multi-agents.mjs';

test('listAntigravitySessions resolves project and repo info', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-test-agy-'));
  const configDir = path.join(tmpRoot, 'config', 'projects');
  const agyDir = path.join(tmpRoot, 'antigravity');
  const brainDir = path.join(agyDir, 'brain');
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(brainDir, { recursive: true });

  // 1. Create a dummy project json
  const dummyMainRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'canban-dummy-repo-'));
  await fs.mkdir(path.join(dummyMainRepo, '.git'));
  await fs.writeFile(path.join(dummyMainRepo, '.git', 'HEAD'), 'ref: refs/heads/main\n');

  const projectId = 'proj-canban-123';
  const projectName = 'Canban Core';
  await fs.writeFile(
    path.join(configDir, `${projectId}.json`),
    JSON.stringify({
      id: projectId,
      name: projectName,
      projectResources: {
        resources: [
          {
            gitFolder: {
              folderUri: `file://${dummyMainRepo}`,
              defaultBranch: 'main'
            }
          }
        ]
      }
    })
  );

  // 2. Create a dummy conversation in brain
  const convId = 'conv-test-456';
  const convPath = path.join(brainDir, convId);
  const logDir = path.join(convPath, '.system_generated', 'logs');
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, 'transcript.jsonl'),
    JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      content: 'Hello Antigravity'
    }) + '\n'
  );

  try {
    const res = await listAntigravitySessions({ antigravityDir: agyDir });
    assert.equal(res.error, null);
    const sessions = res.sessions;
    assert.equal(sessions.length, 1);
    const s = sessions[0];

    // Check project metadata
    assert.ok(s.sourceMetadata.antigravityProject, 'should have antigravityProject');
    assert.equal(s.sourceMetadata.antigravityProject.ref.kind, 'project');
    assert.equal(s.sourceMetadata.antigravityProject.ref.nativeId, projectId);
    assert.equal(s.sourceMetadata.antigravityProject.name, projectName);
    // Check repo resolution
    assert.equal(s.repoName, path.basename(dummyMainRepo));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.rm(dummyMainRepo, { recursive: true, force: true });
  }
});
