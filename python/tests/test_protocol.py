import io
import json

from contact_worker.main import serve


def test_malformed_request_is_sanitized():
    private_text = "secret-resume-text"
    out, err = io.StringIO(), io.StringIO()
    serve(io.StringIO(json.dumps({"version": 1, "request_id": "r", "op": "parse",
                                    "payload": {"path": private_text}}) + "\n"), out, err)
    frames = [json.loads(line) for line in out.getvalue().splitlines()]
    assert frames[0]["kind"] == "error"
    assert private_text not in err.getvalue()
    assert private_text not in out.getvalue()


def test_cancel_frame_is_rejected_without_processing():
    out, err = io.StringIO(), io.StringIO()
    serve(io.StringIO('{"version":1,"request_id":"r","op":"cancel","payload":{}}\n'), out, err)
    assert json.loads(out.getvalue())["error"]["code"] == "INVALID_OPERATION"


def test_large_input_frame_is_rejected():
    out, err = io.StringIO(), io.StringIO()
    serve(io.StringIO("x" * (256 * 1024 + 1) + "\n"), out, err)
    assert json.loads(out.getvalue())["error"]["code"] == "FRAME_TOO_LARGE"


def test_parse_emits_block_then_done(monkeypatch):
    from contact_worker import main
    monkeypatch.setattr(main, "parse", lambda *args, **kwargs: [
        {"block_id": "doc:0", "text": "Invented person", "page": 1, "source_ref": "#/texts/0"}])
    out, err = io.StringIO(), io.StringIO()
    request = {"version": 1, "request_id": "req-1", "op": "parse", "payload": {
        "path": "/tmp/node-owned.pdf", "file_type": "pdf", "document_id": "doc",
        "limits": {"max_pages": 50}}}
    serve(io.StringIO(json.dumps(request) + "\n"), out, err)
    frames = [json.loads(line) for line in out.getvalue().splitlines()]
    assert [frame["kind"] for frame in frames] == ["block", "done"]
    assert frames[0]["block"]["page"] == 1
    assert frames[1]["block_count"] == 1
    assert frames[1]["warning_codes"] == []
    assert err.getvalue() == ""


def test_converter_failure_never_logs_raw_text(monkeypatch):
    from contact_worker import main
    def fail(*args, **kwargs):
        raise RuntimeError("private parsed document")
    monkeypatch.setattr(main, "parse", fail)
    request = {"version": 1, "request_id": "req-2", "op": "parse", "payload": {
        "path": "/tmp/node-owned.pdf", "file_type": "pdf", "document_id": "doc", "limits": {}}}
    out, err = io.StringIO(), io.StringIO()
    serve(io.StringIO(json.dumps(request) + "\n"), out, err)
    assert json.loads(out.getvalue())["error"]["code"] == "INTERNAL_ERROR"
    assert "private parsed document" not in out.getvalue() + err.getvalue()
