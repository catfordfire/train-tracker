FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py init_db.py track_router.py build_track_db.py ./

# Download rail network geometry from GitHub at build time
RUN python3 -c "import urllib.request, os; urllib.request.urlretrieve('https://raw.githubusercontent.com/catfordfire/train-tracker/main/backend/rail_network.json', '/app/rail_network.json'); print(f'Downloaded {os.path.getsize(\"/app/rail_network.json\")/1024/1024:.1f} MB')"

CMD ["sh", "-c", "python init_db.py && uvicorn main:app --host 0.0.0.0 --port 8889"]
