FROM rust:1-bookworm AS graph-build
RUN apt-get update && apt-get install -y --no-install-recommends libclang-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY rust/contact-graph ./rust/contact-graph
RUN cargo build --locked --release --manifest-path rust/contact-graph/Cargo.toml

FROM node:24-bookworm-slim AS node-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web ./web
COPY scripts/build-contact-upload.mjs ./scripts/build-contact-upload.mjs
RUN npm run build

FROM node:24-bookworm-slim AS python-build
COPY --from=ghcr.io/astral-sh/uv:0.9.26 /uv /usr/local/bin/uv
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv libgomp1 libglib2.0-0 libgl1 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
ENV UV_PYTHON_DOWNLOADS=never \
    HF_HOME=/opt/contact-models/hf \
    XDG_CACHE_HOME=/opt/contact-models/cache \
    PYTHONPATH=/opt/contact-worker
WORKDIR /opt/contact-worker
COPY python/pyproject.toml python/uv.lock ./
COPY python/contact_worker ./contact_worker
RUN uv sync --locked --no-dev --no-editable --python /usr/bin/python3
RUN .venv/bin/python -c "import torch, torchvision; assert torch.version.cuda is None, 'GPU Torch entered CPU image'"
COPY scripts/contact-runtime-smoke.py /tmp/contact-runtime-smoke.py
# This runs real Docling image OCR while the model download is still available.
RUN .venv/bin/python /tmp/contact-runtime-smoke.py --ocr-only

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    SQLITE_PATH=/data/salestools.sqlite \
    CONTACT_GRAPH_ENABLED=false \
    CONTACT_GRAPH_SQLITE_PATH=/data/contact-graph.sqlite \
    CONTACT_GRAPH_BIN=/usr/local/bin/contact-graph \
    CONTACT_PYTHON_BIN=/opt/contact-worker/.venv/bin/python \
    CONTACT_WORKER_SOCKET=/run/contact-worker/worker.sock \
    HF_HOME=/opt/contact-models/hf \
    XDG_CACHE_HOME=/opt/contact-models/cache
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 libgomp1 libglib2.0-0 libgl1 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=node-build /app/dist ./dist
COPY --from=node-build /app/web/dist ./web/dist
COPY python/contact_worker ./python/contact_worker
COPY --from=python-build /opt/contact-worker/.venv /opt/contact-worker/.venv
COPY --from=python-build /opt/contact-models /opt/contact-models
COPY --from=graph-build /build/rust/contact-graph/target/release/contact-graph /usr/local/bin/contact-graph
COPY scripts/contact-runtime-smoke.py /usr/local/bin/contact-runtime-smoke.py
COPY scripts/contact-container-smoke.mjs /usr/local/bin/contact-container-smoke.mjs
COPY python/tests/test_runtime.py /usr/local/bin/contact-runtime-tests.py
COPY tests/fixtures/contact-documents/synthetic-resume.pdf /usr/local/share/contact-runtime/synthetic-resume.pdf
RUN mkdir -p /data /run/contact-worker /tmp/salestools-contact-uploads \
    && chown -R node:node /app /data /opt/contact-models /run/contact-worker /tmp/salestools-contact-uploads
USER node
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "dist/index.js"]
