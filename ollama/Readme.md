# Building the vLLM Image

    git clone --depth=1 git@github.com:vllm-project/vllm.git

copy the files from `vllmPatch` into the repository

    docker build -f Dockerfile.openvino -t vllm-openvino-env .
