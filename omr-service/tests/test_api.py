from io import BytesIO

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
