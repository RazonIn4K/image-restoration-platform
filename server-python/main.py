from fastapi import FastAPI

app = FastAPI(title="Image Restoration API (Python)")

@app.get("/health")
def health():
    return {"ok": True, "service": "python"}
