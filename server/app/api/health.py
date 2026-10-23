"""健康檢查。"""
from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/api/health", summary="健康檢查")
def health() -> dict[str, str]:
    return {"status": "ok"}
