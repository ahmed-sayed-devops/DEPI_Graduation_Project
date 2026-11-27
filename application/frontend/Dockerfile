FROM nginxinc/nginx-unprivileged:alpine

# Custom hardened config with /healthz endpoint on port 8080
COPY --chown=nginx:nginx nginx.conf /etc/nginx/conf.d/default.conf

# Static frontend assets
COPY --chown=nginx:nginx index.html style.css script.js /usr/share/nginx/html/

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1