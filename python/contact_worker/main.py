"""One-request-at-a-time JSON Lines boundary for local parsing."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import TextIO

from .parser import FRAME_LIMIT, ParseError, parse
from .diagnostics import emit


def _send(stream: TextIO, frame: dict) -> None:
    encoded = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > FRAME_LIMIT:
        raise ParseError("FRAME_TOO_LARGE")
    stream.write(encoded + "\n")
    stream.flush()


def _request(line: str) -> tuple[str, dict]:
    if len(line.encode("utf-8")) > FRAME_LIMIT:
        raise ParseError("FRAME_TOO_LARGE")
    try:
        data = json.loads(line)
    except (ValueError, TypeError) as error:
        raise ParseError("INVALID_REQUEST") from error
    if not isinstance(data, dict):
        raise ParseError("INVALID_REQUEST")
    request_id = data.get("request_id")
    if (data.get("version") != 1 or not isinstance(request_id, str)
            or not 1 <= len(request_id) <= 128):
        raise ParseError("INVALID_REQUEST")
    if data.get("op") != "parse":
        raise ParseError("INVALID_OPERATION")
    payload = data.get("payload")
    if not isinstance(payload, dict) or set(payload) != {"path", "file_type", "document_id", "limits"}:
        raise ParseError("INVALID_REQUEST")
    if not isinstance(payload["path"], str) or not Path(payload["path"]).is_absolute():
        raise ParseError("INVALID_PATH")
    if (not isinstance(payload["document_id"], str)
            or not 1 <= len(payload["document_id"]) <= 128
            or not isinstance(payload["file_type"], str)
            or not isinstance(payload["limits"], dict)):
        raise ParseError("INVALID_REQUEST")
    return request_id, payload


def serve(stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout,
          stderr: TextIO = sys.stderr) -> None:
    for line in stdin:
        request_id = ""
        try:
            request_id, payload = _request(line)
            blocks = parse(payload["path"], payload["file_type"], payload["document_id"],
                           payload["limits"], request_id=request_id)
            for block in blocks:
                _send(stdout, {"version": 1, "request_id": request_id,
                               "kind": "block", "block": block})
            _send(stdout, {"version": 1, "request_id": request_id,
                           "kind": "done", "block_count": len(blocks), "warning_codes": []})
        except ParseError as error:
            code = str(error)
            emit(error, stderr)
            _send(stdout, {"version": 1, "request_id": request_id, "kind": "error",
                           "error": {"code": code, "message": code}})
            stderr.write(code + "\n")
        except Exception as error:
            emit(error, stderr)
            _send(stdout, {"version": 1, "request_id": request_id, "kind": "error",
                           "error": {"code": "INTERNAL_ERROR", "message": "INTERNAL_ERROR"}})
            stderr.write("INTERNAL_ERROR\n")


if __name__ == "__main__":
    serve()
