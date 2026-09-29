import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { NodeRegistry } from "../gateway/node-registry.js";
import {
  createTestNodeSocket,
  makeClient,
  registerNodeSession,
} from "../gateway/node-registry.test-helpers.js";
import type { GatewayWsClient } from "../gateway/server/ws-types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { withEnvAsync } from "../test-utils/env.js";
import { issueDeviceBootstrapToken } from "./device-bootstrap.js";
import { withDevicePairingLock } from "./device-pairing-lock.js";
import {
  captureNodePairingGeneration,
  isNodePairingGenerationCurrent,
  isPairedDeviceNodeBindingCurrent,
} from "./device-pairing-node-state.js";
import {
  recordPairedNodeHostStats,
  recordPairedNodeConnection,
  recordPairedNodeDisconnection,
  renamePairedNode,
} from "./device-pairing-node.js";
import { getPublishedPairedDeviceBinding } from "./device-pairing-publication.js";
import { persistDevicePairingStoreState } from "./device-pairing-store.js";
import {
  revokeDeviceToken,
  rotateDeviceToken,
  verifyDeviceToken,
} from "./device-pairing-tokens.js";
import { withCurrentDevicePairingSnapshot } from "./device-pairing-worker.js";
import {
  getPairedDevice,
  listDevicePairing,
  listDevicePairingReadOnly,
  removePairedDevice,
  updatePairedDeviceMetadata,
  updatePairedDevicePresence,
} from "./device-pairing.js";

let baseDir: string;
let database: ReturnType<typeof openOpenClawStateDatabase>;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseByPathAsync(database.path);
    cleanup();
  }),
);

beforeAll(() => {
  baseDir = tempDirs.make("pairing-publication-");
  database = openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } });
});

beforeEach(() => {
  persistDevicePairingStoreState(
    {
      pendingById: {},
      pairedByDeviceId: {
        node: {
          deviceId: "node",
          publicKey: "synthetic-node-key",
          roles: ["node"],
          approvedScopes: [],
          tokens: {
            node: { token: "synthetic-node-token", role: "node", scopes: [], createdAtMs: 1 },
          },
          nodeSurface: { createdAtMs: 1, approvedAtMs: 1, lastConnectedAtMs: 1 },
          createdAtMs: 1,
          approvedAtMs: 1,
        },
      },
    },
    baseDir,
    "both",
  );
});

test("keeps committed node bindings across bootstrap writes and caller-owned row edits", async () => {
  await listDevicePairing(baseDir);
  const binding = getPublishedPairedDeviceBinding("node", baseDir);
  expect(binding).not.toBeNull();
  await issueDeviceBootstrapToken({ baseDir });
  expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(binding);
  const device = await getPairedDevice("node", baseDir);
  device!.tokens!.node!.revokedAtMs = 100;
  expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(binding);
  const copy = getPublishedPairedDeviceBinding("node", baseDir)!;
  copy.identity = "caller-edit";
  expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(binding);
});

test.each([
  { change: "unrelated operator approval", remainsCurrent: true },
  { change: "node surface reapproval", remainsCurrent: false },
  { change: "node token replacement", remainsCurrent: false },
  { change: "node token revocation", remainsCurrent: false },
] as const)("refreshes node work authority after $change", async ({ change, remainsCurrent }) => {
  await withEnvAsync({ OPENCLAW_STATE_DIR: baseDir }, async () => {
    const generation = await captureNodePairingGeneration("node");
    expect(generation).not.toBeNull();
    await expect(isNodePairingGenerationCurrent(generation!)).resolves.toBe(true);
    const device = await getPairedDevice("node");
    expect(device).not.toBeNull();
    switch (change) {
      case "unrelated operator approval":
        device!.approvedAtMs = 2;
        device!.roles = ["node", "operator"];
        device!.tokens!.operator = {
          token: "synthetic-operator-token",
          role: "operator",
          scopes: ["operator.pairing"],
          createdAtMs: 2,
        };
        break;
      case "node surface reapproval":
        device!.nodeSurface!.approvedAtMs = 2;
        break;
      case "node token replacement":
        device!.tokens!.node!.token = "synthetic-replacement-token";
        device!.tokens!.node!.rotatedAtMs = 2;
        break;
      case "node token revocation":
        device!.tokens!.node!.revokedAtMs = 2;
        break;
    }
    persistDevicePairingStoreState(
      { pendingById: {}, pairedByDeviceId: { node: device! } },
      baseDir,
      "paired",
    );
    await expect(isNodePairingGenerationCurrent(generation!)).resolves.toBe(remainsCurrent);
  });
});

