"""Create a Low/no-write-up child in a creation-time kill-on-close Windows job."""
import ctypes as c
from ctypes import wintypes as w
import os
from pathlib import Path
import subprocess
import sys
import threading

sys.path.insert(0, str(Path(__file__).resolve().parent))
from windows import a, k, P, D, H, SidAttributes, bind, close, current, free, get_token, ok, open_token


class Startup(c.Structure):
    _fields_ = [("cb", D), ("reserved", w.LPWSTR), ("desktop", w.LPWSTR), ("title", w.LPWSTR),
                ("x", D), ("y", D), ("xs", D), ("ys", D), ("xc", D), ("yc", D), ("fill", D),
                ("flags", D), ("show", w.WORD), ("reserved_size", w.WORD), ("reserved2", P),
                ("stdin", H), ("stdout", H), ("stderr", H)]


class StartupEx(c.Structure):
    _fields_ = [("startup", Startup), ("attributes", P)]


class ProcessInfo(c.Structure):
    _fields_ = [("process", H), ("thread", H), ("pid", D), ("tid", D)]


class BasicLimits(c.Structure):
    _fields_ = [("process_time", c.c_longlong), ("job_time", c.c_longlong), ("flags", D),
                ("min_ws", c.c_size_t), ("max_ws", c.c_size_t), ("active", D),
                ("affinity", c.c_size_t), ("priority", D), ("scheduling", D)]


class IO(c.Structure):
    _fields_ = [(n, c.c_ulonglong) for n in ("reads", "writes", "other", "read_bytes", "write_bytes", "other_bytes")]


class Limits(c.Structure):
    _fields_ = [("basic", BasicLimits), ("io", IO), ("process_memory", c.c_size_t),
                ("job_memory", c.c_size_t), ("peak_process", c.c_size_t), ("peak_job", c.c_size_t)]


restrict = bind(a, "CreateRestrictedToken", [H, D, D, P, D, P, D, P, c.POINTER(H)])
sid = bind(a, "ConvertStringSidToSidW", [w.LPCWSTR, c.POINTER(P)])
set_token = bind(a, "SetTokenInformation", [H, c.c_int, P, D])
job_new = bind(k, "CreateJobObjectW", [P, w.LPCWSTR], H)
job_set = bind(k, "SetInformationJobObject", [H, c.c_int, P, D])
job_terminate = bind(k, "TerminateJobObject", [H, D])
in_job = bind(k, "IsProcessInJob", [H, H, c.POINTER(w.BOOL)])
init_attrs = bind(k, "InitializeProcThreadAttributeList", [P, D, D, c.POINTER(c.c_size_t)])
update_attrs = bind(k, "UpdateProcThreadAttribute", [P, D, c.c_size_t, P, c.c_size_t, P, P])
delete_attrs = bind(k, "DeleteProcThreadAttributeList", [P], None)
create_process = bind(a, "CreateProcessAsUserW", [H, w.LPCWSTR, w.LPWSTR, P, P, w.BOOL, D, P, w.LPCWSTR, P, c.POINTER(ProcessInfo)])
resume = bind(k, "ResumeThread", [H], D)
wait = bind(k, "WaitForSingleObject", [H, D], D)
exit_code = bind(k, "GetExitCodeProcess", [H, c.POINTER(D)])
open_process = bind(k, "OpenProcess", [D, w.BOOL, D], H)
process_times = bind(k, "GetProcessTimes", [H, c.POINTER(w.FILETIME), c.POINTER(w.FILETIME), c.POINTER(w.FILETIME), c.POINTER(w.FILETIME)])
query_job = bind(k, "QueryInformationJobObject", [H, c.c_int, P, D, P])


def creation(handle):
    times = [w.FILETIME() for _ in range(4)]
    ok(process_times(handle, *[c.byref(t) for t in times]))
    return times[0].dwLowDateTime + (times[0].dwHighDateTime << 32)


