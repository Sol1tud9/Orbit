FROM node:22-bookworm-slim AS frontend
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 ORBITA_DATA_DIR=/data
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt && useradd --create-home --uid 10001 orbita && mkdir /data && chown orbita /data
COPY orbita/ ./orbita/
COPY ["Расчетный модуль", "./Расчетный модуль/"]
COPY ["Данные", "./Данные/"]
COPY --from=frontend /build/dist ./web/dist
USER orbita
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health',timeout=3)"
CMD ["python", "-m", "uvicorn", "orbita.api:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
