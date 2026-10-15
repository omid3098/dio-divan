"""A run-private, version-pinned guard; names alone never authorize handlers."""
import copy
import functools
import json
import threading
import urllib.request
from readers import Readers

MEMORY = {"mcp_memory_" + x for x in ("whoami", "search", "get_page", "list_pages", "recent_changes", "ask")}
T3 = {"mcp_t3_" + x for x in ("t3_thread_read", "t3_thread_search", "t3_thread_list")}
HISTORY = {"mcp_hermes_history_" + x for x in ("hermes_history_search", "hermes_history_read")}
DENIED = json.dumps({"error": "Divan guard denied"})
CALLBACK_CONTAINERS = ("_plugins", "_hooks", "_middleware", "_cli_commands", "_plugin_commands",
                       "_memory_hook_registrations", "_approval_transports", "_plugin_loaded_listeners",
                       "_subscriptions", "_system_prompt_sections", "_slack_action_handlers",
                       "_platform_handler_factories", "_aux_tasks", "_ownership_ledger",
                       "_registration_order", "_persistent_carryover", "_hook_running_callbacks",
                       "_hook_abandoned")
CALLBACK_VALUES = ("_context_engine", "_gateway_message_injector", "_tui_message_injector")


def close_plugins(plugins, stop):
    """No external callback is admitted, even when registered by trusted-looking code."""
    def refuse(*args, **kwargs):
        stop()
    slots = []
    def bind(obj, name, fn):
        if not callable(getattr(obj, name, None)):
            stop()
        setattr(obj, name, fn)
        slots.append((obj, name, fn))
    for name in vars(plugins.PluginContext):
        if name.startswith("register_") or name in {"subscribe", "on_unload", "spawn_task"}:
            bind(plugins.PluginContext, name, refuse)
    for name in ("discover_and_load", "_scan_entry_points"):
        bind(plugins.PluginManager, name, lambda *args, **kwargs: [])
    for name in ("register_approval_transport", "on_plugin_loaded", "_subscribe_event",
                 "_track_registration", "_track_scoped_registration", "_register_fallback_hook",
                 "set_gateway_message_injector", "set_tui_message_injector",
                 "_invoke_hook_callback", "_run_hook_callback_bounded"):
        bind(plugins.PluginManager, name, refuse)
    manager = plugins.get_plugin_manager()
    manager._discovered = True
    def check():
        if plugins.get_plugin_manager() is not manager:
            stop()
        for name in CALLBACK_CONTAINERS:
            if getattr(manager, name):
                stop()
        if (any(getattr(manager, name) is not None for name in CALLBACK_VALUES) or
                manager._event_worker is not None or not manager._event_queue.empty() or
                any(manager._event_pending_by_generation.values())):
            stop()
        for obj, name, fn in slots:
            if getattr(obj, name, None) is not fn:
                stop()
    def empty(value):
        def deliver(*args, **kwargs):
            check()
            return copy.deepcopy(value)
        return deliver
    for name, value in (("_dispatch_event", 0), ("_deliver_event", None), ("_notify_plugin_loaded", None),
                        ("invoke_hook", []), ("invoke_middleware", []), ("iter_hook_callbacks", ()),
                        ("render_system_prompt_sections", []), ("inject_gateway_message", False),
                        ("inject_tui_message", False)):
        bind(plugins.PluginManager, name, empty(value))
    async def empty_async(*args, **kwargs):
        check()
        return []
    bind(plugins.PluginManager, "ainvoke_hook", empty_async)
    def delivery_manager():
        check()
        return manager
    bind(plugins, "_delivery_manager", delivery_manager)
    check()
    return manager, check


