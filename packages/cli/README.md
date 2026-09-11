# @loomup/cli

Schema apply is submitted as a durable asynchronous project operation. The CLI
polls until it succeeds or fails, so closing the original HTTP connection does
not strand an apply or leave the project indefinitely in maintenance. Each
poll request has a 30-second network timeout. There is no overall polling
deadline: online backup verification can take several minutes. Temporary network
errors and 408/429/5xx responses retry with backoff. The CLI prints the operation
URL immediately; interrupting the command stops waiting without cancelling the
server operation. Authentication errors still fail immediately.

Atomic hosted migrations report a **Recovery point**, which predates any writes
made during online preparation. Failed migrations use SQLite transaction rollback;
that earlier snapshot is never automatically restored over newer writes. Legacy
servers continue to report a **Rollback snapshot**.

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

Login prints the workspaces available to the account. You can inspect or create
them again at any time, then provision a project and link the current package:

```bash
npx loomup workspaces list
npx loomup workspaces create --name "Acme"     # only when another workspace is needed
npx loomup projects create --name my-app --link
```

When the account has one workspace, project creation selects it automatically.
With several workspaces, an interactive terminal prompts for one; scripts must
pass `--workspace <workspace-id>`. Without `--link`, the CLI prints the exact
`loomup link` command to run next. `npx loomup projects list` lists projects from
all accessible workspaces; `--workspace` filters the result.

Use the logged-in manager session to inspect a linked project without opening
Studio or creating another credential:

```bash
npx loomup data resources
npx loomup data summary
npx loomup data list issues --where status=open --limit 20
npx loomup data list issues --filter priority.gte=2 --sort=-created_at --all
npx loomup data count issues --where status=open
npx loomup data get issues issue_123
```

List output is an adaptive terminal table. Use `--json` for the client-compatible
`{ data, meta }` envelope, `--jsonl` for pipelines, and `--all` to follow every
page automatically. `data summary` shows record and field counts across all
live Resources; `data resources` provides discovery without reading records.

`--where <field>=<value>` is equality shorthand. Rich filters use
`--filter <field>.<operator>=<value>` with `eq`, `ne`, `lt`, `lte`, `gt`, `gte`,
`in`, `isNull`, `contains`, or `startsWith`; both options can be repeated.
`--select` accepts comma-separated fields. JSON metadata includes `meta.total`,
`meta.truncated`, and any `meta.next_cursor`.

By default, hosted data commands use the session saved by `loomup auth login`.
Pass `--use-project-key` with `LOOMUP_API_KEY` to reproduce the exact
`resource:<name>:read` or `project:backend` authorization used by application
code. A project key is also the fallback for self-hosted projects. Outside a
linked package, `--project <project-id>` is enough for tryloomup.com; add
`--url <platform-url>` only for another host. Resource discovery and the
cross-Resource summary require a logged-in manager session.

Logged-in project managers can configure native App Attest and Play Integrity
identities without editing the hosted manifest directly:

```bash
npx loomup app-integrity set-ios --project <project-id> --app-id ios_main \
  --team-id ABCDE12345 --bundle-id com.example.app --apple-app-id 1234567890

npx loomup app-integrity set-android --project <project-id> --app-id android_main \
  --package-name com.example.app --cloud-project-number 123456789012 \
  --certificate-sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

npx loomup app-integrity put-google-credential --project <project-id> \
  --file ./google-play-integrity.json
npx loomup app-integrity set-mode --project <project-id> --mode audit
npx loomup app-integrity status --project <project-id>
```

Inside a package linked to `https://tryloomup.com`, `--project` is optional for
project-key and app-integrity commands. `--project` and `LOOMUP_PROJECT_ID`
remain available as explicit overrides.

Start in `audit` before enabling `enforce`. Use `--allow-development` only for
a separate development identity. These commands require `loomup auth login` or
`LOOMUP_PLATFORM_TOKEN`; workspace and project API keys cannot change the
mobile security policy. Credential contents are sent write-only and never
printed or persisted by the CLI.

The same manager session can install and inspect social-login and push-provider
credentials. Each `put` command reads a complete JSON object from disk; status
and JSON output contain safe metadata only, never private keys or secrets.

```bash
# Google/GitHub: client_id + client_secret
npx loomup auth-provider put google --project <project-id> --file ./google-oauth.json

# Apple: client_id + team_id + key_id + private_key_p8
npx loomup auth-provider put apple --project <project-id> --file ./apple-oauth.json
npx loomup auth-provider status --project <project-id>

# FCM accepts the raw Firebase service-account JSON.
npx loomup push-provider put fcm --project <project-id> --file ./firebase-service-account.json

# APNs JSON contains key_id, team_id, topic, private_key_p8, and production.
npx loomup push-provider put apns --project <project-id> --file ./apns.json
npx loomup push-provider status --project <project-id>
```

Expo works without a credential; optionally store `{ "access_token": "…" }`
when Expo push security is enabled. Web Push uses
`{ "public_key": "…", "private_key": "…", "subject": "mailto:…" }`.
Use `auth-provider delete` or `push-provider delete` with a provider name to
remove a credential. The Apple and APNs `.p8` contents belong in the
`private_key_p8` JSON field; Web Studio also supports selecting the `.p8` file
directly.

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

