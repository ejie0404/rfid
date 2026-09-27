import { test } from "node:test";
import assert from "node:assert/strict";
import { startScheduledMoveOutWorker } from "../apps/api/dist/scheduled-move-out-worker.js";
import { Store } from "../apps/api/dist/store.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, message) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await pause(2);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

test("move-out worker does not overlap its own passes and shutdown drains the active pass", async () => {
  const entered = deferred();
  const finish = deferred();
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const store = {
    async acquireScheduledMoveOutWorkerLease() {
      return async () => {};
    },
    async processDueScheduledMoveOuts() {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      entered.resolve();
      await finish.promise;
      active--;
      return [];
    },
  };

  const worker = startScheduledMoveOutWorker(store, { intervalMs: 5 });
  try {
    await entered.promise;
    await pause(25);
    assert.equal(calls, 1, "timer ticks should skip while a pass is still running");
    assert.equal(maxActive, 1);

    let stopped = false;
    const stopping = worker.stop().then(() => (stopped = true));
    await pause(10);
    assert.equal(stopped, false, "shutdown waits for the current pass");
    finish.resolve();
    await stopping;
    await pause(10);
    assert.equal(calls, 1, "shutdown prevents later timer passes");
  } finally {
    finish.resolve();
    await worker.stop();
  }
});

test("separate worker instances honor the shared database lease", async () => {
  const entered = deferred();
  const finish = deferred();
  let leased = false;
  let calls = 0;
  const store = {
    async acquireScheduledMoveOutWorkerLease() {
      if (leased) return null;
      leased = true;
      return async () => {
        leased = false;
      };
    },
    async processDueScheduledMoveOuts() {
      calls++;
      entered.resolve();
      if (calls === 1) await finish.promise;
      return [];
    },
  };

  const first = startScheduledMoveOutWorker(store, { intervalMs: 5 });
  const second = startScheduledMoveOutWorker(store, { intervalMs: 5 });
  try {
    await entered.promise;
    await pause(25);
    assert.equal(calls, 1, "the second instance skips while the first holds the lease");
  } finally {
    await second.stop();
    const stopping = first.stop();
    finish.resolve();
    await stopping;
  }
  assert.equal(leased, false, "the worker releases its lease after shutdown");
});

test("a failed processing pass reports the error and releases the lease for the retry", async () => {
  let leased = false;
  let calls = 0;
  const errors = [];
  const store = {
    async acquireScheduledMoveOutWorkerLease() {
      assert.equal(leased, false);
      leased = true;
      return async () => {
        leased = false;
      };
    },
    async processDueScheduledMoveOuts() {
      calls++;
      if (calls === 1) throw new Error("database temporarily unavailable");
      return [];
    },
  };

  const worker = startScheduledMoveOutWorker(store, {
    intervalMs: 10_000,
    onError: (error) => errors.push(error),
  });
  try {
    await waitFor(() => errors.length === 1, "the worker should report the failed pass");
    assert.equal(leased, false, "failure must not strand the lease");
    await worker.runOnce();
    assert.equal(calls, 2, "a later pass can retry after the error");
    assert.equal(leased, false);
  } finally {
    await worker.stop();
  }
});

test("PostgreSQL worker lease holds one advisory-lock session until released", async () => {
  const store = new Store();
  const statements = [];
  let connectionReleases = 0;
  store.pool = {
    async connect() {
      return {
        async query(sql, values) {
          statements.push({ sql, values });
          return { rows: [{ acquired: true }] };
        },
        release() {
          connectionReleases++;
        },
      };
    },
  };

  const release = await store.acquireScheduledMoveOutWorkerLease();
  assert.equal(typeof release, "function");
  assert.equal(connectionReleases, 0, "the lock connection stays checked out during processing");
  await release();
  await release();
  assert.equal(connectionReleases, 1, "release is idempotent");
  assert.match(statements[0].sql, /pg_try_advisory_lock/);
  assert.match(statements[1].sql, /pg_advisory_unlock/);
  assert.deepEqual(statements[0].values, statements[1].values);
});

test("a worker that cannot acquire the PostgreSQL lease skips its pass", async () => {
  const store = new Store();
  let connectionReleases = 0;
  store.pool = {
    async connect() {
      return {
        async query() {
          return { rows: [{ acquired: false }] };
        },
        release() {
          connectionReleases++;
        },
      };
    },
  };

  assert.equal(await store.acquireScheduledMoveOutWorkerLease(), null);
  assert.equal(connectionReleases, 1, "a skipped worker returns its idle connection");
});

function leaseClient({ failOn }, releases) {
  return {
    async connect() {
      return {
        async query(sql) {
          if (failOn.test(sql)) throw new Error("lease query interrupted");
          return { rows: [{ acquired: true }] };
        },
        release(destroy) {
          releases.push(destroy);
        },
      };
    },
  };
}

test("a failed PostgreSQL lease unlock destroys the session instead of pooling it", async () => {
  const store = new Store();
  const releases = [];
  store.pool = leaseClient({ failOn: /pg_advisory_unlock/ }, releases);

  const release = await store.acquireScheduledMoveOutWorkerLease();
  await assert.rejects(release(), /lease query interrupted/);
  assert.deepEqual(releases, [true], "a session that may still hold the lease is destroyed");
  await release();
  assert.deepEqual(releases, [true], "release remains idempotent after a failed unlock");
});

test("a failed PostgreSQL lease attempt destroys the session", async () => {
  const store = new Store();
  const releases = [];
  store.pool = leaseClient({ failOn: /pg_try_advisory_lock/ }, releases);

  await assert.rejects(store.acquireScheduledMoveOutWorkerLease(), /lease query interrupted/);
  assert.deepEqual(releases, [true]);
});
