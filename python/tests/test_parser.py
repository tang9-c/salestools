from pathlib import Path
from types import SimpleNamespace

import pytest

from contact_worker.parser import ParseError, parse, split_block


FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "contact-documents"


def fake_converter(*items):
    return lambda path: SimpleNamespace(texts=list(items), tables=[])


def item(text, page=None, ref="#/texts/0"):
    prov = [] if page is None else [SimpleNamespace(page_no=page)]
    return SimpleNamespace(text=text, prov=prov, self_ref=ref)


def test_pdf_blocks_keep_real_page_number():
    blocks = parse(FIXTURES / "synthetic-resume.pdf", "pdf", "document-1",
                   converter=fake_converter(item("林想", 1), item("阿尔法公司", 2, "#/texts/1")))
    assert len(blocks) == 2
    assert blocks[1]["page"] == 2
    assert blocks[1]["source_ref"] == "#/texts/1"


def test_missing_provenance_omits_page():
    blocks = parse(FIXTURES / "synthetic-resume.pdf", "pdf", "document-1",
                   converter=fake_converter(item("林想")))
    assert "page" not in blocks[0]


def test_multi_page_item_splits_only_at_verified_charspans():
    text = "First page Second page"
    merged = item(text, ref="#/texts/0")
    merged.prov = [SimpleNamespace(page_no=1, charspan=(0, 10)),
                   SimpleNamespace(page_no=2, charspan=(11, len(text)))]
    blocks = parse(FIXTURES / "synthetic-resume.pdf", "pdf", "document-1",
                   converter=fake_converter(merged))
    assert [block["page"] for block in blocks] == [1, 2]
    assert "".join(block["text"] for block in blocks) == text
    assert all(block["source_ref"] == "#/texts/0" for block in blocks)


def test_png_card_uses_image_conversion_path():
    seen = []
    def convert(path):
        seen.append(path)
        return fake_converter(item("虚构联系人 叶青", 1))(path)
    blocks = parse(FIXTURES / "synthetic-card.png", "png", "document-2", converter=convert)
    assert seen == [FIXTURES / "synthetic-card.png"]
    assert blocks[0]["text"] == "虚构联系人 叶青"


def test_rejects_oversized_image_before_conversion(tmp_path):
    from PIL import Image
    path = tmp_path / "large.png"
    Image.new("RGB", (101, 101)).save(path)
    with pytest.raises(ParseError, match="IMAGE_PIXELS_EXCEEDED"):
        parse(path, "png", "doc", limits={"max_page_pixels": 10_000},
              converter=lambda _: pytest.fail("conversion must not happen"))


def test_pillow_decompression_bomb_is_reported_as_pixel_limit(tmp_path, monkeypatch):
    from PIL import Image
    path = tmp_path / "large.png"
    Image.new("RGB", (101, 101)).save(path)
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 100)
    with pytest.raises(ParseError, match="IMAGE_PIXELS_EXCEEDED"):
        parse(path, "png", "doc", converter=lambda _: pytest.fail("conversion must not happen"))


def test_rejects_pdf_over_page_limit_before_conversion():
    with pytest.raises(ParseError, match="PDF_PAGE_LIMIT"):
        parse(FIXTURES / "synthetic-resume.pdf", "pdf", "doc",
              limits={"max_pages": 1}, converter=lambda _: pytest.fail("conversion must not happen"))


def test_rejects_malformed_input_and_type_mismatch(tmp_path):
    path = tmp_path / "bad.pdf"
    path.write_bytes(b"not a PDF")
    with pytest.raises(ParseError):
        parse(path, "pdf", "doc", converter=lambda _: pytest.fail("conversion must not happen"))
    with pytest.raises(ParseError, match="INVALID_FILE_TYPE"):
        parse(FIXTURES / "synthetic-card.png", "pdf", "doc", converter=lambda _: None)


def test_split_oversized_utf8_block_preserves_content_and_source():
    original = {"block_id": "doc:0", "text": "甲" * 100_000, "page": 2, "source_ref": "#/texts/1"}
    parts = split_block(original)
    assert len(parts) > 1
    assert "".join(part["text"] for part in parts) == original["text"]
    assert all(part["source_ref"] == original["source_ref"] and part["page"] == 2 for part in parts)
    assert len({part["block_id"] for part in parts}) == len(parts)
    assert all(len(part["text"].encode("utf-8")) < 256 * 1024 for part in parts)


def test_converter_output_never_reaches_worker_streams(capsys):
    import sys
    def noisy_converter(path):
        print("private parsed document", file=sys.stdout)
        print("private parsed document", file=sys.stderr)
        return fake_converter(item("safe"))(path)
    parse(FIXTURES / "synthetic-resume.pdf", "pdf", "doc", converter=noisy_converter)
    captured = capsys.readouterr()
    assert "private parsed document" not in captured.out + captured.err


def test_server_hard_limits_cannot_be_relaxed():
    from contact_worker.parser import _limits
    assert _limits({"max_pages": 999})["max_pages"] == 50
    assert _limits({"max_pages": 1})["max_pages"] == 1
    assert _limits({"max_page_pixels": 999_999_999})["max_page_pixels"] == 25_000_000
    assert _limits({"max_file_bytes": 999_999_999})["max_file_bytes"] == 20 * 1024 * 1024
    assert _limits({"max_temp_bytes": 999_999_999_999})["max_temp_bytes"] == 1024 ** 3


def test_conversion_scratch_is_bounded_and_removed():
    import os
    scratch = []
    def convert(path):
        temporary = Path(os.environ["TMPDIR"])
        scratch.append(temporary)
        (temporary / "intermediate").write_bytes(b"x" * 20)
        return fake_converter(item("safe"))(path)
    with pytest.raises(ParseError, match="TEMP_BYTES_EXCEEDED"):
        parse(FIXTURES / "synthetic-resume.pdf", "pdf", "doc",
              limits={"max_temp_bytes": 10}, converter=convert)
    assert not scratch[0].exists()


def test_invalid_multi_page_span_does_not_guess_page():
    merged = item("First Second", ref="#/texts/0")
    merged.prov = [SimpleNamespace(page_no=1, charspan=(0, 5)),
                   SimpleNamespace(page_no=2, charspan=(3, 12))]
    blocks = parse(FIXTURES / "synthetic-resume.pdf", "pdf", "document-1",
                   converter=fake_converter(merged))
    assert len(blocks) == 1
    assert "page" not in blocks[0]
