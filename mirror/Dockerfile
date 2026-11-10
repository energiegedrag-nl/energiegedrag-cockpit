# SPDX-License-Identifier: EUPL-1.2
# Firmware mirror for the flash station: fetches firmware releases, checks them and writes manifests to /firmware.
FROM python:3.13-alpine
RUN adduser -D -u 1000 mirror && mkdir /firmware && chown mirror /firmware
COPY mirror.py /app/mirror.py
USER mirror
ENV FIRMWARE_DIR=/firmware PYTHONUNBUFFERED=1
VOLUME /firmware
CMD ["python", "-I", "/app/mirror.py"]