Workspace API keys are intentionally workspace-scoped, so their project list
and create commands always require `--workspace` even when a package is linked.

`loomup init` creates documented `loomup.schema.yaml` and `loomup.access.ts`
starters and records their paths in `package.json#loomup`. It never overwrites
existing files. Linking a project also creates either starter when it is missing.

The YAML contains only data shape. The TypeScript access file selects a typed
application profile; Loomup infers relationship access for child rows and R2
objects, compiles the low-level rules internally, and enforces them server-side.
Developers do not maintain `exists(...)` expressions or per-table CRUD rules.

Tables used only by trusted application backends can be denied to every user
session with `serviceOnly`. Access them with a project key carrying the
`project:backend` capability:

```ts
export default {
  profile: "workspace-project",
  serviceOnly: ["retained_attachments"],
} satisfies LoomupAccessConfig;
```

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

## Notification presentation and preferences

Declare application-owned `$notifications.templates` in `loomup.schema.yaml`
(or `notifications.templates` in a Studio Resource manifest). Use a nullable
JSON `presentation_field` to save the rendered wording with each inbox row.
`$push` remains authoritative for recipients and delivery enablement. Run
`loomup generate` after adding the JSON column, review `loomup migrate --plan`,
and apply the schema after upgrading the backend.

```ts
// Trusted application server only: requires a project:backend service key.
await server.push.send({
  type: "mention",
  recipients: [recipientId],
  idempotency_key: `comment:${commentId}:${recipientId}`,
  channels: ["inbox", "push"],
  fields: { actor_id: actorId, actor_name: "Asha", issue_title: "Review design" },
});

// Signed-in application user; preserve the revision when saving.
const catalog = await client.push.catalog();
const preferences = await client.push.preferences.get();
await client.push.preferences.update({ ...preferences, preview: "hidden" });
```

`channels` defaults to both; choose only `inbox` or `push` when appropriate.
Inbox sends need all application-specific required fields. Optional literal
`content` overrides the declared type's template. Identical idempotent retries
return the original receipt; reusing a key with changed content returns 409.
Preference updates also return 409 on stale revisions. Neither recipient mutes
nor hidden previews change saved inbox content.

Use `readNotificationPresentation(row.presentation)` to read either stored JSON
or JSON text, and retain an application fallback for historical rows. The server
uses the same saved snapshot for push. Studio can edit and preview templates and
inspect per-device delivery diagnostics.

See the [notification guide](https://tryloomup.com/docs/push) for schema examples,
permissions, payload limits, fallback behavior, and the complete REST contract.

### Conditional events with multiple recipients

A notification event can use either the existing `recipient` source field or a
non-empty `recipients` list. An optional `when` map combines conditions with AND.
Each condition contains exactly `eq` with a non-null scalar JSON value,
`in` with a non-empty list of non-null scalar values, or `is_null` with a boolean.
Use `is_null: true` for null and `is_null: false` for non-null. This explicit
operator round-trips through Loomup’s persisted TOML configuration. Conditions use source fields or
validated foreign-key paths; unknown fields and operators are rejected.

```yaml
# Under $notifications.events; declare the type, template and mapped inbox fields too.
- type: issue_completed
  source: issues
  operations: [UPDATE]
  changed: status_id
  recipients: [created_by, assignee_id]
  when:
    status_id.type: {in: [completed, closed]}
    deleted_at: {is_null: true}
  fields:
    push_recipient_id: $recipient
    issue_id: id
    actor_name: $actor.name
```

The journal's committed after-image supplies recipient IDs and source values
(the before-image is used for DELETE). Foreign-key conditions resolve against
current related rows when the event is projected, just like mapped relation
fields. Editing a related status definition alone does not trigger this event.
The authenticated journal actor is used unless `actor` is explicitly configured;
never trust a client-authored `updated_by` field for self-delivery suppression.

Missing/null recipients, duplicate user IDs and the actor are omitted.
`$recipient` maps the current recipient ID, including for push delivery fields.
All recipients for a rule commit in one transaction; failures roll back the group
and the durable consumer retries. Multi-recipient keys encode the legacy base
key plus recipient ID as a JSON tuple with a `recipients:` prefix. Without
`dedupe`, the base key includes the notification type and journal event ID, so
reopening and completing again is a new notification. Existing `recipient`
configurations retain their keys and custom `dedupe` behavior unchanged.
Inbox read rules and push notify rules continue to determine access. Push
preferences affect delivery, not inbox creation. Provider delivery remains
at-least-once; this guarantees idempotent inbox projection, not exactly-once
provider delivery.

### Workspace handles

`$handles` maps table names to `{ field, scope, source }`, for example
`workspace_memberships: { field: handle, scope: workspace_id, source: user_id.email }`.
The handle field must be text without a default, scope must be required, source
must follow one foreign key to required text, and `[scope, field]` must have a
unique index. Loomup assigns missing handles on CRUD insertion. Generated insert
types therefore make the handle optional even when selected rows require it.
This metadata requires a backend release supporting scoped handles.
