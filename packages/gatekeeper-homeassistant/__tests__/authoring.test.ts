import { describe, expect, it } from "vitest";
import {
  applyAssignment,
  collectReferences,
  describeAuthoringAction,
  overlayConfigItemConfig,
  overlayGroups,
  overlayRegistry,
  pendingConfigItems,
  referencedGroupIds,
  resolveProvisionalIds,
  sameConfig,
  type AuthoringAction,
} from "../src/authoring";
import type { RegistrySnapshot } from "../src/homeassistant-api";

function registry(overrides: Partial<RegistrySnapshot> = {}): RegistrySnapshot {
  return {
    areas: [{ area_id: "kitchen", name: "Kitchen", labels: ["night"], floor_id: "ground" }],
    floors: [{ floor_id: "ground", name: "Ground floor" }],
    labels: [{ label_id: "night", name: "Nightlights" }],
    devices: [{ id: "dev1", name: "Hue bridge", labels: ["night"], area_id: "kitchen" }],
    entities: [
      { entity_id: "light.porch", name: "Porch", labels: ["night"], area_id: null, categories: {} },
      {
        entity_id: "automation.porch_at_sunset",
        platform: "automation",
        unique_id: "1700000000000",
        labels: [],
        categories: { automation: "cat-lighting" },
      },
    ],
    states: new Map(),
    ...overrides,
  };
}

const porchAutomation = {
  alias: "Porch at sunset",
  triggers: [{ trigger: "sun", event: "sunset" }],
  actions: [
    { action: "light.turn_on", target: { entity_id: ["light.porch", "light.hall"] } },
    { service: "notify.mobile_app_phone", data: { message: "{{ states('sensor.x') }}" } },
    { choose: [{ sequence: [{ action: "scene.turn_on", target: { area_id: "kitchen" } }] }] },
  ],
};

describe("overlayConfigItemConfig / pendingConfigItems", () => {
  const actions: AuthoringAction[] = [
    { id: 1, type: "saveConfigItem", domain: "automation", itemId: "a1", config: { alias: "v1" }, isNew: true },
    { id: 2, type: "saveConfigItem", domain: "automation", itemId: "a1", config: { alias: "v2" }, isNew: true },
    { id: 3, type: "saveConfigItem", domain: "script", itemId: "a1", config: { alias: "script" }, isNew: true },
  ];

  it("shows the latest pending save of the item and keeps it marked as created", () => {
    expect(overlayConfigItemConfig("automation", "a1", null, actions)).toEqual({
      config: { alias: "v2" },
      appliedCount: 2,
    });
    expect(pendingConfigItems("automation", actions).get("a1")).toEqual({
      config: { alias: "v2" },
      created: true,
    });
  });

  it("applies pending actions in submit order, so a later delete wins", () => {
    const withDelete: AuthoringAction[] = [
      { id: 4, type: "deleteConfigItem", domain: "automation", itemId: "a1", name: "v2" },
      ...actions,
    ];
    expect(overlayConfigItemConfig("automation", "a1", { alias: "real" }, withDelete).config).toBeNull();
    expect(pendingConfigItems("automation", withDelete).get("a1")?.config).toBeNull();
  });

  it("leaves items of other domains and untouched items alone", () => {
    expect(overlayConfigItemConfig("automation", "other", { alias: "real" }, actions)).toEqual({
      config: { alias: "real" },
      appliedCount: 0,
    });
  });
});

describe("overlayGroups", () => {
  it("adds pending creations under their provisional id, scoped per category scope", () => {
    const actions: AuthoringAction[] = [
      { id: 7, type: "saveGroup", kind: "category", scope: "automation", fields: { name: "Lighting" } },
      { id: 8, type: "saveGroup", kind: "category", scope: "script", fields: { name: "Other scope" } },
    ];
    const { list } = overlayGroups("category", [{ category_id: "c1", name: "Existing" }], actions, "automation");
    expect(list).toEqual([
      { category_id: "c1", name: "Existing" },
      { category_id: "~7", name: "Lighting" },
    ]);
  });

  it("updates and deletes existing groups", () => {
    const actions: AuthoringAction[] = [
      { id: 1, type: "saveGroup", kind: "label", groupId: "night", fields: { color: "indigo" } },
      { id: 2, type: "deleteGroup", kind: "label", groupId: "old", name: "Old" },
    ];
    const { list, appliedCount } = overlayGroups(
      "label",
      [{ label_id: "night", name: "Nightlights" }, { label_id: "old", name: "Old" }],
      actions,
    );
    expect(list).toEqual([{ label_id: "night", name: "Nightlights", color: "indigo" }]);
    expect(appliedCount).toBe(2);
  });
});

