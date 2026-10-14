<script setup lang="ts">
import { computed, nextTick, onMounted, ref, toRaw, watch } from 'vue';
import { clockTime, defaultState, duplicateProfile, emptyHeader, emptyProfile, isSecret, moveProfile, maskValue, newId, REQUEST_METHODS, RESOURCE_TYPES, type HeaderMod, type Profile, type Redirect, type State } from '../core/model.ts';
import { exportFileName, exportProfiles, importProfiles } from '../core/export.ts';
import { VARIABLES } from '../core/variables.ts';
import { loadMeta, loadState, saveMeta, saveState, STATE_KEY } from '../core/storage.ts';
import type { RuleInfo } from '../core/dnr.ts';
import { tabReport, type MatchedRule, type TabLine } from '../core/explain.ts';
import { parsePasted } from '../core/paste.ts';
import { addHeaders, applyPreset, PRESETS, REQUEST_HEADER_NAMES, RESPONSE_HEADER_NAMES } from '../core/presets.ts';
import { t, tn, type MessageKey } from '../core/i18n.ts';

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
  try {
    state.value = await loadState();
    lastSaved = JSON.stringify(state.value);
    stateLoaded = true;
    hasAccess.value = await chrome.permissions.contains(ALL_SITES);
    await refreshWarnings();
    await refreshTab();
  } catch (e) {
    // Show the editor anyway: a blank popup helps nobody.
    tabNote.value = t('cantCheckTab', { error: e instanceof Error ? e.message : String(e) });
  } finally {
    loaded.value = true;
  }
  chrome.storage.session.onChanged.addListener(refreshWarnings);
  chrome.storage.local.onChanged.addListener(onStateChanged);
});

// Saving. Edits are saved 250 ms after the last keystroke, and right away when
// the popup closes (Chrome closes it on any click outside).
let timer: ReturnType<typeof setTimeout> | undefined;
let lastSaved = '';
let stateLoaded = false;
function saveNow() {
  clearTimeout(timer);
  timer = undefined;
  // Until the profiles are loaded there is nothing of the user's here: saving
  // the empty default would wipe theirs.
  if (!stateLoaded) return Promise.resolve();
  const json = JSON.stringify(state.value);
  if (json === lastSaved) return Promise.resolve();
  lastSaved = json;
  return saveState(structuredClone(toRaw(state.value)));
}
watch(state, () => {
  if (!loaded.value) return;
  clearTimeout(timer);
  timer = setTimeout(saveNow, 250);
}, { deep: true });
addEventListener('pagehide', () => { saveNow(); });
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });

// Changed elsewhere while the popup is open: a keyboard shortcut (pause, next
// profile), a closed tab releasing "only this tab", another Headerwise window.
// Take that in, or the next edit here would save the old state over it.
function onStateChanged(changes: Record<string, chrome.storage.StorageChange>) {
  const next = changes[STATE_KEY]?.newValue as State | undefined;
  if (!next || JSON.stringify(next) === lastSaved) return; // our own save
  const current = state.value.profiles[selected.value]?.id;
  // Typed here in the last 250 ms: that edit is newer, keep it (rare: it means a
  // shortcut pressed mid-typing). A pending save with nothing typed (it follows a
  // change taken in a moment ago) doesn't count: take this one in too.
  if (timer !== undefined && JSON.stringify(state.value) !== lastSaved) { saveNow(); return; }
  clearTimeout(timer);
  timer = undefined;
  lastSaved = JSON.stringify(next);
  state.value = next;
  const i = next.profiles.findIndex(p => p.id === current);
  selected.value = i >= 0 ? i : Math.min(selected.value, next.profiles.length - 1);
}

// What the background script left for us: warnings, and which profile each rule belongs to.
const ruleInfo = ref<Record<number, RuleInfo>>({});
const rulesUpdatedAt = ref(0);

async function refreshWarnings() {
  const got = await chrome.storage.session.get(['warnings', 'ruleInfo', 'rulesUpdatedAt']);
  warnings.value = (got.warnings as string[] | undefined) ?? [];
  ruleInfo.value = (got.ruleInfo as Record<number, RuleInfo> | undefined) ?? {};
  rulesUpdatedAt.value = (got.rulesUpdatedAt as number | undefined) ?? 0;
}

