"""Low-only static YAML candidate inspection. No Hermes entry point or secret output."""
import json
import hashlib
import os
from pathlib import Path
import re
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from windows import Object, low_token, protected


def chat_model(item):
    if type(item) is not dict:
        return True
    if any(item.get(key) is False for key in ("chat", "supports_chat", "chat_completions")):
        return False
    for key in ("mode", "type", "task", "model_type", "api_mode", "transport"):
        if key in item and item[key] not in ("chat", "chat_completions", "text-generation", "text_generation"):
            return False
    # Capabilities and endpoints restrict together: passing one never skips the other.
    capabilities = item.get("capabilities")
    if type(capabilities) is dict and not chat_model(capabilities):
        return False
    if type(capabilities) is list and not any(value in capabilities for value in ("chat", "chat_completions", "text-generation", "text_generation")):
        if any(value in capabilities for value in ("image_generation", "embeddings", "transcription", "speech")):
            return False
    endpoints = item.get("supported_endpoints")
    if type(endpoints) is list:
        return any(value in endpoints for value in ("chat_completions", "/chat/completions", "/v1/chat/completions"))
    return True


def inspect(home, memory_url=None):
    if not low_token():
        raise ValueError("Low required")
    protected(home, directory=True)
    protected(home / "config.yaml", directory=False)
    from config import yaml_config
    with Object(home / "config.yaml", read=True) as obj:
        raw = obj.bytes(1024 * 1024)
        config = yaml_config(raw)
        config_input = {"identity": list(obj.identity), "hash": hashlib.sha256(raw).hexdigest()}
        config_stamp = obj.signature()
    if type(config) is not dict:
        raise ValueError("Invalid config")
    forbidden = ("secret_sources", "key_cmd", "key_command", "api_key_command", "auth_pools")
    if any(config.get(key) for key in forbidden):
        raise ValueError("Unsupported auth")
    providers = config.get("providers", {})
    legacy = config.get("custom_providers", {})
    if type(legacy) is list:
        if any(type(item) is not dict or type(item.get("name")) is not str for item in legacy) or len({item["name"] for item in legacy}) != len(legacy):
            raise ValueError("Ambiguous provider")
        legacy = {item.get("name"): item for item in legacy if type(item) is dict}
    if type(providers) is not dict or type(legacy) is not dict or set(providers) & set(legacy):
        raise ValueError("Ambiguous provider")
    model = config.get("model", {})
    default = model.get("default", "") if type(model) is dict else model if type(model) is str else ""
    routes = []
    cache = {}
    cache_path = home / "provider_models_cache.json"
    if os.path.lexists(cache_path):
        protected(cache_path, directory=False)
        with Object(cache_path, read=True) as obj:
            cache = json.loads(obj.bytes(1024 * 1024))
        if type(cache) is not dict:
            raise ValueError("Invalid picker cache")
    for provider, entry in {**legacy, **providers}.items():
        if type(provider) is not str or not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", provider) or type(entry) is not dict:
            continue
        if entry.get("enabled") is False or any(entry.get(key) for key in ("disabled", "key_cmd", "key_command", "api_key_command", "oauth", "auth", "auth_pool", "auth_pools", "fallback", "fallback_model", "fallback_models", "moa", "virtual", "reference_models", "aggregator", "secret_sources")):
            continue
        endpoint, key = entry.get("base_url"), entry.get("key_env", entry.get("api_key_env"))
        if key is None and type(entry.get("api_key")) is str:
            match = re.fullmatch(r"\$\{([A-Za-z_][A-Za-z0-9_]{0,99})\}", entry["api_key"])
            key = match[1] if match else None
        elif entry.get("api_key"):
            continue
        protocol = entry.get("api_mode", entry.get("transport", "chat_completions"))
        if entry.get("api_mode") and entry.get("transport") and entry["api_mode"] != entry["transport"]:
            continue
        if type(endpoint) is not str or len(endpoint) > 2000 or protocol != "chat_completions" or type(key) is not str or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,99}", key):
            continue
        models = entry.get("models", [])
        if type(models) is dict:
            models = [{**info, "id": name} for name, info in models.items() if type(info) is dict and info.get("id", name) == name]
        if type(models) is not list:
            continue
        selected = (model.get("provider", "") if type(model) is dict else config.get("provider", "")).removeprefix("custom:")
        if selected == provider and type(default) is str and not any((item.get("id") if type(item) is dict else item) == default for item in models):
            models = [*models, default]
        # Picker caches are candidates for this explicit route, never credentials or another endpoint.
        for identity, cached in cache.items():
            if type(identity) is str and identity.startswith("custom:" + endpoint.rstrip("/").lower() + "#") and type(cached) is dict:
                candidates = cached.get("models", [])
                if type(candidates) is list:
                    for item in candidates:
                        name = item.get("id") if type(item) is dict else item
                        if not any((model.get("id") if type(model) is dict else model) == name for model in models):
                            models = [*models, item]
        for item in models[:500]:
            if not chat_model(item):
                continue
            if type(item) is dict and (item.get("enabled") is False or any(item.get(k) for k in ("disabled", "moa", "virtual", "oauth", "models", "reference_models", "aggregator", "fallback", "fallback_model", "fallback_models"))):
                continue
            name = item.get("id") if type(item) is dict else item
            if type(name) is str and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,199}", name) and not name.lower().startswith(("divan/", "moa:", "virtual:")):
                routes.append({"provider": provider, "endpoint": endpoint, "protocol": protocol, "model": name, "keyEnv": key, "default": name == default and selected == provider})
    servers = config.get("mcp_servers", {})
    matches = []
    if type(servers) is dict:
        if memory_url:
            matches = [entry for entry in servers.values() if type(entry) is dict and entry.get("url") == memory_url]
        elif "memory" in servers:
            matches = [servers["memory"]]
    own = matches[0] if len(matches) == 1 else None
    memory = None
    if type(own) is dict and not any(own.get(k) for k in ("command", "env", "oauth", "auth", "secret_sources")):
        headers = own.get("headers", {})
        header = headers.get("Authorization") if type(headers) is dict and set(headers) == {"Authorization"} else None
        match = re.fullmatch(r"Bearer \$\{([A-Za-z_][A-Za-z0-9_]{0,99})\}", header) if type(header) is str else None
        url = own.get("url")
        if match and type(url) is str and url.startswith(("http://", "https://")):
            memory = {"url": own["url"], "headerEnv": match[1]}
    return {"routes": routes, "memory": memory, "memoryRejected": bool(servers) and memory is None, "moaExcluded": bool(config.get("moa")), "configInput": config_input, "configStamp": config_stamp}


if __name__ == "__main__":
    try:
        with Object(sys.argv[1], read=True) as obj:
            policy = json.loads(obj.bytes(4 * 1024 * 1024))
        from install import check_validation
        check_validation(policy)
        print(json.dumps(inspect(Path(policy["home"]), policy.get("memoryUrl"))))
    except Exception:
        print('{"routes":[],"memory":null}')
        raise SystemExit(125)
