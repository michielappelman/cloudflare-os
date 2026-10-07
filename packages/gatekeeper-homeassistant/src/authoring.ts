// Authoring Home Assistant configuration: automations, scripts and scenes ("config items"), and
// organisation (categories, labels, areas, floors, and which of them entities and devices belong
// to).
//
// This module is pure: the action and revert types, provisional ids for groups created by
// pending actions, approval descriptions, and the simulation overlays that make reads reflect
// pending actions. Applying and reverting against Home Assistant lives in `authoring-apply.ts`.

import {
  buildDescription,
  sanitizeTitle,
  type ActionDescriptionBuilder,
} from "@gadgets/gatekeeper-kit/action-description";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { RegistrySnapshot } from "./homeassistant-api";

// ---------------------------------------------------------------------------
// Types

export type ConfigItemDomain = "automation" | "script" | "scene";

/** Entity-registry platform of the entities Home Assistant creates for UI-managed items. The
 * registry `unique_id` of such an entity is the item's id (automation, scene) or key (script). */
export const CONFIG_ITEM_PLATFORM: Record<ConfigItemDomain, string> = {
  automation: "automation",
  script: "script",
  scene: "homeassistant",
};

export type GroupKind = "category" | "label" | "area" | "floor";

/** The fields of Home Assistant entity-registry records this module reads or simulates. */
export interface EntityRegistryEntry {
  entity_id: string;
  platform?: string;
  unique_id?: string;
  name?: string | null;
  original_name?: string | null;
  categories?: Record<string, string>;
  labels?: string[];
  area_id?: string | null;
}

export interface DeviceRegistryEntry {
  id: string;
  name?: string | null;
  name_by_user?: string | null;
  labels?: string[];
  area_id?: string | null;
}

/** A category, label, area or floor registry record. Each kind keys its records by
 * `<kind>_id`; areas also carry `floor_id` and `labels`. */
export interface GroupRegistryEntry {
  name?: string;
  floor_id?: string | null;
  labels?: string[];
  [field: string]: unknown;
}

/** A config item addressed by storage id, so organisation changes can target an item whose
 * creation is still pending (it has no entity yet). */
export interface ConfigItemRef {
  domain: ConfigItemDomain;
  itemId: string;
}

/** Organisation changes for entities or devices. Ids may be provisional. */
export interface AssignmentChanges {
  /** Entities only. Scope → category id; null removes the entity from that scope's category. */
  categories?: Record<string, string | null>;
  labels?: string[];
  addLabels?: string[];
  removeLabels?: string[];
  areaId?: string | null;
}

export type AuthoringAction =
  | {
      id: number;
      type: "saveConfigItem";
      domain: ConfigItemDomain;
      itemId: string;
      /** Full configuration, without `id` (Home Assistant derives it from `itemId`). */
      config: Record<string, unknown>;
      /** Whether the item did not exist when the action was submitted. Descriptive only: the
       * revert snapshot taken at apply time decides what a revert does. */
      isNew: boolean;
      /** Top-level fields that differ from the configuration at submit time (edits only). */
      changedFields?: string[];
    }
  | {
      id: number;
      type: "deleteConfigItem";
      domain: ConfigItemDomain;
      itemId: string;
      name: string;
    }
  | {
      id: number;
      type: "saveGroup";
      kind: GroupKind;
      /** Category scope; categories only. */
      scope?: string;
      /** Absent when creating. */
      groupId?: string;
      /** The group's name at submit time, for the approval title (updates only). */
      currentName?: string;
      /** Home Assistant registry fields (snake_case), e.g. `{ name, icon, floor_id }`. */
      fields: Record<string, unknown>;
    }
  | {
      id: number;
      type: "deleteGroup";
      kind: GroupKind;
      scope?: string;
      groupId: string;
      name: string;
    }
  | {
      id: number;
      type: "assignEntities";
      entityIds: string[];
      items: ConfigItemRef[];
      changes: AssignmentChanges;
      /** Names of the categories the change mentions, looked up at submit time (category ids are
       * opaque and the registry snapshot used for descriptions has no categories). */
      categoryNames?: Record<string, string>;
    }
  | {
      id: number;
      type: "assignDevices";
      deviceIds: string[];
      changes: AssignmentChanges;
    };

