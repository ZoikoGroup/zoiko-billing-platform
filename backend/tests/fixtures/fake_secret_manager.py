"""
tests/fixtures/fake_secret_manager.py
-------------------------------------
An in-memory stand-in for google.cloud.secretmanager's client (Phase 4d-0).
No real GCP in CI. It keeps secrets, labels and versions with their states,
records every call, and raises the real google.api_core exception types on
request (``fail["access"] = PermissionDenied("...")``).
"""
from types import SimpleNamespace

from google.api_core import exceptions as gexc


class FakeSecretManager:
    def __init__(self):
        self.secrets: dict = {}            # name -> {"labels": {}, "replication": {}, "versions": {n: {...}}}
        self.calls: list = []
        self.fail: dict = {}               # operation -> exception instance

    def _maybe_fail(self, op):
        self.calls.append(op)
        if op in self.fail:
            raise self.fail[op]
        if "*" in self.fail:
            raise self.fail["*"]

    def _secret(self, name):
        secret = self.secrets.get(name)
        if secret is None:
            raise gexc.NotFound(f"secret {name.rsplit('/', 1)[-1]} not found")
        return secret

    @staticmethod
    def _split(version_name):
        secret, _, number = version_name.rpartition("/versions/")
        return secret, number

    # ── API surface used by GcpSecretManagerStore / config_secret ──
    def create_secret(self, request):
        self._maybe_fail("create")
        name = f"{request['parent']}/secrets/{request['secret_id']}"
        if name in self.secrets:
            raise gexc.AlreadyExists("secret exists")
        self.secrets[name] = {"labels": dict(request["secret"].get("labels") or {}),
                              "replication": request["secret"]["replication"], "versions": {}}
        return SimpleNamespace(name=name)

    def get_secret(self, request):
        self._maybe_fail("get")
        secret = self._secret(request["name"])
        return SimpleNamespace(name=request["name"], labels=dict(secret["labels"]))

    def add_secret_version(self, request):
        self._maybe_fail("add")
        secret = self._secret(request["parent"])
        number = str(len(secret["versions"]) + 1)
        secret["versions"][number] = {"data": request["payload"]["data"], "state": "ENABLED"}
        return SimpleNamespace(name=f"{request['parent']}/versions/{number}")

    def access_secret_version(self, request):
        self._maybe_fail("access")
        name, number = self._split(request["name"])
        secret = self._secret(name)
        if number == "latest":
            number = max((n for n, v in secret["versions"].items() if v["state"] == "ENABLED"), key=int)
        version = secret["versions"].get(number)
        if version is None or version["state"] != "ENABLED":
            raise gexc.FailedPrecondition(f"version {number} is not enabled")
        return SimpleNamespace(name=request["name"], payload=SimpleNamespace(data=version["data"]))

    def disable_secret_version(self, request):
        self._maybe_fail("disable")
        name, number = self._split(request["name"])
        self._secret(name)["versions"][number]["state"] = "DISABLED"

    def destroy_secret_version(self, request):
        self._maybe_fail("destroy")
        name, number = self._split(request["name"])
        version = self._secret(name)["versions"][number]
        version["state"], version["data"] = "DESTROYED", b""

    def list_secret_versions(self, request):
        self._maybe_fail("list")
        secret = self._secret(request["parent"])
        return [SimpleNamespace(name=f"{request['parent']}/versions/{n}", state=SimpleNamespace(name=v["state"]))
                for n, v in secret["versions"].items()]

    # ── helpers for assertions ──
    def states(self, name) -> dict:
        return {n: v["state"] for n, v in self.secrets[name]["versions"].items()}

    def add_key(self, project, secret_id, value: str) -> str:
        name = f"projects/{project}/secrets/{secret_id}"
        self.secrets[name] = {"labels": {}, "replication": {"automatic": {}}, "versions": {}}
        self.add_secret_version({"parent": name, "payload": {"data": value.encode()}})
        self.calls.clear()
        return f"{name}/versions/latest"
