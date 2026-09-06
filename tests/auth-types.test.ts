import { describe, expect, it } from "vitest";

import { CodexTokens, OAuthTokens, SubscriptionCredentials } from "../src/auth/types.js";

describe("auth/types toString citation", () => {
  it("cites a null account_id as JSON null on OAuthTokens", () => {
    const tokens = new OAuthTokens("access", "refresh", null, 0);
    expect(tokens.toString()).toBe(
      "OAuthTokens(access_token=***, refresh_token=***, account_id=null)",
    );
  });

  it("cites a string account_id as a JSON string on CodexTokens", () => {
    const tokens = new CodexTokens("access", "refresh", "acc-1");
    expect(tokens.toString()).toBe(
      'CodexTokens(access_token=***, refresh_token=***, account_id="acc-1")',
    );
  });

  it("cites a null account_id and the base_url as JSON on SubscriptionCredentials", () => {
    const creds = new SubscriptionCredentials("token", null);
    expect(creds.toString()).toBe(
      'SubscriptionCreds(token=***, account_id=null, base_url="https://chatgpt.com/backend-api/codex")',
    );
  });
});