describe("overlayRegistry", () => {
  it("assigns a label created by a pending action to an entity and a pending item's entity", () => {
    const actions: AuthoringAction[] = [
      { id: 5, type: "saveGroup", kind: "label", fields: { name: "Outdoor" } },
      {
        id: 6,
        type: "assignEntities",
        entityIds: ["light.porch"],
        items: [{ domain: "automation", itemId: "1700000000000" }],
        changes: { addLabels: ["~5"], categories: { automation: null } },
      },
    ];
    const { snapshot } = overlayRegistry(registry(), actions);
    const porch = snapshot.entities.find((e: { entity_id: string }) => e.entity_id === "light.porch");
    const automation = snapshot.entities.find(
      (e: { entity_id: string }) => e.entity_id === "automation.porch_at_sunset",
    );
    expect(porch.labels).toEqual(["night", "~5"]);
    expect(automation.labels).toEqual(["~5"]);
    expect(automation.categories).toEqual({});
    expect(snapshot.labels.map((l: { label_id: string }) => l.label_id)).toEqual(["night", "~5"]);
  });

  it("cascades a pending label deletion to entities, devices and areas", () => {
    const { snapshot } = overlayRegistry(registry(), [
      { id: 1, type: "deleteGroup", kind: "label", groupId: "night", name: "Nightlights" },
    ]);
    expect(snapshot.labels).toEqual([]);
    expect(snapshot.entities[0].labels).toEqual([]);
    expect(snapshot.devices[0].labels).toEqual([]);
    expect(snapshot.areas[0].labels).toEqual([]);
  });

  it("cascades area and floor deletions", () => {
    const { snapshot } = overlayRegistry(registry(), [
      { id: 1, type: "deleteGroup", kind: "area", groupId: "kitchen", name: "Kitchen" },
      { id: 2, type: "deleteGroup", kind: "floor", groupId: "ground", name: "Ground floor" },
    ]);
    expect(snapshot.devices[0].area_id).toBeNull();
    expect(snapshot.areas).toEqual([]);
    expect(snapshot.floors).toEqual([]);
  });

  it("does not mutate the real snapshot", () => {
    const real = registry();
    overlayRegistry(real, [
      { id: 1, type: "assignDevices", deviceIds: ["dev1"], changes: { areaId: null, labels: [] } },
    ]);
    expect(real.devices[0]).toEqual({ id: "dev1", name: "Hue bridge", labels: ["night"], area_id: "kitchen" });
  });
});

describe("applyAssignment", () => {
  const before = { labels: ["a", "b"], areaId: "kitchen", categories: { automation: "c1", helpers: "h1" } };

  it("adds and removes labels without duplicates and leaves omitted fields alone", () => {
    expect(applyAssignment(before, { addLabels: ["b", "c"], removeLabels: ["a"] })).toEqual({
      labels: ["b", "c"],
      areaId: "kitchen",
      categories: { automation: "c1", helpers: "h1" },
    });
  });

  it("changes only the category scopes given; null removes a scope", () => {
    expect(applyAssignment(before, { categories: { automation: "c2", helpers: null } }).categories).toEqual({
      automation: "c2",
    });
  });

  it("distinguishes clearing the area (null) from leaving it (undefined)", () => {
    expect(applyAssignment(before, { areaId: null }).areaId).toBeNull();
    expect(applyAssignment(before, { labels: [] }).areaId).toBe("kitchen");
  });
});

