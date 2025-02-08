# Makefile for deep-research project

# Variables
VENV_NAME := .venv

# Phony targets
.PHONY: all setup run clean

# Default target
all: setup run

# Setup target: Create venv and install dependencies
setup: duckduckgo-crawler/requirements.txt package.json
	test -d $(VENV_NAME) || uv venv --python 3.12
	. $(VENV_NAME)/bin/activate && uv pip install --upgrade pip && uv pip install -Ur duckduckgo-crawler/requirements.txt
	. $(VENV_NAME)/bin/activate && pip install nodeenv && nodeenv -p
	. $(VENV_NAME)/bin/activate && npm install
	@echo "NPM path: $$(. $(VENV_NAME)/bin/activate && which npm)"
	@echo "Node path: $$(. $(VENV_NAME)/bin/activate && which node)"
	touch $(VENV_NAME)/bin/activate

# Run target: Execute the code in the venv
run-setup: setup
	@echo "Activating virtual environment and running npm start..."
	. $(VENV_NAME)/bin/activate && npm start

# Run target: Execute the code in the venv
run:
	@echo "Activating virtual environment and running npm start..."
	. $(VENV_NAME)/bin/activate && npm start

# Clean target: Remove venv and node_modules
clean:
	rm -rf $(VENV_NAME) node_modules
