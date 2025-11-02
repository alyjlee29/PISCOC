import { QueryClient, QueryFunction } from "@tanstack/react-query";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

type JsonLike = Record<string, unknown> | unknown[] | string | number | boolean | null;

function isBodyInit(data: unknown): data is BodyInit {
  return (
    typeof Blob !== "undefined" && data instanceof Blob ||
    typeof ArrayBuffer !== "undefined" && (data instanceof ArrayBuffer || ArrayBuffer.isView(data as ArrayBufferView)) ||
    typeof FormData !== "undefined" && data instanceof FormData ||
    typeof URLSearchParams !== "undefined" && data instanceof URLSearchParams ||
    typeof ReadableStream !== "undefined" && data instanceof ReadableStream ||
    typeof data === "string"
  );
}

export async function apiRequest(
  method: string,
  url: string,
  data?: JsonLike | BodyInit,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  let body: BodyInit | undefined;

  if (data !== undefined) {
    if (isBodyInit(data)) {
      body = data;
    } else {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(data);
    }
  } else if (init?.body) {
    body = init.body as BodyInit;
  }

  const res = await fetch(url, {
    method,
    credentials: "include",
    ...init,
    headers,
    body,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey[0] as string, {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