/** An authoring action as submitted: everything but the `id` the gatekeeper assigns. */
export type AuthoringActionBody = {
  [T in AuthoringAction["type"]]: Omit<Extract<AuthoringAction, { type: T }>, "id">;
}[AuthoringAction["type"]];

const AUTHORING_ACTION_TYPES: Record<AuthoringAction["type"], true> = {
  saveConfigItem: true,
  deleteConfigItem: true,
  saveGroup: true,
  deleteGroup: true,
  assignEntities: true,
  assignDevices: true,
};

export function isAuthoringAction<A extends { type: string }>(
  action: A,
): action is A & AuthoringAction {
  return Object.hasOwn(AUTHORING_ACTION_TYPES, action.type);
}

/** An entity's organisation, as captured for a revert. */
export interface EntityGrouping {
  entityId: string;
  categories: Record<string, string>;
  labels: string[];
  areaId: string | null;
}

export interface DeviceGrouping {
  deviceId: string;
  labels: string[];
  areaId: string | null;
}

export type AuthoringRevertInfo =
  | {
      type: "configItemSnapshot";
      domain: ConfigItemDomain;
      itemId: string;
      /** null: the action created the item, so the revert deletes it. */
      previousConfig: Record<string, unknown> | null;
      /** null: the action deleted the item. Compared with the live config before reverting, so a
       * revert never overwrites changes made after the action. */
      appliedConfig: Record<string, unknown> | null;
      /** For deletions: the item's organisation, restored after it is recreated (Home Assistant
       * drops the entity-registry entry on delete). */
      previousGrouping?: EntityGrouping;
    }
  | {
      type: "groupSnapshot";
      kind: GroupKind;
      scope?: string;
      /** What the action did; a revert does the inverse. */
      operation: "create" | "update" | "delete";
      /** Real id of the group the action created, changed or deleted. */
      groupId: string;
      /** update: the changed fields' previous values; delete: the fields to recreate it with. */
      previous?: Record<string, unknown>;
      /** delete: what belonged to the group, re-attached after it is recreated. */
      members?: { entityIds: string[]; deviceIds: string[]; areaIds: string[] };
    }
  | {
      type: "assignSnapshot";
      entities: EntityGrouping[];
      devices: DeviceGrouping[];
    };

// ---------------------------------------------------------------------------
// Provisional ids
//
// A group created by a pending action has no Home Assistant id yet (categories get a generated
// id, labels/areas/floors one derived from the name with a collision suffix). `create*` returns
// `~<actionId>` instead; later actions may use it, and apply time resolves it through the id
// recorded when the creating action was applied. Same convention as the Notion gatekeeper.

export function provisionalId(actionId: number): string {
  return `~${actionId}`;
}

export function isProvisional(id: string): boolean {
  return /^~\d+$/.test(id);
}

/** Every group id an action refers to (not counting the group an action creates). */
export function referencedGroupIds(action: AuthoringAction): string[] {
  switch (action.type) {
    case "saveGroup": {
      const ids: string[] = [];
      if (action.groupId) ids.push(action.groupId);
      if (typeof action.fields.floor_id === "string") ids.push(action.fields.floor_id);
      if (Array.isArray(action.fields.labels)) ids.push(...(action.fields.labels as string[]));
      return ids;
    }
    case "deleteGroup":
      return [action.groupId];
    case "assignEntities":
    case "assignDevices":
      return changeIds(action.changes);
    case "saveConfigItem":
    case "deleteConfigItem":
      return [];
  }
}

function changeIds(changes: AssignmentChanges): string[] {
  const ids: string[] = [];
  for (const id of Object.values(changes.categories ?? {})) if (id) ids.push(id);
  ids.push(...(changes.labels ?? []), ...(changes.addLabels ?? []), ...(changes.removeLabels ?? []));
  if (changes.areaId) ids.push(changes.areaId);
  return ids;
}

