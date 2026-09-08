/** Minimal Microsoft Graph shapes used by this server. */

export interface GraphEmailAddress {
  name?: string;
  address?: string;
}

export interface GraphRecipient {
  emailAddress?: GraphEmailAddress;
}

export interface GraphHeader {
  name: string;
  value: string;
}

export interface GraphMessage {
  id: string;
  subject?: string | null;
  from?: GraphRecipient | null;
  sender?: GraphRecipient | null;
  toRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  bodyPreview?: string;
  body?: { contentType?: "text" | "html"; content?: string };
  internetMessageHeaders?: GraphHeader[];
  webLink?: string;
  parentFolderId?: string;
}

export interface GraphMailFolder {
  id: string;
  displayName: string;
  parentFolderId?: string;
  childFolderCount?: number;
  totalItemCount?: number;
  unreadItemCount?: number;
  wellKnownName?: string;
}

export interface GraphPage<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

export interface BatchRequest {
  id: string;
  method: "GET" | "POST" | "DELETE" | "PATCH";
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface BatchResponse {
  id: string;
  status: number;
  body?: unknown;
}

/** Parsed List-Unsubscribe information for one message. */
export interface UnsubscribeInfo {
  /** HTTPS unsubscribe URL, if present. */
  https?: string;
  /** mailto: address (without the scheme), if present. */
  mailto?: string;
  /** Subject from the mailto URL query, if present. */
  mailtoSubject?: string;
  /** Body from the mailto URL query, if present. */
  mailtoBody?: string;
  /** True when RFC 8058 one-click POST is supported (List-Unsubscribe-Post present + https URL). */
  oneClick: boolean;
}
