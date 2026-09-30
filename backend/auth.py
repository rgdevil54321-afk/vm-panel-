import os
from typing import Optional

from fastapi import Depends, Header, HTTPException

from store import get_conn, now_ts


def get_api_key(
    authorization: Optional[str] = Header(None),
    x_api_key: Optional[str] = Header(None),
) -> Optional[str]:
    if authorization and authorization.startswith("Bearer "):
        return authorization[7:]
    return x_api_key


def validate_api_key(api_key: Optional[str]) -> bool:
    if not api_key:
        return False
    conn = get_conn()
    row = conn.execute(
        "SELECT is_active, expires_at FROM api_keys WHERE id = ?",
        (api_key,),
    ).fetchone()
    conn.close()
    if not row or not row["is_active"]:
        return False
    if row["expires_at"] and now_ts() > row["expires_at"]:
        return False
    return True


def require_api_key(api_key: Optional[str] = Depends(get_api_key)) -> Optional[str]:
    if os.getenv("REQUIRE_API_KEY", "false").lower() != "true":
        return None
    if not validate_api_key(api_key):
        raise HTTPException(status_code=401, detail="Invalid API key")
    return api_key


def require_admin(x_admin_token: Optional[str] = Header(None)) -> None:
    expected = os.getenv("ADMIN_TOKEN", "vlix-admin-token")
    if not x_admin_token or x_admin_token != expected:
        raise HTTPException(status_code=403, detail="Invalid admin token")
