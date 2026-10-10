"""Preflight local files, convert with Docling, and retain item provenance."""

from __future__ import annotations

import json
import math
import os
import errno
import resource
import signal
import tempfile
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Any, Callable

from .diagnostics import phase

from PIL import Image, UnidentifiedImageError
from pypdf import PdfReader


FRAME_LIMIT = 256 * 1024
DEFAULT_LIMITS = {
    "max_file_bytes": 20 * 1024 * 1024,
    "max_pages": 50,
    "max_page_pixels": 25_000_000,
    "max_temp_bytes": 1024 * 1024 * 1024,
}
FORMATS = {"pdf": b"%PDF-", "png": b"\x89PNG\r\n\x1a\n", "jpg": b"\xff\xd8\xff"}


class ParseError(Exception):
    """An error code safe to send over the process protocol."""


def _limits(overrides: dict[str, int] | None) -> dict[str, int]:
    result = DEFAULT_LIMITS.copy()
    for key, value in (overrides or {}).items():
        if key not in result or isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise ParseError("INVALID_LIMIT")
        result[key] = min(value, result[key])
    return result


def preflight(path: Path, file_type: str, limits: dict[str, int] | None = None) -> None:
    bounds = _limits(limits)
    if file_type not in FORMATS:
        raise ParseError("INVALID_FILE_TYPE")
    if not path.is_file() or path.is_symlink():
        raise ParseError("INVALID_PATH")
    size = path.stat().st_size
    if size < 1 or size > bounds["max_file_bytes"]:
        raise ParseError("FILE_SIZE_EXCEEDED")
    with path.open("rb") as stream:
        if not stream.read(len(FORMATS[file_type])).startswith(FORMATS[file_type]):
            raise ParseError("INVALID_FILE_TYPE")
    if file_type == "pdf":
        try:
            reader = PdfReader(str(path), strict=True)
            if reader.is_encrypted:
                raise ParseError("ENCRYPTED_PDF")
            if len(reader.pages) > bounds["max_pages"]:
                raise ParseError("PDF_PAGE_LIMIT")
            if not reader.pages:
                raise ParseError("INVALID_DOCUMENT")
            for page in reader.pages:
                width = float(page.mediabox.width)
                height = float(page.mediabox.height)
                if not math.isfinite(width) or not math.isfinite(height) or width <= 0 or height <= 0:
                    raise ParseError("INVALID_DOCUMENT")
                # Docling's images_scale is explicitly fixed at 1.0 below.
                if math.ceil(width) * math.ceil(height) > bounds["max_page_pixels"]:
                    raise ParseError("IMAGE_PIXELS_EXCEEDED")
        except ParseError:
            raise
        except Exception as error:
            raise ParseError("INVALID_DOCUMENT") from error
    else:
        try:
            with Image.open(path) as image:
                if image.format != file_type.upper().replace("JPG", "JPEG"):
                    raise ParseError("INVALID_FILE_TYPE")
                if image.width * image.height > bounds["max_page_pixels"]:
                    raise ParseError("IMAGE_PIXELS_EXCEEDED")
                image.verify()
        except ParseError:
            raise
        except Image.DecompressionBombError as error:
            raise ParseError("IMAGE_PIXELS_EXCEEDED") from error
        except (UnidentifiedImageError, OSError, ValueError) as error:
            raise ParseError("INVALID_DOCUMENT") from error


