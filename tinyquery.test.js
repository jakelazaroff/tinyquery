import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { memoryStorage, localChannel, QueryClient, Query } from "./tinyquery.js";

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

/** Wait for pending microtasks / async init to flush */
const flush = () => new Promise((r) => setTimeout(r, 10));

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
		await flush();
		const obs2 = await client.query("k", async () => "b");
		await flush();
		assert.equal(obs1, obs2);
		assert.equal(obs1.get().data, "b");
	});

	test("subscriber sees status transitions", async () => {
		const { client } = setup();
		/** @type {any[]} */
		const states = [];

		// First query to create the observable
		const obs = await client.query("k", async () => "first");
		await flush();

		obs.subscribe((s) => states.push(s));

		// Second query — subscriber should see loading, then success
		// (plus a channel echo that re-sets the same success state)
		await client.query("k", async () => "second");
		await flush();

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
		await flush();

		// client2 queries the same key — it will pick up stored value,
		// then refetch
		const obs2 = await client2.query("k", async () => "from-2");
		await flush();

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

/** @param {import("./tinyquery.js").QueryClient} client */
function createQuery(client, options) {
	/** @type {import("./tinyquery.js").QueryState[]} */
	const states = [];
	const query = new Query(client, {
		...options,
		set: (s) => states.push(s),
	});
	return { query, states };
}

describe("Query", () => {
	test("lazy fetch on first data access", async () => {
		const { client } = setup();
		let called = false;
		const { query, states } = createQuery(client, {
			params: { id: 1 },
			key: (p) => ["item", p.id],
			query: async () => {
				called = true;
				return "result";
			},
		});

		await flush();
		assert.equal(called, false);

		// Accessing .data triggers the fetch
		const _data = query.data;
		await flush();

		assert.equal(called, true);
		assert.equal(query.data, "result");
	});

	test("set callback receives state updates", async () => {
		const { client } = setup();
		const { query, states } = createQuery(client, {
			params: {},
			key: () => ["k"],
			query: async () => "value",
		});

		await flush();

		// Trigger fetch
		query.refetch();
		await flush();

		const last = states[states.length - 1];
		assert.equal(last.status, "success");
		assert.equal(last.data, "value");
	});

	test("explicit fetch triggers query", async () => {
		const { client } = setup();
		let callCount = 0;
		const { query } = createQuery(client, {
			params: {},
			key: () => ["k"],
			query: async () => ++callCount,
		});

		await flush();

		query.refetch();
		await flush();
		assert.equal(query.data, 1);

		query.refetch();
		await flush();
		assert.equal(query.data, 2);
	});

	test("params setter re-fetches on key change", async () => {
		const { client } = setup();
		const { query, states } = createQuery(client, {
			params: { id: 1 },
			key: (p) => ["item", p.id],
			query: async (key) => `data-${key[1]}`,
		});

		await flush();

		// Access data to trigger initial fetch
		query.data;
		await flush();

		query.params = { id: 2 };
		await flush();

		assert.equal(query.data, "data-2");
	});

	test("params setter skips fetch when key is unchanged", async () => {
		const { client } = setup();
		let callCount = 0;
		const { query } = createQuery(client, {
			params: { id: 1, name: "a" },
			key: (p) => ["item", p.id],
			query: async () => ++callCount,
		});

		await flush();
		query.data;
		await flush();
		assert.equal(callCount, 1);

		// Different params object but same key
		query.params = { id: 1, name: "b" };
		await flush();
		assert.equal(callCount, 1);
	});

	test("query error surfaces in set callback", async () => {
		const { client } = setup();
		const err = new Error("boom");
		const { query, states } = createQuery(client, {
			params: {},
			key: () => ["k"],
			query: async () => {
				throw err;
			},
		});

		await flush();
		query.refetch();
		await flush();

		const errorState = states.find((s) => s.status === "error");
		assert.ok(errorState);
		assert.equal(errorState.error, err);
	});

	test("dispose unsubscribes from observable", async () => {
		const { client } = setup();
		const { query, states } = createQuery(client, {
			params: {},
			key: () => ["k"],
			query: async () => "val",
		});

		await flush();
		query.refetch();
		await flush();

		const countBefore = states.length;
		query[Symbol.dispose]();

		// Re-query the same key via client — the disposed query should not receive updates
		await client.query(JSON.stringify(["k"]), async () => "new-val");
		await flush();

		assert.equal(states.length, countBefore);
	});

	test("init loads cached data via set callback", async () => {
		const storage = memoryStorage();
		const channel = localChannel();
		await storage.set(JSON.stringify(["k"]), { data: "cached" });
		const client = new QueryClient({ storage, channel });

		const { states } = createQuery(client, {
			params: {},
			key: () => ["k"],
			query: async () => "fresh",
		});

		await flush();

		const initState = states.find((s) => s.data === "cached");
		assert.ok(initState, "set callback should receive cached data on init");
	});
});
