/**
 * The slice of `vscode` the manual command uses, for a virtual `jest.mock('vscode', …)`:
 *
 * jest.mock('vscode', () => jest.requireActual<typeof fake>('./vscodeFake').vscodeModule, {
 *   virtual: true,
 * });
 */

export interface FakeEditor {
  readonly document: {
    getText(): string;
    readonly languageId: string;
    readonly fileName: string;
  };
  readonly selection: {
    readonly isEmpty: boolean;
    readonly active: { readonly line: number; readonly character: number };
    readonly anchor: { readonly line: number; readonly character: number };
  };
}

export interface ShownMessage {
  readonly level: 'error' | 'info';
  readonly text: string;
}

interface FakeState {
  activeTextEditor: FakeEditor | undefined;
  workspaceFolders: { readonly uri: { readonly fsPath: string } }[] | undefined;
  messages: ShownMessage[];
  progress: unknown[];
}

export const state: FakeState = {
  activeTextEditor: undefined,
  workspaceFolders: undefined,
  messages: [],
  progress: [],
};

export function resetVscodeFake(): void {
  state.activeTextEditor = undefined;
  state.workspaceFolders = undefined;
  state.messages = [];
  state.progress = [];
}

export const vscodeModule = {
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  window: {
    get activeTextEditor(): FakeEditor | undefined {
      return state.activeTextEditor;
    },
    showErrorMessage(text: string): Promise<undefined> {
      state.messages.push({ level: 'error', text });
      return Promise.resolve(undefined);
    },
    showInformationMessage(text: string): Promise<undefined> {
      state.messages.push({ level: 'info', text });
      return Promise.resolve(undefined);
    },
    async withProgress<T>(
      options: unknown,
      task: () => Promise<T>,
    ): Promise<T> {
      state.progress.push(options);
      return task();
    },
  },
  workspace: {
    get workspaceFolders(): FakeState['workspaceFolders'] {
      return state.workspaceFolders;
    },
  },
};

/** An editor with an empty selection at (line, character), both zero-based. */
export function fakeEditor(
  source: string,
  line: number,
  character: number,
  fileName: string,
): FakeEditor {
  const position = { line, character };
  return {
    document: { getText: () => source, languageId: 'java', fileName },
    selection: { isEmpty: true, active: position, anchor: position },
  };
}

export interface Preview {
  readonly texts: readonly string[];
  readonly insertLine: number;
}

/** Records `previewAll` calls; with `failWith`, the preview throws instead. */
export function fakeController(failWith?: Error) {
  const previews: Preview[] = [];
  return {
    previews,
    async previewAll(
      _editor: unknown,
      texts: string[],
      insertLine: number,
    ): Promise<void> {
      if (failWith) {
        throw failWith;
      }
      previews.push({ texts: [...texts], insertLine });
    },
  };
}
