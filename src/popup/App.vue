<script setup lang="ts">
import { computed, onMounted, ref, toRaw, watch } from 'vue';
import { defaultState, emptyHeader, emptyProfile, isSecret, maskValue, newId, type HeaderMod, type State } from '../core/model.ts';
import { importModHeader } from '../core/import-modheader.ts';
import { loadState, saveState } from '../core/storage.ts';
import type { RuleInfo } from '../core/dnr.ts';
import { tabReport, type MatchedRule, type TabLine } from '../core/explain.ts';
import { parsePasted } from '../core/paste.ts';
import { addHeaders, applyPreset, PRESETS, REQUEST_HEADER_NAMES, RESPONSE_HEADER_NAMES } from '../core/presets.ts';

const ALL_SITES = { origins: ['<all_urls>'] };

const state = ref<State>(defaultState());
const loaded = ref(false);
const selected = ref(0);
const warnings = ref<string[]>([]);
const hasAccess = ref(true);
const importText = ref('');
const showImport = ref(false);

const profile = computed(() => state.value.profiles[selected.value]);

onMounted(async () => {
  state.value = await loadState();
  hasAccess.value = await chrome.permissions.contains(ALL_SITES);
  await refreshWarnings();
  await refreshTab();
  loaded.value = true;
  chrome.storage.session.onChanged.addListener(refreshWarnings);
});

// What the background script left for us: warnings, and which profile each rule belongs to.
const ruleInfo = ref<Record<number, RuleInfo>>({});
const rulesUpdatedAt = ref(0);

async function refreshWarnings() {
  const got = await chrome.storage.session.get(['warnings', 'ruleInfo', 'rulesUpdatedAt']);
  warnings.value = (got.warnings as string[] | undefined) ?? [];
  ruleInfo.value = (got.ruleInfo as Record<number, RuleInfo> | undefined) ?? {};
  rulesUpdatedAt.value = (got.rulesUpdatedAt as number | undefined) ?? 0;
}

// "On this tab". Opening the popup grants activeTab, which lets us ask Chrome
// which of our rules matched requests in the current tab. (?tab=<id> is for tests.)
const tab = ref<{ id: number; url: string; host: string } | null>(null);
const tabNote = ref('');
const tabAccess = ref(true);
const matched = ref<MatchedRule[]>([]);

async function refreshTab() {
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  const t = forced ? await chrome.tabs.get(forced) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!t?.id || !t.url) return;
  if (!/^https?:/.test(t.url)) {
    tab.value = null;
    tabNote.value = "Browsers don't let extensions change headers on this page.";
    return;
  }
  tab.value = { id: t.id, url: t.url, host: new URL(t.url).host };
  tabAccess.value = await chrome.permissions.contains({ origins: [`${new URL(t.url).origin}/*`] });
  try {
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId: t.id });
    matched.value = rulesMatchedInfo
      .filter(m => m.rule.rulesetId === chrome.declarativeNetRequest.DYNAMIC_RULESET_ID || m.rule.rulesetId === chrome.declarativeNetRequest.SESSION_RULESET_ID)
      .map(m => ({ ruleId: m.rule.ruleId, timeStamp: m.timeStamp }));
    tabNote.value = '';
  } catch (e) {
    // e.g. Chrome's limit on how often this can be asked
    tabNote.value = `Chrome can't say right now which rules matched here (${e instanceof Error ? e.message : String(e)}).`;
  }
}

const tabLines = computed(() => tab.value
  ? tabReport(state.value, tab.value.url, matched.value, ruleInfo.value, rulesUpdatedAt.value, tab.value.id)
  : []);
const needsReload = computed(() => tabLines.value.some(l => l.line.kind === 'waiting'));

function describe(line: TabLine): string {
  switch (line.kind) {
    case 'applied': return `changed ${line.requests} request${line.requests === 1 ? '' : 's'}${line.skippedBy ? `; skipped where never on ${line.skippedBy} matches` : ''}`;
    case 'excluded': return `skipped here: never on ${line.pattern} matches this page`;
    case 'not-included': return `only on ${line.patterns.join(', ')}: this page doesn't match (its requests to other sites still can)`;
    case 'waiting': return 'nothing changed here since your last edit: reload the tab';
    case 'off': return 'turned off';
    case 'empty': return 'no headers yet';
    case 'other-tab': return `only in another tab (${line.host})`;
  }
}