describe("provisional ids", () => {
  const action: AuthoringAction = {
    id: 9,
    type: "assignEntities",
    entityIds: ["light.porch"],
    items: [],
    changes: { categories: { automation: "~3" }, labels: ["~4", "night"], areaId: "~5" },
  };

  it("lists every group id an action refers to", () => {
    expect(referencedGroupIds(action).toSorted()).toEqual(["night", "~3", "~4", "~5"]);
  });

  it("replaces only provisional ids", () => {
    const resolved = resolveProvisionalIds(action, (id) => `real${id.slice(1)}`);
    expect(resolved.changes).toEqual({
      categories: { automation: "real3" },
      labels: ["real4", "night"],
      addLabels: undefined,
      removeLabels: undefined,
      areaId: "real5",
    });
  });

  it("resolves an area's floor and labels, and the group a change targets", () => {
    const save: AuthoringAction = {
      id: 10,
      type: "saveGroup",
      kind: "area",
      groupId: "~6",
      fields: { floor_id: "~7", labels: ["~8"] },
    };
    expect(resolveProvisionalIds(save, (id) => `r${id.slice(1)}`)).toMatchObject({
      groupId: "r6",
      fields: { floor_id: "r7", labels: ["r8"] },
    });
  });
});

describe("collectReferences", () => {
  it("finds services and ids anywhere in the configuration, including legacy forms", () => {
    const refs = collectReferences("automation", {
      ...porchAutomation,
      conditions: [{ condition: "state", entity_id: "binary_sensor.dark, input_boolean.away", state: "on" }],
    });
    expect(refs.services).toEqual(["light.turn_on", "notify.mobile_app_phone", "scene.turn_on"]);
    expect(refs.entities).toEqual(["binary_sensor.dark", "input_boolean.away", "light.hall", "light.porch"]);
    expect(refs.areas).toEqual(["kitchen"]);
  });

  it("treats a scene's entity map keys as referenced entities", () => {
    const refs = collectReferences("scene", { name: "Movie", entities: { "light.tv": { state: "on" } } });
    expect(refs.entities).toEqual(["light.tv"]);
  });
});

describe("sameConfig", () => {
  it("ignores the id and key order but not values", () => {
    expect(sameConfig({ id: "1", alias: "x", mode: "single" }, { mode: "single", alias: "x" })).toBe(true);
    expect(sameConfig({ alias: "x" }, { alias: "y" })).toBe(false);
    expect(sameConfig(null, { alias: "x" })).toBe(false);
    expect(sameConfig(null, null)).toBe(true);
  });
});

describe("describeAuthoringAction", () => {
  it("shows what a new automation calls and touches, with the full configuration", () => {
    const { title, fields, descriptionIsComplete, implementsRevert } = describeAuthoringAction(
      { id: 1, type: "saveConfigItem", domain: "automation", itemId: "17", config: porchAutomation, isNew: true },
      registry(),
      [],
    );
    expect(title).toBe("Create automation: Porch at sunset");
    expect(implementsRevert).toBe(true);
    expect(descriptionIsComplete).toBe(true);
    expect(fields).toContainEqual({
      label: "Services called",
      kind: "list",
      items: ["light.turn_on", "notify.mobile_app_phone", "scene.turn_on"],
    });
    expect(fields).toContainEqual({
      label: "Entities referenced",
      kind: "list",
      items: ["light.hall", "light.porch (Porch)"],
    });
    expect(fields).toContainEqual({ label: "Areas referenced", kind: "list", items: ["kitchen (Kitchen)"] });
    expect(fields?.find((f) => f.label === "Configuration")).toMatchObject({
      kind: "json",
      value: JSON.stringify(porchAutomation, null, 2),
    });
  });

  it("names a label created by a pending action and the categories by their submitted names", () => {
    const create: AuthoringAction = { id: 4, type: "saveGroup", kind: "label", fields: { name: "Outdoor" } };
    const { title, fields } = describeAuthoringAction(
      {
        id: 5,
        type: "assignEntities",
        entityIds: ["light.porch"],
        items: [],
        changes: { addLabels: ["~4"], categories: { automation: "cat-lighting" } },
        categoryNames: { "cat-lighting": "Lighting" },
      },
      registry(),
      [create],
    );
    expect(title).toBe("Organise: Porch");
    expect(fields).toContainEqual({
      label: "Add labels",
      kind: "list",
      items: ["~4 (Outdoor (created by pending action #4))"],
    });
    expect(fields).toContainEqual({
      label: "Categories",
      kind: "list",
      items: ["automation: cat-lighting (Lighting)"],
    });
  });

  it("counts what a label deletion detaches", () => {
    const { description } = describeAuthoringAction(
      { id: 1, type: "deleteGroup", kind: "label", groupId: "night", name: "Nightlights" },
      registry(),
      [],
    );
    expect(description).toContain("removed from 1 entity, 1 device and 1 area");
  });
});
