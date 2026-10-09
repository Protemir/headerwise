import { applyQuery } from '../core/automation.ts';
import { loadState, saveState } from '../core/storage.ts';
import './automation.css';

// Tests wait for the title to become "Headerwise: ready" (or "Headerwise: error"),
// by then the browser has the new rules. Tests written for ModHeader wait for
// "Done", so that is the title when they came through ModHeader's URLs.

const $ = (id: string) => document.getElementById(id)!;
const fromModHeader = new URLSearchParams(location.search).has('@modheader');

function list(id: string, lines: string[]) {
  $(id).replaceChildren(...lines.map(line => Object.assign(document.createElement('li'), { textContent: line })));
}

function done(ok: boolean, text: string) {
  $('status').textContent = text;
  $('status').className = ok ? '' : 'error';
  document.documentElement.dataset.status = ok ? 'ready' : 'error';
  document.title = ok ? (fromModHeader ? 'Done' : 'Headerwise: ready') : 'Headerwise: error';
}

async function run() {
  const result = applyQuery(await loadState(), location.search);
  if (result.state) await saveState(result.state);
  // The background applies the rules and answers once the browser has them.
  await chrome.runtime.sendMessage({ type: 'sync' });
  const { warnings = [] } = await chrome.storage.session.get('warnings') as { warnings?: string[] };
  list('summary', result.summary.length ? result.summary : ['No headers are changed.']);
  list('warnings', [...result.warnings, ...warnings]);
  // "ready" only if the browser really took the headers: a test that goes on
  // without them would fail somewhere far from the cause.
  const broken = warnings.find(w => (w.startsWith('"Automation"') && /skipped|is off/.test(w)) || /refused the rules|rejected the rules|could not apply/.test(w));
  if (result.error) done(false, result.error);
  else if (broken) done(false, broken);
  else done(true, result.state ? 'Done. In effect now:' : 'Nothing changed. In effect now:');
}

run().catch(e => done(false, e instanceof Error ? e.message : String(e)));
