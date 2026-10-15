"""Medium-owned checked-hash bytecode; never execute the files being compiled."""
import importlib.util
import importlib._bootstrap_external as bootstrap
import hashlib
import json
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from install import pending, protect_code
from windows import Object, ProtectionPass, cache_security, low_token


def record(path, protection, directory, owner_only):
    with Object(path, read=not directory, no_follow=True) as obj:
        protection.check(obj, directory=directory)
        if obj.info.attributes & 0x400:
            raise ValueError("Cache reparse point")
        before = obj.signature()
        security = cache_security(obj, owner_only)
        data_hash = None if directory else hashlib.sha256(obj.bytes(64 * 1024 * 1024)).hexdigest()
        if before != obj.signature():
            raise ValueError("Cache changed during verification")
        # Directory timestamps change when ready.json is published; identities and security do not.
        return {"stamp": before[:3] if directory else before, "security": security, "hash": data_hash}


def inventory(cache):
    entries = {}
    with ProtectionPass(no_follow=True) as protection:
        def visit(path):
            key = str(path.relative_to(cache))
            entries[key] = record(path, protection, True, True)
            for name in os.listdir(path):
                child = path / name
                if child == cache / "ready.json":
                    continue
                if len(entries) >= 10000:
                    raise ValueError("Cache inventory bound exceeded")
                # lstat never traverses a junction while enumerating an untrusted tree.
                info = child.lstat()
                if info.st_file_attributes & 0x400:
                    raise ValueError("Cache reparse point")
                if info.st_file_attributes & 0x10:
                    visit(child)
                elif child.suffix == ".pyc":
                    entries[str(child.relative_to(cache))] = record(child, protection, False, True)
                else:
                    raise ValueError("Unexpected cache entry")
        visit(cache)
        ancestors = {str(path): record(path, protection, True, path == cache.parent) for path in cache.parents}
    return {"entries": entries, "ancestors": ancestors}


def verify(policy):
    if low_token() or sys.pycache_prefix:
        raise ValueError("Uncached Medium verifier required")
    cache = Path(policy["bytecode"])
    with ProtectionPass(no_follow=True) as protection:
        marker = cache / "ready.json"
        record(marker, protection, False, True)
        with Object(marker, read=True, no_follow=True) as obj:
            protection.check(obj, directory=False)
            before = obj.signature()
            data = obj.bytes(4 * 1024 * 1024)
            if before != obj.signature():
                raise ValueError("Cache receipt changed")
        receipt_hash = hashlib.sha256(data).hexdigest()
        if policy.get("bytecodeReceipt") and policy["bytecodeReceipt"] != receipt_hash:
            raise ValueError("Cache receipt changed")
        receipt = json.loads(data)
        actual = {"key": policy["bytecodeKey"], "inventory": inventory(cache)}
        if receipt != actual:
            raise ValueError("Cache bytes, protection or inventory changed")
        # Bind the receipt read to the same path after the full scan.
        with Object(marker, no_follow=True) as current:
            protection.check(current, directory=False)
            if before != current.signature():
                raise ValueError("Cache receipt replaced")
    return receipt_hash


def prepare(policy):
    if low_token() or sys.pycache_prefix:
        raise ValueError("Medium cache writer required")
    cache = Path(policy["bytecode"])
    with ProtectionPass(no_follow=True) as protection:
        record(cache, protection, True, True)
    key = policy["bytecodeKey"]
    marker = cache / "ready.json"
    if os.path.lexists(marker):
        return verify(policy)
    if list(cache.iterdir()):
        raise ValueError("Untrusted unfinished cache")
    roots = {"source": Path(policy["source"]), "dependencies": Path(policy["python"]).parents[1] / "Lib/site-packages",
             "stdlib": Path(policy["basePython"]).parent / "Lib"}
    modules = json.loads((Path(__file__).parent / "bytecode-modules.json").read_bytes())
    with ProtectionPass(no_follow=True) as protection:
        count = 0
        for group, names in modules.items():
            root = roots[group]
            for name in names:
                if not name.endswith(".py") or Path(name).is_absolute() or ".." in Path(name).parts:
                    raise ValueError("Invalid cache source")
                count += 1
                if count > 5000:
                    raise ValueError("Cache source bound exceeded")
                path = root / name
                if not path.exists():
                    continue  # This is a performance hint, never an execution or permission allowlist.
                with Object(path, read=True, no_follow=True) as obj:
                    linked = protect_code(obj, protection, Path(policy["root"]) if group == "dependencies" else None)
                    if obj.path != path or not obj.path.is_relative_to(root):
                        raise ValueError("Cache source origin changed")
                    data = obj.bytes(64 * 1024 * 1024, linked=linked)
                # Compile the checked bytes, not a second path read; PEP 552 checks source bytes on every import.
                try:
                    code = compile(data, str(path), 'exec', dont_inherit=True)
                except (SyntaxError, UnicodeError):
                    continue  # Optional source for another Python version is never imported here.
                sys.pycache_prefix = str(cache)
                try:
                    target = Path(importlib.util.cache_from_source(str(path)))
                finally:
                    sys.pycache_prefix = None
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(bootstrap._code_to_hash_pyc(code, importlib.util.source_hash(data), checked=True))
        if pending(Path(policy["root"]), Path(policy["state"])):
            raise ValueError("Pending installation")
    receipt = {"key": key, "inventory": inventory(cache)}
    with marker.open("x", encoding="utf-8") as out:
        out.write(json.dumps(receipt))
    return hashlib.sha256(marker.read_bytes()).hexdigest()


if __name__ == "__main__":
    try:
        policy = json.loads(sys.stdin.buffer.read(4 * 1024 * 1024))
        receipt_hash = verify(policy) if sys.argv[1:] == ["--verify"] else prepare(policy)
        print(json.dumps({"ok": True, "receiptHash": receipt_hash}))
    except Exception:
        raise SystemExit(125)
