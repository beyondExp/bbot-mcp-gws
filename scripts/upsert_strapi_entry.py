import asyncio
import os
import sys
from typing import Any, Dict


def _require(name: str) -> str:
    val = (os.getenv(name) or "").strip()
    if not val:
        raise SystemExit(f"Missing required env var: {name}")
    return val


async def main() -> int:
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        print("Usage: python scripts/upsert_strapi_entry.py <github_repo_url>", file=sys.stderr)
        return 2

    repo_url = sys.argv[1].strip()

    # Ensure Strapi env vars exist (StrapiService reads them at import time)
    _require("STRAPI_API_URL")
    _require("STRAPI_API_KEY")

    # Import after env check so StrapiService sees env vars.
    # This relies on running from the BBotMainApi environment where app/ is importable.
    try:
        from app.services.strapi_mcp_catalog_service import StrapiMcpCatalogService  # type: ignore
    except Exception:
        # Fallback: allow running from repo root by adding BBotMainApi to path.
        sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "BBotMainApi")))
        from app.services.strapi_mcp_catalog_service import StrapiMcpCatalogService  # type: ignore

    normalized: Dict[str, Any] = {
        "source_id": "bbot/mcp-gws",
        "name": "Google Workspace (gws)",
        "description": "Google Workspace via googleworkspace/cli (gws) wrapped as an MCP server (E2B launch).",
        "repo_url": repo_url,
        "categories": ["gcp", "google workspace", "productivity"],
        "mcp_catalog": {
            "config": [],
            "secrets": [
                {
                    "name": "Service account JSON (base64)",
                    "env": "GOOGLE_APPLICATION_CREDENTIALS_JSON_BASE64",
                    "required": True,
                    "description": "Base64-encoded Google service account JSON. The server materializes it to GOOGLE_APPLICATION_CREDENTIALS at runtime.",
                }
            ],
            "env": [],
            "oauth": {},
        },
        "mcp_launch": {
            "command": "npm",
            "args": ["run", "start:mcp"],
            "env": {},
            "source": {
                "type": "git",
                "url": repo_url,
                "subdir": "mcp-gws",
                "install": "npm ci",
            },
        },
        "icon_url": "https://www.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png",
    }

    raw = {"source": "bbot", "repo_url": repo_url}

    strapi = StrapiMcpCatalogService()
    status, entry_id = await strapi.upsert_entry("curated", normalized, raw)
    print({"status": status, "entry_id": entry_id})
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

