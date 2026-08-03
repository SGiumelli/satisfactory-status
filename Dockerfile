FROM alpine:3.22
RUN apk add --no-cache bash curl jq
COPY status.sh /opt/status.sh
RUN chmod +x /opt/status.sh
ENV INTERVAL=300
CMD ["sh", "-c", "while :; do bash /opt/status.sh || echo 'échec du cycle'; sleep \"$INTERVAL\"; done"]
