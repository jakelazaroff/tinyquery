/**
 * @typedef {"loading" | "success" | "error"} QueryStatus
 * @typedef {{ status: QueryStatus, data?: unknown, error?: any }} QueryState
 */

/**
 * @typedef {object} StorageAdapter
 * @property {(key: string) => Promise<any | null>} get
 * @property {(key: string, entry: any) => Promise<void>} set
 * @property {(key: string) => Promise<void>} delete
 */

/**
 * @typedef {{ key: string, state: QueryState }} ChannelMessage
 * @typedef {object} ChannelAdapter
 * @property {(msg: ChannelMessage) => void} publish
 * @property {(handler: (msg: ChannelMessage) => void) => (() => void)} subscribe
 */

export function memoryStorage() {
	const store = new Map();

	/** @type {StorageAdapter} */
	const adapter = {
		get: async (key) => store.get(key),
		set: async (key, data) => void store.set(key, data),
		delete: async (key) => void store.delete(key),
	};

	return adapter;
}

/**
 * @param {string} name
 * @param {{ dbVersion?: number }} [options]
 */
export function indexedDBStorage(name, options) {
	const dbVersion = options?.dbVersion ?? 1;
	const storeName = "kv";

	/** @type {Promise<IDBDatabase>} */
	const dbPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(name, dbVersion);
		req.onupgradeneeded = () => req.result.createObjectStore(storeName);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});

	/**
	 * @param {IDBTransactionMode} mode
	 * @returns {Promise<IDBObjectStore>}
	 */
	const getStore = async (mode) => {
		const db = await dbPromise;
		return db.transaction(storeName, mode).objectStore(storeName);
	};

	/**
	 * @template T
	 * @param {IDBRequest<T>} req
	 * @returns {Promise<T>}
	 */
	const wrap = (req) =>
		new Promise((resolve, reject) => {
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});

	/** @type {StorageAdapter} */
	const adapter = {
		get: async (key) => wrap((await getStore("readonly")).get(key)),
		set: async (key, data) => void (await wrap((await getStore("readwrite")).put(data, key))),
		delete: async (key) => void (await wrap((await getStore("readwrite")).delete(key))),
	};

	return adapter;
}

export function localChannel() {
	const target = new EventTarget();

	/** @type {ChannelAdapter} */
	const adapter = {
		publish: (msg) => target.dispatchEvent(new CustomEvent("message", { detail: msg })),
		subscribe: (handler) => {
			const ctrl = new AbortController();
			target.addEventListener("message", (e) => handler(/** @type {CustomEvent<ChannelMessage>} */ (e).detail), {
				signal: ctrl.signal,
			});
			return () => ctrl.abort();
		},
	};

	return adapter;
}

/** @param {string} name */
export function broadcastChannel(name) {
	const bc = new BroadcastChannel(name);

	/** @type {ChannelAdapter} */
	const adapter = {
		publish: (msg) => bc.postMessage(msg),
		subscribe: (handler) => {
			const ctrl = new AbortController();
			bc.addEventListener("message", ({ data }) => handler(data), { signal: ctrl.signal });
			return () => ctrl.abort();
		},
	};

	return adapter;
}

/** @template T */
class Observable {
	/** @type {Set<(value: T) => void>} */
	#subscribers = new Set();

	/** @type {T} */
	#value;

	/** @param {T} value */
	constructor(value) {
		this.#value = value;
	}

	get() {
		return this.#value;
	}

	/** @param {T} value */
	set(value) {
		this.#value = value;
		for (const fn of this.#subscribers) fn(value);
	}

	/** @param {(value: T) => void} fn */
	subscribe(fn) {
		this.#subscribers.add(fn);
		return () => this.#subscribers.delete(fn);
	}
}

/**
 * @template {any} Params
 * @template {any[]} Key
 * @template {any} Data
 */
export class Query {
	#fetched = false;

	/** @type {QueryClient} */
	#client;

