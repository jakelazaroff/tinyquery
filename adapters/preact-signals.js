// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Copyright (c) 2026 Jake Lazaroff https://github.com/jakelazaroff/tinyquery

import { signal } from "@preact/signals";
import { Query as CoreQuery } from "../tinyquery.js";

/**
 * @template {any} Params
 * @template {any[]} Key
 * @template {any} Data
 * @extends {CoreQuery<Params, Key, Data>}
 */
export class Query extends CoreQuery {
	#state = signal(CoreQuery.DEFAULT_STATE);

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

	get data() {
		this.ensureFetched();
		return this.#state.value.data;
	}

	get error() {
		return this.#state.value.error;
	}

	get loading() {
		return this.#state.value.status === "loading";
	}
}
