import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Action, createSelector, NgxsOnInit, Selector, State, StateContext } from '@ngxs/store';
import { firstValueFrom } from 'rxjs';
import { DEFAULT_BACKEND_ROOT } from '../../environments';
import { FlagsService } from '../api-client/api/flags.service';
import { FlagFileContent } from '../models/flag.models';
import { FileSystemAccess } from '../services/file-system-access';
import {
  AddBackend,
  RemoveBackend,
  AddFile,
  RemoveFile,
  UpdateFileContent,
  BackendType,
  SyncBackends,
} from './flag-file-store.actions';

/**
 * Represents a flag file in a backend.
 */
export interface FlagFile {
  name: string;
  content: string;
  isDirty?: boolean;
}

/**
 * Represents a backend connection.
 * Local storage (both browser and disk) use hardcoded IDs 'local-browser' and 'local-disk'.
 * Remote backends have URL-based IDs.
 */
export interface Backend {
  uri: string; // 'local-browser', 'local-disk', or URL-based id for remote
  label: string; // Display label
  files: FlagFile[]; // Files in this backend
  isHydrated?: boolean;
}

export interface FlagFileStoreStateModel {
  // Double map: storage type ('local' or 'remote') -> id -> backend
  backends: Record<'local' | 'remote', Record<string, Backend>>;
}

export const LocalBackendUris = {
  Browser: 'browser',
  Disk: 'disk',
};

@State<FlagFileStoreStateModel>({
  name: 'flagFileStore',
  defaults: {
    backends: {
      local: {
        [LocalBackendUris.Browser]: {
          uri: LocalBackendUris.Browser,
          label: 'Local Files (Browser)',
          files: [],
          isHydrated: true,
        },
        [LocalBackendUris.Disk]: {
          uri: LocalBackendUris.Disk,
          label: 'Local Files (Disk)',
          files: [],
          isHydrated: true,
        },
      },
      remote: {},
    },
  },
})
@Injectable()
export class FlagFileStore implements NgxsOnInit {
  private readonly httpClient = inject(HttpClient);
  private readonly fileSystemAccess = inject(FileSystemAccess);

  private isSyncTrackedBackend(backendType: BackendType, uri: string): boolean {
    return backendType === 'remote' || (backendType === 'local' && uri === LocalBackendUris.Disk);
  }

  ngxsOnInit(ctx: StateContext<FlagFileStoreStateModel>): void {
    let defaultRoot = DEFAULT_BACKEND_ROOT;

    // If DEFAULT_BACKEND_ROOT is null, undefined, or empty string, use current URL base
    if (!defaultRoot) {
      defaultRoot = window.location.origin;
    }

    const normalized = this.normalizeUrl(defaultRoot);
    const state = ctx.getState();
    const remoteBackends = state?.backends?.remote ?? {};
    if (remoteBackends[normalized]) {
      ctx.dispatch(new SyncBackends('remote', normalized));
      return;
    }

    ctx.patchState({
      backends: {
        ...state.backends,
        remote: {
          ...remoteBackends,
          [normalized]: {
            uri: normalized,
            label: defaultRoot,
            files: [],
            isHydrated: false,
          },
        },
      },
    });

    ctx.dispatch(new SyncBackends('remote', normalized));
  }

  @Selector()
  static backends(state: FlagFileStoreStateModel): Backend[] {
    if (!state?.backends) {
      return [];
    }
    const backends: Backend[] = [];
    for (const typeMap of Object.values(state.backends)) {
      backends.push(...Object.values(typeMap));
    }
    return backends;
  }

  @Selector()
  static backendsMap(
    state: FlagFileStoreStateModel,
  ): Record<'local' | 'remote', Record<string, Backend>> {
    return state?.backends ?? { local: {}, remote: {} };
  }

  static backendsByType(backendType: BackendType) {
    return createSelector([FlagFileStore], (state: FlagFileStoreStateModel): Backend[] => {
      return Object.values(state?.backends?.[backendType] || {});
    });
  }

  static backend() {
    return (backendType: BackendType, uri: string) =>
      createSelector(
        [FlagFileStore],
        (state: FlagFileStoreStateModel): Backend | undefined =>
          state?.backends?.[backendType]?.[uri],
      );
  }