test("keeps inspection snapshot bytes without republishing revoked node authority", async () => {
  await listDevicePairing(baseDir);
  await withOpenClawStateDatabaseReadSnapshot(
    async () => {
      const historical = JSON.stringify(await listDevicePairingReadOnly(baseDir));
      await removePairedDevice("node", baseDir);
      expect(getPublishedPairedDeviceBinding("node", baseDir)).toBeNull();
      expect(JSON.stringify(await listDevicePairingReadOnly(baseDir))).toBe(historical);
      expect(getPublishedPairedDeviceBinding("node", baseDir)).toBeNull();
      expect(await getPairedDevice("node", baseDir)).toBeNull();
      expect((await listDevicePairing(baseDir)).paired).toEqual([]);
      expect(
        await withCurrentDevicePairingSnapshot(baseDir, (paired) => ({
          start: () => paired.length,
        })),
      ).toBe(0);
    },
    { path: database.path, env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } },
  );
});

test.each(["worker commit", "external commit"] as const)(
  "does not restore revoked node authority from a read delayed past a newer %s",
  async (commit) => {
    await listDevicePairing(baseDir);
    expect(getPublishedPairedDeviceBinding("node", baseDir)).not.toBeNull();
    const releaseRead = createDeferredCore();
    const releaseMutation = createDeferredCore();
    const mutationQueued = createDeferredCore();
    const originalRead = stateReads.executeExistingOpenClawStateRead;
    const readProduced = createDeferredCore<Awaited<ReturnType<typeof originalRead>>>();
    const originalMutation = stateWorker.runOpenClawStateWorkerOperation;
    const read = vi
      .spyOn(stateReads, "executeExistingOpenClawStateRead")
      .mockImplementationOnce(async (...args) => {
        try {
          const reply = await originalRead(...args);
          readProduced.resolve(reply);
          await releaseRead.promise;
          return reply;
        } catch (error) {
          readProduced.reject(error);
          throw error;
        }
      });
    const writer = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementationOnce(async (...args) => {
        mutationQueued.resolve();
        await releaseMutation.promise;
        return originalMutation(...args);
      });
    try {
      await withDevicePairingLock(async () => {
        const mutation =
          commit === "worker commit" ? removePairedDevice("node", baseDir) : undefined;
        if (mutation) {
          await Promise.race([mutationQueued.promise, mutation]);
        }
        const delayed = getPairedDevice("node", baseDir).then(
          (device) => ({ device }),
          (error: unknown) => ({ error }),
        );
        try {
          expect(await readProduced.promise).toMatchObject({
            type: "devicePairing.lookup",
            device: { deviceId: "node", publicKey: "synthetic-node-key" },
          });
          if (mutation) {
            releaseMutation.resolve();
            await mutation;
          } else {
            const other = new DatabaseSync(database.path);
            try {
              other.prepare("DELETE FROM device_pairing_paired WHERE device_id = ?").run("node");
            } finally {
              other.close();
            }
            expect(await getPairedDevice("node", baseDir)).toBeNull();
          }
          expect(getPublishedPairedDeviceBinding("node", baseDir)).toBeNull();
          releaseRead.resolve();
          const settled = await delayed;
          // An obsolete read may refuse or reread; it must never return the old authority.
          if ("device" in settled) {
            expect(settled.device).toBeNull();
          }
          expect(getPublishedPairedDeviceBinding("node", baseDir)).toBeNull();
        } finally {
          releaseRead.resolve();
          releaseMutation.resolve();
          await Promise.allSettled([delayed, mutation]);
        }
      });
    } finally {
      read.mockRestore();
      writer.mockRestore();
    }
  },
);

