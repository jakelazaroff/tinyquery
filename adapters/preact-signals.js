import { signal } from "@preact/signals";
import { Query as CoreQuery } from "../tinyquery.js";

/**
 * @template {any} Params
 * @template {any[]} Key
 * @template {any} Data
 * @extends {CoreQuery<Params, Key, Data>}
 */
export class Query extends CoreQuery {
	#state = signal({ status: "success", data: undefined });

	/**
	 * @param {import("../tinyquery.js").QueryClient} client
	 * @param {object} options
	 * @param {Params} options.params
	 * @param {(params: Params) => Key} options.key
	 * @param {(key: Key) => Promise<Data>} options.query
	 */
	constructor(client, options) {
		super(client, { ...options, set: (s) => (this.#state.value = s) });
	}

	/** @override */
	get data() {
		this.ensureFetched();
		return this.#state.value.data;
	}
}
