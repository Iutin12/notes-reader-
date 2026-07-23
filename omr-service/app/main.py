from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import signal
import subprocess
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from pypdf import PdfReader

DATA_DIR = Path(os.environ.get("OMR_DATA_DIR", "/tmp/notera-omr-jobs")).resolve()
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", 50 * 1024 * 1024))
MAX_PDF_PAGES = int(os.environ.get("MAX_PDF_PAGES", 40))
OMR_TIMEOUT_SECONDS = int(os.environ.get("OMR_TIMEOUT_SECONDS", 900))
AUDIVERIS_BIN = os.environ.get("AUDIVERIS_BIN", "/usr/local/bin/audiveris")
DATA_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title="Notera OMR",
    version="1.0.0",
    description="Isolated PDF-to-MusicXML service powered by Audiveris.",
)

processes: dict[str, subprocess.Popen[str]] = {}


class JobPublic(BaseModel):
    id: str
    file_name: str
    status: str
    stage: str
    message: str
    page_count: int | None = None
    created_at: float
    updated_at: float
    result_url: str | None = None
    thumbnails: list[str] = Field(default_factory=list)


def job_dir(job_id: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{32}", job_id):
        raise HTTPException(status_code=404, detail="Задача не найдена.")
    path = (DATA_DIR / job_id).resolve()
    if DATA_DIR not in path.parents:
        raise HTTPException(status_code=404, detail="Задача не найдена.")
    return path


def read_job(job_id: str) -> dict[str, Any]:
    path = job_dir(job_id) / "job.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Задача не найдена.")
    return json.loads(path.read_text(encoding="utf-8"))


def write_job(job_id: str, **updates: Any) -> dict[str, Any]:
    directory = job_dir(job_id)
    path = directory / "job.json"
    current = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    current.update(updates, updated_at=time.time())
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    temporary.replace(path)
    return current


def public_job(job: dict[str, Any]) -> JobPublic:
    page_count = job.get("page_count")
    job_id = job["id"]
    thumbnails = [
        f"/api/omr/jobs/{job_id}/pages/{number}/thumbnail"
        for number in range(1, min(page_count or 0, 6) + 1)
    ]
    return JobPublic(
        **{
            key: job.get(key)
            for key in (
                "id",
                "file_name",
                "status",
                "stage",
                "message",
                "page_count",
                "created_at",
                "updated_at",
            )
        },
        result_url=(
            f"/api/omr/jobs/{job_id}/musicxml"
            if job.get("status") == "ready"
            else None
        ),
        thumbnails=thumbnails,
    )


def run_checked(
    command: list[str],
    *,
    timeout: int = 180,
    log_file: Path | None = None,
) -> str:
    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
        env={
            **os.environ,
            "HOME": "/tmp/notera-omr-home",
            "JAVA_TOOL_OPTIONS": os.environ.get(
                "JAVA_TOOL_OPTIONS", "-Djava.awt.headless=true -Xmx4g"
            ),
        },
    )
    output = "\n".join(part for part in (completed.stdout, completed.stderr) if part)
    if log_file:
        log_file.write_text(output[-200_000:], encoding="utf-8")
    if completed.returncode != 0:
        raise RuntimeError(
            f"Команда завершилась с кодом {completed.returncode}: {output[-2000:]}"
        )
    return output


def extract_musicxml(mxl_path: Path, result_path: Path) -> None:
    with zipfile.ZipFile(mxl_path) as archive:
        root_path: str | None = None
        try:
            container = archive.read("META-INF/container.xml").decode(
                "utf-8", errors="replace"
            )
            match = re.search(r'full-path="([^"]+)"', container)
            root_path = match.group(1) if match else None
        except KeyError:
            pass
        if not root_path:
            root_path = next(
                (
                    name
                    for name in archive.namelist()
                    if name.lower().endswith((".musicxml", ".xml"))
                    and not name.startswith("META-INF/")
                ),
                None,
            )
        if not root_path:
            raise RuntimeError("Audiveris создал MXL без файла MusicXML.")
        xml = archive.read(root_path)
    if b"<score-partwise" not in xml and b"<score-timewise" not in xml:
        raise RuntimeError("Результат Audiveris не содержит пригодной партитуры.")
    result_path.write_bytes(xml)


