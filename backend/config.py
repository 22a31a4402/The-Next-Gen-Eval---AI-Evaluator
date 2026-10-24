"""Configuration settings for NextGen Eval Python FastAPI Backend."""

import os
from pydantic import BaseModel


class Settings(BaseModel):
    PORT: int = int(os.getenv("PORT", "8000"))
    HOST: str = os.getenv("HOST", "0.0.0.0")
    GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", os.getenv("API_KEY", ""))
    PRIMARY_MODEL: str = os.getenv("GEMINI_MODEL", "gemini-3.8-flash")
    FALLBACK_MODELS: list[str] = ["gemini-flash-latest", "gemini-3.1-flash-lite"]
    MAX_CONCURRENT_EVALS: int = int(os.getenv("MAX_CONCURRENT_EVALS", "4"))
    MAX_RETRIES_PER_MODEL: int = 2
    REQUEST_TIMEOUT_SECONDS: int = 90
    DATA_DIR: str = os.getenv("DATA_DIR", "./.data/evaluations")
    CACHE_TTL_SECONDS: int = 7 * 24 * 3600  # 7 days

    # Gemini Flash pricing ($ / 1M tokens)
    INPUT_COST_PER_MILLION: float = 0.075
    OUTPUT_COST_PER_MILLION: float = 0.30


settings = Settings()
