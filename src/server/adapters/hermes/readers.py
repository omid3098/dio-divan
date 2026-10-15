"""Ordinary local text readers. Authorization and consumption share an opened handle."""
import json
import os
from pathlib import Path
import re
from windows import Object


class Readers:
    def __init__(self, policy):
        self.cwd = Path(policy["scratch"])
        self.blocked = [Path(p).resolve() for p in policy["blocked"]]
        self.copied = Path(policy["copied"]).resolve()

    def forbidden(self, path):
        return (not path.is_relative_to(self.copied) and
                any(path.is_relative_to(root) for root in self.blocked))

    def spelling(self, raw):
        if type(raw) is not str or not raw or "\0" in raw:
            raise ValueError("Invalid path")
        if re.match(r"^/[a-zA-Z]/", raw):
            raw = raw[1].upper() + ":" + raw[2:]
        if (raw.startswith(("\\\\", "//")) or ":" in raw[2:] or
                re.match(r"^[a-zA-Z]:(?:$|[^\\/])", raw) or
                (raw.startswith(("/", "\\")) and not re.match(r"^[a-zA-Z]:", raw))):
            raise ValueError("Ambiguous namespace")
        if raw == "~" or raw.startswith(("~/", "~\\")):
            raw = os.environ["HOME"] + raw[1:]
        path = Path(raw)
        return path if path.is_absolute() else self.cwd / path

    def opened(self, raw):
        obj = Object(self.spelling(raw), read=True)
        try:
            if self.forbidden(obj.path) or (not obj.directory and obj.info.links != 1):
                raise PermissionError("Protected object")
            return obj
        except BaseException:
            obj.close()
            raise

    def read(self, args):
        if type(args) is not dict or set(args) - {"path", "offset", "limit"}:
            raise ValueError("Invalid arguments")
        offset, limit = args.get("offset", 1), args.get("limit", 200)
        if type(offset) is not int or offset < 1 or type(limit) is not int or not 1 <= limit <= 2000:
            raise ValueError("Invalid bounds")
        with self.opened(args.get("path")) as obj:
            if obj.size > 4 * 1024 * 1024:
                return json.dumps({"error":"File exceeds the 4 MiB read limit", "truncated":True})
            lines = obj.bytes(4 * 1024 * 1024).decode("utf-8-sig").splitlines()
            text = "\n".join(lines[offset - 1:offset - 1 + limit])
            return json.dumps({"content": text[:60000], "truncated":
                               len(text) > 60000 or offset - 1 + limit < len(lines)}, ensure_ascii=False)

    def search(self, args):
        if type(args) is not dict or set(args) - {"path", "pattern", "target", "limit"}:
            raise ValueError("Invalid arguments")
        pattern, target, limit = args.get("pattern"), args.get("target", "content"), args.get("limit", 50)
        if type(pattern) is not str or not 1 <= len(pattern) <= 200 or target not in {"files", "content"}:
            raise ValueError("Invalid literal search")
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("Invalid limit")
        with self.opened(args.get("path", str(self.cwd))) as root:
            todo = [root.path]
        visited, matches, truncated = 0, [], False
        while todo:
            path = todo.pop()
            visited += 1
            if visited > 2000:
                truncated = True
                break
            try:
                # Directory links are pruned before enumeration, including empty directories.
                info = path.lstat()
                if info.st_file_attributes & 0x400:
                    continue
                with self.opened(str(path)) as obj:
                    if obj.directory:
                        with os.scandir(obj.path) as entries:
                            for entry in entries:
                                if len(todo) + visited >= 2000:
                                    truncated = True
                                    break
                                todo.append(Path(entry.path))
                        continue
                    if target == "content" and obj.size > 4 * 1024 * 1024:
                        truncated = True
                        continue
                    hit = pattern in obj.path.name if target == "files" else pattern in obj.bytes(4 * 1024 * 1024).decode("utf-8-sig")
                    if hit:
                        name = str(obj.path)
                        if sum(len(m) for m in matches) + len(name) > 60000:
                            truncated = True
                            break
                        matches.append(name)
                    if len(matches) >= limit:
                        truncated = True
                        break
            except (OSError, ValueError, UnicodeError):
                truncated = True
                continue
        return json.dumps({"matches": matches, "truncated": truncated, "visited": min(visited, 2000)})

    def skill(self, args):
        if type(args) is not dict or set(args) - {"name", "file_path"}:
            raise ValueError("Invalid arguments")
        name, support = args.get("name"), args.get("file_path", "SKILL.md")
        if type(name) is not str or not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", name):
            raise ValueError("Invalid skill")
        if type(support) is not str or Path(support).is_absolute() or ":" in support or ".." in Path(support).parts:
            raise ValueError("Invalid support file")
        root = self.copied / "skills" / name
        with self.opened(str(root / support)) as obj:
            if not obj.path.is_relative_to(root):
                raise PermissionError("Skill escape")
            raw = obj.bytes(4 * 1024 * 1024).decode("utf-8-sig")
            return json.dumps({"content": raw[:60000], "truncated": len(raw) > 60000}, ensure_ascii=False)
