// Applying and reverting authoring actions (see `authoring.ts`) against Home Assistant.
//
// Config items go through the REST endpoints behind HA's editors; organisation goes through the
// registry WebSocket commands. Every apply returns the information its revert needs, captured
// immediately before the change.

import {
  HomeAssistantRest,
  withWebSocket,
  type HomeAssistantCredentials,
  type HomeAssistantWebSocket,
} from "./homeassistant-api";
import {
  applyAssignment,
  deviceGrouping,
  entityGrouping,
  findConfigItemEntity,
  resolveProvisionalIds,
  sameConfig,
  withoutId,
  type AssignmentChanges,
  type AuthoringAction,
  type AuthoringRevertInfo,
  type ConfigItemRef,
  type DeviceGrouping,
  type DeviceRegistryEntry,
  type EntityGrouping,
  type EntityRegistryEntry,
  type GroupKind,
  type GroupRegistryEntry,
} from "./authoring";

/** Provisional group ids (`~<actionId>`) and the real ids they stand for once applied. */
export interface ProvisionalIds {
  /** The real id; throws when the creating action has not been applied. */
  resolve(id: string): string;
  record(provisionalId: string, realId: string): void;
}

/** Home Assistant reloads a domain in a background task after a config write, so an item's
 * entity appears shortly after the write returns. */
const ENTITY_WAIT_ATTEMPTS = 20;
const ENTITY_WAIT_INTERVAL_MS = 250;

/** Fields each kind can be created with, used to recreate a deleted group. */
const CREATE_FIELDS: Record<GroupKind, readonly string[]> = {
  category: ["name", "icon"],
  label: ["name", "color", "icon", "description"],
  area: ["name", "floor_id", "icon", "aliases", "labels", "picture"],
  floor: ["name", "level", "icon", "aliases"],
};

export async function applyAuthoringAction(
  action: AuthoringAction,
  creds: HomeAssistantCredentials,
  ids: ProvisionalIds,
): Promise<AuthoringRevertInfo> {
  const resolved = resolveProvisionalIds(action, (id) => ids.resolve(id));
  switch (resolved.type) {
    case "saveConfigItem":
      return await saveConfigItem(resolved, creds);
    case "deleteConfigItem":
      return await deleteConfigItem(resolved, creds);
    case "saveGroup":
      return await withWebSocket(creds, async (ws) => {
        const snapshot = await saveGroup(ws, resolved);
        if (!resolved.groupId) ids.record(`~${action.id}`, snapshot.groupId);
        return snapshot;
      });
    case "deleteGroup":
      return await withWebSocket(creds, (ws) => deleteGroup(ws, resolved));
    case "assignEntities":
      return await withWebSocket(creds, (ws) =>
        assignEntities(ws, resolved.entityIds, resolved.items, resolved.changes),
      );
    case "assignDevices":
      return await withWebSocket(creds, (ws) => assignDevices(ws, resolved.deviceIds, resolved.changes));
  }
}

export async function revertAuthoringAction(
  info: AuthoringRevertInfo,
  creds: HomeAssistantCredentials,
): Promise<void | { message: string }> {
  switch (info.type) {
    case "configItemSnapshot":
      return await revertConfigItem(info, creds);
    case "groupSnapshot":
      return await withWebSocket(creds, (ws) => revertGroup(ws, info));
    case "assignSnapshot":
      await withWebSocket(creds, async (ws) => {
        await restoreEntityGroupings(ws, info.entities);
        for (const device of info.devices) await updateDevice(ws, device);
      });
      return;
  }
}

// ---------------------------------------------------------------------------
// Config items

async function saveConfigItem(
  action: AuthoringAction & { type: "saveConfigItem" },
  creds: HomeAssistantCredentials,
): Promise<AuthoringRevertInfo> {
  const { domain, itemId, config, isNew } = action;
  const rest = new HomeAssistantRest(creds);
  const previousConfig = await rest.getItemConfig(domain, itemId);
  // A creation's id was checked to be unused at submit time, and a later edit of a still-pending
  // creation is itself marked new, so an existing config under a new item's id is the earlier
  // creation having been applied: overwrite it.
  if (!isNew && !previousConfig) {
    throw new Error(
      `The ${domain} "${itemId}" is no longer stored by Home Assistant's ${domain} editor ` +
        `(deleted, or defined in YAML); not recreating it.`,
    );
  }
  await rest.saveItemConfig(domain, itemId, withoutId(config));
  return { type: "configItemSnapshot", domain, itemId, previousConfig, appliedConfig: config };
}

