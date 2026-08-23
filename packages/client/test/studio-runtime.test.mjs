import assert from 'node:assert/strict';
import test from 'node:test';

const sockets = [];
const channels = [];

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { onLine: true },
});
Object.defineProperty(globalThis, 'location', {
  configurable: true,
  value: { protocol: 'https:', host: 'tryloomup.test' },
});
globalThis.addEventListener = () => {};
globalThis.window = {};
globalThis.BroadcastChannel = class FakeBroadcastChannel {
  constructor(name) {
    this.name = name;
    channels.push(this);
  }

  addEventListener(type, listener) {
    if (type === 'message') this.messageListener = listener;
  }

  postMessage(message) {
    this.posted = message;
  }

  emit(message) {
    this.messageListener?.({ data: message });
  }
};
globalThis.WebSocket = class FakeWebSocket {
  constructor(url) {
    this.url = url;
    sockets.push(this);
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }
};

const { createStudioClient, fieldMergeDecision, reconcileSchemaState } =
  await import('../browser/studio-runtime.js');

test('Studio adapter owns the authenticated realtime connection lifecycle', () => {
  const client = createStudioClient({ apiBase: '/platform/api/' });
  const changes = [];
  const statuses = [];
  const stop = client.subscribeRealtime(
    { project: 'project / one', resource: 'work items', schemaRevision: 3 },
    change => changes.push(change),
    status => statuses.push(status),
  );

  const socket = sockets.at(-1);
  assert.equal(
    socket.url,
    'wss://tryloomup.test/platform/api/projects/project%20%2F%20one/studio/realtime?resource=work%20items',
  );
  assert.deepEqual(statuses, ['connecting']);

  socket.onopen();
  socket.onmessage({ data: JSON.stringify({ type: 'subscribed', schema_revision: 4 }) });
  socket.onmessage({ data: JSON.stringify({ type: 'change', table: 'work items', cursor: 12 }) });

  assert.deepEqual(statuses, ['connecting', 'connected']);
  assert.deepEqual(changes, [
    { type: 'schema', revision: 4 },
    { type: 'change', table: 'work items', cursor: 12 },
  ]);
  socket.onmessage({ data: JSON.stringify({ type: 'schema', revision: 5 }) });
  assert.deepEqual(changes.at(-1), { type: 'schema', revision: 5 });

  client.publishRealtime({ project: 'project / one', resource: 'work items' });
  assert.equal(channels[0].posted.project, 'project / one');
  assert.equal(channels[0].posted.resource, 'work items');
  assert.equal(typeof channels[0].posted.at, 'number');

  channels[0].emit({ kind: 'data', project: 'project / one', resource: 'work items' });
  assert.deepEqual(changes.at(-1), {
    type: 'change',
    table: 'work items',
    local: true,
  });

  client.publishSchema({ project: 'project / one', resource: 'work items' }, 5);
  assert.equal(channels[0].posted.kind, 'schema');
  assert.equal(channels[0].posted.revision, 5);
  channels[0].emit({ kind: 'schema', project: 'project / one', revision: 5 });
  assert.deepEqual(changes.at(-1), {
    type: 'schema',
    revision: 5,
    local: true,
  });

  stop();
  assert.equal(socket.closed, true);
});

test('field merge only conflicts when the same field diverges', () => {
  assert.deepEqual(
    fieldMergeDecision(
      { title: 'before', status: 'open' },
      { title: 'before', status: 'closed' },
      { title: 'mine' },
    ),
    { conflicts: [], mergeable: ['title'], needsWrite: true },
  );
  assert.deepEqual(fieldMergeDecision(
    { title: 'before' },
    { title: 'theirs' },
    { title: 'mine' },
  ), {
    conflicts: ['title'],
    mergeable: [],
    needsWrite: false,
  });
});

test('schema revisions remove stale cached fields without discarding pending edits', () => {
  const value = {
    format: 1,
    rows: {
      '1': { data: { id: 1, title: 'kept', legacy: 'remove me', created_at: 1, updated_at: 1 }, version: 4 },
    },
    pending: [{
      id: 'mutation-1', resource: 'posts', operation: 'update', record_id: '1',
      data: { title: 'local title', legacy: 'local legacy' },
      base_data: { id: 1, title: 'kept', legacy: 'before' },
    }],
    conflicts: [],
    cursor: 4,
    schema_version: '1',
    saved_at: 1,
  };

  reconcileSchemaState(value, {
    timestamps: true,
    fields: { title: { type: 'text' } },
  }, 2);

  assert.deepEqual(value.rows['1'].data, {
    id: 1, title: 'kept', created_at: 1, updated_at: 1,
  });
  assert.deepEqual(value.pending[0].data, { title: 'local title' });
  assert.deepEqual(value.pending[0].base_data, { id: 1, title: 'kept' });
  assert.equal(value.conflicts.length, 1);
  assert.deepEqual(value.conflicts[0].fields, ['legacy']);
  assert.equal(value.conflicts[0].error.code, 'schema_changed');
  assert.equal(value.schema_version, '2');
});

test('schema-only subscriptions work without a realtime Resource', () => {
  const client = createStudioClient({ apiBase: '/platform/api' });
  const changes = [];
  const statuses = [];
  const stop = client.subscribeRealtime(
    { project: 'empty-project', websocket: false, schemaRevision: 0 },
    change => changes.push(change),
    status => statuses.push(status),
  );
  const socket = sockets.at(-1);
  assert.equal(socket.url, 'wss://tryloomup.test/platform/api/projects/empty-project/studio/realtime');
  socket.onmessage({ data: JSON.stringify({ type: 'subscribed', schema_revision: 1 }) });
  assert.deepEqual(statuses, ['connecting', 'local']);
  assert.deepEqual(changes, [{ type: 'schema', revision: 1 }]);
  stop();
});
