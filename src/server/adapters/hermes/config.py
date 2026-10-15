"""Validated config snapshots. Stock loaders are never called for authority."""
import copy
import hashlib
import os
import sys
from pathlib import Path
from windows import Object, protected


def yaml_config(data):
    import yaml
    class Strict(yaml.SafeLoader):
        def construct_mapping(self, node, deep=False):
            pairs = self.construct_pairs(node, deep=deep)
            keys = [key for key, value in pairs]
            if any(type(key) is not str for key in keys) or len(set(keys)) != len(keys):
                raise ValueError("Ambiguous YAML")
            return dict(pairs)
    text = data.decode("utf-8-sig")
    if any(isinstance(token, yaml.tokens.AliasToken) for token in yaml.scan(text)):
        raise ValueError("YAML aliases unsupported")
    value = yaml.load(text, Loader=Strict)
    if value is None and not text.strip():
        return {}
    if type(value) is not dict:
        raise ValueError("Invalid YAML")
    return value


def validate_config(policy):
    config = policy["config"]
    fixed = {
        "auth": {"adopt_external_logins": False}, "nous": {"guest": False},
        "updates": {"check": False},
        "auxiliary": {"background_review": {"enabled": False},
                      "title_generation": {"enabled": False, "model_upgrade_enabled": False}},
        "agent": {"api_max_retries": 1, "auto_recovery_cycles": 0},
        "compression": {"enabled": False},
        "streaming": {"enabled": False}, "approvals": {"mode": "deny", "single_query_mode": "deny"},
        "terminal": {"backend": "local", "cwd": policy["scratch"], "shell_init_files": [], "auto_source_bashrc": False},
        "platform_toolsets": {"cli": ["file", "skills"] if policy["tools"] else []},
        "memory": {"memory_enabled": False, "user_profile_enabled": False},
        "session": {"auto_title": False}, "plugins": {"enabled": []},
        "hooks": {"outbound": []}, "mcp_servers": {}, "fallback_model": None,
    }
    if (type(config) is not dict or set(config) != set(fixed) | {"model", "providers"} or
            any(config.get(key) != value for key, value in fixed.items()) or policy.get("web") is not False):
        raise ValueError("Unsafe generated config")
    providers, model = config["providers"], config["model"]
    if type(providers) is not dict or len(providers) != 1 or type(model) is not dict:
        raise ValueError("Ambiguous route")
    name, route = next(iter(providers.items()))
    if (type(route) is not dict or set(route) != {"base_url", "key_env", "api_mode", "models"} or
            route["api_mode"] != "chat_completions" or type(route["models"]) is not list or len(route["models"]) != 1 or
            type(route["models"][0]) is not str or route["models"][0].lower().startswith(("moa:", "virtual:")) or
            model != {"default": route["models"][0], "provider": "custom:" + name, "base_url": route["base_url"]}):
        raise ValueError("Unsafe route")


def same_subset(value, expected):
    if type(value) is dict and type(expected) is dict:
        return all(k in expected and same_subset(v, expected[k]) for k, v in value.items())
    return type(value) is type(expected) and value == expected


