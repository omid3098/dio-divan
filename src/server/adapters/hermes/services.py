"""Fixed read services. No caller can choose a server, executable, path, or secret."""
import json
import os
import subprocess
import urllib.request
import threading


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("Service redirect refused")


def memory_client(service):
    opener = urllib.request.build_opener(NoRedirect())
    session = None
    protocol = "2024-11-05"
    initialized = False
    failed = False
    lock = threading.Lock()
    def post(payload):
        nonlocal session
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": protocol,
                   "Authorization": "Bearer " + os.environ[service["headerEnv"]]}
        if session:
            headers["Mcp-Session-Id"] = session
        req = urllib.request.Request(service["url"], json.dumps(payload).encode(), headers)
        with opener.open(req, timeout=5) as response:
            session = response.headers.get("Mcp-Session-Id", session)
            if session and (len(session) > 512 or any(ord(char) < 33 for char in session)):
                raise ValueError("Invalid service session")
            data = response.read(128 * 1024 + 1)
        if len(data) > 128 * 1024:
            raise ValueError("Service response too large")
        if 'id' not in payload:
            return None
        if data.startswith(b"data:"):
            records = [json.loads(line[5:].strip()) for line in data.splitlines() if line.startswith(b"data:")]
            return next(value for value in records if value.get('id') == payload['id'])
        return json.loads(data)
    def call(payload):
        nonlocal initialized, failed, protocol
        with lock:
            if failed:
                raise ValueError("Service unavailable")
            try:
                if not initialized:
                    value = post({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"Divan","version":"1"}}})
                    if "error" in value:
                        raise ValueError("Service unavailable")
                    protocol = value.get('result',{}).get('protocolVersion',protocol)
                    if protocol not in {"2024-11-05","2025-03-26","2025-06-18","2025-11-25"}:
                        raise ValueError("Unsupported protocol")
                    post({"jsonrpc":"2.0","method":"notifications/initialized"})
                    initialized = True
                return post(payload)
            except Exception:
                failed = True
                raise ValueError("Service unavailable") from None
    return call


def bindings(policy):
    from windows import protected
    result = {}
    for server, service in policy.get("services", {}).items():
        if server not in {"memory", "t3", "hermes_history"}:
            raise ValueError("Unsupported service")
        if server != "memory":
            protected(service["command"], directory=False)
            protected(service["args"][-1], directory=False)
        http = memory_client(service) if server == "memory" else None
        for tool, schema in service["tools"].items():
            name = "mcp_" + server + "_" + tool

            def call(args, _server=server, _service=service, _tool=tool, _schema=schema["parameters"], _http=http):
                import jsonschema
                jsonschema.validate(args, _schema)
                if len(json.dumps(args).encode()) > 16384:
                    raise ValueError("Request too large")
                request = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": _tool, "arguments": args}}
                if _server == "memory":
                    value = _http(request)
                else:
                    env = {key: value for key, value in os.environ.items()
                           if key.upper() in {"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"}}
                    env.update(_service["env"])
                    child = subprocess.Popen([_service["command"], *_service["args"]], env=env,
                                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                             creationflags=0x08000000)
                    try:
                        init = {"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "Divan", "version": "1"}}}
                        output, _ = child.communicate((json.dumps(init) + "\n" + json.dumps(request) + "\n").encode(), timeout=6)
                        if child.returncode != 0 or len(output) > 128 * 1024:
                            raise ValueError("Service unavailable")
                        value = next(value for line in output.splitlines() if (value := json.loads(line)).get("id") == 1)
                    finally:
                        if child.poll() is None:
                            child.kill()
                        child.wait()
                if "error" in value:
                    raise ValueError("Service unavailable")
                return json.dumps(value["result"], ensure_ascii=False)
            result[name] = (call, server, {"name": name, **schema})
    return result
