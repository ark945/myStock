FROM python:3.11-slim

WORKDIR /code

# Create non-root user (required by HF Spaces)
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

# Install dependencies
COPY --chown=user requirements.txt $HOME/app/requirements.txt
RUN pip install --no-cache-dir -r $HOME/app/requirements.txt

# Copy application code
COPY --chown=user . $HOME/app
WORKDIR $HOME/app

EXPOSE 7860

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
