<script setup lang="ts">
import { computed, onMounted, ref, toRaw, watch } from 'vue';
import { defaultState, emptyHeader, emptyProfile, newId, type HeaderMod, type State } from '../core/model.ts';
import { importModHeader } from '../core/import-modheader.ts';
import { loadState, saveState } from '../core/storage.ts';
import type { RuleInfo } from '../core/dnr.ts';
import { tabReport, type MatchedRule, type TabLine } from '../core/explain.ts';

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
      .filter(m => m.rule.rulesetId === chrome.declarativeNetRequest.DYNAMIC_RULESET_ID)
      .map(m => ({ ruleId: m.rule.ruleId, timeStamp: m.timeStamp }));
    tabNote.value = '';
  } catch (e) {
    // e.g. Chrome's limit on how often this can be asked
    tabNote.value = `Chrome can't say right now which rules matched here (${e instanceof Error ? e.message : String(e)}).`;
  }
}

const tabLines = computed(() => tab.value
  ? tabReport(state.value, tab.value.url, matched.value, ruleInfo.value, rulesUpdatedAt.value)
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

function addHeader(list: HeaderMod[]) {
  list.push(emptyHeader());
}

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
        <input v-model="h.name" placeholder="Name" />
        <input class="grow" v-model="h.value" :disabled="h.op === 'remove'" placeholder="Value" />
        <button title="Remove" @click="removeAt(profile.requestHeaders, i)">×</button>
      </div>
      <button class="link" @click="addHeader(profile.requestHeaders)">+ request header</button>

      <h3>Response headers</h3>
      <div v-for="(h, i) in profile.responseHeaders" :key="h.id" class="row">
        <input type="checkbox" v-model="h.enabled" />
        <select v-model="h.op">
          <option>set</option>
          <option>append</option>
          <option>remove</option>
        </select>
        <input v-model="h.name" placeholder="Name" />
        <input class="grow" v-model="h.value" :disabled="h.op === 'remove'" placeholder="Value" />
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

    <footer>Runs locally. No account, no analytics, nothing is sent anywhere.</footer>
  </main>
</template>
