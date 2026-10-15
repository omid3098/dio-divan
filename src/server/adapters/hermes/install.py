"""Static installation validation; this module never imports Hermes."""
import ast
import hashlib
import json
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from windows import Object, ProtectionPass, hardlink_paths

HERE = Path(__file__).resolve().parent


PENDING = ("manifest.json", ".hermes-update-in-progress", "hermes-agent/.update-incomplete",
           "hermes-agent/.lazy-refresh-incomplete", "hermes-agent/.git/hermes-update-pull")


def pending(root, state):
    return any(os.path.lexists(root / name) for name in PENDING) or any(
        os.path.lexists(state / name) for name in (".repair-incomplete", "publication.json", "source-completion-pending"))


def protect_code(obj, protection, root=None, links=None):
    if obj.info.links == 1 or root is None:
        protection.check(obj, directory=False)
        return False
    protection.check(obj, directory=False, linked=True)
    paths = hardlink_paths(obj.path)
    stamp = obj.signature()
    if len(paths) != obj.info.links or obj.path not in paths:
        raise ValueError("Code link set changed")
    for path in paths:
        if not path.is_relative_to(root):
            raise ValueError("Code link outside installation")
        with Object(path, no_follow=True) as alias:
            protection.check(alias, directory=False, linked=True)
            if alias.signature() != stamp:
                raise ValueError("Code link identity changed")
    if links is not None:
        links[str(obj.path)] = list(map(str, paths))
    return True


def digest(path, source=None, protection=None, records=None, root=None, links=None):
    with Object(path, read=True, no_follow=True) as obj:
        linked = protect_code(obj, protection, root, links) if protection is not None else False
        before = obj.signature()
        data = obj.bytes(64 * 1024 * 1024, linked=linked)
        if before != obj.signature():
            raise ValueError("File changed while hashing")
        if records is not None:
            records[str(obj.path)] = before
    if path.name.startswith("__editable___"):
        tree = ast.parse(data)
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and source is not None:
                value = node.value
                if value.lower().startswith(str(source).lower() + "\\"):
                    node.value = "$SOURCE" + value[len(str(source)):].replace("\\", "/")
        data = ast.dump(tree).encode()
    return hashlib.sha256(data).hexdigest()


def validate(policy):
    with ProtectionPass(no_follow=True) as protection:
        records, links = {}, {}
        facts = validate_pass(policy, protection, records, links)
        if pending(Path(policy["root"]), Path(policy["state"])):
            raise ValueError("Pending installation")
        # Gateway state changes root entries; it is not a Python import directory.
        directories = {path: stamp[:3] if Path(path) == Path(policy["root"]) else stamp
                       for path, stamp in protection.signatures.items()
                       if Path(path).is_relative_to(Path(policy["root"]))}
    policy["validation"] = {"manifest": hashlib.sha256((HERE / "supported.json").read_bytes()).hexdigest(),
                            "layout": [policy[k] for k in ("root", "source", "state", "python", "basePython")],
                            "files": records, "directories": directories, "links": links}
    return facts