/** A copy of `action` with every provisional group id replaced through `resolve`. */
export function resolveProvisionalIds<A extends AuthoringAction>(
  action: A,
  resolve: (id: string) => string,
): A {
  const r = (id: string) => (isProvisional(id) ? resolve(id) : id);
  const rChanges = (c: AssignmentChanges): AssignmentChanges => ({
    ...c,
    categories: c.categories
      ? Object.fromEntries(Object.entries(c.categories).map(([k, v]) => [k, v == null ? v : r(v)]))
      : undefined,
    labels: c.labels?.map(r),
    addLabels: c.addLabels?.map(r),
    removeLabels: c.removeLabels?.map(r),
    areaId: c.areaId == null ? c.areaId : r(c.areaId),
  });
  switch (action.type) {
    case "saveGroup": {
      const fields = { ...action.fields };
      if (typeof fields.floor_id === "string") fields.floor_id = r(fields.floor_id);
      if (Array.isArray(fields.labels)) fields.labels = (fields.labels as string[]).map(r);
      return { ...action, groupId: action.groupId ? r(action.groupId) : undefined, fields };
    }
    case "deleteGroup":
      return { ...action, groupId: r(action.groupId) };
    case "assignEntities":
    case "assignDevices":
      return { ...action, changes: rChanges(action.changes) };
    default:
      return action;
  }
}

// ---------------------------------------------------------------------------
// Config helpers

/** The registry entry Home Assistant created for a UI-managed config item, if any. */
export function findConfigItemEntity(
  entities: readonly EntityRegistryEntry[],
  domain: ConfigItemDomain,
  itemId: string,
): EntityRegistryEntry | undefined {
  return entities.find(
    (e) =>
      e.platform === CONFIG_ITEM_PLATFORM[domain] &&
      e.unique_id === itemId &&
      e.entity_id.startsWith(`${domain}.`),
  );
}

export function configItemName(
  domain: ConfigItemDomain,
  config: Record<string, unknown> | null | undefined,
): string | undefined {
  const value = domain === "scene" ? config?.name : config?.alias;
  return typeof value === "string" && value ? value : undefined;
}

/** `config` without its `id` key. Home Assistant stores the id from the URL; a body `id` would
 * override it. */
export function withoutId(config: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = config;
  return rest;
}

/** JSON with object keys sorted, for order-insensitive comparison. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).toSorted().map((k) => [k, v[k]]))
      : v,
  );
}

/** Whether two stored configurations are the same, ignoring `id` and key order. */
export function sameConfig(
  a: Record<string, unknown> | null,
  b: Record<string, unknown> | null,
): boolean {
  if (a === null || b === null) return a === b;
  return stableStringify(withoutId(a)) === stableStringify(withoutId(b));
}

/** Top-level fields whose values differ between two configurations (ignoring `id`). */
export function changedTopLevelFields(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  keys.delete("id");
  return [...keys]
    .filter((k) => stableStringify(previous[k]) !== stableStringify(next[k]))
    .toSorted();
}

/** Home Assistant's slug: lowercase ASCII letters, digits and single underscores. */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function isSlug(text: string): boolean {
  return text !== "" && slugify(text) === text;
}

/** Everything a configuration refers to: services it calls and entities, devices, areas, labels
 * and floors it names. Template strings are not parsed. */
export interface ConfigReferences {
  services: string[];
  entities: string[];
  devices: string[];
  areas: string[];
  labels: string[];
  floors: string[];
}

const SERVICE_PATTERN = /^[a-z0-9_]+\.[a-z0-9_]+$/;

export function collectReferences(
  domain: ConfigItemDomain,
  config: Record<string, unknown>,
): ConfigReferences {
  const sets = {
    services: new Set<string>(),
    entities: new Set<string>(),
    devices: new Set<string>(),
    areas: new Set<string>(),
    labels: new Set<string>(),
    floors: new Set<string>(),
  };
  const idKeys: Record<string, Set<string>> = {
    entity_id: sets.entities,
    device_id: sets.devices,
    area_id: sets.areas,
    label_id: sets.labels,
    floor_id: sets.floors,
  };
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if ((key === "action" || key === "service") && typeof value === "string" && SERVICE_PATTERN.test(value)) {
        sets.services.add(value);
      } else if (Object.hasOwn(idKeys, key)) {
        for (const id of Array.isArray(value) ? value : [value]) {
          if (typeof id !== "string") continue;
          // Legacy configs allow a comma-separated entity_id string.
          for (const part of id.split(",")) if (part.trim()) idKeys[key].add(part.trim());
        }
      } else {
        walk(value);
      }
    }
  };
  if (domain === "scene" && config.entities && typeof config.entities === "object") {
    for (const entityId of Object.keys(config.entities)) sets.entities.add(entityId);
  }
  walk(config);
  return {
    services: [...sets.services].toSorted(),
    entities: [...sets.entities].toSorted(),
    devices: [...sets.devices].toSorted(),
    areas: [...sets.areas].toSorted(),
    labels: [...sets.labels].toSorted(),
    floors: [...sets.floors].toSorted(),
  };
}

