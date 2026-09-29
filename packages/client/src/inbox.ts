/** Online inbox actions are atomic and intentionally separate from queued CRUD. */
export type InboxScope = Record<string, string | number>;
export type InboxTarget =
  | { kind: "matching" }
  | { kind: "ids"; ids: string[] }
  | { kind: "selection"; selectionId: string; excludedIds?: string[]; includedIds?: string[] };
export type InboxAction = "mark-read" | "delete" | "delete-read";
export interface InboxSelection { selectionId: string; count: number; cutoff: number; expiresAt: number }
export interface InboxActionRequest {
  action: InboxAction;
  expectedRecipientId?: string;
  scope?: InboxScope;
  target: InboxTarget;
  /** Reuse the same key and request after an ambiguous transport failure. */
  idempotencyKey: string;
  cutoff?: number;
}
export interface InboxActionResult { changed: number; skipped: number; cutoff: number; changedAt: number }
export interface InboxTransport { request<T>(method: string, path: string, body?: unknown): Promise<T> }

export class InboxClient {
  constructor(private readonly client: InboxTransport) {}
  async select(scope: InboxScope = {}, expectedRecipientId?: string): Promise<InboxSelection> {
    return (await this.client.request<{ data: InboxSelection }>("POST", "/inbox/selections", { scope, expectedRecipientId })).data;
  }
  async members(selectionId: string, ids: string[], scope: InboxScope = {}): Promise<string[]> {
    return (await this.client.request<{ data: { ids: string[] } }>("POST", `/inbox/selections/${encodeURIComponent(selectionId)}/members`, { scope, ids })).data.ids;
  }
  async act(input: InboxActionRequest): Promise<InboxActionResult> {
    return (await this.client.request<{ data: InboxActionResult }>("POST", "/inbox/actions", input)).data;
  }
}