def validate_pass(policy, protection, records, links):
    protected = protection.protected
    root, source, state = map(Path, (policy["root"], policy["source"], policy["state"]))
    supported = json.loads((HERE / "supported.json").read_text(encoding="utf-8"))
    if pending(root, state):
        raise ValueError("Pending installation")
    protected(root, directory=True)
    protected(source, directory=True)
    protected(state, directory=True)
    with Object(state / "facts.json", read=True) as obj:
        protection.check(obj, directory=False)
        records[str(obj.path)] = obj.signature()
        facts = json.loads(obj.bytes(1024 * 1024))
    selection = facts.get("packages", {}).get("venv", {})
    if facts.get("schema") != 1 or {k: selection.get(k) for k in ("stamp", "extras")} != supported["selection"]:
        raise ValueError("Unsupported selection")
    venv = Path(selection["environment"]).resolve(strict=True)
    if (not venv.is_relative_to(state / "environments") or str(venv / "Scripts/python.exe") != policy["python"] or
            source != venv.parent / "workspace"):
        raise ValueError("Selected interpreter changed")
    if Path(selection["resolved_lock"]).resolve() != source / "uv.lock":
        raise ValueError("Lock origin changed")
    with Object(venv / "pyvenv.cfg", read=True) as obj:
        protection.check(obj, directory=False)
        records[str(obj.path)] = obj.signature()
        cfg = dict(line.strip().split(" = ", 1) for line in obj.bytes(1024 * 1024).decode().splitlines() if " = " in line)
    runtime = Path(cfg.get("home", "")).resolve(strict=True)
    if (not runtime.is_relative_to(root / "tools") or cfg.get("version_info") != supported["python_version"] or
            cfg.get("include-system-site-packages") != "false" or str(runtime / "python.exe") != policy["basePython"]):
        raise ValueError("Runtime origin changed")
    origins = [("source", source), ("checkout", root / "hermes-agent"),
               ("runtime", runtime), ("dependencies", venv / "Lib/site-packages")]
    for group, base in origins:
        for name, expected in supported[group].items():
            path = base / name
            if digest(path, source, protection, records, root if group == "dependencies" else None, links) != expected:
                raise ValueError("Supported bytes changed")
    pths = {str(path.relative_to(venv / "Lib/site-packages")).replace("\\", "/")
            for path in (venv / "Lib/site-packages").glob("*.pth")}
    if pths != {name for name in supported["dependencies"] if name.endswith(".pth")}:
        raise ValueError("Startup origin changed")
    for name in ("sitecustomize.py", "usercustomize.py"):
        if (venv / "Lib/site-packages" / name).exists():
            raise ValueError("Unexpected startup")
    protected(venv / "Scripts/python.exe", directory=False)
    with Object(venv / "Scripts/python.exe", read=True) as obj:
        records[str(obj.path)] = obj.signature()
    protected(venv / "pyvenv.cfg", directory=False)
    protected(HERE, directory=True)
    return facts


def check_validation(policy):
    """Only a Medium-owned parent may supply a receipt; Low never writes one."""
    receipt = policy["validation"]
    if (receipt["manifest"] != hashlib.sha256((HERE / "supported.json").read_bytes()).hexdigest() or
            receipt["layout"] != [policy[k] for k in ("root", "source", "state", "python", "basePython")] or
            pending(Path(policy["root"]), Path(policy["state"]))):
        raise ValueError("Installation receipt changed")
    with ProtectionPass(no_follow=True) as protection:
        for path, signature in receipt["files"].items():
            with Object(path, no_follow=True) as obj:
                expected_links = receipt.get("links", {}).get(path)
                actual_links = {}
                protect_code(obj, protection, Path(policy["root"]) if expected_links else None, actual_links)
                if actual_links.get(path) != expected_links:
                    raise ValueError("Code link set changed")
                if str(obj.path).casefold() != path.casefold() or obj.signature() != signature:
                    raise ValueError("Installation identity/content changed")
        # Directory changes catch new startup files, removals and replacements too.
        for path, signature in receipt.get("directories", {}).items():
            with Object(path, no_follow=True) as obj:
                protection.check(obj, directory=True)
                if obj.signature()[:len(signature)] != signature:
                    raise ValueError("Installation directory changed")
        if pending(Path(policy["root"]), Path(policy["state"])):
            raise ValueError("Pending installation")


if __name__ == "__main__":
    try:
        policy = json.loads(sys.stdin.buffer.read(4 * 1024 * 1024))
        if "validation" in policy:
            try:
                check_validation(policy)
            except (ValueError, OSError, KeyError):
                validate(policy)
        else:
            validate(policy)
        from launcher import creation, open_process, close, ok
        parent = ok(open_process(0x1000, False, os.getppid()))
        try:
            stamp = str(creation(parent))
        finally:
            close(parent)
        print(json.dumps({"ok": True, "parentCreated": stamp, "validation": policy["validation"]}))
    except Exception:
        print(json.dumps({"ok": False}))
        raise SystemExit(125)
