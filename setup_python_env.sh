#!/bin/bash

# Check if Python3 is installed
if ! command -v python3 &> /dev/null
then
    echo "Python3 could not be found. Please install Python3 and try again."
    exit 1
fi

# Check if pip is installed
if ! command -v pip3 &> /dev/null
then
    echo "pip3 could not be found. Please install pip3 and try again."
    exit 1
fi

# Install Python dependencies
pip3 install -r duckduckgo-crawler/requirements.txt

echo "Python dependencies installed successfully."
