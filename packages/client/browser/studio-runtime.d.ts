export interface StudioScope {
  user?: string;
  project: string;
  resource: string;
}

export interface StudioRealtimeScope {
  project: string;
  resource?: string;
  websocket?: boolean;
  schemaRevision?: number;
}

export interface StudioResourceSchema {
  fields?: Record<string, unknown>;
  timestamps?: boolean;
}

export type StudioConnectionStatus = 'connecting' | 'connected' | 'local' | 'offline';

export interface StudioRealtimeChange {
  type: 'change' | 'schema';
  table?: string;
  cursor?: number;
  revision?: number;
  [key: string]: unknown;
}

export interface FieldMergeDecision {
  conflicts: string[];
  mergeable: string[];
  needsWrite: boolean;
}

export type StudioApi = (route: string, options?: RequestInit) => Promise<any>;

export interface StudioClient {
  cacheableGet(route: string): boolean;
  cachedGet<T>(route: string, fetcher: () => Promise<T>): Promise<T>;
  cachedResource(scope: StudioScope): Promise<any>;
  queueCreate(
    scope: StudioScope,
    record: Record<string, unknown>,
    resource?: { id_type?: string },
  ): Promise<any>;
  queueUpdate(scope: StudioScope, id: string | number, patch: Record<string, unknown>): Promise<any>;
  queueDelete(scope: StudioScope, id: string | number): Promise<any>;
  sync(scope: StudioScope, api: StudioApi): Promise<any>;
  discardConflicts(scope: StudioScope, api: StudioApi): Promise<any>;
  retryConflicts(scope: StudioScope, api: StudioApi): Promise<any>;
  applySchema(scope: StudioScope, resource: StudioResourceSchema, revision: number): Promise<any>;
  clearAll(): Promise<void>;
  fieldMergeDecision(
    base: Record<string, unknown>,
    server: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): FieldMergeDecision;
  subscribeRealtime(
    scope: StudioRealtimeScope,
    onChange: (change: StudioRealtimeChange) => void,
    onStatus?: (status: StudioConnectionStatus) => void,
  ): () => void;
  publishRealtime(scope: StudioScope): void;
  publishSchema(scope: Pick<StudioScope, 'project'>, revision: number): void;
  isOnline(): boolean;
  subscribe(listener: (online: boolean) => void): () => void;
}

export function createStudioClient(options?: { apiBase?: string }): StudioClient;

export function fieldMergeDecision(
  base: Record<string, unknown>,
  server: Record<string, unknown>,
  patch: Record<string, unknown>,
): FieldMergeDecision;

export function reconcileSchemaState<T>(
  value: T,
  resource: StudioResourceSchema,
  revision: number,
): T;