async function deleteConfigItem(
  action: AuthoringAction & { type: "deleteConfigItem" },
  creds: HomeAssistantCredentials,
): Promise<AuthoringRevertInfo> {
  const { domain, itemId } = action;
  const rest = new HomeAssistantRest(creds);
  const previousConfig = await rest.getItemConfig(domain, itemId);
  if (!previousConfig) {
    throw new Error(
      `The ${domain} "${itemId}" is not stored by Home Assistant's ${domain} editor ` +
        `(already deleted, or defined in YAML).`,
    );
  }
  const entry = await withWebSocket(creds, async (ws) =>
    findConfigItemEntity(await listEntities(ws), domain, itemId),
  );
  await rest.deleteItemConfig(domain, itemId);
  return {
    type: "configItemSnapshot",
    domain,
    itemId,
    previousConfig,
    appliedConfig: null,
    previousGrouping: entry ? entityGrouping(entry) : undefined,
  };
}

async function revertConfigItem(
  info: AuthoringRevertInfo & { type: "configItemSnapshot" },
  creds: HomeAssistantCredentials,
): Promise<void | { message: string }> {
  const { domain, itemId, previousConfig, appliedConfig, previousGrouping } = info;
  const rest = new HomeAssistantRest(creds);
  const current = await rest.getItemConfig(domain, itemId);
  if (!sameConfig(current, appliedConfig)) {
    throw new Error(
      `The ${domain} "${itemId}" was changed in Home Assistant after this action was applied. ` +
        `Not reverting, so those changes are not lost.`,
    );
  }
  if (previousConfig === null) {
    await rest.deleteItemConfig(domain, itemId);
    return;
  }
  await rest.saveItemConfig(domain, itemId, withoutId(previousConfig));
  if (!previousGrouping) return;

  return await withWebSocket(creds, async (ws) => {
    const entry = await waitForItemEntity(ws, { domain, itemId });
    if (!entry) {
      return {
        message:
          `Restored the ${domain}, but its entity did not appear in time to restore its ` +
          `category, labels and area.`,
      };
    }
    await restoreEntityGroupings(ws, [{ ...previousGrouping, entityId: entry.entity_id }]);
    if (entry.entity_id !== previousGrouping.entityId) {
      return { message: `Restored the ${domain} as ${entry.entity_id} (was ${previousGrouping.entityId}).` };
    }
  });
}

