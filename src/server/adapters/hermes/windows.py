"""Windows objects used by the protected launcher and handle-based readers."""
import ctypes as c
from ctypes import wintypes as w
import os
from pathlib import Path

if os.name != "nt":
    raise RuntimeError("Windows required")
k = c.WinDLL("kernel32", use_last_error=True)
a = c.WinDLL("advapi32", use_last_error=True)
P, D, H = c.c_void_p, w.DWORD, w.HANDLE


def bind(dll, name, args, result=w.BOOL):
    fn = getattr(dll, name)
    fn.argtypes, fn.restype = args, result
    return fn


def ok(value):
    if not value:
        raise OSError("Windows operation failed")
    return value


close = bind(k, "CloseHandle", [H])
free = bind(k, "LocalFree", [P], P)
current = bind(k, "GetCurrentProcess", [], H)
open_token = bind(a, "OpenProcessToken", [H, D, c.POINTER(H)])
get_token = bind(a, "GetTokenInformation", [H, c.c_int, P, D, c.POINTER(D)])
create_file = bind(k, "CreateFileW", [w.LPCWSTR, D, D, P, D, D, H], H)
final_name = bind(k, "GetFinalPathNameByHandleW", [H, w.LPWSTR, D, D], D)
file_type = bind(k, "GetFileType", [H], D)
first_link = bind(k, "FindFirstFileNameW", [w.LPCWSTR, D, c.POINTER(D), w.LPWSTR], H)
next_link = bind(k, "FindNextFileNameW", [H, c.POINTER(D), w.LPWSTR])
find_close = bind(k, "FindClose", [H])
drive_type = bind(k, "GetDriveTypeW", [w.LPCWSTR], D)
volume_path = bind(k, "GetVolumePathNameW", [w.LPCWSTR, w.LPWSTR, D])
read_file = bind(k, "ReadFile", [H, P, D, c.POINTER(D), P])
security_info = bind(a, "GetSecurityInfo", [H, c.c_int, D, P, P, P, c.POINTER(P), c.POINTER(P)], D)
get_ace = bind(a, "GetAce", [P, D, c.POINTER(P)])
equal_sid = bind(a, "EqualSid", [P, P])
security_text = bind(a, "ConvertSecurityDescriptorToStringSecurityDescriptorW", [P, D, D, c.POINTER(P), c.POINTER(D)])


class SidAttributes(c.Structure):
    _fields_ = [("sid", P), ("attributes", D)]


class FileInfo(c.Structure):
    _fields_ = [("attributes", D), ("created", w.FILETIME), ("accessed", w.FILETIME),
                ("modified", w.FILETIME), ("volume", D), ("size_high", D),
                ("size_low", D), ("links", D), ("index_high", D), ("index_low", D)]


get_file_info = bind(k, "GetFileInformationByHandle", [H, c.POINTER(FileInfo)])
get_file_info_ex = bind(k, "GetFileInformationByHandleEx", [H, c.c_int, P, D])


class BasicInfo(c.Structure):
    _fields_ = [("created", c.c_int64), ("accessed", c.c_int64), ("modified", c.c_int64),
                ("changed", c.c_int64), ("attributes", D)]


def low_token():
    token = H()
    ok(open_token(current(), 8, c.byref(token)))
    try:
        needed = D()
        get_token(token, 25, None, 0, c.byref(needed))
        data = c.create_string_buffer(needed.value)
        ok(get_token(token, 25, data, needed, c.byref(needed)))
        sid = SidAttributes.from_buffer(data).sid
        rid = c.c_uint32.from_address(sid + 8).value
        policy = D()
        ok(get_token(token, 27, c.byref(policy), c.sizeof(policy), c.byref(needed)))
        return rid == 4096 and bool(policy.value & 1)
    finally:
        ok(close(token))


