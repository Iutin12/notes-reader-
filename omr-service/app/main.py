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
from xml.etree import ElementTree as ET

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
import fitz
from pydantic import BaseModel, Field
from pypdf import PdfReader
import uvicorn

DATA_DIR = Path(os.environ.get("OMR_DATA_DIR", "/tmp/notera-omr-jobs")).resolve()
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", 50 * 1024 * 1024))
MAX_PDF_PAGES = int(os.environ.get("MAX_PDF_PAGES", 40))
OMR_TIMEOUT_SECONDS = int(os.environ.get("OMR_TIMEOUT_SECONDS", 900))
AUDIVERIS_BIN = os.environ.get("AUDIVERIS_BIN", "/usr/local/bin/audiveris")
NATIVE_PORTABLE = os.environ.get("OMR_NATIVE_PORTABLE", "") == "1"
# Audiveris refuses source images larger than 20 million pixels. Keep a
# little headroom for its internal image conversions in the desktop worker.
AUDIVERIS_SAFE_MAX_PIXELS = 17_500_000
PORTABLE_RENDER_DPI = 300
DATA_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title="Notera OMR",
    version="1.0.0",
    description="Isolated PDF-to-MusicXML service powered by Audiveris.",
)

# In the desktop edition the interface and OMR worker run on different local
# ports. They never accept traffic from the network, but the browser renderer
# still needs this explicit local CORS permission.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:3000", "http://localhost:3000"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

processes: dict[str, subprocess.Popen[str]] = {}


class JobPublic(BaseModel):
    id: str
    file_name: str
    status: str
    stage: str
    message: str
    page_count: int | None = None
    detected_bpm: int | None = None
    progress: int | None = None
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
        if (job_dir(job_id) / f"thumb-{number}.jpg").exists()
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
                "detected_bpm",
                "progress",
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


