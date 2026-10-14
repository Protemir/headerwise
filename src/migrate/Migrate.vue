<script setup lang="ts">
import { computed, ref } from 'vue';
import { importModHeader } from '../core/import-modheader.ts';
import type { DbFile } from '../core/leveldb.ts';
import type { Profile, State } from '../core/model.ts';
import { MODHEADER_IDS, readModHeaderStore } from '../core/modheader-store.ts';
import { loadState, saveState } from '../core/storage.ts';
import { t, tn } from '../core/i18n.ts';

type Browser = keyof typeof MODHEADER_IDS;

const platform = navigator.platform;
const os = /Mac/.test(platform) ? 'mac' : /Win/.test(platform) ? 'win' : 'linux';
const browser = ref<Browser>(navigator.userAgent.includes('Edg/') ? 'edge' : 'chrome');
// Firefox keeps extension data in its own format; this page reads Chrome's and Edge's.
const inFirefox = navigator.userAgent.includes('Firefox/');

const ROOTS: Record<typeof os, Record<Browser, string>> = {
  win: { chrome: '%LOCALAPPDATA%\\Google\\Chrome\\User Data', edge: '%LOCALAPPDATA%\\Microsoft\\Edge\\User Data' },
  mac: { chrome: '~/Library/Application Support/Google/Chrome', edge: '~/Library/Application Support/Microsoft Edge' },
  linux: { chrome: '~/.config/google-chrome', edge: '~/.config/microsoft-edge' },
};
const sep = os === 'win' ? '\\' : '/';
const folder = computed(() => [ROOTS[os][browser.value], 'Default', 'Local Extension Settings', MODHEADER_IDS[browser.value]].join(sep));
const howToPaste = { win: t('m_pasteWin'), mac: t('m_pasteMac'), linux: t('m_pasteLinux') }[os];

const copied = ref(false);
async function copyPath() {
  await navigator.clipboard.writeText(folder.value);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}

interface Found {
  profiles: Profile[];
  warnings: string[];
  source: string;
  picked: boolean[];
}

const busy = ref(false);
const error = ref('');
const found = ref<Found | null>(null);
const added = ref(0);

// Opened right after install as ?welcome=1: first steps, then the ModHeader move.
const welcome = new URLSearchParams(location.search).has('welcome');
document.title = welcome ? t('m_titleWelcome') : t('m_titleMove');
const ALL_SITES = { origins: ['<all_urls>'] };
const hasAccess = ref(false);
chrome.permissions.contains(ALL_SITES).then(v => (hasAccess.value = v));
async function grantAccess() {
  hasAccess.value = await chrome.permissions.request(ALL_SITES);
}

// Files from the picker or a drop, grouped by the folder they are in: people may
// pick "Local Extension Settings" itself instead of the ModHeader folder inside.
async function readFiles(list: { path: string; file: File }[]) {
  busy.value = true;
  error.value = '';
  found.value = null;
  added.value = 0;
  try {
    const groups = new Map<string, { path: string; file: File }[]>();
    for (const f of list) {
      const dir = f.path.split('/').slice(0, -1).join('/');
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir)!.push(f);
    }
    const ids = Object.values(MODHEADER_IDS);
    const unreadable: string[] = [];
    const order = [...groups.keys()].sort((a, b) => Number(ids.some(id => b.endsWith(id))) - Number(ids.some(id => a.endsWith(id))));
    for (const dir of order) {
      const files: DbFile[] = await Promise.all(groups.get(dir)!
        .filter(f => /\.(log|ldb|sst)$/i.test(f.file.name))
        .map(async f => ({ name: f.file.name, data: new Uint8Array(await f.file.arrayBuffer()) })));
      if (files.length === 0) continue;
      const { result, errors } = readModHeaderStore(files);
      unreadable.push(...errors);
      if (!result) continue;
      const { profiles, warnings } = importModHeader(JSON.stringify(result.profiles), { active: result.selected });
      // A damaged file can hide newer profiles: say so instead of quietly showing older ones.
      if (errors.length) warnings.unshift(t('m_someUnreadable', { errors: errors.join('; ') }));
      found.value = { profiles, warnings, source: result.source, picked: profiles.map(() => true) };
      return;
    }
    error.value = list.length === 0
      ? t('m_folderEmpty')
      : unreadable.length
        ? t('m_cantReadFiles', { errors: unreadable.join('; ') })
        : t('m_noProfiles');
  } catch (e) {
    error.value = t('m_cantReadFolder', { error: e instanceof Error ? e.message : String(e) });
  } finally {
    busy.value = false;
  }
}

function onPick(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])].map(file => ({ path: file.webkitRelativePath || file.name, file }));
  input.value = '';
  readFiles(files);
}

// Drag and drop of a folder from Explorer / Finder.
async function entryFiles(entry: FileSystemEntry, prefix = ''): Promise<{ path: string; file: File }[]> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise<File>((ok, fail) => (entry as FileSystemFileEntry).file(ok, fail));
    return [{ path, file }];
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
    if (batch.length === 0) break;
    children.push(...batch);
  }
  return (await Promise.all(children.map(c => entryFiles(c, path)))).flat();
}

