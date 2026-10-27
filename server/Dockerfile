# syntax=docker/dockerfile:1
# Aster API（FastAPI）— 帳號與管理員資安後台
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app

FROM base AS test
COPY requirements.txt requirements-dev.txt ./
RUN pip install -r requirements-dev.txt
COPY . .
# 建置時跑後端測試，失敗即中止
RUN python -m pytest -q

FROM base AS runtime
COPY requirements.txt ./
RUN pip install -r requirements.txt && useradd --create-home --uid 10001 clure && mkdir -p /app/data && chown clure:clure /app/data
COPY --from=test /app/app ./app
COPY --from=test /app/alembic ./alembic
COPY --from=test /app/alembic.ini ./alembic.ini
USER clure
ENV CLURE_DATA_DIR=/app/data CLURE_ENV=production
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2)" || exit 1
# 先套用資料庫遷移再啟動；單一 worker（頻率限制計數在行程內）
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*' --workers 1"]