/** Poll the entity registry until Home Assistant has created the item's entity. */
async function waitForItemEntity(
  ws: HomeAssistantWebSocket,
  ref: ConfigItemRef,
): Promise<EntityRegistryEntry | undefined> {
  for (let attempt = 0; attempt < ENTITY_WAIT_ATTEMPTS; attempt++) {
    const entry = findConfigItemEntity(await listEntities(ws), ref.domain, ref.itemId);
    if (entry) return entry;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ENTITY_WAIT_INTERVAL_MS);
    await promise;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Groups

async function listGroups(
  ws: HomeAssistantWebSocket,
  kind: GroupKind,
  scope: string | undefined,
): Promise<GroupRegistryEntry[]> {
  return await ws.send<GroupRegistryEntry[]>({
    type: `config/${kind}_registry/list`,
    ...(kind === "category" ? { scope } : {}),
  });
}

async function findGroup(
  ws: HomeAssistantWebSocket,
  kind: GroupKind,
  scope: string | undefined,
  groupId: string,
): Promise<GroupRegistryEntry> {
  const group = (await listGroups(ws, kind, scope)).find((g) => g[`${kind}_id`] === groupId);
  if (!group) throw new Error(`No ${kind} with id "${groupId}" exists in Home Assistant.`);
  return group;
}

/** Create a group; returns its real id. */
async function createGroup(
  ws: HomeAssistantWebSocket,
  kind: GroupKind,
  scope: string | undefined,
  fields: Record<string, unknown>,
): Promise<string> {
  const created = await ws.send<GroupRegistryEntry>({
    type: `config/${kind}_registry/create`,
    ...(kind === "category" ? { scope } : {}),
    ...fields,
  });
  const id = created[`${kind}_id`];
  if (typeof id !== "string") throw new Error(`Home Assistant did not return the new ${kind}'s id.`);
  return id;
}

async function updateGroup(
  ws: HomeAssistantWebSocket,
  kind: GroupKind,
  scope: string | undefined,
  groupId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await ws.send({
    type: `config/${kind}_registry/update`,
    ...(kind === "category" ? { scope } : {}),
    [`${kind}_id`]: groupId,
    ...fields,
  });
}

async function saveGroup(
  ws: HomeAssistantWebSocket,
  action: AuthoringAction & { type: "saveGroup" },
): Promise<AuthoringRevertInfo & { type: "groupSnapshot" }> {
  const { kind, scope, groupId, fields } = action;
  if (!groupId) {
    const id = await createGroup(ws, kind, scope, fields);
    return { type: "groupSnapshot", kind, scope, operation: "create", groupId: id };
  }
  const current = await findGroup(ws, kind, scope, groupId);
  const previous = Object.fromEntries(Object.keys(fields).map((k) => [k, current[k] ?? null]));
  await updateGroup(ws, kind, scope, groupId, fields);
  return { type: "groupSnapshot", kind, scope, operation: "update", groupId, previous };
}

async function deleteGroup(
  ws: HomeAssistantWebSocket,
  action: AuthoringAction & { type: "deleteGroup" },
): Promise<AuthoringRevertInfo> {
  const { kind, scope, groupId } = action;
  const current = await findGroup(ws, kind, scope, groupId);
  const previous = Object.fromEntries(
    CREATE_FIELDS[kind].filter((k) => current[k] != null).map((k) => [k, current[k]]),
  );

  const members = { entityIds: [] as string[], deviceIds: [] as string[], areaIds: [] as string[] };
  if (kind === "category" || kind === "label" || kind === "area") {
    for (const e of await listEntities(ws)) {
      const member =
        kind === "category" ? e.categories?.[scope!] === groupId
        : kind === "label" ? e.labels?.includes(groupId)
        : e.area_id === groupId;
      if (member) members.entityIds.push(e.entity_id);
    }
  }
  if (kind === "label" || kind === "area") {
    for (const d of await listDevices(ws)) {
      if (kind === "label" ? d.labels?.includes(groupId) : d.area_id === groupId) members.deviceIds.push(d.id);
    }
  }
  if (kind === "label" || kind === "floor") {
    for (const a of await listGroups(ws, "area", undefined)) {
      if (kind === "label" ? a.labels?.includes(groupId) : a.floor_id === groupId) {
        members.areaIds.push(String(a.area_id));
      }
    }
  }

  await ws.send({
    type: `config/${kind}_registry/delete`,
    ...(kind === "category" ? { scope } : {}),
    [`${kind}_id`]: groupId,
  });
  return { type: "groupSnapshot", kind, scope, operation: "delete", groupId, previous, members };
}

async function revertGroup(
  ws: HomeAssistantWebSocket,
  info: AuthoringRevertInfo & { type: "groupSnapshot" },
): Promise<void | { message: string }> {
  const { kind, scope, groupId } = info;
  switch (info.operation) {
    case "create":
      await ws.send({
        type: `config/${kind}_registry/delete`,
        ...(kind === "category" ? { scope } : {}),
        [`${kind}_id`]: groupId,
      });
      return;
    case "update":
      await updateGroup(ws, kind, scope, groupId, info.previous ?? {});
      return;
    case "delete": {
      const newId = await createGroup(ws, kind, scope, info.previous ?? {});
      const members = info.members ?? { entityIds: [], deviceIds: [], areaIds: [] };
      const entityChanges: AssignmentChanges =
        kind === "category" ? { categories: { [scope!]: newId } }
        : kind === "label" ? { addLabels: [newId] }
        : { areaId: newId };
      if (members.entityIds.length) await assignEntities(ws, members.entityIds, [], entityChanges);
      if (members.deviceIds.length) {
        await assignDevices(ws, members.deviceIds, kind === "label" ? { addLabels: [newId] } : { areaId: newId });
      }
      if (members.areaIds.length) {
        const areas = await listGroups(ws, "area", undefined);
        for (const areaId of members.areaIds) {
          const area = areas.find((a) => a.area_id === areaId);
          if (!area) continue;
          await updateGroup(ws, "area", undefined, areaId,
            kind === "label"
              ? { labels: [...new Set([...(area.labels ?? []), newId])] }
              : { floor_id: newId });
        }
      }
      if (newId !== groupId) return { message: `Recreated the ${kind} with the new id "${newId}".` };
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Assignments

async function listEntities(ws: HomeAssistantWebSocket): Promise<EntityRegistryEntry[]> {
  return await ws.send<EntityRegistryEntry[]>({ type: "config/entity_registry/list" });
}

async function listDevices(ws: HomeAssistantWebSocket): Promise<DeviceRegistryEntry[]> {
  return await ws.send<DeviceRegistryEntry[]>({ type: "config/device_registry/list" });
}

async function assignEntities(
  ws: HomeAssistantWebSocket,
  entityIds: readonly string[],
  items: readonly ConfigItemRef[],
  changes: AssignmentChanges,
): Promise<AuthoringRevertInfo> {
  const entries = await listEntities(ws);
  const byId = new Map(entries.map((e) => [e.entity_id, e]));
  const targets: EntityRegistryEntry[] = [];
  const missing: string[] = [];
  for (const entityId of entityIds) {
    const entry = byId.get(entityId);
    if (entry) targets.push(entry);
    else missing.push(entityId);
  }
  for (const ref of items) {
    const entry = findConfigItemEntity(entries, ref.domain, ref.itemId) ?? (await waitForItemEntity(ws, ref));
    if (entry) targets.push(entry);
    else missing.push(`${ref.domain} "${ref.itemId}" (if its creation is still pending, approve that first)`);
  }
  if (missing.length) {
    throw new Error(`Not in Home Assistant's entity registry: ${missing.join(", ")}.`);
  }

  const previous = targets.map(entityGrouping);
  const applied: EntityGrouping[] = [];
  try {
    for (const before of previous) {
      const after = applyAssignment(before, changes);
      await ws.send({
        type: "config/entity_registry/update",
        entity_id: before.entityId,
        ...(changes.categories ? { categories: changes.categories } : {}),
        ...(changes.labels || changes.addLabels || changes.removeLabels ? { labels: after.labels } : {}),
        ...(changes.areaId !== undefined ? { area_id: changes.areaId } : {}),
      });
      applied.push(before);
    }
  } catch (e) {
    // Leave nothing half-applied: an action either takes effect as a whole or not at all.
    await restoreEntityGroupings(ws, applied).catch(() => {});
    throw e;
  }
  return { type: "assignSnapshot", entities: previous, devices: [] };
}

async function assignDevices(
  ws: HomeAssistantWebSocket,
  deviceIds: readonly string[],
  changes: AssignmentChanges,
): Promise<AuthoringRevertInfo> {
  const devices = await listDevices(ws);
  const previous: DeviceGrouping[] = [];
  for (const deviceId of deviceIds) {
    const device = devices.find((d) => d.id === deviceId);
    if (!device) throw new Error(`No device with id "${deviceId}" exists in Home Assistant.`);
    previous.push(deviceGrouping(device));
  }
  const applied: DeviceGrouping[] = [];
  try {
    for (const before of previous) {
      await updateDevice(ws, applyAssignment(before, changes));
      applied.push(before);
    }
  } catch (e) {
    for (const before of applied) await updateDevice(ws, before).catch(() => {});
    throw e;
  }
  return { type: "assignSnapshot", entities: [], devices: previous };
}

async function updateDevice(ws: HomeAssistantWebSocket, grouping: DeviceGrouping): Promise<void> {
  await ws.send({
    type: "config/device_registry/update",
    device_id: grouping.deviceId,
    labels: grouping.labels,
    area_id: grouping.areaId,
  });
}

/** Put entities back to the given organisation. Category scopes an entity gained since are
 * cleared. */
async function restoreEntityGroupings(
  ws: HomeAssistantWebSocket,
  groupings: readonly EntityGrouping[],
): Promise<void> {
  if (groupings.length === 0) return;
  const current = new Map((await listEntities(ws)).map((e) => [e.entity_id, e]));
  for (const grouping of groupings) {
    const categories: Record<string, string | null> = { ...grouping.categories };
    for (const scope of Object.keys(current.get(grouping.entityId)?.categories ?? {})) {
      categories[scope] ??= null;
    }
    await ws.send({
      type: "config/entity_registry/update",
      entity_id: grouping.entityId,
      categories,
      labels: grouping.labels,
      area_id: grouping.areaId,
    });
  }
}
