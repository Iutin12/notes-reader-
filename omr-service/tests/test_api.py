from io import BytesIO
from math import ceil

from fastapi.testclient import TestClient
from pypdf import PdfWriter

import app.main as main

client = TestClient(main.app)


def test_rejects_non_pdf() -> None:
    response = client.post(
        "/api/omr/jobs",
        files={"file": ("notes.pdf", b"not a pdf", "application/pdf")},
    )
    assert response.status_code == 415
    assert "не является PDF" in response.json()["detail"]


def test_rejects_wrong_content_type() -> None:
    response = client.post(
        "/api/omr/jobs",
        files={"file": ("notes.txt", b"%PDF-fake", "text/plain")},
    )
    assert response.status_code == 415


def test_health_exposes_configured_engine() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_portable_render_scale_caps_large_pdf_page() -> None:
    scale = main.portable_render_scale(1002, 1366)

    assert scale < main.PORTABLE_RENDER_DPI / 72
    assert ceil(1002 * scale) * ceil(1366 * scale) <= main.AUDIVERIS_SAFE_MAX_PIXELS


def test_portable_render_scale_keeps_ordinary_page_at_300_dpi() -> None:
    scale = main.portable_render_scale(595, 842)

    assert scale == main.PORTABLE_RENDER_DPI / 72


def test_groups_treble_and_bass_into_one_piano_system() -> None:
    counts = [0] * 1_400
    for row in (100, 120, 350, 370, 800, 820, 1_050, 1_070):
        counts[row] = 600

    assert main.find_staff_system_bands(counts, 1_000, 4) == [(100, 370), (800, 1_070)]


def test_accepts_a_small_valid_pdf(monkeypatch) -> None:
    writer = PdfWriter()
    writer.add_blank_page(width=300, height=400)
    stream = BytesIO()
    writer.write(stream)
    monkeypatch.setattr(main, "process_pdf", lambda _job_id: None)

    response = client.post(
        "/api/omr/jobs",
        files={"file": ("score.pdf", stream.getvalue(), "application/pdf")},
    )

    assert response.status_code == 202
    payload = response.json()
    assert payload["status"] == "queued"
    assert payload["file_name"] == "score.pdf"
    assert len(payload["id"]) == 32
