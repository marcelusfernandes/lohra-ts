#!/usr/bin/env python3
from __future__ import annotations
import base64, json, os, stat, sys
from pathlib import Path
from contextlib import redirect_stdout, redirect_stderr
from io import StringIO

HOME=Path(os.environ["LOHRA_HOME"]); CODEX=Path(os.environ["CODEX_HOME"])
def emit(value): sys.stdout.write(json.dumps(value, ensure_ascii=True, sort_keys=True)+"\n")
def jwt(payload):
    encoded=base64.urlsafe_b64encode(json.dumps(payload,separators=(",",":")).encode()).decode().rstrip("=")
    return f"x.{encoded}.x"
def permissions(path): return format(stat.S_IMODE(path.stat().st_mode), "04o")
def config_json(value):
    return None if value is None else {"auth_mode":value.auth_mode,"acknowledged_tos_risk":value.acknowledged_tos_risk,"preference":value.preference}

def store_merge():
    from lohra.subscription.store import SubscriptionConfig, read_config, write_config
    from lohra.subscription.token_store import OAuthTokens, read_tokens, write_tokens
    write_config(HOME, SubscriptionConfig("subscription",True,"auto"))
    write_tokens(HOME, OAuthTokens("DUMMY-ACCESS-T05","DUMMY-REFRESH-T05","ACCT-T05-DUMMY",1300.0))
    auth=json.loads((HOME/"auth.json").read_text()); tokens=read_tokens(HOME)
    emit({"config":config_json(read_config(HOME)),"neighbor":auth["neighbor"],"future":auth["openai"]["future"],"authMode":permissions(HOME/"auth.json"),"oauthMode":permissions(HOME/"oauth.json"),"oauth":{"accountId":tokens.account_id,"expiresAt":tokens.expires_at,"redacted":repr(tokens)},"temporary":[p.name for p in HOME.iterdir() if ".tmp" in p.name]})

def route_table():
    from lohra import cli
    from lohra.subscription.credentials import route_for
    rows=[]
    for preference in ["auto","typo","api_key","subscription"]:
        for active in [False,True]:
            route=route_for(preference,active); row={"preference":preference,"active":active,"mode":route.mode}
            if route.note is not None: row["note"]=route.note
            if route.error is not None: row["error"]=route.error
            rows.append(row)
    stdout=StringIO(); stderr=StringIO()
    with redirect_stdout(stdout), redirect_stderr(stderr): code=cli.main(["auth", "prefer", "AUTO"])
    emit({"invalidCase":{"code":code,"stdout":stdout.getvalue(),"stderr":stderr.getvalue()},"rows":rows})

def credentials_resolution():
    from lohra.subscription.store import SubscriptionConfig, write_config
    from lohra.subscription.token_store import OAuthTokens, read_tokens, write_tokens
    from lohra.subscription.credentials import resolve
    from lohra.subscription.refresh import is_expired
    write_config(HOME,SubscriptionConfig("subscription",True,"auto")); write_tokens(HOME,OAuthTokens("OWN-ACCESS-T05","OWN-REFRESH-T05","ACCT-OWN-DUMMY",1301))
    fresh=resolve(HOME, now=1000)
    write_tokens(HOME,OAuthTokens("OLD-ACCESS-T05","OLD-REFRESH-T05","ACCT-OWN-DUMMY",1300)); calls=[]
    def post(url, body): calls.append({"url":url,"keys":sorted(body)}); return (200,{"access_token":"NEW-ACCESS-T05","refresh_token":"NEW-REFRESH-T05","expires_in":3600})
    refreshed=resolve(HOME,now=1000,post=post)
    emit({"fresh":{"accountId":fresh.account_id,"baseUrl":fresh.base_url,"headers":fresh.headers},"refreshed":{"accountId":refreshed.account_id,"persisted":read_tokens(HOME).refresh_token=="NEW-REFRESH-T05"},"calls":calls,"boundary":{"at300":is_expired(jwt({"exp":1300}),now=1000),"at301":is_expired(jwt({"exp":1301}),now=1000)}})