def launch(scratch, parent_pid, parent_created, command, fault=None):
    import msvcrt
    from windows import protected
    for fd in (sys.stdin.fileno(), sys.stdout.fileno(), sys.stderr.fileno()):
        msvcrt.setmode(fd, os.O_BINARY)
    if not Path(scratch).is_absolute() or not Path(command[0]).is_absolute():
        raise ValueError("Absolute paths required")
    protected(command[0], directory=False)
    handles, fds, attrs = [], set(), None
    attrs_initialized = False
    pi, job = ProcessInfo(), None
    errors = []
    done = threading.Event()

    def stage(name):
        if fault == name:
            raise OSError("Injected launcher failure")

    def owned(handle):
        ok(handle)
        handles.append(handle)
        return handle

    def pipe(name):
        stage(name)
        pair = os.pipe()
        fds.update(pair)
        return pair

    try:
        parent = owned(open_process(0x100000 | 0x1000, False, parent_pid))
        if creation(parent) != parent_created or wait(parent, 0) != 258:
            raise OSError("Parent identity unavailable")
        stage("token")
        original, token = H(), H()
        ok(open_token(current(), 0xf01ff, c.byref(original)))
        handles.append(original)
        ok(restrict(original, 1, 0, None, 0, None, 0, None, c.byref(token)))
        handles.append(token)
        il = P()
        ok(sid("S-1-16-4096", c.byref(il)))
        try:
            label = SidAttributes(il, 0x20)
            ok(set_token(token, 25, c.byref(label), c.sizeof(label) + 12))
        finally:
            free(il)
        size = D()
        get_token(token, 25, None, 0, c.byref(size))
        data = c.create_string_buffer(size.value)
        ok(get_token(token, 25, data, size, c.byref(size)))
        if c.c_uint32.from_address(SidAttributes.from_buffer(data).sid + 8).value != 4096:
            raise OSError("Low token required")
        mandatory = D()
        ok(get_token(token, 27, c.byref(mandatory), c.sizeof(mandatory), c.byref(size)))
        if not mandatory.value & 1:
            raise OSError("No-write-up required")
        stage("job")
        job = owned(job_new(None, None))
        limits = Limits()
        limits.basic.flags = 0x2000
        ok(job_set(job, 9, c.byref(limits), c.sizeof(limits)))
        inp, input_parent = pipe("pipe1")
        output_parent, out = pipe("pipe2")
        error_parent, err = pipe("pipe3")
        for fd in (inp, out, err):
            os.set_inheritable(fd, True)
        child_handles = (H * 3)(*[msvcrt.get_osfhandle(fd) for fd in (inp, out, err)])
        jobs = (H * 1)(job)
        needed = c.c_size_t()
        init_attrs(None, 2, 0, c.byref(needed))
        if c.get_last_error() != 122 or not needed.value:
            raise OSError("Attribute sizing failed")
        stage("attributes")
        attrs = c.create_string_buffer(needed.value)
        ok(init_attrs(attrs, 2, 0, c.byref(needed)))
        attrs_initialized = True
        stage("handles")
        ok(update_attrs(attrs, 0, 0x20002, child_handles, c.sizeof(child_handles), None, None))
        stage("joblist")
        ok(update_attrs(attrs, 0, 0x2000d, jobs, c.sizeof(jobs), None, None))
        si = StartupEx()
        si.startup.cb, si.startup.flags = c.sizeof(si), 0x100
        si.startup.stdin, si.startup.stdout, si.startup.stderr = child_handles
        si.attributes = c.cast(attrs, P)
        environment = c.create_unicode_buffer("\0".join(key + "=" + value for key, value in
                                                       sorted(os.environ.items(), key=lambda item: item[0].upper())) + "\0\0")
        line = c.create_unicode_buffer(subprocess.list2cmdline(command))
        stage("create")
        ok(create_process(token, command[0], line, None, None, True,
                          0x08000000 | 4 | 0x80000 | 0x400, environment, scratch, c.byref(si), c.byref(pi)))
        handles.extend([pi.process, pi.thread])
        for fd in (inp, out, err):
            os.close(fd)
            fds.remove(fd)
        stage("membership")
        member = w.BOOL()
        ok(in_job(pi.process, job, c.byref(member)))
        if not member.value:
            raise OSError("Job membership required")

        def pump(src, dst, input_stream=False):
            try:
                while not done.is_set() or not input_stream:
                    chunk = os.read(src, 65536)
                    if not chunk:
                        break
                    view = memoryview(chunk)
                    while view:
                        count = os.write(dst, view)
                        if count <= 0:
                            raise OSError("Short transport write")
                        view = view[count:]
            except OSError:
                if not input_stream or not done.is_set():
                    errors.append("transport")
                    job_terminate(job, 125)
            finally:
                if input_stream:
                    try:
                        os.close(dst)
                        fds.discard(dst)
                    except OSError:
                        pass

        pumps = [threading.Thread(target=pump, args=(sys.stdin.fileno(), input_parent, True), daemon=True),
                 threading.Thread(target=pump, args=(output_parent, sys.stdout.fileno()), daemon=True),
                 threading.Thread(target=pump, args=(error_parent, sys.stderr.fileno()), daemon=True)]
        for thread in pumps:
            thread.start()
        stage("resume")
        if resume(pi.thread) == 0xffffffff:
            raise OSError("Resume failed")
        while True:
            state = wait(pi.process, 50)
            if state == 0:
                break
            if state != 258 or wait(parent, 0) != 258:
                errors.append("parent")
                ok(job_terminate(job, 125))
        code = D()
        ok(exit_code(pi.process, c.byref(code)))
        done.set()
        ok(job_terminate(job, code.value))
        # Query the job until every descendant is dead before returning to the owner.
        accounting = c.create_string_buffer(48)
        while True:
            ok(query_job(job, 1, accounting, len(accounting), None))
            if c.c_uint32.from_buffer(accounting, 40).value == 0:
                break
            threading.Event().wait(0.01)
        stage("drain")
        for thread in pumps[1:]:
            while thread.is_alive():
                thread.join(0.05)
                if wait(parent, 0) != 258:
                    raise OSError("Parent ended during drain")
        return 125 if errors else code.value
    finally:
        done.set()
        if job:
            job_terminate(job, 125)
        if pi.process:
            wait(pi.process, 5000)
        if attrs_initialized:
            delete_attrs(attrs)
        for fd in list(fds):
            try:
                os.close(fd)
            except OSError:
                pass
        for handle in reversed(handles):
            close(handle)


if __name__ == "__main__":
    try:
        raise SystemExit(launch(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4:]))
    except Exception:
        os.write(2, b"Divan Hermes launcher failure\n")
        raise SystemExit(125)