def extract_pdf_bpm(source: Path) -> int | None:
    """Read a printed metronome mark from the first page's PDF text layer.

    Audiveris often omits tempo directions in its MusicXML output, while many
    digital scores retain a selectable text mark such as "quarter = 96".
    """
    try:
        completed = subprocess.run(
            ["pdftotext", "-f", "1", "-l", "1", "-layout", str(source), "-"],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None

    text = completed.stdout or ""
    patterns = (
        r"(?:[♩♪𝅘𝅥𝅮]|quarter|tempo|bpm)?\s*=\s*(\d{2,3})\b",
        r"\b(?:tempo|bpm)\s*[:=]?\s*(\d{2,3})\b",
    )
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if not match:
            continue
        bpm = int(match.group(1))
        if 20 <= bpm <= 400:
            return bpm
    return None


def extract_image_bpm(page: Path) -> int | None:
    """Fallback for scanned PDFs whose tempo mark is not selectable text."""
    try:
        completed = subprocess.run(
            ["tesseract", str(page), "stdout", "-l", "eng", "--psm", "6"],
            check=False,
            capture_output=True,
            text=True,
            timeout=45,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    for pattern in (r"[=:=]\s*(\d{2,3})\b", r"\b(?:tempo|bpm)\s*(\d{2,3})\b"):
        match = re.search(pattern, completed.stdout or "", flags=re.IGNORECASE)
        if match and 20 <= int(match.group(1)) <= 400:
            return int(match.group(1))
    return None


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


def merge_page_musicxml(page_xml: list[Path], result_path: Path) -> None:
    """Join one-page Audiveris exports into a single score-partwise file."""
    if not page_xml:
        raise RuntimeError("Audiveris не создал пригодный MusicXML ни для одной страницы.")
    root = ET.parse(page_xml[0]).getroot()
    target_parts = {part.get("id"): part for part in root.findall("part")}
    next_number = {part_id: len(part.findall("measure")) + 1 for part_id, part in target_parts.items()}

    def last_clefs(part: ET.Element) -> dict[str, tuple[str, str]]:
        clefs: dict[str, tuple[str, str]] = {}
        for clef in part.findall(".//attributes/clef"):
            number = clef.get("number", "1")
            sign = (clef.findtext("sign") or "").strip()
            line = (clef.findtext("line") or "").strip()
            if sign:
                clefs[number] = (sign, line)
        return clefs

    inherited_clefs = {
        part_id: last_clefs(part) for part_id, part in target_parts.items()
    }
    for xml_path in page_xml[1:]:
        page_root = ET.parse(xml_path).getroot()
        for source_part in page_root.findall("part"):
            part_id = source_part.get("id")
            target = target_parts.get(part_id)
            if target is None:
                # Keep an unfamiliar part rather than losing musical material.
                root.append(source_part)
                target_parts[part_id] = source_part
                next_number[part_id] = len(source_part.findall("measure")) + 1
                continue
            # A page usually starts in the middle of an existing piano system.
            # Audiveris then invents a default G clef for staff 2, even when
            # the previous page established F clef. Keep the previous clef in
            # that specific default-vs-inherited case.
            first_measure = source_part.find("measure")
            if first_measure is not None:
                for clef in first_measure.findall("attributes/clef"):
                    number = clef.get("number", "1")
                    previous = inherited_clefs.get(part_id, {}).get(number)
                    sign = (clef.findtext("sign") or "").strip()
                    line = (clef.findtext("line") or "").strip()
                    if previous and (sign, line) == ("G", "2") and previous != ("G", "2"):
                        sign_node = clef.find("sign")
                        if sign_node is not None:
                            sign_node.text = previous[0]
                        line_node = clef.find("line")
                        if line_node is not None:
                            line_node.text = previous[1]
            for measure in source_part.findall("measure"):
                measure.set("number", str(next_number[part_id]))
                next_number[part_id] += 1
                target.append(measure)
            inherited_clefs[part_id] = last_clefs(target)
    ET.indent(root, space="  ")
    ET.ElementTree(root).write(result_path, encoding="utf-8", xml_declaration=True)


def musicxml_quality(path: Path) -> tuple[int, int, int]:
    """A conservative completeness signal for competing OMR exports."""
    root = ET.parse(path).getroot()
    measures = root.findall(".//part/measure")
    sounding_notes = 0
    nonempty_measures = 0
    for measure in measures:
        notes = measure.findall("note")
        if notes:
            nonempty_measures += 1
        sounding_notes += sum(1 for note in notes if note.find("rest") is None)
    # Prefer exports that retain more noteheads, then more populated measures.
    return sounding_notes, nonempty_measures, len(measures)


def portable_render_scale(page_width_points: float, page_height_points: float) -> float:
    """Return a PDF render scale that stays below Audiveris' image limit."""
    if page_width_points <= 0 or page_height_points <= 0:
        raise ValueError("У страницы PDF некорректный размер.")
    preferred_scale = PORTABLE_RENDER_DPI / 72
    # PyMuPDF rounds both rendered dimensions up. Solving
    # (width * scale + 1) * (height * scale + 1) <= limit leaves room for
    # those two round-ups, unlike a simple area-only calculation.
    page_area = page_width_points * page_height_points
    page_perimeter = page_width_points + page_height_points
    maximum_scale = (
        (-page_perimeter + (page_perimeter**2 + 4 * page_area * (AUDIVERIS_SAFE_MAX_PIXELS - 1)) ** 0.5)
        / (2 * page_area)
    )
    return min(preferred_scale, maximum_scale)


def find_staff_system_bands(
    row_dark_pixels: list[int], page_width_pixels: int, scale: float
) -> list[tuple[int, int]]:
    """Find grand-staff systems from long horizontal staff lines in a raster."""
    if not row_dark_pixels or page_width_pixels <= 0:
        return []
    # A staff line spans most of the page, unlike noteheads, text and barlines.
    minimum_staff_ink = max(80, round(page_width_pixels * 0.25))
    staff_rows = [
        row for row, dark_pixels in enumerate(row_dark_pixels)
        if dark_pixels >= minimum_staff_ink
    ]
    if not staff_rows:
        return []
    # The gap between treble and bass staffs is visibly larger than the gap
    # within one staff, but still much smaller than the blank space between
    # successive piano systems.
    merge_gap = max(24, round(75 * scale))
    bands: list[tuple[int, int]] = []
    start = previous = staff_rows[0]
    for row in staff_rows[1:]:
        if row - previous > merge_gap:
            bands.append((start, previous))
            start = row
        previous = row
    bands.append((start, previous))
    # A piano system contains two groups of five lines. Small one-line bands
    # are usually title decorations or a scanning artefact, not a score.
    return [band for band in bands if band[1] - band[0] >= round(12 * scale)]


def portable_system_images(page: fitz.Page, directory: Path, page_index: int) -> tuple[list[Path], list[str]]:
    """Render each staff system at 300 DPI, excluding surrounding page text."""
    full_scale = PORTABLE_RENDER_DPI / 72
    preview = page.get_pixmap(
        matrix=fitz.Matrix(full_scale, full_scale),
        colorspace=fitz.csGRAY,
        alpha=False,
    )
    samples = memoryview(preview.samples)
    row_dark_pixels = [
        sum(1 for value in samples[row * preview.width:(row + 1) * preview.width] if value < 190)
        for row in range(preview.height)
    ]
    bands = find_staff_system_bands(row_dark_pixels, preview.width, full_scale)
    logs: list[str] = []
    images: list[Path] = []
    top_padding = round(22 * full_scale)
    bottom_padding = round(30 * full_scale)
    for system_index, (top, bottom) in enumerate(bands, start=1):
        top = max(0, top - top_padding)
        bottom = min(preview.height, bottom + bottom_padding)
        clip = fitz.Rect(
            page.rect.x0,
            page.rect.y0 + top / full_scale,
            page.rect.x1,
            page.rect.y0 + bottom / full_scale,
        )
        image = directory / f"source-page-{page_index:03d}-system-{system_index:02d}.png"
        system = page.get_pixmap(
            matrix=fitz.Matrix(full_scale, full_scale),
            clip=clip,
            alpha=False,
        )
        if system.width * system.height > AUDIVERIS_SAFE_MAX_PIXELS:
            # This is only expected for atypically tall systems; use the same
            # safe rendering rule as the whole-page fallback in that case.
            system = page.get_pixmap(
                matrix=fitz.Matrix(portable_render_scale(clip.width, clip.height), portable_render_scale(clip.width, clip.height)),
                clip=clip,
                alpha=False,
            )
        system.save(str(image))
        images.append(image)
        logs.append(
            f"Страница {page_index}, система {system_index}: {system.width}x{system.height} "
            f"({system.width * system.height:,} пикселей, 300 DPI)."
        )
    return images, logs


def portable_recognize_image(image: Path, output: Path, logs: list[str], label: str) -> Path:
    """Export one image with a compatibility retry for Audiveris builds."""
    failures: list[str] = []
    for mode, swap in (("swap", True), ("plain", False)):
        candidate_output = output / mode
        candidate_output.mkdir(parents=True, exist_ok=True)
        command = [AUDIVERIS_BIN, "-batch", "-transcribe", "-export"]
        if swap:
            command.append("-swap")
        command.extend(["-output", str(candidate_output), "--", str(image)])
        try:
            logs.append(run_checked(command, timeout=OMR_TIMEOUT_SECONDS))
            mxl_files = sorted(candidate_output.rglob("*.mxl"))
            if not mxl_files:
                raise RuntimeError("Audiveris не создал файл MusicXML")
            extracted = candidate_output / "result.musicxml"
            extract_musicxml(mxl_files[0], extracted)
            if mode == "plain":
                logs.append(f"{label}: использован совместимый режим без -swap.")
            return extracted
        except Exception as exc:  # noqa: BLE001 - retry alternate local engine mode
            failures.append(f"{mode}: {exc}")
    raise RuntimeError(f"{label}: оба режима Audiveris завершились ошибкой: {' | '.join(failures)}")


def process_pdf_portable(job_id: str, source: Path, page_count: int) -> None:
    """Run an all-in-one Audiveris desktop build without Docker utilities.

    PDF pages are rendered by the bundled Python worker before reaching
    Audiveris. This avoids Audiveris' 20-million-pixel PDF image limit while
    keeping the installer self-contained (no Poppler or ImageMagick needed).
    """
    directory = job_dir(job_id)
    output_dir = directory / "audiveris-output"
    output_dir.mkdir(exist_ok=True)
    write_job(
        job_id,
        status="processing",
        stage="recognizing",
        progress=10,
        message="Audiveris распознаёт партитуру локально…",
    )
    try:
        # Process individual pages. Audiveris does not expose a dependable
        # in-page percentage, but this gives the interface factual milestones:
        # a percentage advances only after a complete page has been exported.
        document = fitz.open(source)
        page_xml: list[Path] = []
        logs: list[str] = []
        for index, pdf_page in enumerate(document, start=1):
            if read_job(job_id)["status"] == "cancelled":
                return
            write_job(
                job_id,
                progress=10 + round((index - 1) / page_count * 78),
                message=f"Подготавливаем страницу {index} из {page_count}…",
            )
            system_images, system_logs = portable_system_images(pdf_page, directory, index)
            logs.extend(system_logs)
            if not system_images:
                # Fallback for PDFs whose staff lines cannot be detected.
                scale = portable_render_scale(pdf_page.rect.width, pdf_page.rect.height)
                page_image = directory / f"source-page-{index:03d}.png"
                pixmap = pdf_page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
                pixmap.save(str(page_image))
                system_images = [page_image]
                logs.append(
                    f"Страница {index}: не удалось выделить системы, подготовлено изображение "
                    f"{pixmap.width}x{pixmap.height} ({pixmap.width * pixmap.height:,} пикселей)."
                )
            write_job(
                job_id,
                message=f"Audiveris распознаёт страницу {index} из {page_count}…",
            )
            page_output = output_dir / f"page-{index:03d}"
            page_output.mkdir(exist_ok=True)
            system_xml: list[Path] = []
            system_error: Exception | None = None
            for system_index, image in enumerate(system_images, start=1):
                try:
                    system_xml.append(portable_recognize_image(
                        image,
                        page_output / f"system-{system_index:02d}",
                        logs,
                        f"Страница {index}, система {system_index}",
                    ))
                except Exception as exc:  # noqa: BLE001 - page-level fallback below
                    system_error = exc
                    break
            extracted = page_output / "page.musicxml"
            if system_error is None:
                try:
                    merge_page_musicxml(system_xml, extracted)
                except Exception as exc:  # noqa: BLE001 - page-level fallback below
                    system_error = exc
            if system_error is not None:
                # Some Audiveris versions reject a cropped system even though
                # they can read the same page as a whole. Retain a usable score
                # rather than failing the complete upload.
                logs.append(f"Страница {index}: системы не распознаны ({system_error}); используем совместимый режим страницы.")
                scale = portable_render_scale(pdf_page.rect.width, pdf_page.rect.height)
                fallback_image = directory / f"source-page-{index:03d}-fallback.png"
                fallback = pdf_page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
                fallback.save(str(fallback_image))
                fallback_xml = portable_recognize_image(
                    fallback_image,
                    page_output / "page-fallback",
                    logs,
                    f"Страница {index}, совместимый режим",
                )
                shutil.copyfile(fallback_xml, extracted)
            page_xml.append(extracted)
            write_job(job_id, progress=10 + round(index / page_count * 78))
        document.close()
        (directory / "audiveris.log").write_text("\n\n".join(logs)[-500_000:], encoding="utf-8")
        write_job(job_id, stage="building", progress=88, message="Создаём партитуру MusicXML…")
        merge_page_musicxml(page_xml, directory / "result.musicxml")
        write_job(
            job_id,
            status="ready",
            stage="ready",
            progress=100,
            message=(
                f"Партитура готова: обработано {page_count} страниц локально. "
                "Проверьте высоту и длительности нот."
            ),
        )
    except Exception as exc:  # noqa: BLE001 - user-safe task boundary
        write_job(
            job_id,
            status="error",
            stage="error",
            message=(
                "Не удалось распознать PDF локально. Подробности сохранены в "
                f"audiveris.log: {exc}"
            ),
        )
    finally:
        for page_image in directory.glob("source-page-*.png"):
            page_image.unlink(missing_ok=True)


def process_pdf(job_id: str) -> None:
    directory = job_dir(job_id)
    source = directory / "source.pdf"
    prepared_pages = directory / "prepared-pages"
    high_res_pages = directory / "high-resolution-pages"
    cleaned_pages = directory / "cleaned-pages"
    output_dir = directory / "audiveris-output"
    log_path = directory / "audiveris.log"
    prepared_pages.mkdir(exist_ok=True)
    high_res_pages.mkdir(exist_ok=True)
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
            progress=5,
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
        write_job(job_id, page_count=page_count, progress=10)

        if NATIVE_PORTABLE:
            process_pdf_portable(job_id, source, page_count)
            return

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
        run_checked(
            [
                "pdftoppm",
                "-png",
                "-r",
                "360",
                str(source),
                str(high_res_pages / "page"),
            ],
            timeout=min(450, OMR_TIMEOUT_SECONDS),
            log_file=directory / "preparation-high-resolution.log",
        )
        pages = sorted(prepared_pages.glob("page-*.png"))
        high_pages = sorted(high_res_pages.glob("page-*.png"))
        if not pages or len(high_pages) != len(pages):
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
            write_job(job_id, progress=12 + round(index / len(pages) * 18))

        # A scan has no PDF text layer, so retry the tempo mark with OCR after
        # rendering the first page. The value is sent back in the job status.
        if not read_job(job_id).get("detected_bpm"):
            detected_bpm = extract_image_bpm(cleaned_pages / "page-001.png")
            if detected_bpm:
                write_job(job_id, detected_bpm=detected_bpm)

        write_job(job_id, stage="recognizing", progress=30, message="Audiveris распознаёт страницы по очереди…")
        page_xml: list[Path] = []
        failed_pages: list[int] = []
        logs: list[str] = []
        # Do not feed the deskewed/trimmed image into OMR. It helps a noisy
        # scan, but removes thin noteheads and ties from vector PDFs. Audiveris
        # receives the untouched 300-DPI page; the cleaned copy is retained for
        # thumbnails and OCR only.
        for index, page in enumerate(pages, start=1):
            if read_job(job_id)["status"] == "cancelled":
                return
            write_job(
                job_id,
                progress=30 + round((index - 1) / page_count * 60),
                message=f"Audiveris распознаёт страницу {index} из {page_count}…",
            )
            page_output = output_dir / f"page-{index:03d}"
            page_output.mkdir(exist_ok=True)
            candidates: list[tuple[tuple[int, int, int], Path, str]] = []
            for label, variant in (("300dpi", page), ("360dpi", high_pages[index - 1])):
                candidate_output = page_output / label
                candidate_output.mkdir(exist_ok=True)
                try:
                    logs.append(run_checked(
                        # Audiveris already writes an .omr work file when exporting.
                        # Passing -save asks it to write that archive a second time;
                        # on several dense pages this triggers FileSystemAlreadyExistsException.
                        [AUDIVERIS_BIN, "-batch", "-transcribe", "-export", "-swap", "-output", str(candidate_output), "--", str(variant)],
                        timeout=OMR_TIMEOUT_SECONDS,
                    ))
                    mxl_files = sorted(candidate_output.rglob("*.mxl"))
                    if not mxl_files:
                        raise RuntimeError("не создан файл MusicXML")
                    extracted = candidate_output / "page.musicxml"
                    extract_musicxml(mxl_files[0], extracted)
                    candidates.append((musicxml_quality(extracted), extracted, label))
                except Exception as candidate_error:
                    logs.append(f"Page {index} ({label}): {candidate_error}")
            if candidates:
                quality, selected, label = max(candidates, key=lambda candidate: candidate[0])
                extracted = page_output / "page.musicxml"
                shutil.copyfile(selected, extracted)
                logs.append(f"Page {index}: selected {label}, quality={quality}")
                page_xml.append(extracted)
            else:
                failed_pages.append(index)
            write_job(job_id, progress=30 + round(index / page_count * 60))
        log_path.write_text("\n\n".join(logs)[-500_000:], encoding="utf-8")
        if failed_pages:
            raise RuntimeError(
                "FAILED_PAGES:" + ", ".join(map(str, failed_pages))
            )

        write_job(
            job_id,
            stage="building",
            progress=92,
            message="Проверяем и создаём партитуру MusicXML…",
        )
        merge_page_musicxml(page_xml, directory / "result.musicxml")
        write_job(
            job_id,
            status="ready",
            stage="ready",
            progress=100,
            message=(
                f"Партитура готова: все {page_count} страниц распознаны. Автоматическое распознавание может содержать "
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
                message=(
                    "Не удалось распознать страницы: "
                    + str(exc).removeprefix("FAILED_PAGES:")
                    + ". Партитура не создана, потому что все страницы обязательны. "
                    "Попробуйте более чёткий скан или PDF, экспортированный из нотного редактора."
                    if str(exc).startswith("FAILED_PAGES:")
                    else "Не удалось распознать PDF. Попробуйте более чёткий скан или PDF, экспортированный из нотного редактора. Подробности сохранены в audiveris.log."
                ),
            )
    finally:
        shutil.rmtree(prepared_pages, ignore_errors=True)
        shutil.rmtree(high_res_pages, ignore_errors=True)
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
        detected_bpm = extract_pdf_bpm(source)
        job = write_job(
            job_id,
            id=job_id,
            file_name=Path(file.filename or "score.pdf").name[:200],
            status="queued",
            stage="queued",
            progress=1,
            message="Файл загружен и поставлен в очередь.",
            page_count=None,
            detected_bpm=detected_bpm,
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


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000, workers=1)