// Regexes Chrome won't take (it uses RE2: no lookarounds or backreferences, size
// limits), marked on their row; the warning at the top says what happens.
const badRegex = ref<Record<string, string>>({});
let regexRun = 0;
watch(() => (profile.value ? [
  // Rows that are switched on: the warning at the top only speaks about those.
  ...profile.value.filters.filter(f => f.enabled && f.isRegex && f.pattern.trim()).map(f => [f.id, f.pattern.trim()]),
  ...(profile.value.redirects ?? []).filter(r => r.enabled && r.isRegex && r.from.trim()).map(r => [r.id, r.from.trim()]),
] : []), async patterns => {
  const run = ++regexRun;
  const bad: Record<string, string> = {};
  for (const [id, regex] of patterns) {
    const r = await chrome.declarativeNetRequest.isRegexSupported({ regex }).catch(() => ({ isSupported: true, reason: undefined }));
    if (!r.isSupported) bad[id] = t('badRegex', { reason: r.reason ?? t('notSupported') });
  }
  if (run === regexRun) badRegex.value = bad; // a newer edit may have started a newer check
}, { deep: true, immediate: true });

// "On this tab". Opening the popup grants activeTab, which lets us ask Chrome
// which of our rules matched requests in the current tab. (?tab=<id> is for tests.)
const tab = ref<{ id: number; url: string; host: string } | null>(null);
const tabNote = ref('');
const tabAccess = ref(true);
const matched = ref<MatchedRule[]>([]);
const exact = ref(true);

async function refreshTab() {
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  const current = forced ? await chrome.tabs.get(forced) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!current?.id || !current.url) return;
  if (!/^https?:/.test(current.url)) {
    tab.value = null;
    tabNote.value = t('cantChangeThisPage');
    return;
  }
  tab.value = { id: current.id, url: current.url, host: new URL(current.url).host };
  // No port in the pattern: Chrome's patterns cover all ports anyway, Firefox rejects one.
  const u = new URL(current.url);
  tabAccess.value = await chrome.permissions.contains({ origins: [`${u.protocol}//${u.hostname}/*`] });
  if (typeof chrome.declarativeNetRequest.getMatchedRules !== 'function') {
    // Firefox doesn't report matched rules to extensions.
    exact.value = false;
    tabNote.value = t('noMatchedRulesApi');
    return;
  }
  try {
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId: current.id });
    matched.value = rulesMatchedInfo
      .filter(m => m.rule.rulesetId === chrome.declarativeNetRequest.DYNAMIC_RULESET_ID || m.rule.rulesetId === chrome.declarativeNetRequest.SESSION_RULESET_ID)
      .map(m => ({ ruleId: m.rule.ruleId, timeStamp: m.timeStamp }));
    tabNote.value = '';
  } catch (e) {
    // e.g. Chrome's limit on how often this can be asked
    tabNote.value = t('matchedRulesError', { error: e instanceof Error ? e.message : String(e) });
  }
}

const tabLines = computed(() => tab.value
  ? tabReport(state.value, tab.value.url, matched.value, ruleInfo.value, rulesUpdatedAt.value, tab.value.id, exact.value)
  : []);
const needsReload = computed(() => tabLines.value.some(l => l.line.kind === 'waiting'));

function describe(line: TabLine): string {
  switch (line.kind) {
    case 'applied': return tn('line_applied', line.requests) + (line.skippedBy ? t('line_skippedWhere', { pattern: line.skippedBy }) : '');
    case 'excluded': return t('line_excluded', { pattern: line.pattern });
    case 'not-included': return t('line_notIncluded', { patterns: line.patterns.join(', ') });
    case 'waiting': return t('line_waiting');
    case 'off': return t('line_off');
    case 'empty': return t('line_empty');
    case 'other-tab': return t('line_otherTab', { host: line.host });
    case 'narrowed': return t('line_narrowed', { scope: line.scope });
    case 'page-match': return t('line_pageMatch');
  }
}

async function reloadTab() {
  if (!tab.value) return;
  await chrome.tabs.reload(tab.value.id);
  setTimeout(refreshTab, 1500);
}

async function grantAccess() {
  hasAccess.value = await chrome.permissions.request(ALL_SITES);
  await refreshTab();
}

// Shown once a value uses {{...}}. Built here: braces in the template would be Vue syntax.
const usesVariables = computed(() => [...(profile.value?.requestHeaders ?? []), ...(profile.value?.responseHeaders ?? [])].some(h => h.value.includes('{{')));
const variablesHint = t('variablesHint', { list: VARIABLES.map(v => `{{${v.name}}}`).join(', ') });

