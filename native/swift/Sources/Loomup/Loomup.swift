/**
 Loomup — Swift client for Loomup Realtime.

 Mirrors the TypeScript `@loomup/client` SDK:

 ```swift
 import Loomup

 let client = createClient(url: URL(string: "http://127.0.0.1:3000")!)
 let tokens = try await client.auth.signUp(email: "a@b.com", password: "secret12")
 let list = try await client.from("todos").select(
     where: ["completed": false],
     limit: 20
 )
 let unsub = try await client.from("todos").subscribeReady { event in
     print(event.op, event.data as Any)
 }
 unsub()
 client.closeRealtime()
 ```
 */

// Public types are defined across the module; this file is the package entry documentation.
