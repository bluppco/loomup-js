'use strict';

  const DATABASE = 'loomup-studio-offline-v1';
  const STORE = 'state';
  const listeners = new Set();
  const localChangeListeners = new Set();
  const localLocks = new Map();
  let online = typeof navigator === 'undefined' ? true : navigator.onLine;
  const localChannel = typeof window !== 'undefined' && typeof BroadcastChannel === 'function'
    ? new BroadcastChannel('loomup-studio-records')
    : null;

  localChannel?.addEventListener('message', event => {
    for (const listener of localChangeListeners) listener(event.data);
  });

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function transact(mode, operation) {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE, mode);
        const store = transaction.objectStore(STORE);
        let result;
        try { result = operation(store); } catch (error) { reject(error); return; }
        transaction.oncomplete = () => resolve(result?.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('Offline storage transaction aborted'));
      });
    } finally {
      database.close();
    }
  }

  const get = key => transact('readonly', store => store.get(key));
  const put = (key, value) => transact('readwrite', store => store.put(value, key));

  function setOnline(value) {
    if (online === value) return;
    online = value;
    for (const listener of listeners) listener(online);
  }

  function cacheableGet(route) {
    return route === '/auth/me' || route === '/workspaces' || route === '/projects' ||
      /^\/projects\/[^/]+$/.test(route) || /^\/projects\/[^/]+\/studio\/schema$/.test(route);
  }

  async function cachedGet(route, fetcher) {
    try {
      const value = await fetcher();
      try { await put('api:' + route, { value, saved_at: Date.now() }); } catch {}
      setOnline(true);
      return value;
    } catch (error) {
      if (error?.status) throw error;
      setOnline(false);
      let cached;
      try { cached = await get('api:' + route); } catch {}
      if (!cached) throw error;
      return cached.value;
    }
  }

  function identifier() {
    return typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  function resourceKey(scope) {
    return ['resource', scope.user, scope.project, scope.resource].join(':');
  }

  function blank() {
    return { format: 1, rows: {}, pending: [], conflicts: [], cursor: 0, schema_version: '', saved_at: 0 };
  }

  async function load(scope) {
    const value = await get(resourceKey(scope));
    return value?.format === 1 ? value : blank();
  }

  async function save(scope, value) {
    value.saved_at = Date.now();
    await put(resourceKey(scope), value);
    return value;
  }

  function applyMutation(rows, mutation) {
    const key = String(mutation.temp_id || mutation.record_id || '');
    if (mutation.operation === 'create') {
      rows[key] = { data: { ...(mutation.data || {}), id: mutation.temp_id || mutation.record_id }, version: 0 };
    } else if (mutation.operation === 'update' && rows[key]) {
      rows[key] = { ...rows[key], data: { ...rows[key].data, ...(mutation.data || {}) } };
    } else if (mutation.operation === 'delete') {
      delete rows[key];
    }
  }

  function view(value) {
    const queued = [...value.pending, ...value.conflicts.map(item => item.mutation)];
    const pendingIds = new Set(queued.map(item => String(item.temp_id || item.record_id || '')));
    const conflictFields = new Set(value.conflicts.flatMap(item => item.fields || []));
    const conflictCells = {};
    for (const conflict of value.conflicts) {
      const id = String(conflict.mutation.record_id || conflict.mutation.temp_id || '');
      conflictCells[id] = [...new Set([...(conflictCells[id] || []), ...(conflict.fields || [])])];
    }
    return {
      data: Object.values(value.rows).map(item => item.data),
      meta: {
        total: Object.keys(value.rows).length,
        pending: value.pending.length,
        conflicts: value.conflicts.length,
        conflict_fields: [...conflictFields],
        conflict_cells: conflictCells,
        pending_ids: [...pendingIds],
        cached_at: value.saved_at,
      },
    };
  }

  async function cachedResource(scope) {
    const value = await load(scope);
    return value.saved_at ? view(value) : null;
  }

  function schemaFields(resource) {
    return new Set([
      'id',
      ...Object.keys(resource?.fields || {}),
      ...(resource?.timestamps === false ? [] : ['created_at', 'updated_at']),
    ]);
  }

  function selectSchemaFields(data, allowed) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
    return Object.fromEntries(Object.entries(data).filter(([field]) => allowed.has(field)));
  }

  function splitSchemaFields(data, allowed) {
    const kept = {};
    const removed = {};
    for (const [field, value] of Object.entries(data || {})) {
      (allowed.has(field) ? kept : removed)[field] = value;
    }
    return { kept, removed };
  }

  function reconcileSchemaState(value, resource, revision) {
    const allowed = schemaFields(resource);
    for (const row of Object.values(value.rows || {})) {
      row.data = selectSchemaFields(row.data, allowed);
    }

    const schemaConflicts = [];
    const pending = [];
    for (const mutation of value.pending || []) {
      if (!['create', 'update'].includes(mutation.operation)) {
        pending.push(mutation);
        continue;
      }
      const { kept, removed } = splitSchemaFields(mutation.data, allowed);
      const removedFields = Object.keys(removed);
      const nextMutation = {
        ...mutation,
        data: kept,
        ...(mutation.base_data ? { base_data: selectSchemaFields(mutation.base_data, allowed) } : {}),
      };
      if (mutation.operation === 'create' || Object.keys(kept).length) pending.push(nextMutation);
      if (removedFields.length) {
        schemaConflicts.push({
          mutation: { ...mutation, data: removed },
          fields: removedFields,
          error: {
            code: 'schema_changed',
            message: 'The schema removed or renamed this field before the local change synced',
          },
        });
      }
    }

    const conflicts = [];
    for (const conflict of value.conflicts || []) {
      const mutation = conflict.mutation || {};
      if (!['create', 'update'].includes(mutation.operation)) {
        conflicts.push({
          ...conflict,
          ...(conflict.server ? { server: selectSchemaFields(conflict.server, allowed) } : {}),
        });
        continue;
      }
      const { kept, removed } = splitSchemaFields(mutation.data, allowed);
      const keptFields = Object.keys(kept);
      const removedFields = Object.keys(removed);
      if (keptFields.length) {
        conflicts.push({
          ...conflict,
          mutation: {
            ...mutation,
            data: kept,
            ...(mutation.base_data ? { base_data: selectSchemaFields(mutation.base_data, allowed) } : {}),
          },
          fields: (conflict.fields || keptFields).filter(field => allowed.has(field)),
          ...(conflict.server ? { server: selectSchemaFields(conflict.server, allowed) } : {}),
        });
      }
      if (removedFields.length) {
        conflicts.push({
          mutation: { ...mutation, data: removed },
          fields: removedFields,
          error: {
            code: 'schema_changed',
            message: 'The schema removed or renamed this field before the local change synced',
          },
        });
      }
    }
    value.pending = pending;
    value.conflicts = [...conflicts, ...schemaConflicts];
    value.schema_version = String(revision ?? '');
    return value;
  }

  async function applySchema(scope, resource, revision) {
    return withLock('loomup-studio-state:' + resourceKey(scope), async () => {
      const value = await load(scope);
      const exists = value.saved_at || Object.keys(value.rows).length ||
        value.pending.length || value.conflicts.length;
      if (!exists) return null;
      reconcileSchemaState(value, resource, revision);
      await save(scope, value);
      return view(value);
    });
  }

  async function queueCreate(scope, data, resource) {
    return withLock('loomup-studio-state:' + resourceKey(scope), async () => {
      const value = await load(scope);
      const mutationId = identifier();
      const textId = resource?.id_type === 'text';
      const recordId = textId ? String(data.id || identifier()) : null;
      const tempId = recordId || 'pending:' + mutationId.slice(0, 8);
      const mutation = {
        id: mutationId,
        resource: scope.resource,
        operation: 'create',
        ...(recordId ? { record_id: recordId } : {}),
        data: { ...data, ...(recordId ? { id: recordId } : {}) },
        temp_id: tempId,
        created_at: Date.now(),
      };
      value.pending.push(mutation);
      applyMutation(value.rows, mutation);
      await save(scope, value);
      return view(value);
    });
  }

  async function queueUpdate(scope, id, patch) {
    return withLock('loomup-studio-state:' + resourceKey(scope), async () => {
      const value = await load(scope);
      const key = String(id);
      const row = value.rows[key];
      if (!row) throw new Error('Cached record is no longer available');
      const create = value.pending.find(item => item.operation === 'create' &&
        String(item.temp_id || item.record_id) === key);
      if (create) {
        create.data = { ...create.data, ...patch };
        applyMutation(value.rows, { operation: 'update', record_id: key, data: patch });
      } else {
        let update = value.pending.find(item => item.operation === 'update' && String(item.record_id) === key);
        if (update) update.data = { ...update.data, ...patch };
        else {
          update = {
            id: identifier(), resource: scope.resource, operation: 'update', record_id: key,
            data: patch, base_sequence: row.version, base_data: structuredClone(row.data),
            created_at: Date.now(),
          };
          value.pending.push(update);
        }
        applyMutation(value.rows, update);
      }
      await save(scope, value);
      return view(value);
    });
  }

  async function queueDelete(scope, id) {
    return withLock('loomup-studio-state:' + resourceKey(scope), async () => {
      const value = await load(scope);
      const key = String(id);
      const row = value.rows[key];
      if (!row) return view(value);
      const createIndex = value.pending.findIndex(item => item.operation === 'create' &&
        String(item.temp_id || item.record_id) === key);
      if (createIndex >= 0) {
        value.pending.splice(createIndex, 1);
        value.pending = value.pending.filter(item => String(item.record_id) !== key);
      } else {
        value.pending = value.pending.filter(item => !(item.operation === 'update' && String(item.record_id) === key));
        value.pending.push({
          id: identifier(), resource: scope.resource, operation: 'delete', record_id: key,
          base_sequence: row.version, base_data: structuredClone(row.data), created_at: Date.now(),
        });
      }
      delete value.rows[key];
      await save(scope, value);
      return view(value);
    });
  }

  function wireMutation(mutation) {
    return {
      id: mutation.id,
      resource: mutation.resource,
      operation: mutation.operation,
      ...(mutation.record_id ? { record_id: mutation.record_id } : {}),
      ...(mutation.data ? { data: mutation.data } : {}),
      ...(Number.isFinite(mutation.base_sequence) ? { base_sequence: mutation.base_sequence } : {}),
    };
  }

  async function withLock(name, task) {
    if (navigator?.locks?.request) return navigator.locks.request(name, task);
    const previous = localLocks.get(name) || Promise.resolve();
    const next = previous.then(task, task);
    localLocks.set(name, next.catch(() => undefined));
    return next;
  }

  function sameValue(left, right) {
    if (Object.is(left, right)) return true;
    try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
  }

  function fieldMergeDecision(base, server, patch) {
    const fields = Object.keys(patch || {});
    const conflicts = fields.filter(field =>
      !sameValue(base?.[field], server?.[field]) && !sameValue(patch[field], server?.[field]));
    const mergeable = fields.filter(field =>
      !conflicts.includes(field) && !sameValue(patch[field], server?.[field]));
    return {
      conflicts,
      mergeable,
      needsWrite: mergeable.length > 0,
    };
  }

  async function fetchSnapshot(scope, api) {
    const clientId = 'studio:' + scope.user + ':' + scope.project;
    const route = '/projects/' + encodeURIComponent(scope.project) + '/studio/sync/bootstrap?resource=' +
      encodeURIComponent(scope.resource) + '&client_id=' + encodeURIComponent(clientId);
    const response = await api(route);
    const snapshot = response.data;
    setOnline(true);
    return snapshot;
  }

  function snapshotRows(scope, snapshot) {
    const records = snapshot.resources?.[scope.resource]?.records || [];
    const rows = {};
    for (const record of records) rows[String(record.data.id)] = { data: record.data, version: record.version };
    return rows;
  }

  async function applySnapshot(scope, current, snapshot) {
    const rows = snapshotRows(scope, snapshot);
    for (const mutation of current.pending) applyMutation(rows, mutation);
    for (const conflict of current.conflicts) {
      if (conflict.error?.code !== 'schema_changed') applyMutation(rows, conflict.mutation);
    }
    current.rows = rows;
    current.cursor = snapshot.cursor || 0;
    current.schema_version = snapshot.schema_version || '';
    await save(scope, current);
    return current;
  }

  async function sync(scope, api) {
    return withLock('loomup-studio-state:' + resourceKey(scope), async () => {
      let value = await load(scope);
      if (!online && typeof navigator !== 'undefined' && !navigator.onLine) return view(value);
      const route = '/projects/' + encodeURIComponent(scope.project) + '/studio/sync/mutations';
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const versionConflicts = [];
        let rebased = 0;
        if (value.pending.length) {
          let response;
          const submitted = value.pending;
          try {
            response = await api(route, {
              method: 'POST',
              body: JSON.stringify({ protocol_version: 1, mutations: submitted.map(wireMutation) }),
            });
            setOnline(true);
          } catch (error) {
            if (!error?.status || error.status >= 500) setOnline(false);
            throw error;
          }
          const results = new Map((response.data?.results || []).map(result => [result.mutation_id, result]));
          const remaining = [];
          for (const mutation of submitted) {
            const result = results.get(mutation.id);
            if (!result || result.status === 'retry') { remaining.push(mutation); continue; }
            if (result.status === 'acknowledged') continue;
            if (result.error?.code === 'version_conflict') {
              versionConflicts.push({ mutation, error: result.error });
              continue;
            }
            value.conflicts.push({
              mutation,
              fields: Object.keys(mutation.data || {}).length ? Object.keys(mutation.data) : ['row'],
              error: result.error || { message: 'Mutation rejected' },
            });
          }
          value.pending = remaining;
        }
        let snapshot;
        try {
          snapshot = await fetchSnapshot(scope, api);
        } catch (error) {
          if (!error?.status || error.status >= 500) setOnline(false);
          throw error;
        }
        const canonical = snapshotRows(scope, snapshot);
        for (const conflict of versionConflicts) {
          const mutation = conflict.mutation;
          const server = canonical[String(mutation.record_id)];
          if (mutation.operation === 'update' && mutation.base_data && server) {
            const decision = fieldMergeDecision(mutation.base_data, server.data, mutation.data || {});
            if (!decision.conflicts.length) {
              if (decision.needsWrite) {
                mutation.base_sequence = server.version;
                mutation.base_data = structuredClone(server.data);
                value.pending.push(mutation);
                rebased += 1;
              }
              continue;
            }
            if (decision.mergeable.length) {
              const mergeData = Object.fromEntries(
                decision.mergeable.map(field => [field, mutation.data[field]]));
              value.pending.push({
                ...mutation,
                id: identifier(),
                data: mergeData,
                base_sequence: server.version,
                base_data: structuredClone(server.data),
              });
              rebased += 1;
            }
            const conflictMutation = {
              ...mutation,
              data: Object.fromEntries(
                decision.conflicts.map(field => [field, mutation.data[field]])),
            };
            value.conflicts.push({
              mutation: conflictMutation,
              fields: decision.conflicts,
              server: structuredClone(server.data),
              server_version: server.version,
              error: conflict.error,
            });
            continue;
          }
          value.conflicts.push({
            mutation,
            fields: mutation.operation === 'delete' ? ['row'] : Object.keys(mutation.data || {}),
            ...(server ? { server: structuredClone(server.data), server_version: server.version } : {}),
            error: conflict.error,
          });
        }
        value = await applySnapshot(scope, value, snapshot);
        if (!rebased) break;
      }
      return view(value);
    });
  }

  async function discardConflicts(scope, api) {
    await withLock('loomup-studio-state:' + resourceKey(scope), async () => {
      const value = await load(scope);
      value.conflicts = [];
      await save(scope, value);
    });
    return sync(scope, api);
  }

  async function retryConflicts(scope, api) {
    await withLock('loomup-studio-state:' + resourceKey(scope), async () => {
      const value = await load(scope);
      const unresolved = [];
      for (const conflict of value.conflicts) {
        if (conflict.error?.code === 'schema_changed') { unresolved.push(conflict); continue; }
        if (!Number.isFinite(conflict.server_version)) { unresolved.push(conflict); continue; }
        const mutation = conflict.mutation;
        mutation.id = identifier();
        mutation.base_sequence = conflict.server_version;
        mutation.base_data = structuredClone(conflict.server || {});
        value.pending.push(mutation);
      }
      value.conflicts = unresolved;
      await save(scope, value);
    });
    return sync(scope, api);
  }

  let platformApiBase = '/platform/api';

  function publishRealtime(scope) {
    localChannel?.postMessage({
      kind: 'data',
      project: scope.project,
      resource: scope.resource,
      at: Date.now(),
    });
  }

  function publishSchema(scope, revision) {
    localChannel?.postMessage({
      kind: 'schema',
      project: scope.project,
      revision,
      at: Date.now(),
    });
  }

  function subscribeRealtime(scope, onChange, onStatus = () => {}) {
    let socket;
    let reconnectTimer;
    let reconnectAttempt = 0;
    let stopped = false;

    const report = status => {
      try { onStatus(status); } catch {}
    };
    const scheduleReconnect = () => {
      if (stopped || reconnectTimer) return;
      const ceiling = Math.min(30_000, 1_000 * (2 ** reconnectAttempt));
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, Math.max(100, Math.floor(Math.random() * ceiling)));
    };
    const connect = () => {
      if (stopped) return;
      if (!online || (typeof navigator !== 'undefined' && !navigator.onLine)) {
        report('offline');
        return;
      }
      report('connecting');
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = scheme + '//' + location.host + platformApiBase + '/projects/' +
        encodeURIComponent(scope.project) + '/studio/realtime' +
        (scope.websocket !== false && scope.resource
          ? '?resource=' + encodeURIComponent(scope.resource)
          : '');
      const current = new WebSocket(url);
      socket = current;
      current.onopen = () => {
        if (socket !== current || stopped) return;
        reconnectAttempt = 0;
      };
      current.onmessage = event => {
        if (socket !== current || stopped) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'subscribed') {
          report(scope.websocket === false ? 'local' : 'connected');
          if (Number.isFinite(message.schema_revision) &&
              Number.isFinite(scope.schemaRevision) &&
              message.schema_revision !== scope.schemaRevision) {
            try { onChange({ type: 'schema', revision: message.schema_revision }); } catch {}
          }
          return;
        }
        if (message.type === 'schema') {
          try { onChange({ type: 'schema', revision: message.revision }); } catch {}
          return;
        }
        if (message.type === 'change') {
          try { onChange(message); } catch {}
        }
      };
      current.onerror = () => current.close();
      current.onclose = () => {
        if (socket !== current || stopped) return;
        socket = undefined;
        report(online && localChannel ? 'local' : online ? 'connecting' : 'offline');
        scheduleReconnect();
      };
    };
    const localChange = message => {
      if (stopped || message?.project !== scope.project) return;
      if (message.kind === 'schema') {
        try { onChange({ type: 'schema', revision: message.revision, local: true }); } catch {}
        return;
      }
      if (message?.resource !== scope.resource) return;
      try { onChange({ type: 'change', table: scope.resource, local: true }); } catch {}
    };
    const connectivity = isOnline => {
      if (stopped) return;
      if (!isOnline) {
        report('offline');
        socket?.close();
      } else if (!socket) {
        connect();
      }
    };
    listeners.add(connectivity);
    localChangeListeners.add(localChange);
    connect();
    return () => {
      stopped = true;
      listeners.delete(connectivity);
      localChangeListeners.delete(localChange);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
      socket = undefined;
    };
  }

  async function clearAll() {
    await transact('readwrite', store => store.clear());
  }

  if (typeof addEventListener === 'function') {
    addEventListener('offline', () => setOnline(false));
    addEventListener('online', () => setOnline(true));
  }

  const studioClient = {
    cacheableGet, cachedGet, cachedResource, queueCreate, queueUpdate, queueDelete,
    sync, discardConflicts, retryConflicts, applySchema, clearAll, fieldMergeDecision,
    subscribeRealtime, publishRealtime, publishSchema,
    isOnline: () => online,
    subscribe(listener) { listeners.add(listener); listener(online); return () => listeners.delete(listener); },
  };

export function createStudioClient(options = {}) {
  platformApiBase = String(options.apiBase || '/platform/api').replace(/\/$/, '');
  return studioClient;
}

export { fieldMergeDecision, reconcileSchemaState };
