<script setup lang="ts">
import { computed, ref } from 'vue';
import { importModHeader } from '../core/import-modheader.ts';
import type { DbFile } from '../core/leveldb.ts';
import type { Profile, State } from '../core/model.ts';
import { MODHEADER_IDS, readModHeaderStore } from '../core/modheader-store.ts';
import { loadState, saveState } from '../core/storage.ts';

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
const howToPaste = {
  win: 'In the folder picker, paste it into the address bar at the top and press Enter.',
  mac: 'In the folder picker, press ⌘ Shift G, paste it and press Enter.',
  linux: 'In the folder picker, press Ctrl+L, paste it and press Enter.',
}[os];

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
if (welcome) document.title = 'Welcome to Headerwise';
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
    const order = [...groups.keys()].sort((a, b) => Number(ids.some(id => b.endsWith(id))) - Number(ids.some(id => a.endsWith(id))));
    for (const dir of order) {
      const files: DbFile[] = await Promise.all(groups.get(dir)!
        .filter(f => /\.(log|ldb|sst)$/i.test(f.file.name))
        .map(async f => ({ name: f.file.name, data: new Uint8Array(await f.file.arrayBuffer()) })));
      if (files.length === 0) continue;
      const { result } = readModHeaderStore(files);
      if (!result) continue;
      const { profiles, warnings } = importModHeader(JSON.stringify(result.profiles), { active: result.selected });
      found.value = { profiles, warnings, source: result.source, picked: profiles.map(() => true) };
      return;
    }
    error.value = list.length === 0
      ? 'That folder is empty.'
      : 'No ModHeader profiles in that folder. Check the path below, or try the same path with "Sync Extension Settings" instead of "Local Extension Settings".';
  } catch (e) {
    error.value = `Could not read the folder: ${e instanceof Error ? e.message : String(e)}`;
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
  return s.profiles.length === 1 && s.profiles[0].filters.length === 0
    && [...s.profiles[0].requestHeaders, ...s.profiles[0].responseHeaders].every(h => h.name.trim() === '');
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
</script>

<template>
  <main @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="onDrop" :class="{ dragging }">
    <template v-if="welcome">
      <h1>Headerwise is installed</h1>
      <section class="steps">
        <h2>Two quick steps</h2>
        <ol>
          <li>
            Let Headerwise change headers on sites. Chrome applies the changes itself; Headerwise never reads your pages.
            <span v-if="hasAccess" class="ok-text">Done.</span>
            <button v-else class="primary" @click="grantAccess">Allow on all sites</button>
          </li>
          <li>Pin the icon: click the puzzle piece in the toolbar, then the pin next to Headerwise. Click the icon to add headers.</li>
        </ol>
      </section>
      <h2 class="from">Coming from ModHeader?</h2>
    </template>
    <h1 v-else>Move your profiles from ModHeader</h1>
    <p>
      Chrome and Edge turned ModHeader off in July 2026, so its Export button is gone.
      Your profiles are still in its folder on your disk. Headerwise reads them right here,
      in this page. Nothing is uploaded or sent anywhere.
    </p>

    <section v-if="added" class="done">
      <h2>Done: {{ added }} profile{{ added === 1 ? '' : 's' }} added</h2>
      <p>Click the Headerwise icon in the toolbar to see them. Once you are happy, you can remove ModHeader from the extensions page.</p>
    </section>

    <template v-else>
      <section>
        <h2>1. Copy the path to ModHeader's folder</h2>
        <p v-if="inFirefox" class="hint">This reads ModHeader's folder from Chrome or Edge on this computer. If you used ModHeader in Firefox and it still opens, use its Export button and "Import JSON" in the Headerwise popup instead.</p>
        <div class="row">
          <label><input type="radio" value="chrome" v-model="browser" /> Chrome (also Brave, Vivaldi, Opera…)</label>
          <label><input type="radio" value="edge" v-model="browser" /> Edge</label>
        </div>
        <div class="row">
          <code class="grow">{{ folder }}</code>
          <button @click="copyPath">{{ copied ? 'Copied' : 'Copy' }}</button>
        </div>
        <p class="hint">
          If you use several browser profiles, ModHeader may be in another one: open
          <code>{{ browser === 'edge' ? 'edge' : 'chrome' }}://version</code> in the profile where you used it and replace
          <code>{{ ROOTS[os][browser] }}{{ sep }}Default</code> with its "Profile Path".
        </p>
      </section>

      <section>
        <h2>2. Pick that folder</h2>
        <p class="hint">{{ howToPaste }} The browser will ask whether to "upload" the files to this page: that only lets Headerwise read them here.</p>
        <label class="pick">
          <input type="file" webkitdirectory multiple @change="onPick" :disabled="busy" />
          <span>{{ busy ? 'Reading…' : 'Choose folder' }}</span>
        </label>
        <span class="hint">or drag the folder onto this page</span>
        <p v-if="error" class="error">{{ error }}</p>
      </section>

      <section v-if="found">
        <h2>3. Import</h2>
        <p class="hint" v-if="found.source !== 'profiles'">Restored from ModHeader's {{ found.source }}.</p>
        <ul class="profiles">
          <li v-for="(p, i) in found.profiles" :key="p.id">
            <label>
              <input type="checkbox" v-model="found.picked[i]" />
              <strong>{{ p.title }}</strong>
              <span class="hint">{{ headerCount(p) }} header{{ headerCount(p) === 1 ? '' : 's' }}<template v-if="p.filters.length">, {{ p.filters.length }} URL filter{{ p.filters.length === 1 ? '' : 's' }}</template><template v-if="p.enabled">, on</template></span>
            </label>
          </li>
        </ul>
        <ul v-if="found.warnings.length" class="warnings">
          <li v-for="(w, i) in found.warnings" :key="i">{{ w }}</li>
        </ul>
        <p class="hint">Profiles often hold tokens and cookies. They stay in this browser only.</p>
        <button class="primary" :disabled="pickedCount === 0" @click="doImport">Import {{ pickedCount }} profile{{ pickedCount === 1 ? '' : 's' }}</button>
      </section>
    </template>
  </main>
</template>