async function reloadTab() {
  if (!tab.value) return;
  await chrome.tabs.reload(tab.value.id);
  setTimeout(refreshTab, 1500);
}

let timer: ReturnType<typeof setTimeout> | undefined;
watch(state, () => {
  if (!loaded.value) return;
  clearTimeout(timer);
  timer = setTimeout(() => saveState(structuredClone(toRaw(state.value))), 250);
}, { deep: true });

async function grantAccess() {
  hasAccess.value = await chrome.permissions.request(ALL_SITES);
  await refreshTab();
}

// Quick input: a request copied from DevTools, or a preset.
const showPaste = ref(false);
const pasteText = ref('');
const pasted = computed(() => (pasteText.value.trim() ? parsePasted(pasteText.value) : null));
const pastePicked = ref<boolean[]>([]);
watch(pasted, r => { pastePicked.value = r ? r.headers.map(h => h.suggested) : []; });
const pasteHost = computed(() => {
  try { return pasted.value?.url ? new URL(pasted.value.url).hostname : ''; } catch { return ''; }
});
const pasteOnlyHost = ref(true);
const canLimitToHost = computed(() => pasteHost.value !== '' && !profile.value.filters.some(f => f.kind === 'include'));

function addPasted() {
  const r = pasted.value;
  if (!r) return;
  addHeaders(profile.value.requestHeaders, r.headers.filter((_, i) => pastePicked.value[i]).map(h => ({ name: h.name, value: h.value })));
  if (canLimitToHost.value && pasteOnlyHost.value) {
    profile.value.filters.push({ id: newId(), enabled: true, kind: 'include', pattern: `||${pasteHost.value}^`, isRegex: false });
  }
  pasteText.value = '';
  showPaste.value = false;
}

const presetChoice = ref('');
function onPreset() {
  const preset = PRESETS.find(x => x.id === presetChoice.value);
  if (preset) applyPreset(profile.value, preset);
  presetChoice.value = '';
}

function addHeader(list: HeaderMod[]) {
  list.push(emptyHeader());
}

// "Only this tab": bind the profile to the tab the popup was opened on.
function bindToTab() {
  if (tab.value) profile.value.tab = { id: tab.value.id, host: tab.value.host };
}
function unbindTab() {
  delete profile.value.tab;
}

// Secret values are shown as dots until revealed (not saved: back to dots next time).
const revealed = ref(new Set<string>());
function toggleReveal(h: HeaderMod) {
  if (revealed.value.has(h.id)) revealed.value.delete(h.id);
  else revealed.value.add(h.id);
}
function toggleSecret(h: HeaderMod) {
  h.secret = !isSecret(h);
  revealed.value.delete(h.id);
}
const masked = (h: HeaderMod) => isSecret(h) && !revealed.value.has(h.id) && h.op !== 'remove';

function removeAt<T>(list: T[], i: number) {
  list.splice(i, 1);
}

function addProfile() {
  state.value.profiles.push(emptyProfile(`Profile ${state.value.profiles.length + 1}`));
  selected.value = state.value.profiles.length - 1;
}

function deleteProfile() {
  if (state.value.profiles.length === 1) return;
  state.value.profiles.splice(selected.value, 1);
  selected.value = Math.max(0, selected.value - 1);
}

function addFilter(kind: 'include' | 'exclude') {
  profile.value.filters.push({ id: newId(), enabled: true, kind, pattern: '', isRegex: kind === 'include' });
}

function filterPlaceholder(kind: 'include' | 'exclude', isRegex: boolean): string {
  if (isRegex) return kind === 'exclude' ? 'regex, e.g. /login' : 'regex, e.g. ^https://api\\.example\\.com/';
  return kind === 'exclude' ? 'example.com or *login*' : '||example.com^';
}

function doImport() {
  const res = importModHeader(importText.value);
  if (res.profiles.length) {
    state.value.profiles.push(...res.profiles);
    selected.value = state.value.profiles.length - res.profiles.length;
    importText.value = '';
    showImport.value = false;
  }
  warnings.value = res.warnings;
}

