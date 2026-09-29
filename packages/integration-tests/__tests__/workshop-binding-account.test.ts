// GadgetBindingInfo.accountId: a binding reports the connected account its connection was created
// from, so the Connections tab can offer a reconnect -- but only to the user who connected it.
// Account ids index one user's own account list, so anyone else gets only connectedByOtherUser.

import { afterAll, beforeAll, expect, it } from "vitest";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import { startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, MAX_OBSERVER_PROMPTS, nextUsernames, ObserverConfigRecorder,
  signUp, stubFor, waitFor, type ConnectedAccount,
} from "../src/rpc-client.js";
import type { RpcStub } from "capnweb";

let harness: Harness;
const network = new NetworkInterceptor();

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness();
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

async function provisionAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the test account to be provisioned", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
}

it("reports a binding's account to the user who connected it, and to no one else", async () => {
  using publicApi = connect(harness.url);
  const [alice, bob] = nextUsernames("alice", "bob");

  using aliceApi = await signUp(publicApi, alice);
  const aliceAccount = await provisionAccount(aliceApi);
  using overseer = await aliceApi.newGadget();
  const { id: workspaceId } = await overseer.getMetadata();
  using connection = await overseer.newGatekeeper(
      aliceAccount.id, "https://gadgets-test.example/things/binding-account");
  if (!connection) throw new Error("Failed to create the test connection");
  using gadget = await overseer.createGadget("Test Gadget", undefined, "TEST_GADGET");
  await gadget.bind("TEST_THING", await connection.getId());
  const gadgetId = await gadget.getId();

  expect(await gadget.listBindings()).toContainEqual(expect.objectContaining({
    name: "TEST_THING", accountId: aliceAccount.id,
  }));

  using bobApi = await signUp(publicApi, bob);
  const bobAccount = await provisionAccount(bobApi);
  if (!await overseer.addCollaborator(bob, "build")) {
    throw new Error("Failed to share the workspace with bob");
  }
  const callback =
      stubFor(new ObserverConfigRecorder().alwaysChoose(bobAccount.id, MAX_OBSERVER_PROMPTS));
  using bobOverseer = await bobApi.openGadget(workspaceId, undefined, callback)
      .finally(() => callback[Symbol.dispose]());
  using bobGadget = await bobOverseer.getGadget(gadgetId);

  const [binding] = (await bobGadget.listBindings()).filter(b => b.name === "TEST_THING");
  expect(binding).toBeDefined();
  expect(binding).not.toHaveProperty("accountId");
  // Said explicitly, so bob's UI doesn't take it for an untracked connection of his own.
  expect(binding).toHaveProperty("connectedByOtherUser", true);
});
