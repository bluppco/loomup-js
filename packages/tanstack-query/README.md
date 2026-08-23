# `@loomup/tanstack-query`

TanStack Query helpers for [`@loomup/client`](https://www.npmjs.com/package/@loomup/client).

```bash
npm install @loomup/client @loomup/tanstack-query @tanstack/query-core
```

```ts
import { QueryClient } from "@tanstack/query-core";
import { createClient } from "@loomup/client";
import { createLoomupQuery } from "@loomup/tanstack-query";

const queryClient = new QueryClient();
const client = createClient({ url: "https://api.example.com" });
const loomup = createLoomupQuery({ client, queryClient });

await queryClient.fetchQuery(loomup.list("todos", { limit: 20 }));
```

The package also exports stable query keys and realtime cache synchronization
helpers for resource lists and detail records.
