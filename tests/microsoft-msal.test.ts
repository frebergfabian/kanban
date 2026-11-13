import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import {
  ConfidentialClientApplication,
  type Configuration,
  type INetworkModule,
  type NetworkRequestOptions,
} from "@azure/msal-node";
import { Store } from "../server/store.js";
import { CalendarService } from "../server/calendar.js";

const config = {
  clientId: "11111111-1111-4111-8111-111111111111",
  clientSecret: "synthetic-secret-never-log",
  tenant: "common",
  redirectUri: "https://kanban.test/api/microsoft/callback",
};
const tenant = "22222222-2222-4222-8222-222222222222";
const user = "33333333-3333-4333-8333-333333333333";
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

test("real MSAL code exchange binds the original nonce, rejects missing/wrong nonce and logs only safe failure metadata", async () => {
  for (const mode of ["valid", "missing_expected_nonce", "wrong_token_nonce", "invalid_client"] as const) {
    const store = new Store(":memory:");
    const audit: { event: string; detail: Record<string, unknown> }[] = [];
    let nonce = "", challenge = "", profileReads = 0;
    // The real SDK runs nonce validation and encrypted cache callbacks. Only HTTP
    // responses are synthetic, so a permissive acquireTokenByCode stub cannot mask regressions.
    const network: INetworkModule = {
      async sendGetRequestAsync<T>() {
        throw new Error("Unexpected metadata request: authority metadata is supplied locally");
      },
      async sendPostRequestAsync<T>(_url: string, options?: NetworkRequestOptions) {
        const body = new URLSearchParams(options?.body);
        assert.equal(body.get("grant_type"), "authorization_code");
        assert.equal(body.get("client_secret"), config.clientSecret);
        assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), challenge);
        const now = Math.floor(Date.now() / 1000);
        const response = mode === "invalid_client" ? {
          error: "invalid_client",
          error_codes: [7000215],
          error_description: "Private provider detail: synthetic-secret-never-log authorization-code user@example.test",
        } : {
          token_type: "Bearer", expires_in: 3600,
          scope: "Mail.Read Calendars.Read User.Read",
          access_token: "synthetic-access-token",
          refresh_token: "synthetic-refresh-token",
          client_info: encode({ uid: user, utid: tenant }),
          id_token: [encode({ alg: "RS256", typ: "JWT" }), encode({
            iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
            aud: config.clientId, tid: tenant, oid: user, sub: user,
            iat: now, nbf: now, exp: now + 3600,
            preferred_username: "user@example.test", name: "Synthetic User",
            nonce: mode === "wrong_token_nonce" ? "wrong-nonce" : nonce,
          }), "synthetic-signature"].join("."),
        };
        return { status: mode === "invalid_client" ? 400 : 200, headers: {}, body: response as T };
      },
    };
    const factory = (configuration: Configuration) => {
      const client = new ConfidentialClientApplication({
        ...configuration,
        auth: {
          ...configuration.auth,
          cloudDiscoveryMetadata: JSON.stringify({ metadata: [{
            preferred_network: "login.microsoftonline.com",
            preferred_cache: "login.windows.net",
            aliases: ["login.microsoftonline.com", "login.windows.net"],
          }] }),
          authorityMetadata: JSON.stringify({
            authorization_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            token_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            end_session_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/logout",
            issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
            jwks_uri: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
          }),
        },
        system: { ...configuration.system, networkClient: network },
      });
      if (mode === "missing_expected_nonce") {
        const acquire = client.acquireTokenByCode.bind(client);
        client.acquireTokenByCode = (request) => acquire({ ...request, nonce: undefined });
      }
      return client;
    };
    const service = new CalendarService(store, {
      key: randomBytes(32), microsoft: config, clientFactory: factory,
      request: (async (_url, init) => {
        assert.equal(init?.method, "GET");
        profileReads++;
        return Response.json({ displayName: "Synthetic User" });
      }) as typeof fetch,
    }, (event, detail) => audit.push({ event, detail }));
    try {
      const url = new URL(await service.beginMicrosoft("browser-session"));
      nonce = url.searchParams.get("nonce")!;
      challenge = url.searchParams.get("code_challenge")!;
      assert.ok(nonce && challenge);
      const finish = service.finishMicrosoft(url.searchParams.get("state")!, "browser-session", "authorization-code");
      if (mode === "valid") {
        await finish;
        assert.equal(service.accounts()[0].connected, true);
        assert.equal(profileReads, 1);
        const rows = JSON.stringify(store.db.prepare("SELECT * FROM calendar_accounts").all());
        assert.ok(!rows.includes("synthetic-refresh-token"));
        assert.ok(!rows.includes("synthetic-access-token"));
      } else {
        await assert.rejects(finish, /Microsoft-inloggningen misslyckades/);
        assert.equal(service.accounts().length, 0);
        assert.equal(profileReads, 0);
        assert.deepEqual(audit, [{ event: "microsoft.login_failed", detail: {
          stage: "token_exchange",
          code: mode === "invalid_client" ? "invalid_client" : "nonce_mismatch",
          ...(mode === "invalid_client" ? { aadsts_code: "7000215" } : {}),
        } }]);
      }
      for (const privateValue of [nonce, config.clientSecret, "synthetic-access-token", "synthetic-refresh-token", "authorization-code", "user@example.test"])
        assert.ok(!JSON.stringify(audit).includes(privateValue));
    } finally {
      service.close(); store.close();
    }
  }
});
