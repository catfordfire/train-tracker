FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py init_db.py ./

# Startup: init DB (skips if already built), then launch API
CMD ["sh", "-c", "python init_db.py && uvicorn main:app --host 0.0.0.0 --port 8889"]
