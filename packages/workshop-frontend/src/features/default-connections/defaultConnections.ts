// Connections the user wants in every new chat. The Home composer creates a gatekeeper for each in
// the new workspace and inserts it as a capsule, so it reaches the chat like one the user attached
// by hand (and can be removed from the draft before sending). Stored per browser, per user.

/** One default connection: a connected account and the resource URL it opens. */
export type DefaultConnection = {
  accountId: number;
  vendorId: string;
  resourceUrl: string;
  /** Display label for the settings list; the capsule shows the gatekeeper's own description. */
  label: string;
};

const storageKey = (userId: number | string) => `defaultConnections:${userId}`;

const isDefaultConnection = (value: unknown): value is DefaultConnection => {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return Number.isInteger(entry.accountId) && typeof entry.vendorId === "string" &&
    typeof entry.resourceUrl === "string" && typeof entry.label === "string";
};

export function loadDefaultConnections(userId: number | string): DefaultConnection[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(localStorage.getItem(storageKey(userId)) ?? "[]");
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter(isDefaultConnection) : [];
}

export function saveDefaultConnections(
  userId: number | string,
  connections: DefaultConnection[],
): void {
  if (connections.length === 0) {
    localStorage.removeItem(storageKey(userId));
  } else {
    localStorage.setItem(storageKey(userId), JSON.stringify(connections));
  }
}
