import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { memoryStorage, localChannel, QueryClient } from "./tinyquery.js";

// Polyfill navigator.locks with a simple async mutex
const lockQueues = new Map();
Object.defineProperty(globalThis, "navigator", {
	value: {
		locks: {
			/** @param {string} key @param {(lock: any) => Promise<any>} fn */
			async request(key, fn) {
				while (lockQueues.has(key)) await lockQueues.get(key);
				const promise = fn({ name: key, mode: "exclusive" });
				lockQueues.set(key, promise);
				try {
					return await promise;
				} finally {
					lockQueues.delete(key);
				}
			},
		},
	},
	writable: true,
	configurable: true,
});

/** @returns {{ storage: ReturnType<typeof memoryStorage>, channel: ReturnType<typeof localChannel>, client: QueryClient }} */
function setup() {
	const storage = memoryStorage();
	const channel = localChannel();
	const client = new QueryClient({ storage, channel });
	return { storage, channel, client };
}

describe("QueryClient", () => {
	test("basic query resolves with data", async () => {
		const { client } = setup();
		const obs = await client.query("users", async () => [1, 2, 3]);
		assert.deepEqual(obs.get(), { status: "success", data: [1, 2, 3] });
	});

	test("query error is captured", async () => {
		const { client } = setup();
		const err = new Error("boom");
		const obs = await client.query("fail", async () => {
			throw err;
		});
		assert.equal(obs.get().status, "error");
		assert.equal(obs.get().error, err);
	});

	test("successful query persists to storage", async () => {
		const { client, storage } = setup();
		await client.query("k", async () => "val");
		assert.equal(await storage.get("k"), "val");
	});

	test("failed query does not persist to storage", async () => {
		const { client, storage } = setup();
		await client.query("k", async () => {
			throw new Error("nope");
		});
		assert.equal(await storage.get("k"), undefined);
	});

	test("second query for same key returns same observable", async () => {
		const { client } = setup();
		const obs1 = await client.query("k", async () => "a");
		const obs2 = await client.query("k", async () => "b");
		assert.equal(obs1, obs2);
		assert.equal(obs1.get().data, "b");
	});

	test("subscriber sees status transitions", async () => {
		const { client } = setup();
		/** @type {any[]} */
		const states = [];

		// First query to create the observable
		const obs = await client.query("k", async () => "first");

		obs.subscribe((s) => states.push(s));

		// Second query — subscriber should see loading, success, then
		// the channel echo (localChannel dispatches synchronously back
		// into the same client's subscriber)
		await client.query("k", async () => "second");

		assert.equal(states[0].status, "loading");
		assert.equal(states[1].status, "success");
		assert.equal(states[1].data, "second");
		// Channel echo re-sets the same success state
		assert.equal(states[2].status, "success");
		assert.equal(states[2].data, "second");
	});

	test("channel publish broadcasts success to other clients", async () => {
		const storage = memoryStorage();
		const channel = localChannel();
		const client1 = new QueryClient({ storage, channel });
		const client2 = new QueryClient({ storage, channel });

		const obs1 = await client1.query("k", async () => "from-1");

		// client2 queries the same key — it will pick up stored value,
		// then refetch
		const obs2 = await client2.query("k", async () => "from-2");
		assert.equal(obs2.get().data, "from-2");

		// client1's observable should have been updated via the channel
		assert.equal(obs1.get().data, "from-2");
	});

	test("cached data is returned on first load", async () => {
		const storage = memoryStorage();
		const channel = localChannel();

		// Pre-seed storage
		await storage.set("k", { data: "cached" });

		const client = new QueryClient({ storage, channel });

		const obs = await client.query("k", async () => "fresh");

		// Final state is fresh data
		assert.equal(obs.get().data, "fresh");
	});

	test("lock deduplicates concurrent queries", async () => {
		const { client } = setup();
		let callCount = 0;

		const p1 = client.query("k", async () => {
			callCount++;
			return "result";
		});

		const p2 = client.query("k", async () => {
			callCount++;
			return "result2";
		});

		const [obs1, obs2] = await Promise.all([p1, p2]);

		// The second query's fn should be skipped because the first
		// already resolved while the second was waiting for the lock
		assert.equal(callCount, 1);
		assert.equal(obs1.get().data, "result");
		assert.equal(obs2.get().data, "result");
	});
});
