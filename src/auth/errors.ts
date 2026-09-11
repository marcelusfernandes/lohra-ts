export class SubscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionError";
  }
}

// Narrower than SubscriptionError (`instanceof SubscriptionError` still
// holds): only the refresh-attempt-failed branch of resolveCredentials
// throws this. Chat's own catch (issue #351) needs to tell "the OAuth
// refresh POST itself failed" apart from every other SubscriptionError
// (not logged in, ToS not acknowledged, expired Codex token) that don't
// touch the network and so don't have the double-attempt/masking bug — for
// those, falling back to runChatBoundary stays byte-identical, which
// tests/auth-cli.test.ts already pins.
export class RefreshFailedError extends SubscriptionError {
  constructor(message: string) {
    super(message);
    this.name = "RefreshFailedError";
  }
}

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}