	/** @type {(key: Key) => Promise<Data>} */
	#fn;

	/** @type {(params: Params) => Key} */
	#key;

	/** @type {Params} */
	#params;

	/** @type {QueryState} */
	#state = { status: "success", data: undefined };

	/** @type {(state: QueryState) => void} */
	#set;

	/** @type {(() => void) | null} */
	#unsub = null;

	/**
	 * @param {QueryClient} client
	 * @param {object} options
	 * @param {Params} options.params
	 * @param {(params: Params) => Key} options.key
	 * @param {(key: Key) => Promise<Data>} options.query
	 * @param {(state: QueryState) => void} options.set
	 */
	constructor(client, { params, key, query, set }) {
		this.#client = client;
		this.#fn = query;
		this.#key = key;
		this.#params = params;
		this.#set = set;
		this.#init();
	}

	async #init() {
		const key = JSON.stringify(this.#key(this.#params));
		const state = await this.#client.value(key);
		this.#setState(state.get());
	}

	/** @param {QueryState} state */
	#setState(state) {
		this.#state = state;
		this.#set(state);
	}

	/** @param {Params} value */
	set params(value) {
		const key = this.#key(value);
		if (JSON.stringify(this.#key(this.#params)) === JSON.stringify(key)) return;
		this.#params = value;

		this.#fetch(key);
	}

	/** @param {Key} key */
	async #fetch(key) {
		this.#fetched = true;
		this.#unsub?.();
		this.#unsub = null;

		const obs = await this.#client.query(JSON.stringify(key), () => this.#fn(key));
		this.#setState(obs.get());
		this.#unsub = obs.subscribe((s) => {
			this.#setState(s);
		});
	}

	fetch() {
		this.#fetch(this.#key(this.#params));
	}

	[Symbol.dispose]() {
		this.#unsub?.();
		this.#unsub = null;
	}

	ensureFetched() {
		if (!this.#fetched) this.#fetch(this.#key(this.#params));
	}

	get data() {
		this.ensureFetched();
		return this.#state.data;
	}
}

export class QueryClient {
	/** @type {Map<string, Observable<QueryState>>} */
	#queries = new Map();

	/** @type {StorageAdapter} */
	#storage;

	/** @type {ChannelAdapter} */
	#channel;

	/**
	 * @param {object} options
	 * @param {StorageAdapter} options.storage
	 * @param {ChannelAdapter} options.channel
	 */
	constructor({ storage, channel }) {
		this.#storage = storage;
		this.#channel = channel;

		this.#channel.subscribe((msg) => {
			if (msg.state.status === "success") this.#storage.set(msg.key, msg.state.data);

			const obs = this.#queries.get(msg.key);
			obs?.set(msg.state);
		});
	}

	/** @param {string} key */
	async value(key) {
		let obs = /** @type {Observable<QueryState>} */ (this.#queries.get(key));

		if (!obs) {
			const stored = await this.#storage.get(key);
			obs = new Observable(/** @type {QueryState} */ ({ status: "success", data: stored?.data }));
			this.#queries.set(key, obs);
		}

		return obs;
	}

	/**
	 * @param {string} key
	 * @param {() => Promise<unknown>} query
	 * @returns {Promise<Observable<QueryState>>}
	 */
	async query(key, query) {
		const obs = await this.value(key);

		obs.set({ ...obs.get(), status: "loading" });
		navigator.locks.request(key, async () => {
			if (obs.get().status !== "loading") return; // someone else finished while we waited

			try {
				const data = await query();
				const state = /** @type {QueryState} */ ({ status: "success", data });
				obs.set(state);
				await this.#storage.set(key, data);
				this.#channel.publish({ key, state });
			} catch (error) {
				const state = /** @type {QueryState} */ ({ status: "error", error });
				obs.set(state);
				this.#channel.publish({ key, state });
			}
		});

		return obs;
	}
}
