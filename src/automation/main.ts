import { applyQuery } from '../core/automation.ts';
import { loadState, saveState } from '../core/storage.ts';
import './automation.css';

// Tests wait for the title to become "Headerwise: ready" (or "Headerwise: error"),
// by then the browser has the new rules.

const $ = (id: string) => document.getElementById(id)!;

function list(id: string, lines: string[]) {
  $(id).replaceChildren(...lines.map(line => Object.assign(document.createElement('li'), { textContent: line })));
}

function done(ok: boolean, text: string) {
  $('status').textContent = text;
  $('status').className = ok ? '' : 'error';
  document.documentElement.dataset.status = ok ? 'ready' : 'error';
  document.title = ok ? 'Headerwise: ready' : 'Headerwise: error';
}

async function run() {
  const result = applyQuery(await loadState(), location.search);
  if (result.state) await saveState(result.state);
  // The background applies the rules and answers once the browser has them.
  await chrome.runtime.sendMessage({ type: 'sync' });
  const { warnings = [] } = await chrome.storage.session.get('warnings') as { warnings?: string[] };
  list('summary', result.summary.length ? result.summary : ['No headers are changed.']);
  list('warnings', [...result.warnings, ...warnings]);
  if (result.error) done(false, result.error);
  else done(true, result.state ? 'Done. In effect now:' : 'Nothing changed. In effect now:');
}

run().catch(e => done(false, e instanceof Error ? e.message : String(e)));
