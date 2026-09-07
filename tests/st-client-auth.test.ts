import { afterEach, describe, expect, it, vi } from "vitest";

import { StClient } from "../src/infra/st/st-client";

describe("StClient Basic Auth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds the configured Authorization header to the CSRF request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ token: "csrf-token" }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "session=test; Path=/; HttpOnly",
        },
      },
    ));
    const client = new StClient({
      baseUrl: "http://127.0.0.1:8000",
      hostHeader: null,
      authorizationHeader: "Basic dXNlcjpwYXNz",
      timeoutMs: 1000,
      generateTimeoutMs: 1000,
      generateIdleTimeoutMs: 1000,
    });

    await (client as any).ensureSession();

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:8000/csrf-token"),
      expect.objectContaining({
        headers: { Authorization: "Basic dXNlcjpwYXNz" },
      }),
    );
  });
});