def process_pdf(job_id: str) -> None:
    directory = job_dir(job_id)
    source = directory / "source.pdf"
    prepared_pages = directory / "prepared-pages"
    cleaned_pages = directory / "cleaned-pages"
    output_dir = directory / "audiveris-output"
    log_path = directory / "audiveris.log"
    prepared_pages.mkdir(exist_ok=True)
    cleaned_pages.mkdir(exist_ok=True)
    output_dir.mkdir(exist_ok=True)

    try:
        job = read_job(job_id)
        if job["status"] == "cancelled":
            return

        write_job(
            job_id,
            status="processing",
            stage="preparing",
            message="Проверяем страницы и подготавливаем изображение…",
        )
        reader = PdfReader(str(source), strict=False)
        page_count = len(reader.pages)
        if page_count == 0:
            raise RuntimeError("PDF не содержит страниц.")
        if page_count > MAX_PDF_PAGES:
            raise RuntimeError(
                f"В PDF {page_count} страниц. Разрешено не более {MAX_PDF_PAGES}."
            )
        write_job(job_id, page_count=page_count)

        run_checked(
            [
                "pdftoppm",
                "-png",
                "-r",
                "300",
                str(source),
                str(prepared_pages / "page"),
            ],
            timeout=min(300, OMR_TIMEOUT_SECONDS),
            log_file=directory / "preparation.log",
        )
        pages = sorted(prepared_pages.glob("page-*.png"))
        if not pages:
            raise RuntimeError("Не удалось преобразовать страницы PDF в изображения.")

        for index, page in enumerate(pages, start=1):
            if read_job(job_id)["status"] == "cancelled":
                return
            cleaned = cleaned_pages / f"page-{index:03d}.png"
            run_checked(
                [
                    "convert",
                    str(page),
                    "-colorspace",
                    "Gray",
                    "-deskew",
                    "40%",
                    "-trim",
                    "+repage",
                    "-contrast-stretch",
                    "1%x1%",
                    str(cleaned),
                ],
                timeout=90,
            )
            run_checked(
                [
                    "convert",
                    str(cleaned),
                    "-thumbnail",
                    "320x420>",
                    "-quality",
                    "82",
                    str(directory / f"thumb-{index}.jpg"),
                ],
                timeout=30,
            )

        write_job(
            job_id,
            stage="recognizing",
            message="Audiveris читает исходный PDF и распознаёт ноты…",
        )
        command = [
            AUDIVERIS_BIN,
            "-batch",
            "-transcribe",
            "-export",
            "-save",
            "-swap",
            "-output",
            str(output_dir),
            "--",
            str(source),
        ]
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
            env={
                **os.environ,
                "HOME": "/tmp/notera-omr-home",
                "JAVA_TOOL_OPTIONS": os.environ.get(
                    "JAVA_TOOL_OPTIONS", "-Djava.awt.headless=true -Xmx4g"
                ),
            },
        )
        processes[job_id] = process
        try:
            output, _ = process.communicate(timeout=OMR_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
            raise RuntimeError(
                f"Распознавание превысило лимит {OMR_TIMEOUT_SECONDS} секунд."
            )
        finally:
            processes.pop(job_id, None)
        log_path.write_text((output or "")[-500_000:], encoding="utf-8")

        if read_job(job_id)["status"] == "cancelled":
            return
        if process.returncode != 0:
            raise RuntimeError(
                f"Audiveris завершился с кодом {process.returncode}. "
                f"Подробности записаны в audiveris.log. {(output or '')[-1200:]}"
            )

        write_job(
            job_id,
            stage="building",
            message="Проверяем и создаём партитуру MusicXML…",
        )
        mxl_files = sorted(output_dir.rglob("*.mxl"))
        if not mxl_files:
            raise RuntimeError(
                "Распознавание завершилось, но Audiveris не создал MusicXML. "
                "Вероятно, на страницах не удалось уверенно найти печатные ноты."
            )
        extract_musicxml(mxl_files[0], directory / "result.musicxml")
        write_job(
            job_id,
            status="ready",
            stage="ready",
            message=(
                "Партитура готова. Автоматическое распознавание может содержать "
                "ошибки — проверьте ноты перед обучением."
            ),
        )
    except Exception as exc:  # noqa: BLE001 - boundary logs user-safe state
        current = read_job(job_id)
        if current.get("status") != "cancelled":
            write_job(
                job_id,
                status="error",
                stage="error",
                message=str(exc)[:2000],
            )
    finally:
        shutil.rmtree(prepared_pages, ignore_errors=True)
        shutil.rmtree(cleaned_pages, ignore_errors=True)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "audiveris": AUDIVERIS_BIN}