def install(policy, check, stop, services=None):
    import agent.tool_executor as te
    import agent.conversation_loop as loop
    import agent.turn_api_request as request_module
    import agent.auxiliary_client as auxiliary
    import agent.moa_loop as moa
    import httpx
    import hermes_cli.plugins as plugins
    from tools.registry import registry
    from run_agent import AIAgent

    lock = threading.RLock()
    readers = Readers(policy)
    manager, check_plugins = close_plugins(plugins, stop)
    allowed = {"read_file", "search_files", "skill_view"} if policy["tools"] else set()
    services = services or {}
    for name, binding in services.items():
        if name in MEMORY and policy["memory"] or name in T3 | HISTORY and policy["tools"]:
            allowed.add(name)
        else:
            stop()
        if type(binding) is not tuple or len(binding) != 3 or not callable(binding[0]):
            stop()
    own = {"read_file": readers.read, "search_files": readers.search, "skill_view": readers.skill}
    signatures = {
        "read_file": {"path": {"type": "string"}, "offset": {"type": "integer", "minimum": 1}, "limit": {"type": "integer", "minimum": 1, "maximum": 2000}},
        "search_files": {"path": {"type": "string"}, "pattern": {"type": "string"}, "target": {"type": "string", "enum": ["files", "content"]}, "limit": {"type": "integer", "minimum": 1, "maximum": 100}},
        "skill_view": {"name": {"type": "string"}, "file_path": {"type": "string"}},
    }
    for name, handler in own.items():
        registry.register(name=name, toolset="skills" if name == "skill_view" else "file",
                          schema={"name": name, "description": "Read local text only; literal searches. Bounded results report truncation. No shell or templates.",
                                  "parameters": {"type": "object", "properties": signatures[name], "additionalProperties": False,
                                                 "required": ["pattern" if name == "search_files" else "name" if name == "skill_view" else "path"]}},
                          handler=handler, override=True)
    for name, (handler, server, schema) in services.items():
        if not name.startswith("mcp_" + server + "_") or server not in {"memory", "t3", "hermes_history"}:
            stop()
        registry.register(name=name, toolset="mcp-" + server, schema=schema, handler=handler)

    slots, entries = {}, {}
    generation = None
    registrations = None
    sealed = False
    request_ids = set()
    tool_results = set()
    send_available = False
    original_outer = te._dispatch_authorized_once
    original_init = AIAgent.__init__
    original_request = request_module.build_api_request
    original_definitions = registry.get_definitions
    bound_scope = registry.current_scope_key()
    mutators = ("register", "deregister", "restore_registration", "register_toolset_alias",
                "register_plugin_override_policy", "restore_plugin_override_policy")

    def refuse(*args, **kwargs):
        stop()

    def evidence(event):
        allowance = policy.get("attemptCounter")
        if allowance is None or not allowance.get("evidence"):
            return
        try:
            payload = json.dumps(event).encode()
            if len(payload) > 128 * 1024:
                stop()
            req = urllib.request.Request(allowance["url"].removesuffix("/attempt") + "/evidence", data=payload,
                                         headers={"Authorization": "Bearer " + allowance["token"]})
            with urllib.request.urlopen(req, timeout=5) as response:
                if response.read(100) != b"RECORDED":
                    stop()
        except BaseException:
            stop()

    def before_send(http_request):
        nonlocal send_available
        ready()
        # Metadata probes are not model calls; every model send needs a fresh primary request.
        if http_request.method == "GET" or http_request.url.path == "/api/show":
            return
        with lock:
            route = policy["config"]["model"]
            expected = route["base_url"].rstrip("/") + "/chat/completions"
            if (http_request.method != "POST" or str(http_request.url) != expected or
                    not send_available or json.loads(http_request.content).get("model") != route["default"]):
                stop()
            send_available = False
            evidence({"type": "catalog", "names": [item.get("function", item).get("name")
                       for item in json.loads(http_request.content).get("tools", [])]})
            # The optional probe counter lives in the Medium parent, never in Low-writable state.
            allowance = policy.get("attemptCounter")
            if allowance is not None:
                try:
                    url = urllib.parse.urlsplit(allowance["url"])
                    if url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port or url.port == 47321:
                        stop()
                    req = urllib.request.Request(allowance["url"], data=b"{}",
                                                 headers={"Authorization": "Bearer " + allowance["token"]})
                    with urllib.request.urlopen(req, timeout=5) as response:
                        if response.read(100) != b"ALLOW":
                            stop()
                except BaseException:
                    stop()

    original_send = httpx.Client._send_single_request
    original_async_send = httpx.AsyncClient._send_single_request
    def send(client, http_request):
        before_send(http_request)
        return original_send(client, http_request)
    async def async_send(client, http_request):
        before_send(http_request)
        return await original_async_send(client, http_request)

    def callbacks_empty():
        check_plugins()
        if plugins._dispatch_pre_tool_call_hooks is not callback:
            stop()

    def ready():
        with lock:
            try:
                check()
            except BaseException:
                stop()
            callbacks_empty()
            for obj, name, value in slots.values():
                if getattr(obj, name, None) is not value:
                    stop()
            if sealed:
                with registry._lock:
                    if registry._generation != generation or registry._scoped_tools:
                        stop()
                    if registry.current_scope_key() != bound_scope:
                        stop()
                    if {name: id(entry) for name, entry in registry._tools.items()} != registrations:
                        stop()
                    for name, (entry, handler, toolset, schema) in entries.items():
                        actual = registry.get_entry(name)
                        if (actual is not entry or actual.handler is not handler or actual.toolset != toolset or
                                actual.schema != schema or actual.is_async or actual.dynamic_schema_overrides is not None):
                            stop()
                for name in mutators:
                    if getattr(registry, name) is not refuse:
                        stop()

    def decide(name, args):
        if type(name) is not str or name not in allowed or type(args) is not dict:
            return False
        try:
            json.dumps(args, allow_nan=False)
            if name in {"read_file", "search_files"}:
                with readers.opened(args.get("path", str(readers.cwd))):
                    pass
            if name == "skill_view":
                readers.skill(args)
            return True
        except (ValueError, TypeError, OSError):
            return False

    def authorized(name, args):
        try:
            decision = decide(name, args)
        except BaseException:
            stop()
        if type(decision) is not bool:
            stop()
        return decision

    def callback(name, args, **kwargs):
        ready()
        return (None, None)  # There are deliberately zero external pre-tool callbacks.

    def pre(agent, ref):
        ready()
        try:
            result = callback(ref.name, ref.args)
            if type(result) is not tuple or len(result) != 2 or result != (None, None):
                stop()
            if not authorized(ref.name, ref.args):
                return "Divan guard denied", ref.args
            return None, ref.args
        except Exception:
            return "Divan guard denied", ref.args

    def final(name, args, **kwargs):
        with lock:
            ready()
            if not sealed or kwargs.get("scope") not in {None, bound_scope}:
                stop()
            if not authorized(name, args) or name not in entries:
                evidence({"type": "tool", "name": name, "args": args, "denied": True})
                return DENIED
            entry, handler, toolset, schema = entries[name]
            # Invoke the captured callable, never perform another mutable registry lookup.
            try:
                result = handler(copy.deepcopy(args))
            except Exception:
                result = DENIED
            evidence({"type": "tool", "name": name, "args": args, "result": result, "denied": result == DENIED})
            return result

    def outer(agent, state, ref, **kwargs):
        ready()
        if not authorized(ref.name, ref.args):
            state.blocked = True
            if kwargs.get("begin_execution") is not None:
                kwargs["begin_execution"]()
            evidence({"type": "tool", "name": ref.name, "args": ref.args, "denied": True})
            return DENIED
        kwargs["execute"] = lambda args: final(ref.name, args)
        return original_outer(agent, state, ref, **kwargs)

    def seal():
        nonlocal sealed, generation, registrations
        with registry._lock:
            if registry._scoped_tools:
                stop()
            for name in allowed:
                entry = registry.get_entry(name)
                expected = own.get(name) if name in own else services[name][0]
                if entry is None or entry.handler is not expected or entry.is_async or entry.dynamic_schema_overrides is not None:
                    stop()
                entries[name] = (entry, expected, entry.toolset, copy.deepcopy(entry.schema))
            generation = registry._generation
            registrations = {name: id(entry) for name, entry in registry._tools.items()}
            for name in mutators:
                if not callable(getattr(registry, name, None)):
                    stop()
                setattr(registry, name, refuse)
            sealed = True

    def guarded_init(agent, *args, **kwargs):
        ready()
        original_init(agent, *args, **kwargs)
        if not sealed:
            seal()
        ready()
        agent.tools = [item for item in (agent.tools or []) if item.get("function", item).get("name") in allowed]
        names = {item['function']['name'] for item in agent.tools}
        for name in services:
            if name not in names:
                agent.tools.append({'type':'function','function':copy.deepcopy(entries[name][3])})
        agent.valid_tool_names = {item["function"]["name"] for item in agent.tools}

    def definitions(names, *args, **kwargs):
        ready()
        return original_definitions(set(names) & allowed, *args, **kwargs)

    @functools.wraps(original_request)
    def request(*args, **kwargs):
        nonlocal send_available
        ready()
        if not sealed:
            stop()
        agent = args[0] if args else kwargs.get("agent")
        route = policy["config"]["model"]
        if (getattr(agent, "model", None) != route["default"] or
                getattr(agent, "api_mode", None) != "chat_completions" or
                str(getattr(agent, "base_url", "")).rstrip("/") != route["base_url"].rstrip("/")):
            stop()
        request_id = kwargs.get("api_request_id")
        with lock:
            if type(request_id) is not str or not request_id or request_id in request_ids or send_available:
                stop()
            request_ids.add(request_id)
        result = original_request(*args, **kwargs)
        ready()
        if type(result.api_kwargs) is not dict:
            stop()
        results = {item.get("tool_call_id") for item in result.api_kwargs.get("messages", [])
                   if item.get("role") == "tool" and type(item.get("tool_call_id")) is str}
        # Another model turn is allowed only after an actual tool result, never an empty/recovery replay.
        if len(request_ids) > 1 and not results - tool_results:
            stop()
        tool_results.update(results)
        if "tools" in result.api_kwargs:
            result.api_kwargs["tools"] = [item for item in result.api_kwargs["tools"] or []
                                          if item.get("function", item).get("name") in allowed]
            if not result.api_kwargs["tools"]:
                result.api_kwargs.pop("tool_choice", None)
        with lock:
            send_available = True
        return result

    for index, (obj, name, value) in enumerate((
            (te, "_dispatch_authorized_once", outer), (te, "_pre_tool_block", pre),
            (registry, "dispatch", final), (loop, "build_api_request", request),
            (request_module, "build_api_request", request), (AIAgent, "__init__", guarded_init),
            (httpx.Client, "_send_single_request", send), (httpx.AsyncClient, "_send_single_request", async_send),
            (auxiliary, "call_llm", refuse), (auxiliary, "async_call_llm", refuse),
            (moa, "bind_moa_runtime", refuse), (moa, "build_moa_facade", refuse),
            (moa, "aggregate_moa_context", refuse),
            (auxiliary, "_create_openai_client", refuse), (auxiliary, "get_async_text_auxiliary_client", refuse))):
        if not callable(getattr(obj, name, None)):
            stop()
        setattr(obj, name, value)
        slots[index] = (obj, name, value)
    if not callable(getattr(plugins, "_dispatch_pre_tool_call_hooks", None)):
        stop()
    plugins._dispatch_pre_tool_call_hooks = callback
    if not callable(getattr(registry, "get_definitions", None)):
        stop()
    registry.get_definitions = definitions
    slots['definitions'] = (registry, 'get_definitions', definitions)
    seal()
    ready()
    return ready, seal
