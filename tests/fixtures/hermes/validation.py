"""Medium-only receipt mutation canaries on disposable files; never imports Hermes."""
import copy,json,os,sys
from pathlib import Path
policy_file=Path(sys.argv[1])
policy=json.loads(policy_file.read_text())
sys.path.insert(0,sys.argv[2])
def denied(fn):
 try: fn()
 except (ValueError,OSError): return
 raise AssertionError('Expected refusal')
from install import validate, check_validation
from windows import Object, ProtectionPass
validate(policy)
assert len(policy['validation']['directories'][policy['root']]) == 3
source = Path(policy['python']).parents[1].parent / 'workspace'
assert Path(policy['source']) == source
for name in ('run_agent.py', 'uv.lock', 'pyproject.toml', 'plugins/plugin_loader.py'):
    assert str(source / name) in policy['validation']['files'], name
from install import digest, protect_code
supported = json.loads((Path(sys.argv[2]) / 'supported.json').read_bytes())
finder_name = '__editable___hermes_agent_0_0_0_finder.py'
finder = Path(policy['python']).parents[1] / 'Lib/site-packages' / finder_name
with ProtectionPass() as protection:
    assert digest(finder, source, protection, root=Path(policy['root'])) == supported['dependencies'][finder_name]
redirected = policy_file.parent / finder_name
redirected.write_bytes(finder.read_bytes().replace(str(source).replace('\\', '\\\\').encode(),
                                                 str(Path(policy['root']) / 'hermes-agent').replace('\\', '\\\\').encode()))
assert digest(redirected, source) != supported['dependencies'][finder_name]
check_validation(policy)
gateway_root = policy_file.parent / 'gateway-root'
gateway_root.mkdir()
gateway_receipt = copy.deepcopy(policy)
gateway_receipt['root'] = str(gateway_root)
gateway_receipt['validation']['layout'] = [gateway_receipt[k] for k in ('root', 'source', 'state', 'python', 'basePython')]
gateway_receipt['validation']['files'] = {}
gateway_receipt['validation']['links'] = {}
with Object(gateway_root) as obj:
    gateway_receipt['validation']['directories'] = {str(gateway_root): obj.signature()[:3]}
(gateway_root / 'gateway_state.json').write_text('{}')
check_validation(gateway_receipt)
links_folder = policy_file.parent / 'install-links'
links_folder.mkdir()
primary, alias_dir = links_folder / 'primary.py', links_folder / 'aliases'
alias_dir.mkdir()
alias = alias_dir / 'alias.py'
primary.write_text('SAFE')
os.link(primary, alias)
linked_receipt = copy.deepcopy(policy)
linked_receipt['root'] = str(links_folder)
linked_receipt['validation']['layout'] = [linked_receipt[k] for k in ('root', 'source', 'state', 'python', 'basePython')]
with ProtectionPass() as protection, Object(primary, read=True) as obj:
    links = {}
    assert protect_code(obj, protection, links_folder, links)
    assert obj.bytes(100, linked=True) == b'SAFE'
    linked_receipt['validation']['files'] = {str(primary): obj.signature()}
    linked_receipt['validation']['directories'] = {}
    linked_receipt['validation']['links'] = links
    denied(lambda: protect_code(obj, protection))
    denied(lambda: protect_code(obj, protection, Path(policy['source'])))
check_validation(linked_receipt)
alias.unlink()
replacement = alias.with_name('replacement.py')
os.link(primary, replacement)
with Object(primary) as obj:
    linked_receipt['validation']['files'][str(primary)] = obj.signature()
denied(lambda: check_validation(linked_receipt))
replacement.unlink()
os.link(primary, alias)
import subprocess
subprocess.run([str(Path(os.environ['SystemRoot']) / 'System32/icacls.exe'), str(alias_dir), '/setintegritylevel', '(OI)(CI)L'],
               check=True, creationflags=0x08000000, stdout=subprocess.DEVNULL)
with ProtectionPass() as protection, Object(primary) as obj:
    denied(lambda: protect_code(obj, protection, links_folder))
receipt = copy.deepcopy(policy)
folder = policy_file.parent / "receipt-code"
folder.mkdir()
code = folder / "code.py"
code.write_text("SAFE")
with Object(code) as obj:
    stamp = obj.signature()
receipt["validation"]["files"] = {str(code): stamp}
with Object(folder) as obj:
    receipt["validation"]["directories"] = {str(folder): obj.signature()}
check_validation(receipt)
times = code.stat()
code.write_text("EVIL")  # Same file ID and length; restoring mtime is insufficient.
os.utime(code, ns=(times.st_atime_ns, times.st_mtime_ns))
with Object(code) as obj:
    assert obj.signature()[:3] == stamp[:3]
denied(lambda: check_validation(receipt))
low = Path(policy["copied"]) / "low-code.py"
low.write_text("SAFE")
with Object(low) as obj:
    receipt["validation"]["files"] = {str(low): obj.signature()}
denied(lambda: check_validation(receipt))
def replace_ancestor():
    with ProtectionPass() as protection:
        with Object(code) as obj:
            protection.check(obj, directory=False)
        folder.rename(folder.with_name("receipt-code-old"))
        folder.mkdir()
        (folder / "code.py").write_text("EVIL")
denied(replace_ancestor)

from bytecode import prepare
import importlib.machinery
cache = policy_file.parent / "bytecode-cache"
cache.mkdir()
source = policy_file.parent / "cache-source"
source.mkdir()
module = source / "run_agent.py"
module.write_text("VALUE=1\n")
cache_policy = {**policy, "source": str(source), "bytecode": str(cache), "bytecodeKey": "synthetic",
                "python": str(source / "venv/Scripts/python.exe"), "basePython": str(source / "runtime/python.exe")}
prepare(cache_policy)
sys.pycache_prefix = str(cache)
compiled = Path(importlib.util.cache_from_source(str(module)))
assert compiled.read_bytes()[4:8] == b"\x03\0\0\0"  # Checked-hash mode, never timestamp-only.
times = module.stat()
module.write_text("VALUE=2\n")
os.utime(module, ns=(times.st_atime_ns, times.st_mtime_ns))
namespace = {}
exec(importlib.machinery.SourceFileLoader("fixture", str(module)).get_code("fixture"), namespace)
assert namespace["VALUE"] == 2
sys.pycache_prefix = None
(cache / "ready.json").write_text('{"key":"wrong"}')
denied(lambda: prepare(cache_policy))
print('VALIDATION CANARIES OK')
