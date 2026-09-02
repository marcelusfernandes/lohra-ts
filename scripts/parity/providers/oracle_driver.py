#!/usr/bin/env python3
from __future__ import annotations
import json, os, sys
from pathlib import Path

def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=True, sort_keys=True)+"\n")

def registry_resolution():
    from lohra.providers import list_providers, resolve_provider_name
    profiles=[]
    for p in list_providers():
        profiles.append({"name":p.name,"apiMode":p.api_mode,"aliases":list(p.aliases),"envVars":list(p.env_vars),"baseUrl":p.base_url,"fallbackModels":list(p.fallback_models),"maxTokens":p.default_max_tokens,"aux":p.default_aux_model,"vision":p.supports_vision,"requiresKey":p.requires_api_key})
    matrix={
      "arg":resolve_provider_name(" google ","or",{"LOHRA_PROVIDER":"oai","ANTHROPIC_API_KEY":"x"}),
      "config":resolve_provider_name(" ","or",{"LOHRA_PROVIDER":"oai","ANTHROPIC_API_KEY":"x"}),
      "env":resolve_provider_name(None,None,{"LOHRA_PROVIDER":"oai","ANTHROPIC_API_KEY":"x"}),
      "key":resolve_provider_name(None,None,{"ANTHROPIC_API_KEY":"x","OPENAI_API_KEY":"x"}),
      "spaceKey":resolve_provider_name(None,None,{"ANTHROPIC_API_KEY":"   ","OPENAI_API_KEY":"x"}),
      "auto":resolve_provider_name(None,None,{})}
    emit({"profiles":profiles,"matrix":matrix})

def dotenv_profile():
    from lohra.config.env_file import apply_env_file
    path=Path(os.environ["LOHRA_HOME"])/".env"
    env={"OPENAI_API_KEY":"REAL_SENTINEL"}; applied=apply_env_file(path,environ=env)
    emit({"applied":applied,"openai":"real" if env.get("OPENAI_API_KEY")=="REAL_SENTINEL" else "file","groq":"present" if env.get("GROQ_API_KEY") else "missing","pathScope":"base"})

class Response:
    def __init__(self,status,payload): self.status_code=status; self.payload=payload
    def __enter__(self): return self
    def __exit__(self,*_): return False
    def iter_bytes(self): yield self.payload
_ALLOWED_HEADERS={"accept-encoding","authorization","x-api-key","anthropic-version"}
class Client:
    def __init__(self,status,payload,error=False): self.status=status; self.payload=payload; self.error=error; self.request=None
    def stream(self,method,url,headers):
        names=[k.lower() for k in headers]
        unclassified=sorted(k for k in names if k not in _ALLOWED_HEADERS)
        if unclassified: raise RuntimeError("REQUEST_HEADER_UNCLASSIFIED")
        self.request={"method":method,"url":url,"identity":headers.get("Accept-Encoding"),"auth":sorted(k for k in names if k in {"authorization","x-api-key","anthropic-version"}),"unclassified":unclassified}
        if self.error: raise TimeoutError("fixture timeout")
        return Response(self.status,self.payload)

def catalog_fixtures():
    from lohra.catalog.catalog import fetch_models
    from lohra.providers import get_provider_profile
    cases=[]
    exact_cap_payload=b'{"data":[]}'+b' '*(4_000_000-len(b'{"data":[]}'))
    fixtures=[
      ("data","openai",200,b'{"data":[{"id":"b"},{"name":"a"}]}',False),
      ("bare","openai",200,b'["bare-a",{"id":"bare-b"}]',False),
      ("duplicate","openai",200,b'{"data":[{"id":"b"},{"id":"b"},{"name":"a"}]}',False),
      ("empty","openai",200,b'{"data":[]}',False),
      ("has-more","openai",200,b'{"data":[{"id":"page-a"}],"has_more":true}',False),
      ("shape","openai",200,b'{}',False),
      ("invalid","openai",200,b'{',False),
      ("exception","openai",200,b'',True),
      ("http","openai",401,b'secret-body-not-projected',False),
      ("at-cap","openai",200,exact_cap_payload,False,"SENTINEL"),
      ("oversized","openai",200,exact_cap_payload+b' ',False,"SENTINEL"),
      ("headers-anthropic","anthropic",200,b'{"data":[]}',False),
      ("headers-gemini","gemini",200,b'{"data":[]}',False),
      ("headers-empty","openai",200,b'{"data":[]}',False,""),
    ]
    for fixture in fixtures:
        name,provider,status,payload,error,*key=fixture; profile=get_provider_profile(provider); client=Client(status,payload,error=error); entry=fetch_models(profile,api_key=key[0] if key else "SENTINEL",client=client); cases.append({"name":name,"entry":entry.to_dict(),"request":client.request})
    emit(cases)

def pricing(mutant=False):
    from lohra.agent.types import Usage, combine_usage
    from lohra.pricing.estimate import estimate_cost, ModelPrice
    usage=Usage(input_tokens=1000,output_tokens=100,cache_read_tokens=500,cache_write_tokens=200,reasoning_tokens=37)
    openai=estimate_cost(usage,provider="openai",model="gpt-4o-mini")
    anthropic=estimate_cost(usage,provider="anthropic",model="claude-haiku-4-5")
    local=estimate_cost(usage,provider="ollama",model="m")
    override=estimate_cost(Usage(input_tokens=1_000_000),provider="openai",model="gpt-4o-mini",overrides={("openai","gpt-4o-mini"):ModelPrice(input_usd=3,output_usd=4)})
    emit({"combined":combine_usage(Usage(input_tokens=1),Usage(output_tokens=2)).__dict__,"openai":{"usd":openai.usd,"gross":openai.gross_usd,"saved":openai.saved_usd,"basis":openai.basis},"anthropic":{"usd":anthropic.usd,"gross":anthropic.gross_usd},"ollama":{"usd":local.usd,"gross":local.gross_usd,"basis":local.basis},"openrouter":estimate_cost(usage,provider="openrouter",model="m"),"override":{"usd":override.usd,"source":override.source}})

def profile_isolation():
    from lohra.agent.types import Usage
    from lohra.pricing.estimate import estimate_cost
    from lohra.workflow.tiers import load_tiers
    from lohra.pricing.overrides import load_price_overrides
    base=Path(os.environ["LOHRA_HOME"]); out={}
    for name,path in [("default",base),("p1",base/"profiles"/"p1"),("p2",base/"profiles"/"p2")]:
        tiers=load_tiers(path/"workflow_tiers.json"); prices=load_price_overrides(path/"pricing.json"); model=getattr(tiers.get("small"),"model",None); estimate=estimate_cost(Usage(input_tokens=1_000_000),provider="openai",model=model or "missing",overrides=prices); out[name]={"small":model,"priceKeys":sorted(f"{p}/{m}" for p,m in prices),"cost":estimate.usd if estimate else None,"source":estimate.source if estimate else None}
    emit(out)

mode=sys.argv[1]
if mode=="registry-resolution": registry_resolution()
elif mode=="dotenv-profile": dotenv_profile()
elif mode=="catalog-fixtures": catalog_fixtures()
elif mode=="pricing-usage": pricing()
elif mode=="profile-isolation": profile_isolation()
elif mode=="pricing-mutant": pricing()
else: raise SystemExit(f"unknown mode {mode}")