// Hold the actual mutation adapter before worker execution: this is the interval
// in which unrelated presence writes used to reject live input and progress.
test.each([
  { kind: "metadata", target: "node" },
  { kind: "metadata", target: "other" },
  { kind: "presence", target: "node" },
  { kind: "presence", target: "other" },
  { kind: "hostStats", target: "node" },
  { kind: "hostStats", target: "other" },
  { kind: "connection", target: "node" },
  { kind: "connection", target: "other" },
  { kind: "disconnection", target: "node" },
  { kind: "disconnection", target: "other" },
  { kind: "rename", target: "node" },
  { kind: "rename", target: "other" },
  { kind: "verifyToken", target: "node" },
  { kind: "verifyToken", target: "other" },
] as const)(
  "keeps a node invocation usable during a $kind mutation on $target",
  async ({ kind, target }) => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: baseDir }, async () => {
      const device = await getPairedDevice("node", baseDir);
      persistDevicePairingStoreState(
        {
          pendingById: {},
          pairedByDeviceId: {
            node: device!,
            other: { ...device!, deviceId: "other", publicKey: "other-key" },
          },
        },
        baseDir,
        "paired",
      );
      await listDevicePairing(baseDir);
      const binding = getPublishedPairedDeviceBinding("node", baseDir)!;
      const generation = await captureNodePairingGeneration(target);
      const registry = new NodeRegistry({
        isPairingStateCurrent: isPairedDeviceNodeBindingCurrent,
        resolveCurrentPairingState: async () => binding,
      });
      const frames: string[] = [];
      const sent = createDeferredCore<string>();
      const socket = createTestNodeSocket(frames);
      socket.send.mockImplementation((frame: string) => {
        frames.push(frame);
        sent.resolve(frame);
      });
      registerNodeSession(
        registry,
        makeClient("conn", "node", frames, {
          socket: socket as unknown as GatewayWsClient["socket"],
        }),
        {
          pairingIdentity: binding.identity,
          pairingGeneration: binding.generation,
        },
      );
      const chunks: string[] = [];
      const invocation = registry.invoke({
        nodeId: "node",
        command: "debug.ping",
        timeoutMs: 60_000,
        idleTimeoutMs: 30_000,
        onProgress: (chunk) => chunks.push(chunk),
      });
      const invokeId = JSON.parse(await sent.promise).payload.id as string;
      const queued = createDeferredCore();
      const release = createDeferredCore();
      const original = stateWorker.runOpenClawStateWorkerOperation;
      const writer = vi
        .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
        .mockImplementationOnce(async (...args) => {
          queued.resolve();
          await release.promise;
          return original(...args);
        });
      const mutation = (() => {
        switch (kind) {
          case "metadata":
            return updatePairedDeviceMetadata(target, { displayName: "Updated" }, baseDir);
          case "presence":
            return updatePairedDevicePresence(
              target,
              { lastSeenAtMs: 100, lastSeenReason: "heartbeat" },
              generation!,
              baseDir,
            );
          case "hostStats":
            return recordPairedNodeHostStats({
              nodeId: target,
              baseDir,
              expectedPairingGeneration: generation!,
              hostStats: {
                cpuCount: 8,
                memoryTotalBytes: 16384,
                memoryFreeBytes: 8192,
                updatedAtMs: 100,
              },
            });
          case "connection":
            return recordPairedNodeConnection(target, 100, baseDir, generation!).then((result) => {
              expect(result.recorded).toBe(true);
              return true;
            });
          case "disconnection":
            return recordPairedNodeDisconnection({
              nodeId: target,
              connectedAtMs: 1,
              disconnectedAtMs: 100,
              expectedPairingGeneration: generation!,
              baseDir,
            }).then((result) => {
              expect(result.recorded).toBe(true);
              return true;
            });
          case "rename":
            return renamePairedNode(target, "Updated", baseDir).then((result) => {
              expect(result?.displayName).toBe("Updated");
              return true;
            });
          case "verifyToken":
            return verifyDeviceToken({
              deviceId: target,
              role: "node",
              scopes: [],
              token: "synthetic-node-token",
              baseDir,
            }).then((result) => {
              expect(result.ok).toBe(true);
              return true;
            });
        }
        throw new Error("Unsupported metadata mutation");
      })();
      try {
        await Promise.race([queued.promise, mutation]);
        // This is the inbound RPC gate before node.invoke.progress is dispatched.
        await expect.soft(registry.isConnectionCurrentPairingState("conn")).resolves.toBe(true);
        expect
          .soft(() => registry.sendInvokeInput(invokeId, { command: "continue" }))
          .not.toThrow();
        expect(
          registry.handleInvokeProgress({
            invokeId,
            nodeId: "node",
            connId: "conn",
            seq: 0,
            chunk: "working",
          }),
        ).toBe(true);
        expect(chunks).toEqual(["working"]);
        expect(frames.map((frame) => JSON.parse(frame).event)).toContain("node.invoke.input");
        release.resolve();
        await expect(mutation).resolves.toBe(true);
        expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(binding);
        expect(
          registry.handleInvokeResult({ id: invokeId, nodeId: "node", connId: "conn", ok: true }),
        ).toBe(true);
        await expect(invocation).resolves.toMatchObject({ ok: true });
      } finally {
        release.resolve();
        await mutation;
        writer.mockRestore();
        registry.unregister("conn");
        await invocation;
      }
    });
  },
);

test.each(["remove", "revoke", "rotate"] as const)(
  "fences current node authority throughout a %s mutation",
  async (kind) => {
    await listDevicePairing(baseDir);
    const originalBinding = getPublishedPairedDeviceBinding("node", baseDir);
    const queued = createDeferredCore();
    const release = createDeferredCore();
    const original = stateWorker.runOpenClawStateWorkerOperation;
    const writer = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementationOnce(async (...args) => {
        queued.resolve();
        await release.promise;
        return original(...args);
      });
    const mutation =
      kind === "remove"
        ? removePairedDevice("node", baseDir)
        : kind === "revoke"
          ? revokeDeviceToken({ deviceId: "node", role: "node", baseDir })
          : rotateDeviceToken({ deviceId: "node", role: "node", baseDir });
    try {
      await Promise.race([queued.promise, mutation]);
      expect(() => getPublishedPairedDeviceBinding("node", baseDir)).toThrow(
        "current worker publication",
      );
      release.resolve();
      await mutation;
      expect(getPublishedPairedDeviceBinding("node", baseDir)).not.toEqual(originalBinding);
    } finally {
      release.resolve();
      await mutation;
      writer.mockRestore();
    }
  },
);

