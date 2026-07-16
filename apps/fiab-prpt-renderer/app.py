"""CSA Loom paginated-report renderer — ACA host.

Same HTTP contract as the Azure Functions variant (POST /api/render,
GET /api/health) so LOOM_PAGINATED_RENDER_URL points here unchanged. Runs as an
internal-ingress Container App inside the CAE VNet — the Console BFF is the
only caller. Optional shared key: when RENDER_KEY is set, /api/render requires
a matching ?code= (mirrors the Function-key contract the Console client already
speaks); leave unset for internal-ingress deployments.
"""

from __future__ import annotations

import os

from flask import Flask, jsonify, request

from renderer_core import _MIME, _RENDERERS

app = Flask(__name__)

_RENDER_KEY = os.environ.get("RENDER_KEY", "")


@app.get("/api/health")
def health():
    return jsonify({"ok": True, "service": "paginated-report-renderer", "host": "aca"})


@app.post("/api/render")
def render():
    if _RENDER_KEY and request.args.get("code") != _RENDER_KEY:
        return jsonify({"ok": False, "error": "invalid or missing key"}), 401

    body = request.get_json(silent=True)
    if body is None:
        return jsonify({"ok": False, "error": "invalid json body"}), 400

    definition = body.get("definition")
    fmt = (body.get("format") or "pdf").lower()
    if not isinstance(definition, dict):
        return jsonify({"ok": False, "error": "definition object required"}), 400
    if fmt not in _RENDERERS:
        return jsonify({"ok": False, "error": f"unsupported format '{fmt}' (pdf|xlsx|docx)"}), 400
    if not definition.get("tablixes"):
        return jsonify({"ok": False, "error": "report has no tablix to render"}), 400

    try:
        data = _RENDERERS[fmt](definition)
    except Exception as exc:  # noqa: BLE001 — surface render failure with detail
        app.logger.exception("render failed (format=%s)", fmt)
        return jsonify({"ok": False, "error": f"render failed: {exc}"}), 500

    name = definition.get("name") or "report"
    safe = "".join(c if (c.isalnum() or c in "._-") else "_" for c in name)[:80] or "report"
    return app.response_class(
        data,
        status=200,
        mimetype=_MIME[fmt],
        headers={"Content-Disposition": f'attachment; filename="{safe}.{fmt}"'},
    )