def integrity(handle):
    acl, sd = P(), P()
    if security_info(handle, 1, 0x10, None, None, None, c.byref(acl), c.byref(sd)):
        raise OSError("Cannot inspect integrity")
    try:
        if not acl:
            return 8192, 1  # Windows' implicit medium label and no-write-up.
        count = c.c_uint16.from_address(acl.value + 4).value
        labels = []
        for index in range(count):
            ace = P()
            ok(get_ace(acl, index, c.byref(ace)))
            if c.c_ubyte.from_address(ace.value).value == 0x11:
                sid = ace.value + 8
                n = c.c_ubyte.from_address(sid + 1).value
                labels.append((c.c_uint32.from_address(sid + 8 + 4 * (n - 1)).value,
                               c.c_uint32.from_address(ace.value + 4).value))
        if len(labels) > 1:
            raise OSError("Ambiguous integrity")
        return labels[0] if labels else (8192, 1)
    finally:
        if sd:
            free(sd)


class Object:
    def __init__(self, path, read=False, no_follow=False):
        self.handle = None
        self.requested = Path(path).absolute()
        handle = create_file(str(path), 0x80000000 if read else 0x80 | 0x20000,
                             1 | 2 | 4, None, 3, 0x02000000 | (0x00200000 if no_follow else 0), None)
        if handle == c.c_void_p(-1).value:
            raise OSError("Cannot open local object")
        self.handle = handle
        try:
            if file_type(handle) != 1:
                raise OSError("Not a disk object")
            buf = c.create_unicode_buffer(32768)
            n = final_name(handle, buf, len(buf), 0)
            if not 0 < n < len(buf) or not buf.value.startswith("\\\\?\\"):
                raise OSError("Uninspectable path")
            name = buf.value[4:]
            if name.startswith("UNC\\") or ":" in name[2:]:
                raise OSError("Remote or stream")
            volume = c.create_unicode_buffer(32768)
            if no_follow:
                # Cache scans reject reparse points at every component, so the DOS drive is the volume.
                volume.value = Path(name).anchor
            else:
                ok(volume_path(name, volume, len(volume)))
            if drive_type(volume.value) != 3:
                raise OSError("Not a local fixed volume")
            self.path = Path(name)
            self.info = FileInfo()
            ok(get_file_info(handle, c.byref(self.info)))
            self.directory = bool(self.info.attributes & 0x10)
            self.size = self.info.size_low + (self.info.size_high << 32)
            self.identity = (self.info.volume, self.info.index_high, self.info.index_low)
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.handle is not None:
            handle, self.handle = self.handle, None
            ok(close(handle))

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def bytes(self, maximum, *, linked=False):
        if self.directory or (self.info.links != 1 and not linked) or self.size > maximum:
            raise OSError("Unsafe or oversized file")
        out = bytearray()
        buf = c.create_string_buffer(65536)
        while True:
            n = D()
            ok(read_file(self.handle, buf, len(buf), c.byref(n), None))
            if not n.value:
                return bytes(out)
            out.extend(buf.raw[:n.value])
            if len(out) > maximum:
                raise OSError("File grew beyond limit")

    def prefix(self, count):
        if self.directory or self.info.links != 1:
            raise OSError("Unsafe file")
        buf, read = c.create_string_buffer(count), D()
        ok(read_file(self.handle, buf, count, c.byref(read), None))
        return buf.raw[:read.value]

    def signature(self):
        info, basic = FileInfo(), BasicInfo()
        ok(get_file_info(self.handle, c.byref(info)))
        ok(get_file_info_ex(self.handle, 0, c.byref(basic), c.sizeof(basic)))
        return [info.volume, info.index_high, info.index_low, info.links,
                info.size_high, info.size_low, str(basic.modified), str(basic.changed), basic.attributes]


def protected(path, directory=None):
    """Inspect the actual object and all parents; never label or repair any of them."""
    with Object(path) as obj:
        if directory is not None and obj.directory != directory:
            raise OSError("Wrong object kind")
        if not obj.directory and obj.info.links != 1:
            raise OSError("Linked protected code")
        rid, policy = integrity(obj.handle)
        if rid < 8192 or not policy & 1:
            raise OSError("Unprotected object")
        canonical = obj.path
    for parent in canonical.parents:
        with Object(parent) as obj:
            rid, policy = integrity(obj.handle)
            if rid < 8192 or not policy & 1:
                raise OSError("Unprotected ancestor")
    return canonical


