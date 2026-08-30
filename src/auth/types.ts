export type AuthPreference = "auto" | "subscription" | "api_key";
export type AuthMode = string;

export interface SubscriptionConfig {
  readonly authMode: AuthMode;
  readonly acknowledgedTosRisk: boolean;
  readonly preference: AuthPreference;
}

export interface OAuthTokensValue {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accountId: string | null;
  readonly expiresAt: number;
}

export class OAuthTokens implements OAuthTokensValue {
  constructor(
    readonly accessToken: string,
    readonly refreshToken: string,
    readonly accountId: string | null,
    readonly expiresAt: number,
  ) {}
  toString(): string {
    return `OAuthTokens(access_token=***, refresh_token=***, account_id=${repr(this.accountId)})`;
  }
}

export class CodexTokens {
  constructor(
    readonly accessToken: string,
    readonly refreshToken: string,
    readonly accountId: string | null,
  ) {}
  toString(): string {
    return `CodexTokens(access_token=***, refresh_token=***, account_id=${repr(this.accountId)})`;
  }
}

export class SubscriptionCredentials {
  readonly baseUrl = "https://chatgpt.com/backend-api/codex";
  readonly headers: Readonly<Record<string, string>>;
  constructor(
    readonly token: string,
    readonly accountId: string | null,
  ) {
    this.headers = Object.freeze({
      originator: "codex_cli_rs",
      ...(accountId ? { "ChatGPT-Account-ID": accountId } : {}),
    });
  }
  toString(): string {
    return `SubscriptionCreds(token=***, account_id=${repr(this.accountId)}, base_url='${this.baseUrl}')`;
  }
}

export interface AuthRoute {
  readonly mode: "subscription" | "api_key";
  readonly note?: string;
  readonly error?: string;
}

const repr = (value: string | null): string => (value === null ? "None" : `'${value}'`);
