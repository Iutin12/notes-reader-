from io import BytesIO
from math import ceil
from pathlib import Path

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


def test_portable_omr_retries_without_swap(monkeypatch, tmp_path: Path) -> None:
    image = tmp_path / "page.png"
    image.write_bytes(b"png")
    calls: list[list[str]] = []

    def fake_run(command: list[str], **_kwargs: object) -> str:
        calls.append(command)
        if "-swap" in command:
            raise RuntimeError("swap failed")
        output = Path(command[command.index("-output") + 1])
        output.mkdir(parents=True, exist_ok=True)
        (output / "score.mxl").write_bytes(b"placeholder")
        return "ok"

    monkeypatch.setattr(main, "run_checked", fake_run)
    monkeypatch.setattr(main, "extract_musicxml", lambda _source, target: target.write_text("<score-partwise />"))
    result = main.portable_recognize_image(image, tmp_path / "output", [], "test")

    assert result.exists()
    assert "-swap" in calls[0]
    assert "-swap" not in calls[1]


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
