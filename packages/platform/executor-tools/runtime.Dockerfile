USER root
RUN --network=none --mount=type=bind,source=executor-tools,target=/tmp/executor-tools,rw \
    sh /tmp/executor-tools/install.sh
ENV PATH="/home/node/.local/bin:${PATH}"
