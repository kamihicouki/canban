// Isolated regression fixture: make the global listing genuinely unable to finish.
// Other exports remain the real reader, so session detail follows production code.
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`
export async function load(url, context, nextLoad) {
  if (url.endsWith('/server/sources/claude.mjs')) {
    return { format: 'module', shortCircuit: true, source:
      'export * from ' + JSON.stringify(url + '?real-reader') + ';\\n' +
      'export let stalledListingCalls = 0; export function listClaudeSessions(){ stalledListingCalls++; return new Promise(()=>{}); }'
    };
  }
  return nextLoad(url, context);
}
`), import.meta.url);