def convert_local(path: Path) -> Any:
    phase("dependencies_loading")
    from docling.datamodel.base_models import InputFormat, ConversionStatus
    from docling.datamodel.pipeline_options import PdfPipelineOptions, NativePdfPipelineOptions
    from docling.document_converter import DocumentConverter, ImageFormatOption, PdfFormatOption

    from docling.pipeline.native_pdf_pipeline import NativePdfPipeline

    phase("dependencies_loaded")
    options = PdfPipelineOptions()
    options.do_ocr = True
    options.images_scale = 1.0
    options.generate_page_images = False
    options.generate_picture_images = False
    phase("converter_initializing")
    converter = DocumentConverter(format_options={
        InputFormat.PDF: PdfFormatOption(
            pipeline_cls=NativePdfPipeline,
            pipeline_options=NativePdfPipelineOptions(
                parser_threads=1, generate_page_images=False, generate_picture_images=False)),
        InputFormat.IMAGE: ImageFormatOption(pipeline_options=options),
    })
    phase("converter_initialized")
    phase("conversion_started")
    result = converter.convert(str(path))
    if result.status != ConversionStatus.SUCCESS:
        raise ParseError("CONVERSION_FAILED")
    document = result.document
    # Upload paths are UUIDs with no extension; inspect the already validated signature.
    with path.open("rb") as source:
        is_pdf = source.read(5) == b"%PDF-"
    if is_pdf:
        expected_pages = set(range(1, len(PdfReader(str(path)).pages) + 1))
        if set(document.pages) != expected_pages:
            raise ParseError("CONVERSION_FAILED")
        text_pages = {prov.page_no for item, _ in document.iterate_items()
                      if isinstance(getattr(item, "text", None), str) and item.text.strip()
                      for prov in getattr(item, "prov", [])}
        # Native extraction cannot establish coverage of a page without text.
        if not expected_pages.issubset(text_pages):
            raise ParseError("PDF_TEXT_UNAVAILABLE")
    phase("conversion_completed")
    return document


def _scratch_bytes(path: Path) -> int:
    total = 0
    for directory, _, names in os.walk(path):
        for name in names:
            try:
                total += (Path(directory) / name).stat().st_size
            except FileNotFoundError:
                continue
    return total


@contextmanager
def _watch_scratch(path: Path, max_bytes: int):
    """Interrupt conversion as soon as the dedicated worker samples an overage."""
    previous_handler = signal.getsignal(signal.SIGALRM)
    previous_timer = signal.getitimer(signal.ITIMER_REAL)
    previous_file_handler = signal.getsignal(signal.SIGXFSZ)
    previous_file_limit = resource.getrlimit(resource.RLIMIT_FSIZE)

    def check_budget(_signum, _frame):
        if _scratch_bytes(path) > max_bytes:
            raise ParseError("TEMP_BYTES_EXCEEDED")

    def file_limit_exceeded(_signum, _frame):
        raise ParseError("TEMP_BYTES_EXCEEDED")

    try:
        signal.signal(signal.SIGALRM, check_budget)
        signal.signal(signal.SIGXFSZ, file_limit_exceeded)
        old_soft, old_hard = previous_file_limit
        file_cap = max_bytes if old_soft == resource.RLIM_INFINITY else min(max_bytes, old_soft)
        resource.setrlimit(resource.RLIMIT_FSIZE, (file_cap, old_hard))
        signal.setitimer(signal.ITIMER_REAL, 0.05, 0.05)
        yield
        check_budget(None, None)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        resource.setrlimit(resource.RLIMIT_FSIZE, previous_file_limit)
        signal.signal(signal.SIGALRM, previous_handler)
        signal.signal(signal.SIGXFSZ, previous_file_handler)
        if previous_timer[0] > 0:
            signal.setitimer(signal.ITIMER_REAL, *previous_timer)


