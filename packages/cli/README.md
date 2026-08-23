# @loomup/cli

Declare a Loomup project's tables, fields, types, defaults, and indexes in YAML.
Loomup derives and safely reconciles the database schema; application developers
do not write migration SQL.

```bash
npm install @loomup/client
npm install --save-dev @loomup/cli
npx loomup init
```

Platform authentication always uses `https://tryloomup.com`; the CLI does not
accept an authentication URL override. Login stores the platform session in a
local user-only credential file:

```bash
npx loomup auth login
npx loomup auth status
npx loomup auth logout
```

Workspace API keys provide non-human control-plane automation without granting
direct access to project data. Create one in **Workspace API keys**, then use it
from CI to provision projects and issue project keys within its delegation
ceiling:

```bash
export LOOMUP_WORKSPACE_API_KEY="lbsk_…"

npx loomup projects create --workspace <workspace-id> --name my-app
npx loomup project-keys create \
  --project <project-id> \
  --name schema-deployer \
  --scope schema:plan \
  --scope schema:apply
```

`loomup init` creates documented `loomup.schema.yaml` and `loomup.access.ts`
starters and records their paths in `package.json#loomup`. It never overwrites
existing files. Linking a project also creates either starter when it is missing.

The YAML contains only data shape. The TypeScript access file selects a typed
application profile; Loomup infers relationship access for child rows and R2
objects, compiles the low-level rules internally, and enforces them server-side.
Developers do not maintain `exists(...)` expressions or per-table CRUD rules.

```bash
# Create a project API key with Schema · Apply in Loomup Studio.
export LOOMUP_API_KEY="loomup_sk_…"

npx loomup link \
  --url https://loomup.example.com \
  --project <project-id>

npx loomup migrate --plan
npx loomup migrate
```

`init`, `link`, and every successful `migrate` also generate a project-specific
TypeScript client at `.loomup/client.ts`. Regenerate it without touching the
remote database with `npx loomup generate`; use `npx loomup generate --check`
in CI to reject stale checked-in output. `package.json#loomup.output` changes
the default output path.

Realtime is disabled unless the schema declares a table explicitly:

```yaml
$realtime:
  tables: [issues, issue_comments]
```

Migration plans show realtime enable/disable changes. Unknown table names fail
before deployment, and the generated `RealtimeTable` type lets TypeScript
subscription helpers prevent subscriptions to undeclared tables.

```ts
import { createDb } from "./.loomup/client";

const db = createDb({ serviceKey: env.LOOMUP_API_KEY });
const issues = await db.issues.list({ where: { project_id: projectId } });
const issue = await db.issues.create({ project_id: projectId, title: "First issue" });
await db.issues.update(issue.id, { title: "Updated" });
await db.issues.delete(issue.id);
```

The generated module contains row, insert, and update types plus the linked
project gateway URL. Credentials are passed explicitly at runtime and are never
written into source or `package.json`. Override the gateway with the `url`
option when needed.

Destructive changes require `--allow-data-loss`. `LOOMUP_API_KEY` is preferred
for local and CI use; give it `schema:plan` or `schema:apply` only. An interactive
`LOOMUP_PLATFORM_TOKEN` also works. The CLI never writes either credential into
the project.

If the same credential also powers the application backend, choose Studio's
**Full backend** preset. Its `project:backend` capability includes schema
deployment and every Resource or operation added to the project later.
