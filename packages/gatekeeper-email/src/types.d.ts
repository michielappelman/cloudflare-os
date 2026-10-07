export type EmailAddress = {
  /** Display name, e.g. "John Doe". Empty string if not provided. */
  name: string;
  /** Email address, e.g. "john@example.com". */
  address: string;
}

export type EmailAttachment = {
  /** Filename of the attachment, if provided. */
  filename: string | null;
  /** MIME type of the attachment, e.g. "application/pdf". */
  mimeType: string;
  /** Content disposition: "attachment", "inline", or null. */
  disposition: string | null;
  /** The attachment content as an ArrayBuffer. */
  content: ArrayBuffer;
}

/** An inbound email message, parsed into structured fields. */
export type IncomingEmail = {
  /** Sender address. */
  from: EmailAddress;
  /** Recipient addresses. */
  to: EmailAddress[];
  /** CC addresses. */
  cc: EmailAddress[];
  /** Subject line. */
  subject: string;
  /** Sending time in ISO 8601 format. */
  date: string;
  /** Plain text body, if available. */
  text: string | null;
  /** HTML body, if available. */
  html: string | null;
  /** File attachments. */
  attachments: EmailAttachment[];
  /** The `Message-ID` header (e.g. "<abc@example.com>"), or null if absent. Pass it as
   *  `inReplyTo` when replying, so the reply is threaded. */
  messageId: string | null;
  /** The `References` header of the message, or null if absent. */
  references: string | null;
}

/** An outbound file attachment. */
export type OutgoingEmailAttachment = {
  filename: string;
  /** MIME type, e.g. "application/pdf". */
  mimeType: string;
  content: ArrayBuffer;
}

/** An outbound email message. The sender is always the bound mailbox. */
export type OutgoingEmail = {
  /** Recipient addresses, e.g. "john@example.com". At least one of `to`, `cc`, or `bcc` must be
   *  non-empty. */
  to?: string[];
  cc?: string[];
  bcc?: string[];
  /** Subject line. */
  subject: string;
  /** Plain text body. At least one of `text` or `html` is required. */
  text?: string;
  /** HTML body. */
  html?: string;
  /** Optional Reply-To address. */
  replyTo?: string;
  /** Display name for the sender. Defaults to no display name. */
  fromName?: string;
  /** `Message-ID` of the message being replied to (see `IncomingEmail.messageId`). */
  inReplyTo?: string;
  /** `References` header for threading; usually the replied-to message's `references` plus its
   *  `messageId`. Defaults to `inReplyTo` when that is set. */
  references?: string;
  attachments?: OutgoingEmailAttachment[];
}

/** Session interface for an email binding: the address, sending from it, and receiving at it. */
export interface EmailSession {
  /** Returns the full email address (e.g. "name@example.com"). */
  getAddress(): Promise<string>;

  /**
   * Request a callback on each inbound email.
   *
   * @param callback - A persistent stub (must be created with ctx.restore()) implementing the
   *   `EmailHook` interface, which will be called back whenever an email arrives.
   */
  subscribe(callback: RpcStub<EmailHook>): Promise<void>;

  /**
   * Send an email from this mailbox's address. The send is submitted for the user's approval and
   * this returns once it is queued; the message goes out only after it is approved (per message,
   * or automatically if the user chose to always allow sending from this mailbox).
   *
   * Delivery to arbitrary recipients depends on the deployment's Cloudflare email sending setup.
   */
  send(email: OutgoingEmail): Promise<void>;
}

/**
 * Hook interface for receiving inbound emails. A Gadget implements this
 * as an RpcTarget to receive push notifications when email arrives.
 */
export interface EmailHook {
  /** Called when an email is received at the bound address. */
  receiveEmail(email: IncomingEmail): Promise<void>;
}
