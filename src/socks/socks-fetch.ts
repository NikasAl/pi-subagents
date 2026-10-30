import { socksDispatcher } from "fetch-socks";
import { fetch as undiciFetch, type Dispatcher } from "undici";
import type { ProxyConfig } from "../router/types.ts";

export type FetchFunction = typeof globalThis.fetch;

/**
 * Build a SOCKS5-tunnelled fetch for one proxy.
 *
 * Each proxy gets its own undici dispatcher (`fetch-socks` over `socks`), so
 * different providers can use different tunnels in the same process. The
 * returned function is a drop-in `fetch` for pi's provider request options
 * (`ProviderRequestOptions.fetch`).
 *
 * `dispatcherFactory` is injectable for tests.
 */
export function createSocksFetch(
	proxy: ProxyConfig,
	options: {
		dispatcherFactory?: (proxy: ProxyConfig) => Dispatcher;
	} = {},
): FetchFunction {
	const dispatcherFactory = options.dispatcherFactory ?? defaultDispatcherFactory;
	const dispatcher = dispatcherFactory(proxy);
	return ((input: Parameters<FetchFunction>[0], init?: Parameters<FetchFunction>[1]) => {
		return undiciFetch(input as never, { ...(init ?? {}), dispatcher } as never) as unknown as Promise<Response>;
	}) as FetchFunction;
}

function defaultDispatcherFactory(proxy: ProxyConfig): Dispatcher {
	if (proxy.type === 4) {
		throw new Error("SOCKS4 proxies are declared in the config but not supported; use type 5");
	}
	return socksDispatcher({
		type: 5,
		host: proxy.host,
		port: proxy.port,
		...(proxy.username || proxy.password ? { userId: proxy.username ?? "", password: proxy.password ?? "" } : {}),
	});
}
