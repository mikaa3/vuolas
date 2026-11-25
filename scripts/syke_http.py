"""HTTP helper for SYKE APIs that includes the HARICA/GEANT intermediate CA."""

from __future__ import annotations

import tempfile
from pathlib import Path
import certifi
import requests

REPO_ROOT = Path(__file__).resolve().parent.parent
HARICA_INTERMEDIATE = REPO_ROOT / "certs" / "harica_geant_intermediate.pem"
_CA_BUNDLE_PATH: str | None = None


def get_syke_ca_bundle() -> str:
    """Return a CA bundle path containing certifi roots + HARICA GEANT TLS RSA 1 intermediate."""
    global _CA_BUNDLE_PATH
    if _CA_BUNDLE_PATH and Path(_CA_BUNDLE_PATH).exists():
        return _CA_BUNDLE_PATH

    base_pem = Path(certifi.where()).read_text(encoding="utf-8")
    if HARICA_INTERMEDIATE.exists():
        extra_pem = HARICA_INTERMEDIATE.read_text(encoding="utf-8")
        combined = Path(tempfile.gettempdir()) / "syke_certifi_bundle.pem"
        combined.write_text(base_pem + "\n" + extra_pem + "\n", encoding="utf-8")
        _CA_BUNDLE_PATH = str(combined)
    else:
        _CA_BUNDLE_PATH = certifi.where()
    return _CA_BUNDLE_PATH


def make_syke_session() -> requests.Session:
    session = requests.Session()
    session.verify = get_syke_ca_bundle()
    session.headers.update(
        {
            "Accept": "application/json",
            "User-Agent": "vuolas-river-flow-map/1.0 (+https://github.com; open-data CC-BY-4.0)",
        }
    )
    return session


def fetch_odata_all(odata_base: str, entity: str, params: dict | None = None) -> list[dict]:
    session = make_syke_session()
    rows: list[dict] = []
    url: str | None = f"{odata_base.rstrip('/')}/{entity}"
    cur_params = params
    while url:
        resp = session.get(url, params=cur_params, timeout=60)
        resp.raise_for_status()
        payload = resp.json()
        rows.extend(payload.get("value", []))
        url = payload.get("odata.nextLink") or payload.get("@odata.nextLink")
        cur_params = None
    return rows
