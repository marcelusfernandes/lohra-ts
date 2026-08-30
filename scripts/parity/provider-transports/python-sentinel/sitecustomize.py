from __future__ import annotations

import os
from dataclasses import replace

url = os.environ.get("LOHRA_T10_LOOPBACK")
if url:
    import lohra.providers.base as base
    import lohra.providers  # registers builtins

    for name, profile in list(base._REGISTRY.items()):
        suffix = "/v1" if profile.api_mode == "chat_completions" else ""
        base._REGISTRY[name] = replace(profile, base_url=url.rstrip("/") + suffix)

    import lohra.subscription.provider as subscription_provider
    from lohra.agent.client import ResponsesClient
    from lohra.subscription.credentials import SubscriptionError, resolve

    def build_subscription_client(home, *, now=None):
        creds = resolve(home, now=now)
        if creds is None:
            raise SubscriptionError("subscription mode is not active")
        return ResponsesClient(
            api_key=creds.token,
            base_url=url,
            default_headers=creds.headers,
        )

    subscription_provider.build_subscription_client = build_subscription_client
