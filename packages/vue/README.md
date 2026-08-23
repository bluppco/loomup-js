# @loomup/vue

Vue 3 plugin and composables for [Loomup](https://tryloomup.com), built on `@loomup/client`.

```bash
npm install @loomup/client @loomup/vue
```

```ts
import { createApp } from "vue";
import { createClient } from "@loomup/client";
import { LoomupPlugin, useAuth, useLiveQuery } from "@loomup/vue";
import App from "./App.vue";

const client = createClient({ url: "http://127.0.0.1:3000" });
const app = createApp(App);
app.use(LoomupPlugin, { client, persist: { enabled: true } });
app.mount("#app");
```

```vue
<script setup lang="ts">
import { useAuth, useLiveQuery } from "@loomup/vue";

const { user, signIn } = useAuth();
const { data } = useLiveQuery("todos", { strategy: "merge" });
</script>
```

Full documentation: [tryloomup.com/docs](https://tryloomup.com/docs).

```bash
npm install && npm test && npm run build
```
