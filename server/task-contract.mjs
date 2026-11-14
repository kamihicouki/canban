// The goal-contract model lives in ui/task-contract-model.js so the board and the server judge readiness the same way.
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../ui/task-contract-model.js', import.meta.url), 'utf8');
const model = vm.runInNewContext(`${source}\n({ CONTRACT_LEVELS, VERIFY_KINDS, CONTRACT_GATES, normalizeVerify, normalizeContract, criterionWarning, contractReadiness, contractMissingText, contractGateLabel });`, { Error }); // host Error, so callers' instanceof checks hold

export const { CONTRACT_LEVELS, VERIFY_KINDS, CONTRACT_GATES, normalizeVerify, normalizeContract, criterionWarning, contractReadiness, contractMissingText, contractGateLabel } = model;

export const contractSchema = {
  type: 'object',
  properties: {
    level: { type: 'integer', enum: [0, 1, 2] },
    goal: { type: 'string', maxLength: 500 },
    criteria: { type: 'array', maxItems: 20, items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { text: { type: 'string' }, verify: { type: ['object', 'null'], properties: { kind: { type: 'string', enum: Object.keys(VERIFY_KINDS) }, value: { type: 'string' } } } }, required: ['text'] }] } },
    principles: { type: 'string', maxLength: 4000 },
    maxRounds: { type: 'integer', minimum: 1, maximum: 20 },
    timeLimitMin: { type: 'integer', minimum: 5, maximum: 1440 },
    gates: { type: 'array', maxItems: 4, items: { anyOf: [{ type: 'string', enum: Object.keys(CONTRACT_GATES) }, { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }] } },
  },
  additionalProperties: false,
};

// The top-level cycle the contract describes (the first loop without a parent).
export const contractCycle = loop => loop?.cycles?.find(c => !c.parentId) || null;
