# Run Jupiter on remote Machine via SSH

    python -m venv .venv
    source .venv/bin/activate
    pip install jupyterlab
    jupiter lab

    ssh ai -L8888:localhost:8888

Copy server URL, connect to that kernel in local vscode