/** An entity's or device's organisation after `changes`. */
export function applyAssignment<G extends { labels: string[]; areaId: string | null; categories?: Record<string, string> }>(
  current: G,
  changes: AssignmentChanges,
): G {
  const next = { ...current };
  if (changes.categories && next.categories) {
    const categories = { ...next.categories };
    for (const [scope, id] of Object.entries(changes.categories)) {
      if (id == null) delete categories[scope];
      else categories[scope] = id;
    }
    next.categories = categories;
  }
  if (changes.labels) next.labels = [...new Set(changes.labels)];
  if (changes.addLabels || changes.removeLabels) {
    const labels = new Set(next.labels);
    for (const id of changes.addLabels ?? []) labels.add(id);
    for (const id of changes.removeLabels ?? []) labels.delete(id);
    next.labels = [...labels];
  }
  if (changes.areaId !== undefined) next.areaId = changes.areaId;
  return next;
}

export function entityGrouping(entry: EntityRegistryEntry): EntityGrouping {
  return {
    entityId: entry.entity_id,
    categories: { ...entry.categories },
    labels: [...(entry.labels ?? [])],
    areaId: entry.area_id ?? null,
  };
}

export function deviceGrouping(entry: DeviceRegistryEntry): DeviceGrouping {
  return { deviceId: entry.id, labels: [...(entry.labels ?? [])], areaId: entry.area_id ?? null };
}

// ---------------------------------------------------------------------------
// Simulation overlays

type AnyAction = { id: number; type: string };

function authoringActions(pending: readonly AnyAction[]): AuthoringAction[] {
  return pending
    .filter((a): a is AnyAction & AuthoringAction => isAuthoringAction(a))
    .toSorted((a, b) => a.id - b.id);
}

/** Final pending state per item of a domain: its configuration, or null when a pending action
 * deletes it. Items no pending action touches are absent. */
export function pendingConfigItems(
  domain: ConfigItemDomain,
  pending: readonly AnyAction[],
): Map<string, { config: Record<string, unknown> | null; created: boolean }> {
  const result = new Map<string, { config: Record<string, unknown> | null; created: boolean }>();
  for (const action of authoringActions(pending)) {
    if (action.type === "saveConfigItem" && action.domain === domain) {
      const created = result.get(action.itemId)?.created ?? action.isNew;
      result.set(action.itemId, { config: action.config, created });
    } else if (action.type === "deleteConfigItem" && action.domain === domain) {
      result.set(action.itemId, { config: null, created: false });
    }
  }
  return result;
}

/** A config item's configuration as it will be once pending actions are applied. */
export function overlayConfigItemConfig(
  domain: ConfigItemDomain,
  itemId: string,
  real: Record<string, unknown> | null,
  pending: readonly AnyAction[],
): { config: Record<string, unknown> | null; appliedCount: number } {
  let config = real;
  let appliedCount = 0;
  for (const action of authoringActions(pending)) {
    if (action.type === "saveConfigItem" && action.domain === domain && action.itemId === itemId) {
      config = action.config;
      appliedCount += 1;
    } else if (action.type === "deleteConfigItem" && action.domain === domain && action.itemId === itemId) {
      config = null;
      appliedCount += 1;
    }
  }
  return { config, appliedCount };
}

const ID_KEY: Record<GroupKind, string> = {
  category: "category_id",
  label: "label_id",
  area: "area_id",
  floor: "floor_id",
};

/** A registry list (categories of one scope, labels, areas or floors) as it will be once pending
 * group actions are applied. Groups created by pending actions carry their provisional id. */