// Quick input: a request copied from DevTools, or a preset.
const showPaste = ref(false);
const pasteText = ref('');
const pasted = computed(() => (pasteText.value.trim() ? parsePasted(pasteText.value) : null));
const pastePicked = ref<boolean[]>([]);
// Ticks the user changed survive further typing in the box.
watch(pasted, (r, old) => {
  const before = new Map((old?.headers ?? []).map((h, i) => [h.name.toLowerCase(), pastePicked.value[i]]));
  pastePicked.value = r ? r.headers.map(h => before.get(h.name.toLowerCase()) ?? h.suggested) : [];
});
const pasteHost = computed(() => {
  try { return pasted.value?.url ? new URL(pasted.value.url).hostname : ''; } catch { return ''; }
});
// "Only on <host>" limits the whole profile: suggested only while it has no headers of its own.
const pasteOnlyHost = ref(true);
watch(showPaste, open => {
  if (open) pasteOnlyHost.value = [...profile.value.requestHeaders, ...profile.value.responseHeaders].every(h => h.name.trim() === '');
});
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
  const meta = await loadMeta();
  showRate.value = !!meta.installedAt && Date.now() - meta.installedAt > 14 * 24 * 3600 * 1000 && !meta.rateDone;
});
async function rateDone(open: boolean) {
  showRate.value = false;
  // Saved before the new tab opens: that closes the popup.
  await saveMeta({ rateDone: true });
  if (open) chrome.tabs.create({ url: RATE_URL });
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
    `Paused: ${s.paused ? 'yes' : 'no'}. Site access: ${perms.origins?.includes('<all_urls>') ? 'all sites' : `${perms.origins?.length ?? 0} sites`}`,
    `Rules in the browser: ${dynamic.length} dynamic, ${session.length} session`,
    `Profiles (${s.profiles.length}):`,
    ...s.profiles.map((p, i) => [
      `  ${i + 1}. ${p.enabled ? 'on' : 'off'}${p.tab ? ', only one tab' : ''}`,
      `request [${names(p.requestHeaders)}]`,
      `response [${names(p.responseHeaders)}]`,
      `${p.redirects?.filter(r => r.enabled).length ?? 0} redirects`,
      `filters [${p.filters.map(f => `${f.enabled ? '' : '(off) '}${f.kind === 'include' ? 'only on' : 'never on'}${f.isRegex ? ' regex' : ''}`).join(', ')}]`,
      // counts only: site names are the user's business
      `${p.initiatorDomains?.length ?? 0} only-from sites, ${p.excludedInitiatorDomains?.length ?? 0} never-from sites, types [${(p.resourceTypes ?? []).join(', ')}], methods [${(p.requestMethods ?? []).join(', ')}]`,
    ].join('; ')),
    'Warnings:',
    ...(warnings.value.length ? warnings.value.map(w => `  ${w}`) : ['  none']),
  ].join('\n');
  await navigator.clipboard.writeText(text);
  diagnosticsDone.value = t('diagnosticsCopied');
}
function reportProblem() {
  chrome.tabs.create({ url: ISSUES_URL });
}

// A profile with nothing in it yet gets a hint on where to start.
const isBlank = computed(() => !!profile.value
  && [...profile.value.requestHeaders, ...profile.value.responseHeaders].every(h => h.name.trim() === '')
  && !profile.value.redirects?.length);

// A token or cookie with no limit goes to every site the page talks to: fonts,
// analytics, other people's APIs. Said once, with a one-click fix for this tab's site.
const secretsEverywhere = computed(() => {
  const p = profile.value;
  if (!p || !p.enabled || p.tab || p.initiatorDomains?.length) return [];
  if (p.filters.some(f => f.enabled && f.kind === 'include' && f.pattern.trim())) return [];
  return p.requestHeaders.filter(h => h.enabled && h.op !== 'remove' && h.name.trim() && h.value.trim() && isSecret(h)).map(h => h.name.trim());
});
const tabSite = computed(() => (tab.value ? new URL(tab.value.url).hostname : ''));
function limitToThisSite() {
  if (tabSite.value) profile.value.filters.push({ id: newId(), enabled: true, kind: 'include', pattern: `||${tabSite.value}^`, isRegex: false });
}

// Only rows added here: one the user switched off stays off while they edit it.
const fresh = new Set<string>();
function arm(r: Redirect) {
  if (fresh.has(r.id) && r.from.trim() && r.to.trim()) {
    r.enabled = true;
    fresh.delete(r.id);
  }
}

function addRedirect() {
  // Off until filled in: a half-typed "from" would already rewrite every matching address.
  const r = { id: newId(), enabled: false, from: '', to: '', isRegex: false };
  fresh.add(r.id);
  (profile.value.redirects ??= []).push(r);
}

function addHeader(list: HeaderMod[]) {
  list.push(emptyHeader());
}

