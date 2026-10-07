// Outbound mail: validation of a Gadget's `send()` request, the approval-backed "send" action, and
// delivery through the Worker's `send_email` binding once the user approves it.

import {
  ActionApplyError,
  defineActions,
  type ActionPresentation,
} from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import type { OutgoingEmail } from "./types";

/** Recipients across To, Cc and Bcc. */
export const MAX_RECIPIENTS = 50;
/**
 * Total attachment bytes. The pending send is stored as one Durable Object KV value until it is
 * approved, and a value is capped at 2 MiB.
 */
export const MAX_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_SUBJECT_LENGTH = 998;
const MAX_BODY_BYTES = 512 * 1024;

/** The action kind auto-approval rules key on: "always allow sending from this mailbox". */
export const SEND_EMAIL_ACTION: ActionKind = { tag: "send-email", label: "Send email" };

/** A validated send, as stored in the action journal until it is approved. */
export type SendEmailPayload = {
  from: { name: string; email: string };
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string | null;
  html: string | null;
  replyTo: string | null;
  inReplyTo: string | null;
  references: string | null;
  attachments: { filename: string; mimeType: string; content: ArrayBuffer; sha256: string }[];
};

/** What the action needs at apply time. */
export type SendEmailHost = { sender: SendEmail | undefined };

// Deliberately strict: a bare addr-spec, no display name, comments, or whitespace, so the approver
// sees exactly the address the mail goes to.
const ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
// A Message-ID as it appears in headers: `<local@domain>`, possibly several for References.
const MESSAGE_ID = /^<[^\s<>]+@[^\s<>]+>$/;
const encoder = new TextEncoder();

function addresses(field: string, value: string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of addresses.`);
  return value.map(address => {
    if (typeof address !== "string" || !ADDRESS.test(address.trim())) {
      throw new Error(`${field}: ${JSON.stringify(address)} is not a plain email address ` +
          `such as "name@example.com".`);
    }
    return address.trim();
  });
}

function messageIds(field: string, value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  let ids = value.trim().split(/\s+/);
  if (!ids.every(id => MESSAGE_ID.test(id))) {
    throw new Error(`${field} must be one or more Message-IDs such as "<abc@example.com>".`);
  }
  return ids.join(" ");
}

function singleLine(field: string, value: string, max: number): string {
  if (/[\r\n]/.test(value)) throw new Error(`${field} must not contain line breaks.`);
  if (value.length > max) throw new Error(`${field} is longer than ${max} characters.`);
  return value;
}

function body(field: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  if (encoder.encode(value).byteLength > MAX_BODY_BYTES) {
    throw new Error(`${field} is larger than ${MAX_BODY_BYTES} bytes.`);
  }
  return value;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  let digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Validates a Gadget's send request into the payload the approver reviews and apply sends.
 * @param email The Gadget's request.
 * @param from The bound mailbox's address, always the sender.
 */
export async function prepareSend(
    email: OutgoingEmail, from: string): Promise<SendEmailPayload> {
  let to = addresses("to", email.to);
  let cc = addresses("cc", email.cc);
  let bcc = addresses("bcc", email.bcc);
  let recipients = to.length + cc.length + bcc.length;
  if (recipients === 0) throw new Error("At least one of to, cc, or bcc must name a recipient.");
  if (recipients > MAX_RECIPIENTS) {
    throw new Error(`At most ${MAX_RECIPIENTS} recipients are allowed per message.`);
  }
  if (typeof email.subject !== "string") throw new Error("subject must be a string.");
  let subject = singleLine("subject", email.subject, MAX_SUBJECT_LENGTH);
  let text = body("text", email.text);
  let html = body("html", email.html);
  if (text === null && html === null) throw new Error("Provide a text or html body.");
  let replyTo = email.replyTo === undefined ? null : addresses("replyTo", [email.replyTo])[0]!;
  let fromName = singleLine("fromName", (email.fromName ?? "").trim(), 100);
  let inReplyTo = messageIds("inReplyTo", email.inReplyTo);
  if (inReplyTo?.includes(" ")) throw new Error("inReplyTo must be a single Message-ID.");
  let references = messageIds("references", email.references) ?? inReplyTo;

  let total = 0;
  let attachments: SendEmailPayload["attachments"] = [];
  for (let attachment of email.attachments ?? []) {
    if (!(attachment.content instanceof ArrayBuffer)) {
      throw new Error("Attachment content must be an ArrayBuffer.");
    }
    let filename = singleLine("Attachment filename", attachment.filename?.trim() ?? "", 255);
    if (!filename) throw new Error("Every attachment needs a filename.");
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(attachment.mimeType ?? "")) {
      throw new Error(`Attachment ${filename}: mimeType must look like "application/pdf".`);
    }
    total += attachment.content.byteLength;
    if (total > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachments may total at most ${MAX_ATTACHMENT_BYTES} bytes.`);
    }
    // Copied so later changes by the caller cannot alter what was approved.
    let content = attachment.content.slice(0);
    attachments.push({
      filename, mimeType: attachment.mimeType, content, sha256: await sha256Hex(content),
    });
  }

  return {
    from: { name: fromName, email: from },
    to, cc, bcc, subject, text, html, replyTo, inReplyTo, references, attachments,
  };
}

