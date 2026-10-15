"""Static audit of the pinned source; never imports or executes Hermes."""
import ast
import hashlib
import json
from pathlib import Path
import re
import sys
import warnings

warnings.filterwarnings("ignore", category=SyntaxWarning)
READ_CALLS = {"open", "read_text", "read_bytes", "safe_load", "fast_safe_load",
              "load_dotenv", "dotenv_values", "load_yaml_file_readonly"}
WRAPPERS = {"load_env", "get_env_value", "get_env_value_prefer_dotenv", "load_env_file",
            "load_managed_env", "load_managed_config", "load_config", "load_config_readonly",
            "read_raw_config", "read_raw_config_readonly", "check_config_version",
            "load_hermes_dotenv", "_apply_managed_env"}
CONTEXT_CALLS = {"select_context", "on_session_start", "on_turn_complete", "on_session_end",
                 "on_session_reset", "on_session_switch"}
CONTEXT_CALLERS = {"_select_context_engine", "_apply_context_engine_selection",
                   "_notify_context_engine_turn_complete", "_notify_context_engine_session_end",
                   "_notify_context_engine_compression_complete"}


def own(node):
    yield node
    for child in ast.iter_child_nodes(node):
        if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            yield from own(child)


def scan(source, pins):
    rows = []
    def visit(node, path, text, prefix=""):
        calls = [n for n in own(node) if isinstance(n, ast.Call)]
        def leaf(call):
            fn = call.func
            return fn.id if isinstance(fn, ast.Name) else fn.attr if isinstance(fn, ast.Attribute) else "<indirect>"
        io = [c for c in calls if leaf(c) in READ_CALLS]
        reader = bool(io)
        reader = reader or (path in {"hermes_cli/config.py", "hermes_cli/managed_scope.py", "hermes_cli/env_loader.py", "agent/secret_scope.py"}
                            and prefix in WRAPPERS)
        reader = reader or (path == "utils.py" and prefix in {"fast_safe_load", "load_yaml_file_readonly"})
        delivery = [c for c in calls if re.search(r"callback|middleware|listener|injector|subscriber|invoke.*hook|^cb$|^hook$|^handler$|_dispatch_event|_deliver_event", leaf(c))
                    or (leaf(c) == "run" and any(re.search(r"callback|\bcb\b", ast.unparse(arg)) for arg in c.args))]
        delivery = delivery or (calls and prefix.rsplit(".", 1)[-1] in {
            "invoke_hook", "ainvoke_hook", "invoke_middleware", "_dispatch_event", "_deliver_event",
            "_notify_plugin_loaded", "_run_hook_callback_bounded", "_render_prompt_section_text",
            "inject_gateway_message", "inject_tui_message", "inject_message", "emit",
            "_run_execution_chain", "run_llm_execution_middleware", "run_tool_execution_middleware",
            "enqueue_plugin_stream_hook", "dispose", "_dispose_registrations", "_load_plugin_scoped",
            "run_with_load_deadline", "_dispatch_pre_tool_call_hooks"})
        delivery = delivery or any(leaf(c) in CONTEXT_CALLS for c in calls)
        delivery = delivery or (calls and prefix.rsplit(".", 1)[-1] in CONTEXT_CALLERS)
        delivery = delivery or (re.search(r"plugin|hook|middleware", path) and any(leaf(c) in {"fn", "entrypoint", "register", "content", "release", "_on_dispose"} for c in calls))
        delivery = delivery or (calls and path in {
            "hermes_cli/plugins_dispatch.py", "hermes_cli/plugins_loader.py", "hermes_cli/plugins_ledger.py",
            "hermes_cli/lifecycle.py", "hermes_cli/middleware.py", "agent/plugin_stream_hooks.py",
            "agent/shell_hooks.py", "agent/outbound_webhooks.py"})
        for kind, included, selected in (("reader", reader, io), ("delivery", delivery, calls)):
            if included and not isinstance(node, ast.ClassDef):
                rows.append((kind, path, prefix or "<module>", getattr(node, "lineno", 1),
                             ",".join(sorted({leaf(c) for c in selected}))))
        def nested(n):
            for child in ast.iter_child_nodes(n):
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    visit(child, path, text, (prefix + "." if prefix else "") + child.name)
                else:
                    nested(child)
        nested(node)
    for path, digest in sorted(pins.items()):
        if path.endswith(".py"):
            data = (source / path).read_bytes()
            assert hashlib.sha256(data).hexdigest() == digest, "Pinned source changed: " + path
            text = data.decode("utf-8-sig")
            visit(ast.parse(text), path, text)
    return sorted(rows)


if __name__ == "__main__":
    policy = json.loads(Path(sys.argv[1]).read_text())
    supported = json.loads((Path(sys.argv[2]) / "supported.json").read_text())
    inventory = Path(__file__).with_name("INVENTORY.md").read_text(encoding="utf-8")
    assert supported["source_commit"] in inventory, "Inventory must name the pinned commit"
    expected = []
    counts = {"bound": 0, "unreachable": 0, "excluded": 0}
    for line in inventory.splitlines():
        if not line.startswith("| reader |") and not line.startswith("| delivery |"):
            continue
        kind, path, symbol, number, calls, status, evidence = [part.strip() for part in line.strip("|").split("|")]
        assert status in counts and evidence, line
        expected.append((kind, path, symbol, int(number), calls))
        counts[status] += 1
    actual = sorted(set(scan(Path(policy["source"]), supported["source"])) |
                    set(scan(Path(policy["root"]) / "hermes-agent", supported["checkout"])))
    assert len(expected) == len(set(expected)), "Duplicate inventory entry"
    assert set(actual) == set(expected), {"unlisted": sorted(set(actual) - set(expected)), "removed": sorted(set(expected) - set(actual))}
    probe = Path(policy["scratch"]) / "inventory-probe"
    probe.mkdir()
    path = "hermes_cli/cli_config_load.py"
    original = (Path(policy["source"]) / path).read_bytes()
    data = original + b"\nfrom pathlib import Path\nSETTINGS = Path('config.yaml')\ndef added_reader():\n return SETTINGS.read_text()\ndef parameter_reader(path):\n return open(path).read()\nasync def added_delivery(callback):\n return await callback()\ndef method_delivery(engine):\n return engine.on_session_start('synthetic')\n"
    target = probe / path
    target.parent.mkdir()
    target.write_bytes(data)
    try:
        scan(probe, {path: supported["source"][path]})
    except AssertionError as error:
        assert "Pinned source changed" in str(error)
    else:
        raise AssertionError("An unchanged source pin must reject the edit")
    baseline = set(scan(Path(policy["source"]), {path: supported["source"][path]}))
    updated = set(scan(probe, {path: hashlib.sha256(data).hexdigest()}))
    added = updated - baseline
    assert {(r[0], r[2]) for r in added} == {
        ("reader", "added_reader"), ("reader", "parameter_reader"),
        ("delivery", "added_delivery"), ("delivery", "method_delivery")}
    assert baseline < updated, "A maintained pin still requires an inventory delta"
    assert added.isdisjoint(expected), "New functions must be unlisted until audited"
    print(json.dumps({"passed": ["pinned-source inventory, all listed readers and deliveries"], "low": True,
                      "counts": counts, "entries": len(actual), "pythonFiles": sum(p.endswith(".py") for p in supported["source"])}))
