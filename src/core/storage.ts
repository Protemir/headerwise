import { defaultState, type State } from './model.ts';

const KEY = 'state';

export async function loadState(): Promise<State> {
  const got = await chrome.storage.local.get(KEY);
  const s = got[KEY] as State | undefined;
  return s && s.version === 1 ? s : defaultState();
}

export async function saveState(state: State): Promise<void> {
  await chrome.storage.local.set({ [KEY]: state });
}

export const STATE_KEY = KEY;