function describeSend(payload: SendEmailPayload): ActionPresentation {
  let recipients = [...payload.to, ...payload.cc, ...payload.bcc];
  let builder = buildDescription(
      `Send an email from ${payload.from.email} to ${recipients.length} ` +
      `recipient${recipients.length === 1 ? "" : "s"}.`);
  builder.inline("From", payload.from.name
      ? `${payload.from.name} <${payload.from.email}>` : payload.from.email);
  if (payload.to.length) builder.list("To", payload.to);
  if (payload.cc.length) builder.list("Cc", payload.cc);
  if (payload.bcc.length) builder.list("Bcc", payload.bcc);
  if (payload.replyTo) builder.inline("Reply-To", payload.replyTo);
  builder.inline("Subject", payload.subject);
  if (payload.inReplyTo) builder.inline("In-Reply-To", payload.inReplyTo);
  if (payload.references) builder.inline("References", payload.references);
  if (payload.text !== null) builder.verbatim("Text body", payload.text);
  if (payload.html !== null) builder.verbatim("HTML body", payload.html, "html");
  for (let attachment of payload.attachments) {
    builder.file("Attachment", {
      name: attachment.filename,
      mediaType: attachment.mimeType,
      size: attachment.content.byteLength,
      sha256: attachment.sha256,
      origin: "agent",
    });
  }
  let firstRecipient = recipients[0]!;
  let others = recipients.length > 1 ? ` (+${recipients.length - 1})` : "";
  return {
    title: sanitizeTitle(`Email ${firstRecipient}${others}: ${payload.subject || "(no subject)"}`),
    ...builder.finish(),
    implementsRevert: false,
  };
}

async function deliver(payload: SendEmailPayload, host: SendEmailHost): Promise<void> {
  if (!host.sender) {
    throw new ActionApplyError(
        "This deployment has no send_email binding (SEND_EMAIL), so it cannot send email.");
  }
  let headers: Record<string, string> = {};
  if (payload.inReplyTo) headers["In-Reply-To"] = payload.inReplyTo;
  if (payload.references) headers["References"] = payload.references;
  let message = {
    from: payload.from.name ? payload.from : payload.from.email,
    subject: payload.subject,
    ...(payload.to.length ? { to: payload.to } : {}),
    ...(payload.cc.length ? { cc: payload.cc } : {}),
    ...(payload.bcc.length ? { bcc: payload.bcc } : {}),
    ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
    ...(payload.text !== null ? { text: payload.text } : {}),
    ...(payload.html !== null ? { html: payload.html } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(payload.attachments.length ? {
      attachments: payload.attachments.map(a => ({
        disposition: "attachment" as const,
        filename: a.filename,
        type: a.mimeType,
        content: a.content,
      })),
    } : {}),
  } as EmailMessageBuilder;
  try {
    await host.sender.send(message);
  } catch (error) {
    // The binding rejects before handing the message off (unverified destination, sender not
    // allowed, malformed message), so a thrown send is known not to have been delivered.
    throw new ActionApplyError(
        `Sending failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const emailActions = defineActions<SendEmailHost, { send: SendEmailPayload }>({
  send: {
    kind: SEND_EMAIL_ACTION,
    autoApprovable: true,
    // Nothing reads sent mail back, so there is no simulated state for the agent to continue on.
    delivery: "await-decision",
    // Sending is irreversible: never replay it after a crash mid-send.
    claimBeforeApply: true,
    describe: describeSend,
    apply: deliver,
  },
}, {
  // No external credential: the binding and the mailbox's ownership don't change under a pending
  // action.
  fence: "none",
  vendorId: "email",
});