  @Action(AddBackend)
  addBackend(ctx: StateContext<FlagFileStoreStateModel>, action: AddBackend): void {
    const state = ctx.getState();
    const normalized = this.normalizeUrl(action.uri);

    // Check if backend already exists
    const existing = Object.values(state.backends.remote).find(
      (backend) => backend.uri === normalized,
    );
    if (existing) {
      throw new Error('Backend already exists');
    }

    const backend: Backend = {
      uri: normalized,
      label: action.label,
      files: [],
      isHydrated: false,
    };

    ctx.patchState({
      backends: {
        ...state.backends,
        remote: {
          ...state.backends.remote,
          [normalized]: backend,
        },
      },
    });
  }

  @Action(RemoveBackend)
  removeBackend(ctx: StateContext<FlagFileStoreStateModel>, action: RemoveBackend): void {
    // Cannot remove local backends
    if (action.backendType === 'local') {
      throw new Error('Cannot remove local backends');
    }

    const state = ctx.getState();
    const uriMap = state.backends[action.backendType];
    if (!uriMap || !uriMap[action.uri]) {
      throw new Error(`Backend "${action.uri}" not found`);
    }

    const nextTypeMap = { ...uriMap };
    delete nextTypeMap[action.uri];

    ctx.patchState({
      backends: {
        ...state.backends,
        [action.backendType]: nextTypeMap,
      },
    });
  }

  @Action(AddFile)
  addFile(ctx: StateContext<FlagFileStoreStateModel>, action: AddFile): void {
    const state = ctx.getState();
    const uriMap = state.backends[action.backendType];
    const backend = uriMap?.[action.uri];

    if (!backend) {
      throw new Error(`Backend "${action.uri}" of type "${action.backendType}" not found`);
    }

    // Check if file already exists in this backend
    if (backend.files.some((f) => f.name === action.fileName)) {
      throw new Error(`File "${action.fileName}" already exists in this backend`);
    }

    const updatedBackend: Backend = {
      ...backend,
      isHydrated: action.backendType === 'remote' ? (backend.isHydrated ?? false) || true : true,
      files: [
        ...backend.files,
        {
          name: action.fileName,
          content: this.toDeterministicContent(action.content),
          isDirty:
            this.isSyncTrackedBackend(action.backendType, action.uri) && action.isDirty
              ? true
              : false,
        },
      ],
    };

    ctx.patchState({
      backends: {
        ...state.backends,
        [action.backendType]: {
          ...uriMap,
          [action.uri]: updatedBackend,
        },
      },
    });
  }

  @Action(RemoveFile)
  removeFile(ctx: StateContext<FlagFileStoreStateModel>, action: RemoveFile): void {
    const state = ctx.getState();
    const uriMap = state.backends[action.backendType];
    const backend = uriMap?.[action.uri];

    if (!backend) {
      throw new Error(`Backend "${action.uri}" of type "${action.backendType}" not found`);
    }

    if (action.backendType === 'local' && action.uri === LocalBackendUris.Disk) {
      this.fileSystemAccess.unbindFlagsFile(action.fileName);
    }

    const updatedBackend: Backend = {
      ...backend,
      files: backend.files.filter((f) => f.name !== action.fileName),
    };

    ctx.patchState({
      backends: {
        ...state.backends,
        [action.backendType]: {
          ...uriMap,
          [action.uri]: updatedBackend,
        },
      },
    });
  }