def oauth_device_flow():
    from lohra.subscription.oauth import start_device_login,poll_for_tokens,refresh_tokens
    replies=[(200,{"device_auth_id":"DEVICE","user_code":"USERCODE","interval":0}),(403,{}),(200,{"authorization_code":"CODE","code_verifier":"VERIFIER"}),(200,{"access_token":jwt({"chatgpt_account_id":"ACCT-T05-DUMMY"}),"refresh_token":"REFRESH-T05","expires_in":3600})]; calls=[]
    def post(url,body): calls.append({"url":url,"keys":sorted(body)}); return replies.pop(0)
    device=start_device_login(post=post); ticks=iter(range(100)); tokens=poll_for_tokens(device,post=post,sleep=lambda _s:None,now=lambda:next(ticks))
    try: refresh_tokens("R", post=lambda _u,_b:{"status":200}); mismatch=""
    except Exception: mismatch="POST_SEAM_MISMATCH: oauth.post must return [status, body]"
    from lohra import cli
    from lohra.subscription import oauth as oauth_module
    handler_calls=[]; handler_replies=[(200,{"device_auth_id":"DEVICE","user_code":"USERCODE","interval":0}),(200,{"authorization_code":"CODE","code_verifier":"VERIFIER"}),(200,{"access_token":jwt({"chatgpt_account_id":"ACCT-T05-DUMMY"}),"refresh_token":"REFRESH-T05","expires_in":3600})]
    def handler_post(url,body): handler_calls.append({"url":url,"keys":sorted(body)}); return handler_replies.pop(0)
    previous=oauth_module.default_post; oauth_module.default_post=handler_post; stdout=StringIO(); stderr=StringIO()
    try:
        with redirect_stdout(stdout), redirect_stderr(stderr): code=cli.run_auth("login",assume_yes=True)
    finally: oauth_module.default_post=previous
    from lohra.subscription.store import read_config
    from lohra.subscription.token_store import read_tokens
    emit({"device":{"deviceAuthId":device.device_auth_id,"userCode":device.user_code,"interval":device.interval,"verifyUrl":device.verify_url},"calls":calls,"accountId":tokens.account_id,"redacted":repr(tokens),"mismatch":mismatch,"handler":{"code":code,"stdout":stdout.getvalue(),"stderr":stderr.getvalue(),"active":read_config(HOME).acknowledged_tos_risk is True,"own":read_tokens(HOME) is not None,"requests":len(handler_calls)}})

def jwt_redaction(mutant=False):
    from lohra.subscription.oauth import _account_id as account_id_from_token
    from lohra.subscription.refresh import is_expired
    from lohra.subscription.token_store import OAuthTokens
    from lohra.subscription.codex_creds import CodexTokens
    from lohra.subscription.credentials import SubscriptionCreds
    emit({"boundary":{"at299":is_expired(jwt({"exp":1299}),now=1000),"at300":False if mutant else is_expired(jwt({"exp":1300}),now=1000),"at301":is_expired(jwt({"exp":1301}),now=1000)},"accountIds":[account_id_from_token(jwt({"chatgpt_account_id":"ACCT-TOP"})),account_id_from_token(jwt({"https://api.openai.com/auth":{"chatgpt_account_id":"ACCT-NESTED"}})),account_id_from_token(jwt({"organizations":[{"id":"ACCT-ORG"}]}))],"repr":[repr(OAuthTokens("SECRET-A","SECRET-R","ACCT-T05-DUMMY",1)),repr(CodexTokens("SECRET-A","SECRET-R","ACCT-T05-DUMMY")),repr(SubscriptionCreds("SECRET-A","ACCT-T05-DUMMY","https://chatgpt.com/backend-api/codex",{}))]})

def profile_isolation():
    from lohra.subscription.store import read_config
    from lohra.subscription.token_store import read_tokens
    values={}
    for name,path in [("default",HOME),("p1",HOME/"profiles"/"p1"),("p2",HOME/"profiles"/"p2")]: values[name]={"config":config_json(read_config(path)),"own":read_tokens(path) is not None}
    values["codex"]={"exists":(CODEX/"auth.json").exists()}; emit(values)

mode=sys.argv[1]
if mode=="store-merge-hardening": store_merge()
elif mode=="route-table": route_table()
elif mode=="credentials-resolution": credentials_resolution()
elif mode=="oauth-device-flow": oauth_device_flow()
elif mode=="jwt-redaction": jwt_redaction()
elif mode=="expiry-mutant": jwt_redaction(True)
elif mode=="profile-isolation": profile_isolation()
else: raise SystemExit(f"unknown auth mode {mode}")