class Snapshot:
    def __init__(self, policy):
        validate_config(policy)
        self.policy = copy.deepcopy(policy)
        self.files = {}
        self.managed = Path(policy["managed"])
        if str(Path(os.environ["HERMES_MANAGED_DIR"]).resolve()) != str(self.managed):
            raise ValueError("Managed identity changed")
        self.managed_identity = self.directory_identity(self.managed)
        if policy.get("configInput") is not None:
            file = Path(policy["home"]) / "config.yaml"
            self.capture(file, protected_file=True)
            identity, digest = self.files[str(file)]
            if {"identity": list(identity), "hash": digest} != policy["configInput"]:
                raise ValueError("Selected config changed")
        self.capture(Path(policy["source"]) / ".env", empty=True, protected_file=True)
        self.capture(Path(policy["root"]) / "hermes-agent/.env", empty=True, protected_file=True)
        self.capture(self.managed / ".env", empty=True, protected_file=True)
        managed_bytes = self.capture(self.managed / "config.yaml", protected_file=True)
        shadow = self.capture(Path(os.environ["HERMES_HOME"]) / "config.yaml")
        self.capture(Path(os.environ["HERMES_HOME"]) / ".env", empty=True)
        config = yaml_config(shadow)
        if type(config) is not dict or config != policy["config"]:
            raise ValueError("Shadow policy changed")
        overlay = yaml_config(managed_bytes) if managed_bytes is not None else {}
        if type(overlay) is not dict or not same_subset(overlay, config):
            raise ValueError("Managed policy conflict")
        self.raw = copy.deepcopy(config)
        self.overlay = copy.deepcopy(overlay)

    @staticmethod
    def directory_identity(path):
        if not os.path.lexists(path):
            return None
        protected(path, directory=True)
        with Object(path) as obj:
            return obj.identity

    def capture(self, path, empty=False, protected_file=False):
        if not os.path.lexists(path):
            self.files[str(path)] = None
            return None
        if protected_file:
            protected(path, directory=False)
        with Object(path, read=True) as obj:
            data = obj.bytes(1024 * 1024)
            identity = obj.identity
        if empty and data != b"":
            raise ValueError("Dotenv conflict")
        self.files[str(path)] = (identity, hashlib.sha256(data).hexdigest())
        return data

    def check(self):
        if self.directory_identity(self.managed) != self.managed_identity:
            raise ValueError("Managed identity changed")
        for name, expected in self.files.items():
            if expected is None:
                if os.path.lexists(name):
                    raise ValueError("Input appeared")
                continue
            with Object(name, read=True) as obj:
                data = obj.bytes(1024 * 1024)
                if (obj.identity, hashlib.sha256(data).hexdigest()) != expected:
                    raise ValueError("Input changed")

    def bind(self, stop):
        import hermes_cli.managed_scope as ms
        import hermes_cli.config as hc
        import hermes_cli.config_effective as ce
        import hermes_cli.env_loader as el
        import hermes_cli.cli_config_load as cli_config
        import agent.secret_scope as secret_scope
        import agent.skill_utils as skill_utils
        merged = hc._deep_merge(copy.deepcopy(hc.DEFAULT_CONFIG), copy.deepcopy(self.raw))
        # Native defaults include enabled MoA presets even when the user layer omits MoA.
        merged.pop("moa", None)
        latest = hc._coerce_config_version(hc.DEFAULT_CONFIG.get("_config_version", 1)) or 1
        stamp = hc._coerce_config_version(self.raw.get("_config_version"))
        slots = []

        def getter(value):
            def read(*args, **kwargs):
                try:
                    self.check()
                    for obj, name, fn in slots:
                        if getattr(obj, name, None) is not fn:
                            stop()
                except Exception:
                    stop()
                return copy.deepcopy(value)
            return read

        for obj, name, value in ((ms, "load_managed_config", self.overlay),
                                 (ms, "load_managed_env", {}),
                                 (ce, "load_user_config_effective", self.raw),
                                 (hc, "read_user_config_raw", self.raw),
                                 (hc, "read_raw_config", self.raw),
                                 (hc, "read_raw_config_readonly", self.raw),
                                 (hc, "_read_raw_config_impl", self.raw),
                                 (hc, "load_config", merged),
                                 (hc, "load_config_readonly", merged),
                                 (hc, "_load_config_impl", merged),
                                 (hc, "load_env", {}),
                                 (skill_utils, "_load_raw_config", self.raw),
                                 (hc, "require_readable_config_before_write", self.raw),
                                 (hc, "require_parseable_user_config", None),
                                 (hc, "_read_config_version_stamp", (stamp, latest)),
                                 (hc, "check_config_version", (0 if stamp is None else stamp, latest)),
                                 (el, "load_hermes_dotenv", []),
                                 (el, "_apply_managed_env", None),
                                 (el, "_load_secrets_config", {})):
            if not callable(getattr(obj, name, None)):
                stop()
            fn = getter(value)
            setattr(obj, name, fn)
            slots.append((obj, name, fn))

        raw = getter(self.raw)
        empty_env = getter({})

        def load_cli_config():
            cli = sys.modules.get("cli")
            if cli is not None and not any(obj is cli for obj, name, fn in slots):
                if getattr(cli, "load_cli_config", None) is not load_cli_config:
                    stop()
                slots.append((cli, "load_cli_config", load_cli_config))
            file_config = hc._normalize_root_model_keys(raw())
            defaults = cli_config._cli_config_defaults()
            cli_config._merge_file_config(defaults, file_config)
            defaults = hc._expand_env_vars(defaults)
            defaults = ms.apply_managed_overlay(defaults)
            if defaults.get("moa"):
                stop()
            cli_config._mirror_config_to_env(defaults, "terminal" in file_config)
            return defaults

        def load_env_file(env_path):
            value = empty_env()
            if str(Path(env_path).resolve()) not in self.files or Path(env_path).name != ".env":
                stop()
            return value

        def env_value(key):
            empty_env()
            return hc._scoped_environ_get(key)

        for obj, name, fn in ((cli_config, "load_cli_config", load_cli_config),
                              (secret_scope, "load_env_file", load_env_file),
                              (hc, "get_env_value", env_value),
                              (hc, "get_env_value_prefer_dotenv", env_value)):
            if not callable(getattr(obj, name, None)):
                stop()
            setattr(obj, name, fn)
            slots.append((obj, name, fn))
        return slots

    def bind_main(self, slots, stop):
        import hermes_cli.main as main
        load_env = next(fn for obj, name, fn in slots if name == "load_env")
        def dotenv_has_provider_key(*args, **kwargs):
            load_env()
            return False
        if not callable(getattr(main, "_dotenv_has_provider_key", None)):
            stop()
        main._dotenv_has_provider_key = dotenv_has_provider_key
        slots.append((main, "_dotenv_has_provider_key", dotenv_has_provider_key))
