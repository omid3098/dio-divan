"""A fixed helper verifies the Low reader and its bound medium SQLite objects."""
import json
import os
import struct
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from windows import Object, low_token, protected

try:
    if not low_token():
        raise ValueError("Low required")
    path = Path(sys.argv[1])
    protected(path.parent, directory=True)
    protected(path, directory=False)
    with Object(path, read=True) as obj:
        header = obj.prefix(100)
        identity = obj.identity
    objects = [identity]
    if len(header) != 100 or not header.startswith(b"SQLite format 3\0"):
        raise ValueError("Invalid database")
    wal = header[18:20] == b"\x02\x02"
    for suffix in ("-wal", "-shm"):
        side = Path(str(path) + suffix)
        if wal or os.path.lexists(side):
            protected(side, directory=False)
            with Object(side) as obj:
                objects.append(obj.identity)
        else:
            objects.append(None)
    if wal:
        with Object(str(path) + "-wal", read=True) as obj:
            wal_header = obj.prefix(32)
            wal_size = obj.size
        with Object(str(path) + "-shm", read=True) as obj:
            shm_header = obj.prefix(96)
        if (len(wal_header) != 32 or len(shm_header) != 96 or
                struct.unpack(">I", wal_header[:4])[0] not in {0x377f0682, 0x377f0683} or
                struct.unpack(">I", wal_header[4:8])[0] != 3007000 or
                shm_header[:48] != shm_header[48:96] or shm_header[12] != 1 or
                wal_header[16:24] != shm_header[32:40]):
            raise ValueError("Stale WAL objects")
        page_size = struct.unpack(">I", wal_header[8:12])[0]
        frames = struct.unpack("=I", shm_header[16:20])[0]
        if page_size not in {512, 1024, 2048, 4096, 8192, 16384, 32768, 65536} or wal_size < 32 + frames * (page_size + 24):
            raise ValueError("Incomplete WAL objects")
    for helper in sys.argv[2:]:
        protected(helper, directory=False)
    print(json.dumps({"ok": True, "objects": objects, "wal": wal}))
except Exception:
    print('{"ok":false}')
    raise SystemExit(125)