export function overlayGroups(
  kind: GroupKind,
  list: readonly GroupRegistryEntry[],
  pending: readonly AnyAction[],
  scope?: string,
): { list: GroupRegistryEntry[]; appliedCount: number } {
  const idKey = ID_KEY[kind];
  let result = [...list];
  let appliedCount = 0;
  for (const action of authoringActions(pending)) {
    if (action.type !== "saveGroup" && action.type !== "deleteGroup") continue;
    if (action.kind !== kind || (kind === "category" && action.scope !== scope)) continue;
    if (action.type === "deleteGroup") {
      const before = result.length;
      result = result.filter((g) => g[idKey] !== action.groupId);
      if (result.length !== before) appliedCount += 1;
    } else if (!action.groupId) {
      // Fields come from the gatekeeper's own typed converters, so they are registry fields.
      result.push({ ...action.fields, [idKey]: provisionalId(action.id) } as GroupRegistryEntry);
      appliedCount += 1;
    } else {
      const index = result.findIndex((g) => g[idKey] === action.groupId);
      if (index === -1) continue;
      result[index] = { ...result[index], ...action.fields };
      appliedCount += 1;
    }
  }
  return { list: result, appliedCount };
}

/** The registry snapshot as it will be once pending organisation actions are applied: created,
 * changed and deleted labels/areas/floors, deletions cascaded to their members, and entity and
 * device assignments. Categories are not part of the snapshot; see `overlayGroups`. Entity
 * category assignments are applied to the entities' `categories`. */
export function overlayRegistry(
  snapshot: RegistrySnapshot,
  pending: readonly AnyAction[],
): { snapshot: RegistrySnapshot; appliedCount: number } {
  const actions = authoringActions(pending).filter(
    (a) => a.type === "saveGroup" || a.type === "deleteGroup" || a.type === "assignEntities" || a.type === "assignDevices",
  );
  if (actions.length === 0) return { snapshot, appliedCount: 0 };

  const labels = overlayGroups("label", snapshot.labels, actions);
  const areas = overlayGroups("area", snapshot.areas, actions);
  const floors = overlayGroups("floor", snapshot.floors, actions);
  let appliedCount = labels.appliedCount + areas.appliedCount + floors.appliedCount;

  const entities = snapshot.entities.map((e: EntityRegistryEntry) => ({ ...e }));
  const devices = snapshot.devices.map((d: DeviceRegistryEntry) => ({ ...d }));
  const areaList = areas.list.map((a) => ({ ...a }));

  for (const action of actions) {
    if (action.type === "deleteGroup") {
      const id = action.groupId;
      switch (action.kind) {
        case "category":
          for (const e of entities) {
            if (e.categories?.[action.scope!] === id) {
              e.categories = { ...e.categories };
              delete e.categories[action.scope!];
            }
          }
          break;
        case "label":
          for (const item of [...entities, ...devices, ...areaList]) {
            if (item.labels?.includes(id)) item.labels = item.labels.filter((l: string) => l !== id);
          }
          break;
        case "area":
          for (const item of [...entities, ...devices]) if (item.area_id === id) item.area_id = null;
          break;
        case "floor":
          for (const a of areaList) if (a.floor_id === id) a.floor_id = null;
          break;
      }
    } else if (action.type === "assignEntities") {
      const targets = new Set(action.entityIds);
      for (const ref of action.items) {
        const entry = findConfigItemEntity(entities, ref.domain, ref.itemId);
        if (entry) targets.add(entry.entity_id);
      }
      for (const e of entities) {
        if (!targets.has(e.entity_id)) continue;
        const next = applyAssignment(entityGrouping(e), action.changes);
        e.categories = next.categories;
        e.labels = next.labels;
        e.area_id = next.areaId;
      }
      appliedCount += 1;
    } else if (action.type === "assignDevices") {
      const targets = new Set(action.deviceIds);
      for (const d of devices) {
        if (!targets.has(d.id)) continue;
        const next = applyAssignment(deviceGrouping(d), action.changes);
        d.labels = next.labels;
        d.area_id = next.areaId;
      }
      appliedCount += 1;
    }
  }

  return {
    snapshot: { ...snapshot, labels: labels.list, areas: areaList, floors: floors.list, entities, devices },
    appliedCount,
  };
}

// ---------------------------------------------------------------------------
// Approval descriptions

const DOMAIN_TITLE: Record<ConfigItemDomain, string> = {
  automation: "Automation",
  script: "Script",
  scene: "Scene",
};

