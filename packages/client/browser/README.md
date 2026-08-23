# Studio browser adapter

`@loomup/client/studio` is the browser runtime used by Loomup Studio. It owns:

- the cookie-authenticated Studio WebSocket, connection status, and reconnect backoff;
- instant cross-tab changes through a package-managed `BroadcastChannel`;
- schema revision notifications across tabs and reconnecting clients;
- IndexedDB snapshots and the durable mutation outbox;
- optimistic create, update, and delete operations;
- sync-v1 cursor exchange and field-level conflict rebasing.

Studio loads the same module from `/platform/sdk/studio-client.js` and only supplies its API base and the active project/resource scope. Product UI code should not create its own Studio WebSocket or implement a second offline queue.

```js
import { createStudioClient } from '@loomup/client/studio';

const studio = createStudioClient({ apiBase: '/platform/api' });
const unsubscribe = studio.subscribeRealtime(
  { project: projectId, resource: resourceName },
  change => refresh(change.table),
  status => renderConnectionStatus(status),
);
```