  @Action(UpdateFileContent)
  updateFileContent(ctx: StateContext<FlagFileStoreStateModel>, action: UpdateFileContent): void {
    const state = ctx.getState();
    const uriMap = state.backends[action.backendType];
    const backend = uriMap?.[action.uri];

    if (!backend) {
      throw new Error(`Backend "${action.uri}" of type "${action.backendType}" not found`);
    }

    const fileIndex = backend.files.findIndex((f) => f.name === action.fileName);
    if (fileIndex === -1) {
      throw new Error(`File "${action.fileName}" not found in backend "${action.uri}"`);
    }

    const normalizedContent = this.toDeterministicContent(action.content);
    const file = backend.files[fileIndex];
    const hasChanged = file.content !== normalizedContent;
    if (!hasChanged) {
      return;
    }

    const updatedFiles = [...backend.files];
    updatedFiles[fileIndex] = {
      ...updatedFiles[fileIndex],
      content: normalizedContent,
      isDirty:
        hasChanged && this.isSyncTrackedBackend(action.backendType, action.uri)
          ? true
          : updatedFiles[fileIndex].isDirty,
    };

    const updatedBackend: Backend = {
      ...backend,
      files: updatedFiles,
    };

    ctx.patchState({
      backends: {
        ...state.backends,
        [action.backendType]: {
          ...uriMap,
          [action.uri]: updatedBackend,
        },
      },
    });
  }

  @Action(SyncBackends)
  async syncBackends(
    ctx: StateContext<FlagFileStoreStateModel>,
    action: SyncBackends,
  ): Promise<void> {
    const state = ctx.getState();

    const backend = state.backends[action.backendType]?.[action.uri];
    if (!backend) {
      return;
    }

    if (action.backendType === 'remote') {
      if (!backend.isHydrated) {
        await this.importRemoteBackend(ctx, backend);
        return;
      }

      // Only sync files the user has explicitly edited (isDirty), then
      // import the server's current state. Previously this synced ALL
      // cached files (including stale localStorage state) before importing,
      // which overwrote external edits on page load.
      const hasDirtyFiles = backend.files.some((f) => f.isDirty);
      if (hasDirtyFiles) {
        await this.syncRemoteBackend(ctx, backend);
      }
      await this.importRemoteBackend(ctx, backend);
      return;
    }

    if (action.backendType === 'local' && action.uri === LocalBackendUris.Disk) {
      await this.syncDiskBackend(ctx);
      await this.importDiskBackend(ctx);
    }
  }

  // ============================================================================
  // PRIVATE HELPERS
  // ============================================================================
  private async syncRemoteBackend(
    ctx: StateContext<FlagFileStoreStateModel>,
    backend: Backend,
  ): Promise<void> {
    const api = new FlagsService(this.httpClient, backend.uri);

    try {
      const dirtyFiles = backend.files.filter((f) => f.isDirty);
      if (dirtyFiles.length === 0) {
        return;
      }

      const listResponse = await firstValueFrom(api.listFlags());
      const remoteFileNames = new Set(listResponse?.files ?? []);

      for (const file of dirtyFiles) {
        const parsed = this.parseFlagFileContent(file.content);
        if (!parsed) {
          continue;
        }

        const updatePayload: FlagFileContent = {
          $evaluators: parsed.$evaluators ?? {},
          flags: parsed.flags,
          metadata: parsed.metadata ?? {},
        };

        if (remoteFileNames.has(file.name)) {
          await firstValueFrom(api.updateFlag(file.name, updatePayload));
        } else {
          await firstValueFrom(api.createFlag(file.name, updatePayload));
        }
      }

      this.markBackendFilesSynced(ctx, 'remote', backend.uri);
    } catch {
      return;
    }
  }

  private async syncDiskBackend(ctx: StateContext<FlagFileStoreStateModel>): Promise<void> {
    const state = ctx.getState();
    const backend = state.backends.local[LocalBackendUris.Disk];
    if (!backend) {
      return;
    }

    try {
      for (const file of backend.files) {
        const parsed = this.parseFlagFileContent(file.content);
        if (!parsed) {
          continue;
        }

        await this.fileSystemAccess.persistBoundFlagsFile(file.name, parsed);
      }

      this.markBackendFilesSynced(ctx, 'local', LocalBackendUris.Disk);
    } catch {
      return;
    }
  }

  private async importRemoteBackend(
    ctx: StateContext<FlagFileStoreStateModel>,
    backend: Backend,
  ): Promise<void> {
    const api = new FlagsService(this.httpClient, backend.uri);

    try {
      const listResponse = await firstValueFrom(api.listFlags());
      const files = listResponse?.files ?? [];

      const imported = await Promise.all(
        files.map(async (name) => {
          const content = await firstValueFrom(api.getFlag(name));
          return {
            name,
            content: this.toDeterministicContent(JSON.stringify(content, null, 2)),
            isDirty: false,
          };
        }),
      );

      this.upsertBackendFiles(ctx, 'remote', backend.uri, imported);
      this.markBackendHydrated(ctx, 'remote', backend.uri);
    } catch {
      return;
    }
  }

