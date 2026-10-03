# Claude Grid Workshop: web app + pinned OpenSCAD development snapshot.
#   docker build -t grid-workshop .
#   docker run -p 8000:8000 -v gw-cache:/data grid-workshop
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates wget gnupg python3 python3-venv fontconfig fonts-liberation \
    && wget -qO- https://files.openscad.org/OBS-Repository-Key.pub > /etc/apt/trusted.gpg.d/obs-openscad-nightly.asc \
    && echo "deb https://download.opensuse.org/repositories/home:/t-paul/xUbuntu_24.04/ ./" > /etc/apt/sources.list.d/openscad-nightly.list \
    && apt-get update && apt-get install -y --no-install-recommends openscad-nightly \
    && rm -rf /var/lib/apt/lists/* \
    && openscad-nightly --version

WORKDIR /app
COPY requirements.txt .
RUN python3 -m venv /venv && /venv/bin/pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY web ./web
COPY catalog ./catalog
COPY vendor ./vendor
COPY adapters ./adapters

RUN useradd --system --uid 10001 --home /data gw && mkdir -p /data && chown gw /data
USER gw
ENV OPENSCAD=openscad-nightly GW_CACHE_DIR=/data/cache GW_WORKERS=2 GW_TIMEOUT=600
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/api/health')"
CMD ["/venv/bin/uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
