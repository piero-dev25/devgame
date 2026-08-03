"""
epp/config.py — token + endpoint resolution, and the pairing-token redeem
HTTP call.

The frozen spec (docs/workbench/spec-unreal-publisher.md — see the job
scratch dir referenced in the build brief) listed this as an "open
dependency": it could not find the redeem endpoint by grep and flagged it
as shared, unresolved, blocking work for both the Unity and Unreal
publishers. THAT IS NOW RESOLVED, not re-guessed, against three primary
sources read directly out of this repo:

  1. packages/contracts/src/auth.ts — `AuthTokenExchangeRequest`, piped
     through `HttpApiSchema.asFormUrlEncoded()`. The body is
     application/x-www-form-urlencoded, not JSON.
  2. packages/client-runtime/src/authorization/remote.ts —
     `bootstrapRemoteBearerSession` shows the exact field set a real T3
     client sends to `POST {base}/oauth/token`.
  3. unity/com.ironmind.editor-presence/Editor/EditorPresenceSettings.cs —
     the sibling Unity publisher already implements this exact flow
     (`RedeemPairingCredential`), confirming the design in (1)/(2) was
     already built and reviewed for an EPP publisher, not just theorized.

No `unreal` import — `urllib.request` is used for the HTTP call so this
stays pure stdlib and directly unit-testable (unreal/tests/test_config.py
injects a fake `http_post`, never touching the network).
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, Optional

TOKEN_ENV_VAR = "T3_EDITOR_PRESENCE_TOKEN"
URL_ENV_VAR = "T3_EDITOR_PRESENCE_URL"
DEFAULT_WS_URL = "ws://127.0.0.1:3777/editor-presence?role=publisher"
TOKEN_FILE_RELATIVE_PARTS = ("Saved", "EditorPresence", "token.txt")

# Mirrors packages/contracts/src/auth.ts verbatim. These are wire-protocol
# string constants the server checks with `Schema.Literal(...)`, not
# implementation details — Python obviously cannot import the .ts module, so
# hardcoding them here (rather than, say, re-deriving them) is the only
# option, and it is the correct one: a change to any of these three strings
# server-side is a protocol break for every non-TypeScript client, not just
# this one, so keeping them as three named constants (rather than inlined
# literals) is what makes that break a one-line diff to find here.
GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange"
SUBJECT_TOKEN_TYPE = "urn:t3:params:oauth:token-type:environment-bootstrap"
REQUESTED_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token"


class RedeemError(Exception):
    """Raised with a human-readable message suitable for the status
    indicator's tooltip and the Output Log — never a raw exception repr."""


def resolve_token(*, env: Optional[dict] = None, token_file_path: Optional[str] = None) -> Optional[str]:
    """Env var wins over the on-disk file (spec step 5's resolution order).
    The env var path is documented as "must already be a redeemed bearer
    session token" — no auto-redeem is attempted for it, unlike the file
    path (see `redeem_and_store_from_token_file`), to keep this one function
    simple and its behavior fully predictable for a power-user / CI use."""
    env = os.environ if env is None else env
    from_env = env.get(TOKEN_ENV_VAR, "").strip()
    if from_env:
        return from_env
    if token_file_path and os.path.isfile(token_file_path):
        with open(token_file_path, "r", encoding="utf-8") as f:
            for line in f:
                stripped = line.strip()
                if stripped:
                    return stripped
    return None


def resolve_ws_url(*, env: Optional[dict] = None) -> str:
    env = os.environ if env is None else env
    return env.get(URL_ENV_VAR, "").strip() or DEFAULT_WS_URL


def ws_url_to_http_base(ws_url: str) -> str:
    """`ws://host:port/editor-presence?role=publisher` ->
    `http://host:port` — the base the `/oauth/token` redeem POST and the
    "open token folder" affordance both need. Derived rather than
    separately configured so there is exactly one endpoint setting to get
    wrong, not two that can drift apart."""
    parts = urllib.parse.urlsplit(ws_url)
    scheme = "https" if parts.scheme == "wss" else "http"
    netloc = parts.netloc
    return f"{scheme}://{netloc}"


def default_token_file_path(project_dir: str) -> str:
    return os.path.join(project_dir, *TOKEN_FILE_RELATIVE_PARTS)