const KIND_TITLE: Record<GroupKind, string> = {
  category: "Category",
  label: "Label",
  area: "Area",
  floor: "Floor",
};

/** Name of a group for display: registry name, the name a pending creation gives it, or the id. */
function groupName(
  kind: GroupKind,
  id: string,
  registry: RegistrySnapshot,
  pending: readonly AnyAction[],
  categoryNames?: Record<string, string>,
): string {
  if (isProvisional(id)) {
    const creation = authoringActions(pending).find(
      (a) => a.type === "saveGroup" && !a.groupId && provisionalId(a.id) === id,
    ) as (AuthoringAction & { type: "saveGroup" }) | undefined;
    const name = creation?.fields.name;
    return typeof name === "string" ? `${name} (created by pending action #${id.slice(1)})` : id;
  }
  if (kind === "category") return categoryNames?.[id] ?? id;
  const list: GroupRegistryEntry[] =
    kind === "label" ? registry.labels : kind === "area" ? registry.areas : registry.floors;
  return list.find((g) => g[ID_KEY[kind]] === id)?.name ?? id;
}

function entityName(entityId: string, registry: RegistrySnapshot): string {
  const reg = registry.entities.find((e: EntityRegistryEntry) => e.entity_id === entityId);
  return (
    reg?.name ??
    reg?.original_name ??
    registry.states.get(entityId)?.attributes?.friendly_name ??
    entityId
  );
}

function deviceName(deviceId: string, registry: RegistrySnapshot): string {
  const device = registry.devices.find((d: DeviceRegistryEntry) => d.id === deviceId);
  return device?.name_by_user ?? device?.name ?? deviceId;
}

/** "id (name)", or just the id when the name adds nothing. */
function named(ids: readonly string[], name: (id: string) => string): string[] {
  return ids.map((id) => {
    const n = name(id);
    return n === id ? id : `${id} (${n})`;
  });
}

export function describeAuthoringAction(
  action: AuthoringAction,
  registry: RegistrySnapshot,
  pending: readonly AnyAction[],
): ActionDescription {
  switch (action.type) {
    case "saveConfigItem":
      return describeSaveConfigItem(action, registry, pending);
    case "deleteConfigItem":
      return describeDeleteConfigItem(action, registry);
    case "saveGroup":
      return describeSaveGroup(action, registry, pending);
    case "deleteGroup":
      return describeDeleteGroup(action, registry);
    case "assignEntities":
      return describeAssignEntities(action, registry, pending);
    case "assignDevices":
      return describeAssignDevices(action, registry, pending);
  }
}

const CONFIG_ITEM_PROSE: Record<ConfigItemDomain, { create: string; edit: string }> = {
  automation: {
    create:
      "Creates a Home Assistant automation. Once saved, Home Assistant runs it on its own " +
      "whenever its triggers fire, without asking again.",
    edit:
      "Replaces the configuration of a Home Assistant automation. Home Assistant runs it on its " +
      "own whenever its triggers fire, without asking again.",
  },
  script: {
    create:
      "Creates a Home Assistant script. It runs whenever it is started from the UI, by an " +
      "automation or by a service call.",
    edit:
      "Replaces the configuration of a Home Assistant script. It runs whenever it is started " +
      "from the UI, by an automation or by a service call.",
  },
  scene: {
    create:
      "Creates a Home Assistant scene. Activating it sets every listed entity to the stored state.",
    edit:
      "Replaces the configuration of a Home Assistant scene. Activating it sets every listed " +
      "entity to the stored state.",
  },
};

