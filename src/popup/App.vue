<script setup lang="ts">
import { computed, onMounted, ref, toRaw, watch } from 'vue';
import { defaultState, duplicateProfile, emptyHeader, emptyProfile, isSecret, moveProfile, maskValue, newId, REQUEST_METHODS, RESOURCE_TYPES, type HeaderMod, type Profile, type State } from '../core/model.ts';
import { exportFileName, exportProfiles, importProfiles } from '../core/export.ts';
import { VARIABLES } from '../core/variables.ts';
import { loadState, saveState } from '../core/storage.ts';
import type { RuleInfo } from '../core/dnr.ts';
import { scopeSummary, tabReport, type MatchedRule, type TabLine } from '../core/explain.ts';
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
const exact = ref(true);

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
  if (typeof chrome.declarativeNetRequest.getMatchedRules !== 'function') {
    // Firefox doesn't report matched rules to extensions.
    exact.value = false;
    tabNote.value = "This browser doesn't tell extensions which rules matched, so this is based on the page address.";
    return;
  }
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
  ? tabReport(state.value, tab.value.url, matched.value, ruleInfo.value, rulesUpdatedAt.value, tab.value.id, exact.value)
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
    case 'narrowed': return `only ${line.scope}: none here since your last edit`;
    case 'page-match': return 'applies to this page';
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

// Shown once a value uses {{...}}. Built here: braces in the template would be Vue syntax.
const usesVariables = computed(() => [...(profile.value?.requestHeaders ?? []), ...(profile.value?.responseHeaders ?? [])].some(h => h.value.includes('{{')));
const variablesHint = `Variables: ${VARIABLES.map(v => `{{${v.name}}}`).join(', ')}. Chrome sends fixed values, so Headerwise fills them in on every edit and once a minute: requests within that minute share one value.`;

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

// "Rate Headerwise": once, two weeks after install; never again once clicked or closed.
const RATE_URL = 'https://chromewebstore.google.com/detail/jedoaeaapdofoldmkacjbpojbnpapkna/reviews';
const ISSUES_URL = 'https://github.com/Protemir/headerwise/issues/new';
const showRate = ref(false);
onMounted(async () => {
  const { meta } = await chrome.storage.local.get('meta');
  showRate.value = !!meta?.installedAt && Date.now() - meta.installedAt > 14 * 24 * 3600 * 1000 && !meta.rateDone;
});
async function rateDone(open: boolean) {
  if (open) chrome.tabs.create({ url: RATE_URL });
  showRate.value = false;
  const { meta } = await chrome.storage.local.get('meta');
  await chrome.storage.local.set({ meta: { ...meta, rateDone: true } });
}

// Copy a summary for a bug report. There is no telemetry, so this is how
// problems reach us: header names and settings, no values, profile names or URLs.
const diagnosticsDone = ref('');
async function copyDiagnostics() {
  const dnr = chrome.declarativeNetRequest;
  const [dynamic, session, perms] = await Promise.all([dnr.getDynamicRules(), dnr.getSessionRules(), chrome.permissions.getAll()]);
  const names = (list: HeaderMod[]) => list.filter(h => h.name.trim()).map(h => `${h.enabled ? '' : '(off) '}${h.op} ${h.name.trim()}`).join(', ');
  const s = state.value;
  const text = [
    `Headerwise ${chrome.runtime.getManifest().version}`,
    `Browser: ${navigator.userAgent}`,
    `Paused: ${s.paused ? 'yes' : 'no'}. Site access: ${perms.origins?.length ? perms.origins.join(', ') : 'none'}`,
    `Rules in the browser: ${dynamic.length} dynamic, ${session.length} session`,
    `Profiles (${s.profiles.length}):`,
    ...s.profiles.map((p, i) => [
      `  ${i + 1}. ${p.enabled ? 'on' : 'off'}${p.tab ? ', only one tab' : ''}`,
      `request [${names(p.requestHeaders)}]`,
      `response [${names(p.responseHeaders)}]`,
      `${p.redirects?.filter(r => r.enabled).length ?? 0} redirects`,
      `filters [${p.filters.map(f => `${f.enabled ? '' : '(off) '}${f.kind === 'include' ? 'only on' : 'never on'}${f.isRegex ? ' regex' : ''}`).join(', ')}]`,
      ...(scopeSummary(p) ? [scopeSummary(p)] : []),
    ].join('; ')),
    'Warnings:',
    ...(warnings.value.length ? warnings.value.map(w => `  ${w}`) : ['  none']),
  ].join('\n');
  await navigator.clipboard.writeText(text);
  diagnosticsDone.value = 'Copied. Warnings are included as they are: check them before posting.';
}
function reportProblem() {
  chrome.tabs.create({ url: ISSUES_URL });
}