def extract_pairing_credential(pasted_input: str) -> str:
    """Mirrors Unity's `ExtractCredential`: `t3 pair`
    (apps/server/src/cli/pair.ts) prints either a bare credential or a full
    pairing URL with the credential in a `#token=` fragment
    (`EnvironmentAuth.issueStartupPairingUrl`). Accept either — whichever
    the user pastes into token.txt."""
    trimmed = (pasted_input or "").strip()
    if not trimmed:
        return ""
    marker = "token="
    idx = trimmed.find(marker)
    if idx == -1:
        return trimmed
    value = trimmed[idx + len(marker) :]
    for sep in ("&", "#"):
        cut = value.find(sep)
        if cut != -1:
            value = value[:cut]
    return urllib.parse.unquote(value)


def _default_http_post(url: str, form_fields: dict, timeout_s: float) -> dict:
    data = urllib.parse.urlencode(form_fields).encode("ascii")
    request = urllib.request.Request(
        url, data=data, method="POST", headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    with urllib.request.urlopen(request, timeout=timeout_s) as response:  # noqa: S310 - fixed local/paired server
        body = response.read().decode("utf-8")
    return json.loads(body)


def redeem_pairing_credential(
    pasted_input: str,
    *,
    base_http_url: str,
    client_label: str = "Unreal Editor",
    http_post: Callable[[str, dict, float], dict] = _default_http_post,
    timeout_s: float = 10.0,
) -> str:
    """Exchanges a pasted `t3 pair` credential for a long-lived bearer
    session token, POSTing `application/x-www-form-urlencoded` to
    `{base_http_url}/oauth/token` exactly as
    packages/client-runtime/src/authorization/remote.ts's
    `bootstrapRemoteBearerSession` does. Returns the `access_token` string,
    or raises `RedeemError` with a human-readable message on any failure."""
    credential = extract_pairing_credential(pasted_input)
    if not credential:
        raise RedeemError("Could not find a pairing token in the pasted text.")

    url = base_http_url.rstrip("/") + "/oauth/token"
    fields = {
        "grant_type": GRANT_TYPE,
        "subject_token": credential,
        "subject_token_type": SUBJECT_TOKEN_TYPE,
        "requested_token_type": REQUESTED_TOKEN_TYPE,
        "client_label": client_label,
    }
    try:
        response = http_post(url, fields, timeout_s)
    except urllib.error.HTTPError as e:
        raise RedeemError(f"Server rejected the pairing token (HTTP {e.code}).") from e
    except urllib.error.URLError as e:
        raise RedeemError(f"Could not reach {url}: {e.reason}") from e
    except (ValueError, OSError) as e:
        raise RedeemError(f"Could not talk to {url}: {e}") from e

    access_token = response.get("access_token") if isinstance(response, dict) else None
    if not access_token:
        raise RedeemError("Server response did not include an access token.")
    return access_token


def write_token_file(project_dir: str, token: str) -> str:
    path = default_token_file_path(project_dir)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(token.strip() + "\n")
    return path


def read_token_file_raw(project_dir: str) -> str:
    path = default_token_file_path(project_dir)
    if not os.path.isfile(path):
        return ""
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            stripped = line.strip()
            if stripped:
                return stripped
    return ""


def redeem_and_store_from_token_file(
    project_dir: str,
    *,
    base_http_url: str,
    http_post: Callable[[str, dict, float], dict] = _default_http_post,
) -> str:
    """The "Pair" menu action's implementation (spec step 6 / README
    install step 6). Semantics mirror the Unity flow exactly, just via a
    file instead of a text field: `token.txt` initially holds whatever the
    user pasted fresh from `t3 pair` (a pairing credential, or a pairing
    URL); this treats that content AS a pairing credential, redeems it, and
    OVERWRITES the file with the resulting long-lived bearer session token.
    From then on `token.txt` holds a bearer token directly, and
    `resolve_token` reads it as such — no ambiguity between the two roles
    at any single point in time, and no heuristic guessing about which kind
    of string is currently in the file.

    Raises `RedeemError` (propagated from `redeem_pairing_credential`) on
    failure, leaving the file untouched so the user can see what they
    pasted and try again."""
    raw = read_token_file_raw(project_dir)
    if not raw:
        raise RedeemError("token.txt is empty. Run `t3 pair` and paste the printed token or URL into it.")
    access_token = redeem_pairing_credential(raw, base_http_url=base_http_url, http_post=http_post)
    write_token_file(project_dir, access_token)
    return access_token