function describeSaveConfigItem(
  action: AuthoringAction & { type: "saveConfigItem" },
  registry: RegistrySnapshot,
  pending: readonly AnyAction[],
): ActionDescription {
  const { domain, itemId, config, isNew } = action;
  const name = configItemName(domain, config) ?? itemId;
  const refs = collectReferences(domain, config);
  const builder = buildDescription(CONFIG_ITEM_PROSE[domain][isNew ? "create" : "edit"])
    .inline(`${DOMAIN_TITLE[domain]} ID`, itemId);
  const entity = findConfigItemEntity(registry.entities, domain, itemId);
  if (entity) builder.inline("Entity", entity.entity_id);
  if (action.changedFields?.length) builder.list("Changed fields", action.changedFields);
  if (refs.services.length) builder.list("Services called", refs.services);
  if (refs.entities.length) {
    builder.list("Entities referenced", named(refs.entities, (id) => entityName(id, registry)));
  }
  if (refs.devices.length) {
    builder.list("Devices referenced", named(refs.devices, (id) => deviceName(id, registry)));
  }
  for (const [kind, ids, label] of [
    ["area", refs.areas, "Areas referenced"],
    ["label", refs.labels, "Labels referenced"],
    ["floor", refs.floors, "Floors referenced"],
  ] as const) {
    if (ids.length) builder.list(label, named(ids, (id) => groupName(kind, id, registry, pending)));
  }
  builder.json("Configuration", config);
  return {
    title: sanitizeTitle(`${isNew ? "Create" : "Edit"} ${domain}: ${name}`),
    ...builder.finish(),
    implementsRevert: true,
  };
}

function describeDeleteConfigItem(
  action: AuthoringAction & { type: "deleteConfigItem" },
  registry: RegistrySnapshot,
): ActionDescription {
  const { domain, itemId, name } = action;
  const builder = buildDescription(
    `Deletes a Home Assistant ${domain}. Its configuration and organisation ` +
      `(category, labels, area) are kept so the deletion can be reverted.`,
  ).inline(`${DOMAIN_TITLE[domain]} ID`, itemId);
  const entity = findConfigItemEntity(registry.entities, domain, itemId);
  if (entity) builder.inline("Entity", entity.entity_id);
  return {
    title: sanitizeTitle(`Delete ${domain}: ${name}`),
    ...builder.finish(),
    implementsRevert: true,
  };
}

function describeSaveGroup(
  action: AuthoringAction & { type: "saveGroup" },
  registry: RegistrySnapshot,
  pending: readonly AnyAction[],
): ActionDescription {
  const { kind, scope, groupId, fields } = action;
  const builder = buildDescription(
    groupId ? `Changes a Home Assistant ${kind}.` : `Creates a Home Assistant ${kind}.`,
  );
  if (kind === "category" && scope) builder.inline("Scope", scope);
  if (groupId) builder.inline(`${KIND_TITLE[kind]} ID`, groupId);
  if (typeof fields.floor_id === "string") {
    builder.inline("Floor", named([fields.floor_id], (id) => groupName("floor", id, registry, pending))[0]);
  }
  if (Array.isArray(fields.labels) && fields.labels.length) {
    builder.list("Labels", named(fields.labels as string[], (id) => groupName("label", id, registry, pending)));
  }
  builder.json("Settings", fields);
  const name = action.currentName ?? (typeof fields.name === "string" ? fields.name : groupId ?? kind);
  return {
    title: sanitizeTitle(`${groupId ? "Edit" : "Create"} ${kind}: ${name}`),
    ...builder.finish(),
    implementsRevert: true,
  };
}

function describeDeleteGroup(
  action: AuthoringAction & { type: "deleteGroup" },
  registry: RegistrySnapshot,
): ActionDescription {
  const { kind, scope, groupId, name } = action;
  let prose: string;
  switch (kind) {
    case "category": {
      const count = registry.entities.filter((e: EntityRegistryEntry) => e.categories?.[scope!] === groupId).length;
      prose =
        `Deletes a Home Assistant category. Its ${count} item${count === 1 ? "" : "s"} ` +
        `become uncategorised.`;
      break;
    }
    case "label": {
      const entities = registry.entities.filter((e: EntityRegistryEntry) => e.labels?.includes(groupId)).length;
      const devices = registry.devices.filter((d: DeviceRegistryEntry) => d.labels?.includes(groupId)).length;
      const areas = registry.areas.filter((a: GroupRegistryEntry) => a.labels?.includes(groupId)).length;
      prose =
        `Deletes a Home Assistant label. It is removed from ${entities} ` +
        `entit${entities === 1 ? "y" : "ies"}, ${devices} device${devices === 1 ? "" : "s"} and ` +
        `${areas} area${areas === 1 ? "" : "s"}.`;
      break;
    }
    case "area": {
      const entities = registry.entities.filter((e: EntityRegistryEntry) => e.area_id === groupId).length;
      const devices = registry.devices.filter((d: DeviceRegistryEntry) => d.area_id === groupId).length;
      prose =
        `Deletes a Home Assistant area. ${devices} device${devices === 1 ? "" : "s"} and ` +
        `${entities} directly assigned entit${entities === 1 ? "y" : "ies"} become unassigned.`;
      break;
    }
    case "floor": {
      const areas = registry.areas.filter((a: GroupRegistryEntry) => a.floor_id === groupId).length;
      prose = `Deletes a Home Assistant floor. Its ${areas} area${areas === 1 ? "" : "s"} become unassigned.`;
      break;
    }
  }
  const builder = buildDescription(
    `${prose} A revert recreates it (possibly under a new id) and re-attaches its members.`,
  );
  if (kind === "category" && scope) builder.inline("Scope", scope);
  builder.inline("ID", groupId);
  return {
    title: sanitizeTitle(`Delete ${kind}: ${name}`),
    ...builder.finish(),
    implementsRevert: true,
  };
}

