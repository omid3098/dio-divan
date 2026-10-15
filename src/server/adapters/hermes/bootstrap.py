"""Selected-venv entry under Low; no lease, maintenance, or live config loaders."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from windows import Object, low_token, protected
from config import Snapshot
STAGE = "preflight"


def unavailable():
    os.write(2, ("Divan Hermes guard failure: " + STAGE + "\n").encode("ascii"))
    os._exit(125)


def main():
    global STAGE
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    if not low_token():
        unavailable()
    policy_path = Path(sys.argv.pop(1))
    protected(policy_path, directory=False)
    with Object(policy_path, read=True) as obj:
        policy = json.loads(obj.bytes(4 * 1024 * 1024))
    source = Path(policy["source"])
    if policy.get("bytecode"):
        cache = protected(policy["bytecode"], directory=True)
        protected(cache / "ready.json", directory=False)
        if (str(cache) != sys.pycache_prefix or
                json.loads((cache / "ready.json").read_bytes()).get("key") != policy["bytecodeKey"]):
            unavailable()
    if Path(sys.executable).resolve() != Path(policy["python"]).resolve() or sys.prefix == sys.base_prefix:
        unavailable()
    # Startup .pth/origins are inspected before this interpreter can be launched.
    from install import validate, check_validation
    if policy.get("validation"):
        check_validation(policy)
    else:
        validate(policy)
    STAGE = "snapshot"
    snapshot = Snapshot(policy)
    selection = argparse.ArgumentParser(add_help=False)
    selection.add_argument('-m', '--model')
    selection.add_argument('--provider')
    selected, _ = selection.parse_known_args(sys.argv[1:])
    route = policy["config"]["model"]
    if selected.model != route["default"] or selected.provider != route["provider"]:
        unavailable()
    slots = []
    ready = None

    def check():
        snapshot.check()
        for obj, name, fn in slots:
            if getattr(obj, name, None) is not fn:
                unavailable()

    def audit(event, args):
        if event == "socket.connect":
            if ready is None:
                unavailable()
            try:
                ready()
            except BaseException:
                unavailable()
    sys.addaudithook(audit)
    # Use the pinned editable finder, exactly as the selected venv does.
    for name in ("hermes_cli", "agent", "hermes_bootstrap", "run_agent"):
        spec = importlib.util.find_spec(name)
        expected = source / name / "__init__.py" if (source / name).is_dir() else source / (name + ".py")
        if spec is None or Path(spec.origin).resolve() != expected:
            unavailable()
    STAGE = "source"
    from hermes_cli import _early_recovery
    # The pinned no-maintenance route is checked above; a concurrent pending update is fatal.
    def no_recovery(*args, **kwargs):
        from install import pending
        if pending(Path(policy["root"]), Path(policy["state"])) or kwargs.get("explicit"):
            unavailable()
        return False
    if not callable(getattr(_early_recovery, "recover_if_needed", None)):
        unavailable()
    _early_recovery.recover_if_needed = no_recovery
    import hermes_bootstrap
    from hermes_cli import _install_repair
    if not callable(getattr(_install_repair, "ensure_windows_bin_launchers", None)):
        unavailable()
    _install_repair.ensure_windows_bin_launchers = lambda *args, **kwargs: []
    slots = snapshot.bind(unavailable)
    STAGE = "plugins"
    import hermes_cli.plugins as plugins
    from guard import close_plugins, install
    close_plugins(plugins, unavailable)
    import run_agent
    STAGE = "guard"
    from services import bindings
    ready, _seal = install(policy, check, unavailable, bindings(policy))
    ready()
    STAGE = "cli"
    for module in (hermes_bootstrap, run_agent, plugins):
        path = Path(module.__file__).resolve()
        if not path.is_relative_to(source):
            unavailable()
    snapshot.bind_main(slots, unavailable)
    from hermes_cli.main import main as cli
    sys.argv[0] = "hermes-divan"
    return cli()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        kind = type(error).__name__
        if kind not in {"ValueError", "OSError", "TypeError", "RuntimeError", "KeyError", "AttributeError", "ImportError", "ModuleNotFoundError", "PermissionError"}:
            kind = "error"
        os.write(2, ("Divan Hermes failure kind: " + kind + "\n").encode("ascii"))
        unavailable()