test("fails closed after a metadata worker failure and does not revive it during the next write", async () => {
  await listDevicePairing(baseDir);
  const writer = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockRejectedValueOnce(new Error("synthetic worker failure"));
  try {
    await expect(
      updatePairedDeviceMetadata("node", { displayName: "Updated" }, baseDir),
    ).rejects.toThrow("synthetic worker failure");
    expect(() => getPublishedPairedDeviceBinding("node", baseDir)).toThrow(
      "current worker publication",
    );
  } finally {
    writer.mockRestore();
  }
  const original = stateWorker.runOpenClawStateWorkerOperation;
  const nextWriter = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementationOnce(async (...args) => {
      expect(() => getPublishedPairedDeviceBinding("node", baseDir)).toThrow(
        "current worker publication",
      );
      return original(...args);
    });
  try {
    await updatePairedDeviceMetadata("node", { displayName: "Recovered" }, baseDir);
    expect(getPublishedPairedDeviceBinding("node", baseDir)).not.toBeNull();
  } finally {
    nextWriter.mockRestore();
  }
});

test("rejects externally revoked pairing across a queued metadata write", async () => {
  const device = await getPairedDevice("node", baseDir);
  persistDevicePairingStoreState(
    {
      pendingById: {},
      pairedByDeviceId: {
        node: device!,
        other: { ...device!, deviceId: "other", publicKey: "other-key" },
      },
    },
    baseDir,
    "paired",
  );
  await listDevicePairing(baseDir);
  const binding = getPublishedPairedDeviceBinding("node", baseDir)!;
  const registry = new NodeRegistry({
    resolveCurrentPairingState: async (nodeId) => {
      await getPairedDevice(nodeId, baseDir);
      return getPublishedPairedDeviceBinding(nodeId, baseDir) ?? undefined;
    },
  });
  registerNodeSession(registry, makeClient("conn", "node", []), {
    pairingIdentity: binding.identity,
    pairingGeneration: binding.generation,
  });
  const queued = createDeferredCore();
  const releaseMutation = createDeferredCore();
  const releaseRead = createDeferredCore();
  const originalMutation = stateWorker.runOpenClawStateWorkerOperation;
  const originalRead = stateReads.executeExistingOpenClawStateRead;
  const readProduced = createDeferredCore<Awaited<ReturnType<typeof originalRead>>>();
  const writer = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementationOnce(async (...args) => {
      queued.resolve();
      await releaseMutation.promise;
      return originalMutation(...args);
    });
  const reader = vi
    .spyOn(stateReads, "executeExistingOpenClawStateRead")
    .mockImplementationOnce(async (...args) => {
      try {
        const reply = await originalRead(...args);
        readProduced.resolve(reply);
        await releaseRead.promise;
        return reply;
      } catch (error) {
        readProduced.reject(error);
        throw error;
      }
    });
  const mutation = updatePairedDeviceMetadata("other", { displayName: "Updated" }, baseDir);
  let lookup: ReturnType<typeof getPairedDevice> | undefined;
  try {
    await Promise.race([queued.promise, mutation]);
    const external = new DatabaseSync(database.path);
    try {
      external.prepare("DELETE FROM device_pairing_paired WHERE device_id = ?").run("node");
    } finally {
      external.close();
    }
    lookup = getPairedDevice("node", baseDir);
    expect(await Promise.race([readProduced.promise, lookup])).toMatchObject({
      type: "devicePairing.lookup",
      device: null,
    });
    releaseMutation.resolve();
    await expect(mutation).resolves.toBe(true);
    // The receipt's different before-revision discards the previously published binding.
    expect(() => getPublishedPairedDeviceBinding("node", baseDir)).toThrow(
      "current worker publication",
    );
    // A read admitted during the write must refresh after its publication was superseded.
    releaseRead.resolve();
    await expect(lookup).resolves.toBeNull();
    expect(getPublishedPairedDeviceBinding("node", baseDir)).toBeNull();
    await expect(registry.isConnectionCurrentPairingState("conn")).resolves.toBe(false);
  } finally {
    releaseRead.resolve();
    releaseMutation.resolve();
    await Promise.allSettled([lookup, mutation]);
    reader.mockRestore();
    writer.mockRestore();
    registry.unregister("conn");
  }
});