function describeChanges(
  builder: ActionDescriptionBuilder,
  changes: AssignmentChanges,
  registry: RegistrySnapshot,
  pending: readonly AnyAction[],
  categoryNames?: Record<string, string>,
): void {
  const label = (id: string) => groupName("label", id, registry, pending);
  if (changes.categories && Object.keys(changes.categories).length) {
    builder.list(
      "Categories",
      Object.entries(changes.categories).map(([scope, id]) =>
        id == null
          ? `${scope}: (none)`
          : `${scope}: ${named([id], (c) => groupName("category", c, registry, pending, categoryNames))[0]}`,
      ),
    );
  }
  if (changes.labels) {
    builder.list("Labels (replacing the current ones)", changes.labels.length ? named(changes.labels, label) : ["(none)"]);
  }
  if (changes.addLabels?.length) builder.list("Add labels", named(changes.addLabels, label));
  if (changes.removeLabels?.length) builder.list("Remove labels", named(changes.removeLabels, label));
  if (changes.areaId !== undefined) {
    builder.inline(
      "Area",
      changes.areaId === null
        ? "(none)"
        : named([changes.areaId], (id) => groupName("area", id, registry, pending))[0],
    );
  }
}

function describeAssignEntities(
  action: AuthoringAction & { type: "assignEntities" },
  registry: RegistrySnapshot,
  pending: readonly AnyAction[],
): ActionDescription {
  const entityIds = [...action.entityIds];
  const unresolved: string[] = [];
  for (const ref of action.items) {
    const entry = findConfigItemEntity(registry.entities, ref.domain, ref.itemId);
    if (entry) entityIds.push(entry.entity_id);
    else unresolved.push(`${ref.domain} ${ref.itemId}`);
  }
  const builder = buildDescription(
    "Changes how entities are organised in Home Assistant (category, labels, area). Nothing is " +
      "switched or controlled.",
  );
  if (entityIds.length) builder.list("Entities", named(entityIds, (id) => entityName(id, registry)));
  if (unresolved.length) {
    builder.prose("Some items are created by pending actions and get their entity once those are applied.");
    builder.list("Items created by pending actions", unresolved);
  }
  describeChanges(builder, action.changes, registry, pending, action.categoryNames);
  const count = entityIds.length + unresolved.length;
  const title =
    count === 1
      ? `Organise: ${entityIds.length ? entityName(entityIds[0], registry) : unresolved[0]}`
      : `Organise ${count} entities`;
  return { title: sanitizeTitle(title), ...builder.finish(), implementsRevert: true };
}

function describeAssignDevices(
  action: AuthoringAction & { type: "assignDevices" },
  registry: RegistrySnapshot,
  pending: readonly AnyAction[],
): ActionDescription {
  const builder = buildDescription(
    "Changes how devices are organised in Home Assistant (labels, area). Nothing is switched or " +
      "controlled. A device's entities follow its area unless they have their own.",
  ).list("Devices", named(action.deviceIds, (id) => deviceName(id, registry)));
  describeChanges(builder, action.changes, registry, pending);
  const title =
    action.deviceIds.length === 1
      ? `Organise device: ${deviceName(action.deviceIds[0], registry)}`
      : `Organise ${action.deviceIds.length} devices`;
  return { title: sanitizeTitle(title), ...builder.finish(), implementsRevert: true };
}
