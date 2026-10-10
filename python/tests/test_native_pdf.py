from pathlib import Path
from types import SimpleNamespace
import pytest
from contact_worker.parser import convert_local, ParseError

FIXTURES = Path(__file__).resolve().parents[2] / 'tests/fixtures/contact-documents'


def conversion(monkeypatch, status='success', pages=(1, 2), text_pages=(1, 2)):
    import docling.document_converter as module
    observed = {}
    items = [SimpleNamespace(text='Synthetic text', prov=[SimpleNamespace(page_no=p)]) for p in text_pages]
    document = SimpleNamespace(pages={p: object() for p in pages}, iterate_items=lambda: [(i, 0) for i in items])
    class Converter:
        def __init__(self, **kwargs): observed.update(kwargs)
        def convert(self, path): return SimpleNamespace(status=status, document=document)
    monkeypatch.setattr(module, 'DocumentConverter', Converter)
    return observed


def test_extensionless_pdf_uses_native_pipeline(monkeypatch, tmp_path):
    from docling.datamodel.base_models import InputFormat
    from docling.pipeline.native_pdf_pipeline import NativePdfPipeline
    observed = conversion(monkeypatch)
    path = tmp_path / 'upload-uuid'
    path.write_bytes((FIXTURES / 'synthetic-resume.pdf').read_bytes())
    convert_local(path)
    option = observed['format_options'][InputFormat.PDF]
    assert option.pipeline_cls is NativePdfPipeline
    assert option.pipeline_options.parser_threads == 1
    assert not option.pipeline_options.generate_page_images
    assert not option.pipeline_options.generate_picture_images


@pytest.mark.parametrize('status,pages,text_pages,code', [
    ('partial_success', (1, 2), (1, 2), 'CONVERSION_FAILED'),
    ('success', (1,), (1,), 'CONVERSION_FAILED'),
    ('success', (1, 2), (1,), 'PDF_TEXT_UNAVAILABLE'),
])
def test_incomplete_or_textless_pdf_cannot_report_complete(monkeypatch, status, pages, text_pages, code):
    conversion(monkeypatch, status, pages, text_pages)
    with pytest.raises(ParseError, match=code):
        convert_local(FIXTURES / 'synthetic-resume.pdf')


def test_image_keeps_ocr(monkeypatch):
    from docling.datamodel.base_models import InputFormat
    from docling.pipeline.standard_pdf_pipeline import StandardPdfPipeline
    observed = conversion(monkeypatch, pages=(1,), text_pages=(1,))
    convert_local(FIXTURES / 'synthetic-card.png')
    option = observed['format_options'][InputFormat.IMAGE]
    assert option.pipeline_cls is StandardPdfPipeline
    assert option.pipeline_options.do_ocr


def test_real_image_only_pdf_is_rejected(tmp_path):
    from PIL import Image
    path = tmp_path / 'scanned.pdf'
    with Image.open(FIXTURES / 'synthetic-card.png') as image:
        image.convert('RGB').save(path, 'PDF')
    with pytest.raises(ParseError, match='PDF_TEXT_UNAVAILABLE'):
        convert_local(path)
