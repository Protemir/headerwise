import { defaultState, type State } from './model.ts';

const KEY = 'state';

export async function loadState(): Promise<State> {
  const got = await chrome.storage.local.get(KEY);
  const s = got[KEY] as State | undefined;
  return s && s.version === 1 ? s : defaultState();
}

export async function saveState(state: State): Promise<void> {
  // Plain copy: Chrome stores arrays inside Vue's reactive proxies as {"0": ...} objects.
  await chrome.storage.local.set({ [KEY]: JSON.parse(JSON.stringify(state)) });
}

export const STATE_KEY = KEY;

/** Small facts about this install, kept apart from the profiles. */
export interface Meta {
  installedAt?: number;
  rateDone?: boolean;
}

export async function loadMeta(): Promise<Meta> {
  const got = await chrome.storage.local.get('meta');
  return (got.meta as Meta | undefined) ?? {};
}

export async function saveMeta(patch: Meta): Promise<void> {
  await chrome.storage.local.set({ meta: { ...(await loadMeta()), ...patch } });
}