// "On for an hour": the background switches the profile off when the time is up.
const TIMER_MINUTES = [15, 60, 240, 480];
function setTimer(e: Event) {
  const select = e.target as HTMLSelectElement;
  const minutes = Number(select.value);
  select.value = '';
  if (!minutes) return;
  profile.value.enabled = true;
  profile.value.offAt = Date.now() + minutes * 60_000;
}
// Ticking the profile on or off by hand, or the chip's ×: no timer any more.
function clearTimer() {
  delete profile.value.offAt;
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
  state.value.profiles.push(emptyProfile(t('profileN', { n: state.value.profiles.length + 1 })));
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

// The same from the keyboard: Alt+Left / Alt+Right on a profile tab.
async function moveBy(i: number, by: number) {
  const to = i + by;
  if (to < 0 || to >= state.value.profiles.length) return;
  const moved = state.value.profiles[i];
  moveProfile(state.value, i, to);
  selected.value = state.value.profiles.indexOf(moved);
  await nextTick();
  (document.querySelectorAll<HTMLButtonElement>('.tabs button')[selected.value])?.focus();
}

// The shortcuts as actually assigned (people can change them in the browser).
const shortcuts = ref<{ key: string; what: string }[]>([]);
onMounted(async () => {
  const all = await chrome.commands.getAll();
  const label: Record<string, string> = { _execute_action: t('shortcutOpen'), 'toggle-pause': t('shortcutPause'), 'next-profile': t('shortcutNext') };
  shortcuts.value = all.filter(c => c.shortcut && c.name && label[c.name]).map(c => ({ key: c.shortcut!.replace('Period', '.').replace('Comma', ','), what: label[c.name!] }));
});

// Deleting is one click, so it can be taken back for a while (until the popup closes).
const undo = ref<{ profile: Profile; index: number } | null>(null);
let undoTimer: ReturnType<typeof setTimeout> | undefined;
function deleteProfile() {
  if (state.value.profiles.length === 1) return;
  const [gone] = state.value.profiles.splice(selected.value, 1);
  undo.value = { profile: gone, index: selected.value };
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { undo.value = null; }, 15000);
  selected.value = Math.max(0, selected.value - 1);
}
async function undoDelete() {
  if (!undo.value) return;
  const { profile: back, index } = undo.value;
  undo.value = null;
  // Already back (another Headerwise window saved it again): nothing to restore.
  if (state.value.profiles.some(p => p.id === back.id)) return;
  // Its "only this tab" tab may have closed meanwhile: then it comes back off, unbound.
  if (back.tab && !(await chrome.tabs.get(back.tab.id).catch(() => null))) {
    delete back.tab;
    back.enabled = false;
  }
  const at = Math.min(index, state.value.profiles.length);
  state.value.profiles.splice(at, 0, back);
  selected.value = at;
  undo.value = null;
}

function addFilter(kind: 'include' | 'exclude') {
  profile.value.filters.push({ id: newId(), enabled: true, kind, pattern: '', isRegex: kind === 'include' });
}

function filterPlaceholder(kind: 'include' | 'exclude', isRegex: boolean): string {
  if (isRegex) return kind === 'exclude' ? t('filterRegexExcludePlaceholder') : t('filterRegexIncludePlaceholder');
  return kind === 'exclude' ? t('filterExcludePlaceholder') : '||example.com^';
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
  exportDone.value = t('saved', { file: a.download });
}
async function copyExport() {
  await navigator.clipboard.writeText(exportText());
  exportDone.value = t('copied');
}

// Kept apart from the background script's warnings, which are refreshed on every save.
const importNotes = ref<string[]>([]);

function doImport() {
  let res: ReturnType<typeof importProfiles>;
  try {
    res = importProfiles(importText.value);
  } catch (e) {
    importNotes.value = [t('cantRead', { error: e instanceof Error ? e.message : String(e) })];
    return;
  }
  if (res.profiles.length) {
    state.value.profiles.push(...res.profiles);
    selected.value = state.value.profiles.length - res.profiles.length;
    importText.value = '';
    showImport.value = false;
  }
  importNotes.value = res.profiles.length
    ? [tn('imported', res.profiles.length), ...res.warnings]
    : res.warnings;
}

// The editor in a tab, for long profiles: "On this tab" keeps reporting on the page
// the popup was opened over (?tab=<id>; the popup's activeTab grant covers it).
const inTab = new URLSearchParams(location.search).get('view') === 'tab';
if (inTab) document.documentElement.classList.add('in-tab');
async function openInTab() {
  await saveNow();
  const url = chrome.runtime.getURL(`src/popup/index.html?view=tab${tab.value ? `&tab=${tab.value.id}` : ''}`);
  await chrome.tabs.create({ url });
  window.close();
}