  private async importDiskBackend(ctx: StateContext<FlagFileStoreStateModel>): Promise<void> {
    const bound = await this.fileSystemAccess.readBoundFlagsFiles();
    if (!bound.length) {
      return;
    }

    const imported = bound.map((entry) => ({
      name: entry.name,
      content: this.toDeterministicContent(JSON.stringify(entry.content, null, 2)),
      isDirty: false,
    }));

    this.upsertBackendFiles(ctx, 'local', LocalBackendUris.Disk, imported);
  }

  private upsertBackendFiles(
    ctx: StateContext<FlagFileStoreStateModel>,
    backendType: BackendType,
    uri: string,
    imported: { name: string; content: string; isDirty?: boolean }[],
  ): void {
    const state = ctx.getState();
    const uriMap = state.backends[backendType];
    const backend = uriMap?.[uri];
    if (!backend) {
      return;
    }

    const incomingMap = new Map(imported.map((entry) => [entry.name, entry]));
    const updatedFiles = backend.files.map((file) => {
      const incoming = incomingMap.get(file.name);
      if (!incoming) {
        return file;
      }
      incomingMap.delete(file.name);
      return {
        name: file.name,
        content: this.toDeterministicContent(incoming.content),
        isDirty: incoming.isDirty ?? false,
      };
    });

    for (const incoming of incomingMap.values()) {
      updatedFiles.push({
        name: incoming.name,
        content: this.toDeterministicContent(incoming.content),
        isDirty: incoming.isDirty ?? false,
      });
    }

    ctx.patchState({
      backends: {
        ...state.backends,
        [backendType]: {
          ...uriMap,
          [uri]: {
            ...backend,
            files: updatedFiles,
          },
        },
      },
    });
  }

  private markBackendFilesSynced(
    ctx: StateContext<FlagFileStoreStateModel>,
    backendType: BackendType,
    uri: string,
  ): void {
    const state = ctx.getState();
    const uriMap = state.backends[backendType];
    const backend = uriMap?.[uri];
    if (!backend) {
      return;
    }

    const updatedBackend: Backend = {
      ...backend,
      files: backend.files.map((file) => ({
        ...file,
        isDirty: false,
      })),
    };

    ctx.patchState({
      backends: {
        ...state.backends,
        [backendType]: {
          ...uriMap,
          [uri]: updatedBackend,
        },
      },
    });
  }

  private normalizeUrl(url: string): string {
    // Remove trailing slashes and normalize the URL
    return url.replace(/\/$/, '').toLowerCase();
  }

  private markBackendHydrated(
    ctx: StateContext<FlagFileStoreStateModel>,
    backendType: BackendType,
    uri: string,
  ): void {
    const state = ctx.getState();
    const uriMap = state.backends[backendType];
    const backend = uriMap?.[uri];
    if (!backend) {
      return;
    }

    if (backend.isHydrated) {
      return;
    }

    const updatedBackend: Backend = {
      ...backend,
      isHydrated: true,
    };

    ctx.patchState({
      backends: {
        ...state.backends,
        [backendType]: {
          ...uriMap,
          [uri]: updatedBackend,
        },
      },
    });
  }

  private tryParseJson(content: string): unknown | undefined {
    try {
      return JSON.parse(content) as unknown;
    } catch {
      return undefined;
    }
  }

  private toDeterministicContent(content: string): string {
    const parsed = this.tryParseJson(content);
    if (parsed === undefined) {
      return content;
    }

    return JSON.stringify(this.sortJson(parsed));
  }

  private sortJson(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.sortJson(item));
    }

    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = this.sortJson(record[key]);
          return acc;
        }, {});
    }

    return value;
  }

  private parseFlagFileContent(content: string): FlagFileContent | null {
    try {
      const parsed = JSON.parse(content) as FlagFileContent;
      if (!parsed.flags || typeof parsed.flags !== 'object' || Array.isArray(parsed.flags)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }
}