function openMigrate() {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/migrate/index.html') });
  window.close();
}

async function importFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) importText.value = await file.text();
}
</script>

<template>
  <main v-if="loaded">
    <header class="bar">
      <strong>Headerwise</strong>
      <label class="pause"><input type="checkbox" v-model="state.paused" /> Pause all</label>
    </header>

    <p v-if="!hasAccess" class="notice">
      Headerwise needs access to sites to change their headers.
      <button @click="grantAccess">Allow on all sites</button>
    </p>

    <section v-if="tab || tabNote" class="here">
      <h3>On this tab<template v-if="tab"> · <span class="host">{{ tab.host }}</span></template></h3>
      <p v-if="state.paused" class="dim">Paused: nothing is changed anywhere.</p>
      <template v-else-if="tab">
        <p v-if="hasAccess && !tabAccess" class="dim">Headerwise has no access to this site, so nothing is changed here.</p>
        <ul class="lines">
          <li v-for="l in tabLines" :key="l.profileId" :class="l.line.kind">
            <strong>{{ l.title }}</strong> {{ describe(l.line) }}
          </li>
        </ul>
        <button v-if="needsReload" @click="reloadTab">Reload tab</button>
      </template>
      <p v-if="tabNote" class="dim">{{ tabNote }}</p>
    </section>

    <nav class="tabs">
      <button
        v-for="(p, i) in state.profiles"
        :key="p.id"
        :class="{ on: i === selected, off: !p.enabled }"
        @click="selected = i"
      >
        {{ p.title || 'Untitled' }}
      </button>
      <button title="Add profile" @click="addProfile">+</button>
    </nav>

    <section v-if="profile">
      <div class="row">
        <input type="checkbox" v-model="profile.enabled" title="Profile on/off" />
        <input class="grow" v-model="profile.title" placeholder="Profile name" />
        <span v-if="profile.tab" class="chip" :title="profile.tab.id === tab?.id ? 'Applies only in this tab' : 'Applies only in another tab'">
          only in {{ profile.tab.id === tab?.id ? 'this tab' : 'another tab' }} · {{ profile.tab.host }}
          <button class="x" title="Apply in all tabs again" @click="unbindTab">×</button>
        </span>
        <button v-else-if="tab" title="Apply this profile only in the current tab, until it closes" @click="bindToTab">Only this tab</button>
        <button :disabled="state.profiles.length === 1" title="Delete profile" @click="deleteProfile">Delete</button>
      </div>

      <h3>Request headers</h3>
      <div v-for="(h, i) in profile.requestHeaders" :key="h.id" class="row">
        <input type="checkbox" v-model="h.enabled" />
        <select v-model="h.op">
          <option>set</option>
          <option>append</option>
          <option>remove</option>
        </select>
        <input v-model="h.name" placeholder="Name" list="request-names" />
        <input class="grow" v-model="h.value" :disabled="h.op === 'remove'" placeholder="Value" :class="{ masked: masked(h) }" autocomplete="off" spellcheck="false" />
        <button v-if="isSecret(h) && h.op !== 'remove'" class="icon" :class="{ on: revealed.has(h.id) }" :title="revealed.has(h.id) ? 'Hide value' : 'Show value'" @click="toggleReveal(h)">👁</button>
        <span v-else class="icon-space"></span>
        <button class="icon" :class="{ on: isSecret(h) }" :title="isSecret(h) ? 'Secret: value hidden. Click to show it always' : 'Mark as secret: hide the value'" @click="toggleSecret(h)">🔒</button>
        <button title="Remove" @click="removeAt(profile.requestHeaders, i)">×</button>
      </div>
      <div class="row">
        <button class="link" @click="addHeader(profile.requestHeaders)">+ request header</button>
        <button class="link" @click="showPaste = !showPaste">Paste from DevTools…</button>
        <select class="preset" v-model="presetChoice" @change="onPreset" title="Add a ready-made set of headers">
          <option value="">+ preset…</option>
          <option v-for="x in PRESETS" :key="x.id" :value="x.id">{{ x.label }}</option>
        </select>
      </div>
      <div v-if="showPaste" class="import">
        <textarea v-model="pasteText" rows="4" placeholder="In DevTools → Network, right-click a request → Copy as cURL, fetch or PowerShell, and paste it here. Plain &quot;Name: value&quot; lines work too."></textarea>
        <template v-if="pasted">
          <p v-if="!pasted.headers.length" class="dim">No headers found in that text.</p>
          <label v-for="(h, i) in pasted.headers" :key="h.name" class="pasted">
            <input type="checkbox" v-model="pastePicked[i]" />
            <code>{{ h.name }}</code>
            <span class="val">{{ isSecret(h) ? maskValue(h.value) : h.value }}</span>
          </label>
          <label v-if="canLimitToHost" class="pasted"><input type="checkbox" v-model="pasteOnlyHost" /> only on {{ pasteHost }}</label>
          <button :disabled="!pastePicked.some(Boolean)" @click="addPasted">Add {{ pastePicked.filter(Boolean).length }} header{{ pastePicked.filter(Boolean).length === 1 ? '' : 's' }}</button>
        </template>
      </div>

      <h3>Response headers</h3>
      <div v-for="(h, i) in profile.responseHeaders" :key="h.id" class="row">
        <input type="checkbox" v-model="h.enabled" />
        <select v-model="h.op">
          <option>set</option>
          <option>append</option>
          <option>remove</option>
        </select>
        <input v-model="h.name" placeholder="Name" list="response-names" />
        <input class="grow" v-model="h.value" :disabled="h.op === 'remove'" placeholder="Value" :class="{ masked: masked(h) }" autocomplete="off" spellcheck="false" />
        <button v-if="isSecret(h) && h.op !== 'remove'" class="icon" :class="{ on: revealed.has(h.id) }" :title="revealed.has(h.id) ? 'Hide value' : 'Show value'" @click="toggleReveal(h)">👁</button>
        <span v-else class="icon-space"></span>
        <button class="icon" :class="{ on: isSecret(h) }" :title="isSecret(h) ? 'Secret: value hidden. Click to show it always' : 'Mark as secret: hide the value'" @click="toggleSecret(h)">🔒</button>
        <button title="Remove" @click="removeAt(profile.responseHeaders, i)">×</button>
      </div>
      <button class="link" @click="addHeader(profile.responseHeaders)">+ response header</button>

      <h3>Only on / never on</h3>
      <div v-for="(f, i) in profile.filters" :key="f.id" class="row">
        <input type="checkbox" v-model="f.enabled" />
        <select v-model="f.kind">
          <option value="include">only on</option>
          <option value="exclude">never on</option>
        </select>
        <input class="grow" v-model="f.pattern" :placeholder="filterPlaceholder(f.kind, f.isRegex)" />
        <label class="small"><input type="checkbox" v-model="f.isRegex" /> regex</label>
        <button title="Remove" @click="removeAt(profile.filters, i)">×</button>
      </div>
      <button class="link" @click="addFilter('include')">+ only on…</button>
      <button class="link" @click="addFilter('exclude')">+ never on…</button>
    </section>

    <section>
      <button class="link" @click="openMigrate">Move from ModHeader (turned off in Chrome)</button>
      <button class="link" @click="showImport = !showImport">Import ModHeader JSON</button>
      <div v-if="showImport" class="import">
        <input type="file" accept=".json,application/json" @change="importFile" />
        <textarea v-model="importText" rows="5" placeholder="…or paste the exported JSON here"></textarea>
        <button :disabled="!importText.trim()" @click="doImport">Import</button>
      </div>
    </section>

    <ul v-if="warnings.length" class="warnings">
      <li v-for="(w, i) in warnings" :key="i">{{ w }}</li>
    </ul>

    <datalist id="request-names"><option v-for="n in REQUEST_HEADER_NAMES" :key="n" :value="n" /></datalist>
    <datalist id="response-names"><option v-for="n in RESPONSE_HEADER_NAMES" :key="n" :value="n" /></datalist>

    <footer>Runs locally. No account, no analytics, nothing is sent anywhere.</footer>
  </main>
</template>
