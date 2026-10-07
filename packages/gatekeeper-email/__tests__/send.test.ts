import { describe, expect, it } from "vitest";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { ActionJournal, type TaggedAction } from "@gadgets/gatekeeper-kit/actions";
import {
  emailActions, prepareSend, SEND_EMAIL_ACTION, type SendEmailPayload,
} from "../src/send";
import type { OutgoingEmail } from "../src/types";

const FROM = "agent@mail.example.com";

function mapKv() {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: (key: string, value: unknown) => void values.set(key, structuredClone(value)),
    delete: (key: string) => void values.delete(key),
    list: <T>({ prefix, startAfter, limit }:
        { prefix: string; startAfter?: string; limit?: number }) => {
      const found = [...values.entries()]
        .filter(([key]) => key.startsWith(prefix) && (startAfter === undefined || key > startAfter))
        .toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, value]) => [key, structuredClone(value)] as [string, T]);
      return limit === undefined ? found : found.slice(0, limit);
    },
  };
}

function setup(send: (message: EmailMessageBuilder) => Promise<EmailSendResult>) {
  const sent: EmailMessageBuilder[] = [];
  const submitted = new Map<number, ActionDescription>();
  const actions = emailActions.bind(
      new ActionJournal<TaggedAction<{ send: SendEmailPayload }>>(mapKv(), { namespace: "email" }),
      { sender: { send: async (message: EmailMessageBuilder) => {
        const result = await send(message);
        sent.push(message);
        return result;
      } } as SendEmail });
  const queue = {
    submitAction: async (id: number, description: ActionDescription) =>
      void submitted.set(id, description),
  };
  return {
    sent, submitted, actions,
    submit: async (email: OutgoingEmail) =>
      actions.submit(queue as never, "send", await prepareSend(email, FROM)),
  };
}

const ok = async () => ({ messageId: "<sent@mail.example.com>" });

describe("sending email", () => {
  it("sends nothing until approved, then sends from the bound mailbox", async () => {
    const { sent, submitted, actions, submit } = setup(ok);
    const pdf = new Uint8Array([1, 2, 3]).buffer;
    const id = await submit({
      to: ["alice@example.com"],
      cc: ["bob@example.com"],
      subject: "Hello",
      text: "Body text",
      fromName: "Agent",
      inReplyTo: "<orig@example.com>",
      attachments: [{ filename: "a.pdf", mimeType: "application/pdf", content: pdf }],
    });

    expect(sent).toEqual([]);
    const description = submitted.get(id)!;
    expect(description.actionKind).toEqual(SEND_EMAIL_ACTION);
    expect(description.autoApprovable).toBe(true);
    expect(description.awaitDecision).toBe(true);
    expect(description.implementsRevert).toBe(false);
    expect(description.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "From", value: `Agent <${FROM}>` }),
      expect.objectContaining({ label: "To", items: ["alice@example.com"] }),
      expect.objectContaining({ label: "Cc", items: ["bob@example.com"] }),
      expect.objectContaining({ label: "Subject", value: "Hello" }),
      expect.objectContaining({ label: "Text body", value: "Body text" }),
      expect.objectContaining({ label: "Attachment", name: "a.pdf", size: 3, origin: "agent" }),
    ]));

    await actions.apply(id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: { name: "Agent", email: FROM },
      to: ["alice@example.com"],
      cc: ["bob@example.com"],
      subject: "Hello",
      text: "Body text",
      headers: { "In-Reply-To": "<orig@example.com>", "References": "<orig@example.com>" },
    });
    expect(new Uint8Array(sent[0]!.attachments![0]!.content as ArrayBuffer)).toEqual(
        new Uint8Array([1, 2, 3]));

    // Re-applying an applied action must not send it twice.
    await actions.apply(id);
    expect(sent).toHaveLength(1);
  });

  it("never sends a rejected message", async () => {
    const { sent, actions, submit } = setup(ok);
    const id = await submit({ to: ["alice@example.com"], subject: "Hi", text: "x" });
    await actions.reject(id);
    await expect(actions.apply(id)).rejects.toThrow(/Unknown pending action/);
    expect(sent).toEqual([]);
  });

  it("does not retry a send the binding rejected", async () => {
    let attempts = 0;
    const { actions, submit } = setup(async () => {
      attempts++;
      throw new Error("destination address not verified");
    });
    const id = await submit({ to: ["alice@example.com"], subject: "Hi", text: "x" });
    await actions.apply(id).catch(() => {});
    await actions.apply(id).catch(() => {});
    expect(attempts).toBe(1);
  });

  it("offers sending as an always-allow kind", () => {
    const { actions } = setup(ok);
    expect(actions.autoApprovableKinds()).toEqual([SEND_EMAIL_ACTION]);
  });
});

describe("prepareSend", () => {
  const base: OutgoingEmail = { to: ["alice@example.com"], subject: "Hi", text: "x" };

  it.each<[string, OutgoingEmail, RegExp]>([
    ["no recipients", { ...base, to: [] }, /at least one of to, cc, or bcc/i],
    ["display-name address", { ...base, to: ["Alice <alice@example.com>"] }, /not a plain email/],
    ["header injection in subject", { ...base, subject: "Hi\r\nBcc: x@evil.com" }, /line breaks/],
    ["header injection in name", { ...base, fromName: "A\nBcc: x@evil.com" }, /line breaks/],
    ["no body", { to: ["alice@example.com"], subject: "Hi" }, /text or html/],
    ["bad Message-ID", { ...base, inReplyTo: "orig@example.com" }, /Message-ID/],
    ["too many recipients",
      { ...base, to: Array.from({ length: 51 }, (_, i) => `u${i}@example.com`) }, /At most 50/],
    ["oversized attachments", {
      ...base,
      attachments: [{ filename: "big", mimeType: "application/octet-stream",
        content: new ArrayBuffer(1024 * 1024 + 1) }],
    }, /at most 1048576 bytes/],
  ])("rejects %s", async (_name, email, error) => {
    await expect(prepareSend(email, FROM)).rejects.toThrow(error);
  });

  it("always sends from the bound mailbox", async () => {
    const payload = await prepareSend(
        { ...base, from: "boss@example.com" } as OutgoingEmail, FROM);
    expect(payload.from).toEqual({ name: "", email: FROM });
  });
});
