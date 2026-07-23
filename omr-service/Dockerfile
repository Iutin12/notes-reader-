FROM ubuntu:24.04

ARG AUDIVERIS_VERSION=5.10.2
ARG AUDIVERIS_DEB_SHA256=cadb9fafc0be228718c2fbef2e802e04787241150398714251b00c51e31b5198

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OMR_DATA_DIR=/data/jobs \
    AUDIVERIS_BIN=/usr/local/bin/audiveris \
    JAVA_TOOL_OPTIONS="-Djava.awt.headless=true -Xmx4g"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      imagemagick \
      img2pdf \
      libasound2t64 \
      libfreetype6 \
      libtesseract5 \
      libxi6 \
      libxtst6 \
      poppler-utils \
      python3 \
      python3-pip \
      tesseract-ocr \
      tesseract-ocr-eng \
      tesseract-ocr-rus \
    && curl -fsSL \
      "https://github.com/Audiveris/audiveris/releases/download/${AUDIVERIS_VERSION}/Audiveris-${AUDIVERIS_VERSION}-ubuntu24.04-x86_64.deb" \
      -o /tmp/audiveris.deb \
    && echo "${AUDIVERIS_DEB_SHA256}  /tmp/audiveris.deb" | sha256sum -c - \
    && dpkg-deb --extract /tmp/audiveris.deb / \
    && rm -f /tmp/audiveris.deb \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    if command -v audiveris >/dev/null 2>&1; then \
      launcher="$(command -v audiveris)"; \
    elif [ -x /opt/audiveris/bin/Audiveris ]; then \
      launcher=/opt/audiveris/bin/Audiveris; \
    elif [ -x /opt/audiveris/bin/audiveris ]; then \
      launcher=/opt/audiveris/bin/audiveris; \
    else \
      launcher="$(find /opt -type f \( -iname 'audiveris' -o -iname 'Audiveris' \) -perm -111 | head -n 1)"; \
    fi; \
    test -n "$launcher"; \
    ln -sf "$launcher" /usr/local/bin/audiveris; \
    /usr/local/bin/audiveris -batch -version

WORKDIR /service
COPY requirements.txt .
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt
COPY app ./app

RUN useradd --create-home --uid 10001 notera \
    && mkdir -p /data/jobs /tmp/notera-omr-home \
    && chown -R notera:notera /data /tmp/notera-omr-home /service

USER notera
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
