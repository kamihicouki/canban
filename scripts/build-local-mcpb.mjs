#!/usr/bin/env node
// Build the official Desktop extension from committed Git files only.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildLocalPlugin } from './build-local-plugin.mjs';

const distribution = buildLocalPlugin();
const output = path.resolve(distribution.outputDirectory, '..', 'canban.mcpb');
const result = spawnSync('npx', ['-y', '@anthropic-ai/mcpb@2', 'pack', '.', output], {
 cwd: distribution.outputDirectory,
 stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
