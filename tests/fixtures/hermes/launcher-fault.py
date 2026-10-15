import json
import os
from pathlib import Path
import sys
policy = json.loads(Path(sys.argv[1]).read_text())
sys.path.insert(0, sys.argv[2])
from launcher import launch, creation, open_process, close, ok
from windows import bind, k, current, D, c
get_count = bind(k, 'GetProcessHandleCount', [c.c_void_p,c.POINTER(D)])
before, after = D(), D()
ok(get_count(current(), c.byref(before)))
children = []
import launcher
original = launcher.create_process
def capture(*args):
    result = original(*args)
    if result:
        children.append(c.cast(args[-1], c.POINTER(launcher.ProcessInfo)).contents.pid)
    return result
launcher.create_process = capture
parent = ok(open_process(0x1000, False, os.getppid()))
try:
    stamp = creation(parent)
finally:
    close(parent)
owned, fds = set(), set()
original_close, original_pipe, original_fd_close = launcher.close, os.pipe, os.close
def track_return(name):
    original = getattr(launcher, name)
    def call(*args):
        result = original(*args)
        if result:
            owned.add(result)
        return result
    setattr(launcher, name, call)
for name in ('open_process', 'job_new'):
    track_return(name)
for name in ('open_token', 'restrict'):
    original = getattr(launcher,name)
    def call(*args, _original=original):
        result = _original(*args)
        if result:
            owned.add(c.cast(args[-1], c.POINTER(c.c_void_p)).contents.value)
        return result
    setattr(launcher,name,call)
def tracked_close(handle):
    result = original_close(handle)
    if result:
        owned.discard(handle.value if hasattr(handle,'value') else handle)
    return result
def tracked_pipe():
    pair = original_pipe()
    fds.update(pair)
    return pair
def tracked_fd_close(fd):
    result = original_fd_close(fd)
    fds.discard(fd)
    return result
launcher.close, os.pipe, os.close = tracked_close, tracked_pipe, tracked_fd_close
try:
    launch(policy['scratch'], os.getppid(), stamp, [policy['python'], '-I', '-S', '-B', '-c', 'print("unexpected")'], fault=sys.argv[3])
except Exception:
    import gc, time
    gc.collect()
    for pid in children:
        child = open_process(0x100000, False, pid)
        if child:
            try:
                assert launcher.wait(child,5000) == 0, 'owned child survived'
            finally:
                close(child)
    ok(get_count(current(), c.byref(after)))
    assert not owned and not fds, (owned,fds)
    print(json.dumps({'fault':sys.argv[3], 'cleaned':True, 'handlesBefore':before.value, 'handlesAfter':after.value,'children':len(children)}))
else:
    raise AssertionError('Fault injection must refuse')
