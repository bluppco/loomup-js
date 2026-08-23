# @loomup/react-native

React Native helpers for [Loomup](https://tryloomup.com), built on `@loomup/client` and `@loomup/react`.

```bash
npm install @loomup/client @loomup/react @loomup/react-native @react-native-async-storage/async-storage
```

```tsx
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createNativeClient,
  LoomupNativeProvider,
  useAuth,
  useLiveQuery,
} from "@loomup/react-native";

// Android emulator: 10.0.2.2 — iOS sim: 127.0.0.1 — device: LAN IP
const client = createNativeClient({ url: "http://10.0.2.2:3000" });

export function App() {
  return (
    <LoomupNativeProvider client={client} asyncStorage={AsyncStorage}>
      <Todos />
    </LoomupNativeProvider>
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
npm install
npm test
npm run build
```