// A profile with nothing in it yet gets a hint on where to start.
const isBlank = computed(() => !!profile.value
  && [...profile.value.requestHeaders, ...profile.value.responseHeaders].every(h => h.name.trim() === '')
  && !profile.value.redirects?.length);

function addRedirect() {
  (profile.value.redirects ??= []).push({ id: newId(), enabled: true, from: '', to: '', isRegex: false });
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

function duplicate() {
  state.value.profiles.splice(selected.value + 1, 0, duplicateProfile(profile.value));
  selected.value += 1;
}

// Drag a profile tab to reorder: the leftmost profile wins a shared header.
const dragFrom = ref(-1);
function dropOn(i: number) {
  if (dragFrom.value < 0) return;
  const current = state.value.profiles[selected.value];
  moveProfile(state.value, dragFrom.value, i);
  selected.value = state.value.profiles.indexOf(current);
  dragFrom.value = -1;
}

// The shortcuts as actually assigned (people can change them in the browser).
const shortcuts = ref<{ key: string; what: string }[]>([]);
onMounted(async () => {
  const all = await chrome.commands.getAll();
  const label: Record<string, string> = { _execute_action: 'open', 'toggle-pause': 'pause', 'next-profile': 'next profile' };
  shortcuts.value = all.filter(c => c.shortcut && c.name && label[c.name]).map(c => ({ key: c.shortcut!.replace('Period', '.').replace('Comma', ','), what: label[c.name!] }));
});

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

// Sites / request types / methods. Lists are left out of the profile when empty.
type ListKey = 'initiatorDomains' | 'excludedInitiatorDomains' | 'resourceTypes' | 'requestMethods';
function setList(p: Profile, key: ListKey, list: string[]) {
  if (list.length) p[key] = list;
  else delete p[key];
}
function setDomains(p: Profile, key: 'initiatorDomains' | 'excludedInitiatorDomains', e: Event) {
  setList(p, key, (e.target as HTMLInputElement).value.split(/[\s,]+/).map(d => d.trim()).filter(Boolean));
}
function toggleIn(p: Profile, key: 'resourceTypes' | 'requestMethods', value: string) {
  const list = p[key] ?? [];
  setList(p, key, list.includes(value) ? list.filter(x => x !== value) : [...list, value]);
}
const hasScope = (p: Profile) => !!(p.initiatorDomains?.length || p.excludedInitiatorDomains?.length || p.resourceTypes?.length || p.requestMethods?.length);

// Export: chosen profiles to a JSON file (or the clipboard), secrets left out unless asked.
const showExport = ref(false);
const exportPicked = ref<Record<string, boolean>>({});
const exportSecrets = ref(false);
const exportChosen = computed(() => state.value.profiles.filter(p => exportPicked.value[p.id] !== false));
const exportText = () => exportProfiles(exportChosen.value, { includeSecrets: exportSecrets.value });
const exportDone = ref('');
function downloadExport() {
  const url = URL.createObjectURL(new Blob([exportText()], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = exportFileName();
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  exportDone.value = `Saved ${a.download}`;
}
async function copyExport() {
  await navigator.clipboard.writeText(exportText());
  exportDone.value = 'Copied';
}

// Kept apart from the background script's warnings, which are refreshed on every save.
const importNotes = ref<string[]>([]);

function doImport() {
  const res = importProfiles(importText.value);
  if (res.profiles.length) {
    state.value.profiles.push(...res.profiles);
    selected.value = state.value.profiles.length - res.profiles.length;
    importText.value = '';
    showImport.value = false;
  }
  importNotes.value = res.profiles.length
    ? [`Imported ${res.profiles.length} profile${res.profiles.length === 1 ? '' : 's'}.`, ...res.warnings]
    : res.warnings;
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
        draggable="true"
        title="Drag to reorder: the leftmost profile wins when two set the same header"
        @click="selected = i"
        @dragstart="dragFrom = i"
        @dragover.prevent
        @drop.prevent="dropOn(i)"
      >
        {{ p.title || 'Untitled' }}
      </button>
      <button title="Add profile" @click="addProfile">+</button>
    </nav>

    <section v-if="profile">
      <div class="row">
        <input type="checkbox" v-model="profile.enabled" title="Profile on/off" aria-label="Profile on or off" />
        <input class="grow" v-model="profile.title" placeholder="Profile name" aria-label="Profile name" />
        <span v-if="profile.tab" class="chip" :title="profile.tab.id === tab?.id ? 'Applies only in this tab' : 'Applies only in another tab'">
          only in {{ profile.tab.id === tab?.id ? 'this tab' : 'another tab' }} · {{ profile.tab.host }}
          <button class="x" title="Apply in all tabs again" @click="unbindTab">×</button>
        </span>
        <button v-else-if="tab" title="Apply this profile only in the current tab, until it closes" @click="bindToTab">Only this tab</button>
        <button title="Copy this profile (the copy starts switched off)" @click="duplicate">Duplicate</button>
        <button :disabled="state.profiles.length === 1" title="Delete profile" @click="deleteProfile">Delete</button>
      </div>

      <h3>Request headers</h3>
      <div v-for="(h, i) in profile.requestHeaders" :key="h.id" class="row">
        <input type="checkbox" v-model="h.enabled" aria-label="Header on or off" />
        <select v-model="h.op" aria-label="What to do with the header">
          <option>set</option>
          <option>append</option>
          <option>remove</option>
        </select>
        <input v-model="h.name" placeholder="Name" list="request-names" aria-label="Request header name" />
        <input class="grow" v-model="h.value" :disabled="h.op === 'remove'" placeholder="Value" aria-label="Header value" :class="{ masked: masked(h) }" autocomplete="off" spellcheck="false" />
        <button v-if="isSecret(h) && h.op !== 'remove'" class="icon" :class="{ on: revealed.has(h.id) }" :title="revealed.has(h.id) ? 'Hide value' : 'Show value'" @click="toggleReveal(h)">👁</button>
        <span v-else class="icon-space"></span>
        <button class="icon" :class="{ on: isSecret(h) }" :title="isSecret(h) ? 'Secret: value hidden. Click to show it always' : 'Mark as secret: hide the value'" @click="toggleSecret(h)">🔒</button>
        <button title="Remove" aria-label="Remove" @click="removeAt(profile.requestHeaders, i)">×</button>
      </div>
      <p v-if="isBlank" class="dim small-hint">Start here: type a header name and value above, paste a request copied in DevTools, or pick a preset.</p>
      <div class="row">
        <button class="link" @click="addHeader(profile.requestHeaders)">+ request header</button>
        <button class="link" @click="showPaste = !showPaste">Paste from DevTools…</button>
        <select class="preset" v-model="presetChoice" @change="onPreset" title="Add a ready-made set of headers">
          <option value="">+ preset…</option>
          <option v-for="x in PRESETS" :key="x.id" :value="x.id">{{ x.label }}</option>
        </select>
      </div>
      <p v-if="usesVariables" class="dim small-hint">{{ variablesHint }}</p>
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
        <input type="checkbox" v-model="h.enabled" aria-label="Header on or off" />
        <select v-model="h.op" aria-label="What to do with the header">
          <option>set</option>
          <option>append</option>
          <option>remove</option>
        </select>
        <input v-model="h.name" placeholder="Name" list="response-names" aria-label="Response header name" />
        <input class="grow" v-model="h.value" :disabled="h.op === 'remove'" placeholder="Value" aria-label="Header value" :class="{ masked: masked(h) }" autocomplete="off" spellcheck="false" />
        <button v-if="isSecret(h) && h.op !== 'remove'" class="icon" :class="{ on: revealed.has(h.id) }" :title="revealed.has(h.id) ? 'Hide value' : 'Show value'" @click="toggleReveal(h)">👁</button>
        <span v-else class="icon-space"></span>
        <button class="icon" :class="{ on: isSecret(h) }" :title="isSecret(h) ? 'Secret: value hidden. Click to show it always' : 'Mark as secret: hide the value'" @click="toggleSecret(h)">🔒</button>
        <button title="Remove" aria-label="Remove" @click="removeAt(profile.responseHeaders, i)">×</button>
      </div>
      <button class="link" @click="addHeader(profile.responseHeaders)">+ response header</button>

      <h3>Redirects</h3>
      <div v-for="(r, i) in profile.redirects ?? []" :key="r.id" class="row">
        <input type="checkbox" v-model="r.enabled" aria-label="Redirect on or off" />
        <input class="grow" v-model="r.from" aria-label="Replace this part of the address" :placeholder="r.isRegex ? 'regex, e.g. /v(\\d+)/' : 'part of the URL, e.g. api.example.com'" spellcheck="false" />
        <span class="arrow" aria-hidden="true">→</span>
        <input class="grow" v-model="r.to" aria-label="With this" :placeholder="r.isRegex ? 'e.g. /v$1-beta/' : 'e.g. api.staging.example.com'" spellcheck="false" />
        <label class="small"><input type="checkbox" v-model="r.isRegex" /> regex</label>
        <button title="Remove" aria-label="Remove" @click="removeAt(profile.redirects!, i)">×</button>
      </div>
      <button class="link" @click="addRedirect">+ redirect</button>
      <p v-if="profile.redirects?.length" class="dim small-hint">Replaces the first match in the address of a request and sends it there. "Only on" filters don't apply to redirects; "never on" and the other limits do.</p>

      <h3>Only on / never on</h3>
      <div v-for="(f, i) in profile.filters" :key="f.id" class="row">
        <input type="checkbox" v-model="f.enabled" aria-label="Filter on or off" />
        <select v-model="f.kind" aria-label="Only on or never on">
          <option value="include">only on</option>
          <option value="exclude">never on</option>
        </select>
        <input class="grow" v-model="f.pattern" :placeholder="filterPlaceholder(f.kind, f.isRegex)" aria-label="URL pattern" />
        <label class="small"><input type="checkbox" v-model="f.isRegex" /> regex</label>
        <button title="Remove" aria-label="Remove" @click="removeAt(profile.filters, i)">×</button>
      </div>
      <button class="link" @click="addFilter('include')">+ only on…</button>
      <button class="link" @click="addFilter('exclude')">+ never on…</button>

      <details class="more" :open="hasScope(profile)">
        <summary>Sites, request types, methods</summary>
        <div class="row">
          <span class="lbl">Only from sites</span>
          <input class="grow" :value="(profile.initiatorDomains ?? []).join(', ')" @change="setDomains(profile, 'initiatorDomains', $event)" placeholder="app.example.com, admin.example.com" />
        </div>
        <div class="row">
          <span class="lbl">Never from sites</span>
          <input class="grow" :value="(profile.excludedInitiatorDomains ?? []).join(', ')" @change="setDomains(profile, 'excludedInitiatorDomains', $event)" placeholder="example.org" />
        </div>
        <div class="checks">
          <span class="lbl">Only these requests</span>
          <div class="opts">
            <label v-for="t in RESOURCE_TYPES" :key="t.id"><input type="checkbox" :checked="profile.resourceTypes?.includes(t.id)" @change="toggleIn(profile, 'resourceTypes', t.id)" /> {{ t.label }}</label>
          </div>
        </div>
        <div class="checks">
          <span class="lbl">Only these methods</span>
          <div class="opts">
            <label v-for="m in REQUEST_METHODS" :key="m"><input type="checkbox" :checked="profile.requestMethods?.includes(m)" @change="toggleIn(profile, 'requestMethods', m)" /> {{ m.toUpperCase() }}</label>
          </div>
        </div>
        <p class="dim">Nothing ticked means all. "From sites" is the page that made the request: a page opened from the address bar or a bookmark has none, so it doesn't count.</p>
      </details>
    </section>

    <section>
      <button class="link" @click="openMigrate">Move from ModHeader (turned off in Chrome)</button>
      <button class="link" @click="showImport = !showImport; showExport = false">Import JSON</button>
      <button class="link" @click="showExport = !showExport; showImport = false; exportDone = ''">Export…</button>
      <div v-if="showImport" class="import">
        <input type="file" accept=".json,application/json" @change="importFile" />
        <textarea v-model="importText" rows="5" placeholder="…or paste a Headerwise or ModHeader export here"></textarea>
        <button :disabled="!importText.trim()" @click="doImport">Import</button>
      </div>
      <ul v-if="importNotes.length" class="warnings notes">
        <li v-for="(w, i) in importNotes" :key="i">{{ w }}</li>
        <li class="ok"><button class="link" @click="importNotes = []">OK</button></li>
      </ul>
      <div v-if="showExport" class="import export">
        <label v-for="p in state.profiles" :key="p.id" class="pasted">
          <input type="checkbox" :checked="exportPicked[p.id] !== false" @change="exportPicked[p.id] = ($event.target as HTMLInputElement).checked" />
          {{ p.title || 'Untitled' }}
        </label>
        <label class="pasted"><input type="checkbox" v-model="exportSecrets" /> Include secret values (tokens, cookies). Only for your own machines.</label>
        <div class="row">
          <button :disabled="!exportChosen.length" @click="downloadExport">Download {{ exportChosen.length }} profile{{ exportChosen.length === 1 ? '' : 's' }}</button>
          <button :disabled="!exportChosen.length" @click="copyExport">Copy</button>
          <span class="dim">{{ exportDone }}</span>
        </div>
      </div>
    </section>

    <ul v-if="warnings.length" class="warnings">
      <li v-for="(w, i) in warnings" :key="i">{{ w }}</li>
    </ul>

    <datalist id="request-names"><option v-for="n in REQUEST_HEADER_NAMES" :key="n" :value="n" /></datalist>
    <datalist id="response-names"><option v-for="n in RESPONSE_HEADER_NAMES" :key="n" :value="n" /></datalist>

    <p v-if="showRate" class="rate">
      Finding Headerwise useful?
      <button class="link" @click="rateDone(true)">Rate it in the Chrome Web Store</button>
      <button class="link x" title="Don't show again" aria-label="Don't show again" @click="rateDone(false)">×</button>
    </p>

    <footer>
      Runs locally. No account, no analytics, nothing is sent anywhere.
      <span v-if="shortcuts.length" class="keys"><br />Shortcuts: <template v-for="(k, i) in shortcuts" :key="k.what">{{ i ? ', ' : '' }}<kbd>{{ k.key }}</kbd> {{ k.what }}</template></span>
      <br />Something wrong? <button class="link" @click="copyDiagnostics">Copy diagnostics</button> and <button class="link" @click="reportProblem">report a problem</button>.
      <span v-if="diagnosticsDone" class="note-done"><br />{{ diagnosticsDone }}</span>
    </footer>
  </main>
</template>