async function openMigrate() {
  await saveNow();
  chrome.tabs.create({ url: chrome.runtime.getURL('src/migrate/index.html') });
  window.close();
}

// Labels kept in the model in English (they also name things in exports): shown translated.
const typeLabel = (id: string) => t(`type_${id}` as MessageKey);
const presetLabel = (id: string) => t(`preset_${id.replace(/-/g, '_')}` as MessageKey);
const untitled = (title: string) => title || t('untitled');
const duration = (m: number) => (m < 60 ? tn('minutes', m) : tn('hours', m / 60));

async function importFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // picking the same file again must load it again
  if (file) importText.value = await file.text();
}
</script>

<template>
  <main v-if="loaded">
    <header class="bar">
      <h1>Headerwise</h1>
      <button v-if="!inTab" class="link open-tab" :title="t('openInTabTitle')" @click="openInTab">{{ t('openInTab') }}</button>
      <label class="pause"><input type="checkbox" v-model="state.paused" /> {{ t('pauseAll') }}</label>
    </header>

    <p v-if="!hasAccess" class="notice">
      {{ t('needsAccess') }}
      <button @click="grantAccess">{{ t('allowAllSites') }}</button>
    </p>

    <section v-if="tab || tabNote" class="here">
      <h2>{{ t('onThisTab') }}<template v-if="tab"> · <span class="host">{{ tab.host }}</span></template></h2>
      <p v-if="state.paused" class="dim">{{ t('pausedNothing') }}</p>
      <template v-else-if="tab">
        <p v-if="hasAccess && !tabAccess" class="dim">{{ t('noAccessHere') }}</p>
        <ul class="lines">
          <li v-for="l in tabLines" :key="l.profileId" :class="l.line.kind">
            <strong>{{ l.title }}</strong> {{ describe(l.line) }}
          </li>
        </ul>
        <button v-if="needsReload" @click="reloadTab">{{ t('reloadTab') }}</button>
      </template>
      <p v-if="tabNote" class="dim">{{ tabNote }}</p>
    </section>

    <!-- Up here, not under the editor: the popup is cut at 600px and these explain a red badge. -->
    <ul v-if="warnings.length" class="warnings">
      <li v-for="(w, i) in warnings" :key="i">{{ w }}</li>
    </ul>

    <nav class="tabs">
      <button
        v-for="(p, i) in state.profiles"
        :key="p.id"
        :class="{ on: i === selected, off: !p.enabled }"
        draggable="true"
        :title="t('profileTabTitle', { title: untitled(p.title) })"
        :aria-pressed="i === selected"
        @click="selected = i"
        @dragstart="dragFrom = i"
        @dragend="dragFrom = -1"
        @keydown.alt.left.prevent="moveBy(i, -1)"
        @keydown.alt.right.prevent="moveBy(i, 1)"
        @dragover.prevent
        @drop.prevent="dropOn(i)"
      >
        {{ untitled(p.title) }}
      </button>
      <button :title="t('addProfile')" :aria-label="t('addProfile')" @click="addProfile">+</button>
    </nav>

    <p v-if="undo" class="undo" role="status">
      {{ t('deleted', { title: untitled(undo.profile.title) }) }}
      <button class="link" @click="undoDelete">{{ t('undo') }}</button>
    </p>

    <section v-if="profile" :class="{ paused: state.paused }">
      <div class="row">
        <input type="checkbox" v-model="profile.enabled" :title="t('profileOnOff')" :aria-label="t('profileOnOff')" @change="clearTimer" />
        <input class="grow" v-model="profile.title" :placeholder="t('profileName')" :aria-label="t('profileName')" />
        <span v-if="profile.enabled && profile.offAt" class="chip timer" :title="t('timerOffAt', { time: clockTime(profile.offAt) })">
          {{ t('timerUntil', { time: clockTime(profile.offAt) }) }}
          <button class="x" :title="t('keepItOn')" :aria-label="t('keepItOn')" @click="clearTimer">×</button>
        </span>
        <select v-else class="timer" value="" :title="t('timerSelectTitle')" :aria-label="t('timerSelectLabel')" @change="setTimer">
          <option value="">{{ t('onFor') }}</option>
          <option v-for="m in TIMER_MINUTES" :key="m" :value="m">{{ duration(m) }}</option>
        </select>
        <span v-if="profile.tab" class="chip" :title="profile.tab.id === tab?.id ? t('onlyThisTabTitle') : t('onlyAnotherTabTitle')">
          {{ profile.tab.id === tab?.id ? t('onlyInThisTab', { host: profile.tab.host }) : t('onlyInAnotherTab', { host: profile.tab.host }) }}
          <button class="x" :title="t('allTabsAgain')" :aria-label="t('allTabsAgain')" @click="unbindTab">×</button>
        </span>
        <button v-else-if="tab" :title="t('onlyThisTabButtonTitle')" @click="bindToTab">{{ t('onlyThisTab') }}</button>
        <button :title="t('duplicateTitle')" @click="duplicate">{{ t('duplicate') }}</button>
        <button :disabled="state.profiles.length === 1" :title="t('deleteTitle')" @click="deleteProfile">{{ t('delete') }}</button>
      </div>

      <h2>{{ t('requestHeaders') }}</h2>
      <div v-for="(h, i) in profile.requestHeaders" :key="h.id" class="row">
        <input type="checkbox" v-model="h.enabled" :aria-label="t('headerOnOff')" />
        <select v-model="h.op" :aria-label="t('headerAction')">
          <option value="set">{{ t('op_set') }}</option>
          <option value="append">{{ t('op_append') }}</option>
          <option value="remove">{{ t('op_remove') }}</option>
        </select>
        <input v-model="h.name" :placeholder="t('namePlaceholder')" list="request-names" :aria-label="t('requestHeaderName')" />
        <input class="grow" v-model="h.value" :disabled="h.op === 'remove'" :placeholder="h.op === 'remove' ? t('removedPlaceholder') : t('valuePlaceholder')" :aria-label="t('headerValue')" :class="{ masked: masked(h) }" autocomplete="off" spellcheck="false" />
        <button v-if="isSecret(h) && h.op !== 'remove'" class="icon" :class="{ on: revealed.has(h.id) }" :title="revealed.has(h.id) ? t('hideValue') : t('showValue')" :aria-label="revealed.has(h.id) ? t('hideValue') : t('showValue')" :aria-pressed="revealed.has(h.id)" @click="toggleReveal(h)">👁</button>
        <span v-else class="icon-space"></span>
        <button class="icon" :class="{ on: isSecret(h) }" :title="isSecret(h) ? t('secretOnTitle') : t('secretOffTitle')" :aria-label="t('secretValue')" :aria-pressed="isSecret(h)" @click="toggleSecret(h)">🔒</button>
        <button :title="t('remove')" :aria-label="t('remove')" @click="removeAt(profile.requestHeaders, i)">×</button>
      </div>
      <p v-if="isBlank" class="dim small-hint">{{ t('startHere') }}</p>
      <p v-if="secretsEverywhere.length" class="small-hint secret-hint">
        {{ tn('secretsEverywhere', secretsEverywhere.length, { names: secretsEverywhere.join(', ') }) }}
        <button v-if="tabSite" class="link" @click="limitToThisSite">{{ t('onlyOnSite', { site: tabSite }) }}</button>
        <template v-else>{{ t('addOnlyOnFilter') }}</template>
      </p>
      <div class="row">
        <button class="link" @click="addHeader(profile.requestHeaders)">{{ t('addRequestHeader') }}</button>
        <button class="link" @click="showPaste = !showPaste">{{ t('pasteFromDevTools') }}</button>
        <select class="preset" v-model="presetChoice" @change="onPreset" :title="t('presetTitle')" :aria-label="t('presetLabel')">
          <option value="">{{ t('presetPick') }}</option>
          <option v-for="x in PRESETS" :key="x.id" :value="x.id">{{ presetLabel(x.id) }}</option>
        </select>
      </div>
      <p v-if="usesVariables" class="dim small-hint">{{ variablesHint }}</p>
      <div v-if="showPaste" class="import">
        <textarea v-model="pasteText" rows="4" :placeholder="t('pastePlaceholder')"></textarea>
        <template v-if="pasted">
          <p v-if="!pasted.headers.length" class="dim">{{ t('pasteNoHeaders') }}</p>
          <label v-for="(h, i) in pasted.headers" :key="h.name" class="pasted">
            <input type="checkbox" v-model="pastePicked[i]" />
            <code>{{ h.name }}</code>
            <span class="val">{{ isSecret(h) ? maskValue(h.value) : h.value }}</span>
          </label>
          <label v-if="canLimitToHost" class="pasted"><input type="checkbox" v-model="pasteOnlyHost" /> {{ t('pasteOnlyHost', { host: pasteHost }) }}</label>
          <button :disabled="!pastePicked.some(Boolean)" @click="addPasted">{{ tn('addHeaders', pastePicked.filter(Boolean).length) }}</button>
        </template>
      </div>

      <h2>{{ t('responseHeaders') }}</h2>
      <div v-for="(h, i) in profile.responseHeaders" :key="h.id" class="row">
        <input type="checkbox" v-model="h.enabled" :aria-label="t('headerOnOff')" />
        <select v-model="h.op" :aria-label="t('headerAction')">
          <option value="set">{{ t('op_set') }}</option>
          <option value="append">{{ t('op_append') }}</option>
          <option value="remove">{{ t('op_remove') }}</option>
        </select>
        <input v-model="h.name" :placeholder="t('namePlaceholder')" list="response-names" :aria-label="t('responseHeaderName')" />
        <input class="grow" v-model="h.value" :disabled="h.op === 'remove'" :placeholder="h.op === 'remove' ? t('removedPlaceholder') : t('valuePlaceholder')" :aria-label="t('headerValue')" :class="{ masked: masked(h) }" autocomplete="off" spellcheck="false" />
        <button v-if="isSecret(h) && h.op !== 'remove'" class="icon" :class="{ on: revealed.has(h.id) }" :title="revealed.has(h.id) ? t('hideValue') : t('showValue')" :aria-label="revealed.has(h.id) ? t('hideValue') : t('showValue')" :aria-pressed="revealed.has(h.id)" @click="toggleReveal(h)">👁</button>
        <span v-else class="icon-space"></span>
        <button class="icon" :class="{ on: isSecret(h) }" :title="isSecret(h) ? t('secretOnTitle') : t('secretOffTitle')" :aria-label="t('secretValue')" :aria-pressed="isSecret(h)" @click="toggleSecret(h)">🔒</button>
        <button :title="t('remove')" :aria-label="t('remove')" @click="removeAt(profile.responseHeaders, i)">×</button>
      </div>
      <button class="link" @click="addHeader(profile.responseHeaders)">{{ t('addResponseHeader') }}</button>

      <h2>{{ t('redirects') }}</h2>
      <div v-for="(r, i) in profile.redirects ?? []" :key="r.id" class="row">
        <input type="checkbox" v-model="r.enabled" :aria-label="t('redirectOnOff')" />
        <input class="grow" v-model="r.from" @change="arm(r)" :aria-label="t('redirectFrom')" :class="{ bad: badRegex[r.id] }" :title="badRegex[r.id] ?? ''" :placeholder="r.isRegex ? t('redirectFromRegexPlaceholder') : t('redirectFromPlaceholder')" spellcheck="false" />
        <span class="arrow" aria-hidden="true">→</span>
        <input class="grow" v-model="r.to" @change="arm(r)" :aria-label="t('redirectTo')" :placeholder="r.isRegex ? t('redirectToRegexPlaceholder') : t('redirectToPlaceholder')" spellcheck="false" />
        <label class="small"><input type="checkbox" v-model="r.isRegex" /> {{ t('regex') }}</label>
        <button :title="t('remove')" :aria-label="t('remove')" @click="removeAt(profile.redirects!, i)">×</button>
      </div>
      <button class="link" @click="addRedirect">{{ t('addRedirect') }}</button>
      <p v-if="profile.redirects?.length" class="dim small-hint">{{ t('redirectsHint') }}</p>

      <h2>{{ t('onlyOnNeverOn') }}</h2>
      <div v-for="(f, i) in profile.filters" :key="f.id" class="row">
        <input type="checkbox" v-model="f.enabled" :aria-label="t('filterOnOff')" />
        <select v-model="f.kind" :aria-label="t('filterKind')">
          <option value="include">{{ t('onlyOn') }}</option>
          <option value="exclude">{{ t('neverOn') }}</option>
        </select>
        <input class="grow" v-model="f.pattern" :placeholder="filterPlaceholder(f.kind, f.isRegex)" :aria-label="t('urlPattern')" :class="{ bad: badRegex[f.id] }" :title="badRegex[f.id] ?? ''" />
        <label class="small"><input type="checkbox" v-model="f.isRegex" /> {{ t('regex') }}</label>
        <button :title="t('remove')" :aria-label="t('remove')" @click="removeAt(profile.filters, i)">×</button>
      </div>
      <button class="link" @click="addFilter('include')">{{ t('addOnlyOn') }}</button>
      <button class="link" @click="addFilter('exclude')">{{ t('addNeverOn') }}</button>

      <details class="more" :open="hasScope(profile)">
        <summary>{{ t('scopeSummary') }}</summary>
        <div class="row">
          <span class="lbl">{{ t('onlyFromSites') }}</span>
          <input class="grow" :value="(profile.initiatorDomains ?? []).join(', ')" @change="setDomains(profile, 'initiatorDomains', $event)" :aria-label="t('onlyFromSites')" placeholder="app.example.com, admin.example.com" />
        </div>
        <div class="row">
          <span class="lbl">{{ t('neverFromSites') }}</span>
          <input class="grow" :value="(profile.excludedInitiatorDomains ?? []).join(', ')" @change="setDomains(profile, 'excludedInitiatorDomains', $event)" :aria-label="t('neverFromSites')" placeholder="example.org" />
        </div>
        <div class="checks">
          <span class="lbl">{{ t('onlyTheseRequests') }}</span>
          <div class="opts">
            <label v-for="rt in RESOURCE_TYPES" :key="rt.id"><input type="checkbox" :checked="profile.resourceTypes?.includes(rt.id)" @change="toggleIn(profile, 'resourceTypes', rt.id)" /> {{ typeLabel(rt.id) }}</label>
          </div>
        </div>
        <div class="checks">
          <span class="lbl">{{ t('onlyTheseMethods') }}</span>
          <div class="opts">
            <label v-for="m in REQUEST_METHODS" :key="m"><input type="checkbox" :checked="profile.requestMethods?.includes(m)" @change="toggleIn(profile, 'requestMethods', m)" /> {{ m.toUpperCase() }}</label>
          </div>
        </div>
        <p class="dim">{{ t('scopeHint') }}</p>
      </details>
    </section>

    <section>
      <button class="link" @click="openMigrate">{{ t('moveFromModHeader') }}</button>
      <button class="link" @click="showImport = !showImport; showExport = false">{{ t('importJson') }}</button>
      <button class="link" @click="showExport = !showExport; showImport = false; exportDone = ''">{{ t('export') }}</button>
      <div v-if="showImport" class="import">
        <input type="file" accept=".json,application/json" @change="importFile" />
        <textarea v-model="importText" rows="5" :placeholder="t('importPlaceholder')"></textarea>
        <button :disabled="!importText.trim()" @click="doImport">{{ t('import') }}</button>
      </div>
      <ul v-if="importNotes.length" class="warnings notes">
        <li v-for="(w, i) in importNotes" :key="i">{{ w }}</li>
        <li class="ok"><button class="link" @click="importNotes = []">{{ t('ok') }}</button></li>
      </ul>
      <div v-if="showExport" class="import export">
        <label v-for="p in state.profiles" :key="p.id" class="pasted">
          <input type="checkbox" :checked="exportPicked[p.id] !== false" @change="exportPicked[p.id] = ($event.target as HTMLInputElement).checked" />
          {{ untitled(p.title) }}
        </label>
        <label class="pasted"><input type="checkbox" v-model="exportSecrets" /> {{ t('includeSecrets') }}</label>
        <div class="row">
          <button :disabled="!exportChosen.length" @click="downloadExport">{{ tn('download', exportChosen.length) }}</button>
          <button :disabled="!exportChosen.length" @click="copyExport">{{ t('copy') }}</button>
          <span class="dim">{{ exportDone }}</span>
        </div>
      </div>
    </section>

    <datalist id="request-names"><option v-for="n in REQUEST_HEADER_NAMES" :key="n" :value="n" /></datalist>
    <datalist id="response-names"><option v-for="n in RESPONSE_HEADER_NAMES" :key="n" :value="n" /></datalist>

    <p v-if="showRate" class="rate">
      {{ t('rateQuestion') }}
      <button class="link" @click="rateDone(true)">{{ t('rateIt') }}</button>
      <button class="link x" :title="t('dontShowAgain')" :aria-label="t('dontShowAgain')" @click="rateDone(false)">×</button>
    </p>

    <footer>
      {{ t('footerLocal') }}
      <span v-if="shortcuts.length" class="keys"><br />{{ t('shortcuts') }} <template v-for="(k, i) in shortcuts" :key="k.what">{{ i ? ', ' : '' }}<kbd>{{ k.key }}</kbd> {{ k.what }}</template></span>
      <br />{{ t('somethingWrong') }} <button class="link" @click="copyDiagnostics">{{ t('copyDiagnostics') }}</button> {{ t('and') }} <button class="link" @click="reportProblem">{{ t('reportProblem') }}</button>.
      <span v-if="diagnosticsDone" class="note-done"><br />{{ diagnosticsDone }}</span>
    </footer>
  </main>
</template>