const dragging = ref(false);
async function onDrop(e: DragEvent) {
  dragging.value = false;
  const entries = [...(e.dataTransfer?.items ?? [])].map(i => i.webkitGetAsEntry()).filter((x): x is FileSystemEntry => x !== null);
  readFiles((await Promise.all(entries.map(x => entryFiles(x)))).flat());
}

// A fresh install has one empty "Profile 1"; replace it instead of keeping it around.
function isUntouched(s: State): boolean {
  const p = s.profiles[0];
  return s.profiles.length === 1 && (p.title === 'Profile 1' || p.title === t('profileN', { n: 1 })) && p.filters.length === 0
    && !p.redirects?.length && !p.initiatorDomains?.length && !p.excludedInitiatorDomains?.length
    && !p.resourceTypes?.length && !p.requestMethods?.length && !p.tab
    && [...p.requestHeaders, ...p.responseHeaders].every(h => h.name.trim() === '');
}

const pickedCount = computed(() => found.value?.picked.filter(Boolean).length ?? 0);

async function doImport() {
  if (!found.value) return;
  const chosen = found.value.profiles.filter((_, i) => found.value!.picked[i]);
  const state = await loadState();
  state.profiles = isUntouched(state) ? chosen : [...state.profiles, ...chosen];
  await saveState(state);
  added.value = chosen.length;
  found.value = null;
}

function headerCount(p: Profile): number {
  return p.requestHeaders.length + p.responseHeaders.length;
}

// "backup from 2026-07-01" comes from the store reader in English.
const backupDate = (source: string) => source.replace(/^backup from /, '');
const profilesHint = computed(() => t('m_profilesHint', {
  version: `${browser.value === 'edge' ? 'edge' : 'chrome'}://version`,
  path: `${ROOTS[os][browser.value]}${sep}Default`,
}));
</script>

<template>
  <main @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="onDrop" :class="{ dragging }">
    <template v-if="welcome">
      <h1>{{ t('m_installed') }}</h1>
      <section class="steps">
        <h2>{{ t('m_twoSteps') }}</h2>
        <ol>
          <li>
            {{ t('m_stepAccess') }}
            <span v-if="hasAccess" class="ok-text">{{ t('m_done') }}</span>
            <button v-else class="primary" @click="grantAccess">{{ t('allowAllSites') }}</button>
          </li>
          <li>{{ t('m_stepPin') }}</li>
        </ol>
      </section>
      <h2 class="from">{{ t('m_comingFrom') }}</h2>
    </template>
    <h1 v-else>{{ t('m_moveTitle') }}</h1>
    <p>{{ t('m_intro') }}</p>

    <section v-if="added" class="done">
      <h2>{{ tn('m_added', added) }}</h2>
      <p>{{ t('m_addedHint') }}</p>
    </section>

    <template v-else>
      <section>
        <h2>{{ t('m_step1') }}</h2>
        <p v-if="inFirefox" class="hint">{{ t('m_firefoxHint') }}</p>
        <div class="row">
          <label><input type="radio" value="chrome" v-model="browser" /> {{ t('m_chromeAlso') }}</label>
          <label><input type="radio" value="edge" v-model="browser" /> Edge</label>
        </div>
        <div class="row">
          <code class="grow">{{ folder }}</code>
          <button @click="copyPath">{{ copied ? t('copied') : t('copy') }}</button>
        </div>
        <p class="hint">{{ profilesHint }}</p>
      </section>

      <section>
        <h2>{{ t('m_step2') }}</h2>
        <p class="hint">{{ howToPaste }} {{ t('m_uploadHint') }}</p>
        <label class="pick">
          <input type="file" webkitdirectory multiple @change="onPick" :disabled="busy" />
          <span>{{ busy ? t('m_reading') : t('m_chooseFolder') }}</span>
        </label>
        <span class="hint">{{ t('m_orDrag') }}</span>
        <p v-if="error" class="error">{{ error }}</p>
      </section>

      <section v-if="found">
        <h2>{{ t('m_step3') }}</h2>
        <p class="hint" v-if="found.source !== 'profiles'">{{ t('m_restoredBackup', { date: backupDate(found.source) }) }}</p>
        <ul class="profiles">
          <li v-for="(p, i) in found.profiles" :key="p.id">
            <label>
              <input type="checkbox" v-model="found.picked[i]" />
              <strong>{{ p.title }}</strong>
              <span class="hint">{{ tn('m_headers', headerCount(p)) }}<template v-if="p.filters.length">, {{ tn('m_urlFilters', p.filters.length) }}</template><template v-if="p.enabled">, {{ t('m_on') }}</template></span>
            </label>
          </li>
        </ul>
        <ul v-if="found.warnings.length" class="warnings">
          <li v-for="(w, i) in found.warnings" :key="i">{{ w }}</li>
        </ul>
        <p class="hint">{{ t('m_tokensHint') }}</p>
        <button class="primary" :disabled="pickedCount === 0" @click="doImport">{{ tn('m_import', pickedCount) }}</button>
      </section>
    </template>
  </main>
</template>
