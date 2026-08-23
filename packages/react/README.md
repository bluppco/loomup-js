# @loomup/react

React provider and hooks for [Loomup](https://tryloomup.com), built on `@loomup/client`.

```bash
npm install @loomup/client @loomup/react
```

```tsx
import { createClient } from "@loomup/client";
import { LoomupProvider, useAuth, useLiveQuery } from "@loomup/react";

const client = createClient({ url: "http://127.0.0.1:3000" });

export function App() {
  return (
    <LoomupProvider client={client}>
      <Todos />
    </LoomupProvider>
  );
}

function Todos() {
  const { user, signIn } = useAuth();
  const { data } = useLiveQuery("todos", { strategy: "merge" });
  // ...
}
```

Full documentation: [tryloomup.com/docs](https://tryloomup.com/docs).

```bash
npm install && npm test && npm run build
```
