#!/bin/bash
cd /llm/scripts/
source ipex-llm-init --gpu --device Arc

echo Starting ollama...
# init ollama first
mkdir -p /llm/ollama
cd /llm/ollama
init-ollama
export OLLAMA_NUM_GPU=999
export ZES_ENABLE_SYSMAN=1
export OLLAMA_HOST=0.0.0.0:11434
./ollama serve