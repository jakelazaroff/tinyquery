import { signal } from "@preact/signals";

/**
 * @typedef {import("../tinyquery.js").QueryState} QueryState
 * @typedef {import("../tinyquery.js").QueryClient} QueryClient
 */

/**
 * @template {any} Params
 * @template {any[]} Key
 * @template {any} Data
 */
export class Query {
	/** @type {QueryState} */
	static DEFAULT_STATE = { status: "success", data: undefined };

	#fetched = false;

	/** @type {QueryClient} */
	#client;

	/** @type {(key: Key) => Promise<Data>} */
	#fn;

	/** @type {(params: Params) => Key} */
	#key;

	/** @type {Params} */
	#params;

	#state = signal({ status: "success", data: undefined });

	/** @type {(() => void) | null} */
	#unsub = null;

	/**
	 * @param {QueryClient} client
	 * @param {object} options
	 * @param {Params} options.params
	 * @param {(params: Params) => Key} options.key
	 * @param {(key: Key) => Promise<Data>} options.query
	 */
	constructor(client, { params, key, query }) {
		this.#client = client;
		this.#fn = query;
		this.#key = key;
		this.#params = params;
		this.#init();
	}

	async #init() {
		const key = JSON.stringify(this.#key(this.#params));
		const state = await this.#client.value(key);
		this.#state.value = state;
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
		this.#state.value = obs.get();
		this.#unsub = obs.subscribe((s) => {
			this.#state.value = s;
		});
	}

	fetch() {
		this.#fetch(this.#key(this.#params));
	}

	[Symbol.dispose]() {
		this.#unsub?.();
		this.#unsub = null;
	}

	get data() {
		if (!this.#fetched) this.#fetch(this.#key(this.#params));
		return this.#state.value.data;
	}
}