@app.post("/api/omr/jobs", response_model=JobPublic, status_code=202)
async def create_job(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
) -> JobPublic:
    if file.content_type not in {"application/pdf", "application/x-pdf"}:
        raise HTTPException(
            status_code=415, detail="Ожидается PDF-файл (application/pdf)."
        )
    job_id = uuid.uuid4().hex
    directory = job_dir(job_id)
    directory.mkdir(parents=True, exist_ok=False)
    source = directory / "source.pdf"
    total = 0
    try:
        with source.open("wb") as target:
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            f"PDF больше допустимого размера "
                            f"{MAX_UPLOAD_BYTES // 1024 // 1024} МБ."
                        ),
                    )
                target.write(chunk)
        with source.open("rb") as uploaded:
            signature = uploaded.read(5)
        if total < 5 or signature != b"%PDF-":
            raise HTTPException(
                status_code=415,
                detail="Файл имеет расширение PDF, но его содержимое не является PDF.",
            )
        now = time.time()
        job = write_job(
            job_id,
            id=job_id,
            file_name=Path(file.filename or "score.pdf").name[:200],
            status="queued",
            stage="queued",
            message="Файл загружен и поставлен в очередь.",
            page_count=None,
            created_at=now,
        )
        background_tasks.add_task(process_pdf, job_id)
        return public_job(job)
    except Exception:
        if not (directory / "job.json").exists():
            shutil.rmtree(directory, ignore_errors=True)
        raise


@app.get("/api/omr/jobs/{job_id}", response_model=JobPublic)
async def get_job(job_id: str) -> JobPublic:
    return public_job(read_job(job_id))


@app.get("/api/omr/jobs/{job_id}/musicxml")
async def get_musicxml(job_id: str) -> FileResponse:
    job = read_job(job_id)
    result = job_dir(job_id) / "result.musicxml"
    if job.get("status") != "ready" or not result.exists():
        raise HTTPException(status_code=409, detail="MusicXML ещё не готов.")
    safe_title = re.sub(r"[^A-Za-zА-Яа-я0-9._ -]+", "_", job["file_name"])
    return FileResponse(
        result,
        media_type="application/vnd.recordare.musicxml+xml",
        filename=f"{Path(safe_title).stem}.musicxml",
    )


@app.get("/api/omr/jobs/{job_id}/pages/{page_number}/thumbnail")
async def get_thumbnail(job_id: str, page_number: int) -> FileResponse:
    job = read_job(job_id)
    if page_number < 1 or page_number > (job.get("page_count") or 0):
        raise HTTPException(status_code=404, detail="Страница не найдена.")
    thumbnail = job_dir(job_id) / f"thumb-{page_number}.jpg"
    if not thumbnail.exists():
        raise HTTPException(status_code=404, detail="Миниатюра ещё не готова.")
    return FileResponse(thumbnail, media_type="image/jpeg")


@app.delete("/api/omr/jobs/{job_id}", response_model=JobPublic)
async def cancel_or_delete_job(job_id: str) -> JobPublic:
    job = read_job(job_id)
    process = processes.get(job_id)
    if process and process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
    if job.get("status") in {"ready", "error", "cancelled"}:
        await asyncio.to_thread(shutil.rmtree, job_dir(job_id), True)
        return JobPublic(
            id=job_id,
            file_name=job["file_name"],
            status="deleted",
            stage="deleted",
            message="Задача и связанные файлы удалены.",
            page_count=job.get("page_count"),
            created_at=job["created_at"],
            updated_at=time.time(),
        )
    updated = write_job(
        job_id,
        status="cancelled",
        stage="cancelled",
        message="Обработка отменена пользователем.",
    )
    return public_job(updated)
