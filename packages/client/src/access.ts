/**
 * Application-level authorization profiles.
 *
 * These values contain domain intent only. `loomup migrate` compiles them into
 * server-enforced relationship policies; applications never author the policy
 * expression language used internally by Loomup.
 */

export type TableName<TTables> = Extract<keyof TTables, string>;

export type AuthenticatedAccess = {
  profile: "authenticated";
};

export type PublishedContentDefinition<TTable extends string> = {
  table: TTable;
  /** Defaults to `status`. */
  statusField?: string;
  /** Defaults to `published`. */
  publishedValue?: string;
  /** Defaults to `audience`; omit with `null` when content has no audience field. */
  audienceField?: string | null;
  /** Join table relating a content row to a department. */
  departments?: TTable;
  /** Defaults to `<singular table>_id`; set explicitly when it differs. */
  departmentContentField?: string;
};

export type WorkspaceProjectAccess<TTables = Record<string, unknown>> = {
  profile: "workspace-project";
  /** Optional overrides when the app does not use Loomup's conventional names. */
  tables?: {
    users?: TableName<TTables>;
    workspaces?: TableName<TTables>;
    memberships?: TableName<TTables>;
    projects?: TableName<TTables>;
    projectMembers?: TableName<TTables>;
    departments?: TableName<TTables>;
    projectDepartments?: TableName<TTables>;
    invitations?: TableName<TTables>;
  };
  /** Expose workspace name/slug alongside public projects. Defaults to false. */
  publicWorkspaces?: boolean;
  /** Use owner/editor/viewer project-member roles. Requires project_members.role and workspace_id. */
  projectRoles?: boolean;
  /** Project roots whose published records can be read through public/audience rules. */
  publishedContent?: readonly PublishedContentDefinition<TableName<TTables>>[];
  /** Project roots that always require an authenticated workspace member. */
  memberContent?: readonly TableName<TTables>[];
  /** Comment roots: authors may mutate; projectRoles additionally requires an editor role. */
  comments?: readonly TableName<TTables>[];
  /** Server-projected inbox rows visible and acknowledgeable only by their recipient. */
  notifications?: readonly {
    table: TableName<TTables>;
    /** Defaults to `recipient_id`. */
    recipientField?: string;
    /** Allow recipients to delete rows they can read. Default: false. */
    allowDelete?: boolean;
  }[];
  /** User references restricted to current members of the row's workspace and project. */
  projectUserFields?: readonly {
    table: TableName<TTables>;
    field: string;
    /** Allow an unassigned/null reference. Default: false. */
    nullable?: boolean;
    /** Prevent membership removal until references are cleared. Default: false. */
    guardRemoval?: boolean;
  }[];
  /** Immutable parent links to live rows in the same workspace/project; requires deleted_at. */
  issueParents?: readonly { table: TableName<TTables>; field: string }[];
  /** Staging rows owned by their creator and creatable only by project editors. */
  ownedUploads?: readonly TableName<TTables>[];
  /** Tables inaccessible to user sessions and reserved for project backend keys. */
  serviceOnly?: readonly TableName<TTables>[];
  /** Final object metadata tables used to derive private bucket access. */
  objects?: readonly {
    table: TableName<TTables>;
    /** Defaults to `r2_key`. */
    pathField?: string;
  }[];
};

export type LoomupAccessConfig<TTables = Record<string, unknown>> =
  | AuthenticatedAccess
  | WorkspaceProjectAccess<TTables>;