class ProtectionPass:
    """Reuse held canonical ancestors only within one installation scan."""
    def __init__(self, no_follow=False):
        self.parents = {}
        self.signatures = {}
        self.no_follow = no_follow

    def __enter__(self):
        return self

    def check(self, obj, directory=None, *, linked=False):
        if obj.path != obj.requested or (self.no_follow and obj.info.attributes & 0x400):
            raise OSError("Protected origin changed")
        if directory is not None and obj.directory != directory:
            raise OSError("Wrong object kind")
        if not obj.directory and obj.info.links != 1 and not linked:
            raise OSError("Linked protected code")
        rid, policy = integrity(obj.handle)
        if rid < 8192 or not policy & 1:
            raise OSError("Unprotected object")
        for path in obj.path.parents:
            key = str(path).casefold()
            if key in self.parents:
                continue
            parent = Object(path, no_follow=self.no_follow)
            self.parents[key] = parent
            self.signatures[str(parent.path)] = parent.signature()
            rid, policy = integrity(parent.handle)
            if (not parent.directory or rid < 8192 or not policy & 1 or
                    (self.no_follow and (parent.path != parent.requested or parent.info.attributes & 0x400))):
                raise OSError("Unprotected ancestor")
        return obj.path

    def protected(self, path, directory=None):
        with Object(path, no_follow=self.no_follow) as obj:
            return self.check(obj, directory)

    def __exit__(self, kind, *args):
        try:
            if kind is None:
                for parent in self.parents.values():
                    with Object(parent.path, no_follow=self.no_follow) as current:
                        rid, policy = integrity(current.handle)
                        if (current.identity != parent.identity or not current.directory or
                                (self.no_follow and (current.path != current.requested or current.info.attributes & 0x400)) or
                                rid < 8192 or not policy & 1 or integrity(parent.handle) != (rid, policy)):
                            raise OSError("Ancestor changed during validation")
        finally:
            for parent in self.parents.values():
                parent.close()


def hardlink_paths(path):
    """Enumerate every local alias; callers must protect each alias and its ancestry."""
    length, buffer = D(32768), c.create_unicode_buffer(32768)
    handle = first_link(str(path), 0, c.byref(length), buffer)
    if handle == c.c_void_p(-1).value:
        raise OSError("Cannot enumerate code links")
    paths = []
    try:
        while True:
            if not buffer.value.startswith("\\") or buffer.value.startswith("\\\\") or len(paths) >= 64:
                raise OSError("Unsafe code link")
            paths.append(Path(path.drive + buffer.value))
            length.value = len(buffer)
            if not next_link(handle, c.byref(length), buffer):
                if c.get_last_error() != 38:  # ERROR_HANDLE_EOF
                    raise OSError("Cannot finish code link enumeration")
                return sorted(paths)
    finally:
        ok(find_close(handle))


_cache_user = None


def cache_user():
    # One process token owner per verifier, not a token open for every cached file.
    global _cache_user
    if _cache_user is None:
        token, needed = H(), D()
        ok(open_token(current(), 8, c.byref(token)))
        try:
            get_token(token, 1, None, 0, c.byref(needed))
            user = c.create_string_buffer(needed.value)
            ok(get_token(token, 1, user, needed, c.byref(needed)))
            _cache_user = user
        finally:
            ok(close(token))
    return SidAttributes.from_buffer(_cache_user).sid


def cache_security(obj, owner_only=False):
    """Cache descendants may inherit owner-only access, never another account's grant."""
    owner, acl, sd = P(), P(), P()
    if security_info(obj.handle, 1, 1 | 4 | 0x10, c.byref(owner), None, c.byref(acl), None, c.byref(sd)):
        raise OSError("Cannot inspect cache security")
    text = P()
    try:
        if owner_only:
            sid = cache_user()
            if not owner or not equal_sid(owner, sid) or not acl:
                raise OSError("Cache is not owner-only")
            count = c.c_uint16.from_address(acl.value + 4).value
            if not count:
                raise OSError("Empty cache access list")
            for index in range(count):
                ace = P()
                ok(get_ace(acl, index, c.byref(ace)))
                if c.c_ubyte.from_address(ace.value).value != 0 or not equal_sid(ace.value + 8, sid):
                    raise OSError("Cache is not owner-only")
        ok(security_text(sd, 1, 1 | 4 | 0x10, c.byref(text), None))
        return c.wstring_at(text)
    finally:
        if text:
            free(text)
        if sd:
            free(sd)