def _frame_size(block: dict[str, Any], request_id: str) -> int:
    frame = {"version": 1, "request_id": request_id, "kind": "block", "block": block}
    return len(json.dumps(frame, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def split_block(block: dict[str, Any], request_id: str = "", max_frame_bytes: int = FRAME_LIMIT) -> list[dict[str, Any]]:
    if _frame_size(block, request_id) <= max_frame_bytes:
        return [block]
    remaining = block["text"]
    parts: list[dict[str, Any]] = []
    while remaining:
        candidate = {**block, "block_id": f'{block["block_id"]}:{len(parts)}', "text": ""}
        overhead = _frame_size(candidate, request_id)
        if overhead >= max_frame_bytes:
            raise ParseError("FRAME_TOO_LARGE")
        budget = max_frame_bytes - overhead
        lo, hi = 1, len(remaining)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            candidate["text"] = remaining[:mid]
            if _frame_size(candidate, request_id) <= max_frame_bytes:
                lo = mid
            else:
                hi = mid - 1
        if lo < 1:
            raise ParseError("FRAME_TOO_LARGE")
        boundary = lo
        if boundary < len(remaining):
            preferred = max(remaining.rfind("\n", 0, boundary), remaining.rfind(" ", 0, boundary))
            if preferred >= boundary // 2:
                boundary = preferred + 1
        candidate["text"] = remaining[:boundary]
        if not candidate["text"] or len(candidate["text"].encode("utf-8")) > budget:
            raise ParseError("FRAME_TOO_LARGE")
        parts.append(candidate)
        remaining = remaining[boundary:]
    return parts


def _page_fragments(text: str, provenance: list[Any]) -> list[tuple[str, int | None]]:
    pages = {page for prov in provenance
             if isinstance((page := getattr(prov, "page_no", None)), int) and page > 0}
    if len(pages) == 1:
        return [(text, pages.pop())]
    if len(pages) < 2:
        return [(text, None)]
    spans: list[tuple[int, int, int]] = []
    for prov in provenance:
        page = getattr(prov, "page_no", None)
        span = getattr(prov, "charspan", None)
        if (not isinstance(page, int) or page < 1 or not isinstance(span, (tuple, list))
                or len(span) != 2 or not all(isinstance(pos, int) for pos in span)
                or not 0 <= span[0] < span[1] <= len(text)):
            return [(text, None)]
        spans.append((span[0], span[1], page))
    spans.sort()
    if text[:spans[0][0]].strip() or text[spans[-1][1]:].strip():
        return [(text, None)]
    if any(left[1] > right[0] or text[left[1]:right[0]].strip()
           for left, right in zip(spans, spans[1:])):
        return [(text, None)]
    result = []
    for index, (_, _, page) in enumerate(spans):
        start = 0 if index == 0 else spans[index][0]
        end = spans[index + 1][0] if index + 1 < len(spans) else len(text)
        result.append((text[start:end], page))
    return result


def parse(path: str | Path, file_type: str, document_id: str,
          limits: dict[str, int] | None = None,
          converter: Callable[[Path], Any] | None = None,
          request_id: str = "") -> list[dict[str, Any]]:
    local_path = Path(path)
    phase("preflight_started")
    preflight(local_path, file_type, limits)
    phase("preflight_completed")
    bounds = _limits(limits)
    try:
        with tempfile.TemporaryDirectory(prefix="contact-worker-", dir=os.environ.get("TMPDIR")) as scratch:
            old_tmpdir = os.environ.get("TMPDIR")
            old_tempdir = tempfile.tempdir
            os.environ["TMPDIR"] = scratch
            tempfile.tempdir = scratch
            try:
                with _watch_scratch(Path(scratch), bounds["max_temp_bytes"]):
                    with open(os.devnull, "w", encoding="utf-8") as sink:
                        with redirect_stdout(sink), redirect_stderr(sink):
                            document = (converter or convert_local)(local_path)
            finally:
                tempfile.tempdir = old_tempdir
                if old_tmpdir is None:
                    os.environ.pop("TMPDIR", None)
                else:
                    os.environ["TMPDIR"] = old_tmpdir
    except ParseError:
        raise
    except OSError as error:
        if error.errno == errno.EFBIG:
            raise ParseError("TEMP_BYTES_EXCEEDED") from error
        raise ParseError("CONVERSION_FAILED") from error
    except Exception as error:
        raise ParseError("CONVERSION_FAILED") from error
    phase("blocks_started")
    items = (item for item, _ in document.iterate_items()) if hasattr(document, "iterate_items") else iter(
        list(getattr(document, "texts", [])) + list(getattr(document, "tables", [])))
    blocks: list[dict[str, Any]] = []
    for ordinal, item in enumerate(items):
        label = getattr(item, "label", None)
        label = getattr(label, "value", label)
        if label == "picture" and getattr(item, "text", None) == "<!-- image -->":
            continue
        value = getattr(item, "text", None)
        if not isinstance(value, str) and hasattr(item, "export_to_markdown"):
            value = item.export_to_markdown(document)
        if not isinstance(value, str) or not value.strip():
            continue
        ref = getattr(item, "self_ref", None)
        for fragment_index, (fragment, page) in enumerate(
                _page_fragments(value, getattr(item, "prov", None) or [])):
            if not fragment.strip():
                continue
            block: dict[str, Any] = {
                "block_id": f"{document_id}:{ordinal}:{fragment_index}", "text": fragment,
            }
            if page is not None:
                block["page"] = page
            if isinstance(ref, str) and ref.strip():
                block["source_ref"] = ref
            if isinstance(label, str) and label.strip():
                block["layout_label"] = label
            blocks.extend(split_block(block, request_id))
    phase("blocks_completed")
    return blocks
